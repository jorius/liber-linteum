import { useTranslation } from 'react-i18next';
import { ArchiveIcon, TrashIcon } from '../../app/icons';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { ExplorerTree, type ExplorerTreeProps } from '../explorer/ExplorerTree';
import { useBinStore } from './binStore';
import styles from './Bin.module.css';

const ARCHIVE = '.archive';

/** The sidebar's foot (M5b §5.2–§5.3): Archived above Trash, nothing else.
 *  Archived opens like a folder, read-only (round 2); Trash opens its view. */
export function SidebarFoot({ onRequestDelete, onRequestMenu }: ExplorerTreeProps) {
  const { t } = useTranslation();
  const screen = useUiStore((s) => s.screen);
  const archived = useBinStore((s) => s.archive.length);
  const trash = useBinStore((s) => s.trash.length);
  const open = useVaultStore((s) => s.expanded.has(ARCHIVE));
  const hasItems = useVaultStore((s) => (s.children.get(ARCHIVE)?.length ?? 0) > 0);
  return (
    <div className={styles.foot}>
      <button
        type="button"
        className={styles.footRow}
        aria-expanded={open}
        aria-label={t('bin.archivedCount', { count: archived })}
        onClick={() => useVaultStore.getState().toggle(ARCHIVE)}
      >
        <ArchiveIcon />
        <span className={styles.footName}>{t('bin.archived')}</span>
        {archived > 0 && <span className={styles.footCount}>{archived}</span>}
      </button>
      {open && hasItems && (
        <div className={styles.archiveTree}>
          <ExplorerTree
            root={ARCHIVE}
            onRequestDelete={onRequestDelete}
            onRequestMenu={onRequestMenu}
          />
        </div>
      )}
      <button
        type="button"
        className={styles.footRow}
        aria-current={screen === 'trash' ? 'page' : undefined}
        aria-label={t('bin.trashCount', { count: trash })}
        onClick={() => useUiStore.getState().setScreen('trash')}
      >
        <TrashIcon />
        <span className={styles.footName}>{t('bin.trash')}</span>
        {trash > 0 && <span className={styles.footCount}>{trash}</span>}
      </button>
    </div>
  );
}
