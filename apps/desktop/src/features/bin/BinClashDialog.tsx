import { useTranslation } from 'react-i18next';
import { Dialog } from '../dialogs/Dialog';
import dialogStyles from '../dialogs/Dialogs.module.css';
import { restoreItem } from './binActions';
import { binLabel } from './BinView';

/** Something new is where a restored or unarchived item was: keep both
 *  (the restored one numbered), or cancel (M5b §5.2). */
export function BinClashDialog({
  kind,
  path,
  onClose,
}: {
  kind: 'trash' | 'archive';
  path: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const keepBoth = () => {
    onClose();
    void restoreItem(kind, path, true);
  };
  return (
    <Dialog
      title={t('bin.clashTitle', { name: binLabel(path) })}
      onClose={onClose}
      onConfirm={keepBoth}
    >
      <p className={dialogStyles.text}>{t('bin.clashBody')}</p>
      <div className={dialogStyles.buttons}>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={keepBoth}>
          {t('bin.keepBoth')}
        </button>
      </div>
    </Dialog>
  );
}
