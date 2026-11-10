import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  FolderOpen,
  MessageCircle,
  Plus,
  RefreshCw,
  Square,
  ChevronDown,
  Circle,
  Search,
} from 'lucide-react';
import type { ExtensionDialog, SessionInfo, TabParams } from '../../shared/types';
import { useApp } from '../state';
import { api, basename, errorText, json, storageGet, storageSet } from '../lib/api';
import { useSession } from '../lib/useSession';
import { captureScroll, restoreScroll, type ScrollAnchor } from '../lib/scroll';
import { DirectoryTree } from '../components/DirectoryTree';
import { ErrorMessage, IconButton, Loading, Modal } from '../components/ui';
import { ChatMessages } from '../components/ChatMessages';

interface Props {
  params: TabParams;
  update: (changes: Partial<TabParams>, title?: string) => void;
}
export function ChatTab({ params, update }: Props) {
  return params.sessionId ? (
    <Conversation
      key={params.sessionId}
      id={params.sessionId}
      back={() => update({ sessionId: undefined }, 'Chat')}
    />
  ) : (
    <SessionPicker params={params} update={update} />
  );
}
function SessionPicker({ params, update }: Props) {
  const { preferences } = useApp();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [cwd, setCwd] = useState(params.directory || preferences.defaultDirectory);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setError('');
    api<SessionInfo[]>('/api/sessions')
      .then((value) => {
        if (live) setSessions(value);
      })
      .catch((error) => {
        if (live) setError(errorText(error));
      });
    return () => {
      live = false;
    };
  }, [refresh]);
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const session = await api<SessionInfo>(
        '/api/sessions',
        json('POST', { cwd, name: name.trim() || undefined }),
      );
      update({ sessionId: session.id, directory: cwd }, session.name);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const filtered = sessions?.filter((session) =>
    `${session.name} ${session.cwd}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="session-picker">
      <div className="new-conversation">
        <label className="field-label" htmlFor={`name-${params.directory}`}>
          New conversation
        </label>
        <input
          id={`name-${params.directory}`}
          aria-label="Conversation name"
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
        />
        <button className="directory-choice" onClick={() => setChoosing(true)} title={cwd}>
          <FolderOpen size={16} />
          <span>{cwd}</span>
          <ChevronDown size={14} />
        </button>
        <button className="primary" onClick={() => void start()} disabled={busy}>
          <Plus size={16} />
          {busy ? 'Starting pi…' : 'Start conversation'}
        </button>
      </div>
      {error && <ErrorMessage message={error} />}
      <div className="session-search">
        <Search size={15} />
        <input
          aria-label="Find a conversation"
          placeholder="Find a conversation…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <IconButton label="Refresh sessions" onClick={() => setRefresh((r) => r + 1)}>
          <RefreshCw size={15} />
        </IconButton>
      </div>
      <div className="session-list">
        {sessions === null ? (
          <Loading label="Finding sessions…" />
        ) : filtered?.length ? (
          filtered.map((session) => (
            <button
              className="session-card"
              key={session.id}
              onClick={() =>
                update({ sessionId: session.id, directory: session.cwd }, session.name)
              }
            >
              <span className="session-symbol">
                {session.running ? <span className="live-dot" /> : <MessageCircle size={17} />}
              </span>
              <span className="session-copy">
                <strong>{session.name}</strong>
                <span title={session.cwd}>{session.cwd}</span>
              </span>
              <time>
                {new Date(session.modified).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </time>
            </button>
          ))
        ) : (
          <div className="empty-small">
            {search ? 'No matching conversations.' : 'No conversations'}
          </div>
        )}
      </div>
      {choosing && (
        <Modal
          title="Conversation directory"
          close={() => setChoosing(false)}
          className="directory-modal"
        >
          <DirectoryTree directory={cwd} onDirectory={setCwd} directoriesOnly />
          <button
            className="primary full-width"
            onClick={() => {
              update({ directory: cwd });
              setChoosing(false);
            }}
          >
            Use this directory
          </button>
        </Modal>
      )}
    </section>
  );
}
function Conversation({ id, back }: { id: string; back: () => void }) {
  const { preferences } = useApp();
  const { snapshot, connection, error, setError, loadOlder, loadingOlder, syncing, loadMessage } =
    useSession(id);
  const [draft, setDraft] = useState(() => storageGet(`lentz-chat-draft:${id}`) || '');
  const [behavior, setBehavior] = useState<'followUp' | 'steer'>('followUp');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<ScrollAnchor | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (anchor.current) {
      restoreScroll(element, anchor.current);
      anchor.current = null;
    } else if (stick.current) element.scrollTop = element.scrollHeight;
    const received = performance.getEntriesByName(`lentz:${id}:received`).at(-1);
    if (received) {
      performance.clearMeasures(`lentz:${id}:commit`);
      performance.measure(`lentz:${id}:commit`, {
        start: received.startTime,
        end: performance.now(),
      });
      performance.clearMarks(`lentz:${id}:received`);
      requestAnimationFrame(() => {
        performance.clearMeasures(`lentz:${id}:next-frame`);
        performance.measure(`lentz:${id}:next-frame`, {
          start: received.startTime,
          end: performance.now(),
        });
      });
    }
  }, [id, snapshot?.messages, snapshot?.activeTools, snapshot?.dialogs]);
  const older = () =>
    void loadOlder(() => {
      if (scroll.current) {
        anchor.current = captureScroll(scroll.current);
        stick.current = false;
      }
    });
  const send = async () => {
    if (!draft.trim() || sending) return;
    const sent = draft;
    setSending(true);
    setError('');
    try {
      await api(`/api/sessions/${id}/prompt`, json('POST', { message: sent, behavior }));
      setDraft((current) => {
        if (current === sent) {
          storageSet(`lentz-chat-draft:${id}`, '');
          return '';
        }
        return current;
      });
      stick.current = true;
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSending(false);
      composer.current?.focus();
    }
  };
  const stop = async () => {
    setStopping(true);
    try {
      await api(`/api/sessions/${id}/stop`, json('POST'));
    } catch (error) {
      setError(errorText(error));
    } finally {
      setStopping(false);
    }
  };
  const settings = async (value: Record<string, string>) => {
    try {
      await api(`/api/sessions/${id}/settings`, json('PATCH', value));
    } catch (error) {
      setError(errorText(error));
    }
  };
  return (
    <section className="conversation">
      <div className="chat-toolbar">
        <IconButton label="Back to conversations" onClick={back}>
          <ArrowLeft size={16} />
        </IconButton>
        <span className="chat-directory" title={snapshot?.cwd}>
          <FolderOpen size={14} />
          {snapshot ? basename(snapshot.cwd) : 'Connecting'}
        </span>
        <span className="spacer" />
        <span className="connection-state">
          {snapshot?.isStreaming ? (
            <>
              <span className="live-dot" />
              Working
            </>
          ) : connection !== 'Connected' ? (
            connection
          ) : (
            <>
              <Circle size={7} />
              Ready
            </>
          )}
        </span>
      </div>
      {error && <ErrorMessage message={error} />}
      {snapshot?.error && <ErrorMessage message={snapshot.error} />}
      <div
        ref={scroll}
        className="chat-scroll"
        onScroll={() => {
          const element = scroll.current!;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
        }}
      >
        {snapshot?.history.olderCursor && (
          <div className="history-controls">
            <button className="small-button" disabled={loadingOlder} onClick={older}>
              {loadingOlder ? 'Loading older…' : 'Load older messages'}
            </button>
          </div>
        )}
        {syncing && (
          <div className="history-sync" role="status">
            Catching up…
          </div>
        )}
        {!snapshot ? (
          <Loading label="Opening pi session…" />
        ) : (
          <ChatMessages state={snapshot} loadMessage={loadMessage} />
        )}
        {snapshot?.dialogs.map((dialog) => (
          <ExtensionPrompt key={dialog.id} sessionId={id} dialog={dialog} onError={setError} />
        ))}
        {snapshot?.isStreaming && (
          <div className="working-indicator">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      <div className="composer-wrap">
        {snapshot && (
          <div className="model-controls">
            <select
              aria-label="Model"
              value={snapshot.model ? `${snapshot.model.provider}::${snapshot.model.id}` : ''}
              onChange={(e) => {
                const [provider, modelId] = e.target.value.split('::');
                void settings({ provider, modelId });
              }}
            >
              {!snapshot.model && <option value="">Select model</option>}
              {snapshot.model &&
                !snapshot.models.some(
                  (m) => m.id === snapshot.model?.id && m.provider === snapshot.model.provider,
                ) && (
                  <option value={`${snapshot.model.provider}::${snapshot.model.id}`}>
                    {snapshot.model.name || snapshot.model.id}
                  </option>
                )}
              {snapshot.models.map((model) => (
                <option
                  key={`${model.provider}:${model.id}`}
                  value={`${model.provider}::${model.id}`}
                >
                  {model.name || model.id} · {model.provider}
                </option>
              ))}
            </select>
            <select
              aria-label="Thinking level"
              value={snapshot.thinkingLevel}
              onChange={(e) => void settings({ thinkingLevel: e.target.value })}
            >
              {snapshot.thinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {level === 'off' ? 'Thinking off' : `Thinking: ${level}`}
                </option>
              ))}
            </select>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={composer}
            aria-label="Message pi"
            placeholder="Message"
            rows={3}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              storageSet(`lentz-chat-draft:${id}`, e.target.value);
            }}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                ((preferences.sendOnEnter && !e.shiftKey) || e.ctrlKey || e.metaKey)
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-actions">
            <span className="composer-hint">
              {snapshot?.pendingMessageCount ? `${snapshot.pendingMessageCount} queued` : ''}
            </span>
            <span className="spacer" />
            {snapshot?.isStreaming && (
              <>
                <select
                  aria-label="Message delivery"
                  value={behavior}
                  onChange={(e) => setBehavior(e.target.value as typeof behavior)}
                >
                  <option value="followUp">Queue</option>
                  <option value="steer">Steer</option>
                </select>
                <IconButton
                  label="Stop agent"
                  type="button"
                  onClick={() => void stop()}
                  disabled={stopping}
                >
                  <Square size={14} fill="currentColor" />
                </IconButton>
              </>
            )}
            <button
              className="send-button"
              aria-label="Send message"
              disabled={
                !draft.trim() ||
                sending ||
                !snapshot ||
                snapshot.exited ||
                connection !== 'Connected'
              }
            >
              <ArrowUp size={13} />
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
function ExtensionPrompt({
  sessionId,
  dialog,
  onError,
}: {
  sessionId: string;
  dialog: ExtensionDialog;
  onError: (value: string) => void;
}) {
  const [value, setValue] = useState(dialog.prefill || '');
  const respond = async (fields: Record<string, unknown>) => {
    try {
      await api(`/api/sessions/${sessionId}/dialog`, json('POST', { id: dialog.id, ...fields }));
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <div className="extension-prompt">
      <strong>{dialog.title}</strong>
      {dialog.message && <p>{dialog.message}</p>}
      {dialog.method === 'select' ? (
        dialog.options?.map((option) => (
          <button key={option} onClick={() => void respond({ value: option })}>
            {option}
          </button>
        ))
      ) : dialog.method === 'confirm' ? (
        <>
          <button onClick={() => void respond({ confirmed: false })}>No</button>
          <button className="primary" onClick={() => void respond({ confirmed: true })}>
            Yes
          </button>
        </>
      ) : (
        <>
          <textarea
            aria-label={dialog.title}
            placeholder={dialog.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button onClick={() => void respond({ value })}>Submit</button>
        </>
      )}
      <button className="text-button" onClick={() => void respond({ cancelled: true })}>
        Dismiss
      </button>
    </div>
  );
}
