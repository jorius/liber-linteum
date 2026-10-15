import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { scratchpadChoose, scratchpadDefault, scratchpadSet } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import { takeQuickNote } from './quickNote';
import styles from './Scratchpad.module.css';

/** "Where should quick notes live?" (M4c §2): the default folder, or one
 *  picked in a dialog Rust opens; Create makes it the global Scratchpad and,
 *  when a quick note asked, takes it. */
export function ScratchpadSetupDialog({
  then,
  onClose,
}: {
  then: 'quickNote' | 'none';
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const placeId = useId();

  useEffect(() => {
    void scratchpadDefault().then((res) => {
      if (res.ok) setPath((p) => p ?? res.value);
    });
  }, []);

  const choose = async () => {
    const res = await scratchpadChoose();
    if (res.ok && res.value) setPath(res.value);
  };

  const create = async () => {
    if (!path || busy) return;
    setBusy(true);
    const res = await scratchpadSet(path);
    setBusy(false);
    if (!res.ok) {
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      return;
    }
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...res.value } });
    onClose();
    if (then === 'quickNote') await takeQuickNote();
  };

  return (
    <Dialog title={t('scratchpad.setupTitle')} onClose={onClose} onConfirm={() => void create()}>
      <p className={dialogs.text}>{t('scratchpad.setupBody')}</p>
      <div className={styles.place}>
        <span className={styles.placeLabel} id={placeId}>
          {t('scratchpad.folder')}
        </span>
        <code className={styles.path} aria-labelledby={placeId}>
          {path ?? '…'}
        </code>
        <button type="button" className="btn btn-secondary" onClick={() => void choose()}>
          {t('scratchpad.chooseFolder')}
        </button>
      </div>
      <p className={dialogs.hint}>{t('scratchpad.setupHint')}</p>
      <div className={dialogs.buttons}>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-autofocus
          aria-disabled={!path || busy}
          onClick={() => void create()}
        >
          {t('scratchpad.create')}
        </button>
      </div>
    </Dialog>
  );
}
