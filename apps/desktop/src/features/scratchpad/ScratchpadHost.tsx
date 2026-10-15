import { useEffect } from 'react';
import { onMenuQuickNote } from '../../ipc';
import { useUiStore } from '../../stores/uiStore';
import { newQuickNote } from './quickNote';
import { ScratchpadSetupDialog } from './ScratchpadSetupDialog';
import { installScratchpadSync } from './scratchpadStore';

/** Unsubscribes without ever throwing (the event runtime may be gone). */
function quietly(un: () => unknown) {
  try {
    void Promise.resolve(un()).catch(() => undefined);
  } catch {
    // already gone
  }
}

/** ⌘⇧N (Ctrl+Shift+N): every screen, the Welcome screen included. */
function isQuickNoteKey(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n';
}

/** Quick notes on every screen (M4c §2): ⌘⇧N, File → New Quick Note, the
 *  first-use dialog, and the store kept in step with the open vault.
 *  Mounted once, beside the Welcome screen and the app shell. */
export function ScratchpadHost() {
  const dialog = useUiStore((s) => s.dialog);
  const close = useUiStore((s) => s.closeDialog);

  useEffect(() => installScratchpadSync(), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isQuickNoteKey(e)) return;
      e.preventDefault();
      // Holding the keys must not make a note per repeat; another dialog
      // keeps the keyboard (as for the other shortcuts).
      if (e.repeat || useUiStore.getState().dialog) return;
      void newQuickNote();
    };
    window.addEventListener('keydown', onKeyDown);
    let stop: (() => unknown) | null = null;
    let gone = false;
    void onMenuQuickNote(() => void newQuickNote())
      .then((un) => (gone ? quietly(un) : (stop = un)))
      .catch(() => undefined); // no Tauri event runtime (plain browser)
    return () => {
      gone = true;
      window.removeEventListener('keydown', onKeyDown);
      if (stop) quietly(stop);
    };
  }, []);

  if (dialog?.type !== 'scratchpadSetup') return null;
  return <ScratchpadSetupDialog then={dialog.then} onClose={close} />;
}
