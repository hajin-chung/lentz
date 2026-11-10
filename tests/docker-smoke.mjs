// Isolated image smoke test: no host credentials, native sessions, or model prompts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.env.LENTZ_TEST_IMAGE || 'lentz:0.1.0';
const name = `lentz-smoke-${randomUUID()}`;
const volume = `${name}-data`;
const home = await mkdtemp(path.join(tmpdir(), 'lentz-docker-'));
await chmod(home, 0o777);
const sessionDirectory = path.join(home, 'sessions');
await mkdir(sessionDirectory, { mode: 0o777 });
const savedId = randomUUID();
const timestamp = new Date().toISOString();
// Empty new pi sessions need not be flushed to disk. Seed a real saved transcript
// separately so restart/attach checks never need a paid prompt to persist history.
const fixture = [
  { type: 'session', version: 3, id: savedId, cwd: home, timestamp },
  ...Array.from({ length: 90 }, (_, index) => ({
    type: 'message',
    id: `m${index}`,
    parentId: index ? `m${index - 1}` : null,
    timestamp,
    message: {
      role: index % 2 ? 'assistant' : 'user',
      content: [{ type: 'text', text: index === 89 ? 'x'.repeat(12_000) : `Message ${index}` }],
      timestamp: Date.now(),
    },
  })),
];
await writeFile(
  path.join(sessionDirectory, `${savedId}.jsonl`),
  fixture.map(JSON.stringify).join('\n') + '\n',
);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
let address;
const request = async (endpoint, method = 'GET', body) => {
  const response = await fetch(`${address}${endpoint}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(65_000),
  });
  assert.equal(response.status, 200, `${method} ${endpoint}: ${await response.clone().text()}`);
  return response.json();
};
const healthy = async () => {
  for (let attempt = 0; attempt < 45; attempt++) {
    const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
    assert.equal(state.Running, true, docker('logs', name));
    if (state.Health.Status === 'healthy') {
      // Docker can reassign an ephemeral published port after restart.
      address = `http://${docker('port', name, '4317/tcp')}`;
      return;
    }
    await delay(1000);
  }
  throw new Error(`Container did not become healthy: ${docker('logs', name)}`);
};
const start = async () => {
  docker(
    'run',
    '--detach',
    '--init',
    '--name',
    name,
    '--publish',
    '127.0.0.1::4317',
    '--health-interval=1s',
    '--health-start-period=0s',
    '--env',
    `HOME=${home}`,
    '--env',
    `LENTZ_ROOT=${home}`,
    '--env',
    `PI_CODING_AGENT_SESSION_DIR=${sessionDirectory}`,
    '--mount',
    `type=bind,src=${home},dst=${home}`,
    '--mount',
    `type=volume,src=${volume},dst=/var/lib/lentz`,
    image,
  );
  address = `http://${docker('port', name, '4317/tcp')}`;
  await healthy();
};

try {
  await start();
  const bootstrap = await request('/api/bootstrap');
  assert.equal(bootstrap.config.root, home);
  assert.equal(bootstrap.config.dataDirectory, '/var/lib/lentz');
  const page = await fetch(address);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/assets\/.*\.js/);
  const workspace = await request('/api/workspaces', 'POST', { name: 'Docker persistence check' });
  const session = await request('/api/sessions', 'POST', { cwd: home, name: 'Docker RPC check' });
  await request(`/api/sessions/${session.id}/attach`, 'POST');
  const snapshot = await request(`/api/sessions/${session.id}/snapshot`);
  assert.equal(snapshot.exited, false);
  assert.equal(snapshot.history.total, 0);
  assert.ok(Array.isArray(snapshot.models));

  await request(`/api/sessions/${savedId}/attach`, 'POST');
  const recent = await request(`/api/sessions/${savedId}/snapshot`);
  assert.equal(recent.history.total, 90);
  assert.equal(recent.messages.length, 40);
  assert.equal(recent.messages.at(-1).deferred, true);
  const older = await request(
    `/api/sessions/${savedId}/history?before=${recent.history.olderCursor}`,
  );
  assert.equal(older.messages.length, 40);
  assert.equal(older.end, recent.history.start);
  const detail = await request(
    `/api/sessions/${savedId}/message?cursor=${recent.messages.at(-1).cursor}`,
  );
  assert.equal(detail.message.content[0].text.length, 12_000);
  assert.equal((await request(`/api/sessions/${savedId}/diagnostics`)).historyRpcCalls, 1);

  // A clean restart must release the data-directory lock and retain state.
  docker('restart', '--time', '30', name);
  await healthy();
  assert.ok((await request('/api/bootstrap')).workspaces.some((item) => item.id === workspace.id));
  await request(`/api/sessions/${savedId}/attach`, 'POST');

  // Recreate with the same mounts to verify persistence beyond a container's lifetime.
  docker('stop', '--time', '30', name);
  docker('rm', name);
  await start();
  assert.ok((await request('/api/bootstrap')).workspaces.some((item) => item.id === workspace.id));
  assert.ok((await request('/api/sessions')).some((item) => item.id === savedId));
  await request(`/api/sessions/${savedId}/attach`, 'POST');
  const reopened = await request(`/api/sessions/${savedId}/snapshot`);
  assert.equal(reopened.exited, false);
  assert.equal(reopened.history.total, 90);
  console.log(
    'Docker smoke test passed: health, static assets, pi RPC, paginated history, full bodies, restart, and persistent state/sessions. No model prompt sent.',
  );
} catch (error) {
  try {
    console.error(docker('logs', name));
  } catch {}
  throw error;
} finally {
  try {
    docker('rm', '--force', name);
  } catch {}
  try {
    docker('volume', 'rm', volume);
  } catch {}
  await rm(home, { recursive: true, force: true });
}
