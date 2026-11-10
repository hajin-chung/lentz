import { useCallback, useEffect, useRef, useState } from 'react';
import {
  mergeSnapshot,
  mergeUpdate,
  mergePage,
  mergeDetail,
  type ChatView,
  type ChatSnapshot,
  type ChatUpdate,
  type HistoryMessage,
  type HistoryPage,
} from '../../shared/history';
import { api, errorText, json } from './api';

type StreamUpdate =
  | { kind: 'event'; data: ChatUpdate }
  | { kind: 'snapshot'; data: ChatSnapshot }
  | { kind: 'notice'; data: string }
  | { kind: 'connection'; data: boolean };
type Listener = (event: StreamUpdate) => void;

/** One stream per browser, regardless of tab count (HTTP/1 has a six-connection limit). */
class SessionStreams {
  private listeners = new Map<string, Set<Listener>>();
  private source?: EventSource;
  private scheduled = false;
  subscribe(id: string, listener: Listener) {
    let listeners = this.listeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(id, listeners);
      this.reconnect();
    }
    listeners.add(listener);
    if (this.source?.readyState === EventSource.OPEN) listener({ kind: 'connection', data: true });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.listeners.delete(id);
        this.reconnect();
      }
    };
  }
  private reconnect() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.source?.close();
      this.source = undefined;
      if (!this.listeners.size) return;
      const source = new EventSource(
        `/api/events?ids=${encodeURIComponent([...this.listeners.keys()].join(','))}`,
      );
      this.source = source;
      const connection = (connected: boolean) => {
        for (const listeners of this.listeners.values())
          for (const listener of listeners) listener({ kind: 'connection', data: connected });
      };
      source.onopen = () => connection(true);
      source.onerror = () => connection(false); // onopen reattaches sessions after a server restart.
      source.addEventListener('update', (event) => {
        const started = performance.now();
        const update = JSON.parse((event as MessageEvent).data) as StreamUpdate & { id: string };
        if (update.kind === 'snapshot') {
          performance.clearMeasures(`lentz:${update.id}:parse`);
          performance.measure(`lentz:${update.id}:parse`, {
            start: started,
            end: performance.now(),
          });
          performance.clearMarks(`lentz:${update.id}:received`);
          performance.mark(`lentz:${update.id}:received`);
        }
        for (const listener of this.listeners.get(update.id) || []) listener(update);
      });
    });
  }
}
const streams = new SessionStreams();

export function useSession(id: string) {
  const [snapshot, setSnapshot] = useState<ChatView | null>(null);
  const current = useRef<ChatView | null>(null);
  const [connection, setConnection] = useState('Connecting…');
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const olderBusy = useRef(false);
  const detailRequests = useRef(new Map<string, Promise<void>>());
  const alive = useRef(false);
  const apply = useCallback((value: ChatView) => {
    current.current = value;
    setSnapshot(value);
  }, []);
  useEffect(() => {
    let closed = false;
    alive.current = true;
    let attaching = false;
    let needsSnapshot = false;
    let pendingUpdates: ChatUpdate[] = [];
    let retry: ReturnType<typeof setTimeout>;
    let syncingHistory = false;
    let catchup: { epoch: string; cursor: string; target: number } | undefined;
    const synchronize = async () => {
      if (syncingHistory || !catchup || closed) return;
      syncingHistory = true;
      setSyncing(true);
      try {
        while (catchup && !closed) {
          const job: { epoch: string; cursor: string; target: number } = catchup;
          const page: HistoryPage = await api<HistoryPage>(
            `/api/sessions/${id}/history?from=${encodeURIComponent(job.cursor)}`,
          );
          if (closed || !current.current) break;
          if (current.current.epoch !== page.epoch) continue;
          if (catchup?.epoch !== page.epoch) continue;
          apply(mergePage(current.current, page));
          if (page.end >= catchup.target || !page.nextCursor) catchup = undefined;
          else catchup = { ...catchup, cursor: page.nextCursor };
        }
      } catch (error) {
        if (!closed) {
          setError(errorText(error));
          retry = setTimeout(() => void attach(), 1500);
        }
      } finally {
        syncingHistory = false;
        if (!closed) setSyncing(false);
      }
    };
    const queueCatchup = (previous: ChatView, total: number) => {
      // Revalidate the loaded range too: parallel tools may have updated an earlier entry.
      const first = previous.messages[0];
      if (catchup?.epoch === previous.epoch) catchup.target = Math.max(catchup.target, total);
      else
        catchup = {
          epoch: previous.epoch,
          cursor: first?.cursor || `${previous.epoch}.0`,
          target: total,
        };
      void synchronize();
    };
    const receiveUpdate = (incoming: ChatUpdate) => {
      const previous = current.current;
      if (!previous) {
        // A new view of an existing stream can receive deltas during its snapshot request.
        pendingUpdates = [...pendingUpdates.slice(-255), incoming];
        return;
      }
      if (previous.epoch !== incoming.epoch) {
        needsSnapshot = true;
        void attach();
        return;
      }
      if (incoming.sequence > previous.sequence + 1) queueCatchup(previous, incoming.total);
      apply(mergeUpdate(previous, incoming));
    };
    const receiveSnapshot = (incoming: ChatSnapshot) => {
      const previous = current.current;
      if (previous?.epoch === incoming.epoch && incoming.sequence > previous.sequence)
        queueCatchup(previous, incoming.history.end);
      if (previous?.epoch !== incoming.epoch) catchup = undefined;
      apply(mergeSnapshot(previous, incoming));
      const pending = pendingUpdates;
      pendingUpdates = [];
      for (const update of pending) receiveUpdate(update);
    };
    const attach = async () => {
      if (attaching || closed) return;
      attaching = true;
      try {
        await api(`/api/sessions/${id}/attach`, json('POST'));
        if (!closed) {
          // A second view can subscribe to an already-open multiplexed stream.
          // It needs its own recent page, without rebroadcasting to every other view.
          if (!current.current || catchup || needsSnapshot) {
            const before = current.current;
            const incoming = await api<ChatSnapshot>(`/api/sessions/${id}/snapshot`);
            if (closed) return;
            needsSnapshot = false;
            if (
              !current.current ||
              current.current.epoch === before?.epoch ||
              current.current.epoch === incoming.epoch
            )
              receiveSnapshot(incoming);
          }
          if (closed) return;
          setError('');
          setConnection('Connected');
          void synchronize();
        }
      } catch (error) {
        if (!closed) {
          setError(errorText(error));
          setConnection('Disconnected');
          retry = setTimeout(attach, 5000);
        }
      } finally {
        attaching = false;
      }
    };
    current.current = null;
    setSnapshot(null);
    const unsubscribe = streams.subscribe(id, (update) => {
      if (closed) return;
      if (update.kind === 'snapshot') receiveSnapshot(update.data);
      else if (update.kind === 'event') receiveUpdate(update.data);
      else if (update.kind === 'notice') setError(update.data);
      else {
        setConnection(update.data ? 'Connected' : 'Reconnecting…');
        if (update.data) void attach();
      }
    });
    return () => {
      closed = true;
      alive.current = false;
      unsubscribe();
      clearTimeout(retry);
    };
  }, [id, apply]);
  const loadOlder = useCallback(
    async (beforeMerge?: () => void) => {
      const initial = current.current;
      if (!initial?.history.olderCursor || olderBusy.current) return;
      olderBusy.current = true;
      setLoadingOlder(true);
      try {
        const page: HistoryPage = await api<HistoryPage>(
          `/api/sessions/${id}/history?before=${encodeURIComponent(initial.history.olderCursor)}`,
        );
        if (!alive.current || !current.current || current.current.epoch !== page.epoch) return;
        beforeMerge?.();
        apply(mergePage(current.current, page));
      } catch (error) {
        if (alive.current && current.current?.epoch === initial.epoch) setError(errorText(error));
      } finally {
        olderBusy.current = false;
        if (alive.current) setLoadingOlder(false);
      }
    },
    [id, apply],
  );
  const loadMessage = useCallback(
    (cursor: string): Promise<void> => {
      const pending = detailRequests.current.get(cursor);
      if (pending) return pending;
      const request = (async () => {
        try {
          const detail = await api<{ epoch: string; message: HistoryMessage }>(
            `/api/sessions/${id}/message?cursor=${encodeURIComponent(cursor)}`,
          );
          if (alive.current && current.current)
            apply(mergeDetail(current.current, detail.message, detail.epoch));
        } finally {
          detailRequests.current.delete(cursor);
        }
      })();
      detailRequests.current.set(cursor, request);
      return request;
    },
    [id, apply],
  );
  return { snapshot, connection, error, setError, loadOlder, loadingOlder, syncing, loadMessage };
}
