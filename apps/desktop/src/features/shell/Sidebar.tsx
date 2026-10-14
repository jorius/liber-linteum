import { useTranslation } from 'react-i18next';
import { BrandMark, LockIcon, NewFolderIcon, NewPageIcon } from '../../app/icons';
import { dirFor } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { ExplorerDnd } from '../explorer/ExplorerDnd';
import type { ExplorerTreeProps } from '../explorer/ExplorerTree';
import styles from './Shell.module.css';

/** Left column: brand, explorer actions, the tree and the privacy footer. */
export function Sidebar(treeProps: ExplorerTreeProps) {
  const { t } = useTranslation();
  const name = useVaultStore((s) => s.info?.name ?? '');
  const create = (kind: 'page' | 'folder') => {
    const { nodes, selected, createPage, createFolder } = useVaultStore.getState();
    const dir = dirFor(nodes, selected);
    void (kind === 'page' ? createPage(dir) : createFolder(dir));
  };
  return (
    <aside className={styles.side} aria-label={t('shell.files', { name })}>
      {/* The vault, not the app (M4b §1): the app's name is in the window
          title, the About panel and the welcome screen. */}
      <div className={styles.brand} title={name}>
        <BrandMark size={26} />
        <span className={styles.brandName}>{name}</span>
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
      <p className={styles.sideFoot}>
        <LockIcon />
        {t('privacy.localOnly')}
      </p>
    </aside>
  );
}
