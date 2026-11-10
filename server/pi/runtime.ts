import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Config } from '../config.js';
import type { RpcResults, RpcState } from './protocol.js';
import {
  reducePiEvent,
  type SessionState,
  type ChatMessage,
  type ModelInfo,
  type PiEvent,
  type ExtensionDialog,
  type SessionInfo,
} from '../../shared/types.js';
import type { ChatSnapshot, ChatUpdate } from '../../shared/history.js';
import { SessionHistory } from './history.js';

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  type: string;
  started: number;
  onData?: (data: unknown) => void;
}

const displayModel = ({ id, name, provider, reasoning }: ModelInfo): ModelInfo => ({
  id,
  name,
  provider,
  reasoning,
});

export class PiRuntime extends EventEmitter {
  private state: SessionState;
  history = new SessionHistory();
  sequence = 0;
  private initialized = false;
  private historyLoaded = false;
  private cachedSnapshot?: ChatSnapshot;
  private started = performance.now();
  readonly timings = {
    firstRpcMs: 0,
    historyRpcMs: 0,
    historyParseMs: 0,
    historyIndexMs: 0,
    readyMs: 0,
    historyRpcBytes: 0,
    historyRpcCalls: 0,
    snapshotBuildMs: 0,
    snapshotSerializeMs: 0,
    snapshotBytes: 0,
  };
  get snapshot(): ChatSnapshot {
    if (!this.cachedSnapshot) {
      const started = performance.now();
      const { messages, epoch, sequence, ...history } = this.history.page(this.sequence);
      this.cachedSnapshot = { ...this.state, epoch, sequence, messages, history };
      this.timings.snapshotBuildMs = performance.now() - started;
    }
    return this.cachedSnapshot;
  }
  private publish(entries: number[] = []) {
    this.cachedSnapshot = undefined;
    if (!this.initialized) return;
    const { models: _models, ...state } = this.state;
    const update: ChatUpdate = {
      epoch: this.history.epoch,
      sequence: this.sequence,
      state,
      messages: [...new Set(entries)].map((id) => this.history.message(id)),
      total: this.history.length,
    };
    this.emit('event', update);
  }
  private publishState() {
    this.sequence++;
    this.publish();
  }

  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private stderr = '';
  private refreshTimer?: NodeJS.Timeout;
  readonly ready: Promise<void>;
  constructor(
    public info: SessionInfo,
    config: Config,
  ) {
    super();
    this.setMaxListeners(100);
    this.state = {
      id: info.id,
      cwd: info.cwd,
      isStreaming: false,
      models: [],
      thinkingLevel: 'off',
      thinkingLevels: ['off'],
      pendingMessageCount: 0,
      exited: false,
      dialogs: [],
      activeTools: {},
    };
    const projectKey = `--${info.cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const sessionDirectory = info.path
      ? path.dirname(info.path)
      : path.join(config.sessionDirectory, projectKey);
    const args = [
      '--mode',
      'rpc',
      '--session-dir',
      sessionDirectory,
      ...(info.path ? ['--session', info.path] : ['--session-id', info.id]),
    ];
    this.process = spawn(config.piCommand, args, {
      cwd: info.cwd,
      env: process.env,
      stdio: 'pipe',
    });
    createInterface({ input: this.process.stdout, crlfDelay: Infinity }).on('line', (line) =>
      this.onLine(line),
    );
    this.process.stderr.on('data', (data) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000);
    });
    this.process.stdin.on('error', () => {});
    this.process.on('error', (error) => this.fail(error.message));
    this.process.on('exit', (code, signal) =>
      this.fail(`Pi exited (${signal || code}). ${this.stderr}`.trim()),
    );
    this.ready = this.initialize();
    this.ready.catch(() => {});
  }
  private async initialize() {
    try {
      const [, , models, levels] = await Promise.all([
        this.command('get_state', {}, (state) => this.applyState(state)),
        this.retrieveHistory(),
        this.command('get_available_models'),
        this.command('get_available_thinking_levels'),
      ]);
      this.state = {
        ...this.state,
        models: models.models.map(displayModel),
        thinkingLevels: levels.levels,
      };
      this.initialized = true;
      this.cachedSnapshot = undefined;
      this.timings.readyMs = performance.now() - this.started;
    } catch (error) {
      this.fail((error as Error).message);
      this.process.kill('SIGTERM');
      throw error;
    }
  }
  private pickState(state: RpcState): Partial<SessionState> {
    return {
      model: state.model ? displayModel(state.model) : undefined,
      thinkingLevel: state.thinkingLevel,
      isStreaming: state.isStreaming,
      pendingMessageCount: state.pendingMessageCount,
    };
  }
  private applyState(state: RpcState) {
    this.state = { ...this.state, ...this.pickState(state) };
    if (state.sessionFile) this.info.path = state.sessionFile;
    if (state.sessionName) this.info.name = state.sessionName;
    this.cachedSnapshot = undefined;
  }
  private retrieveHistory() {
    return this.command('get_messages', {}, (history) => {
      const started = performance.now();
      this.history = new SessionHistory(history.messages, this.sequence);
      this.historyLoaded = true;
      this.cachedSnapshot = undefined;
      this.timings.historyIndexMs = performance.now() - started;
      if (this.initialized) this.emit('snapshot', this.snapshot);
    });
  }
  private onLine(line: string) {
    const received = performance.now();
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
      if (!event || typeof event !== 'object') return;
    } catch {
      return;
    }
    if (event.type === 'response') {
      const request = typeof event.id === 'string' ? this.pending.get(event.id) : undefined;
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(event.id as string);
        if (!this.timings.firstRpcMs) this.timings.firstRpcMs = performance.now() - this.started;
        if (request.type === 'get_messages') {
          this.timings.historyRpcCalls++;
          this.timings.historyRpcMs = received - request.started;
          this.timings.historyParseMs = performance.now() - received;
          this.timings.historyRpcBytes = Buffer.byteLength(line);
        }
        if (event.success) {
          try {
            request.onData?.(event.data);
            request.resolve(event.data);
          } catch (error) {
            request.reject(error instanceof Error ? error : new Error(String(error)));
          }
        } else request.reject(new Error(String(event.error || 'Pi command failed.')));
      }
      return;
    }
    if (event.type === 'extension_ui_request') {
      if (
        typeof event.method === 'string' &&
        ['confirm', 'select', 'input', 'editor'].includes(event.method)
      ) {
        this.state = {
          ...this.state,
          dialogs: [...this.state.dialogs, event as unknown as ExtensionDialog],
        };
        this.publishState();
      } else if (event.method === 'notify') {
        this.emit('notice', event.message);
      }
      return;
    }
    this.sequence++;
    // Full arguments/output belong to indexed messages, not repeatedly sent metadata.
    const metadataEvent = { ...event, args: undefined } as PiEvent;
    if (metadataEvent.partialResult !== undefined)
      metadataEvent.partialResult =
        typeof metadataEvent.partialResult === 'string'
          ? metadataEvent.partialResult.slice(-4096)
          : 'Tool output is streaming…';
    this.state = reducePiEvent(this.state, metadataEvent);
    let entries: number[] = [];
    if (this.historyLoaded && event.message) {
      if (event.type === 'message_start')
        entries = this.history.append(event.message as ChatMessage, this.sequence);
      else if (event.type === 'message_update' || event.type === 'message_end')
        entries = this.history.update(event.message as ChatMessage, this.sequence);
    }
    this.publish(entries);
    if (
      [
        'compaction_end',
        'auto_compaction_end',
        'session_switch',
        'session_fork',
        'session_tree',
      ].includes(String(event.type)) ||
      (event.type === 'entry_appended' &&
        ['context_edit', 'custom_message', 'compaction'].includes(
          String((event.entry as { type?: string })?.type),
        ))
    )
      void this.retrieveHistory().catch((error) => this.emit('notice', error.message));
    if (event.type === 'agent_settled') {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.refresh().catch((error) => this.emit('notice', error.message));
      }, 50);
    }
  }
  command<K extends keyof RpcResults>(
    type: K,
    fields: Record<string, unknown> = {},
    onData?: (data: RpcResults[K]) => void,
  ): Promise<RpcResults[K]> {
    if (this.state.exited)
      return Promise.reject(new Error(this.state.error || 'Pi is not running.'));
    const id = randomUUID();
    return new Promise<RpcResults[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not respond to ${type} within 60 seconds.`));
      }, 60_000);
      this.pending.set(id, {
        resolve: (data) => resolve(data as RpcResults[K]),
        reject,
        timer,
        type,
        started: performance.now(),
        onData: onData ? (data) => onData(data as RpcResults[K]) : undefined,
      });
      this.process.stdin.write(JSON.stringify({ ...fields, id, type }) + '\n');
    });
  }
  async refresh() {
    // RPC callbacks apply state at the response boundary, before subsequent live events.
    const [, levels] = await Promise.all([
      this.command('get_state', {}, (state) => {
        this.applyState(state);
        this.publishState();
      }),
      this.command('get_available_thinking_levels'),
    ]);
    this.state = { ...this.state, thinkingLevels: levels.levels };
    this.publishState();
  }
  async prompt(message: string, behavior: 'steer' | 'followUp') {
    const result = await this.command('prompt', { message, streamingBehavior: behavior });
    if (result?.disposition === 'queued') {
      this.state = {
        ...this.state,
        pendingMessageCount: this.state.pendingMessageCount + 1,
      };
      this.publishState();
    }
    return result;
  }
  respond(id: string, value: Record<string, unknown>) {
    if (!this.state.dialogs.some((dialog) => dialog.id === id))
      throw new Error('This prompt is no longer pending.');
    this.process.stdin.write(
      JSON.stringify({ type: 'extension_ui_response', id, ...value }) + '\n',
    );
    this.state = {
      ...this.state,
      dialogs: this.state.dialogs.filter((dialog) => dialog.id !== id),
    };
    this.publishState();
  }
  private fail(message: string) {
    if (this.state.exited) return;
    clearTimeout(this.refreshTimer);
    this.state = { ...this.state, error: message, exited: true, isStreaming: false };
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    this.pending.clear();
    this.publishState();
    if (!this.initialized) this.emit('snapshot', this.snapshot);
  }
  async stop() {
    await this.command('clear_queue');
    await this.command('abort');
    await this.refresh();
  }
  close() {
    this.process.stdin.end();
  }
}
