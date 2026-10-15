// The Format bar's Attach button (M4b part 3 §7): Rust opens the OS file
// dialog; files already in the vault are linked at once, the others wait for
// the "Copy or link" choice the editor showing that view puts up.
import type { EditorView } from '@codemirror/view';
import { filePick, type PickedFile } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { attachPaths } from './attachments';
import { pagePath } from './livePreview';

const choosers = new WeakMap<EditorView, (files: PickedFile[]) => void>();

export function setAttachChooser(
  view: EditorView,
  choose: ((files: PickedFile[]) => void) | null,
): void {
  if (choose) choosers.set(view, choose);
  else choosers.delete(view);
}

/** Opens the dialog for the page in `view`; `true` (the button's command
 *  never runs on its own). */
export function openAttach(view: EditorView): boolean {
  void pickFor(view);
  return true;
}

async function pickFor(view: EditorView): Promise<void> {
  const res = await filePick(view.state.facet(pagePath)());
  if (!res.ok) {
    useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    view.focus();
    return;
  }
  const inside = res.value.filter((f) => f.inVault !== null);
  const outside = res.value.filter((f) => f.inVault === null);
  if (inside.length)
    attachPaths(
      view,
      inside.map((f) => f.path),
    );
  const choose = choosers.get(view);
  if (outside.length && choose) choose(outside);
  else {
    if (outside.length)
      attachPaths(
        view,
        outside.map((f) => f.path),
      );
    view.focus();
  }
}
