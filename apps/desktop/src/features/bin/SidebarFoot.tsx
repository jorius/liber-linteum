import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArchiveIcon, LockIcon, TrashIcon } from '../../app/icons';
import { useUiStore } from '../../stores/uiStore';
import { useBinStore } from './binStore';
import styles from './Bin.module.css';

/** The sidebar's foot (M5b §5.2–§5.3): Archived above Trash, each opening
 *  its view, then the privacy line. */
export function SidebarFoot() {
  const { t } = useTranslation();
  const screen = useUiStore((s) => s.screen);
  const counts = {
    archive: useBinStore((s) => s.archive.length),
    trash: useBinStore((s) => s.trash.length),
  };
  const row = (kind: 'archive' | 'trash', icon: ReactNode) => (
    <button
      type="button"
      className={styles.footRow}
      aria-current={screen === kind ? 'page' : undefined}
      aria-label={t(kind === 'trash' ? 'bin.trashCount' : 'bin.archivedCount', {
        count: counts[kind],
      })}
      onClick={() => useUiStore.getState().setScreen(kind)}
    >
      {icon}
      <span className={styles.footName}>{t(kind === 'trash' ? 'bin.trash' : 'bin.archived')}</span>
      {counts[kind] > 0 && <span className={styles.footCount}>{counts[kind]}</span>}
    </button>
  );
  return (
    <div className={styles.foot}>
      {row('archive', <ArchiveIcon />)}
      {row('trash', <TrashIcon />)}
      <p className={styles.privacy}>
        <LockIcon />
        {t('privacy.localOnly')}
      </p>
    </div>
  );
}
