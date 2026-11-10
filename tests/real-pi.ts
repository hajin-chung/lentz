import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { PiRuntime } from '../server/pi/runtime.js';

const root = await mkdtemp(path.join(tmpdir(), 'lentz-real-pi-'));
const runtime = new PiRuntime(
  {
    id: randomUUID(),
    cwd: root,
    name: 'Protocol check',
    modified: new Date().toISOString(),
    running: false,
  },
  {
    root,
    dataDirectory: root,
    sessionDirectory: path.join(root, 'sessions'),
    piCommand: process.env.LENTZ_PI || 'pi',
    host: '127.0.0.1',
    port: 4317,
    dev: false,
  },
);
try {
  await runtime.ready;
  assert.equal(runtime.snapshot.exited, false);
  assert.ok(Array.isArray(runtime.snapshot.models));
  assert.ok(Array.isArray(runtime.snapshot.messages));
  await runtime.command('set_session_name', { name: 'Lentz protocol check' });
  await runtime.refresh();
  assert.ok(runtime.info.path?.startsWith(root));
  console.log(
    'Installed pi RPC verified: session creation, metadata, models, thinking levels, history. No model prompt sent.',
  );
} finally {
  runtime.close();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    runtime.on('event', (update) => {
      if (update.state.exited) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await rm(root, { recursive: true, force: true });
}
