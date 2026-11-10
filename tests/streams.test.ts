import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mergeSnapshot, mergeUpdate, type ChatView } from '../shared/history.js';
import { createApp } from '../server/app.js';

test('large bodies are deferred and live updates do not repeat full snapshots', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lentz-backpressure-'));
  const sessionDirectory = path.join(root, 'sessions');
  await mkdir(sessionDirectory);
  const id = randomUUID();
  await writeFile(
    path.join(sessionDirectory, `${id}.jsonl`),
    [
      { type: 'session', id, cwd: root, version: 3 },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'old-call',
          content: 'x'.repeat(16 * 1024 * 1024),
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  const app = await createApp({
    root,
    dataDirectory: root,
    sessionDirectory,
    piCommand: path.resolve('tests/fake-pi.mjs'),
    host: '127.0.0.1',
    port: 0,
    dev: false,
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10000);
  t.after(async () => {
    clearTimeout(deadline);
    controller.abort();
    app.server.closeAllConnections();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const stream = await fetch(`${address}/api/events?ids=${id}`, { signal: controller.signal });
  const reader = stream.body!.getReader();
  const post = async (endpoint: string, body?: unknown) => {
    const response = await fetch(`${address}/api/sessions/${id}/${endpoint}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await post('attach'), { ok: true });
  // Leave the history unread while more messages arrive and the user stops the agent.
  await post('prompt', { message: 'A new message while history is buffered' });
  await delay(200);
  await post('stop');
  await delay(100);
  let buffered = '';
  let view: ChatView | null = null;
  let snapshots = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    assert.equal(done, false, 'the stream must not close and force history to reload');
    buffered += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffered.indexOf('\n\n')) !== -1) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!data) continue;
      const update = JSON.parse(data.slice(6));
      if (update.kind === 'snapshot') {
        snapshots++;
        assert.ok(data.length < 140000, 'initial event must be bounded');
        view = mergeSnapshot(view, update.data);
        assert.equal(view.messages[0].deferred, true);
      } else if (update.kind === 'event' && view) view = mergeUpdate(view, update.data);
      if (!view) continue;
      const snapshot = view;
      if (
        !snapshot.isStreaming &&
        snapshot.messages.some(
          (message) => message.content === 'A new message while history is buffered',
        )
      ) {
        assert.equal(snapshots, 1);
        const timings = await (await fetch(`${address}/api/sessions/${id}/diagnostics`)).json();
        assert.equal(timings.historyRpcCalls, 1);
        return;
      }
    }
  }
});
