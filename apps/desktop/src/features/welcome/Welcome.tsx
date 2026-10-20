import { useEffect, type ReactNode } from 'react';
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
import { keyLabel } from '../dialogs/shortcuts';
import { openFileDialog } from '../singleFile/openFile';
import { SUPPORTED_LANGUAGES, type Language } from '../../i18n';
import { pickFolder } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { openNotionImport } from '../notion/NotionHost';
import { newQuickNote } from '../scratchpad/quickNote';
import { QuickNoteIcon } from '../scratchpad/QuickNoteIcon';
import { RecentList } from './RecentList';
import styles from './Welcome.module.css';

const MAC = /Mac/i.test(navigator.platform);

/** ⌘N / ⌘O here (Ctrl elsewhere). On macOS only ⌘: Ctrl+N and Ctrl+O edit
 *  text in a field. A held key doesn't repeat the picker. */
export function welcomeShortcut(e: KeyboardEvent, mac = MAC): 'n' | 'o' | null {
  if (e.repeat || !(mac ? e.metaKey : e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) {
    return null;
  }
  const key = e.key.toLowerCase();
  return key === 'n' || key === 'o' ? key : null;
}

/** Native folder picker → open or create (VLT-01). A cancelled picker does nothing. */
async function pickThen(action: (path: string) => Promise<unknown>) {
  const path = await pickFolder().catch(() => null);
  if (path) await action(path);
}

/** One of the three ways to start, with its shortcut (`Mod+N` style). */
function StartButton(props: {
  icon: ReactNode;
  label: string;
  keys: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={props.primary ? `${styles.button} ${styles.primary}` : styles.button}
      aria-keyshortcuts={props.keys.replace('Mod', MAC ? 'Meta' : 'Control')}
      onClick={props.onClick}
    >
      {props.icon}
      {props.label}
      <kbd className={styles.kbd} aria-hidden="true">
        {keyLabel(props.keys, MAC)}
      </kbd>
    </button>
  );
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

  // R3 §7: ⌘N and ⌘O work here too (the shell's shortcuts aren't mounted
  // yet); ⌘⇧N is ScratchpadHost's everywhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = welcomeShortcut(e);
      if (!key) return;
      if (useUiStore.getState().dialog || useVaultStore.getState().status === 'opening') return;
      e.preventDefault();
      void pickThen(key === 'n' ? create : open);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [create, open]);

  const chooseLanguage = async (lng: Language) => {
    // Switch immediately; persist when running inside the app.
    await i18n.changeLanguage(lng);
    void updateSettings({ language: lng });
  };

  return (
    <main className={styles.page} inert={opening}>
      <div className={styles.start}>
        <div className={styles.brand}>
          <BrandMark size={36} />
          <div>
            <h1 className={styles.title}>{t('app.name')}</h1>
            {version && <span className={styles.version}>{t('app.version', { version })}</span>}
          </div>
        </div>
        <p className={styles.tagline}>{t('app.tagline')}</p>

        <div className={styles.actions}>
          <StartButton
            primary
            icon={<PlusIcon />}
            label={t('welcome.create')}
            keys="Mod+N"
            onClick={() => void pickThen(create)}
          />
          <StartButton
            icon={<FolderIcon />}
            label={t('welcome.open')}
            keys="Mod+O"
            onClick={() => void pickThen(open)}
          />
          <StartButton
            icon={<QuickNoteIcon />}
            label={t('welcome.quickNote')}
            keys="Mod+Shift+N"
            onClick={() => void newQuickNote()}
          />
        </div>

        <div className={styles.more} role="group" aria-labelledby="welcome-more">
          <h2 className={styles.label} id="welcome-more">
            {t('welcome.moreWays')}
          </h2>
          <button type="button" className={styles.link} onClick={() => void pickThen(open)}>
            <VaultIcon />
            {t('welcome.openObsidian')}
          </button>
          {/* M4c §3: one file on its own, in a window of its own. */}
          <button type="button" className={styles.link} onClick={() => void openFileDialog()}>
            <NewPageIcon />
            {t('welcome.openFile')}
          </button>
          <button type="button" className={styles.link} onClick={openNotionImport}>
            <ImportIcon />
            {t('welcome.importNotion')}
          </button>
        </div>

        <div className={styles.foot}>
          <div className={styles.segmented} role="group" aria-label={t('welcome.language')}>
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
          <p className={styles.footer}>
            <LockIcon />
            {t('privacy.localOnly')}
          </p>
        </div>
      </div>

      <div className={styles.recentPane}>
        <RecentList />
        {/* React Flow's canvas badge is hidden; it is credited here (M3a §9). */}
        <p className={styles.credits}>{t('app.credits')}</p>
      </div>
    </main>
  );
}
