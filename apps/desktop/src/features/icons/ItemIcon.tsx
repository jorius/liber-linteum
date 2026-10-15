import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TreeNode } from '../../ipc';
import { useVaultStore } from '../../stores/vaultStore';
import { EmojiPicker } from './EmojiPicker';
import styles from './Icons.module.css';
import { setIcon, type IconTarget } from './setIcon';

let cache: { nodes: TreeNode[]; icons: Map<string, string> } | null = null;
function iconsOf(nodes: TreeNode[]): Map<string, string> {
  if (cache?.nodes !== nodes) {
    const icons = new Map<string, string>();
    for (const n of nodes) if (n.icon) icons.set(n.path, n.icon);
    cache = { nodes, icons };
  }
  return cache.icons;
}

/** Every page's and folder's emoji by path (M5b §4). */
export function useIcons(): Map<string, string> {
  return useVaultStore((s) => iconsOf(s.nodes));
}

/** The emoji of a page or folder (M5b §4), or `null`. */
export function useIcon(path: string | null | undefined): string | null {
  return useVaultStore((s) => (path ? (iconsOf(s.nodes).get(path) ?? null) : null));
}

/** An optional emoji before a name; nothing without one. Decorative: the
 *  name beside it says what it is. */
export function ItemIcon({
  icon,
  className,
}: {
  icon: string | null | undefined;
  className?: string;
}) {
  if (!icon) return null;
  return (
    <span className={className ? `${styles.icon} ${className}` : styles.icon} aria-hidden="true">
      {icon}
    </span>
  );
}

/** A page's, folder's or the vault's icon as a button that opens the emoji
 *  picker. Without an icon it reads "Add icon" (shown on hover or focus by
 *  the caller's styles via `data-empty`). */
export function IconButton({
  target,
  icon,
  name,
  className,
}: {
  target: IconTarget;
  icon: string | null | undefined;
  /** What the icon belongs to, for labels. */
  name: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const anchor = () => {
    const r = button.current?.getBoundingClientRect();
    return r ? { top: r.top, bottom: r.bottom, left: r.left } : null;
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className ? `${styles.iconButton} ${className}` : styles.iconButton}
        data-empty={icon ? undefined : ''}
        aria-label={icon ? t('icons.change') : t('icons.add')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={icon ? t('icons.change') : t('icons.add')}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">{icon ?? '☺'}</span>
      </button>
      {open && (
        <EmojiPicker
          anchor={anchor}
          label={t('icons.pickFor', { name })}
          hasIcon={!!icon}
          onClose={close}
          onPick={(emoji) => {
            close();
            void setIcon(target, emoji);
          }}
        />
      )}
    </>
  );
}
