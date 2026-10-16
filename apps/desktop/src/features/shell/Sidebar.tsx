import { useTranslation } from 'react-i18next';
import { NewFolderIcon, NewPageIcon, SidebarIcon } from '../../app/icons';
import { dirFor } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { SidebarFoot } from '../bin/SidebarFoot';
import { ExplorerDnd } from '../explorer/ExplorerDnd';
import type { ExplorerTreeProps } from '../explorer/ExplorerTree';
import { IconButton } from '../icons/ItemIcon';
import { toggleSidebar } from './shellMenu';
import { VaultMenu } from './VaultMenu';
import styles from './Shell.module.css';

/** Left column: the vault's icon and menu, explorer actions, the tree, and
 *  the foot (Archived, Trash and the privacy line, M5b §5). */
export function Sidebar(treeProps: ExplorerTreeProps) {
  const { t } = useTranslation();
  const name = useVaultStore((s) => s.info?.name ?? '');
  const icon = useVaultStore((s) => s.info?.icon);
  const create = (kind: 'page' | 'folder') => {
    const { nodes, selected, createPage, createFolder } = useVaultStore.getState();
    const dir = dirFor(nodes, selected);
    void (kind === 'page' ? createPage(dir) : createFolder(dir));
  };
  return (
    <aside className={styles.side} aria-label={t('shell.files', { name })}>
      {/* The vault, not the app (M4b §1): no app mark beside it (M5b §2.4). Its
          optional emoji is its own button, so it never opens the vault menu. */}
      <div className={styles.brandRow}>
        <IconButton
          target={{ kind: 'vault' }}
          icon={icon}
          name={name}
          className={styles.vaultIcon}
        />
        <VaultMenu name={name} />
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('shell.hideSidebar')}
          data-sidebar-toggle
          aria-keyshortcuts="Meta+\ Control+\"
          title={t('shell.hideSidebar')}
          onClick={toggleSidebar}
        >
          <SidebarIcon />
        </button>
      </div>
      <div className={styles.sideHeader}>
        <span className={styles.sideLabel}>{t('shell.files', { name })}</span>
        <span className={styles.sideActions}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('shell.newPage')}
            title={t('shell.newPage')}
            onClick={() => create('page')}
          >
            <NewPageIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('shell.newFolder')}
            title={t('shell.newFolder')}
            onClick={() => create('folder')}
          >
            <NewFolderIcon />
          </button>
        </span>
      </div>
      <nav className={styles.treeScroll}>
        <ExplorerDnd {...treeProps} />
      </nav>
      <SidebarFoot />
    </aside>
  );
}
