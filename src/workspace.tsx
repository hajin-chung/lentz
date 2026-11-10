import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
  type IDockviewHeaderActionsProps,
  type SerializedDockview,
} from 'dockview-react';
import {
  MessageCircle,
  FolderOpen,
  Settings2,
  Plus,
  Columns2,
  Rows2,
  Maximize2,
  X,
  Layers,
  Check,
  ChevronDown,
} from 'lucide-react';
import type { TabKind, TabParams, Workspace } from '../shared/types';
import { useApp } from './state';
import { basename, errorText, storageGet, storageSet, uuid } from './lib/api';
import { IconButton, Modal } from './components/ui';
import { FileTab } from './tabs/FileTab';
import { ChatTab } from './tabs/ChatTab';
import { SettingsTab } from './tabs/SettingsTab';
import { withDesktopGeometry } from './lib/layout';

interface WorkspaceControls {
  addTab: (
    kind: TabKind,
    params?: Partial<TabParams>,
    groupId?: string,
    direction?: 'right' | 'below',
  ) => void;
  showPaneMenu: (groupId: string) => void;
  changed: () => void;
  mobile: boolean;
}
const ControlsContext = createContext<WorkspaceControls>(null!);
export const useWorkspace = () => useContext(ControlsContext);
const icons = { chat: MessageCircle, files: FolderOpen, settings: Settings2 };
const titles = { chat: 'Chat', files: 'Files', settings: 'Settings' };

function TabContent(props: IDockviewPanelProps<TabParams>) {
  const controls = useWorkspace();
  const update = useCallback(
    (changes: Partial<TabParams>, title?: string) => {
      props.api.updateParameters({ ...props.api.getParameters(), ...changes });
      if (title) props.api.setTitle(title);
      controls.changed();
    },
    [props.api, controls.changed],
  );
  const kind = props.params.kind;
  if (kind === 'files') return <FileTab params={props.params} update={update} />;
  if (kind === 'settings') return <SettingsTab />;
  return <ChatTab params={props.params} update={update} />;
}
function TabHeader(props: IDockviewPanelHeaderProps<TabParams>) {
  const [title, setTitle] = useState(props.api.title);
  useEffect(() => {
    const listener = props.api.onDidTitleChange((e) => setTitle(e.title));
    return () => listener.dispose();
  }, [props.api]);
  const Icon = icons[props.params.kind] || MessageCircle;
  return (
    <div className="tab-header">
      <Icon size={14} />
      <span>{title}</span>
      <button
        className="tab-close"
        aria-label={`Close ${title} tab`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          props.api.close();
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
function HeaderActions(props: IDockviewHeaderActionsProps) {
  const { showPaneMenu } = useWorkspace();
  return (
    <div className="pane-actions">
      <IconButton label="Pane options" onClick={() => showPaneMenu(props.group.id)}>
        <Plus size={16} />
      </IconButton>
    </div>
  );
}
function EmptyWorkspace() {
  const { addTab } = useWorkspace();
  return (
    <div className="empty-workspace">
      <div className="start-actions">
        {(['chat', 'files', 'settings'] as TabKind[]).map((kind) => {
          const Icon = icons[kind];
          return (
            <button key={kind} onClick={() => addTab(kind)}>
              <Icon size={18} />
              {titles[kind]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
const components = { content: TabContent };

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const app = useApp();
  const appRef = useRef(app);
  appRef.current = app;
  const apiRef = useRef<DockviewApi | null>(null);
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 700px)').matches);
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  const [menu, setMenu] = useState<string | null>(null);
  const [launcher, setLauncher] = useState(false);
  const [newName, setNewName] = useState('');
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [selectedGroup, setSelectedGroup] = useState('');
  const initializing = useRef(true);
  const listeners = useRef<{ dispose: () => void }[]>([]);
  const previousLayout = useRef<SerializedDockview | null>(null);
  const desktopLayout = useRef<SerializedDockview | null>(workspace.layout);
  const changed = useCallback(() => {
    const dock = apiRef.current;
    if (!dock || initializing.current) return;
    const layout = dock.toJSON();
    appRef.current.saveLayout(
      workspace.id,
      mobileRef.current ? withDesktopGeometry(layout, desktopLayout.current) : layout,
    );
  }, [workspace.id]);
  const addTab = useCallback(
    (
      kind: TabKind,
      params: Partial<TabParams> = {},
      groupId?: string,
      direction?: 'right' | 'below',
    ) => {
      const dock = apiRef.current;
      if (!dock) return;
      const group = groupId ? dock.getGroup(groupId) : dock.activeGroup;
      dock.addPanel({
        id: uuid(),
        component: 'content',
        title: params.file ? basename(params.file) : titles[kind],
        params: { kind, directory: appRef.current.preferences.defaultDirectory, ...params },
        position: group
          ? { referenceGroup: group.id, direction: direction || 'within' }
          : undefined,
        renderer: 'always',
      });
    },
    [],
  );
  const refreshGroups = useCallback(() => {
    const dock = apiRef.current;
    if (!dock) return;
    setGroups(
      dock.groups.map((group, index) => ({
        id: group.id,
        name: `${index + 1} · ${group.activePanel?.title || 'Pane'}`,
      })),
    );
    setSelectedGroup(dock.activeGroup?.id || '');
  }, []);
  const enforceMobile = useCallback(() => {
    const dock = apiRef.current;
    if (mobileRef.current && dock?.activePanel && !dock.activePanel.api.isMaximized())
      dock.maximizeGroup(dock.activePanel);
  }, []);
  const onReady = useCallback(
    ({ api: dock }: DockviewReadyEvent) => {
      apiRef.current = dock;
      setApi(dock);
      try {
        if (workspace.layout) dock.fromJSON(workspace.layout);
        else {
          addTab('chat');
          addTab('files', {}, dock.activeGroup?.id, 'right');
          dock.panels[0]?.api.setActive();
        }
      } catch (error) {
        appRef.current.notice(`Could not restore layout: ${errorText(error)}`);
      }
      const active = storageGet(`lentz-panel-${workspace.id}`);
      if (active) dock.getPanel(active)?.api.setActive();
      initializing.current = false;
      enforceMobile();
      refreshGroups();
      previousLayout.current = dock.toJSON();
      if (!mobileRef.current) desktopLayout.current = dock.toJSON();
      if (!workspace.layout) changed();
      listeners.current = [
        dock.onDidLayoutChange((event) => {
          refreshGroups();
          // Focus/maximize/viewport changes are device-local; structural edits are shared.
          const layout = dock.toJSON();
          const previous = previousLayout.current;
          const structure = (value: SerializedDockview) =>
            JSON.stringify({ panels: value.panels, grid: value.grid.root }, (key, value) =>
              ['activeView', 'activeGroup', 'size'].includes(key) ? undefined : value,
            );
          const structuralChange = previous && structure(layout) !== structure(previous);
          const sashResize =
            previous &&
            event.reasons.has('geometry') &&
            !mobileRef.current &&
            layout.grid.width === previous.grid.width &&
            layout.grid.height === previous.grid.height &&
            JSON.stringify(layout.grid.root) !== JSON.stringify(previous.grid.root);
          previousLayout.current = layout;
          if (!mobileRef.current && window.innerWidth > 700) desktopLayout.current = layout;
          if (structuralChange || sashResize) changed();
        }),
        dock.onDidActivePanelChange((event) => {
          if (event.panel) storageSet(`lentz-panel-${workspace.id}`, event.panel.id);
          refreshGroups();
          enforceMobile();
        }),
      ];
    },
    [workspace.id],
  );
  useEffect(() => {
    const query = matchMedia('(max-width: 700px)');
    const resize = () => {
      mobileRef.current = query.matches;
      setMobile(query.matches);
      if (query.matches) enforceMobile();
      else if (apiRef.current) {
        const dock = apiRef.current;
        const restored = withDesktopGeometry(dock.toJSON(), desktopLayout.current);
        initializing.current = true;
        dock.exitMaximizedGroup();
        dock.fromJSON(restored);
        previousLayout.current = dock.toJSON();
        initializing.current = false;
        refreshGroups();
      }
    };
    query.addEventListener('change', resize);
    return () => {
      query.removeEventListener('change', resize);
      listeners.current.forEach((listener) => listener.dispose());
    };
  }, [enforceMobile]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        setLauncher((value) => !value);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const run = (action: () => void) => {
    action();
    setMenu(null);
    setLauncher(false);
  };
  const pane = menu ? api?.getGroup(menu) : undefined;
  return (
    <ControlsContext.Provider value={{ addTab, changed, showPaneMenu: setMenu, mobile }}>
      <main className="workspace" aria-label={`${workspace.name} workspace`}>
        <DockviewReact
          components={components}
          defaultTabComponent={TabHeader}
          rightHeaderActionsComponent={HeaderActions}
          watermarkComponent={EmptyWorkspace}
          onReady={onReady}
          className="lentz-dock"
          disableFloatingGroups
          disableDnd={mobile}
        />
      </main>
      <footer className="workspace-bar" aria-label="Workspace controls">
        <button
          className="workspace-trigger"
          onClick={() => setLauncher(true)}
          title="Workspaces and tabs · Ctrl/⌘ K"
          aria-label="Open workspace menu"
        >
          <Layers size={12} />
          <span className="workspace-name">{workspace.name}</span>
          <ChevronDown size={13} />
          <span
            className={`save-dot ${app.saveStatus === 'Not saved' ? 'failed' : app.saveStatus === 'Saving…' ? 'pending' : ''}`}
            title={app.saveStatus}
          />
        </button>
        {mobile && groups.length > 1 && (
          <label className="mobile-pane-picker">
            <Layers size={15} />
            <select
              aria-label="Visible pane"
              value={selectedGroup}
              onChange={(e) => {
                const group = api?.getGroup(e.target.value);
                group?.activePanel?.api.setActive();
                enforceMobile();
              }}
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </footer>
      {menu && (
        <Modal title="This pane" close={() => setMenu(null)} className="command-modal">
          <div className="field-label">New tab</div>
          <div className="command-grid">
            {(['chat', 'files', 'settings'] as TabKind[]).map((kind) => {
              const Icon = icons[kind];
              return (
                <button key={kind} onClick={() => run(() => addTab(kind, {}, menu))}>
                  <Icon size={18} />
                  {titles[kind]}
                </button>
              );
            })}
          </div>
          <div className="menu-list">
            <button onClick={() => run(() => addTab('chat', {}, menu, 'right'))}>
              <Columns2 size={17} />
              Split side by side
            </button>
            <button onClick={() => run(() => addTab('chat', {}, menu, 'below'))}>
              <Rows2 size={17} />
              Split top and bottom
            </button>
            {!mobile && (
              <button
                onClick={() =>
                  run(() => {
                    if (api?.hasMaximizedGroup()) api.exitMaximizedGroup();
                    else if (pane?.activePanel) api?.maximizeGroup(pane.activePanel);
                  })
                }
              >
                <Maximize2 size={17} />
                {api?.hasMaximizedGroup() ? 'Restore layout' : 'Maximize pane'}
              </button>
            )}
            <button
              onClick={() =>
                run(() => {
                  if (pane) api?.removeGroup(pane);
                  enforceMobile();
                })
              }
            >
              <X size={17} />
              Close pane
            </button>
          </div>
        </Modal>
      )}
      {launcher && (
        <Modal title="Workspaces" close={() => setLauncher(false)} className="command-modal">
          <div className="workspace-list">
            {app.workspaces.map((item) => (
              <button
                key={item.id}
                onClick={() => run(() => app.setActiveId(item.id))}
                className={item.id === workspace.id ? 'selected' : ''}
              >
                <Layers size={17} />
                <span>{item.name}</span>
                {item.id === workspace.id && <Check size={16} />}
              </button>
            ))}
          </div>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim())
                app
                  .createWorkspace(newName.trim())
                  .then(() => setLauncher(false))
                  .catch((error) => app.notice(errorText(error)));
            }}
          >
            <input
              aria-label="New workspace name"
              placeholder="New workspace…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={80}
            />
            <IconButton label="Create workspace" type="submit" disabled={!newName.trim()}>
              <Plus size={18} />
            </IconButton>
          </form>
          <div className="field-label">Open a tab</div>
          <div className="command-grid">
            {(['chat', 'files', 'settings'] as TabKind[]).map((kind) => {
              const Icon = icons[kind];
              return (
                <button key={kind} onClick={() => run(() => addTab(kind))}>
                  <Icon size={18} />
                  {titles[kind]}
                </button>
              );
            })}
          </div>
          <div className="menu-footer">
            <span>{app.saveStatus}</span>
            <span>Ctrl / ⌘ K</span>
          </div>
        </Modal>
      )}
    </ControlsContext.Provider>
  );
}
