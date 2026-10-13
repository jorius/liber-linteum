import { useUiStore } from '../../stores/uiStore';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { MoveToDialog } from './MoveToDialog';
import { SettingsDialog } from './SettingsDialog';

/** Renders the one open dialog (uiStore). */
export function DialogHost() {
  const dialog = useUiStore((s) => s.dialog);
  const close = useUiStore((s) => s.closeDialog);
  if (!dialog) return null;
  switch (dialog.type) {
    case 'delete':
      return <ConfirmDeleteDialog path={dialog.path} onClose={close} />;
    case 'move':
      return <MoveToDialog path={dialog.path} onClose={close} />;
    case 'settings':
      return <SettingsDialog onClose={close} />;
  }
}
