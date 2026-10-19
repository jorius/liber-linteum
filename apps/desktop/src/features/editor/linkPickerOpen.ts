// ⌘K / the Link button open the "Link to…" picker of the editor showing that
// view (M2c §6.3); without one (tests, no React host) they fall back to the
// Markdown `[text](url)` insertion.
import type { EditorView } from '@codemirror/view';

const openers = new WeakMap<EditorView, () => void>();

export function setLinkPickerOpener(view: EditorView, open: (() => void) | null): void {
  if (open) openers.set(view, open);
  else openers.delete(view);
}

/** Opens the picker for `view`; `false` when it has none. */
export function openLinkPicker(view: EditorView): boolean {
  const open = openers.get(view);
  if (!open) return false;
  open();
  return true;
}
