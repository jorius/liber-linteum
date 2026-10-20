import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  coverMax,
  MIN_COVER_HEIGHT,
  useCoverHeight,
  useCoverHeightStore,
} from '../../stores/coverHeightStore';
import styles from './PageView.module.css';

/** ↑/↓ move the edge this far; with Shift, four times as far. */
const STEP = 16;

/** The window's inner height, kept current on resize. */
function useWindowHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return height;
}

/** Cover resize: the cover band's height and the handle on its bottom edge.
 *  The page's own height (`.liber/vault.json`, never the note) or the app's
 *  default, shown between 132 px and 60% of the window; the window caps what
 *  is shown, never what is stored. Dragging the edge sets the height live and
 *  release saves it; from the keyboard (a focusable separator) ↑/↓ move it
 *  16 px (Shift: 64), Home/End go to the ends, Enter or leaving saves and
 *  Escape restores. A double-click, Delete or Backspace (the Mac "delete"
 *  key) puts the default back. */
export function useCoverResize(path: string): { height: number; handle: ReactNode } {
  const { t } = useTranslation();
  const stored = useCoverHeight(path);
  const max = coverMax(useWindowHeight());
  const clamp = (px: number) => Math.min(max, Math.max(MIN_COVER_HEIGHT, Math.round(px)));
  const shownStored = clamp(stored);
  const [draft, setDraft] = useState<number | null>(null);
  const height = draft === null ? shownStored : clamp(draft);
  /** The drag in progress; `value` is what release saves (a ref, so it never
   *  lags behind the last move). */
  const drag = useRef<{ startY: number; start: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    drag.current = null;
    setDragging(false);
    setDraft(null);
  }, [path]);

  const commit = (value: number) => {
    setDraft(null);
    if (value !== shownStored) void useCoverHeightStore.getState().save(path, value);
  };
  const reset = () => {
    drag.current = null;
    setDragging(false);
    setDraft(null);
    if (useCoverHeightStore.getState().pages[path] !== undefined) {
      void useCoverHeightStore.getState().save(path, null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowUp: -STEP, ArrowDown: STEP }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      setDraft(clamp(height + (e.shiftKey ? step * 4 : step)));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setDraft(e.key === 'Home' ? MIN_COVER_HEIGHT : max);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (draft !== null) commit(clamp(draft));
    } else if (e.key === 'Escape') {
      // Only a change in progress is the handle's to cancel.
      if (draft === null && !drag.current) return;
      e.preventDefault();
      e.stopPropagation();
      drag.current = null;
      setDragging(false);
      setDraft(null);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      reset();
    }
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { startY: e.clientY, start: height, value: height };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.value = clamp(d.start + e.clientY - d.startY);
    setDraft(d.value);
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (d.value !== d.start) commit(d.value);
  };
  const onPointerCancel = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    setDraft(null);
  };

  const handle = (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('cover.height')}
      aria-valuenow={height}
      aria-valuemin={MIN_COVER_HEIGHT}
      aria-valuemax={max}
      aria-valuetext={t('cover.heightValue', { px: height })}
      title={t('cover.resizeHint')}
      tabIndex={0}
      data-dragging={dragging || undefined}
      className={styles.coverResize}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={reset}
      onBlur={() => {
        if (draft !== null && !drag.current) commit(clamp(draft));
      }}
    />
  );
  return { height, handle };
}
