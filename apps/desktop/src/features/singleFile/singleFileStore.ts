// A single-file window (M4c §3): one Markdown, text or code file opened on
// its own, outside any vault. The editor store edits it as it edits a page;
// the IPC layer sends the page commands to the window's own file.
import { create } from 'zustand';
import { confirmUnsaved, needsUnsavedPrompt } from '../editor/unsavedPrompt';
import {
  destroyWindow,
  fileInfo,
  fileOpenInVault,
  fileRename,
  onFileChanged,
  setFileWindow,
  type CommandError,
  type FileInfo,
  type IpcResult,
} from '../../ipc';
import { QUIT_FLUSH_MS, useEditorStore, warnUnsaved } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';

interface SingleFileState {
  info: FileInfo | null;
  /** Why the window has no file to show. */
  error: CommandError | null;
  /** Deleted or moved outside with nothing unsaved: there is nothing to edit. */
  gone: boolean;
  /** Being handed to the main window: the editor takes no more input, so
   *  nothing typed after the last save is left behind (M4c review m4). */
  handingOff: boolean;
  load: () => Promise<void>;
  /** Renames the file in its folder (same extension); the editor follows. */
  rename: (to: string) => Promise<IpcResult<string>>;
  /** The file changed on disk, or is gone. */
  changed: (removed: boolean) => Promise<void>;
  /** Saves, hands the page to its vault in the main window, and closes. */
  openInVault: () => Promise<void>;
}

const IDLE = { info: null, error: null, gone: false, handingOff: false };

/** Test helper. */
export function resetSingleFileStore() {
  setFileWindow(null);
  useSingleFileStore.setState(IDLE);
}

export const useSingleFileStore = create<SingleFileState>((set, get) => ({
  ...IDLE,
  load: async () => {
    const res = await fileInfo();
    if (!res.ok) {
      set({ error: res.error });
      return;
    }
    setFileWindow(res.value.name);
    set({ info: res.value, error: null, gone: false });
    await useEditorStore.getState().open(res.value.name);
  },
  rename: async (to) => {
    const info = get().info;
    if (!info) return { ok: false, error: { kind: 'notFound', message: 'no file' } };
    const res = await fileRename(to);
    if (res.ok && res.value !== info.name) {
      // The name first: a save the move schedules goes to the new name.
      setFileWindow(res.value);
      set({ info: { ...info, name: res.value } });
      useEditorStore.getState().follow(info.name, res.value);
    }
    return res;
  },
  changed: async (removed) => {
    const name = get().info?.name;
    if (!name) return;
    const editor = useEditorStore.getState();
    await editor.onExternalChange(
      { created: [], modified: removed ? [] : [name], removed: removed ? [name] : [], renamed: [] },
      () => false,
    );
    if (removed) {
      // Unsaved text is kept (the editor shows "Save again"); otherwise
      // there's nothing left to show.
      if (!useEditorStore.getState().doc) set({ gone: true });
    } else if (!useEditorStore.getState().doc) {
      // Back (restored, written again): open it again.
      set({ gone: false });
      await useEditorStore.getState().open(name);
    }
  },
  openInVault: async () => {
    // Auto save off (M5b §6): Save / Don't Save / Cancel first.
    if (needsUnsavedPrompt() && !(await confirmUnsaved())) return;
    set({ handingOff: true });
    const unsaved = await useEditorStore.getState().saveAll(QUIT_FLUSH_MS);
    if (unsaved.length) {
      set({ handingOff: false });
      warnUnsaved(unsaved[0], 'editor.unsavedBlocks');
      return;
    }
    const res = await fileOpenInVault();
    if (!res.ok) {
      set({ handingOff: false });
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      return;
    }
    // One editor per file: this window goes once the main window has it.
    await destroyWindow();
  },
}));

/** Follows the file on disk (the window's watcher); returns the unsubscribe. */
export function installFileWatch(): Promise<() => void> {
  return onFileChanged(({ removed }) => void useSingleFileStore.getState().changed(removed));
}
