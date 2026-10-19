import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import styles from './Dialogs.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: labelled, focus trapped, Escape closes, focus restored on
 *  close. Initial focus: the `[data-autofocus]` element, else the first
 *  focusable one. With `onConfirm`, Enter confirms (except on other buttons).
 *  `returnFocus` names where the keyboard goes on close when the element
 *  that had it is gone (a toast's action button; NFR-10).
 *  `dismissible` (Settings, whose changes save as they're made; M4b part 3):
 *  Escape closes even when nothing inside has focus (WebKit doesn't focus a
 *  clicked checkbox or button), a click on the backdrop closes, and closing
 *  first blurs the focused field so a value typed but not confirmed is saved. */
export function Dialog({
  title,
  onClose,
  onConfirm,
  returnFocus,
  dismissible = false,
  children,
}: {
  title: string;
  onClose: () => void;
  onConfirm?: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
  dismissible?: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pressedOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  /** Closes; a dismissible dialog first commits the field being edited. */
  const close = () => {
    const focused = document.activeElement;
    if (dismissible && focused instanceof HTMLElement && box.current?.contains(focused)) {
      focused.blur();
    }
    onCloseRef.current();
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!dismissible) return;
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      const box_ = box.current;
      if (e.key !== 'Escape' || e.defaultPrevented || !box_) return;
      if (e.target instanceof Node && box_.contains(e.target)) return;
      // Only the topmost dialog answers.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== box_) return;
      e.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [dismissible]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const box_ = box.current;
    (
      box_?.querySelector<HTMLElement>('[data-autofocus]') ??
      box_?.querySelector<HTMLElement>(FOCUSABLE)
    )?.focus();
    return () => {
      const kept = previous && previous !== document.body && previous.isConnected;
      (kept ? previous : returnFocus?.())?.focus?.();
    };
    // Taken when the dialog opens, as the element it returns to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
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

  // A press that starts inside and ends on the backdrop (selecting text,
  // dragging the colour picker) is not a click outside.
  const backdropDown = (e: MouseEvent<HTMLDivElement>) => {
    pressedOnBackdrop.current = e.target === e.currentTarget;
  };
  const backdropClick = (e: MouseEvent<HTMLDivElement>) => {
    const outside = pressedOnBackdrop.current && e.target === e.currentTarget;
    pressedOnBackdrop.current = false;
    if (outside) close();
  };

  return (
    <div
      className={styles.backdrop}
      onMouseDown={dismissible ? backdropDown : undefined}
      onClick={dismissible ? backdropClick : undefined}
    >
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
