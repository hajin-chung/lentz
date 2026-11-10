import { useEffect, useState, type CSSProperties } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  File,
  ArrowUp,
  RefreshCw,
  CornerDownLeft,
  ExternalLink,
} from 'lucide-react';
import type { DirectoryEntry, DirectoryListing } from '../../shared/types';
import { api, errorText } from '../lib/api';
import { useApp } from '../state';
import { ErrorMessage, IconButton, Loading } from './ui';

interface Props {
  directory: string;
  onDirectory: (path: string) => void;
  onFile?: (path: string) => void;
  onNewTab?: (path: string) => void;
  directoriesOnly?: boolean;
}
function TreeEntry({
  entry,
  depth,
  props,
}: {
  entry: DirectoryEntry;
  depth: number;
  props: Props;
}) {
  const { preferences } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState('');
  const toggle = async () => {
    setExpanded((value) => !value);
    if (!children)
      try {
        setChildren(
          (await api<DirectoryListing>(`/api/files/tree?path=${encodeURIComponent(entry.path)}`))
            .entries,
        );
      } catch (e) {
        setError(errorText(e));
      }
  };
  return (
    <>
      <div
        className={`tree-row ${entry.directory ? 'directory' : ''}`}
        style={{ '--tree-depth': depth } as CSSProperties}
      >
        {entry.directory ? (
          <>
            <IconButton
              label={`${expanded ? 'Collapse' : 'Expand'} ${entry.name}`}
              onClick={() => void toggle()}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </IconButton>
            <button
              className="tree-name"
              onClick={() => props.onDirectory(entry.path)}
              title={entry.path}
            >
              <Folder size={16} />
              <span>{entry.name}</span>
              {entry.symlink && <span className="muted">↗</span>}
            </button>
          </>
        ) : (
          <>
            <span className="tree-indent" />
            <button
              className="tree-name"
              onClick={() => props.onFile?.(entry.path)}
              title={entry.path}
            >
              <File size={16} />
              <span>{entry.name}</span>
            </button>
            {props.onNewTab && (
              <IconButton
                className="tree-new-tab"
                label={`Open ${entry.name} in new tab`}
                onClick={() => props.onNewTab?.(entry.path)}
              >
                <ExternalLink size={14} />
              </IconButton>
            )}
          </>
        )}
      </div>
      {expanded && entry.directory && (
        <>
          {error ? (
            <ErrorMessage message={error} />
          ) : children ? (
            children
              .filter(
                (e) =>
                  (preferences.showHidden || !e.name.startsWith('.')) &&
                  (!props.directoriesOnly || e.directory),
              )
              .map((e) => <TreeEntry key={e.path} entry={e} depth={depth + 1} props={props} />)
          ) : (
            <Loading />
          )}
        </>
      )}
    </>
  );
}
export function DirectoryTree(props: Props) {
  const { config, preferences } = useApp();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [input, setInput] = useState(props.directory);
  useEffect(() => {
    const controller = new AbortController();
    setListing(null);
    setError('');
    setInput(props.directory);
    api<DirectoryListing>(`/api/files/tree?path=${encodeURIComponent(props.directory)}`, {
      signal: controller.signal,
    })
      .then(setListing)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [props.directory, refresh]);
  const entries = listing?.entries.filter(
    (e) =>
      (preferences.showHidden || !e.name.startsWith('.')) &&
      (!props.directoriesOnly || e.directory),
  );
  return (
    <div className="directory-browser">
      <form
        className="path-bar"
        onSubmit={(e) => {
          e.preventDefault();
          props.onDirectory(input);
        }}
      >
        <IconButton
          label="Parent directory"
          type="button"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && props.onDirectory(listing.parent)}
        >
          <ArrowUp size={16} />
        </IconButton>
        <input
          aria-label="Directory path"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
        />
        <IconButton label="Go to directory" type="submit">
          <CornerDownLeft size={15} />
        </IconButton>
        <IconButton
          label="Refresh directory"
          type="button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={15} />
        </IconButton>
      </form>
      <div className="tree-scroll">
        {error ? (
          <ErrorMessage message={error} retry={() => props.onDirectory(config.root)} />
        ) : !listing ? (
          <Loading />
        ) : entries?.length ? (
          entries.map((entry) => (
            <TreeEntry key={`${refresh}-${entry.path}`} entry={entry} depth={0} props={props} />
          ))
        ) : (
          <div className="empty-small">This folder is empty.</div>
        )}
      </div>
    </div>
  );
}
