// Quick notes take their first line's name while you type (M4c §2, §7.15):
// about 2 s after the last keystroke, or at once when the editor loses
// focus or another page opens. Rust reads the saved file and decides; this
// only says when to ask, one question at a time.
import { quickNoteAutoname } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { useSettingsStore } from '../../stores/settingsStore';
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
  // A rename the user has open (title or explorer) wins: renaming under
  // it would reset what they type (final review I3).
  const isTitle = (el: unknown) =>
    el instanceof Element && el.closest('[data-page-title]') !== null;
  const renameOpen = () =>
    useVaultStore.getState().renaming !== null || isTitle(document.activeElement);
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const run = async (path: string) => {
    cancel();
    if (!flagged(path) || renameOpen()) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      // Auto save off (M5b §6): the name waits for ⌘S, nothing is written for it.
      if (useSettingsStore.getState().settings.autoSave === false) {
        if (useEditorStore.getState().dirtyPaths().includes(path)) return;
      } else await useEditorStore.getState().flushAll();
      const res = await quickNoteAutoname(path);
      if (!res.ok) return; // the name simply stays
      const { path: to, autoNamed, outcome } = res.value;
      const store = useScratchpadStore.getState();
      if (!autoNamed) store.drop(path);
      else if (to !== path && outcome) {
        store.moved(path, to);
        // Quiet only when no other note was touched (final review I1).
        const quiet = outcome.updatedFiles.every((f) => f === to);
        await useVaultStore.getState().applyRename(path, to, outcome, { quiet });
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
      // Another page: the one left is named now if it was waiting, or was
      // still unsaved (run saves it first; final review M1).
      if (flagged(prev.path) && (timer || prev.dirty)) void run(prev.path);
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
    if (isTitle(e.relatedTarget)) return; // naming it by hand
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
