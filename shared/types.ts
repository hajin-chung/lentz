import type { SerializedDockview } from 'dockview-react';

export type TabKind = 'chat' | 'files' | 'settings';
export interface TabParams {
  kind: TabKind;
  directory?: string;
  file?: string;
  fileView?: 'auto' | 'text';
  sessionId?: string;
}
export interface Workspace {
  id: string;
  name: string;
  layout: SerializedDockview | null;
  revision: number;
}
export interface Preferences {
  theme: 'system' | 'light' | 'dark';
  accent: 'mono' | 'sage' | 'blue' | 'rose';
  fontSize: number;
  motion: boolean;
  showHidden: boolean;
  defaultDirectory: string;
  sendOnEnter: boolean;
  htmlScripts: boolean;
}
export const defaultPreferences: Preferences = {
  theme: 'system',
  accent: 'mono',
  fontSize: 14,
  motion: true,
  showHidden: true,
  defaultDirectory: '',
  sendOnEnter: true,
  htmlScripts: false,
};
export interface Bootstrap {
  workspaces: Workspace[];
  preferences: Preferences;
  config: { root: string; dataDirectory: string; piCommand: string; sessionDirectory: string };
}
export interface DirectoryEntry {
  name: string;
  path: string;
  directory: boolean;
  symlink: boolean;
}
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}
export type FileKind =
  'text' | 'markdown' | 'html' | 'image' | 'audio' | 'video' | 'pdf' | 'table' | 'binary';
export interface FileInfo {
  path: string;
  name: string;
  size: number;
  modified: string;
  mime: string;
  kind: FileKind;
  editable: boolean;
}
export interface TextPreview {
  content: string;
  truncated: boolean;
  lossy: boolean;
}
export interface SessionInfo {
  id: string;
  path?: string;
  cwd: string;
  name: string;
  modified: string;
  running: boolean;
}
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
}
export interface ChatMessage {
  role: string;
  content?: string | ContentBlock[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  errorMessage?: string;
}
export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  reasoning?: boolean;
}
export interface ExtensionDialog {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  prefill?: string;
  placeholder?: string;
}
export interface SessionState {
  id: string;
  cwd: string;
  isStreaming: boolean;
  model?: ModelInfo;
  models: ModelInfo[];
  thinkingLevel: string;
  thinkingLevels: string[];
  pendingMessageCount: number;
  error?: string;
  exited: boolean;
  dialogs: ExtensionDialog[];
  activeTools: Record<string, { name: string; args: unknown; output?: unknown }>;
}
export interface PiEvent {
  type: string;
  message?: ChatMessage;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  [key: string]: unknown;
}

/** Live metadata only. History is indexed and versioned separately. */
export function reducePiEvent(state: SessionState, event: PiEvent): SessionState {
  const next = { ...state };
  if (event.type === 'agent_start') {
    next.isStreaming = true;
    next.error = undefined;
  }
  if (event.type === 'agent_settled') {
    next.isStreaming = false;
    next.activeTools = {};
    next.pendingMessageCount = 0;
  }
  if (event.type === 'message_start' && event.message) {
    if (event.message.role === 'user')
      next.pendingMessageCount = Math.max(0, state.pendingMessageCount - 1);
  }
  if (event.type === 'tool_execution_start' && event.toolCallId) {
    next.activeTools = {
      ...state.activeTools,
      [event.toolCallId]: { name: event.toolName || 'Tool', args: event.args },
    };
  }
  if (
    event.type === 'tool_execution_update' &&
    event.toolCallId &&
    state.activeTools[event.toolCallId]
  ) {
    next.activeTools = {
      ...state.activeTools,
      [event.toolCallId]: { ...state.activeTools[event.toolCallId], output: event.partialResult },
    };
  }
  if (event.type === 'tool_execution_end' && event.toolCallId) {
    next.activeTools = { ...state.activeTools };
    delete next.activeTools[event.toolCallId];
  }
  return next;
}

export type { ChatSnapshot } from './history.js';
