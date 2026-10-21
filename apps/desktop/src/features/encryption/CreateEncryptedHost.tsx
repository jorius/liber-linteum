import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import { CreateEncryptedDialog } from './CreateEncryptedDialog';
import { NewRecoveryDialog } from './SecuritySettings';
import { useState } from 'react';

/** Opens the create dialog for the folder just picked; another dialog keeps the screen. */
export function openCreateEncrypted(path: string) {
  if (!useUiStore.getState().dialog)
    useUiStore.getState().openDialog({ type: 'createEncrypted', path });
}

/** The voided-key prompt: no way out but a new recovery key. */
function RecoveryVoidDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [making, setMaking] = useState(false);
  const done = () => {
    // The vault now has a working key: it is no longer void.
    useVaultStore.setState((s) => ({ info: s.info && { ...s.info, recoveryVoid: false } }));
    onClose();
  };
  if (making) return <NewRecoveryDialog onClose={() => setMaking(false)} onDone={done} />;
  return (
    <Dialog title={t('encryption.security.voidTitle')} onClose={() => undefined} alert>
      <p className={dialogs.text}>{t('encryption.security.voidBody')}</p>
      <div className={dialogs.buttons}>
        <button
          type="button"
          className="btn btn-primary"
          data-autofocus
          onClick={() => setMaking(true)}
        >
          {t('encryption.security.voidAction')}
        </button>
      </div>
    </Dialog>
  );
}

/** The dialogs, on every screen: the create dialog stays mounted when Welcome
 *  gives way to the shell, so the recovery code isn't lost with the screen. */
export function CreateEncryptedHost() {
  const dialog = useUiStore((s) => s.dialog);
  const close = useUiStore((s) => s.closeDialog);
  if (dialog?.type === 'recoveryVoid') return <RecoveryVoidDialog onClose={close} />;
  if (dialog?.type !== 'createEncrypted') return null;
  return <CreateEncryptedDialog path={dialog.path} onClose={close} />;
}
