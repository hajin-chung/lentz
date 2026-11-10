import { randomUUID } from 'node:crypto';
import type { ChatMessage, ContentBlock } from '../../shared/types.js';
import type { HistoryMessage, HistoryPage } from '../../shared/history.js';
import { HttpError } from '../errors.js';

export const PAGE_MESSAGES = 40;
export const PAGE_BYTES = 128 * 1024;
export const INLINE_MESSAGE_BYTES = 8 * 1024;
interface Entry {
  message: ChatMessage;
  version: number;
  groupId: number;
  callId?: number;
  wire?: HistoryMessage;
  bytes?: number;
}
const blocks = (message: ChatMessage): ContentBlock[] =>
  typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content || [];

/** Native messages remain untouched; cursors, projections and associations are server-only. */
export class SessionHistory {
  readonly epoch = randomUUID();
  private entries: Entry[] = [];
  private calls = new Map<string, number>();
  private results = new Map<number, Map<string, number>>();
  private lastGroup = -1;
  private lastRole = '';
  get length() {
    return this.entries.length;
  }
  constructor(messages: ChatMessage[] = [], version = 0) {
    for (const message of messages) this.append(message, version);
  }
  cursor(index: number) {
    return `${this.epoch}.${index}`;
  }
  offset(cursor: string) {
    const [epoch, value, extra] = cursor.split('.');
    if (epoch !== this.epoch) throw new HttpError(409, 'History changed. Reload the conversation.');
    const offset = Number(value);
    if (
      extra ||
      !/^\d+$/.test(value || '') ||
      !Number.isSafeInteger(offset) ||
      offset > this.length
    )
      throw new HttpError(400, 'Invalid history cursor.');
    return offset;
  }
  append(message: ChatMessage, version: number) {
    const index = this.length;
    let groupId = index;
    if (message.role === 'toolResult') groupId = this.lastGroup < 0 ? index : this.lastGroup;
    else {
      if (message.role === 'assistant' && this.lastRole === 'assistant') groupId = this.lastGroup;
      this.lastGroup = groupId;
      this.lastRole = message.role;
    }
    this.entries.push({ message, version, groupId });
    return this.associate(index, version);
  }
  update(message: ChatMessage, version: number) {
    if (!this.length) return this.append(message, version);
    // Parallel tools can finish out of order. Pi identifies tool messages by call ID;
    // assistant updates belong to the most recent assistant start.
    const index = this.entries.findLastIndex(
      (entry) =>
        entry.message.role === message.role &&
        (message.role !== 'toolResult' || entry.message.toolCallId === message.toolCallId),
    );
    if (index < 0) return this.append(message, version);
    this.entries[index] = {
      ...this.entries[index],
      message,
      version,
      wire: undefined,
      bytes: undefined,
    };
    return this.associate(index, version);
  }
  private associate(index: number, version: number) {
    const entry = this.entries[index];
    for (const block of blocks(entry.message))
      if (block.type === 'toolCall' && block.id) this.calls.set(block.id, index);
    const changed = [index];
    if (entry.message.role === 'toolResult' && entry.message.toolCallId) {
      const callId = this.calls.get(entry.message.toolCallId);
      if (callId !== undefined) {
        entry.callId = callId;
        entry.groupId = this.entries[callId].groupId;
        let results = this.results.get(callId);
        if (!results) this.results.set(callId, (results = new Map()));
        results.set(entry.message.toolCallId, index);
        Object.assign(this.entries[callId], { version, wire: undefined, bytes: undefined });
        changed.push(callId);
      }
    }
    return changed;
  }
  message(index: number, full = false): HistoryMessage {
    const entry = this.entries[index];
    if (!entry) throw new HttpError(404, 'Message not found.');
    if (!full && entry.wire) return entry.wire;
    const result: HistoryMessage = {
      ...entry.message,
      entryId: index,
      version: entry.version,
      groupId: entry.groupId,
      cursor: this.cursor(index),
      ...(entry.callId === undefined ? {} : { callId: entry.callId }),
    };
    const associations = this.results.get(index);
    if (associations)
      result.toolResults = Object.fromEntries(
        [...associations].map(([id, target]) => [
          id,
          {
            entryId: target,
            cursor: this.cursor(target),
            isError: !!this.entries[target].message.isError,
          },
        ]),
      );
    if (full) return result;
    let bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > INLINE_MESSAGE_BYTES) {
      result.deferred = true;
      result.content = blocks(entry.message)
        .slice(0, 8)
        .map((block) => {
          if (block.type === 'text') return { type: 'text', text: block.text?.slice(0, 512) };
          if (block.type === 'thinking')
            return { type: 'thinking', thinking: block.thinking?.slice(0, 512) };
          if (block.type === 'toolCall') {
            const args = block.arguments as Record<string, unknown> | undefined;
            return {
              type: block.type,
              id: block.id,
              name: block.name,
              arguments: {
                path: String(args?.path || '').slice(0, 256),
                command: String(args?.command || '').slice(0, 256),
              },
            };
          }
          return { type: block.type };
        });
      if (result.toolResults) {
        const ids = new Set((result.content as ContentBlock[]).map((block) => block.id));
        result.toolResults = Object.fromEntries(
          Object.entries(result.toolResults).filter(([id]) => ids.has(id)),
        );
      }
      // Unknown extension fields can be huge too: projections carry only display data.
      for (const key of Object.keys(result))
        if (
          ![
            'role',
            'content',
            'timestamp',
            'toolCallId',
            'toolName',
            'isError',
            'errorMessage',
            'entryId',
            'version',
            'groupId',
            'cursor',
            'callId',
            'toolResults',
            'deferred',
          ].includes(key)
        )
          delete (result as unknown as Record<string, unknown>)[key];
      result.errorMessage = result.errorMessage?.slice(0, 256);
      bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes > INLINE_MESSAGE_BYTES) {
        result.content = [];
        result.toolResults = undefined;
        result.toolCallId = result.toolCallId?.slice(0, 128);
        result.toolName = result.toolName?.slice(0, 128);
        bytes = Buffer.byteLength(JSON.stringify(result));
      }
    }
    entry.wire = result;
    entry.bytes = bytes;
    return result;
  }
  page(sequence: number, query: { before?: string; from?: string } = {}): HistoryPage {
    if (query.before && query.from) throw new HttpError(400, 'Choose one history cursor.');
    const forward = query.from !== undefined;
    const anchor = query.from
      ? this.offset(query.from)
      : query.before
        ? this.offset(query.before)
        : this.length;
    let start = anchor,
      end = anchor,
      bytes = 0;
    const messages: HistoryMessage[] = [];
    while (messages.length < PAGE_MESSAGES) {
      const index = forward ? end : start - 1;
      if (index < 0 || index >= this.length) break;
      const message = this.message(index);
      const size = this.entries[index].bytes!;
      if (messages.length && bytes + size > PAGE_BYTES) break;
      bytes += size;
      if (forward) {
        messages.push(message);
        end++;
      } else {
        messages.unshift(message);
        start--;
      }
    }
    return {
      epoch: this.epoch,
      sequence,
      messages,
      start,
      end,
      total: this.length,
      olderCursor: start ? this.cursor(start) : null,
      nextCursor: end < this.length ? this.cursor(end) : null,
    };
  }
}
