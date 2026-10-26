import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TreeNode } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { useVaultStore } from '../../stores/vaultStore';
import explorer from '../explorer/Explorer.module.css';
import { displayName, Icon, useShowExtensions } from '../explorer/TreeRow';
import favorites from '../favorites/Favorites.module.css';
import { ItemIcon } from '../icons/ItemIcon';
import { openFromList, shownOpen, useOpenStore } from './openStore';
import styles from './Open.module.css';

/** The Open list (0.1.2), at the top of the sidebar: the pages and files open
 *  for editing; a click goes back to one as it was left, × (a middle click,
 *  or Delete on its name) closes it. Folds like Favorites; nothing while
 *  empty. */
export function OpenSection() {
  const { t } = useTranslation();
  const headingId = useId();
  const nodes = useVaultStore((s) => s.nodes);
  const paths = useOpenStore((s) => s.paths);
  const shown = shownOpen(paths, nodes);
  const [collapsed, setCollapsed] = useState(false);
  if (shown.length === 0) return null;
  return (
    <section className={favorites.section} aria-labelledby={headingId} data-open-list>
      <div className={styles.head}>
        <h2 className={favorites.heading} id={headingId}>
          <button
            type="button"
            className={favorites.toggle}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <svg
              className={collapsed ? favorites.chevron : `${favorites.chevron} ${favorites.open}`}
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
            {t('open.title')}
          </button>
        </h2>
        <button
          type="button"
          className={styles.closeAll}
          onClick={() => void useOpenStore.getState().closeAll()}
        >
          {t('open.closeAll')}
        </button>
      </div>
      {!collapsed && (
        <ul className={favorites.list} aria-labelledby={headingId}>
          {shown.map((node) => (
            <OpenRow key={node.path} node={node} />
          ))}
        </ul>
      )}
    </section>
  );
}

function OpenRow({ node }: { node: TreeNode }) {
  const { t } = useTranslation();
  const name = displayName(node, useShowExtensions());
  const current = usePageStore((s) => s.path === node.path);
  const unsaved = useEditorStore((s) => s.path === node.path && s.dirty);
  const close = () => void useOpenStore.getState().close(node.path);
  return (
    <li data-open={node.path}>
      <div
        className={current ? `${explorer.row} ${explorer.selected}` : explorer.row}
        style={{ paddingLeft: 8 }}
        onAuxClick={(e) => {
          if (e.button === 1) close();
        }}
      >
        {node.icon ? <ItemIcon icon={node.icon} /> : <Icon node={node} expanded={false} />}
        <button
          type="button"
          className={favorites.name}
          aria-current={current ? 'page' : undefined}
          aria-keyshortcuts="Delete"
          onClick={() => void openFromList(node.path)}
          onKeyDown={(e) => {
            if (e.key === 'Delete') close();
          }}
        >
          {name}
        </button>
        {unsaved && <span className={styles.dot} role="img" aria-label={t('open.unsaved')} />}
        <span className={explorer.actions}>
          <button
            type="button"
            tabIndex={-1}
            className={explorer.action}
            aria-label={t('open.closeNamed', { name })}
            title={t('open.close')}
            onClick={close}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      </div>
    </li>
  );
}
