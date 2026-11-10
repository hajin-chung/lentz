import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function addTab(page: Page, kind: 'Chat' | 'Files' | 'Settings') {
  await page.getByRole('button', { name: 'Open workspace menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: kind, exact: true }).click();
}
async function newWorkspace(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open workspace menu' }).click();
  await page.getByLabel('New workspace name').fill(name);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open workspace menu' })).toContainText(name);
}
test('files render, text edits detect conflicts, HTML stays isolated, and Excel sheets work', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'notes.md', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'notes.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A quiet workspace' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Local image' })).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole('img', { name: 'Local image' })
        .evaluate((element: HTMLImageElement) => element.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Back to directory' }).click();
  await page.getByRole('button', { name: 'edit.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await editor.fill('My changed contents');
  await writeFile('/tmp/lentz-e2e/files/edit.txt', 'An external edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.error-message')).toContainText('changed on disk');
  await expect(editor).toContainText('My changed contents');
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.fill('Successfully saved');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Successfully saved');
  await page.getByRole('button', { name: 'Back to directory' }).click();
  await page.getByRole('button', { name: 'index.html', exact: true }).click();
  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'HTML preview' }),
  ).toBeVisible();
  await expect(page.frameLocator('iframe').locator('#status')).toHaveText('Script off');
  await addTab(page, 'Settings');
  await page.getByRole('switch', { name: 'HTML scripts', exact: true }).click();
  await page.getByRole('tab', { name: 'index.html', exact: true }).click();
  await expect(page.frameLocator('iframe').locator('#status')).toHaveText('Script on');
  await expect(page.frameLocator('iframe').locator('body')).not.toHaveAttribute(
    'data-leaked',
    'yes',
  );
  await page.getByRole('button', { name: 'Back to directory' }).click();
  for (const name of ['data.csv', 'book.xlsx', 'legacy.xls']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Ada', exact: true })).toBeVisible();
    if (name !== 'data.csv') {
      await page.getByLabel('Worksheet').selectOption('1');
      await expect(page.getByRole('cell', { name: 'Second sheet' })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Back to directory' }).click();
  }
  await page.getByRole('button', { name: 'picture.svg', exact: true }).click();
  await expect(page.getByRole('img', { name: 'picture.svg' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to directory' }).click();
  await page.getByRole('button', { name: 'document.pdf', exact: true }).click();
  await expect(page.getByText('PDF fixture', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to directory' }).click();
  for (const [name, tag] of [
    ['sound.wav', 'audio'],
    ['clip.webm', 'video'],
  ]) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect
      .poll(() => page.locator(tag).evaluate((element: HTMLMediaElement) => element.readyState))
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Back to directory' }).click();
  }
  expect(errors).toEqual([]);
});

test('panes split, maximize, persist, and become one visible pane on mobile', async ({ page }) => {
  await page.goto('/');
  await newWorkspace(page, 'Layout test');
  await expect(page.locator('.dv-groupview')).toHaveCount(2);
  await page.getByRole('button', { name: 'Pane options', exact: true }).first().click();
  await page.getByRole('button', { name: 'Split top and bottom' }).click();
  await expect(page.locator('.dv-groupview')).toHaveCount(3);
  await addTab(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  const beforeMobile = await page.locator('.dv-groupview').first().boundingBox();
  await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/bootstrap')).json()).workspaces.find(
          (w: any) => w.name === 'Layout test',
        )?.layout?.panels &&
        Object.keys(
          (await (await page.request.get('/api/bootstrap')).json()).workspaces.find(
            (w: any) => w.name === 'Layout test',
          ).layout.panels,
        ).length,
    )
    .toBe(4);
  await page.reload();
  await expect(page.locator('.dv-groupview')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Visible pane')).toBeVisible();
  await expect(page.locator('.dv-groupview:visible')).toHaveCount(1);
  const options = await page
    .getByLabel('Visible pane')
    .locator('option')
    .evaluateAll((elements) => elements.map((e) => (e as HTMLOptionElement).value));
  await page.getByLabel('Visible pane').selectOption(options[0]);
  await expect(page.locator('.dv-groupview:visible')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/mobile.png' });
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect(page.locator('.dv-groupview:visible')).toHaveCount(3);
  const afterMobile = await page.locator('.dv-groupview').first().boundingBox();
  expect(Math.abs(afterMobile!.width - beforeMobile!.width)).toBeLessThan(5);
  await page.screenshot({ path: 'test-results/desktop.png' });
});

test('pi streams, queues, survives closing its tab, resumes, and stops', async ({ page }) => {
  await page.goto('/');
  await newWorkspace(page, 'Chat test');
  await page.getByLabel('Conversation name').fill('Persistent conversation');
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await expect(page.getByLabel('Message pi')).toBeVisible();
  await expect(page.getByLabel('Model')).toContainText('Test model');
  await page.getByLabel('Thinking level').selectOption('high');
  await expect(page.getByLabel('Thinking level')).toHaveValue('high');
  await page.getByLabel('Message pi').fill('First prompt');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop agent' })).toBeVisible();
  await page.getByLabel('Message pi').fill('Queued prompt');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.composer-hint')).toContainText('queued');
  await page.getByRole('button', { name: 'Close Persistent conversation tab' }).click();
  await addTab(page, 'Chat');
  await page.getByRole('button', { name: /Persistent conversation/ }).click();
  await expect(page.locator('.chat-message.user').filter({ hasText: 'Queued prompt' })).toBeVisible(
    { timeout: 10000 },
  );
  await expect(
    page
      .locator('.chat-message.assistant')
      .filter({ hasText: 'Your session stays on the server.' })
      .first(),
  ).toBeVisible();
  const firstReply = page.locator('.chat-message.assistant').first();
  await expect(firstReply.locator('.message-role')).toHaveCount(1);
  await expect(firstReply.locator('.thinking > summary')).toHaveCount(1);
  await expect(firstReply.locator('.thinking .markdown')).toHaveCount(0);
  await firstReply.locator('.thinking > summary').click();
  await expect(firstReply).toContainText('First reasoning step.');
  await expect(firstReply).toContainText('Second reasoning step.');
  await expect(firstReply).toContainText('Checking the working directory.');
  await firstReply.locator('.tool-call summary').click();
  await expect(page.getByText('fixture tool output', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Message pi').fill('Stop this one');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop agent' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop agent' }).click();
  await expect(page.getByRole('button', { name: 'Stop agent' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Message pi')).toBeVisible();
  await expect(
    page.locator('.chat-message.user').filter({ hasText: 'First prompt' }),
  ).toBeVisible();
});

test('seven open chat tabs share one connection and keep the API responsive', async ({ page }) => {
  const openStreams = new Set<unknown>();
  page.on('request', (request) => {
    if (request.url().includes('/api/events?')) openStreams.add(request);
  });
  page.on('requestfinished', (request) => openStreams.delete(request));
  page.on('requestfailed', (request) => openStreams.delete(request));
  await page.goto('/');
  await newWorkspace(page, 'Many chats');
  for (let index = 0; index < 7; index++) {
    if (index) await addTab(page, 'Chat');
    await page.getByLabel('Conversation name').fill(`Parallel ${index + 1}`);
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await expect(page.locator('.conversation:visible').getByLabel('Model')).toContainText(
      'Test model',
    );
  }
  await expect.poll(() => openStreams.size).toBe(1);
  const conversation = page.locator('.conversation:visible');
  await conversation.getByLabel('Message pi').fill('All seven tabs can stay open');
  await conversation.getByRole('button', { name: 'Send message' }).click();
  await expect(conversation.getByRole('button', { name: 'Stop agent' })).toBeVisible();
  await conversation.getByRole('button', { name: 'Stop agent' }).click();
  await expect(conversation.getByRole('button', { name: 'Stop agent' })).toHaveCount(0);
  await addTab(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
});

test('tabs move between panes and pane maximize restores the split', async ({ page }) => {
  await page.goto('/');
  await newWorkspace(page, 'Docking test');
  await addTab(page, 'Settings');
  await page
    .getByRole('tab', { name: 'Settings', exact: true })
    // Dockview's before/after drop zones exclude the exact midpoint of a tab.
    .dragTo(page.getByRole('tab', { name: 'Files', exact: true }), {
      targetPosition: { x: 10, y: 10 },
    });
  const group = page
    .locator('.dv-groupview')
    .filter({ has: page.getByRole('tab', { name: 'Files', exact: true }) });
  await expect(group.getByRole('tab', { name: 'Settings', exact: true })).toBeVisible();
  await group.getByRole('button', { name: 'Pane options', exact: true }).click();
  await page.getByRole('button', { name: 'Maximize pane' }).click();
  await expect(page.locator('.dv-groupview:visible')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Pane options', exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole('button', { name: 'Restore layout' }).click();
  await expect(page.locator('.dv-groupview:visible')).toHaveCount(2);
});

test('text size scales UI and file content, persists, and keeps mobile controls visible', async ({
  page,
}) => {
  await page.goto('/');
  await newWorkspace(page, 'Text size test');
  await addTab(page, 'Settings');
  const slider = page.getByRole('slider', { name: 'Text size' });
  const tabTitle = page.getByRole('tab', { name: 'Settings', exact: true }).locator('.tab-header');
  const file = page.getByRole('button', { name: 'edit.txt', exact: true });
  await slider.fill('12');
  await expect(tabTitle).toHaveCSS('font-size', '10px');
  await expect(file).toHaveCSS('font-size', '10px');
  await slider.fill('20');
  await expect(tabTitle).toHaveCSS('font-size', '18px');
  await expect(file).toHaveCSS('font-size', '18px');
  await file.click();
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '18px');
  await page.reload();
  await expect(slider).toHaveValue('20');
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '18px');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.dv-groupview:visible')).toHaveCount(1);
  await expect(page.getByLabel('Visible pane')).toBeVisible();
  const workspace = await page.locator('.workspace').boundingBox();
  const bar = await page.locator('.workspace-bar').boundingBox();
  expect(workspace!.x).toBe(0);
  expect(workspace!.y).toBe(0);
  expect(workspace!.width).toBe(390);
  expect(workspace!.height).toBe(bar!.y);
  expect(bar!.y + bar!.height).toBe(844);
  expect(bar!.height).toBeLessThan(36);
  // Restore the shared preference for other tests and future manual checks.
  await page.setViewportSize({ width: 1360, height: 900 });
  await slider.fill('14');
  await expect(tabTitle).toHaveCSS('font-size', '12px');
});

test('large history opens promptly with one snapshot and collapsed activity', async ({ page }) => {
  const id = randomUUID();
  const root = '/tmp/lentz-e2e/files';
  const entries: unknown[] = [
    { type: 'session', id, cwd: root, version: 3 },
    { type: 'session_info', name: 'Large history fixture' },
    { type: 'message', message: { role: 'user', content: 'Inspect this project' } },
  ];
  const thinking = 'A reasoning step with **Markdown** and `code`.\n\n'.repeat(1000);
  for (let i = 0; i < 160; i++) {
    entries.push(
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking },
            { type: 'toolCall', id: `call-${i}`, name: 'read', arguments: { path: 'example.txt' } },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: `call-${i}`,
          content: [{ type: 'text', text: 'Tool output\n'.repeat(4000) }],
        },
      },
    );
  }
  entries.push({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Large history answer.' }] },
  });
  await mkdir('/tmp/lentz-e2e/sessions', { recursive: true });
  const fixture = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  await writeFile(`/tmp/lentz-e2e/sessions/${id}.jsonl`, fixture);
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    (window as any).snapshotCount = 0;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener('update', (event) => {
          if (JSON.parse((event as MessageEvent).data).kind === 'snapshot')
            (window as any).snapshotCount++;
        });
      }
    };
  });
  await page.goto('/');
  await newWorkspace(page, 'Large history');
  const started = Date.now();
  await page.getByRole('button', { name: /Large history fixture/ }).click();
  await expect(page.getByText('Large history answer.', { exact: true })).toBeVisible({
    timeout: 8000,
  });
  await expect(page.getByLabel('Model')).toContainText('Test model');
  console.log(
    `Cold open: ${Date.now() - started}ms for ${(Buffer.byteLength(fixture) / 1048576).toFixed(1)}MB history`,
  );
  await expect(page.locator('.chat-message.assistant')).toHaveCount(1);
  await expect(page.locator('.thinking > summary')).toHaveCount(1);
  await expect(page.locator('.thinking .markdown, .tool-call pre')).toHaveCount(0);
  // Wait for all attachment work, ensuring history wasn't repeated on the stream.
  await expect.poll(() => page.evaluate(() => (window as any).snapshotCount)).toBe(1);
  const reload = Date.now();
  await page.reload();
  await expect(page.getByText('Large history answer.', { exact: true })).toBeVisible({
    timeout: 5000,
  });
  console.log(`Reopen: ${Date.now() - reload}ms`);
  expect(await page.evaluate(() => (window as any).snapshotCount)).toBe(1);
});

test('accent choices persist while surfaces stay neutral', async ({ page }) => {
  await page.goto('/');
  await newWorkspace(page, 'Accent test');
  await addTab(page, 'Settings');
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Blue', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toHaveCSS(
    'color',
    'rgb(56, 107, 158)',
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Blue', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toHaveCSS(
    'color',
    'rgb(155, 191, 229)',
  );
  await page.getByRole('button', { name: 'Monochrome', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'mono');
});

test('source detection and per-tab text overrides work for previews and binary files', async ({
  page,
}) => {
  const root = '/tmp/lentz-e2e/files';
  await writeFile(`${root}/source.ts`, 'export const answer: number = 42;\n');
  await writeFile(`${root}/opaque.bin`, Buffer.from([0x61, 0, 0xff, 0x62]));
  await page.goto('/');
  await newWorkspace(page, 'View modes');
  await page.getByRole('button', { name: 'source.ts', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('export const answer: number = 42;');
  await expect(page.locator('video')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content[contenteditable="true"]').fill('export const answer = 43;');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('export const answer = 43;');
  await page.getByRole('button', { name: 'Back to directory' }).click();

  await page.getByRole('button', { name: 'index.html', exact: true }).click();
  await expect(page.locator('iframe')).toBeVisible();
  await page.getByRole('button', { name: 'Open as text', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('<!doctype html>');
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect
    .poll(async () => {
      const state = await (await page.request.get('/api/bootstrap')).json();
      return JSON.stringify(
        state.workspaces.find((workspace: any) => workspace.name === 'View modes').layout,
      );
    })
    .toContain('"fileView":"text"');
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('<!doctype html>');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Show preview', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Show preview', exact: true }).click();
  await expect(page.locator('iframe')).toBeVisible();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole('button', { name: 'Back to directory' }).click();

  for (const [file, native, text] of [
    ['picture.svg', 'img[alt="picture.svg"]', '<svg'],
    ['sound.wav', 'audio', 'RIFF'],
  ]) {
    await page.getByRole('button', { name: file, exact: true }).click();
    await expect(page.locator(native)).toBeVisible();
    await page.getByRole('button', { name: 'Open as text', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText(text);
    await expect(page.locator(native)).toHaveCount(0);
    await page.getByRole('button', { name: 'Show preview', exact: true }).click();
    await expect(page.locator(native)).toBeVisible();
    await page.getByRole('button', { name: 'Back to directory' }).click();
  }
  await page.getByRole('button', { name: 'opaque.bin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No preview for this format' })).toBeVisible();
  await page.getByRole('button', { name: 'Open as text', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('a␀�b');
  await expect(
    page.getByText('Binary or non-UTF-8 data shown as a text approximation.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No preview for this format' })).toBeVisible();
});
