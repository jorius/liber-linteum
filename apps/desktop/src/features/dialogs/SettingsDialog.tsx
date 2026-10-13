import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import type { Theme } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';

const THEMES: Theme[] = ['system', 'light', 'dark'];
const themeKey = { system: 'themeSystem', light: 'themeLight', dark: 'themeDark' } as const;

/** Language, theme and file-operation settings; every change is saved at once. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  return (
    <Dialog title={t('settings.title')} onClose={onClose}>
      <label className={styles.field}>
        <span>{t('settings.language')}</span>
        <select
          className={styles.select}
          value={settings.language ?? 'system'}
          onChange={(e) => void update({ language: e.target.value })}
        >
          <option value="system">{t('settings.languageSystem')}</option>
          {SUPPORTED_LANGUAGES.map((lng) => (
            <option key={lng} value={lng} lang={lng}>
              {t(`languages.${lng}`)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className={styles.fieldset}>
        <legend>{t('settings.theme')}</legend>
        {THEMES.map((theme) => (
          <label key={theme} className={styles.check}>
            <input
              type="radio"
              name="theme"
              value={theme}
              checked={settings.theme === theme}
              onChange={() => void update({ theme })}
            />
            {t(`settings.${themeKey[theme]}`)}
          </label>
        ))}
      </fieldset>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={settings.rewriteLinks}
          onChange={(e) => void update({ rewriteLinks: e.target.checked })}
        />
        {t('settings.rewriteLinks')}
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={settings.confirmDelete}
          onChange={(e) => void update({ confirmDelete: e.target.checked })}
        />
        {t('settings.confirmDelete')}
      </label>
      <div className={styles.buttons}>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onClose}>
          {t('dialogs.close')}
        </button>
      </div>
    </Dialog>
  );
}
