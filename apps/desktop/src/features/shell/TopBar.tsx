import { useTranslation } from 'react-i18next';
import { CloseIcon, GearIcon, GraphIcon, PencilIcon } from '../../app/icons';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './Shell.module.css';

/** Vault name, the [Edit · Global view] switch (M3a §2), settings and close. */
export function TopBar() {
  const { t } = useTranslation();
  const name = useVaultStore((s) => s.info?.name ?? '');
  const close = useVaultStore((s) => s.close);
  const openDialog = useUiStore((s) => s.openDialog);
  const current = useUiStore((s) => s.screen);
  const setScreen = useUiStore((s) => s.setScreen);
  return (
    <header className={styles.topbar}>
      <span className={styles.vaultName}>{name}</span>
      <div className={styles.toggle} role="group" aria-label={t('shell.view')}>
        <button
          type="button"
          className={`${styles.tg} ${current === 'edit' ? styles.on : ''}`}
          aria-pressed={current === 'edit'}
          aria-keyshortcuts="Meta+1 Control+1"
          onClick={() => setScreen('edit')}
        >
          <PencilIcon />
          {t('shell.edit')}
        </button>
        <button
          type="button"
          className={`${styles.tg} ${current === 'global' ? styles.on : ''}`}
          aria-pressed={current === 'global'}
          aria-keyshortcuts="Meta+2 Control+2"
          onClick={() => setScreen('global')}
        >
          <GraphIcon />
          {t('shell.globalView')}
        </button>
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
