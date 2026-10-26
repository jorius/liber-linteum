import type { EditorState } from '@codemirror/state';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keyLabel } from '../dialogs/shortcuts';
import { goToLine } from '../editor/goToLine';
import { onViewUpdate, useCurrentView } from '../editor/viewUpdates';
import styles from './PageView.module.css';

const MAC = /Mac/i.test(navigator.platform);

interface Position {
  line: number;
  col: number;
  /** Characters selected, every selection summed; 0 with none. */
  selected: number;
}

/** Characters (code points: an emoji is one) between `from` and `to`. */
function charsIn(state: EditorState, from: number, to: number): number {
  const text = state.sliceDoc(from, to);
  let n = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) n--;
  }
  return n;
}

/** The cursor's line and column (from 1, columns in characters) and what is
 *  selected. Lines are the file's, frontmatter included, as the line-number
 *  gutter and Go to line count them. */
export function positionOf(state: EditorState): Position {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const selected = state.selection.ranges.reduce(
    (sum, r) => sum + (r.empty ? 0 : charsIn(state, r.from, r.to)),
    0,
  );
  return { line: line.number, col: charsIn(state, line.from, head) + 1, selected };
}

/** "Ln 12, Col 8", and "· 15 selected" with a selection, beside the word
 *  count: a button that opens Go to line. Hidden until the editor has had
 *  the keyboard on this page (a position nobody placed means nothing). Not a
 *  live region: it would talk on every keystroke; its text is read when it
 *  is reached. */
export function CursorPosition() {
  const { t } = useTranslation();
  const view = useCurrentView();
  const [pos, setPos] = useState<Position | null>(null);

  useEffect(() => {
    if (!view) return;
    let shown = view.hasFocus;
    setPos(shown ? positionOf(view.state) : null);
    // The text taking the keyboard shows it at once (CodeMirror reports the
    // focus change a moment later).
    const onFocus = () => {
      shown = true;
      setPos(positionOf(view.state));
    };
    view.contentDOM.addEventListener('focus', onFocus);
    const off = onViewUpdate(view, (u) => {
      if (!u) {
        // Another page in the view: hidden again until it has the keyboard.
        shown = view.hasFocus;
        setPos(shown ? positionOf(view.state) : null);
        return;
      }
      if (u.focusChanged && u.view.hasFocus) shown = true;
      if (shown && (u.selectionSet || u.docChanged || u.focusChanged)) {
        const next = positionOf(u.state);
        setPos((prev) =>
          prev &&
          prev.line === next.line &&
          prev.col === next.col &&
          prev.selected === next.selected
            ? prev
            : next,
        );
      }
    });
    return () => {
      off();
      view.contentDOM.removeEventListener('focus', onFocus);
    };
  }, [view]);

  if (!view) return null;
  // Its room is kept meanwhile: appearing must not re-wrap the header's row
  // and move the text under the pointer (0.1.2).
  if (!pos) return <span className={`${styles.count} ${styles.cursorSlot}`} aria-hidden="true" />;
  const key = keyLabel('Ctrl+G', MAC);
  return (
    <button
      type="button"
      className={`${styles.count} ${styles.pill} ${styles.cursorPos}`}
      title={t('cursor.goTo', { key })}
      aria-keyshortcuts="Control+G"
      data-cursor-position
      onClick={() => goToLine(view)}
    >
      {pos.selected
        ? t('cursor.positionSelected', { line: pos.line, col: pos.col, count: pos.selected })
        : t('cursor.position', { line: pos.line, col: pos.col })}
    </button>
  );
}
