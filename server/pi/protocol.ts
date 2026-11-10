import type { ChatMessage, ModelInfo } from '../../shared/types.js';

/** The subset of pi's RPC protocol used by Lentz. Runtime remains an external pi process. */
export interface RpcState {
  sessionFile?: string;
  sessionName?: string;
  model?: ModelInfo;
  thinkingLevel: string;
  isStreaming: boolean;
  pendingMessageCount: number;
}

export interface RpcResults {
  get_state: RpcState;
  get_messages: { messages: ChatMessage[] };
  get_available_models: { models: ModelInfo[] };
  get_available_thinking_levels: { levels: string[] };
  prompt: { disposition: 'started' | 'queued' | 'handled' };
  set_session_name: void;
  set_model: ModelInfo;
  set_thinking_level: void;
  clear_queue: { steering: string[]; followUp: string[] };
  abort: void;
}
