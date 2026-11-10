import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionHistory, PAGE_BYTES, PAGE_MESSAGES } from '../server/pi/history.js';
import {
  mergeSnapshot,
  mergePage,
  mergeUpdate,
  mergeDetail,
  resolvedMessage,
  type ChatSnapshot,
} from '../shared/history.js';
import type { ChatMessage, SessionState } from '../shared/types.js';
import { groupMessages } from '../src/lib/chat.js';

const state: SessionState = {
  id: 'fixture',
  cwd: '/',
  models: [],
  thinkingLevel: 'off',
  thinkingLevels: ['off'],
  isStreaming: false,
  pendingMessageCount: 0,
  exited: false,
  activeTools: {},
  dialogs: [],
};
const historyOf = (count: number) =>
  new SessionHistory(
    Array.from({ length: count }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `Message ${i}`,
    })),
  );
const snapshot = (history: SessionHistory, sequence = 0): ChatSnapshot => {
  const { messages, epoch, sequence: seq, ...page } = history.page(sequence);
  return { ...state, epoch, sequence: seq, messages, history: page };
};

test('10,000 messages paginate in both directions without overlap, omissions, or unbounded bodies', () => {
  const history = historyOf(10000);
  const seen: number[] = [];
  let page = history.page(0);
  assert.equal(page.start, 9960);
  while (true) {
    assert.ok(page.messages.length <= PAGE_MESSAGES);
    seen.unshift(...page.messages.map((m) => m.entryId));
    if (!page.olderCursor) break;
    page = history.page(0, { before: page.olderCursor });
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 10000 }, (_, i) => i),
  );
  const forward: number[] = [];
  page = history.page(0, { from: history.cursor(0) });
  while (true) {
    forward.push(...page.messages.map((m) => m.entryId));
    if (!page.nextCursor) break;
    page = history.page(0, { from: page.nextCursor });
  }
  assert.deepEqual(forward, seen);
  assert.throws(() => history.page(0, { before: 'different.1' }), /History changed/);
  assert.throws(() => history.page(0, { before: history.cursor(10001) }), /Invalid/);
  assert.throws(
    () => history.page(0, { before: history.cursor(1), from: history.cursor(1) }),
    /Choose/,
  );
  assert.deepEqual(new SessionHistory().page(0).messages, []);
});

test('byte limits defer oversized messages and preserve full originals on explicit retrieval', () => {
  const original: ChatMessage = {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'x'.repeat(16 * 1024 * 1024) }],
  };
  const history = new SessionHistory([
    ...Array.from({ length: 40 }, () => ({ role: 'user', content: 'x'.repeat(7000) })),
    original,
  ]);
  const page = history.page(0);
  assert.ok(
    page.messages.length < PAGE_MESSAGES,
    'byte budget limits the page before the count limit',
  );
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < PAGE_BYTES + 2048);
  assert.equal(page.messages.at(-1)?.deferred, true);
  assert.equal(history.message(40, true).content, original.content);
  assert.equal(
    original.content?.[0] && (original.content[0] as any).thinking.length,
    16 * 1024 * 1024,
  );
});

test('assistant groups and tool associations survive every page boundary and out-of-order tool completion', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'Work' }];
  for (let i = 0; i < 60; i++)
    messages.push(
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Step' },
          { type: 'toolCall', id: `t${i}`, name: 'read' },
        ],
      },
      { role: 'toolResult', toolCallId: `t${i}`, content: `Output ${i}` },
    );
  messages.push({ role: 'assistant', content: 'Done' });
  const history = new SessionHistory(messages);
  const recent = history.page(0);
  assert.equal(recent.messages[0].role, 'toolResult');
  assert.equal(recent.messages[0].groupId, 1);
  assert.equal(recent.messages[0].callId, 81);
  let view = mergeSnapshot(null, snapshot(history));
  view = mergePage(view, history.page(0, { before: view.history.olderCursor! }));
  const groups = groupMessages(view.messages);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 1);
  assert.equal(history.message(81).toolResults?.t40.entryId, 82);
  history.append({ role: 'toolResult', toolCallId: 't0', content: 'Started' }, 1);
  history.append({ role: 'toolResult', toolCallId: 't1', content: 'Started other' }, 2);
  history.update({ role: 'toolResult', toolCallId: 't0', content: 'Finished first' }, 3);
  assert.equal(history.message(122).content, 'Finished first');
  assert.equal(history.message(123).content, 'Started other');
});

test('live deltas win against stale pages and full-body requests without overwriting loaded history', () => {
  const history = historyOf(100);
  let view = mergeSnapshot(null, snapshot(history));
  const older = history.page(0, { before: view.history.olderCursor! });
  const staleRecent = history.page(0);
  const staleDetail = history.message(99, true);
  const changed = history.update({ role: 'assistant', content: 'Streaming changed' }, 1);
  view = mergeUpdate(view, {
    epoch: history.epoch,
    sequence: 1,
    state: { ...state, isStreaming: true },
    messages: changed.map((id) => history.message(id)),
    total: 100,
  });
  history.append({ role: 'user', content: 'Queued' }, 2);
  view = mergeUpdate(view, {
    epoch: history.epoch,
    sequence: 2,
    state,
    messages: [history.message(100)],
    total: 101,
  });
  view = mergePage(mergePage(view, older), staleRecent);
  view = mergeDetail(view, staleDetail, history.epoch);
  assert.equal(view.messages.length, 81);
  assert.equal(view.history.start, 20);
  assert.equal(view.sequence, 2);
  assert.equal(
    resolvedMessage(
      view,
      view.messages.find((m) => m.entryId === 99)!,
    ).content,
    'Streaming changed',
  );
  assert.equal(view.messages.at(-1)?.content, 'Queued');
  assert.equal(
    mergeUpdate(view, { epoch: history.epoch, sequence: 1, state, messages: [], total: 100 }),
    view,
  );
  assert.equal(mergePage(view, historyOf(100).page(0)), view);
});

test('reconnect revalidates loaded pages, fills a multi-page gap, and keeps multiple views independent', () => {
  const history = historyOf(100);
  let first = mergeSnapshot(null, snapshot(history));
  let second = mergeSnapshot(null, snapshot(history));
  first = mergePage(first, history.page(0, { before: first.history.olderCursor! }));
  assert.equal(second.history.start, 60);
  const start = first.messages[0].cursor;
  for (let i = 100; i < 225; i++)
    history.append({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i}` }, i);
  const fresh = snapshot(history, 225);
  first = mergeSnapshot(first, fresh);
  second = mergeSnapshot(second, fresh);
  let page = history.page(225, { from: start });
  while (true) {
    first = mergePage(first, page);
    if (!page.nextCursor) break;
    page = history.page(225, { from: page.nextCursor });
  }
  assert.deepEqual(
    first.messages.map((m) => m.entryId),
    Array.from({ length: 205 }, (_, i) => i + 20),
  );
  assert.equal(second.history.start, 60);
  assert.ok(second.messages.length < first.messages.length);
  const reset = historyOf(5);
  first = mergeSnapshot(first, snapshot(reset));
  assert.equal(first.messages.length, 5);
  assert.deepEqual(first.details, {});
  assert.equal(mergePage(first, page), first);
});
