import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import styles from './Shell.module.css';

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 560;
export const DEFAULT_SIDEBAR_WIDTH = 270;
/** ←/→ move the edge this far; with Shift, four times as far. */
const STEP = 16;

const clamp = (px: number) =>
  Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(px)));

/** The sidebar's width (round 3 §2.1) and the handle on its right edge: drag
 *  it, or focus it and use ←/→ (Shift ×4), Home/End; a double-click puts the
 *  default back. Dragging saves once on release, keys on each press; the
 *  width is app-wide (`sidebarWidth`). */
export function useSidebarResize() {
  const { t } = useTranslation();
  const stored = clamp(useSettingsStore((s) => s.settings.sidebarWidth));
  // Shown until the saved setting catches up with it, so the edge never jumps
  // back while older saves are still answering.
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft((d) => (d === stored ? null : d)), [stored]);
  const width = draft ?? stored;
  // Saves go one at a time, so they land in the order the keys were pressed.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const drag = useRef<{ startX: number; start: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const save = (px: number) => {
    const value = clamp(px);
    setDraft(value === stored ? null : value);
    if (value === stored) return;
    queue.current = queue.current
      .then(async () => {
        const res = await useSettingsStore.getState().update({ sidebarWidth: value });
        // A refused save shows the stored width again rather than a stale edge.
        if (!res.ok) setDraft((d) => (d === value ? null : d));
      })
      .catch(() => setDraft(null)); // a broken save must not stall the queue
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -STEP, ArrowRight: STEP }[e.key];
    if (step !== undefined) save(width + (e.shiftKey ? step * 4 : step));
    else if (e.key === 'Home') save(MIN_SIDEBAR_WIDTH);
    else if (e.key === 'End') save(MAX_SIDEBAR_WIDTH);
    else return;
    e.preventDefault();
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { startX: e.clientX, start: width };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const dragged = (e: PointerEvent<HTMLDivElement>, d: { startX: number; start: number }) =>
    clamp(d.start + e.clientX - d.startX);
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) setDraft(dragged(e, d));
  };
  // The width comes from the release itself: on a busy machine it can arrive
  // before the last move has rendered (round 3b final review, flaky drag).
  const end = (e: PointerEvent<HTMLDivElement>, keep: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (keep) save(dragged(e, d));
    else setDraft(null);
  };

  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('shell.resizeSidebar')}
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      title={t('shell.resizeSidebarHint')}
      tabIndex={0}
      data-dragging={dragging || undefined}
      className={styles.sideResize}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onDoubleClick={() => save(DEFAULT_SIDEBAR_WIDTH)}
    />
  );
  return { width, handle };
}
