import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { languageFor } from '../../markdown/codeHighlight';
import {
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tagHighlighter, tags } from '@lezer/highlight';
import { diffIndices } from 'node-diff3';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorMode, PickedFile } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { usePageWidth, useWideElements } from '../../stores/pageWidthStore';
import { isTextPath } from '../../stores/textFiles';
import { isArchived, nameOf } from '../../stores/tree';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { Preview } from '../preview/Preview';
import styles from './Editor.module.css';
import { followLinkAtCursor, livePreview, pagePath } from './livePreview';
import { attachmentHandlers } from './attachments';
import { flash, jumpTo } from './flash';
import { BlockGutter, type Shown } from './BlockGutter';
import { SplitHint } from './SplitHint';
import { activeFormats, editorKeymap, type ActiveFormat } from './format';
import { coverSideHistory } from './coverSideHistory';
import { linkCompletion } from './linkComplete';
import { LanguagePicker } from './LanguagePicker';
import { setLanguagePickerOpener } from './languagePickerOpen';
import { LinkPicker } from './LinkPicker';
import { setLinkPickerOpener } from './linkPickerOpen';
import { setAttachChooser } from './attachOpen';
import { AttachChoice } from './AttachChoice';
import type { PageDoc } from './pageDoc';
import { Outline } from './Outline';
import { blockForOffset, offsetAtTop, topIn } from './scrollSync';
import { notifyViewReset, notifyViewUpdate, setCurrentView } from './viewUpdates';
import { Toolbar } from './Toolbar';
import { hideView, pageDocOf, showView, storedState, storeState } from './views';
import { LIVE_PADDING, wideAttrs, wideExtents } from './wideBox';
import { spellcheck } from './spell';
import { toggleTaskIn } from './widgets';

/** The Split pane of the component currently showing each view. */
const paneOf = new WeakMap<EditorView, (text: string, now: boolean) => void>();
/** The toolbar's pressed state of the component currently showing each view. */
const toolbarOf = new WeakMap<EditorView, (state: EditorState) => void>();
const modeSlot = new Compartment();
const labelSlot = new Compartment();
/** Line numbers in the gutter (Settings → Editor; always in text files). */
const gutterSlot = new Compartment();
/** A text file's language, loaded by its name (M4b part 2 §6). */
const languageSlot = new Compartment();
/** Archived pages are read-only (M5b round 2): no typing, and no edits from
 *  the toolbar or keys; changes from the disk still show. */
const readOnlySlot = new Compartment();
/** Spell checking, pages only (spell checking spec): off leaves it out. */
const spellSlot = new Compartment();
const readOnly = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorState.transactionFilter.of((tr) =>
    tr.docChanged && !tr.annotation(Transaction.remote) ? [] : tr,
  ),
];
const readOnlyFor = (path: string) => (isArchived(path) ? readOnly : []);
const gutter = (on: boolean): Extension => (on ? lineNumbers() : []);

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

/** Code tokens as classes, drawn with the palette's --code-* colours (the
 *  rendered pane uses the same tokens through highlight.js classes). */
const codeHighlighter = tagHighlighter([
  {
    tag: [tags.keyword, tags.bool, tags.null, tags.atom, tags.tagName],
    class: 'cm-nimw-code-keyword',
  },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], class: 'cm-nimw-code-string' },
  { tag: [tags.number, tags.integer, tags.float], class: 'cm-nimw-code-number' },
  { tag: tags.comment, class: 'cm-nimw-code-comment' },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.propertyName,
      tags.attributeName,
    ],
    class: 'cm-nimw-code-function',
  },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'cm-nimw-code-type' },
  { tag: [tags.annotation, tags.modifier, tags.self], class: 'cm-nimw-code-meta' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], class: 'cm-nimw-code-punct' },
]);

const theme = EditorView.theme({
  '.cm-nimw-code-keyword': { color: 'var(--code-keyword)' },
  '.cm-nimw-code-string': { color: 'var(--code-string)' },
  '.cm-nimw-code-number': { color: 'var(--code-number)' },
  '.cm-nimw-code-comment': { color: 'var(--code-comment)', fontStyle: 'italic' },
  '.cm-nimw-code-function': { color: 'var(--code-function)' },
  '.cm-nimw-code-type': { color: 'var(--code-type)' },
  '.cm-nimw-code-meta': { color: 'var(--code-meta)' },
  '.cm-nimw-code-punct': { color: 'var(--code-punct)' },
  '&': { height: '100%', color: 'var(--color-text)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-nimw-misspelled': {
    textDecoration: 'underline wavy var(--color-danger)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-live)',
    fontSize: 'var(--font-size-editor)',
    lineHeight: '1.7',
  },
  '&.cm-nimw-source .cm-scroller': {
    fontFamily: 'var(--font-source)',
    fontSize: 'calc(var(--font-size-editor) * 0.9)',
    lineHeight: '1.6',
  },
  '.cm-content': { padding: '20px 0 40vh', caretColor: 'var(--color-text)' },
  '.cm-cursor': { borderLeftColor: 'var(--color-text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--color-accent-soft)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-source)',
    fontSize: '0.8em',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 12px' },
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

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Lines with their `\n` kept. */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', start)) {
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** `from.slice(a, b)` → `insert`, trimmed to the characters that differ. */
function trimmed(from: string, a: number, b: number, insert: string): TextChange | null {
  let head = 0;
  const max = Math.min(b - a, insert.length);
  while (head < max && from.charCodeAt(a + head) === insert.charCodeAt(head)) head++;
  let tail = 0;
  while (
    tail < max - head &&
    from.charCodeAt(b - 1 - tail) === insert.charCodeAt(insert.length - 1 - tail)
  ) {
    tail++;
  }
  if (a + head === b - tail && head === insert.length - tail) return null;
  return { from: a + head, to: b - tail, insert: insert.slice(head, insert.length - tail) };
}

/** The changes turning `from` into `to`: one per changed run of lines (each
 *  trimmed to the characters that differ), never touching the unchanged text
 *  between them, so selections and undo history map through it (M2a §3.3).
 *  Offsets are in `from`; the changes don't overlap and are sorted. */
export function diffText(from: string, to: string): TextChange[] {
  if (from === to) return [];
  const a = splitLines(from);
  const b = splitLines(to);
  // Skip the common head and tail lines (cheap; keeps the LCS small).
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  // Offsets of each line of `from` (relative to the first differing line).
  let base = 0;
  for (let i = 0; i < head; i++) base += a[i].length;
  const offsets = [base];
  for (const line of midA) offsets.push(offsets[offsets.length - 1] + line.length);
  const out: TextChange[] = [];
  for (const hunk of diffIndices(midA, midB)) {
    const [startA, lenA] = hunk.buffer1;
    const change = trimmed(
      from,
      offsets[startA],
      offsets[startA + lenA],
      hunk.buffer2Content.join(''),
    );
    if (change) out.push(change);
  }
  return out;
}

/** Text that changed outside the editor (reload, merge): applied as minimal
 *  changes outside the undo history, so the selection maps through it and undo
 *  only ever reverts the user's own edits. */
function applyExternal(view: EditorView, text: string) {
  const changes = diffText(view.state.doc.toString(), text);
  if (!changes.length) return;
  view.dispatch({
    changes,
    annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  });
}

/** Text files highlight by file type (language-data, loaded lazily); a
 *  view showing `d` gets the language once it has loaded. */
function showLanguage(v: EditorView, d: PageDoc) {
  if (!isTextPath(d.path)) return;
  const lang = LanguageDescription.matchFilename(languages, nameOf(d.path));
  if (!lang) return;
  void lang.load().then((support) => {
    if (v.state.facet(pageDocOf) === d) v.dispatch({ effects: languageSlot.reconfigure(support) });
  });
}

/** Shared by pages and text files: autosave, the toolbar's state and the
 *  Split pane follow the text. */
const followers = [
  // Autosave also when the editor loses focus (M2a §3.3).
  EditorView.domEventHandlers({
    blur: (_e, v) => {
      void v.state.facet(pageDocOf)?.autoFlush();
    },
  }),
  EditorView.updateListener.of((u) => {
    notifyViewUpdate(u);
    if (u.docChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      toolbarOf.get(u.view)?.(u.state);
    }
    if (!u.docChanged) return;
    const next = u.state.doc.toString();
    u.state.facet(pageDocOf)?.edit(next);
    // A block move shows in the pane at once (its gutter acts on what
    // the pane shows, M4 §4); typing waits for the render delay.
    paneOf.get(u.view)?.(
      next,
      u.transactions.some((tr) => tr.isUserEvent('move.block')),
    );
  }),
];

/** A text or code file (M4b part 2 §6): Source-style, wrapped, line
 *  numbers, highlighting by file type; no Markdown, links or attachments. */
function createTextState(d: PageDoc, label: string): EditorState {
  return EditorState.create({
    doc: d.text,
    extensions: [
      pageDocOf.of(d),
      readOnlySlot.of(readOnlyFor(d.path)),
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      languageSlot.of([]),
      syntaxHighlighting(codeHighlighter),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      theme,
      labelSlot.of(labelled(label)),
      modeSlot.of(modeExtensions('source')),
      gutterSlot.of(gutter(true)),
      followers,
    ],
  });
}

/** A page's editor state. Its listeners find the page through `pageDocOf`
 *  and the Split pane through the view they run in (I5). */
function createState(d: PageDoc, mode: EditorMode, label: string, numbers: boolean): EditorState {
  if (isTextPath(d.path)) return createTextState(d, label);
  return EditorState.create({
    doc: d.text,
    extensions: [
      pageDocOf.of(d),
      readOnlySlot.of(readOnlyFor(d.path)),
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      // GFM syntax tree: Source highlighting and the toolbar's pressed state.
      // Picker ids (`mssql`, `angulartemplate`) resolve as in the rendered pane.
      markdown({ base: markdownLanguage, codeLanguages: languageFor }),
      // Syntax colours inside fenced code (M4b part 2 §2), in every mode.
      syntaxHighlighting(codeHighlighter),
      keymap.of([{ key: 'Mod-Enter', run: followLinkAtCursor }, ...editorKeymap, ...historyKeymap]),
      pagePath.of(() => d.path),
      theme,
      labelSlot.of(labelled(label)),
      modeSlot.of(modeExtensions(mode)),
      // Pasted images and dropped files (M2c §5), `[[` autocomplete (§6).
      attachmentHandlers(),
      linkCompletion(),
      // Cover placements join the undo history (M4b part 3 §3).
      coverSideHistory,
      // An atom clicked in the Global View flashes here (M4b part 3 §6).
      flash,
      gutterSlot.of(gutter(numbers)),
      spellSlot.of(spellOn() ? spellcheck() : []),
      followers,
    ],
  });
}

const spellOn = () => useSettingsStore.getState().settings.spellcheck;

export interface EditorProps {
  doc: PageDoc;
  mode: EditorMode;
  /** Accessible name of the text area (the page title). */
  label: string;
}

/** The page editor: Live Preview, Source, or Split (Source + rendered pane). */
export function Editor({ doc, mode, label }: EditorProps) {
  const width = usePageWidth(doc.path);
  const wideKinds = useWideElements();
  const textFile = isTextPath(doc.path);
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(doc);
  const split = mode === 'split';
  // The text for the Split pane (cheap to track: the pane renders only in Split).
  const [text, setText] = useState(doc.text);
  const [renderNow, setRenderNow] = useState(false);
  const toPane = useCallback((next: string, now: boolean) => {
    setText(next);
    setRenderNow(now);
  }, []);
  const showToolbar = useSettingsStore((s) => s.settings.toolbar);
  const showNumbers = useSettingsStore((s) => s.settings.lineNumbers);
  const showOutline = useSettingsStore((s) => s.settings.outline);
  const [toolbarView, setToolbarView] = useState<EditorView | null>(null);
  const [picker, setPicker] = useState(false);
  const [attach, setAttach] = useState<PickedFile[] | null>(null);
  const [langPicker, setLangPicker] = useState<{ at: number; anchor: HTMLElement } | null>(null);
  const [active, setActive] = useState<Set<ActiveFormat>>(() => new Set());
  const showFormats = useCallback((state: EditorState) => {
    const next = activeFormats(state);
    setActive((prev) => ([...prev].sort().join() === [...next].sort().join() ? prev : next));
  }, []);

  const stateFor = (d: PageDoc): EditorState =>
    storedState(d) ?? createState(d, mode, label, showNumbers);

  // One view for the component's lifetime; page states are swapped into it.
  useLayoutEffect(() => {
    const v = new EditorView({ parent: host.current!, state: stateFor(current.current) });
    view.current = v;
    showView(current.current, v);
    paneOf.set(v, toPane);
    toolbarOf.set(v, showFormats);
    setToolbarView(v);
    setLinkPickerOpener(v, () => setPicker(true));
    setAttachChooser(v, setAttach);
    setLanguagePickerOpener(v, (at, anchor) => setLangPicker({ at, anchor }));
    showFormats(v.state);
    setCurrentView(v);
    showLanguage(v, current.current);
    return () => {
      setCurrentView(null);
      hideView(current.current, v);
      storeState(current.current, v.state);
      current.current.sink = null;
      paneOf.delete(v);
      toolbarOf.delete(v);
      setLinkPickerOpener(v, null);
      setAttachChooser(v, null);
      setLanguagePickerOpener(v, null);
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const v = view.current!;
    if (current.current !== doc) {
      storeState(current.current, v.state);
      current.current.sink = null;
      hideView(current.current, v);
      current.current = doc;
      showView(doc, v);
      v.setState(stateFor(doc));
      showFormats(v.state);
      notifyViewReset(v);
      showLanguage(v, doc);
    }
    doc.sink = (next) => applyExternal(v, next);
    // Changed while it was in the background (reload or merge without a view).
    applyExternal(v, doc.text);
    v.dispatch({
      effects: [
        modeSlot.reconfigure(modeExtensions(mode)),
        labelSlot.reconfigure(labelled(label)),
        gutterSlot.reconfigure(gutter(showNumbers || isTextPath(doc.path))),
        // A page's stored state may predate a change to the setting.
        ...(isTextPath(doc.path) ? [] : [spellSlot.reconfigure(spellOn() ? spellcheck() : [])]),
      ],
    });
    setText(doc.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: [modeSlot.reconfigure(modeExtensions(mode)), labelSlot.reconfigure(labelled(label))],
    });
  }, [mode, label]);

  // Unarchived (or archived) while open: the same doc, a new place.
  useLayoutEffect(() => {
    view.current?.dispatch({ effects: readOnlySlot.reconfigure(readOnlyFor(doc.path)) });
  }, [doc, doc.path]);

  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: gutterSlot.reconfigure(gutter(showNumbers || isTextPath(current.current.path))),
    });
  }, [showNumbers]);

  const spellEnabled = useSettingsStore((s) => s.settings.spellcheck);
  useLayoutEffect(() => {
    const v = view.current;
    if (!v || isTextPath(current.current.path)) return;
    v.dispatch({ effects: spellSlot.reconfigure(spellEnabled ? spellcheck() : []) });
  }, [spellEnabled]);

  // Back from the Global View (a card opened in the editor, ⌘1): the keyboard
  // comes back here, with the selection it had, once the editor shows —
  // never taken from something else that has it (M3a final review I4).
  const wantsFocus = usePageStore((s) => s.editorFocus);
  const screen = useUiStore((s) => s.screen);
  useEffect(() => {
    const v = view.current;
    if (!wantsFocus || screen !== 'edit' || !v) return;
    usePageStore.getState().clearEditorFocus();
    const active = document.activeElement;
    if (!active || active === document.body) v.focus();
  }, [wantsFocus, screen]);

  // See atoms (M4b part 3 §6): an atom clicked in the Global View puts the
  // cursor on its block, once its page shows here.
  const jump = usePageStore((s) => s.jump);
  useEffect(() => {
    const v = view.current;
    if (!jump || !v || screen !== 'edit' || current.current.path !== jump.path) return;
    usePageStore.getState().clearJump();
    jumpTo(v, jump.from, jump.to);
    v.focus();
  }, [jump, screen, doc]);

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

  // Wide elements (M4b part 3): how far past the text the chosen kinds may
  // reach, measured from the editor (the scroller, or the line-number
  // gutter, less the side padding).
  useLayoutEffect(() => {
    const h = host.current;
    const v = toolbarView;
    if (!h) return;
    if (!v || width !== 'wide' || mode !== 'livePreview') {
      h.style.removeProperty('--nimw-wide-m');
      h.style.removeProperty('--nimw-wide-r');
      return;
    }
    const measure = () => {
      const scroller = v.scrollDOM.getBoundingClientRect();
      const content = v.contentDOM.getBoundingClientRect();
      const gutters = v.dom.querySelector<HTMLElement>('.cm-gutters')?.getBoundingClientRect();
      const { m, r } = wideExtents({
        textLeft: content.left + LIVE_PADDING,
        textRight: content.right - LIVE_PADDING,
        leftBound: Math.max(scroller.left, gutters ? gutters.right : scroller.left) + LIVE_PADDING,
        rightBound: scroller.left + v.scrollDOM.clientWidth - LIVE_PADDING,
      });
      h.style.setProperty('--nimw-wide-m', `${m}px`);
      h.style.setProperty('--nimw-wide-r', `${r}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(v.scrollDOM);
    const gutters = v.dom.querySelector('.cm-gutters');
    if (gutters) observer?.observe(gutters);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [toolbarView, width, mode, showNumbers]);

  const toggleTask = useCallback((at: number) => {
    if (view.current) toggleTaskIn(view.current, at);
  }, []);

  // What the Split pane shows, for its block gutter (M4 §4).
  const [shown, setShown] = useState<Shown | null>(null);
  const onRendered = useCallback(
    (text: string, page: Shown['page']) => setShown({ text, page }),
    [],
  );

  return (
    <div className={styles.frame}>
      {showToolbar && !textFile && !isArchived(doc.path) && toolbarView && (
        <Toolbar view={toolbarView} active={active} />
      )}
      {picker && toolbarView && <LinkPicker view={toolbarView} onClose={() => setPicker(false)} />}
      {attach && toolbarView && (
        <AttachChoice view={toolbarView} files={attach} onClose={() => setAttach(null)} />
      )}
      {langPicker && toolbarView && (
        <LanguagePicker
          view={toolbarView}
          at={langPicker.at}
          anchor={langPicker.anchor}
          onClose={() => setLangPicker(null)}
        />
      )}
      {split && <SplitHint />}
      <div className={styles.body}>
        <div className={split ? styles.split : styles.single}>
          <div
            ref={host}
            data-width={width}
            {...wideAttrs(width, wideKinds)}
            className={`${mode === 'livePreview' ? styles.live : styles.source} ${width === 'full' ? styles.full : ''}`}
          />
          {split && (
            <div ref={pane} className={styles.pane} role="region" aria-label={t('editor.preview')}>
              {toolbarView && <BlockGutter view={toolbarView} pane={pane} shown={shown} />}
              <Preview
                text={text}
                path={doc.path}
                onToggleTask={isArchived(doc.path) ? undefined : toggleTask}
                onRendered={onRendered}
                delay={renderNow ? 0 : undefined}
              />
            </div>
          )}
        </div>
        {showOutline && !textFile && toolbarView && <Outline view={toolbarView} text={text} />}
      </div>
    </div>
  );
}
