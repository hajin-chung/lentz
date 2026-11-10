import { useEffect, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { useApp } from '../state';

export default function TextEditor({
  path,
  value,
  onChange,
  onSave,
  readOnly = false,
}: {
  path: string;
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
}) {
  const { preferences } = useApp();
  const [language, setLanguage] = useState<LanguageSupport | null>(null);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    let live = true;
    const description = LanguageDescription.matchFilename(languages, path);
    description
      ?.load()
      .then((value) => {
        if (live) setLanguage(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const dark = preferences.theme === 'dark' || (preferences.theme === 'system' && systemDark);
  return (
    <CodeMirror
      className={readOnly ? 'text-preview' : undefined}
      value={value}
      height="100%"
      theme={dark ? oneDark : 'light'}
      readOnly={readOnly}
      editable={!readOnly}
      onChange={onChange}
      extensions={[
        EditorView.lineWrapping,
        ...(language ? [language] : []),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              onSave?.();
              return true;
            },
          },
        ]),
      ]}
      basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly, autocompletion: !readOnly }}
      aria-label={readOnly ? 'File text' : 'File editor'}
    />
  );
}
