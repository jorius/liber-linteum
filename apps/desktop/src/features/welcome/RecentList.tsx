import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderIcon } from '../../app/icons';
import { vaultsForget, vaultsRecent, type RecentVault } from '../../ipc';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './Welcome.module.css';

/** Recently opened vaults (most recent first). Missing folders (e.g. an
 * unmounted drive) are shown but can't be opened; any entry can be removed. */
export function RecentList() {
  const { t } = useTranslation();
  const open = useVaultStore((s) => s.open);
  const [items, setItems] = useState<RecentVault[] | null>(null);

  const reload = useCallback(async () => {
    const res = await vaultsRecent();
    setItems(res.ok ? res.value : []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const forget = async (path: string) => {
    await vaultsForget(path);
    await reload();
  };

  return (
    <section className={styles.recent} aria-labelledby="welcome-recent">
      <h2 className={styles.label} id="welcome-recent">
        {t('welcome.recent')}
      </h2>
      {items && items.length > 0 ? (
        <ul className={styles.recentList} aria-labelledby="welcome-recent">
          {items.map((item) => (
            <li key={item.path} className={styles.recentItem}>
              <button
                type="button"
                className={styles.recentOpen}
                disabled={item.missing}
                onClick={() => void open(item.path)}
              >
                <FolderIcon />
                <span className={styles.recentText}>
                  <span className={styles.recentName}>{item.name}</span>
                  <span className={styles.recentPath}>{item.path}</span>
                  {item.missing && <span className={styles.missing}>{t('welcome.missing')}</span>}
                </span>
              </button>
              <button
                type="button"
                className={styles.forget}
                aria-label={t('welcome.forget', { name: item.name })}
                onClick={() => void forget(item.path)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>{t('welcome.noRecent')}</p>
      )}
    </section>
  );
}
