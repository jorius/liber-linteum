import { useDraggable, useDroppable } from '@dnd-kit/core';
import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TreeNode } from '../../ipc';
import { isArchived } from '../../stores/tree';
import { StarIcon } from '../favorites/FavoritesSection';
import { useFavoritesStore } from '../favorites/favoritesStore';
import { IconButton, ItemIcon } from '../icons/ItemIcon';
import { QuickNoteIcon } from '../scratchpad/QuickNoteIcon';
import styles from './Explorer.module.css';
import { validateName } from './nameRules';
import { requestTrash } from './trashAction';

/** Name shown in the tree: pages without their `.md`. */
export function displayName(node: TreeNode): string {
  const name = node.path.slice(node.path.lastIndexOf('/') + 1);
  return node.kind === 'page' ? name.replace(/\.md$/i, '') : name;
}

/** The extension kept when renaming (`.md` as written, or '' for folders). */
export function keptExtension(node: TreeNode): string {
  if (node.kind !== 'page') return '';
  const m = /\.md$/i.exec(node.path);
  return m ? m[0] : '';
}

interface TreeRowProps {
  node: TreeNode;
  level: number;
  expanded: boolean;
  selected: boolean;
  focused: boolean;
  renaming: boolean;
  dropTarget?: boolean;
  onActivate: (node: TreeNode) => void;
  onFocusRow: (path: string) => void;
  onCommitRename: (node: TreeNode, name: string) => void;
  onCancelRename: () => void;
  /** The vault's scratch folder, pinned first (M4c §7.2): its note count. */
  pinnedCount?: number;
  /** The first root row under the pinned scratch folder. */
  divider?: boolean;
}

/** The row's ★ (round 3 §2.3): adds the item to Favorites or takes it out. */
function FavoriteAction({ path, name }: { path: string; name: string }) {
  const { t } = useTranslation();
  const on = useFavoritesStore((s) => s.paths.includes(path));
  // One fixed name; aria-pressed carries the state (the tooltip says the action).
  return (
    <button
      type="button"
      tabIndex={-1}
      className={styles.action}
      aria-pressed={on}
      aria-label={t('favorites.toggleNamed', { name })}
      title={t(on ? 'favorites.removeNamed' : 'favorites.addNamed', { name })}
      onClick={() => void useFavoritesStore.getState().toggle(path)}
    >
      <StarIcon filled={on} size={13} />
    </button>
  );
}

/** "Add an icon": a face with a plus, at full contrast (round 3 §2.3). */
function EmojiAddGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5V12a9 9 0 1 1-9-9h.5" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

export function Icon({ node, expanded }: { node: TreeNode; expanded: boolean }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    'aria-hidden': true,
  } as const;
  if (node.kind === 'folder') {
    return (
      <svg
        {...common}
        strokeWidth={2.4}
        strokeLinecap="round"
        className={expanded ? styles.open : styles.chevron}
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    );
  }
  if (node.kind === 'page') {
    return (
      <svg {...common} strokeLinejoin="round">
        <path d="M6 3h8l4 4v14H6z" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 16l5-5 4 4 3-3 4 4" />
    </svg>
  );
}

function RenameInput({
  node,
  onCommit,
  onCancel,
}: {
  node: TreeNode;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(displayName(node));
  const input = useRef<HTMLInputElement>(null);
  // Set once Enter/Escape decided; the blur that follows unmounting is ignored.
  const finished = useRef(false);
  const error = validateName(value);
  const errorId = useId();

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!error) {
        finished.current = true;
        onCommit(value.trim());
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finished.current = true;
      onCancel();
    }
  };

  return (
    <span className={styles.renameBox}>
      <input
        ref={input}
        className={styles.renameInput}
        aria-label={t('explorer.rename')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => {
          if (finished.current) return;
          finished.current = true;
          if (error) onCancel();
          else onCommit(value.trim());
        }}
      />
      {error && (
        <span id={errorId} className={styles.renameError}>
          {t(
            `explorer.nameErrors.${error.key}`,
            error.key === 'forbidden' ? { char: error.char } : {},
          )}
        </span>
      )}
    </span>
  );
}

export const TreeRow = forwardRef<HTMLLIElement, TreeRowProps>(function TreeRow(
  {
    node,
    level,
    expanded,
    selected,
    focused,
    renaming,
    dropTarget,
    onActivate,
    onFocusRow,
    onCommitRename,
    onCancelRename,
    pinnedCount,
    divider,
  },
  ref,
) {
  const { t } = useTranslation();
  const name = displayName(node);
  // The Archive is read-only (M5b round 2): no new page inside, no icon.
  const archived = isArchived(node.path);
  // Drag source (any item) and drop target (folders). Only the listeners are
  // spread: dnd-kit's attributes would replace the treeitem role and tabindex.
  const drag = useDraggable({ id: node.path, disabled: renaming });
  const drop = useDroppable({ id: node.path, disabled: node.kind !== 'folder' });
  const setRefs = (el: HTMLLIElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  const classes = [
    styles.row,
    selected ? styles.selected : '',
    dropTarget ? styles.drop : '',
    drag.isDragging ? styles.dragSource : '',
    divider ? styles.divider : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li
      ref={setRefs}
      {...drag.listeners}
      role="treeitem"
      aria-label={
        pinnedCount === undefined ? name : t('explorer.scratchFolder', { name, count: pinnedCount })
      }
      aria-level={level}
      aria-selected={selected}
      aria-expanded={node.kind === 'folder' ? expanded : undefined}
      tabIndex={focused ? 0 : -1}
      data-path={node.path}
      data-name={name}
      data-divider={divider || undefined}
      className={classes}
      style={{ paddingLeft: 8 + (level - 1) * 16 }}
      onClick={() => onActivate(node)}
      onFocus={() => onFocusRow(node.path)}
    >
      {/* An optional emoji (M5b §4) stands in for the page glyph, and
          follows a folder's chevron. */}
      {node.kind === 'page' && node.icon ? (
        <ItemIcon icon={node.icon} />
      ) : (
        <Icon node={node} expanded={expanded} />
      )}
      {node.kind === 'folder' && <ItemIcon icon={node.icon} />}
      {pinnedCount !== undefined && (
        <span className={styles.pinIcon} data-quick-note-icon>
          <QuickNoteIcon size={14} />
        </span>
      )}
      {renaming ? (
        <RenameInput
          node={node}
          onCommit={(n) => onCommitRename(node, n)}
          onCancel={onCancelRename}
        />
      ) : (
        <span
          className={node.kind === 'folder' ? `${styles.label} ${styles.folder}` : styles.label}
        >
          {name}
        </span>
      )}
      {pinnedCount !== undefined && !renaming && (
        <span className={styles.count} aria-hidden>
          {pinnedCount}
        </span>
      )}
      {!renaming && (
        // Quick actions (round 3 §2.3: ★ ☺ 🗑), for the pointer: shown on
        // hover, focus and selection; right-click, Delete and Shift+F10 do the
        // rest. Their clicks and keys (the picker's too) stay out of the row.
        <span
          className={styles.actions}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {node.kind !== 'attachment' && !archived && (
            <FavoriteAction path={node.path} name={name} />
          )}
          {node.kind !== 'attachment' && !archived && (
            <IconButton
              target={{ kind: node.kind, path: node.path }}
              icon={node.icon}
              name={name}
              glyph={<EmojiAddGlyph />}
              label={t('icons.pickFor', { name })}
              tabIndex={-1}
              className={styles.action}
            />
          )}
          <button
            type="button"
            tabIndex={-1}
            className={styles.action}
            aria-label={t('explorer.trash', { name })}
            title={t('explorer.trash', { name })}
            onClick={() => requestTrash(node.path)}
          >
            <TrashGlyph />
          </button>
        </span>
      )}
    </li>
  );
});
