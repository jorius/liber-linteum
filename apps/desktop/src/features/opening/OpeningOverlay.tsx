import { useTranslation } from 'react-i18next';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './OpeningOverlay.module.css';

/** Shown while a vault is being opened and indexed (spec §4.1). */
export function OpeningOverlay() {
  const { t } = useTranslation();
  const progress = useVaultStore((s) => s.progress);
  return (
    <div className={styles.backdrop}>
      <div className={styles.panel} role="status" aria-labelledby="opening-title">
        <h2 id="opening-title" className={styles.title}>
          {t('opening.title')}
        </h2>
        <progress
          className={styles.bar}
          max={progress?.total || 1}
          value={progress?.done ?? 0}
          aria-labelledby="opening-title"
        />
        <p className={styles.detail}>
          {progress
            ? t('opening.progress', { done: progress.done, total: progress.total })
            : t('opening.preparing')}
        </p>
      </div>
    </div>
  );
}
