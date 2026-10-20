import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './Preview.module.css';

/** In Live Preview's wide frame (M5b §7.2), a table wider at its natural
 *  width than the text takes the whole frame: the frame is marked
 *  `data-wide-full` for the editor's CSS. The frame reaches --liber-wide-m
 *  past the text on each side (Editor.tsx). */
function markWideFull(el: HTMLElement) {
  const frame = el.closest<HTMLElement>('.cm-liber-widget[data-wide-kind="tables"]');
  const table = el.firstElementChild as HTMLElement | null;
  if (!frame || !table) return;
  const on = !!frame.closest('[data-wide-tables]');
  const m = on ? parseFloat(getComputedStyle(frame).getPropertyValue('--liber-wide-m')) || 0 : 0;
  let full = false;
  if (m > 0) {
    const width = table.style.width;
    table.style.width = 'max-content';
    full = table.getBoundingClientRect().width > frame.clientWidth - 2 * m + 1;
    table.style.width = width;
  }
  frame.toggleAttribute('data-wide-full', full);
}

/** A table's own box (M4b part 3 wide elements §3): the table keeps its
 *  words whole and scrolls sideways here instead of squeezing. Only while
 *  it overflows is the box a named region in the tab order, so the keyboard
 *  can scroll it (axe scrollable-region-focusable) without a stop at every
 *  table that fits. */
export function TableScroll({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      setOverflows(el.scrollWidth > el.clientWidth + 1);
      markWideFull(el);
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    const table = el.firstElementChild;
    if (table) observer?.observe(table);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  return (
    <div
      ref={box}
      className={styles.tableScroll}
      data-table-scroll=""
      {...(overflows
        ? { role: 'region', 'aria-label': t('preview.tableScroll'), tabIndex: 0 }
        : {})}
    >
      {children}
    </div>
  );
}
