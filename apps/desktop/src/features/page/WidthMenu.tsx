import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CheckIcon, WidthIcon } from '../../app/icons';
import type { PageWidth } from '../../ipc';
import { useOwnPageWidth, usePageWidth, usePageWidthStore } from '../../stores/pageWidthStore';
import styles from './PageView.module.css';

const WIDTHS: PageWidth[] = ['readable', 'wide', 'full'];

/** The header band's page width control (M4b part 2 §1; M4b part 3 wide
 *  elements §2): a menu button (ARIA menu button pattern) whose icon shows
 *  the page's width, opening Readable / Wide elements / Full width as radio
 *  items and Reset to default (clears the page's own width; unavailable
 *  without one). Arrows, Home and End move; Escape and Tab close and give
 *  the keyboard back to the button, as a choice does. */
export function WidthMenu({ path }: { path: string }) {
  const { t } = useTranslation();
  const width = usePageWidth(path);
  const own = useOwnPageWidth(path);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);
  const name = (w: PageWidth) => t(`page.width.${w}`);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.toolbarToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('page.width.label')}
        title={t('page.width.title', { width: name(width) })}
        data-active={width !== 'readable' || undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        <WidthIcon width={width} />
      </button>
      {open && button.current && (
        <Menu
          anchor={button.current}
          label={t('page.width.label')}
          width={width}
          own={own}
          name={name}
          resetLabel={t('page.width.reset')}
          onChoose={(next) => {
            close(true);
            void usePageWidthStore.getState().set(path, next);
          }}
          onClose={close}
        />
      )}
    </>
  );
}

function Menu({
  anchor,
  label,
  width,
  own,
  name,
  resetLabel,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement;
  label: string;
  width: PageWidth;
  own: boolean;
  name: (w: PageWidth) => string;
  resetLabel: string;
  onChoose: (width: PageWidth | null) => void;
  onClose: (refocus: boolean) => void;
}) {
  // The keyboard moves over the radios, then Reset when it's available.
  const count = WIDTHS.length + (own ? 1 : 0);
  const [active, setActive] = useState(Math.max(0, WIDTHS.indexOf(width)));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();

  useEffect(() => {
    refs.current[active]?.focus();
  }, [active]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !anchor.contains(target)) onClose(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor, onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % count);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + count) % count);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(count - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={label}
      className={`liber-menu ${styles.widthMenu}`}
      style={{
        position: 'fixed',
        right: Math.max(8, document.documentElement.clientWidth - rect.right),
        top: rect.bottom + 4,
      }}
      onKeyDown={onKeyDown}
    >
      {WIDTHS.map((w, i) => (
        <button
          key={w}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="menuitemradio"
          aria-checked={w === width}
          tabIndex={i === active ? 0 : -1}
          onClick={() => onChoose(w)}
        >
          <span className={styles.widthCheck}>{w === width && <CheckIcon />}</span>
          {name(w)}
        </button>
      ))}
      <div role="separator" />
      <button
        ref={(el) => {
          refs.current[WIDTHS.length] = own ? el : null;
        }}
        type="button"
        role="menuitem"
        aria-disabled={!own}
        tabIndex={own && active === WIDTHS.length ? 0 : -1}
        onClick={() => {
          if (own) onChoose(null);
        }}
      >
        <span className={styles.widthCheck} />
        {resetLabel}
      </button>
    </div>,
    anchor.closest<HTMLElement>('main, [role="main"], section[aria-label], [role="region"]') ??
      document.body,
  );
}
