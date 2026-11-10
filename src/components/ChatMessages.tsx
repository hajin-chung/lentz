import { memo, Profiler, useMemo, useState, type ReactNode } from 'react';
import { Terminal } from 'lucide-react';
import type { ContentBlock, SessionState } from '../../shared/types';
import { resolvedMessage, type ChatView, type HistoryMessage } from '../../shared/history';
import { contentBlocks, groupMessages, type MessageGroup } from '../lib/chat';
import { errorText } from '../lib/api';
import Markdown from '../viewers/Markdown';
import { ErrorMessage } from './ui';

type LoadMessage = (cursor: string) => Promise<void>;

/** Closed sections never parse or fetch hidden bodies. */
function Disclosure({
  className,
  summary,
  children,
  anchor,
}: {
  className: string;
  summary: ReactNode;
  children: () => ReactNode;
  anchor?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-scroll-key={anchor}
      className={className}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {open && children()}
    </details>
  );
}
function LoadBody({
  cursor,
  loadMessage,
  label = 'Load full message',
}: {
  cursor: string;
  loadMessage: LoadMessage;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <button
        className="small-button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await loadMessage(cursor);
          } catch (error) {
            setError(errorText(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Loading…' : label}
      </button>
      {error && <ErrorMessage message={error} />}
    </>
  );
}

export function ChatMessages({
  state,
  loadMessage,
}: {
  state: ChatView;
  loadMessage: LoadMessage;
}) {
  const messages = useMemo(
    () => state.messages.map((message) => resolvedMessage(state, message)),
    [state.messages, state.details],
  );
  const groups = useMemo(() => groupMessages(messages), [messages]);
  const results = useMemo(() => {
    const byId = new Map(messages.map((message) => [message.entryId, message]));
    for (const detail of Object.values(state.details)) {
      const old = byId.get(detail.entryId);
      if (!old || detail.version >= old.version) byId.set(detail.entryId, detail);
    }
    const byGroup = new Map<number, HistoryMessage[]>();
    for (const message of byId.values())
      if (message.role === 'toolResult') {
        let list = byGroup.get(message.groupId);
        if (!list) byGroup.set(message.groupId, (list = []));
        list.push(message);
      }
    return byGroup;
  }, [messages, state.details]);
  return (
    <Profiler
      id={`chat:${state.id}`}
      onRender={(_id, _phase, actualDuration) => {
        performance.clearMeasures(`lentz:${state.id}:react-render`);
        performance.measure(`lentz:${state.id}:react-render`, {
          start: performance.now() - actualDuration,
          end: performance.now(),
        });
      }}
    >
      {groups.map((group) => (
        <Message
          key={group.key}
          group={group}
          activeTools={state.activeTools}
          results={results.get(group.key) || emptyResults}
          loadMessage={loadMessage}
        />
      ))}
    </Profiler>
  );
}
const emptyResults: HistoryMessage[] = [];
interface MessageProps {
  group: MessageGroup;
  activeTools: SessionState['activeTools'];
  results: HistoryMessage[];
  loadMessage: LoadMessage;
}
const sameItems = (a: HistoryMessage[], b: HistoryMessage[]) =>
  a.length === b.length && a.every((entry, i) => entry === b[i]);
const Message = memo(
  function Message({ group, activeTools, results, loadMessage }: MessageProps) {
    const activity: ReactNode[] = [];
    const calls = new Set<string>();
    for (const message of group.messages) {
      if (message.role === 'toolResult') continue;
      for (const [index, block] of contentBlocks(message).entries()) {
        if (block.type === 'thinking')
          activity.push(
            <div
              className="thinking-step"
              data-scroll-key={`thinking:${message.entryId}:${index}`}
              key={`${message.entryId}:${index}`}
            >
              <Markdown text={block.thinking || ''} />
            </div>,
          );
        if (block.type === 'toolCall') {
          const key = `${message.entryId}:${block.id}`;
          calls.add(key);
          const ref = block.id ? message.toolResults?.[block.id] : undefined;
          const result = results.find((result) =>
            ref
              ? result.entryId === ref.entryId
              : result.callId === message.entryId && result.toolCallId === block.id,
          );
          activity.push(
            <ToolCall
              key={key}
              anchor={key}
              block={block}
              result={result}
              resultRef={ref}
              active={block.id ? activeTools[block.id] : undefined}
              loadMessage={loadMessage}
            />,
          );
        }
      }
      if (
        message.deferred &&
        contentBlocks(message).some(
          (block) => block.type === 'thinking' || block.type === 'toolCall',
        )
      )
        activity.push(
          <LoadBody
            key={`full:${message.entryId}`}
            cursor={message.cursor}
            loadMessage={loadMessage}
            label="Load full activity"
          />,
        );
    }
    // A page may start after the call. Its result remains available until older pages
    // bring in the call; the same stable key then supplies the arguments and label.
    for (const result of group.messages.filter((message) => message.role === 'toolResult')) {
      const key = `${result.callId ?? result.entryId}:${result.toolCallId}`;
      if (!calls.has(key))
        activity.push(
          <ToolCall
            key={key}
            anchor={key}
            block={{
              type: 'toolCall',
              name: result.toolName || 'Tool result',
              id: result.toolCallId,
            }}
            result={result}
            loadMessage={loadMessage}
          />,
        );
    }
    return (
      <article className={`chat-message ${group.role}`} data-group-id={group.key}>
        <div className="message-role">
          {group.role === 'user' ? 'You' : group.role === 'assistant' ? 'PI' : group.role}
        </div>
        {activity.length > 0 && (
          <Disclosure className="thinking" summary="Thinking">
            {() => <div className="thinking-content">{activity}</div>}
          </Disclosure>
        )}
        {group.messages
          .filter((message) => message.role !== 'toolResult')
          .map((message) => {
            const visible = contentBlocks(message).filter(
              (block) => block.type === 'text' || block.type === 'image',
            );
            return (
              <div className="chat-entry" data-message-id={message.entryId} key={message.entryId}>
                {visible.map((block, index) =>
                  block.type === 'text' ? (
                    <Markdown key={index} text={block.text || ''} />
                  ) : block.data ? (
                    <img
                      key={index}
                      className="message-image"
                      alt="Conversation attachment"
                      src={`data:${block.mimeType};base64,${block.data}`}
                    />
                  ) : null,
                )}
                {message.deferred &&
                  (visible.length > 0 ||
                    !contentBlocks(message).some(
                      (block) => block.type === 'thinking' || block.type === 'toolCall',
                    )) && <LoadBody cursor={message.cursor} loadMessage={loadMessage} />}
                {message.errorMessage && <ErrorMessage message={message.errorMessage} />}
              </div>
            );
          })}
      </article>
    );
  },
  (a, b) =>
    a.group.key === b.group.key &&
    sameItems(a.group.messages, b.group.messages) &&
    sameItems(a.results, b.results) &&
    (a.activeTools === b.activeTools ||
      a.group.messages.every((message) =>
        contentBlocks(message).every(
          (block) => !block.id || a.activeTools[block.id] === b.activeTools[block.id],
        ),
      )) &&
    a.loadMessage === b.loadMessage,
);

function ToolCall({
  anchor,
  block,
  result,
  resultRef,
  active,
  loadMessage,
}: {
  anchor: string;
  block: ContentBlock;
  result?: HistoryMessage;
  resultRef?: { entryId: number; cursor: string; isError: boolean };
  active?: SessionState['activeTools'][string];
  loadMessage: LoadMessage;
}) {
  const args = block.arguments as Record<string, unknown> | undefined;
  const failed = result?.isError || resultRef?.isError;
  const cursor = result?.cursor || resultRef?.cursor;
  return (
    <Disclosure
      anchor={anchor}
      className={`tool-call ${failed ? 'tool-error' : ''}`}
      summary={
        <>
          <Terminal size={14} />
          <strong>{block.name}</strong>
          <span>{String(args?.path || args?.command || '').slice(0, 120)}</span>
          <span className="tool-status">
            {active ? 'running' : result || resultRef ? (failed ? 'failed' : 'done') : 'pending'}
          </span>
        </>
      }
    >
      {() => (
        <>
          {block.arguments !== undefined && <pre>{JSON.stringify(block.arguments, null, 2)}</pre>}
          {result && (
            <pre>
              {contentBlocks(result)
                .map((item) => item.text || '')
                .join('\n')}
            </pre>
          )}
          {cursor && (!result || result.deferred) && (
            <LoadBody cursor={cursor} loadMessage={loadMessage} label="Load full result" />
          )}
          {!result && active?.output !== undefined && <pre>{String(active.output)}</pre>}
        </>
      )}
    </Disclosure>
  );
}
