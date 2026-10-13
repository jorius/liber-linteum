import { useTranslation } from 'react-i18next';
import type { EditorMode } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import styles from './PageView.module.css';

const MODES: EditorMode[] = ['livePreview', 'source', 'split'];

/** Live Preview · Source · Split (segmented control of native radios); the
 *  choice is saved as the `editorMode` setting. */
export function ModeToggle({ mode }: { mode: EditorMode }) {
  const { t } = useTranslation();
  return (
    <fieldset className={styles.modes}>
      <legend className={styles.srOnly}>{t('editor.mode')}</legend>
      {MODES.map((m) => (
        <label key={m} className={m === mode ? styles.modeOn : styles.mode}>
          <input
            type="radio"
            name="editor-mode"
            value={m}
            checked={m === mode}
            onChange={() => void useSettingsStore.getState().update({ editorMode: m })}
          />
          {t(`editor.modes.${m}`)}
        </label>
      ))}
    </fieldset>
  );
}
