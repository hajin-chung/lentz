import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Bootstrap, Preferences, Workspace } from '../shared/types';
import type { SerializedDockview } from 'dockview-react';
import { api, ApiError, errorText, json, storageGet, storageSet } from './lib/api';

interface AppState extends Bootstrap {
  activeId: string;
  setActiveId: (id: string) => void;
  saveLayout: (id: string, layout: SerializedDockview) => void;
  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  updatePreferences: (changes: Partial<Preferences>) => Promise<void>;
  notice: (message: string) => void;
  saveStatus: string;
}
const StateContext = createContext<AppState | null>(null);
export function useApp() {
  const state = useContext(StateContext);
  if (!state) throw new Error('Missing app state');
  return state;
}

export function StateProvider({ initial, children }: { initial: Bootstrap; children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState(initial.workspaces);
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const [preferences, setPreferences] = useState(initial.preferences);
  const [activeId, selectActive] = useState(
    () =>
      initial.workspaces.find((w) => w.id === storageGet('lentz-workspace'))?.id ||
      initial.workspaces[0].id,
  );
  const [message, notice] = useState('');
  const [saveStatus, setSaveStatus] = useState('Saved');
  const pending = useRef(new Map<string, SerializedDockview>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const saving = useRef(new Map<string, Promise<void>>());
  const blocked = useRef(new Set<string>());
  const updateWorkspace = (workspace: Workspace) => {
    workspacesRef.current = workspacesRef.current.map((w) =>
      w.id === workspace.id ? workspace : w,
    );
    setWorkspaces(workspacesRef.current);
  };
  const flush = async (id: string): Promise<void> => {
    if (saving.current.has(id)) return saving.current.get(id);
    if (blocked.current.has(id)) return;
    const task = (async () => {
      while (pending.current.has(id)) {
        const layout = pending.current.get(id)!;
        pending.current.delete(id);
        const workspace = workspacesRef.current.find((w) => w.id === id);
        if (!workspace) return;
        try {
          setSaveStatus('Saving…');
          const updated = await api<Workspace>(
            `/api/workspaces/${id}`,
            json('PUT', { layout, revision: workspace.revision }),
          );
          updateWorkspace(updated);
          setSaveStatus('Saved');
        } catch (error) {
          if (!pending.current.has(id)) pending.current.set(id, layout);
          setSaveStatus('Not saved');
          if (error instanceof ApiError && error.status === 409) {
            blocked.current.add(id);
            notice(`${errorText(error)} Your current layout remains open.`);
          } else {
            notice('Layout could not reach the server. Keeping it open and retrying.');
            timers.current.set(
              id,
              setTimeout(() => {
                void flush(id);
              }, 5000),
            );
          }
          break;
        }
      }
    })();
    saving.current.set(id, task);
    try {
      await task;
    } finally {
      saving.current.delete(id);
    }
  };
  const saveLayout = (id: string, layout: SerializedDockview) => {
    pending.current.set(id, layout);
    setSaveStatus('Saving…');
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => {
        void flush(id);
      }, 350),
    );
  };
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === 'hidden')
        for (const id of pending.current.keys()) void flush(id);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending.current.size || saving.current.size) {
        event.preventDefault();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = preferences.theme;
    root.dataset.accent = preferences.accent;
    root.dataset.motion = String(preferences.motion);
    root.style.setProperty('--text-size', `${preferences.fontSize}px`);
    storageSet('lentz-theme', preferences.theme);
  }, [preferences]);
  const setActiveId = (id: string) => {
    void flush(activeId);
    selectActive(id);
    storageSet('lentz-workspace', id);
  };
  const createWorkspace = async (name: string) => {
    const created = await api<Workspace>('/api/workspaces', json('POST', { name }));
    workspacesRef.current = [...workspacesRef.current, created];
    setWorkspaces(workspacesRef.current);
    setActiveId(created.id);
  };
  const renameWorkspace = async (id: string, name: string) => {
    await flush(id);
    const current = workspacesRef.current.find((w) => w.id === id)!;
    updateWorkspace(
      await api<Workspace>(
        `/api/workspaces/${id}`,
        json('PUT', { name, revision: current.revision }),
      ),
    );
  };
  const deleteWorkspace = async (id: string) => {
    await flush(id);
    await api(`/api/workspaces/${id}`, json('DELETE'));
    pending.current.delete(id);
    clearTimeout(timers.current.get(id));
    const remaining = workspacesRef.current.filter((w) => w.id !== id);
    workspacesRef.current = remaining;
    setWorkspaces(remaining);
    if (id === activeId) setActiveId(remaining[0].id);
  };
  const updatePreferences = async (changes: Partial<Preferences>) => {
    const next = await api<Preferences>('/api/preferences', json('PATCH', changes));
    setPreferences(next);
  };
  return (
    <StateContext.Provider
      value={{
        ...initial,
        workspaces,
        preferences,
        activeId,
        setActiveId,
        saveLayout,
        createWorkspace,
        renameWorkspace,
        deleteWorkspace,
        updatePreferences,
        notice,
        saveStatus,
      }}
    >
      {children}
      {message && (
        <div className="toast" role="alert">
          <span>{message}</span>
          <button onClick={() => notice('')} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      )}
    </StateContext.Provider>
  );
}
