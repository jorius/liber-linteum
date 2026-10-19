// Save / Don't Save / Cancel (M5b §6): with auto save off, unsaved text is
// never left silently — not by opening another page, closing the vault or
// closing the window.
import { useEditorStore, warnUnsaved } from '../../stores/editorStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore, type UnsavedChoice } from '../../stores/uiStore';

let asked = 0;

/** Whether leaving now must ask first (synchronous, so callers that don't
 *  need to ask stay synchronous). */
export function needsUnsavedPrompt(): boolean {
  return (
    useSettingsStore.getState().settings.autoSave === false &&
    useEditorStore.getState().askPaths().length > 0
  );
}

/** Asks, then saves or drops the unsaved pages; `false` means stay (Cancel,
 *  or a save that failed). */
export async function confirmUnsaved(): Promise<boolean> {
  if (!needsUnsavedPrompt()) return true;
  const paths = useEditorStore.getState().askPaths();
  const choice = await new Promise<UnsavedChoice>((answer) =>
    useUiStore.getState().openDialog({ type: 'unsaved', id: ++asked, paths, answer }),
  );
  if (choice === 'cancel') return false;
  if (choice === 'discard') {
    useEditorStore.getState().discardAll();
    return true;
  }
  // An orphaned page can't be saved here; its banner offers "Save as new page".
  const left = (await useEditorStore.getState().saveAll()).filter((p) =>
    useEditorStore.getState().askPaths().includes(p),
  );
  if (left.length) warnUnsaved(left[0], 'editor.unsavedBlocks');
  return left.length === 0;
}
