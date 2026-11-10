import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { SessionInfo } from '../../shared/types.js';
import { isInside } from '../files.js';

/** Index metadata only. Pi itself reconstructs branches and conversation context. */
export class SessionIndex {
  private cache = new Map<string, { mtime: number; info: SessionInfo | null }>();
  constructor(
    private directory: string,
    private root: string,
  ) {}
  async list(): Promise<SessionInfo[]> {
    const paths: string[] = [];
    const walk = async (directory: string, depth: number) => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw e;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && depth < 2)
          await walk(path.join(directory, entry.name), depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl'))
          paths.push(path.join(directory, entry.name));
      }
    };
    await walk(this.directory, 0);
    const result: SessionInfo[] = [];
    // Sequential scans keep descriptor and memory usage bounded for large histories.
    for (const file of paths) {
      const details = await stat(file);
      let cached = this.cache.get(file);
      if (!cached || cached.mtime !== details.mtimeMs) {
        let info: SessionInfo | null = null;
        let named = false;
        const stream = createReadStream(file);
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            let value;
            try {
              value = JSON.parse(line);
            } catch {
              continue;
            }
            if (value.type === 'session') {
              if (typeof value.cwd !== 'string' || !isInside(this.root, value.cwd)) break;
              info = {
                id: value.id,
                path: file,
                cwd: value.cwd,
                name: 'Untitled conversation',
                modified: details.mtime.toISOString(),
                running: false,
              };
            } else if (info && value.type === 'session_info' && value.name) {
              info.name = value.name;
              named = true;
            } else if (
              info &&
              !named &&
              info.name === 'Untitled conversation' &&
              value.type === 'message' &&
              value.message?.role === 'user'
            ) {
              const content = value.message.content;
              const text =
                typeof content === 'string'
                  ? content
                  : Array.isArray(content)
                    ? content.find((block: { type: string }) => block.type === 'text')?.text
                    : undefined;
              if (text) info.name = text.replace(/\s+/g, ' ').slice(0, 100);
            }
          }
        } finally {
          lines.close();
          stream.destroy();
        }
        cached = { mtime: details.mtimeMs, info };
        this.cache.set(file, cached);
      }
      if (cached.info) result.push(cached.info);
    }
    return result.sort((a, b) => b.modified.localeCompare(a.modified));
  }
}
