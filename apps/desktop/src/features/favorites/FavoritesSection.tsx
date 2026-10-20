import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TreeNode } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { isTextPath } from '../../stores/textFiles';
import { useTrailStore } from '../../stores/trailStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import explorer from '../explorer/Explorer.module.css';
import { displayName, Icon } from '../explorer/TreeRow';
import { ItemIcon } from '../icons/ItemIcon';
import { shownFavorites, useFavoritesStore } from './favoritesStore';
import styles from './Favorites.module.css';

type MenuOpener = (path: string, anchor: { x: number; y: number }) => void;

/** A filled or outlined star. */
export function StarIcon({ filled, size = 13 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />
    </svg>
  );
}

const COLLAPSED = 'liber.favoritesCollapsed:';

function readCollapsed(root: string): boolean {
  try {
    return localStorage.getItem(COLLAPSED + root) === '1';
  } catch {
    return false;
  }
}

/** Opens a page the way the explorer does (M2b §3: a fresh link trail; the
 *  Trash view gives the editor its place back). Kept beside the explorer's
 *  own copy so the two cherry-pick apart. */
function openEntry(node: TreeNode, clicks = 1) {
  const vault = useVaultStore.getState();
  vault.select(node.path);
  if (node.kind !== 'page' && !isTextPath(node.path)) return;
  if (clicks >= 2) {
    // Round 3b §8.1: a double-click opens the page for editing.
    useUiStore.getState().setScreen('edit');
    usePageStore.getState().requestEditorFocus();
    return;
  }
  useTrailStore.getState().reset();
  const ui = useUiStore.getState();
  if (ui.screen === 'trash') ui.setScreen('edit');
  void usePageStore.getState().load(node.path);
}

/** Favorites (M5b §19): below the pinned Scratchpad, a labelled list of the
 *  vault's favorite pages and folders; folders open in place. Reordered by
 *  dragging, or Move up / Move down in the row menu. Nothing while empty. */
export function FavoritesSection({ onRequestMenu }: { onRequestMenu?: MenuOpener }) {
  const { t } = useTranslation();
  const headingId = useId();
  const root = useVaultStore((s) => s.info?.root ?? '');
  const nodes = useVaultStore((s) => s.nodes);
  const paths = useFavoritesStore((s) => s.paths);
  const shown = shownFavorites(paths, nodes);
  const [collapsedFor, setCollapsedFor] = useState<Record<string, boolean>>({});
  const collapsed = collapsedFor[root] ?? readCollapsed(root);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const drag = useRef<{ path: string; y: number; moved: boolean } | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);

  if (shown.length === 0) return null;

  const setCollapsed = (value: boolean) => {
    setCollapsedFor((c) => ({ ...c, [root]: value }));
    try {
      localStorage.setItem(COLLAPSED + root, value ? '1' : '0');
    } catch {
      // A per-viewer convenience: not kept when storage is unavailable.
    }
  };

  // Dragging a favorite among the others (pointer events: the explorer's
  // dnd-kit would read a drop on a folder as a move).
  const targetAt = (y: number): string | null => {
    for (const node of shown) {
      const rect = rows.current.get(node.path)?.getBoundingClientRect();
      if (rect && y < rect.top + rect.height / 2) return node.path;
    }
    return null;
  };
  const onPointerDown = (e: PointerEvent<HTMLElement>, path: string) => {
    if (e.button !== 0) return;
    drag.current = { path, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || (!d.moved && Math.abs(e.clientY - d.y) < 4)) return;
    // Captured only once it's a drag, so a plain click still reaches the name.
    if (!d.moved) e.currentTarget.setPointerCapture?.(e.pointerId);
    d.moved = true;
    setDropBefore(targetAt(e.clientY));
  };
  // A cancelled pointer or Escape drops the drag: nothing moves (round-2 review M10).
  const cancelDrag = () => {
    drag.current = null;
    setDropBefore(undefined);
  };
  const onDragKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && drag.current?.moved) {
      e.stopPropagation();
      cancelDrag();
    }
  };
  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d?.moved) {
      const before = targetAt(e.clientY);
      if (before !== d.path) void useFavoritesStore.getState().move(d.path, before);
    }
    setDropBefore(undefined);
    // The click that ends a drag opens nothing (read in onClick).
    setTimeout(() => {
      drag.current = null;
    });
  };

  return (
    <section
      className={styles.section}
      aria-labelledby={headingId}
      data-favorites
      onKeyDown={onDragKey}
    >
      <h2 className={styles.heading} id={headingId}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <svg
            className={collapsed ? styles.chevron : `${styles.chevron} ${styles.open}`}
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          <StarIcon filled size={12} />
          {t('favorites.title')}
        </button>
      </h2>
      {!collapsed && (
        <ul className={styles.list} aria-labelledby={headingId}>
          {shown.map((node) => (
            <FavoriteRow
              key={node.path}
              node={node}
              level={0}
              favorite
              dropAbove={dropBefore === node.path}
              rowRef={(el) => {
                if (el) rows.current.set(node.path, el);
                else rows.current.delete(node.path);
              }}
              dragged={() => drag.current?.moved === true}
              pointer={{ onPointerDown, onPointerMove, onPointerUp, onPointerCancel: cancelDrag }}
              onRequestMenu={onRequestMenu}
            />
          ))}
          {dropBefore === null && <li className={styles.dropEnd} aria-hidden="true" />}
        </ul>
      )}
    </section>
  );
}

interface RowProps {
  node: TreeNode;
  level: number;
  /** A favorite itself (not a page inside a favorite folder). */
  favorite?: boolean;
  dropAbove?: boolean;
  rowRef?: (el: HTMLLIElement | null) => void;
  dragged?: () => boolean;
  pointer?: {
    onPointerDown: (e: PointerEvent<HTMLElement>, path: string) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
  };
  onRequestMenu?: MenuOpener;
}

function FavoriteRow({
  node,
  level,
  favorite,
  dropAbove,
  rowRef,
  dragged,
  pointer,
  onRequestMenu,
}: RowProps) {
  const { t } = useTranslation();
  const name = displayName(node);
  const selected = useVaultStore((s) => s.selected === node.path);
  const kids = useVaultStore((s) =>
    node.kind === 'folder' ? s.children.get(node.path) : undefined,
  );
  const [open, setOpen] = useState(false);
  const isFolder = node.kind === 'folder';
  const menuAt = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    onRequestMenu?.(node.path, { x: rect.left, y: rect.bottom });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      menuAt(e.currentTarget);
    }
  };
  const classes = [
    explorer.row,
    selected ? explorer.selected : '',
    dropAbove ? styles.dropAbove : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li ref={rowRef} data-favorite={favorite ? node.path : undefined}>
      <div
        className={classes}
        style={{ paddingLeft: 8 + level * 16 }}
        onPointerDown={pointer ? (e) => pointer.onPointerDown(e, node.path) : undefined}
        onPointerMove={pointer?.onPointerMove}
        onPointerUp={pointer?.onPointerUp}
        onPointerCancel={pointer?.onPointerCancel}
        onContextMenu={(e) => {
          if (!onRequestMenu) return;
          e.preventDefault();
          onRequestMenu(node.path, { x: e.clientX, y: e.clientY });
        }}
      >
        {node.icon ? <ItemIcon icon={node.icon} /> : <Icon node={node} expanded={open} />}
        <button
          type="button"
          className={styles.name}
          aria-expanded={isFolder ? open : undefined}
          onKeyDown={onKeyDown}
          onClick={(e) => {
            if (dragged?.()) return;
            if (isFolder) setOpen(!open);
            else openEntry(node, e.detail);
          }}
        >
          {name}
        </button>
        <span
          className={explorer.actions}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {favorite && (
            <button
              type="button"
              tabIndex={-1}
              className={`${explorer.action} ${styles.star}`}
              aria-label={t('favorites.removeNamed', { name })}
              title={t('favorites.remove')}
              onClick={() => void useFavoritesStore.getState().toggle(node.path)}
            >
              <StarIcon filled />
            </button>
          )}
        </span>
      </div>
      {isFolder && open && kids && kids.length > 0 && (
        <ul className={styles.list}>
          {kids.map((kid) => (
            <FavoriteRow
              key={kid.path}
              node={kid}
              level={level + 1}
              onRequestMenu={onRequestMenu}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
