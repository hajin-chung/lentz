import { lazy, Suspense, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Pencil,
  Save,
  X,
  Download,
  RefreshCw,
  FileQuestion,
  FileText,
  Eye,
} from 'lucide-react';
import type { FileInfo, TabParams } from '../../shared/types';
import { DirectoryTree } from '../components/DirectoryTree';
import { ErrorMessage, IconButton, Loading } from '../components/ui';
import { api, basename, errorText, fileUrl, json } from '../lib/api';
import { useApp } from '../state';
import { useWorkspace } from '../workspace';

const FilePreview = lazy(() => import('../viewers/FilePreview'));
const TextEditor = lazy(() => import('../viewers/TextEditor'));
const TextPreview = lazy(() => import('../viewers/TextPreview'));
interface Draft {
  content: string;
  revision: string;
}
const drafts = new Map<string, Draft>();
function readDraft(path: string): Draft | undefined {
  if (drafts.has(path)) return drafts.get(path);
  try {
    const value = sessionStorage.getItem(`lentz-draft:${path}`);
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}
function rememberDraft(path: string, draft?: Draft) {
  if (draft) drafts.set(path, draft);
  else drafts.delete(path);
  try {
    if (draft) sessionStorage.setItem(`lentz-draft:${path}`, JSON.stringify(draft));
    else sessionStorage.removeItem(`lentz-draft:${path}`);
  } catch {
    /* Keep in-memory draft when browser storage is full. */
  }
}
export function FileTab({
  params,
  update,
}: {
  params: TabParams;
  update: (changes: Partial<TabParams>, title?: string) => void;
}) {
  const { preferences } = useApp();
  const { addTab } = useWorkspace();
  const directory = params.directory || preferences.defaultDirectory;
  if (params.file)
    return (
      <FileView
        key={params.file}
        path={params.file}
        view={params.fileView || 'auto'}
        changeView={(fileView) => update({ fileView })}
        back={() => update({ file: undefined, fileView: undefined }, 'Files')}
      />
    );
  return (
    <DirectoryTree
      directory={directory}
      onDirectory={(directory) => update({ directory }, basename(directory))}
      onFile={(file) => update({ file, fileView: undefined }, basename(file))}
      onNewTab={(file) => addTab('files', { directory, file })}
    />
  );
}
function FileView({
  path,
  view,
  changeView,
  back,
}: {
  path: string;
  view: 'auto' | 'text';
  changeView: (view: 'auto' | 'text') => void;
  back: () => void;
}) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<Draft | undefined>(() => readDraft(path));
  const [editing, setEditing] = useState(() => Boolean(readDraft(path)));
  const [busy, setBusy] = useState(false);
  const { notice } = useApp();
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<FileInfo>(`/api/files/info?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then(setInfo)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [path, refresh]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (editing && draft) event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editing, draft]);
  const edit = async () => {
    setBusy(true);
    setError('');
    try {
      const text = await api<Draft>(`/api/files/text?path=${encodeURIComponent(path)}`);
      setDraft(text);
      setEditing(true);
      rememberDraft(path, text);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/files/text', json('PUT', { path, ...draft }));
      rememberDraft(path);
      setDraft(undefined);
      setEditing(false);
      setRefresh((value) => value + 1);
      notice(`Saved ${basename(path)}`);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    rememberDraft(path);
    setDraft(undefined);
    setEditing(false);
    setError('');
    setRefresh((value) => value + 1);
  };
  return (
    <section className="file-view">
      <div className="file-toolbar">
        <IconButton label="Back to directory" onClick={back}>
          <ArrowLeft size={17} />
        </IconButton>
        <span className="file-path" title={path}>
          {basename(path)}
          {editing && <span className="draft-dot"> · draft</span>}
        </span>
        {editing ? (
          <>
            <button className="small-button primary" disabled={busy} onClick={() => void save()}>
              <Save size={14} />
              Save
            </button>
            <IconButton label="Discard draft" disabled={busy} onClick={cancel}>
              <X size={16} />
            </IconButton>
          </>
        ) : (
          <>
            {info && (
              <button
                className="small-button"
                aria-label={view === 'text' ? 'Show preview' : 'Open as text'}
                onClick={() => changeView(view === 'text' ? 'auto' : 'text')}
              >
                {view === 'text' ? <Eye size={14} /> : <FileText size={14} />}
                {view === 'text' ? 'Preview' : 'Text'}
              </button>
            )}
            {info?.editable && (
              <button className="small-button" disabled={busy} onClick={() => void edit()}>
                <Pencil size={14} />
                Edit
              </button>
            )}
            <IconButton label="Reload file" onClick={() => setRefresh((value) => value + 1)}>
              <RefreshCw size={15} />
            </IconButton>
            <a
              className="icon-button"
              href={`${fileUrl(path)}&download=1`}
              download
              title="Download file"
              aria-label="Download file"
            >
              <Download size={16} />
            </a>
          </>
        )}
      </div>
      {error && <ErrorMessage message={error} />}
      <div className="file-content">
        <Suspense fallback={<Loading label="Opening viewer…" />}>
          {!info ? (
            !error && <Loading />
          ) : editing && draft ? (
            <TextEditor
              path={path}
              value={draft.content}
              onChange={(content) => {
                const next = { ...draft, content };
                setDraft(next);
                rememberDraft(path, next);
              }}
              onSave={save}
            />
          ) : view === 'text' ? (
            <TextPreview key={`${path}:${refresh}`} path={path} />
          ) : info.kind === 'binary' ? (
            <div className="empty-state">
              <FileQuestion size={32} />
              <h2>No preview for this format</h2>
              <a className="button" href={`${fileUrl(path)}&download=1`} download>
                Download {info.name}
              </a>
            </div>
          ) : (
            <FilePreview key={`${path}:${refresh}`} info={info} />
          )}
        </Suspense>
      </div>
      {info && (
        <div className="panel-footnote">
          <span>{editing ? 'Draft' : info.mime}</span>
          <span>{formatSize(info.size)}</span>
        </div>
      )}
    </section>
  );
}
function formatSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
