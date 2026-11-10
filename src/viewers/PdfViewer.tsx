import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { IconButton, Loading } from '../components/ui';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();
export default function PdfViewer({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(500);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(150, entries[0].contentRect.width - 32)),
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="pdf-viewer" ref={ref}>
      <div className="viewer-controls">
        <IconButton
          label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          <ChevronLeft size={16} />
        </IconButton>
        <span>
          Page {page} / {pages || '…'}
        </span>
        <IconButton
          label="Next page"
          disabled={page >= pages}
          onClick={() => setPage((p) => p + 1)}
        >
          <ChevronRight size={16} />
        </IconButton>
        <span className="spacer" />
        <IconButton label="Zoom out" onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}>
          <ZoomOut size={16} />
        </IconButton>
        <IconButton label="Zoom in" onClick={() => setScale((s) => Math.min(3, s + 0.25))}>
          <ZoomIn size={16} />
        </IconButton>
      </div>
      <div className="pdf-scroll">
        <Document
          file={url}
          onLoadSuccess={(document) => setPages(document.numPages)}
          loading={<Loading label="Loading PDF…" />}
          error={<p className="error-message">Unable to open this PDF.</p>}
        >
          <Page pageNumber={page} width={width * scale} loading={<Loading />} />
        </Document>
      </div>
    </div>
  );
}
