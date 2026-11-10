import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { acquireLock } from '../server/lock.js';

test('HTTP streams byte ranges and confines HTML and cross-site requests', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lentz-http-'));
  const app = await createApp({
    root,
    dataDirectory: root,
    sessionDirectory: path.join(root, 'sessions'),
    piCommand: 'pi',
    host: '127.0.0.1',
    port: 4317,
    dev: false,
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'test.html');
  await writeFile(file, '<h1>Hello</h1>');
  const raw = `/api/files/raw?path=${encodeURIComponent(file)}`;
  const part = await app.inject({ method: 'GET', url: raw, headers: { range: 'bytes=0-3' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.body, '<h1>');
  assert.equal(part.headers['content-range'], 'bytes 0-3/14');
  const invalid = await app.inject({
    method: 'GET',
    url: raw,
    headers: { range: 'bytes=900-999' },
  });
  assert.equal(invalid.statusCode, 416);
  const html = await app.inject({ method: 'GET', url: '/preview/test.html' });
  assert.match(html.headers['content-security-policy'] as string, /sandbox allow-scripts/);
  assert.match(html.headers['content-security-policy'] as string, /connect-src 'none'/);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/bootstrap',
        headers: { origin: 'https://other.example' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { origin: 'null' } }))
      .statusCode,
    403,
  );
  assert.equal((await app.inject({ method: 'GET', url: '/api/unknown' })).statusCode, 404);
  const source = path.join(root, 'module.ts');
  await writeFile(source, 'export const value = 1;');
  const sourceResponse = await app.inject({
    method: 'GET',
    url: `/api/files/raw?path=${encodeURIComponent(source)}`,
  });
  assert.match(sourceResponse.headers['content-type'] as string, /^text\/plain/);
  const binary = path.join(root, 'data.bin');
  await writeFile(binary, Buffer.from([0, 255]));
  const textPreview = await app.inject({
    method: 'GET',
    url: `/api/files/text-preview?path=${encodeURIComponent(binary)}`,
  });
  assert.equal(textPreview.statusCode, 200);
  assert.equal(textPreview.json().lossy, true);
});

test('a second server cannot write the same workspace store', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lentz-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await acquireLock(directory);
  await assert.rejects(acquireLock(directory), /Another Lentz server/);
  await release();
  const releaseAgain = await acquireLock(directory);
  await releaseAgain();
});

test('an unattached chat stream opens immediately, before its first snapshot', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lentz-stream-'));
  const app = await createApp({
    root,
    dataDirectory: root,
    sessionDirectory: path.join(root, 'sessions'),
    piCommand: path.resolve('tests/fake-pi.mjs'),
    host: '127.0.0.1',
    port: 0,
    dev: false,
  });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    app.server.closeAllConnections();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${address}/api/events?ids=00000000-0000-4000-8000-000000000001`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const { value } = await response.body!.getReader().read();
    assert.match(new TextDecoder().decode(value), /: connected/);
  } finally {
    clearTimeout(timeout);
  }
});
