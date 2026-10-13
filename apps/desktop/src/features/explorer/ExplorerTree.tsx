import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TreeNode } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { joinPath, parentOf, remap } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './Explorer.module.css';
import { displayName, keptExtension, TreeRow } from './TreeRow';

export interface Row {
  node: TreeNode;
  level: number;
}

/** Rows of the root and of expanded folders only (others are not rendered). */
export function visibleRows(children: Map<string, TreeNode[]>, expanded: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (parent: string, level: number) => {
    for (const node of children.get(parent) ?? []) {
      out.push({ node, level });
      if (node.kind === 'folder' && expanded.has(node.path)) walk(node.path, level + 1);
    }
  };
  walk('', 1);
  return out;
}

export interface ExplorerTreeProps {
  onRequestDelete?: (path: string) => void;
  onRequestMenu?: (path: string, anchor: { x: number; y: number }) => void;
  /** Highlighted drop target while dragging. */
  dropTarget?: string | null;
  /** A drag is in progress: arrow keys belong to the drag, not the tree. */
  dragging?: boolean;
}

/** ARIA tree (one Tab stop, roving focus, arrow keys, type-ahead, inline rename). */
export function ExplorerTree({
  onRequestDelete,
  onRequestMenu,
  dropTarget,
  dragging,
}: ExplorerTreeProps) {
  const { t } = useTranslation();
  const children = useVaultStore((s) => s.children);
  const expanded = useVaultStore((s) => s.expanded);
  const selected = useVaultStore((s) => s.selected);
  const renaming = useVaultStore((s) => s.renaming);
  const focusRequest = useVaultStore((s) => s.focusRequest);
  const rows = useMemo(() => visibleRows(children, expanded), [children, expanded]);
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

  const activate = (node: TreeNode) => {
    const vault = useVaultStore.getState();
    vault.select(node.path);
    setFocused(node.path);
    if (node.kind === 'folder') vault.toggle(node.path);
    else if (node.kind === 'page') void usePageStore.getState().load(node.path);
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
        moveFocus(rows.at(-1)?.node.path);
        break;
      case 'Enter':
        activate(row.node);
        break;
      case 'F2':
        vault.startRename(row.node.path);
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
          const hit = order.find((r) => displayName(r.node).toLowerCase().startsWith(ch));
          moveFocus(hit?.node.path);
          break;
        }
        return;
    }
    e.preventDefault();
  };

  return (
    <ul
      onFocus={() => {
        hadFocus.current = true;
      }}
      onBlur={(e) => {
        // Focus moving to another element outside the tree ends "tree has focus";
        // a removed row blurs with no related target, which keeps it.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) {
          hadFocus.current = false;
        }
      }}
      role="tree"
      aria-label={t('explorer.tree')}
      className={styles.tree}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        const li = (e.target as HTMLElement).closest('li[data-path]');
        const path = li?.getAttribute('data-path');
        if (path && onRequestMenu) {
          e.preventDefault();
          setFocused(path);
          onRequestMenu(path, { x: e.clientX, y: e.clientY });
        }
      }}
    >
      {rows.map(({ node, level }) => (
        <TreeRow
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
          onActivate={activate}
          onFocusRow={setFocused}
          onCommitRename={commitRename}
          onCancelRename={cancelRename}
          onMenu={
            onRequestMenu
              ? (path, anchor) => {
                  setFocused(path);
                  onRequestMenu(path, anchor);
                }
              : undefined
          }
        />
      ))}
    </ul>
  );
}
