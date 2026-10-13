import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './Dialogs.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: labelled, focus trapped, Escape closes, focus restored on
 *  close. Initial focus: the `[data-autofocus]` element, else the first
 *  focusable one. With `onConfirm`, Enter confirms (except on other buttons). */
export function Dialog({
  title,
  onClose,
  onConfirm,
  children,
}: {
  title: string;
  onClose: () => void;
  onConfirm?: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const box_ = box.current;
    (
      box_?.querySelector<HTMLElement>('[data-autofocus]') ??
      box_?.querySelector<HTMLElement>(FOCUSABLE)
    )?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter' && onConfirm && !(e.target as HTMLElement).closest('button, select')) {
      e.preventDefault();
      onConfirm();
      return;
    }
    if (e.key !== 'Tab' || !box.current) return;
    const nodes = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.backdrop}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={styles.dialog}
        onKeyDown={onKeyDown}
      >
        <h2 id="dialog-title" className={styles.title}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
