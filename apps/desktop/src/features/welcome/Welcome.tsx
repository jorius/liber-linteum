import { useTranslation } from 'react-i18next';
import {
  BrandMark,
  FolderIcon,
  ImportIcon,
  LockIcon,
  NewPageIcon,
  PlusIcon,
  VaultIcon,
} from '../../app/icons';
import { openFileDialog } from '../singleFile/openFile';
import { SUPPORTED_LANGUAGES, type Language } from '../../i18n';
import { pickFolder } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVaultStore } from '../../stores/vaultStore';
import { openNotionImport } from '../notion/NotionHost';
import { newQuickNote } from '../scratchpad/quickNote';
import { QuickNoteIcon } from '../scratchpad/QuickNoteIcon';
import { RecentList } from './RecentList';
import styles from './Welcome.module.css';

/** Native folder picker → open or create (VLT-01). A cancelled picker does nothing. */
async function pickThen(action: (path: string) => Promise<unknown>) {
  const path = await pickFolder().catch(() => null);
  if (path) await action(path);
}

export interface WelcomeProps {
  version: string | null;
}

export function Welcome({ version }: WelcomeProps) {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage;
  const open = useVaultStore((s) => s.open);
  const create = useVaultStore((s) => s.create);
  // Behind the opening overlay nothing is reachable (M1b §10 b).
  const opening = useVaultStore((s) => s.status === 'opening');
  const updateSettings = useSettingsStore((s) => s.update);

  const chooseLanguage = async (lng: Language) => {
    // Switch immediately; persist when running inside the app.
    await i18n.changeLanguage(lng);
    void updateSettings({ language: lng });
  };

  return (
    <main className={styles.page} inert={opening}>
      <div className={styles.card}>
        <div className={styles.header}>
          <BrandMark />
          {version && <span className={styles.version}>{t('app.version', { version })}</span>}
        </div>
        <h1 className={styles.title}>{t('app.name')}</h1>
        <p className={styles.tagline}>{t('app.tagline')}</p>

        <div className={styles.row}>
          <span className={styles.label} id="welcome-language">
            {t('welcome.language')}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby="welcome-language">
            {SUPPORTED_LANGUAGES.map((lng) => (
              <button
                key={lng}
                type="button"
                lang={lng}
                aria-pressed={current === lng}
                onClick={() => void chooseLanguage(lng)}
              >
                {t(`languages.${lng}`)}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => void newQuickNote()}>
            <QuickNoteIcon />
            {t('welcome.quickNote')}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            onClick={() => void pickThen(create)}
          >
            <PlusIcon />
            {t('welcome.create')}
          </button>
          <button type="button" className={styles.button} onClick={() => void pickThen(open)}>
            <FolderIcon />
            {t('welcome.open')}
          </button>
          <button type="button" className={styles.button} onClick={() => void pickThen(open)}>
            <VaultIcon />
            {t('welcome.openObsidian')}
          </button>
          {/* M4c §3: one file on its own, in a window of its own. */}
          <button type="button" className={styles.button} onClick={() => void openFileDialog()}>
            <NewPageIcon />
            {t('singleFile.openFile')}
          </button>
          <button type="button" className={styles.button} onClick={openNotionImport}>
            <ImportIcon />
            {t('welcome.importNotion')}
          </button>
        </div>

        <RecentList />

        <p className={styles.footer}>
          <LockIcon />
          {t('privacy.localOnly')}
        </p>
        {/* React Flow's canvas badge is hidden; it is credited here (M3a §9). */}
        <p className={styles.credits}>{t('app.credits')}</p>
      </div>
    </main>
  );
}
