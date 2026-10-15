// Quick notes take their first line's name while you type (M4c §2, §7.15):
// about 2 s after the last keystroke, or at once when the editor loses
// focus or another page opens. Rust reads the saved file and decides; this
// only says when to ask, one question at a time.
import { quickNoteAutoname } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { useVaultStore } from '../../stores/vaultStore';
import { AUTOSAVE_MS } from '../editor/pageDoc';
import { useScratchpadStore } from './scratchpadStore';

/** Quiet time after the last keystroke before the note is renamed. */
export const AUTO_NAME_IDLE_MS = 2000;

/** Starts watching the open page; returns the stop. */
export function installAutoName(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;

  const flagged = (path: string | null): path is string =>
    path !== null && useScratchpadStore.getState().autoNamed.has(path);
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const run = async (path: string) => {
    cancel();
    if (!flagged(path)) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await useEditorStore.getState().flushAll();
      const res = await quickNoteAutoname(path);
      if (!res.ok) return; // the name simply stays
      const { path: to, autoNamed, outcome } = res.value;
      const store = useScratchpadStore.getState();
      if (!autoNamed) store.drop(path);
      else if (to !== path && outcome) {
        store.moved(path, to);
        await useVaultStore.getState().applyRename(path, to, outcome, { quiet: true });
      }
    } finally {
      running = false;
      if (again) {
        again = false;
        // The note may have moved meanwhile: ask about the page on screen.
        const current = useEditorStore.getState().path;
        if (current) void run(current);
      }
    }
  };

  const unsubscribe = useEditorStore.subscribe((s, prev) => {
    if (s.path !== prev.path) {
      // Another page: the one left is named now if it was waiting.
      if (timer && prev.path) void run(prev.path);
      cancel();
      return;
    }
    if (!flagged(s.path)) return;
    if (s.dirty && !prev.dirty) {
      cancel(); // typing
    } else if (!s.dirty && prev.dirty) {
      // Saved: the save waited AUTOSAVE_MS after the last keystroke.
      const path = s.path;
      cancel();
      timer = setTimeout(() => void run(path), AUTO_NAME_IDLE_MS - AUTOSAVE_MS);
    }
  });

  const onFocusOut = (e: FocusEvent) => {
    const editor = (e.target as Element | null)?.closest?.('.cm-editor');
    if (!editor || (e.relatedTarget instanceof Node && editor.contains(e.relatedTarget))) return;
    const { path, dirty } = useEditorStore.getState();
    if (flagged(path) && (timer || dirty)) void run(path);
  };
  document.addEventListener('focusout', onFocusOut);

  return () => {
    cancel();
    unsubscribe();
    document.removeEventListener('focusout', onFocusOut);
  };
}
