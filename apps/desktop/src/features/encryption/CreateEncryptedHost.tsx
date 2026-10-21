import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import { CreateEncryptedDialog } from './CreateEncryptedDialog';
import { NewRecoveryDialog } from './SecuritySettings';

/** Opens the create dialog for the folder just picked (refused while a
 *  sticky dialog shows). */
export function openCreateEncrypted(path: string) {
  useUiStore.getState().openDialog({ type: 'createEncrypted', path });
}

/** The voided-key prompt: no way out but a new recovery key. */
function RecoveryVoidDialog() {
  const { t } = useTranslation();
  return (
    <Dialog title={t('encryption.security.voidTitle')} onClose={() => undefined} alert>
      <p className={dialogs.text}>{t('encryption.security.voidBody')}</p>
      <div className={dialogs.buttons}>
        <button
          type="button"
          className="btn btn-primary"
          data-autofocus
          // The sticky prompt hands over to its own flow (openDialog would refuse).
          onClick={() => useUiStore.setState({ dialog: { type: 'newRecovery', fromVoid: true } })}
        >
          {t('encryption.security.voidAction')}
        </button>
      </div>
    </Dialog>
  );
}

/** The dialogs, on every screen: the create dialog stays mounted when Welcome
 *  gives way to the shell, and a recovery code stays over the Unlock screen
 *  after a lock, so neither code is lost with the screen. */
export function CreateEncryptedHost() {
  const dialog = useUiStore((s) => s.dialog);
  const open = useVaultStore((s) => s.status === 'open');
  const close = useUiStore((s) => s.closeDialog);
  // Its only action needs an unlocked vault (a lock parks it, vaultStore).
  if (dialog?.type === 'recoveryVoid') return open ? <RecoveryVoidDialog /> : null;
  if (dialog?.type === 'newRecovery') {
    const done = () => {
      // The vault now has a working key: it is no longer void.
      useVaultStore.setState((s) => ({ info: s.info && { ...s.info, recoveryVoid: false } }));
      close();
    };
    const back = dialog.fromVoid
      ? () => useUiStore.setState({ dialog: { type: 'recoveryVoid' } })
      : close;
    return <NewRecoveryDialog onClose={back} onDone={done} />;
  }
  if (dialog?.type !== 'createEncrypted') return null;
  return <CreateEncryptedDialog path={dialog.path} onClose={close} />;
}
