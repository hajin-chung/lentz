import type { ChatMessage, SessionState } from './types.js';

/** Ordinals and cursors are scoped to one runtime generation, never native JSONL IDs. */
export interface HistoryMessage extends ChatMessage {
  entryId: number;
  version: number;
  groupId: number;
  cursor: string;
  deferred?: boolean;
  callId?: number;
  toolResults?: Record<string, { entryId: number; cursor: string; isError: boolean }>;
}
export interface HistoryPage {
  epoch: string;
  sequence: number;
  messages: HistoryMessage[];
  start: number;
  end: number;
  total: number;
  olderCursor: string | null;
  nextCursor: string | null;
}
export interface ChatSnapshot extends SessionState {
  epoch: string;
  sequence: number;
  messages: HistoryMessage[];
  history: Omit<HistoryPage, 'messages' | 'epoch' | 'sequence'>;
}
export interface ChatUpdate {
  epoch: string;
  sequence: number;
  state: Omit<SessionState, 'models'>;
  messages: HistoryMessage[];
  total: number;
}
export interface ChatView extends ChatSnapshot {
  /** Explicitly fetched full bodies do not change the contiguous history range. */
  details: Record<number, HistoryMessage>;
}

export function mergeMessages(current: HistoryMessage[], incoming: HistoryMessage[]) {
  const entries = new Map(current.map((entry) => [entry.entryId, entry]));
  for (const entry of incoming) {
    const old = entries.get(entry.entryId);
    if (
      !old ||
      entry.version > old.version ||
      (entry.version === old.version && old.deferred && !entry.deferred)
    )
      entries.set(entry.entryId, entry);
  }
  return [...entries.values()].sort((a, b) => a.entryId - b.entryId);
}
function range(messages: HistoryMessage[], total: number) {
  const first = messages[0];
  return {
    start: first?.entryId ?? 0,
    end: messages.length ? messages.at(-1)!.entryId + 1 : 0,
    total,
    olderCursor: first && first.entryId > 0 ? first.cursor : null,
    nextCursor: null,
  };
}
export function mergeSnapshot(current: ChatView | null, incoming: ChatSnapshot): ChatView {
  if (!current || current.epoch !== incoming.epoch) return { ...incoming, details: {} };
  const messages = mergeMessages(current.messages, incoming.messages);
  const newest = incoming.sequence >= current.sequence ? incoming : current;
  return {
    ...newest,
    messages,
    history: range(messages, Math.max(current.history.total, incoming.history.total)),
    details: current.details,
  };
}
export function mergePage(current: ChatView, page: HistoryPage): ChatView {
  if (current.epoch !== page.epoch) return current;
  const messages = mergeMessages(current.messages, page.messages);
  return {
    ...current,
    messages,
    history: range(messages, Math.max(current.history.total, page.total)),
  };
}
export function mergeUpdate(current: ChatView, update: ChatUpdate): ChatView {
  if (current.epoch !== update.epoch || update.sequence <= current.sequence) return current;
  const messages = mergeMessages(
    current.messages,
    update.messages.filter((entry) => entry.entryId >= current.history.start),
  );
  const details = { ...current.details };
  for (const entry of update.messages)
    if (
      entry.entryId < current.history.start &&
      (!details[entry.entryId] || details[entry.entryId].version < entry.version)
    )
      details[entry.entryId] = entry;
  return {
    ...current,
    ...update.state,
    sequence: update.sequence,
    messages,
    details,
    history: range(messages, update.total),
  };
}
export function mergeDetail(current: ChatView, entry: HistoryMessage, epoch: string): ChatView {
  if (current.epoch !== epoch) return current;
  const newer = current.messages.find((message) => message.entryId === entry.entryId);
  if (newer && newer.version > entry.version) return current;
  const old = current.details[entry.entryId];
  if (old && old.version > entry.version) return current;
  return { ...current, details: { ...current.details, [entry.entryId]: entry } };
}
export function resolvedMessage(view: ChatView, message: HistoryMessage) {
  const detail = view.details[message.entryId];
  return detail && detail.version >= message.version ? detail : message;
}
