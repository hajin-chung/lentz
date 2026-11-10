/** Isolated, read-only native pi benchmark. No model prompt or native-history writes. */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createApp } from '../server/app.js';
import type { ChatMessage } from '../shared/types.js';

const root = await mkdtemp(path.join(tmpdir(), 'lentz-history-benchmark-'));
const sessions = path.join(root, 'sessions');
await mkdir(sessions);
await mkdir(path.join(root, 'state'));
const id = randomUUID();
const timestamp = new Date().toISOString();
const messages: ChatMessage[] = [
  { role: 'user', content: 'Inspect this project', timestamp: Date.now() },
];
for (let i = 0; i < 160; i++)
  messages.push(
    {
      role: 'assistant',
      timestamp: Date.now(),
      content: [
        {
          type: 'thinking',
          thinking: 'A reasoning step with **Markdown** and `code`.\n\n'.repeat(1000),
        },
        { type: 'toolCall', id: `call-${i}`, name: 'read', arguments: { path: 'example.txt' } },
      ],
    },
    {
      role: 'toolResult',
      timestamp: Date.now(),
      toolCallId: `call-${i}`,
      toolName: 'read',
      content: [{ type: 'text', text: 'Tool output\n'.repeat(4000) }],
    },
  );
messages.push({
  role: 'assistant',
  content: [{ type: 'text', text: 'Benchmark answer.' }],
  timestamp: Date.now(),
});
const fixture =
  [
    { type: 'session', version: 3, id, cwd: root, timestamp },
    ...messages.map((message, i) => ({
      type: 'message',
      id: `m${i}`,
      parentId: i ? `m${i - 1}` : null,
      timestamp,
      message,
    })),
    {
      type: 'session_info',
      id: 'name',
      parentId: `m${messages.length - 1}`,
      timestamp,
      name: 'History benchmark',
    },
    {
      type: 'thinking_level_change',
      id: 'thinking',
      parentId: 'name',
      timestamp,
      thinkingLevel: 'high',
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n') + '\n';
const sessionFile = path.join(sessions, `${id}.jsonl`);
await writeFile(sessionFile, fixture);
const app = await createApp({
  root,
  dataDirectory: path.join(root, 'state'),
  sessionDirectory: sessions,
  piCommand: process.env.LENTZ_PI || 'pi',
  host: '127.0.0.1',
  port: 0,
  dev: false,
});
const browser = await chromium.launch({ headless: true });
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.goto(address);
  const card = page.locator('.session-card').filter({ hasText: 'History benchmark' });
  await card.waitFor();
  const opened = performance.now();
  await card.click();
  await page.getByText('Benchmark answer.', { exact: true }).waitFor();
  const openMs = performance.now() - opened;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const timings = await (await fetch(`${address}/api/sessions/${id}/diagnostics`)).json();
  assert.equal(timings.messages, messages.length);
  const recent = await (await fetch(`${address}/api/sessions/${id}/snapshot`)).json();
  const start = performance.now();
  const fullBody = JSON.stringify({ ...recent, messages });
  const fullSerializeMs = performance.now() - start;
  const recentBody = JSON.stringify(recent);
  const client = await page.evaluate(
    async ({ id, fullBody, recentBody }) => {
      const parsing: number[] = [];
      for (const body of [fullBody, recentBody]) {
        const samples: number[] = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          JSON.parse(body);
          samples.push(performance.now() - start);
        }
        parsing.push(samples.sort((a, b) => a - b)[2]);
      }
      const networkStart = performance.now();
      const response = await fetch(`/api/sessions/${id}/history`);
      const headersMs = performance.now() - networkStart;
      const text = await response.text();
      const responseMs = performance.now() - networkStart;
      return {
        fullPayloadParseMedianMs: parsing[0],
        recentPayloadParseMedianMs: parsing[1],
        recentHttpHeadersMs: headersMs,
        recentHttpBodyMs: responseMs - headersMs,
        recentHttpTotalMs: responseMs,
        recentHttpBytes: new TextEncoder().encode(text).length,
        recentServerTiming: response.headers.get('server-timing'),
        measures: performance
          .getEntriesByType('measure')
          .filter((e) => e.name.startsWith(`lentz:${id}:`))
          .map((e) => ({ name: e.name.split(':').at(-1), ms: e.duration })),
      };
    },
    { id, fullBody, recentBody },
  );
  const after = await readFile(sessionFile, 'utf8');

  assert.ok(
    after.startsWith(fixture),
    'Existing native JSONL entries must remain byte for byte unchanged',
  );
  console.log(
    JSON.stringify(
      {
        pi: process.env.LENTZ_PI || 'pi',
        fixtureBytes: Buffer.byteLength(fixture),
        messages: messages.length,
        openToVisibleMs: openMs,
        server: timings,
        fullPayloadBaseline: { bytes: Buffer.byteLength(fullBody), serializeMs: fullSerializeMs },
        recentPayloadBytes: Buffer.byteLength(recentBody),
        client,
        nativeHistoryUnchanged: true,
        piAppendedBytes: after.length - fixture.length,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  app.server.closeAllConnections();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
