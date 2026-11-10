import { useState, type ReactNode } from 'react';
import { Check, FolderOpen, Trash2 } from 'lucide-react';
import { useApp } from '../state';
import type { Preferences } from '../../shared/types';
import { errorText } from '../lib/api';
import { DirectoryTree } from '../components/DirectoryTree';
import { Modal } from '../components/ui';

function Setting({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row" title={description}>
      <div>
        <strong>{title}</strong>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
export function SettingsTab() {
  const app = useApp();
  const { preferences: prefs } = app;
  const [choosing, setChoosing] = useState(false);
  const [directory, setDirectory] = useState(prefs.defaultDirectory);
  const [confirmDelete, setConfirmDelete] = useState('');
  const update = (changes: Partial<Preferences>) =>
    app.updatePreferences(changes).catch((error) => app.notice(errorText(error)));
  const toggle = (name: 'motion' | 'showHidden' | 'sendOnEnter' | 'htmlScripts', label: string) => (
    <button
      role="switch"
      aria-checked={prefs[name]}
      aria-label={label}
      className={`switch ${prefs[name] ? 'on' : ''}`}
      onClick={() => void update({ [name]: !prefs[name] })}
    >
      {prefs[name] && <Check size={12} />}
    </button>
  );
  return (
    <section className="settings-scroll">
      <div className="settings-content">
        <h2 className="section-title">Appearance</h2>
        <Setting title="Appearance">
          <select
            aria-label="Appearance"
            value={prefs.theme}
            onChange={(e) => void update({ theme: e.target.value as Preferences['theme'] })}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Setting>
        <Setting title="Accent">
          <div className="swatches" role="group" aria-label="Accent color">
            {(['mono', 'sage', 'blue', 'rose'] as const).map((accent) => (
              <button
                key={accent}
                className={`swatch ${accent}`}
                aria-label={
                  accent === 'mono' ? 'Monochrome' : accent[0].toUpperCase() + accent.slice(1)
                }
                aria-pressed={prefs.accent === accent}
                onClick={() => void update({ accent })}
              >
                {prefs.accent === accent && <Check size={12} />}
              </button>
            ))}
          </div>
        </Setting>
        <Setting title="Text size">
          <input
            type="range"
            aria-label="Text size"
            min={12}
            max={20}
            value={prefs.fontSize}
            onChange={(e) => void update({ fontSize: Number(e.target.value) })}
          />
          <span>{prefs.fontSize}</span>
        </Setting>
        <Setting
          title="Motion"
          description="Gentle transitions; respects reduced-motion preferences."
        >
          {toggle('motion', 'Motion')}
        </Setting>
        <h2 className="section-title">Files & conversations</h2>
        <Setting title="Show hidden files">{toggle('showHidden', 'Show hidden files')}</Setting>
        <Setting title="Enter to send" description="Shift + Enter always inserts a new line.">
          {toggle('sendOnEnter', 'Enter to send')}
        </Setting>
        <Setting
          title="HTML scripts"
          description="Run scripts inside isolated HTML previews. Network requests and access to this app stay blocked."
        >
          {toggle('htmlScripts', 'HTML scripts')}
        </Setting>
        <Setting
          title="Default directory"
          description="Starting point for new tabs; each tab can navigate independently."
        >
          <button
            className="directory-setting"
            title={prefs.defaultDirectory}
            onClick={() => {
              setDirectory(prefs.defaultDirectory);
              setChoosing(true);
            }}
          >
            <FolderOpen size={15} />
            <span>{prefs.defaultDirectory}</span>
          </button>
        </Setting>
        <h2 className="section-title">Workspaces</h2>
        {app.workspaces.map((workspace) => (
          <form
            key={workspace.id}
            className="workspace-setting"
            onSubmit={(e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get('name') as string;
              app
                .renameWorkspace(workspace.id, name)
                .then(() => app.notice('Workspace renamed'))
                .catch((error) => app.notice(errorText(error)));
            }}
          >
            <input
              aria-label={`Name for ${workspace.name}`}
              name="name"
              defaultValue={workspace.name}
              key={workspace.name}
              maxLength={80}
              required
            />
            <button type="submit" className="small-button">
              Rename
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Delete ${workspace.name}`}
              disabled={app.workspaces.length < 2}
              onClick={() => setConfirmDelete(workspace.id)}
            >
              <Trash2 size={15} />
            </button>
          </form>
        ))}
        <h2 className="section-title">This server</h2>
        <dl className="server-details">
          <dt>File root</dt>
          <dd>{app.config.root}</dd>
          <dt>Workspace storage</dt>
          <dd>{app.config.dataDirectory}</dd>
          <dt>Pi sessions</dt>
          <dd>{app.config.sessionDirectory}</dd>
          <dt>Pi command</dt>
          <dd>{app.config.piCommand}</dd>
        </dl>
      </div>
      {choosing && (
        <Modal
          title="Default directory"
          close={() => setChoosing(false)}
          className="directory-modal"
        >
          <DirectoryTree directory={directory} onDirectory={setDirectory} directoriesOnly />
          <button
            className="primary full-width"
            onClick={() => {
              void update({ defaultDirectory: directory });
              setChoosing(false);
            }}
          >
            Use this directory
          </button>
        </Modal>
      )}
      {confirmDelete && (
        <Modal title="Remove workspace?" close={() => setConfirmDelete('')}>
          <p>
            Only its saved layout will be removed. Conversations keep running and files stay on
            disk.
          </p>
          <div className="modal-actions">
            <button onClick={() => setConfirmDelete('')}>Keep workspace</button>
            <button
              className="danger"
              onClick={() =>
                app
                  .deleteWorkspace(confirmDelete)
                  .then(() => setConfirmDelete(''))
                  .catch((error) => app.notice(errorText(error)))
              }
            >
              Remove workspace
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
