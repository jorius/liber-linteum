import { useTranslation } from 'react-i18next';
import { CloseIcon, GearIcon, GraphIcon, PencilIcon, SearchIcon } from '../../app/icons';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useGvStore } from '../global-view/gvStore';
import { levelLabel } from '../global-view/Toolbar';
import { PageHeading } from '../page/PageHeading';
import styles from './Shell.module.css';

/** "Global view · <level>" while the Global View shows (M4b §1). */
function GvHeading() {
  const { t } = useTranslation();
  const level = useGvStore((s) => s.stack[s.stack.length - 1]);
  const titles = useGvStore((s) => s.titles);
  return (
    <h1 className={styles.screenTitle}>
      {level ? `${t('shell.globalView')} · ` : t('shell.globalView')}
      {level && <span className={styles.screenLevel}>{levelLabel(level, titles, t)}</span>}
    </h1>
  );
}

/** The search shortcut as this platform writes it. */
const SEARCH_KEYS = /Mac/i.test(navigator.platform) ? '⌘⇧F' : 'Ctrl+Shift+F';

/** The page's title and subtitle (or the Global View's level), the [Edit ·
 *  Global view] switch (M3a §2), search (M5 §4), settings and close. The vault's name is in
 *  the sidebar (M4b §1). */
export function TopBar() {
  const { t } = useTranslation();
  const close = useVaultStore((s) => s.close);
  const openDialog = useUiStore((s) => s.openDialog);
  const current = useUiStore((s) => s.screen);
  const setScreen = useUiStore((s) => s.setScreen);
  return (
    <header className={styles.topbar}>
      <div className={styles.heading}>{current === 'global' ? <GvHeading /> : <PageHeading />}</div>
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
          className={styles.searchButton}
          aria-keyshortcuts="Meta+Shift+F Control+Shift+F"
          onClick={() => openDialog({ type: 'search' })}
        >
          <SearchIcon />
          {t('search.button')}
          <kbd className={styles.kbd} aria-hidden="true">
            {SEARCH_KEYS}
          </kbd>
        </button>
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
