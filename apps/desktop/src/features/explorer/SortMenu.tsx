import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { folderSortGet, folderSortSet, type FolderSort } from '../../ipc';
import { useVaultStore } from '../../stores/vaultStore';

const SORTS: FolderSort[] = [
  'name-asc',
  'name-desc',
  'modified-desc',
  'modified-asc',
  'created-desc',
];

/** How a folder (`""`: the vault root) lists its entries (M5b round 2): a
 *  radio menu at `anchor`. ← goes `back` to the menu it came from. */
export function SortMenu({
  path,
  name,
  anchor,
  onClose,
  onBack,
}: {
  path: string;
  name: string;
  anchor: { x: number; y: number };
  onClose: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<FolderSort>('name-asc');
  const [active, setActive] = useState(0);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void folderSortGet(path).then((r) => r.ok && setCurrent(r.value));
  }, [path]);
  useEffect(() => items.current[active]?.focus(), [active]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const choose = (sort: FolderSort) => {
    onClose();
    void folderSortSet(path, sort).then(async (r) => {
      if (r.ok) await useVaultStore.getState().refreshTree();
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % SORTS.length);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + SORTS.length) % SORTS.length);
    else if (e.key === 'ArrowLeft' && onBack) onBack();
    else if (e.key === 'Escape' || e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={box}
      role="menu"
      aria-label={t('sort.label', { name })}
      className="nimw-menu"
      style={{ position: 'fixed', left: anchor.x, top: anchor.y }}
      onKeyDown={onKeyDown}
    >
      {SORTS.map((sort, i) => (
        <button
          key={sort}
          ref={(el) => {
            items.current[i] = el;
          }}
          type="button"
          role="menuitemradio"
          aria-checked={sort === current}
          tabIndex={i === active ? 0 : -1}
          onClick={() => choose(sort)}
        >
          {t(`sort.${sort}`)}
        </button>
      ))}
    </div>
  );
}
