import { useTranslation } from 'react-i18next';
import { restoreItem } from './binActions';
import styles from './Bin.module.css';

/** An archived page, reached through a link (M5b §5.3). */
export function ArchivedBanner({ path }: { path: string | null }) {
  const { t } = useTranslation();
  if (!path?.startsWith('.archive/')) return null;
  return (
    <div className={styles.banner}>
      <p role="status">{t('bin.archivedPage')}</p>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => void restoreItem('archive', path)}
      >
        {t('bin.unarchive')}
      </button>
    </div>
  );
}
