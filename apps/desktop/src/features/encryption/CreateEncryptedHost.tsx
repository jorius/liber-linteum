import { useUiStore } from '../../stores/uiStore';
import { CreateEncryptedDialog } from './CreateEncryptedDialog';

/** Opens the create dialog for the folder just picked; another dialog keeps the screen. */
export function openCreateEncrypted(path: string) {
  if (!useUiStore.getState().dialog)
    useUiStore.getState().openDialog({ type: 'createEncrypted', path });
}

/** The dialog, on every screen: it stays mounted when Welcome gives way to
 *  the shell, so the recovery code isn't lost with the screen. */
export function CreateEncryptedHost() {
  const dialog = useUiStore((s) => s.dialog);
  const close = useUiStore((s) => s.closeDialog);
  if (dialog?.type !== 'createEncrypted') return null;
  return <CreateEncryptedDialog path={dialog.path} onClose={close} />;
}
