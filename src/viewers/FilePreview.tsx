import { lazy, Suspense, useEffect, useState } from 'react';
import { Music2, ZoomIn, ZoomOut } from 'lucide-react';
import type { FileInfo } from '../../shared/types';
import { api, errorText, fileUrl } from '../lib/api';
import { useApp } from '../state';
import { ErrorMessage, IconButton, Loading } from '../components/ui';
import Markdown from './Markdown';
const TextPreview = lazy(() => import('./TextPreview'));
const PdfViewer = lazy(() => import('./PdfViewer'));
const TableViewer = lazy(() => import('./TableViewer'));

export default function FilePreview({ info }: { info: FileInfo }) {
  const { config, preferences } = useApp();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    if (info.kind !== 'markdown') return;
    const controller = new AbortController();
    api<{ content: string }>(`/api/files/text?path=${encodeURIComponent(info.path)}`, {
      signal: controller.signal,
    })
      .then((value) => setText(value.content))
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [info.path, info.kind]);
  if (error) return <ErrorMessage message={error} />;
  const url = fileUrl(info.path);
  if (info.kind === 'image')
    return (
      <div className="image-viewer">
        <div className="image-controls">
          <IconButton label="Zoom out" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>
            <ZoomOut size={16} />
          </IconButton>
          <span>{Math.round(zoom * 100)}%</span>
          <IconButton label="Zoom in" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
            <ZoomIn size={16} />
          </IconButton>
          <button onClick={() => setZoom(1)}>Fit</button>
        </div>
        <div className="image-scroll">
          <img
            src={url}
            alt={info.name}
            style={{ width: `${zoom * 100}%`, maxHeight: zoom === 1 ? '100%' : undefined }}
            onError={() =>
              setError(
                'The browser could not decode this image. Download it to view in another application.',
              )
            }
          />
        </div>
      </div>
    );
  if (info.kind === 'audio')
    return (
      <div className="media-viewer">
        <div className="audio-art">
          <Music2 size={48} strokeWidth={1} />
        </div>
        <h2>{info.name}</h2>
        <audio
          controls
          src={url}
          preload="metadata"
          onError={() => setError('This audio codec is not supported by your browser.')}
        />
      </div>
    );
  if (info.kind === 'video')
    return (
      <div className="media-viewer video">
        <video
          controls
          playsInline
          src={url}
          preload="metadata"
          onError={() => setError('This video codec is not supported by your browser.')}
        />
      </div>
    );
  if (info.kind === 'html') {
    const relative = info.path.slice(config.root === '/' ? 1 : config.root.length + 1);
    return (
      <iframe
        key={String(preferences.htmlScripts)}
        className="html-preview"
        title={`Preview of ${info.name}`}
        src={`/preview/${relative.split('/').map(encodeURIComponent).join('/')}`}
        sandbox={preferences.htmlScripts ? 'allow-scripts' : ''}
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <Suspense fallback={<Loading label="Opening viewer…" />}>
      {info.kind === 'pdf' ? (
        <PdfViewer url={url} />
      ) : info.kind === 'table' ? (
        <TableViewer info={info} />
      ) : info.kind === 'text' ? (
        <TextPreview path={info.path} />
      ) : text === null ? (
        <Loading />
      ) : info.kind === 'markdown' ? (
        <div className="document-scroll">
          <Markdown text={text} path={info.path} />
        </div>
      ) : null}
    </Suspense>
  );
}
