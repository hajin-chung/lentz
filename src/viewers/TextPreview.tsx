import { useEffect, useState } from 'react';
import type { TextPreview as Preview } from '../../shared/types';
import { api, errorText } from '../lib/api';
import { ErrorMessage, Loading } from '../components/ui';
import TextEditor from './TextEditor';

/** Explicit text viewing never grants editing permission or changes file contents. */
export default function TextPreview({ path }: { path: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError('');
    api<Preview>(`/api/files/text-preview?path=${encodeURIComponent(path)}`, {
      signal: controller.signal,
    })
      .then(setPreview)
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, [path]);
  if (error) return <ErrorMessage message={error} />;
  if (!preview) return <Loading />;
  return (
    <div className="text-file-preview">
      <TextEditor path={path} value={preview.content} readOnly />
      {(preview.truncated || preview.lossy) && (
        <div className="panel-footnote" role="status">
          <span>
            {[
              preview.truncated && 'Showing the first 5 MB.',
              preview.lossy && 'Binary or non-UTF-8 data shown as a text approximation.',
            ]
              .filter(Boolean)
              .join(' ')}
          </span>
        </div>
      )}
    </div>
  );
}
