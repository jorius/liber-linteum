import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import { CreateEncryptedDialog } from './CreateEncryptedDialog';
import { NewRecoveryDialog } from './SecuritySettings';

/** Dialogs waiting for an answer or running an import: never replaced. */
const BUSY = new Set(['unsaved', 'binClash', 'notionImport', 'scratchpadSetup']);

/** Opens the create dialog for the folder just picked (refused while a
 *  sticky dialog shows, or one that is waiting for an answer). */
export function openCreateEncrypted(path: string) {
  if (BUSY.has(useUiStore.getState().dialog?.type ?? '')) return;
  useUiStore.getState().openDialog({ type: 'createEncrypted', path });
}

/** The voided-key prompt: no way out but a new recovery key. */
function RecoveryVoidDialog({ root }: { root: string }) {
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
          onClick={() =>
            useUiStore.setState({ dialog: { type: 'newRecovery', root, fromVoid: true } })
          }
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
  const openRoot = useVaultStore((s) => (s.status === 'open' ? s.info?.root : null));
  const close = useUiStore((s) => s.closeDialog);
  // Its only action needs its own vault unlocked (leaving parks it, vaultStore).
  if (dialog?.type === 'recoveryVoid')
    return openRoot === dialog.root ? <RecoveryVoidDialog root={dialog.root} /> : null;
  if (dialog?.type === 'newRecovery') {
    const done = () => {
      // The vault now has a working key: it is no longer void.
      useVaultStore.setState((s) => ({ info: s.info && { ...s.info, recoveryVoid: false } }));
      close();
    };
    const back = dialog.fromVoid
      ? () => useUiStore.setState({ dialog: { type: 'recoveryVoid', root: dialog.root } })
      : close;
    return <NewRecoveryDialog onClose={back} onDone={done} />;
  }
  if (dialog?.type !== 'createEncrypted') return null;
  return <CreateEncryptedDialog path={dialog.path} onClose={close} />;
}
