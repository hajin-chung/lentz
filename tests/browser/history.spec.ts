import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import type { ChatMessage } from '../../shared/types';
import { randomUUID, createHash } from 'node:crypto';

async function openHistory(page: Page, count = 160, messages?: ChatMessage[]) {
  const id = randomUUID();
  const name = `Paged ${id.slice(0, 8)}`;
  const file = `/tmp/lentz-e2e/sessions/${id}.jsonl`;
  const body =
    [
      { type: 'session', id, cwd: '/tmp/lentz-e2e/files', version: 3 },
      { type: 'session_info', name },
      ...(
        messages ||
        Array.from({ length: count }, (_, i) => ({
          role: i % 2 ? 'assistant' : 'user',
          content: `History ${i}\n\n${'A variable-height paragraph. '.repeat((i % 4) + 1)}`,
        }))
      ).map((message) => ({ type: 'message', message })),
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n';
  await mkdir('/tmp/lentz-e2e/sessions', { recursive: true });
  await writeFile(file, body);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open workspace menu' }).click();
  await page.getByLabel('New workspace name').fill(name);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.locator('.session-card').filter({ hasText: name }).click();
  if (count)
    await expect(page.locator('[data-message-id]').last()).toHaveAttribute(
      'data-message-id',
      String(count - 1),
    );
  else await expect(page.getByLabel('Message pi')).toBeVisible();
  return { id, name, file, body };
}
const ids = (page: Page) =>
  page
    .locator('.conversation:visible [data-message-id]')
    .evaluateAll((nodes) => nodes.map((n) => Number((n as HTMLElement).dataset.messageId)));

test('older pages preserve the visible anchor while live updates arrive; reading leaves JSONL untouched', async ({
  page,
}) => {
  const fixture = await openHistory(page);
  expect(await ids(page)).toEqual(Array.from({ length: 40 }, (_, i) => 120 + i));
  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route('**/history?before=*', async (route) => {
    const response = await route.fetch();
    requested();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Load older messages' }).click();
  await started;
  // Move while the page is in flight; restore the position at merge, not request time.
  await page.locator('.chat-scroll').evaluate((node) => {
    node.scrollTop = 300;
  });
  const anchor = await page.locator('.chat-scroll').evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    const item = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (item) => item.getBoundingClientRect().bottom > top,
    )!;
    return { id: item.dataset.messageId, y: item.getBoundingClientRect().top };
  });
  release();
  await expect(page.locator('[data-message-id="80"]')).toBeAttached();
  expect(
    Math.abs((await page.locator(`[data-message-id="${anchor.id}"]`).boundingBox())!.y - anchor.y),
  ).toBeLessThan(2);
  expect(
    createHash('sha256')
      .update(await readFile(fixture.file))
      .digest('hex'),
  ).toBe(createHash('sha256').update(fixture.body).digest('hex'));
  // A second, stale older page returns after a complete live turn.
  let releaseSecond!: () => void;
  const heldSecond = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  await page.unroute('**/history?before=*');
  let requestedSecond!: () => void;
  const startedSecond = new Promise<void>((resolve) => {
    requestedSecond = resolve;
  });
  await page.route('**/history?before=*', async (route) => {
    const response = await route.fetch();
    requestedSecond();
    await heldSecond;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Load older messages' }).click();
  await startedSecond;
  await page.request.post(`/api/sessions/${fixture.id}/prompt`, {
    data: { message: 'fixture:burst:50' },
  });
  await expect(page.locator('[data-message-id="209"]')).toBeAttached();
  releaseSecond();
  await expect(page.locator('[data-message-id="40"]')).toBeAttached();
  expect(await ids(page)).toEqual(Array.from({ length: 170 }, (_, i) => i + 40));
  const timings = await (await page.request.get(`/api/sessions/${fixture.id}/diagnostics`)).json();
  expect(timings.historyRpcCalls).toBe(1);
});

test('reconnect fills more than a page of missed messages and a second view keeps its own pages', async ({
  page,
  context,
}) => {
  const { id, name } = await openHistory(page);
  await page.getByRole('button', { name: 'Load older messages' }).click();
  await expect(page.locator('[data-message-id="80"]')).toBeAttached();
  await context.setOffline(true);
  // Node fetch bypasses browser offline emulation, as another connected device would.
  const response = await fetch(`http://127.0.0.1:4327/api/sessions/${id}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'fixture:burst:126' }),
  });
  expect(response.ok).toBe(true);
  await expect
    .poll(
      async () =>
        (await (await fetch(`http://127.0.0.1:4327/api/sessions/${id}/diagnostics`)).json())
          .messages,
    )
    .toBe(286);
  await context.setOffline(false);
  await expect
    .poll(() => ids(page), { timeout: 15000 })
    .toEqual(Array.from({ length: 206 }, (_, i) => i + 80));
  await page.getByRole('button', { name: 'Open workspace menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.session-card').filter({ hasText: name }).click();
  await expect.poll(() => ids(page)).toEqual(Array.from({ length: 40 }, (_, i) => i + 246));
  // Same runtime, distinct view history. Switching tabs does not discard the first page range.
  await page.getByRole('tab', { name, exact: true }).first().click();
  await expect.poll(() => ids(page)).toEqual(Array.from({ length: 206 }, (_, i) => i + 80));
});

test('many loaded groups keep historical Markdown mounted during live updates', async ({
  page,
}) => {
  test.setTimeout(60000);
  const { id } = await openHistory(page, 1000);
  const renders: number[] = [];
  for (let start = 920; start >= 0; start -= 40) {
    await page.getByRole('button', { name: 'Load older messages' }).click();
    await expect(page.locator(`[data-message-id="${start}"]`)).toBeAttached();
    renders.push(
      await page.evaluate(
        (id) => performance.getEntriesByName(`lentz:${id}:react-render`).at(-1)?.duration || 0,
        id,
      ),
    );
  }
  await page.locator('[data-message-id="0"] .markdown').evaluate((node) => {
    (window as any).firstMarkdown = node;
  });
  await page.request.post(`/api/sessions/${id}/prompt`, { data: { message: 'fixture:burst:2' } });
  await expect(page.locator('[data-message-id="1001"]')).toBeAttached();
  expect(
    await page
      .locator('[data-message-id="0"] .markdown')
      .evaluate((node) => (window as any).firstMarkdown === node),
  ).toBe(true);
  const liveRender = await page.evaluate(
    (id) => performance.getEntriesByName(`lentz:${id}:react-render`).at(-1)?.duration || 0,
    id,
  );
  console.log(
    JSON.stringify({
      loadedGroups: 1002,
      olderPageRenderMedianMs: renders.sort((a, b) => a - b)[12],
      olderPageRenderMaxMs: Math.max(...renders),
      liveRenderMs: liveRender,
    }),
  );
});

test('a tool result at the page boundary keeps its open disclosure when its call is loaded', async ({
  page,
}) => {
  await openHistory(page, 42, [
    { role: 'user', content: 'Inspect' },
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'boundary', name: 'read', arguments: { path: 'boundary.txt' } },
      ],
    },
    { role: 'toolResult', toolCallId: 'boundary', toolName: 'read', content: 'Boundary output' },
    ...Array.from({ length: 39 }, (_, i) => ({ role: 'assistant', content: `Answer ${i}` })),
  ]);
  await page.locator('.thinking > summary').click();
  await page.locator('.tool-call > summary').click();
  await expect(page.locator('.tool-call')).toContainText('Boundary output');
  await page.getByRole('button', { name: 'Load older messages' }).click();
  await expect(page.locator('[data-message-id="0"]')).toBeAttached();
  await expect(page.locator('.chat-message.assistant .message-role')).toHaveCount(1);
  await expect(page.locator('.tool-call')).toHaveCount(1);
  await expect(page.locator('.tool-call')).toHaveAttribute('open', '');
  await expect(page.locator('.tool-call')).toContainText('boundary.txt');
  await expect(page.locator('.tool-call')).toContainText('Boundary output');
});

test('a new view buffers live updates while its initial snapshot is in flight', async ({
  page,
}) => {
  const { id, name } = await openHistory(page, 0);
  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(`**/sessions/${id}/snapshot`, async (route) => {
    const response = await route.fetch();
    requested();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Open workspace menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.session-card').filter({ hasText: name }).click();
  await started;
  await page.request.post(`/api/sessions/${id}/prompt`, { data: { message: 'fixture:burst:140' } });
  await expect(page.locator('[data-message-id="139"]')).toBeAttached();
  release();
  await expect.poll(() => ids(page)).toEqual(Array.from({ length: 140 }, (_, i) => i));
});
