import path from 'node:path';
import {
  realpath,
  readdir,
  stat,
  open,
  readFile,
  writeFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import mime from 'mime-types';
import type { DirectoryListing, FileInfo, FileKind, TextPreview } from '../shared/types.js';
import { HttpError } from './errors.js';

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
export function revision(content: Buffer | string) {
  return createHash('sha256').update(content).digest('hex');
}

export class Files {
  private writes = new Map<string, Promise<unknown>>();
  constructor(public root: string) {}
  async resolve(input: string = this.root) {
    const requested = path.resolve(this.root, input);
    if (!isInside(this.root, requested))
      throw new HttpError(403, 'Path is outside the configured root.');
    const resolved = await realpath(requested);
    if (!isInside(this.root, resolved))
      throw new HttpError(403, 'This symlink points outside the configured root.');
    return resolved;
  }
  async directory(input?: string): Promise<DirectoryListing> {
    const directory = await this.resolve(input);
    const entries = await readdir(directory, { withFileTypes: true });
    const visible = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        try {
          const resolved = await this.resolve(entryPath);
          const directory = entry.isSymbolicLink()
            ? (await stat(resolved)).isDirectory()
            : entry.isDirectory();
          return { name: entry.name, path: entryPath, directory, symlink: entry.isSymbolicLink() };
        } catch {
          return null;
        }
      }),
    );
    return {
      path: directory,
      parent: directory === this.root ? null : path.dirname(directory),
      entries: visible
        .filter((e) => e !== null)
        .sort(
          (a, b) =>
            Number(b.directory) - Number(a.directory) ||
            a.name.localeCompare(b.name, undefined, { numeric: true }),
        ),
    };
  }
  async info(input: string): Promise<FileInfo> {
    const file = await this.resolve(input);
    const details = await stat(file);
    if (!details.isFile()) throw new HttpError(400, 'Select a regular file.');
    const extension = path.extname(file).toLowerCase();
    let contentType = mime.lookup(file) || 'application/octet-stream';
    let kind: FileKind = 'binary';
    if (['.md', '.markdown', '.mdx'].includes(extension)) kind = 'markdown';
    else if (['.htm', '.html'].includes(extension)) kind = 'html';
    else if (['.csv', '.tsv', '.xls', '.xlsx'].includes(extension)) kind = 'table';
    else if (extension === '.pdf') kind = 'pdf';
    else if (contentType.startsWith('image/')) kind = 'image';
    else if (contentType.startsWith('audio/')) kind = 'audio';
    else if (contentType.startsWith('video/')) kind = 'video';
    const handle = await open(file, 'r');
    let textual = false;
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
      const sample = buffer.subarray(0, bytesRead);
      if (!sample.some((byte) => byte < 32 && ![9, 10, 12, 13].includes(byte))) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(sample, {
            stream: details.size > bytesRead,
          });
          textual = true;
        } catch {
          /* Non-UTF8 files are read-only. */
        }
      }
    } finally {
      await handle.close();
    }
    // Extensions such as .ts/.mts also name media formats. Readable source takes
    // precedence over that guess, while actual binary transport streams stay video.
    if (textual && ['binary', 'audio', 'video'].includes(kind)) {
      kind = 'text';
      contentType = 'text/plain';
    }
    const editable =
      textual &&
      ['text', 'markdown', 'html', 'table', 'image'].includes(kind) &&
      !['.xls', '.xlsx'].includes(extension) &&
      details.size <= MAX_TEXT_BYTES;
    return {
      path: file,
      name: path.basename(file),
      size: details.size,
      modified: details.mtime.toISOString(),
      mime: contentType,
      kind,
      editable,
    };
  }
  async text(input: string) {
    const info = await this.info(input);
    if (!info.editable) throw new HttpError(413, 'Text editing supports UTF-8 files up to 5 MB.');
    const buffer = await readFile(info.path);
    if (buffer.length > MAX_TEXT_BYTES)
      throw new HttpError(413, 'Text editing is limited to 5 MB.');
    try {
      if (buffer.includes(0)) throw new Error('Binary data');
      // Validate the whole file before editing, not just the detection sample.
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
      return { content, revision: revision(buffer) };
    } catch {
      throw new HttpError(
        415,
        'This file is not UTF-8 text. Open it as text for a read-only preview.',
      );
    }
  }
  async previewText(input: string): Promise<TextPreview> {
    const file = await this.resolve(input);
    const handle = await open(file, 'r');
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new HttpError(400, 'Select a regular file.');
      // Read one extra byte to detect truncation without loading an entire large file.
      const buffer = Buffer.alloc(Math.min(details.size, MAX_TEXT_BYTES + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const truncated = length > MAX_TEXT_BYTES;
      const sample = buffer.subarray(0, Math.min(length, MAX_TEXT_BYTES));
      let content: string;
      let lossy = sample.includes(0);
      try {
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sample, {
          stream: truncated,
        });
      } catch {
        lossy = true;
        content = new TextDecoder('utf-8', { ignoreBOM: true }).decode(sample, {
          stream: truncated,
        });
      }
      return { content: content.replaceAll('\0', '\u2400'), truncated, lossy };
    } finally {
      await handle.close();
    }
  }
  async save(input: string, content: string, expectedRevision: string) {
    const file = await this.resolve(input);
    const operation = (this.writes.get(file) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = await this.text(file);
        if (current.revision !== expectedRevision)
          throw new HttpError(
            409,
            'The file changed on disk. Your draft is kept. Reload the file before saving again.',
          );
        if (Buffer.byteLength(content) > MAX_TEXT_BYTES)
          throw new HttpError(413, 'Text editing is limited to 5 MB.');
        const details = await stat(file);
        const temp = path.join(path.dirname(file), `.lentz-${randomUUID()}.tmp`);
        try {
          await writeFile(temp, content, { flag: 'wx', mode: details.mode & 0o777 });
          // Check again after preparing the write, to catch edits made during the request.
          if (revision(await readFile(file)) !== expectedRevision)
            throw new HttpError(409, 'The file changed on disk. Your draft is kept.');
          await rename(temp, file);
        } finally {
          await unlink(temp).catch(() => {});
        }
        return { revision: revision(content) };
      });
    this.writes.set(file, operation);
    try {
      return await operation;
    } finally {
      if (this.writes.get(file) === operation) this.writes.delete(file);
    }
  }
}
