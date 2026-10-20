import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export interface CardMenuItem {
  label: string;
  run: () => void;
}

/** How to close each open menu. */
const openMenus = new Set<() => void>();

/** Closes the open card menu, if any: the canvas moved under it (a pan, a
 *  zoom, another level). The keyboard in it goes back to its button. */
export function closeCardMenus() {
  for (const close of [...openMenus]) close();
}

/** A card's connections menu (M3b §3; ARIA menu button pattern): under its
 *  button, in a portal (React Flow's viewport is transformed, which would
 *  move a fixed-position menu with the canvas) into the landmark region
 *  that holds the card, the Global View (axe `region`, final review m9).
 *  Placed once, it closes when the canvas pans, zooms or shows another
 *  level ({@link closeCardMenus}). Arrow keys, Home and End
 *  move, Escape and Tab close it and give the keyboard back to the button;
 *  a click elsewhere closes it. An item gets the keyboard back to the button
 *  before it runs: a dialog it opens returns there (NFR-10, final review
 *  I2). */
export function CardMenu({
  label,
  items,
  anchor,
  onClose,
}: {
  label: string;
  items: CardMenuItem[];
  anchor: HTMLElement;
  onClose: (refocus: boolean) => void;
}) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();

  useEffect(() => {
    refs.current[active]?.focus();
  }, [active]);

  useEffect(() => {
    const close = () => onClose(box.current?.contains(document.activeElement) ?? false);
    openMenus.add(close);
    return () => {
      openMenus.delete(close);
    };
  }, [onClose]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !anchor.contains(target)) onClose(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor, onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % items.length);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + items.length) % items.length);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(items.length - 1);
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
      className="liber-menu"
      style={{ position: 'fixed', left: rect.left, top: rect.bottom + 4 }}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          onClick={() => {
            onClose(true);
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    anchor.closest<HTMLElement>('section[aria-label], [role="region"]') ?? document.body,
  );
}
