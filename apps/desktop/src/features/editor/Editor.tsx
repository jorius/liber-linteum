import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorMode } from '../../ipc';
import { Preview } from '../preview/Preview';
import styles from './Editor.module.css';
import { followLinkAtCursor, livePreview, pagePath } from './livePreview';
import type { PageDoc } from './pageDoc';
import { blockForOffset, offsetAtTop, topIn } from './scrollSync';

/** Each page keeps its CodeMirror state (text, selection, undo) while the app
 *  runs, so switching pages or modes never loses history (ED-07). */
const states = new WeakMap<PageDoc, EditorState>();
const modeSlot = new Compartment();
const labelSlot = new Compartment();

const sourceHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700', color: 'var(--color-text-strong)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--color-accent)' },
  { tag: tags.url, color: 'var(--color-text-muted)' },
  { tag: tags.quote, color: 'var(--color-text-muted)' },
  {
    tag: [tags.processingInstruction, tags.meta, tags.contentSeparator],
    color: 'var(--color-text-faint)',
  },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--color-text)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-body)', fontSize: '15.5px', lineHeight: '1.7' },
  '&.cm-nimw-source .cm-scroller': {
    fontFamily: 'var(--font-mono)',
    fontSize: '13.5px',
    lineHeight: '1.6',
  },
  '.cm-content': { padding: '20px 0 40vh', caretColor: 'var(--color-text)' },
  '.cm-cursor': { borderLeftColor: 'var(--color-text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--color-accent-soft)',
  },
});

function modeExtensions(mode: EditorMode): Extension {
  return mode === 'livePreview'
    ? [livePreview(), EditorView.editorAttributes.of({ class: 'cm-nimw-live' })]
    : [
        syntaxHighlighting(sourceHighlight),
        EditorView.editorAttributes.of({ class: 'cm-nimw-source' }),
      ];
}

const labelled = (label: string) => EditorView.contentAttributes.of({ 'aria-label': label });

/** The smallest change turning `from` into `to`. */
export function diffText(from: string, to: string) {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let a = from.length;
  let b = to.length;
  while (a > start && b > start && from.charCodeAt(a - 1) === to.charCodeAt(b - 1)) {
    a--;
    b--;
  }
  return { from: start, to: a, insert: to.slice(start, b) };
}

/** Text that changed outside the editor (reload, merge): applied as a minimal
 *  change outside the undo history, so the selection maps through it and undo
 *  only ever reverts the user's own edits. */
function applyExternal(view: EditorView, text: string) {
  const changes = diffText(view.state.doc.toString(), text);
  if (!changes) return;
  view.dispatch({
    changes,
    annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  });
}

export interface EditorProps {
  doc: PageDoc;
  mode: EditorMode;
  /** Accessible name of the text area (the page title). */
  label: string;
}

/** The page editor: Live Preview, Source, or Split (Source + rendered pane). */
export function Editor({ doc, mode, label }: EditorProps) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(doc);
  const split = mode === 'split';
  // The text for the Split pane (cheap to track: the pane renders only in Split).
  const [text, setText] = useState(doc.text);

  const stateFor = (d: PageDoc): EditorState =>
    states.get(d) ??
    EditorState.create({
      doc: d.text,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        markdown(),
        keymap.of([
          { key: 'Mod-Enter', run: followLinkAtCursor },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        pagePath.of(() => current.current.path),
        theme,
        labelSlot.of(labelled(label)),
        modeSlot.of(modeExtensions(mode)),
        // Autosave also when the editor loses focus (M2a §3.3).
        EditorView.domEventHandlers({
          blur: () => {
            void current.current.flush();
          },
        }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const next = u.state.doc.toString();
          current.current.edit(next);
          setText(next);
        }),
      ],
    });

  // One view for the component's lifetime; page states are swapped into it.
  useLayoutEffect(() => {
    const v = new EditorView({ parent: host.current!, state: stateFor(current.current) });
    view.current = v;
    return () => {
      states.set(current.current, v.state);
      current.current.sink = null;
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const v = view.current!;
    if (current.current !== doc) {
      states.set(current.current, v.state);
      current.current.sink = null;
      current.current = doc;
      v.setState(stateFor(doc));
    }
    doc.sink = (next) => applyExternal(v, next);
    // Changed while it was in the background (reload or merge without a view).
    applyExternal(v, doc.text);
    v.dispatch({
      effects: [modeSlot.reconfigure(modeExtensions(mode)), labelSlot.reconfigure(labelled(label))],
    });
    setText(doc.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: [modeSlot.reconfigure(modeExtensions(mode)), labelSlot.reconfigure(labelled(label))],
    });
  }, [mode, label]);

  // Split: the editor and the rendered pane follow each other's scrolling.
  useEffect(() => {
    if (!split || !view.current || !pane.current) return;
    const v = view.current;
    const p = pane.current;
    let lock: 'editor' | 'pane' | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hold = (who: 'editor' | 'pane') => {
      lock = who;
      clearTimeout(timer);
      timer = setTimeout(() => (lock = null), 120);
    };
    const fromEditor = () => {
      if (lock === 'pane') return;
      hold('editor');
      const el = blockForOffset(p, v.lineBlockAtHeight(v.scrollDOM.scrollTop).from);
      if (el) p.scrollTop = topIn(p, el);
    };
    const fromPane = () => {
      if (lock === 'editor') return;
      hold('pane');
      const offset = offsetAtTop(p);
      if (offset !== null) {
        v.dispatch({ effects: EditorView.scrollIntoView(offset, { y: 'start' }) });
      }
    };
    v.scrollDOM.addEventListener('scroll', fromEditor);
    p.addEventListener('scroll', fromPane);
    return () => {
      clearTimeout(timer);
      v.scrollDOM.removeEventListener('scroll', fromEditor);
      p.removeEventListener('scroll', fromPane);
    };
  }, [split]);

  return (
    <div className={split ? styles.split : styles.single}>
      <div ref={host} className={mode === 'livePreview' ? styles.live : styles.source} />
      {split && (
        <div ref={pane} className={styles.pane} role="region" aria-label={t('editor.preview')}>
          <Preview text={text} path={doc.path} />
        </div>
      )}
    </div>
  );
}
