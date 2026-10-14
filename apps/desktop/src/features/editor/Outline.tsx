import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useMediaQuery } from '../../app/useMediaQuery';
import { headingAt, headingsOf, parentsOf, type OutlineHeading } from '../../markdown/outline';
import { useSettingsStore } from '../../stores/settingsStore';
import styles from './Outline.module.css';
import { parsedFor } from './pageModel';
import { onViewUpdate } from './viewUpdates';

/** Typing pauses this long before the outline is read again. */
export const OUTLINE_DEBOUNCE_MS = 300;
export const OUTLINE_WIDTH = { min: 200, max: 420, initial: 260 };
const WIDTH_KEY = 'nimw.outlineWidth';

function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (n >= OUTLINE_WIDTH.min && n <= OUTLINE_WIDTH.max) return n;
  } catch {
    // No storage (private window): the default width.
  }
  return OUTLINE_WIDTH.initial;
}

/** The heading at the top of the editor's viewport. */
function topLine(view: EditorView): number {
  return view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
}

/** The outline panel (M4b part 2 §5): the page's headings as a tree beside
 *  the editor. Click or Enter jumps there (the Split pane follows the
 *  editor's scroll); ←/→ fold sections; the heading holding the cursor — or,
 *  while scrolling, the one at the top — is marked. Under 1100 px it
 *  overlays the editor. */
export function Outline({ view, text }: { view: EditorView; text: string }) {
  const { t } = useTranslation();
  const overlay = useMediaQuery('(max-width: 1099.98px)');
  const [source, setSource] = useState(text);
  const [width, setWidth] = useState(storedWidth);
  const [folded, setFolded] = useState<Set<number>>(() => new Set());
  const [current, setCurrent] = useState(-1);
  const [active, setActive] = useState(0);
  const tree = useRef<HTMLUListElement>(null);
  const panel = useRef<HTMLElement>(null);

  // A new page is read at once; typing waits for a pause.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => setSource(text), OUTLINE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const items = useMemo(() => headingsOf(parsedFor(source), source), [source]);
  const parents = useMemo(() => parentsOf(items), [items]);

  // Sections fold by heading position; a changed outline starts unfolded.
  useEffect(() => setFolded(new Set()), [items.length]);

  // The cursor's heading, or the top one while scrolling.
  useEffect(() => {
    // Scrolling that follows the cursor (typing, a jump) keeps its heading.
    let selected = 0;
    const fromCursor = () => {
      selected = performance.now();
      setCurrent(headingAt(items, view.state.selection.main.head));
    };
    fromCursor();
    const off = onViewUpdate(view, (u) => {
      if (!u || u.selectionSet || u.docChanged) fromCursor();
    });
    const onScroll = () => {
      if (performance.now() - selected > 250) setCurrent(headingAt(items, topLine(view)));
    };
    view.scrollDOM.addEventListener('scroll', onScroll);
    return () => {
      off();
      view.scrollDOM.removeEventListener('scroll', onScroll);
    };
  }, [view, items]);

  const hidden = (i: number): boolean => {
    for (let p = parents[i]; p >= 0; p = parents[p]) if (folded.has(items[p].from)) return true;
    return false;
  };
  const visible = items.map((_, i) => i).filter((i) => !hidden(i));
  const hasChildren = (i: number) => i + 1 < items.length && items[i + 1].level > items[i].level;
  // The mark sits on the nearest shown heading of the current section.
  let marked = current;
  while (marked >= 0 && hidden(marked)) marked = parents[marked];

  // The tab stop follows the current heading unless the tree has the keyboard.
  useEffect(() => {
    if (!tree.current?.contains(document.activeElement)) setActive(Math.max(0, marked));
  }, [marked]);
  const tabStop = visible.includes(active) ? active : (visible[0] ?? -1);

  // Closing it with the keyboard inside (View → Toggle Outline) hands the
  // keyboard to the editor (NFR-10).
  useEffect(() => {
    const el = panel.current;
    return () => {
      if (el?.contains(document.activeElement)) view.focus();
    };
  }, [view]);

  const jump = (h: OutlineHeading) => {
    view.dispatch({
      selection: EditorSelection.cursor(h.at),
      effects: EditorView.scrollIntoView(h.from, { y: 'start', yMargin: 8 }),
      userEvent: 'select.outline',
    });
    view.focus();
  };
  const fold = (i: number, on: boolean) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (on) next.add(items[i].from);
      else next.delete(items[i].from);
      return next;
    });
  const focusItem = (i: number) => {
    setActive(i);
    tree.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const at = visible.indexOf(i);
    const open = hasChildren(i) && !folded.has(items[i].from);
    let handled = true;
    if (e.key === 'ArrowDown') {
      if (at < visible.length - 1) focusItem(visible[at + 1]);
    } else if (e.key === 'ArrowUp') {
      if (at > 0) focusItem(visible[at - 1]);
    } else if (e.key === 'Home') focusItem(visible[0]);
    else if (e.key === 'End') focusItem(visible[visible.length - 1]);
    else if (e.key === 'ArrowRight') {
      if (hasChildren(i) && !open) fold(i, false);
      else if (open) focusItem(i + 1);
    } else if (e.key === 'ArrowLeft') {
      if (open) fold(i, true);
      else if (parents[i] >= 0) focusItem(parents[i]);
    } else if (e.key === 'Enter') jump(items[i]);
    else if (e.key === 'Escape' && overlay) {
      void useSettingsStore.getState().update({ outline: false });
      view.focus();
    } else handled = false;
    if (handled) e.preventDefault();
  };

  // Dragging the left edge; ←/→ on it change the width too.
  const setStoredWidth = (w: number) => {
    const next = Math.round(Math.min(OUTLINE_WIDTH.max, Math.max(OUTLINE_WIDTH.min, w)));
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // Not kept without storage.
    }
  };
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startX = e.clientX;
    const startWidth = width;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setStoredWidth(startWidth + startX - ev.clientX);
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  const onResizeKey = (e: KeyboardEvent) => {
    const step = { ArrowLeft: 16, ArrowRight: -16 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    setStoredWidth(width + step);
  };

  return (
    <aside
      ref={panel}
      className={`${styles.outline} ${overlay ? styles.overlay : ''}`}
      style={{ width }}
      aria-label={t('outline.title')}
      data-overlay={overlay || undefined}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('outline.resize')}
        aria-valuemin={OUTLINE_WIDTH.min}
        aria-valuemax={OUTLINE_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        className={styles.resize}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
      />
      <h2 className={styles.title}>{t('outline.title')}</h2>
      {items.length === 0 ? (
        <p className={styles.empty}>{t('outline.empty')}</p>
      ) : (
        <ul ref={tree} role="tree" aria-label={t('outline.title')} className={styles.tree}>
          {visible.map((i) => {
            const h = items[i];
            const parent = hasChildren(i);
            const siblings = items.filter((_, j) => parents[j] === parents[i]);
            return (
              <li
                key={`${h.from}-${i}`}
                role="treeitem"
                data-index={i}
                aria-level={h.level}
                aria-setsize={siblings.length}
                aria-posinset={siblings.indexOf(h) + 1}
                aria-expanded={parent ? !folded.has(h.from) : undefined}
                aria-selected={i === tabStop}
                aria-current={i === marked ? 'location' : undefined}
                tabIndex={i === tabStop ? 0 : -1}
                className={`${styles.item} ${i === marked ? styles.current : ''}`}
                style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
                onClick={() => {
                  setActive(i);
                  jump(h);
                }}
                onKeyDown={(e) => onKeyDown(e, i)}
              >
                {parent && (
                  <span
                    aria-hidden="true"
                    className={styles.twisty}
                    onClick={(e) => {
                      e.stopPropagation();
                      fold(i, !folded.has(h.from));
                    }}
                  >
                    {folded.has(h.from) ? '▸' : '▾'}
                  </span>
                )}
                <span className={styles.text}>{h.text || '—'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
