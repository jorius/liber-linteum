import { useTranslation } from 'react-i18next';
import { CloseIcon, GearIcon, GraphIcon, PencilIcon } from '../../app/icons';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './Shell.module.css';

/** Vault name, the [Edit · Global view] toggle (Global view arrives in M3),
 * settings and close. */
export function TopBar() {
  const { t } = useTranslation();
  const name = useVaultStore((s) => s.info?.name ?? '');
  const close = useVaultStore((s) => s.close);
  const openDialog = useUiStore((s) => s.openDialog);
  return (
    <header className={styles.topbar}>
      <span className={styles.vaultName}>{name}</span>
      <div className={styles.toggle} role="group" aria-label={t('shell.view')}>
        <button type="button" className={`${styles.tg} ${styles.on}`} aria-pressed="true">
          <PencilIcon />
          {t('shell.edit')}
        </button>
        <button
          type="button"
          className={styles.tg}
          aria-pressed="false"
          aria-disabled="true"
          aria-describedby="global-later"
          title={t('shell.globalLater')}
        >
          <GraphIcon />
          {t('shell.globalView')}
        </button>
        <span id="global-later" className={styles.srOnly}>
          {t('shell.globalLater')}
        </span>
      </div>
      <div className={styles.tright}>
        <button
          type="button"
          className={styles.iconButtonLight}
          aria-label={t('shell.settings')}
          title={t('shell.settings')}
          onClick={() => openDialog({ type: 'settings' })}
        >
          <GearIcon />
        </button>
        <button
          type="button"
          className={styles.iconButtonLight}
          aria-label={t('shell.closeVault')}
          title={t('shell.closeVault')}
          onClick={() => void close()}
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  );
}
