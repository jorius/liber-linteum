import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { parentOf } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { EmojiPicker } from '../icons/EmojiPicker';
import { setIcon } from '../icons/setIcon';
import { archiveItem } from '../bin/binActions';
import { requestTrash } from './trashAction';
import { displayName } from './TreeRow';

export interface MenuState {
  path: string;
  anchor: { x: number; y: number };
}

/** Explorer actions for one item (right-click, "…" or Shift+F10). */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const { t } = useTranslation();
  const node = useVaultStore((s) => s.nodes.find((n) => n.path === menu.path));
  const [active, setActive] = useState(0);
  // Icon… swaps the menu for the emoji picker at the same place (M5b §4).
  const [picking, setPicking] = useState(false);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    items.current[active]?.focus();
  }, [active]);

  useEffect(() => {
    if (picking) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose, picking]);

  // Its item vanished (deleted or renamed outside the app): close instead of
  // lingering invisibly with global shortcuts disabled (final review, upgraded M3).
  useEffect(() => {
    if (!node) onClose();
  }, [node, onClose]);

  if (!node) return null;
  const dir = node.kind === 'folder' ? node.path : parentOf(node.path);
  const vault = useVaultStore.getState;
  const actions: [string, () => void][] = [
    [t('menu.newPage'), () => void vault().createPage(dir)],
    [t('menu.newFolder'), () => void vault().createFolder(dir)],
    [t('menu.rename'), () => vault().startRename(node.path)],
    [t('menu.move'), () => useUiStore.getState().openDialog({ type: 'move', path: node.path })],
    ...(node.kind === 'attachment'
      ? []
      : [[t('menu.icon'), () => setPicking(true)] as [string, () => void]]),
    [t('menu.archive'), () => void archiveItem(node.path)],
    [t('menu.delete'), () => requestTrash(node.path)],
  ];

  if (picking) {
    const kind = node.kind === 'folder' ? 'folder' : 'page';
    return (
      <EmojiPicker
        anchor={() => ({ top: menu.anchor.y, bottom: menu.anchor.y, left: menu.anchor.x })}
        label={t('icons.pickFor', { name: displayName(node) })}
        hasIcon={!!node.icon}
        onClose={onClose}
        onPick={(emoji) => {
          onClose();
          void setIcon({ kind, path: node.path }, emoji);
        }}
      />
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % actions.length);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + actions.length) % actions.length);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(actions.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={box}
      role="menu"
      aria-label={t('menu.label', { name: displayName(node) })}
      className="nimw-menu"
      style={{ position: 'fixed', left: menu.anchor.x, top: menu.anchor.y }}
      onKeyDown={onKeyDown}
    >
      {actions.map(([label, run], i) => (
        <button
          key={label}
          ref={(el) => {
            items.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          onClick={() => {
            if (label !== t('menu.icon')) onClose();
            run();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
