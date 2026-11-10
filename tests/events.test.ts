import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reducePiEvent, type SessionState } from '../shared/types.js';

const initial: SessionState = {
  id: 'test',
  cwd: '/',
  models: [],
  thinkingLevel: 'off',
  thinkingLevels: ['off'],
  isStreaming: false,
  pendingMessageCount: 1,
  exited: false,
  activeTools: {},
  dialogs: [],
};
test('pending messages, tool progress, and settled metadata are reduced', () => {
  let state = reducePiEvent(initial, { type: 'agent_start' });
  state = reducePiEvent(state, {
    type: 'message_start',
    message: { role: 'user', content: 'Hello' },
  });
  assert.equal(state.pendingMessageCount, 0);
  state = reducePiEvent(state, {
    type: 'message_start',
    message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
  });
  state = reducePiEvent(state, {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
  });
  state = reducePiEvent(state, {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
  });
  state = reducePiEvent(state, {
    type: 'tool_execution_start',
    toolCallId: 'one',
    toolName: 'bash',
    args: { command: 'pwd' },
  });
  state = reducePiEvent(state, {
    type: 'tool_execution_update',
    toolCallId: 'one',
    partialResult: 'output',
  });
  assert.equal(state.activeTools.one.output, 'output');
  state = reducePiEvent(state, { type: 'agent_settled' });
  assert.equal(state.isStreaming, false);
  assert.deepEqual(state.activeTools, {});
});
