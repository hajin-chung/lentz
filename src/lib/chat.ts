import type { ChatMessage, ContentBlock } from '../../shared/types';
import type { HistoryMessage } from '../../shared/history';

export interface MessageGroup {
  key: number;
  role: string;
  messages: HistoryMessage[];
}

/** Global group IDs keep a reply intact even when a page starts with a tool result. */
export function groupMessages(messages: HistoryMessage[]): MessageGroup[] {
  const groups = new Map<number, MessageGroup>();
  for (const message of messages) {
    let group = groups.get(message.groupId);
    if (!group) {
      group = {
        key: message.groupId,
        role: message.role === 'toolResult' ? 'assistant' : message.role,
        messages: [],
      };
      groups.set(group.key, group);
    }
    group.messages.push(message);
  }
  return [...groups.values()].sort((a, b) => a.key - b.key);
}

export function contentBlocks(message: ChatMessage): ContentBlock[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content || [];
}
