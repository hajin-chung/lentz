import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Files, MAX_TEXT_BYTES, revision } from '../server/files.js';
import { Store } from '../server/store.js';

test('file root enforces path boundaries, including symlinks', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'lentz-files-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  await mkdir(root);
  await writeFile(path.join(base, 'private.txt'), 'outside');
  await writeFile(path.join(root, 'hello.md'), '# Hello');
  await symlink(path.join(base, 'private.txt'), path.join(root, 'escape'));
  const files = new Files(root);
  await assert.rejects(files.resolve('../private.txt'), /outside/);
  await assert.rejects(files.resolve(path.join(root, 'escape')), /outside/);
  await assert.rejects(files.previewText(path.join(root, 'escape')), /outside/);
  assert.deepEqual(
    (await files.directory()).entries.map((e) => e.name),
    ['hello.md'],
  );
  assert.equal((await files.info(path.join(root, 'hello.md'))).kind, 'markdown');
});

test('readable text overrides ambiguous media extensions while real media stays media', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lentz-types-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Files(root);
  for (const name of ['module.ts', 'module.mts', 'text.mp4']) {
    const file = path.join(root, name);
    await writeFile(file, 'export const answer = 42;\n');
    const info = await files.info(file);
    assert.equal(info.kind, 'text');
    assert.equal(info.mime, 'text/plain');
    assert.equal(info.editable, true);
    assert.equal((await files.text(file)).content, 'export const answer = 42;\n');
  }
  const video = path.join(root, 'transport.ts');
  await writeFile(video, Buffer.from([0x47, 0x40, 0, 0x10, 0xff, 0, 0, 0]));
  assert.equal((await files.info(video)).kind, 'video');
  assert.equal((await files.info(video)).editable, false);
  const svg = path.join(root, 'picture.svg');
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal((await files.info(svg)).kind, 'image');
  assert.match((await files.previewText(svg)).content, /<svg/);
});

test('any-file text previews are bounded and lossy decoding cannot overwrite the original', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lentz-text-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Files(root);
  const binary = path.join(root, 'data.unknown');
  const bytes = Buffer.from([0x61, 0, 0xff, 0x62]);
  await writeFile(binary, bytes);
  const preview = await files.previewText(binary);
  assert.deepEqual(preview, { content: 'a␀�b', lossy: true, truncated: false });
  await assert.rejects(files.save(binary, preview.content, revision(bytes)), /UTF-8/);
  assert.deepEqual(await readFile(binary), bytes);

  const invalidTail = path.join(root, 'invalid-tail.txt');
  const tailBytes = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0xff])]);
  await writeFile(invalidTail, tailBytes);
  assert.equal((await files.previewText(invalidTail)).lossy, true);
  await assert.rejects(files.text(invalidTail), /not UTF-8/);
  await assert.rejects(files.save(invalidTail, 'replacement', revision(tailBytes)), /not UTF-8/);
  assert.deepEqual(await readFile(invalidTail), tailBytes);

  const large = path.join(root, 'large.txt');
  await writeFile(
    large,
    Buffer.concat([Buffer.alloc(MAX_TEXT_BYTES - 1, 0x61), Buffer.from('€end')]),
  );
  const prefix = await files.previewText(large);
  assert.equal(prefix.truncated, true);
  assert.equal(prefix.lossy, false);
  assert.equal(prefix.content.length, MAX_TEXT_BYTES - 1);
  assert.equal(prefix.content.includes('�'), false);
  assert.equal((await files.info(large)).editable, false);
});

test('editing detects external and simultaneous changes without overwriting them', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lentz-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'example.txt');
  await writeFile(filename, 'initial');
  const files = new Files(root);
  const original = await files.text(filename);
  await writeFile(filename, 'external change');
  await assert.rejects(files.save(filename, 'my edit', original.revision), /changed on disk/);
  assert.equal(await readFile(filename, 'utf8'), 'external change');
  const latest = await files.text(filename);
  const outcomes = await Promise.allSettled([
    files.save(filename, 'first', latest.revision),
    files.save(filename, 'second', latest.revision),
  ]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((o) => o.status === 'rejected').length, 1);
});

test('workspace persistence restores layouts and rejects stale writes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lentz-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root, root);
  await store.init();
  const workspace = store.read().workspaces[0];
  await store.update(workspace.id, { name: 'Research' }, 0);
  await assert.rejects(store.update(workspace.id, { name: 'Stale name' }, 0), /another device/);
  const second = new Store(root, root);
  await second.init();
  assert.equal(second.read().workspaces[0].name, 'Research');
  const extra = await second.create('Scratch');
  await second.remove(extra.id);
  await assert.rejects(second.remove(workspace.id), /at least one/);
});
