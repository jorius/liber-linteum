import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { fileWindowName, scratchpadChoose, scratchpadSet } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import dialogs from '../dialogs/Dialogs.module.css';
import styles from './Scratchpad.module.css';

/** Settings → Files: where the global Scratchpad lives (M4c §2). Change…
 *  points to another folder, picked in a dialog Rust opens; notes already
 *  taken stay where they are. */
export function ScratchpadLocation() {
  const { t } = useTranslation();
  const path = useSettingsStore((s) => s.settings.scratchpadPath ?? null);
  const labelId = useId();
  // A single-file window may not choose folders (final review M7).
  if (fileWindowName() !== null) return null;

  const change = async () => {
    const picked = await scratchpadChoose();
    if (!picked.ok || !picked.value) return;
    const res = await scratchpadSet(picked.value);
    if (!res.ok) {
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      return;
    }
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...res.value } });
  };

  return (
    <div className={styles.place} role="group" aria-labelledby={labelId}>
      <span className={styles.placeLabel} id={labelId}>
        {t('scratchpad.location')}
      </span>
      {path ? (
        <code className={styles.path}>{path}</code>
      ) : (
        <span className={`${dialogs.hint} ${styles.unset}`}>{t('scratchpad.notYet')}</span>
      )}
      <button type="button" className="btn btn-secondary" onClick={() => void change()}>
        {t(path ? 'scratchpad.change' : 'scratchpad.choose')}
      </button>
    </div>
  );
}
