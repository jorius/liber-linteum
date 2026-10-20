import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderIcon } from '../../app/icons';
import type { TreeNode } from '../../ipc';
import { childrenByParent, folderPageOf, nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { dropEntry, planDrop } from '../explorer/drop';
import { displayName, Icon } from '../explorer/TreeRow';
import { ItemIcon } from '../icons/ItemIcon';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';

interface Row {
  path: string;
  node?: TreeNode;
  icon?: string;
  level: number;
  hasChildren: boolean;
}

/** The Archive, the Trash and anything else hidden: not move targets. */
const hidden = (path: string) => path.split('/').some((s) => s.startsWith('.'));

/** `''` and every folder above `path` (not `path` itself). */
function ancestors(path: string): string[] {
  const out = [''];
  for (let p = parentOf(path); p; p = parentOf(p)) out.push(p);
  return out;
}

/** Keyboard-friendly alternative to drag-and-drop (spec §3.4): the vault's
 *  folders as a tree to pick from, filtered by typing (round 3 §3.2). */
export function MoveToDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useTranslation();
  const nodes = useVaultStore((s) => s.nodes);
  const node = nodes.find((n) => n.path === path);
  const current = parentOf(path);
  const [open, setOpen] = useState(() => new Set([...ancestors(current), current]));
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState('');
  const treeRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  // Its item vanished (deleted or renamed outside the app): close instead of
  // lingering invisibly with global shortcuts disabled (final review, upgraded M3).
  useEffect(() => {
    if (!node) onClose();
  }, [node, onClose]);

  if (!node) return null;

  // Folders it can go into or past, and pages it can go under (round 3 §9.3):
  // not hidden, not itself or inside itself. A folder page is its folder's row.
  const all = childrenByParent(nodes);
  const children = childrenByParent(
    nodes.filter(
      (n) =>
        (n.kind === 'folder' ||
          (n.kind === 'page' && folderPageOf(parentOf(n.path), all) !== n.path)) &&
        !hidden(n.path) &&
        n.path !== path &&
        !n.path.startsWith(`${path}/`),
    ),
  );
  const label = (p: string) => nameOf(p).replace(/\.md$/i, '');
  const q = query.trim().toLowerCase();
  const keep = new Set<string>();
  if (q) {
    for (const list of children.values()) {
      for (const f of list) {
        if (label(f.path).toLowerCase().includes(q)) {
          keep.add(f.path);
          for (const a of ancestors(f.path)) keep.add(a);
        }
      }
    }
  }
  const rows: Row[] = [];
  const walk = (parent: string, level: number) => {
    for (const f of children.get(parent) ?? []) {
      if (q && !keep.has(f.path)) continue;
      rows.push({ path: f.path, node: f, icon: f.icon, level, hasChildren: children.has(f.path) });
      if (q || open.has(f.path)) walk(f.path, level + 1);
    }
  };
  const rootShown = !q || keep.size > 0;
  if (rootShown) {
    rows.push({ path: '', level: 1, hasChildren: children.has('') });
    if (q || open.has('')) walk('', 2);
  }

  // Only what's on screen counts: a pick or a tab stop the filter hid is dropped.
  const picked = rows.some((r) => r.path === selected) ? selected : null;
  const stop = rows.some((r) => r.path === active) ? active : rows[0]?.path;

  const canMove = (target: string) => planDrop(path, target) !== null;
  const move = async (target: string | null) => {
    if (target === null || !canMove(target)) return;
    onClose();
    await dropEntry(path, target);
  };
  const isOpen = (r: Row) => r.hasChildren && (!!q || open.has(r.path));
  const toggle = (p: string, to: boolean) =>
    setOpen((s) => {
      const next = new Set(s);
      if (to) next.add(p);
      else next.delete(p);
      return next;
    });
  const focusRow = (p: string) => {
    setActive(p);
    treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`)?.focus();
  };

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex((r) => r.path === stop);
    const r = rows[i];
    if (!r) return;
    const go = (j: number) => rows[j] && focusRow(rows[j].path);
    switch (e.key) {
      case 'ArrowDown':
        go(i + 1);
        break;
      case 'ArrowUp':
        go(i - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(rows.length - 1);
        break;
      case 'ArrowRight':
        if (r.hasChildren && !isOpen(r)) toggle(r.path, true);
        else if (isOpen(r)) go(i + 1);
        break;
      case 'ArrowLeft':
        if (isOpen(r) && !q) toggle(r.path, false);
        else if (r.level > 1) focusRow(parentOf(r.path));
        break;
      case 'Enter':
        void move(r.path);
        break;
      case ' ':
        if (canMove(r.path)) setSelected(r.path);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <Dialog title={t('dialogs.move.title', { name: displayName(node) })} onClose={onClose}>
      <span className={styles.field} id={labelId}>
        {t('dialogs.move.to')}
      </span>
      <input
        type="search"
        className="field-control"
        aria-label={t('dialogs.move.filter')}
        placeholder={t('dialogs.move.filter')}
        value={query}
        data-autofocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || rows.length === 0) return;
          e.preventDefault();
          focusRow(rows[0].path);
        }}
      />
      <div
        ref={treeRef}
        role="tree"
        aria-labelledby={labelId}
        className={styles.moveTree}
        onKeyDown={onTreeKey}
      >
        {rows.map((r) => {
          const ok = canMove(r.path);
          const expanded = isOpen(r);
          return (
            <div
              key={r.path || 'root'}
              role="treeitem"
              data-path={r.path}
              aria-level={r.level}
              aria-expanded={r.hasChildren ? expanded : undefined}
              aria-selected={selected === r.path}
              aria-disabled={ok ? undefined : true}
              tabIndex={stop === r.path ? 0 : -1}
              className={styles.moveRow}
              style={{ '--level': r.level - 1 } as CSSProperties}
              onClick={() => {
                setActive(r.path);
                if (ok) setSelected(r.path);
              }}
              onDoubleClick={() => void move(r.path)}
            >
              <span
                className={styles.moveChevron}
                aria-hidden="true"
                data-open={expanded || undefined}
                onClick={(e) => {
                  if (!r.hasChildren || q) return;
                  e.stopPropagation();
                  toggle(r.path, !expanded);
                }}
              >
                {r.hasChildren && (
                  <svg
                    viewBox="0 0 24 24"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                )}
              </span>
              {r.icon ? (
                <ItemIcon icon={r.icon} />
              ) : r.node?.kind === 'page' ? (
                <Icon node={r.node} expanded={false} />
              ) : (
                <FolderIcon />
              )}
              <span className={styles.moveName}>
                {r.path ? label(r.path) : t('dialogs.move.root')}
              </span>
              {r.path === current && (
                <span className={styles.moveCurrent}>{t('dialogs.move.current')}</span>
              )}
            </div>
          );
        })}
      </div>
      {rows.length === 0 && <p className={styles.hint}>{t('dialogs.move.none')}</p>}
      <div className={styles.buttons}>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={picked === null}
          onClick={() => void move(picked)}
        >
          {t('dialogs.move.confirm')}
        </button>
      </div>
    </Dialog>
  );
}
