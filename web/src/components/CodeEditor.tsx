import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { useTheme } from '../lib/theme';

const langOf = (lang: string): Extension => {
  switch (lang) {
    case 'html': return html({ autoCloseTags: true });
    case 'css': return css();
    case 'json': return json();
    case 'markdown': return markdown();
    case 'python': return python();
    default: return javascript({ jsx: false });
  }
};

export default function CodeEditor({
  value, onChange, language = 'javascript', height = 360, readOnly = false,
}: {
  value: string; onChange?: (v: string) => void; language?: string;
  height?: number | string; readOnly?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const { resolved } = useTheme();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!ref.current) return;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      foldGutter(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      langOf(language),
      // Dark surface gets the one-dark palette; the light theme leans on
      // CodeMirror's default (light) highlight style.
      ...(resolved === 'dark' ? [oneDark] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && onChangeRef.current) onChangeRef.current(u.state.doc.toString());
      }),
      EditorView.theme({
        '&': { height: typeof height === 'number' ? `${height}px` : height, backgroundColor: 'transparent' },
        '.cm-scroller': { overflow: 'auto' },
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--line)', color: 'var(--dim)' },
        '.cm-activeLine': { backgroundColor: 'var(--w2)' },
        '.cm-content': { caretColor: 'var(--pink)' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--pink-soft)' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent' },
        '&.cm-focused': { outline: 'none' },
      }),
    ];
    if (readOnly) extensions.push(EditorState.readOnly.of(true));
    const state = EditorState.create({ doc: value, extensions });
    const v = new EditorView({ state, parent: ref.current });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, typeof height === 'number' ? height : height, resolved]);

  // sync external value (e.g. switching files)
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (value !== cur) {
      v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
    }
  }, [value]);

  return <div className="editor-shell" ref={ref} style={{ height: typeof height === 'number' ? `${height}px` : height }} />;
}
