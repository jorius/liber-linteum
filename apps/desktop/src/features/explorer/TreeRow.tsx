import { forwardRef, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TreeNode } from '../../ipc';
import styles from './Explorer.module.css';
import { validateName } from './nameRules';

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
}

function Icon({ node, expanded }: { node: TreeNode; expanded: boolean }) {
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
  const errorId = `rename-error-${node.path}`;

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
  },
  ref,
) {
  const name = displayName(node);
  const classes = [styles.row, selected ? styles.selected : '', dropTarget ? styles.drop : '']
    .filter(Boolean)
    .join(' ');
  return (
    <li
      ref={ref}
      role="treeitem"
      aria-label={name}
      aria-level={level}
      aria-selected={selected}
      aria-expanded={node.kind === 'folder' ? expanded : undefined}
      tabIndex={focused ? 0 : -1}
      data-path={node.path}
      data-name={name}
      className={classes}
      style={{ paddingLeft: 8 + (level - 1) * 16 }}
      onClick={() => onActivate(node)}
      onFocus={() => onFocusRow(node.path)}
    >
      <Icon node={node} expanded={expanded} />
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
    </li>
  );
});
