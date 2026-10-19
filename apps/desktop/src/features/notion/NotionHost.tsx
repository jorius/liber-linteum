import { useEffect } from 'react';
import { onMenuNotionImport } from '../../ipc';
import { useUiStore } from '../../stores/uiStore';
import { quietly } from '../scratchpad/ScratchpadHost';
import { NotionImportDialog } from './NotionImportDialog';

/** Opens the Notion import (M7 §3). */
export function openNotionImport() {
  // Another dialog keeps the screen, as for the other menu items.
  if (!useUiStore.getState().dialog) useUiStore.getState().openDialog({ type: 'notionImport' });
}

/** File → Import from Notion… and its dialog, on every screen (the Welcome
 *  screen included). Mounted once, beside the Welcome screen and the shell. */
export function NotionHost() {
  const dialog = useUiStore((s) => s.dialog);
  const close = useUiStore((s) => s.closeDialog);

  useEffect(() => {
    let stop: (() => unknown) | null = null;
    let gone = false;
    void onMenuNotionImport(openNotionImport)
      .then((un) => (gone ? quietly(un) : (stop = un)))
      .catch(() => undefined); // no Tauri event runtime (plain browser)
    return () => {
      gone = true;
      if (stop) quietly(stop);
    };
  }, []);

  if (dialog?.type !== 'notionImport') return null;
  return <NotionImportDialog onClose={close} />;
}
