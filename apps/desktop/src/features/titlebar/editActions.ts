// Edit → Undo, Redo, Cut, Copy, Paste, Select All from the drawn menu bar
// (custom title bar §3.3). macOS routes these through its Edit menu; here the
// menu acts on what had the keyboard when it opened.
import { EditorView } from '@codemirror/view';
import { windowPaste } from '../../ipc';
import type { LocalAction } from './menus';

export type EditAction = Extract<
  LocalAction,
  'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'
>;

/** The CodeMirror editor holding `el`, if any. */
function editorOf(el: Element | null): EditorView | null {
  const dom = el?.closest<HTMLElement>('.cm-editor');
  return dom ? EditorView.findFromDOM(dom) : null;
}

/** The keys the editor answers for each action (its own keymaps, history and
 *  the page's undo of cover changes included). */
const EDITOR_KEYS: Partial<Record<EditAction, KeyboardEventInit>> = {
  undo: { key: 'z', code: 'KeyZ', ctrlKey: true },
  // Ctrl+Y: CodeMirror's redo on Linux and Windows alike.
  redo: { key: 'y', code: 'KeyY', ctrlKey: true },
  selectAll: { key: 'a', code: 'KeyA', ctrlKey: true },
};

/** Inserts `text` where the caret is, as typing it would. */
function insert(view: EditorView | null, text: string) {
  if (view) view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste' });
  else document.execCommand('insertText', false, text);
}

/** Runs `action` on `target` (the focused element before the menu opened). */
export async function runEdit(action: EditAction, target: Element | null): Promise<void> {
  if (target instanceof HTMLElement && document.activeElement !== target) target.focus();
  const view = editorOf(target);
  const keys = EDITOR_KEYS[action];
  if (view && keys) {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { ...keys, bubbles: true, cancelable: true }),
    );
    return;
  }
  if (action !== 'paste') {
    document.execCommand(action === 'selectAll' ? 'selectAll' : action);
    return;
  }
  // Linux: WebKitGTK's own Paste. Elsewhere, the clipboard API.
  if ((await windowPaste()).ok) return;
  const text = await navigator.clipboard?.readText().catch(() => null);
  if (text) insert(view, text);
}
