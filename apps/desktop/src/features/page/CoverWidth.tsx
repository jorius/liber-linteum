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
  coverWidthMax,
  MIN_CONTENT_WIDTH,
  MIN_COVER_WIDTH,
  useCoverLayoutStore,
  useCoverWidth,
} from '../../stores/coverLayoutStore';
import styles from './PageView.module.css';

/** ←/→ move the edge this far; with Shift, four times as far. */
const STEP = 16;

/** The window's inner width, kept current on resize. */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** A side cover's strip (M4b part 3 §3): its width and the handle on its
 *  inner edge, the twin of the cover band's height handle (CoverResize). The
 *  page's own width (`.nimw/vault.json`) or 280 px, shown between 160 px and
 *  45% of the window; the window caps what is shown, never what is stored.
 *  The arrow keys move the edge the way they point (on a left strip → widens
 *  it, on a right strip ←), Shift ×4, Home/End go to the ends, Enter or
 *  leaving saves, Escape restores; a double-click, Delete or Backspace puts
 *  the default back. The edge stops where the text beside it would go below
 *  its minimum (`available`, the page area's width), so resizing never pushes
 *  the strip to the top (final review I1); `fits` says whether the strip has
 *  room at all, and a window narrowed past that drops any change in progress. */
export function useCoverWidthResize(
  path: string,
  side: 'left' | 'right',
  available: number | null,
): { width: number; handle: ReactNode; fits: boolean } {
  const { t } = useTranslation();
  const stored = useCoverWidth(path);
  const windowMax = coverWidthMax(useWindowWidth());
  const shownStored = Math.min(windowMax, Math.max(MIN_COVER_WIDTH, Math.round(stored)));
  /** What the edge may reach: the window's cap, less any room the text needs. */
  const max =
    available === null
      ? windowMax
      : Math.max(MIN_COVER_WIDTH, Math.min(windowMax, Math.floor(available - MIN_CONTENT_WIDTH)));
  const clamp = (px: number) => Math.min(max, Math.max(MIN_COVER_WIDTH, Math.round(px)));
  const [draft, setDraft] = useState<number | null>(null);
  const width = draft === null ? shownStored : clamp(draft);
  const fits = available === null || available - width >= MIN_CONTENT_WIDTH;
  /** Moving the edge right widens a left strip and narrows a right one. */
  const grow = side === 'left' ? 1 : -1;
  const drag = useRef<{ startX: number; start: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    drag.current = null;
    setDragging(false);
    setDraft(null);
  }, [path, side]);
  // The strip is about to show on top instead: its handle unmounts, so a
  // change in progress could never finish.
  useEffect(() => {
    if (fits) return;
    drag.current = null;
    setDragging(false);
    setDraft(null);
  }, [fits]);

  const commit = (value: number) => {
    setDraft(null);
    if (value !== shownStored) void useCoverLayoutStore.getState().saveWidth(path, value);
  };
  const reset = () => {
    drag.current = null;
    setDragging(false);
    setDraft(null);
    if (useCoverLayoutStore.getState().widths[path] !== undefined) {
      void useCoverLayoutStore.getState().saveWidth(path, null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -STEP, ArrowRight: STEP }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      setDraft(clamp(width + (e.shiftKey ? step * 4 : step) * grow));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setDraft(e.key === 'Home' ? MIN_COVER_WIDTH : max);
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
    drag.current = { startX: e.clientX, start: width, value: width };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.value = clamp(d.start + (e.clientX - d.startX) * grow);
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
      aria-orientation="vertical"
      aria-label={t('cover.width')}
      aria-valuenow={width}
      aria-valuemin={MIN_COVER_WIDTH}
      aria-valuemax={max}
      aria-valuetext={t('cover.widthValue', { px: width })}
      title={t('cover.resizeHint')}
      tabIndex={0}
      data-dragging={dragging || undefined}
      className={styles.coverWidthResize}
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
  return { width, handle, fits };
}
