import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { TreeNode } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { useTrailStore } from '../../stores/trailStore';
import { folderPageOf, isArchived, joinPath, parentOf, remap } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { useUiStore } from '../../stores/uiStore';
import { useScratchpadStore } from '../scratchpad/scratchpadStore';
import { FavoritesSection } from '../favorites/FavoritesSection';
import { shownFavorites, useFavoritesStore } from '../favorites/favoritesStore';
import styles from './Explorer.module.css';
import { displayName, keptExtension, TreeRow } from './TreeRow';
import { isImagePath, isTextPath } from '../../stores/textFiles';

export interface Row {
  node: TreeNode;
  level: number;
}

/** Rows of the root and of expanded folders only (others are not rendered).
 *  `pinned`: the vault's scratch folder, first at the root (M4c §7.2).
 *  `root`: the folder whose contents are listed; the vault's tree leaves the
 *  Archive out, which the sidebar's foot lists itself (M5b round 2). */
export function visibleRows(
  children: Map<string, TreeNode[]>,
  expanded: Set<string>,
  pinned: string | null = null,
  root = '',
): Row[] {
  const out: Row[] = [];
  const pin = (list: TreeNode[]) => {
    const i = list.findIndex((n) => n.path === pinned && n.kind === 'folder');
    return i <= 0 ? list : [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
  };
  const walk = (parent: string, level: number) => {
    const own = folderPageOf(parent, children); // the folder's row stands for it
    const list = (children.get(parent) ?? []).filter((n) => n.path !== own);
    for (const node of parent ? list : pin(list.filter((n) => !isArchived(n.path)))) {
      out.push({ node, level });
      if (node.kind === 'folder' && expanded.has(node.path)) walk(node.path, level + 1);
    }
  };
  walk(root, 1);
  return out;
}

export interface ExplorerTreeProps {
  onRequestDelete?: (path: string) => void;
  onRequestMenu?: (path: string, anchor: { x: number; y: number }) => void;
  /** Highlighted drop target while dragging. */
  dropTarget?: string | null;
  /** A drag is in progress: arrow keys belong to the drag, not the tree. */
  dragging?: boolean;
  /** Lists this folder's contents instead of the vault's: the Archive, read-only. */
  root?: string;
}

/** ARIA tree (one Tab stop, roving focus, arrow keys, type-ahead, inline rename). */
export function ExplorerTree({
  onRequestDelete,
  onRequestMenu,
  dropTarget,
  dragging,
  root = '',
}: ExplorerTreeProps) {
  const archive = isArchived(root);
  const { t } = useTranslation();
  const children = useVaultStore((s) => s.children);
  const expanded = useVaultStore((s) => s.expanded);
  const selected = useVaultStore((s) => s.selected);
  const renaming = useVaultStore((s) => s.renaming);
  const focusRequest = useVaultStore((s) => s.focusRequest);
  const scratch = useScratchpadStore((s) => s.folder);
  const nodes = useVaultStore((s) => s.nodes);
  const openPath = usePageStore((s) => s.path);
  // A folder's own page (round 3b §6.2), as a node.
  const pageOf = (node: TreeNode) => {
    const path = node.kind === 'folder' ? folderPageOf(node.path, children) : null;
    return path ? (children.get(node.path)?.find((n) => n.path === path) ?? null) : null;
  };
  const rows = useMemo(
    () => visibleRows(children, expanded, archive ? null : scratch, root),
    [children, expanded, scratch, archive, root],
  );
  // The pinned folder's note count, and the first root row after it.
  const pinned = scratch !== null && rows[0]?.node.path === scratch;
  const notes = useMemo(
    () =>
      scratch === null
        ? 0
        : nodes.filter((n) => n.kind === 'page' && n.path.startsWith(`${scratch}/`)).length,
    [nodes, scratch],
  );
  const divider = pinned ? rows.findIndex((r, i) => i > 0 && r.level === 1) : -1;
  // Favorites (M5b §19) sit under the pinned Scratchpad (or first): the tree
  // splits in two around them, one Tab stop and one arrow-key order still.
  const hasFavorites = useFavoritesStore((s) => shownFavorites(s.paths, nodes).length > 0);
  // The Archive's own tree (M5b round 2) has no Favorites.
  const favorites = !archive && hasFavorites;
  const split = !favorites || !pinned ? 0 : divider > 0 ? divider : rows.length;
  const [focused, setFocused] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());

  // The single Tab stop must always be a visible row (final review I1): the
  // focused row, else the selection, else the nearest visible ancestor of
  // either, else the first row.
  const visible = useMemo(() => new Set(rows.map((r) => r.node.path)), [rows]);
  const focusPath = useMemo(() => {
    for (const start of [focused, selected]) {
      for (let p = start; p; p = parentOf(p)) if (visible.has(p)) return p;
    }
    return rows[0]?.node.path ?? null;
  }, [focused, selected, visible, rows]);
  const index = rows.findIndex((r) => r.node.path === focusPath);

  // When the focused row disappears (trash, rename, move), the browser drops
  // focus to <body>; put it back on the tree's Tab stop.
  const hadFocus = useRef(false);
  useEffect(() => {
    if (!hadFocus.current || !focusPath) return;
    const active = document.activeElement;
    if (!active || active === document.body) refs.current.get(focusPath)?.focus();
  }, [focusPath, rows]);

  const moveFocus = (path: string | undefined) => {
    if (!path) return;
    setFocused(path);
    refs.current.get(path)?.focus();
  };

  // Breadcrumb requests: focus that row (or the first one).
  useEffect(() => {
    if (!focusRequest) return;
    moveFocus(focusRequest.path || rows[0]?.node.path);
    // Only a new request moves focus, not later row changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // Keep focus on the renamed item after an inline rename.
  useEffect(() => {
    if (focused && !rows.some((r) => r.node.path === focused) && selected) setFocused(selected);
  }, [rows, focused, selected]);

  // Round 3b §8.1: whether the editor already showed the row's page before
  // the double-click's first click (which may itself open it).
  const wasEditing = useRef(false);
  const activate = (node: TreeNode, clicks = 1) => {
    const vault = useVaultStore.getState();
    const open = node.kind === 'folder' ? pageOf(node)?.path : node.path;
    const opens = !!open && (node.kind !== 'attachment' || isTextPath(open) || isImagePath(open));
    if (opens && clicks >= 2) {
      const ui = useUiStore.getState();
      if (wasEditing.current) {
        if (!archive) vault.startRename(node.path);
      } else {
        ui.setScreen('edit');
        if (usePageStore.getState().path !== open) void usePageStore.getState().load(open);
        usePageStore.getState().requestEditorFocus();
      }
      return;
    }
    wasEditing.current =
      useUiStore.getState().screen === 'edit' && usePageStore.getState().path === open;
    vault.select(node.path);
    setFocused(node.path);
    if (node.kind === 'folder' && !open) vault.toggle(node.path);
    else if (opens) {
      // Pages, text and code files in the text view (M4b part 2 §6), and
      // images in the image view (0.1.2).
      // Opening from the explorer starts a fresh link trail (M2b §3).
      useTrailStore.getState().reset();
      // The Trash view takes the editor's place (M5b §5).
      const ui = useUiStore.getState();
      if (ui.screen === 'trash') ui.setScreen('edit');
      void usePageStore.getState().load(open);
    }
  };

  const commitRename = (node: TreeNode, name: string) => {
    const vault = useVaultStore.getState();
    const newName = `${name}${keptExtension(node)}`;
    const oldName = node.path.slice(node.path.lastIndexOf('/') + 1);
    if (newName === oldName) {
      vault.startRename(null);
      return;
    }
    const to = joinPath(parentOf(node.path), newName);
    void vault.rename(node.path, to).then((res) => {
      if (res.ok) setFocused((f) => (f ? (remap(f, node.path, to) ?? f) : f));
    });
  };

  const cancelRename = () => {
    const path = useVaultStore.getState().renaming;
    useVaultStore.getState().startRename(null);
    if (path) refs.current.get(path)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (index < 0 || dragging) return;
    const row = rows[index];
    const vault = useVaultStore.getState();
    const isFolder = row.node.kind === 'folder';
    const isOpen = isFolder && expanded.has(row.node.path);
    switch (e.key) {
      case 'ArrowDown':
        moveFocus(rows[index + 1]?.node.path);
        break;
      case 'ArrowUp':
        moveFocus(rows[index - 1]?.node.path);
        break;
      case 'ArrowRight':
        if (isFolder && !isOpen) vault.toggle(row.node.path);
        else if (isOpen) moveFocus(rows[index + 1]?.node.path);
        break;
      case 'ArrowLeft':
        if (isOpen) vault.toggle(row.node.path);
        else moveFocus(parentOf(row.node.path) || undefined);
        break;
      case 'Home':
        moveFocus(rows[0]?.node.path);
        break;
      case 'End':
        moveFocus(rows[rows.length - 1]?.node.path);
        break;
      case 'Enter':
        activate(row.node);
        break;
      case 'F2':
        if (!archive) vault.startRename(row.node.path);
        break;
      case 'Delete':
      case 'Backspace':
        onRequestDelete?.(row.node.path);
        break;
      case 'ContextMenu': {
        const rect = refs.current.get(row.node.path)?.getBoundingClientRect();
        onRequestMenu?.(row.node.path, { x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        break;
      }
      default:
        if (e.key === 'F10' && e.shiftKey) {
          const rect = refs.current.get(row.node.path)?.getBoundingClientRect();
          onRequestMenu?.(row.node.path, { x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
          break;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const order = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
          // A name starts the same with or without its extension.
          const hit = order.find((r) => displayName(r.node, false).toLowerCase().startsWith(ch));
          moveFocus(hit?.node.path);
          break;
        }
        return;
    }
    e.preventDefault();
  };

  const tree = {
    onFocus: () => {
      hadFocus.current = true;
    },
    onBlur: (e: FocusEvent<HTMLUListElement>) => {
      // Focus moving to another element outside the tree ends "tree has focus";
      // a removed row blurs with no related target, which keeps it.
      if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) {
        hadFocus.current = false;
      }
    },
    role: 'tree',
    className: styles.tree,
    onKeyDown,
    onContextMenu: (e: MouseEvent<HTMLUListElement>) => {
      const li = (e.target as HTMLElement).closest('li[data-path]');
      const path = li?.getAttribute('data-path');
      if (path && onRequestMenu) {
        e.preventDefault();
        setFocused(path);
        onRequestMenu(path, { x: e.clientX, y: e.clientY });
      }
    },
  };

  const renderRow = ({ node, level }: (typeof rows)[number], i: number) => (
    <TreeRow
      pinnedCount={pinned && i === 0 ? notes : undefined}
      divider={i === divider}
      key={node.path}
      ref={(el) => {
        if (el) refs.current.set(node.path, el);
        else refs.current.delete(node.path);
      }}
      node={node}
      level={level}
      expanded={expanded.has(node.path)}
      selected={selected === node.path}
      focused={focusPath === node.path}
      renaming={renaming === node.path}
      dropTarget={dropTarget === node.path}
      page={pageOf(node)}
      current={pageOf(node)?.path === openPath}
      onToggle={(n) => useVaultStore.getState().toggle(n.path)}
      onActivate={activate}
      onFocusRow={setFocused}
      onCommitRename={commitRename}
      onCancelRename={cancelRename}
    />
  );

  if (!favorites) {
    return (
      <ul {...tree} aria-label={archive ? t('bin.archived') : t('explorer.tree')}>
        {rows.map(renderRow)}
      </ul>
    );
  }
  return (
    <>
      {split > 0 && (
        <ul {...tree} aria-label={t('favorites.scratchTree')}>
          {rows.slice(0, split).map(renderRow)}
        </ul>
      )}
      <FavoritesSection onRequestMenu={onRequestMenu} />
      <ul {...tree} aria-label={t('explorer.tree')}>
        {rows.slice(split).map((row, i) => renderRow(row, i + split))}
      </ul>
    </>
  );
}
