#!/usr/bin/env node
// Deterministic RPC fixture. Browser tests never make paid model calls.
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const argument = (name) => args[args.indexOf(name) + 1];
const sessionFile = args.includes('--session')
  ? argument('--session')
  : path.join(argument('--session-dir'), `${argument('--session-id')}.jsonl`);
const id = args.includes('--session-id')
  ? argument('--session-id')
  : path.basename(sessionFile, '.jsonl');
let messages = [];
let name = 'Test conversation';
try {
  const entries = readFileSync(sessionFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  name = entries.findLast((e) => e.type === 'session_info')?.name || name;
  messages = entries.filter((e) => e.type === 'message').map((e) => e.message);
} catch {}
let model = { id: 'test-model', name: 'Test model', provider: 'fixture', reasoning: true };
let thinkingLevel = 'off';
let running = false;
let timers = [];
let queue = [];
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
function persist() {
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(
    sessionFile,
    [
      { type: 'session', version: 3, id, cwd: process.cwd(), timestamp: new Date().toISOString() },
      { type: 'session_info', name },
      ...messages.map((message) => ({ type: 'message', message })),
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );
}
function message(message) {
  messages.push(message);
  emit({ type: 'message_start', message });
  emit({ type: 'message_end', message });
  persist();
}
function run(text) {
  if (text.startsWith('fixture:burst:')) {
    emit({ type: 'agent_start' });
    for (let i = 0; i < Number(text.split(':')[2]); i++) {
      const entry = { role: i % 2 ? 'assistant' : 'user', content: `Burst ${i}` };
      messages.push(entry);
      emit({ type: 'message_start', message: entry });
      emit({ type: 'message_end', message: entry });
    }
    persist();
    emit({ type: 'agent_settled' });
    return;
  }
  running = true;
  emit({ type: 'agent_start' });
  message({ role: 'user', content: text });
  const response = {
    role: 'assistant',
    content: [
      { type: 'text', text: '' },
      { type: 'thinking', thinking: 'First reasoning step.' },
      { type: 'thinking', thinking: 'Second reasoning step.' },
    ],
  };
  messages.push(response);
  emit({ type: 'message_start', message: response });
  const words = 'A streamed reply from pi. Your session stays on the server.'.split(' ');
  words.forEach((word, index) =>
    timers.push(
      setTimeout(
        () => {
          response.content[0].text += `${index ? ' ' : ''}${word}`;
          emit({ type: 'message_update', message: response });
        },
        120 * (index + 1),
      ),
    ),
  );
  timers.push(
    setTimeout(() => {
      emit({ type: 'message_end', message: response });
      const tool = {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Checking the working directory.' },
          { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'pwd' } },
        ],
      };
      message(tool);
      emit({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'pwd' },
      });
      message({
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'fixture tool output' }],
      });
      emit({ type: 'tool_execution_end', toolCallId: 'tool-1' });
      message({ role: 'assistant', content: [{ type: 'text', text: 'Directory checked.' }] });
      running = false;
      persist();
      emit({ type: 'agent_settled' });
      if (queue.length) timers.push(setTimeout(() => run(queue.shift()), 100));
    }, 1900),
  );
}
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const command = JSON.parse(line);
    let data;
    switch (command.type) {
      case 'get_state':
        data = {
          sessionId: id,
          sessionFile,
          sessionName: name,
          model,
          thinkingLevel,
          isStreaming: running,
          pendingMessageCount: queue.length,
        };
        break;
      case 'get_messages':
        data = { messages };
        break;
      case 'get_available_models':
        data = { models: [model, { id: 'other-model', name: 'Other model', provider: 'fixture' }] };
        break;
      case 'get_available_thinking_levels':
        data = { levels: ['off', 'low', 'medium', 'high'] };
        break;
      case 'set_session_name':
        name = command.name;
        persist();
        break;
      case 'set_model':
        model = { ...model, id: command.modelId };
        break;
      case 'set_thinking_level':
        thinkingLevel = command.level;
        break;
      case 'prompt':
        if (running) {
          queue.push(command.message);
          data = { disposition: 'queued' };
        } else {
          data = { disposition: 'started' };
          timers.push(setTimeout(() => run(command.message), 10));
        }
        break;
      case 'clear_queue':
        queue = [];
        data = { steering: [], followUp: [] };
        break;
      case 'abort':
        timers.forEach(clearTimeout);
        timers = [];
        running = false;
        persist();
        emit({ type: 'agent_settled' });
        break;
      default:
        break;
    }
    emit({ id: command.id, type: 'response', command: command.type, success: true, data });
  })
  .on('close', () => process.exit(0));
