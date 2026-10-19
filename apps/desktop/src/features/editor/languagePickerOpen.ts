// A code block's language badge opens the language picker of the editor that
// shows it (M4b part 2 §2); the widget only knows the view.
import type { EditorView } from '@codemirror/view';

type Open = (at: number, anchor: HTMLElement) => void;
const openers = new WeakMap<EditorView, Open>();

export function setLanguagePickerOpener(view: EditorView, open: Open | null): void {
  if (open) openers.set(view, open);
  else openers.delete(view);
}

/** Opens the picker for the fence at `at`; `false` when there is no host. */
export function openLanguagePicker(view: EditorView, at: number, anchor: HTMLElement): boolean {
  const open = openers.get(view);
  if (!open) return false;
  open(at, anchor);
  return true;
}
