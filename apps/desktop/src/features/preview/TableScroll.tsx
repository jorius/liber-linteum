import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './Preview.module.css';

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
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
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
