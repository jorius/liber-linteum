// Go to line: Ctrl+G on every platform (⌘G is find next on macOS, so Ctrl+G
// there too, as in VS Code), the cursor position button beside the word
// count, and Edit → Go to Line… in the macOS menu. A small field at the top
// of the editor, drawn like find in page's (findInPage.ts): `42`, `42:7`
// (line:column, from 1, as the cursor position shows them), `+5` / `-5`
// (lines from the cursor's). Lines are the file's, frontmatter included,
// as the line-number gutter counts them.
import { EditorSelection, type Text } from '@codemirror/state';
import { EditorView, getDialog, showDialog } from '@codemirror/view';
import i18next from 'i18next';
import { isTauri, onMenuGoToLine } from '../../ipc';
import { findableView } from './findInPage';

const TARGET = /^\s*([+-])?(\d+)?(?::(\d+))?\s*$/;

/** Where `input` points, as a document offset, from the cursor at `head`;
 *  `null` when it isn't a line (or `:column`) at all. Lines and columns past
 *  the end land on the last one. */
export function lineTarget(input: string, doc: Text, head: number): number | null {
  const m = TARGET.exec(input);
  if (!m || (!m[2] && !m[3])) return null;
  const [, sign, ln, cl] = m;
  const current = doc.lineAt(head).number;
  let number = current;
  if (ln) number = sign ? current + (sign === '-' ? -1 : 1) * Number(ln) : Number(ln);
  else if (sign) return null;
  const line = doc.line(Math.max(1, Math.min(doc.lines, number)));
  const col = cl ? Math.max(1, Number(cl)) : 1;
  return line.from + Math.min(col - 1, line.length);
}

const CLASS = 'cm-liber-goto';

/** The field, its Go button and the "Line 12 of 340" hint; Enter goes,
 *  Escape (or ×) closes and gives the text back the keyboard. A target that
 *  isn't a line keeps the field open, marked invalid. */
function goToContent(view: EditorView, close: () => void): HTMLElement {
  const t = i18next.t.bind(i18next);
  const { doc, selection } = view.state;
  const current = doc.lineAt(selection.main.head).number;
  const box = document.createElement('div');
  const label = document.createElement('label');
  label.append(`${t('goToLine.label')} `);
  const input = document.createElement('input');
  input.type = 'text';
  input.name = 'line';
  input.className = 'cm-textfield';
  input.value = String(current);
  input.placeholder = t('goToLine.placeholder');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const hint = document.createElement('span');
  hint.className = 'cm-liber-goto-hint';
  hint.id = `cm-liber-goto-hint-${Math.random().toString(36).slice(2)}`;
  hint.textContent = t('goToLine.hint', { line: current, lines: doc.lines });
  input.setAttribute('aria-describedby', hint.id);
  label.append(input);
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'cm-button';
  go.textContent = t('goToLine.go');
  const submit = () => {
    const at = lineTarget(input.value, view.state.doc, view.state.selection.main.head);
    if (at === null) {
      input.setAttribute('aria-invalid', 'true');
      hint.textContent = t('goToLine.invalid');
      input.select();
      return;
    }
    close();
    view.dispatch({
      selection: EditorSelection.cursor(at),
      effects: EditorView.scrollIntoView(at, { y: 'center' }),
      userEvent: 'select',
    });
    view.focus();
  };
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  go.addEventListener('click', submit);
  box.append(label, go, hint);
  return box;
}

/** Opens Go to line in `view` (again: its field takes the keyboard). */
export function goToLine(view: EditorView): boolean {
  const open = getDialog(view, CLASS);
  if (open) {
    open.dom.querySelector<HTMLInputElement>('input')?.select();
    return true;
  }
  showDialog(view, { class: CLASS, top: true, focus: 'input', content: goToContent });
  return true;
}

/** Go to line in the page on screen; `false` when there is none. */
export function openGoToLine(): boolean {
  const view = findableView();
  return view ? goToLine(view) : false;
}

/** Ctrl+G, on every platform (⌘G stays find next on macOS); the physical key
 *  on layouts without a Latin G. */
export function isGoToLineKey(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  const key = e.key.toLowerCase();
  return key === 'g' || (!/^[a-z]$/.test(key) && e.code === 'KeyG');
}

/** Edit → Go to Line… (macOS app menu, Ctrl+G): the focused window's page. */
export function installGoToLineMenuIfTauri(): void {
  if (!isTauri()) return;
  void onMenuGoToLine(() => void openGoToLine()).catch(() => undefined);
}
