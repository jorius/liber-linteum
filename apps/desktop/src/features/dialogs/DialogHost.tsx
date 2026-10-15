import { useUiStore } from '../../stores/uiStore';
import { IndexPickDialog } from '../global-view/IndexPickDialog';
import { RelationsDialog } from '../global-view/RelationsDialog';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { CreatePageDialog, OpenExternalDialog, OpenFileDialog } from './LinkDialogs';
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
    case 'createPage':
      return <CreatePageDialog source={dialog.source} target={dialog.target} onClose={close} />;
    case 'openExternal':
      return <OpenExternalDialog url={dialog.url} onClose={close} />;
    case 'openFile':
      return <OpenFileDialog path={dialog.path} external={dialog.external} onClose={close} />;
    case 'indexPick':
      return (
        <IndexPickDialog
          folder={dialog.folder}
          current={dialog.current}
          only={dialog.only}
          onClose={close}
        />
      );
    case 'relations':
      return <RelationsDialog page={dialog.page} other={dialog.other} onClose={close} />;
  }
}
