import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { FileInfo } from '../../shared/types';
import { fileUrl, errorText } from '../lib/api';
import { ErrorMessage, IconButton, Loading } from '../components/ui';

interface Sheet {
  name: string;
  rows: string[][];
  limited: boolean;
}
export default function TableViewer({ info }: { info: FileInfo }) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    if (info.size > 25 * 1024 * 1024) {
      setError('Table previews support files up to 25 MB. Download this file to open it locally.');
      return;
    }
    const worker = new Worker(new URL('./table.worker.ts', import.meta.url), { type: 'module' });
    const controller = new AbortController();
    worker.onmessage = (event) => {
      if (event.data.error) setError(event.data.error);
      else setSheets(event.data.sheets);
    };
    worker.onerror = () => setError('Unable to read this spreadsheet.');
    fetch(fileUrl(info.path), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Could not load spreadsheet.');
        return response.arrayBuffer();
      })
      .then((buffer) => worker.postMessage(buffer, [buffer]))
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => {
      controller.abort();
      worker.terminate();
    };
  }, [info.path]);
  if (error) return <ErrorMessage message={error} />;
  if (!sheets.length) return <Loading label="Reading table…" />;
  const sheet = sheets[selected];
  const rows = sheet.rows.slice(page * 100, (page + 1) * 100);
  const columns = Math.max(0, ...sheet.rows.map((row) => row.length));
  return (
    <div className="table-viewer">
      <div className="viewer-controls">
        <select
          aria-label="Worksheet"
          value={selected}
          onChange={(e) => {
            setSelected(Number(e.target.value));
            setPage(0);
          }}
        >
          {sheets.map((sheet, index) => (
            <option key={index} value={index}>
              {sheet.name}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <span>{sheet.rows.length.toLocaleString()} rows</span>
      </div>
      {sheet.limited && (
        <div className="panel-footnote">
          Preview limited to 10,000 rows and 200 columns. Original file is unchanged.
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              {Array.from({ length: columns }, (_, i) => (
                <th key={i}>{columnName(i)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <th>{page * 100 + i + 1}</th>
                {Array.from({ length: columns }, (_, j) => (
                  <td key={j}>{row[j] || ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="empty-small">Empty worksheet</p>}
      </div>
      <div className="viewer-controls">
        <IconButton label="Previous rows" disabled={!page} onClick={() => setPage((p) => p - 1)}>
          <ChevronLeft size={16} />
        </IconButton>
        <span>
          {sheet.rows.length ? page * 100 + 1 : 0}–{Math.min((page + 1) * 100, sheet.rows.length)}{' '}
          of {sheet.rows.length}
        </span>
        <IconButton
          label="Next rows"
          disabled={(page + 1) * 100 >= sheet.rows.length}
          onClick={() => setPage((p) => p + 1)}
        >
          <ChevronRight size={16} />
        </IconButton>
      </div>
    </div>
  );
}
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
