import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { placePopup, windowViewport } from '../editor/placePopup';

/** A right-click menu at `anchor` (the image and diagram menus): kept on
 *  screen, closed by a press outside it, Escape or Tab; arrows move. */
export function PopupMenu({
  label,
  items,
  anchor,
  onClose,
}: {
  label: string;
  items: { label: string; run: () => void }[];
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ top: anchor.y, left: anchor.x });
  useLayoutEffect(() => {
    const el = box.current;
    const size = { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 };
    const { top, left } = placePopup(
      { top: anchor.y, bottom: anchor.y, left: anchor.x },
      size,
      windowViewport(),
    );
    setPlace({ top, left });
  }, [anchor.x, anchor.y]);
  useEffect(() => buttons.current[active]?.focus(), [active]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % items.length);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + items.length) % items.length);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      ref={box}
      role="menu"
      aria-label={label}
      className="liber-menu"
      style={{ position: 'fixed', left: place.left, top: place.top }}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          onMouseMove={() => setActive(i)}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
