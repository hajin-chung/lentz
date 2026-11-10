import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fileUrl } from '../lib/api';

function Markdown({ text, path }: { text: string; path?: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => {
          const safe = defaultUrlTransform(url);
          if (path && key === 'src' && safe && !/^(?:[a-z]+:|\/\/)/i.test(safe)) {
            const resolved = new URL(
              safe,
              `http://local${path.split('/').map(encodeURIComponent).join('/')}`,
            );
            return fileUrl(decodeURIComponent(resolved.pathname));
          }
          return safe;
        }}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
