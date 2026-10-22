import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../dialogs/Dialog';
import dialogStyles from '../dialogs/Dialogs.module.css';
import { useShowExtensions } from '../explorer/TreeRow';
import { binLabel } from './BinView';

/** Something new is where a restored or unarchived item was: keep both
 *  (the restored one numbered), or cancel (M5b §5.2). The answer goes back
 *  to the restore waiting on it (round-2 review I2), exactly once. */
export function BinClashDialog({
  path,
  answer,
  onClose,
}: {
  path: string;
  answer: (keepBoth: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const extensions = useShowExtensions();
  const answered = useRef(false);
  const reply = (keep: boolean) => {
    if (!answered.current) {
      answered.current = true;
      answer(keep);
    }
    onClose();
  };
  // Closed some other way (the vault closed): the restore stops waiting.
  useEffect(
    () => () => {
      if (!answered.current) answer(false);
    },
    [answer],
  );
  const keepBoth = () => reply(true);
  const cancel = () => reply(false);
  return (
    <Dialog
      title={t('bin.clashTitle', { name: binLabel(path, extensions) })}
      onClose={cancel}
      onConfirm={keepBoth}
    >
      <p className={dialogStyles.text}>{t('bin.clashBody')}</p>
      <div className={dialogStyles.buttons}>
        <button type="button" className="btn btn-secondary" onClick={cancel}>
          {t('dialogs.cancel')}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={keepBoth}>
          {t('bin.keepBoth')}
        </button>
      </div>
    </Dialog>
  );
}
