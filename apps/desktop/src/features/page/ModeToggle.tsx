import { useTranslation } from 'react-i18next';
import { CodeIcon, ColumnsIcon, PenIcon } from '../../app/icons';
import type { EditorMode } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import styles from './PageView.module.css';

const MODES: EditorMode[] = ['livePreview', 'source', 'split'];
const ICONS = { livePreview: PenIcon, source: CodeIcon, split: ColumnsIcon } as const;

/** Live Preview · Source · Split (segmented control of native radios, each
 *  with an icon, M4b §2); the choice is saved as the `editorMode` setting. */
export function ModeToggle({ mode }: { mode: EditorMode }) {
  const { t } = useTranslation();
  return (
    <fieldset className={styles.modes}>
      <legend className={styles.srOnly}>{t('editor.mode')}</legend>
      {MODES.map((m) => {
        const Icon = ICONS[m];
        return (
          <label key={m} className={m === mode ? styles.modeOn : styles.mode}>
            <input
              type="radio"
              name="editor-mode"
              value={m}
              checked={m === mode}
              onChange={() => void useSettingsStore.getState().update({ editorMode: m })}
            />
            <Icon />
            {t(`editor.modes.${m}`)}
          </label>
        );
      })}
    </fieldset>
  );
}
