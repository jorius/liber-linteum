// Auto-close brackets and quotes (Settings → Editor, on by default):
// CodeMirror's closeBrackets for `(`, `[`, `{`, `"` and backticks — typing
// the closer steps over it, Backspace between an empty pair removes both —
// but never `'`, an apostrophe in English and Spanish prose. With a
// selection, those and `'`, `*`, `_`, `=`, `~` wrap it, the selection staying
// on the text so a second press makes `**bold**`, `==mark==` or `~~strike~~`.
// `[[` makes one `]]`, which the link autocomplete steps over (linkComplete).
import { closeBrackets, deleteBracketPair } from '@codemirror/autocomplete';
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

/** What closes itself as you type (everywhere: prose, code blocks, text files). */
export const CLOSING = ['(', '[', '{', '"', '`'];

/** What wraps a selection besides `CLOSING` (Markdown's emphasis marks, and
 *  `'` for quoting). */
const WRAP_ONLY = new Set(["'", '*', '_', '=', '~']);

/** Wraps every selected range in `mark` (the selections stay on the text);
 *  `false` when some range is empty, so the mark is typed as usual. */
export function wrapSelection(view: EditorView, mark: string): boolean {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.some((r) => r.empty)) return false;
  view.dispatch(
    state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: mark },
        { from: range.to, insert: mark },
      ],
      range: EditorSelection.range(range.anchor + mark.length, range.head + mark.length),
    })),
    { scrollIntoView: true, userEvent: 'input.type' },
  );
  return true;
}

const wrapMarks = EditorView.inputHandler.of((view, from, to, text) => {
  if (!WRAP_ONLY.has(text) || view.composing) return false;
  const main = view.state.selection.main;
  if (from !== main.from || to !== main.to) return false;
  return wrapSelection(view, text);
});

/** The pairs and wrapping, or nothing (`on` false). */
export function autoClose(on: boolean): Extension {
  if (!on) return [];
  return [
    closeBrackets(),
    // Ahead of the Markdown language's own data, and of a code block's
    // language (JavaScript would pair `'`).
    Prec.highest(EditorState.languageData.of(() => [{ closeBrackets: { brackets: CLOSING } }])),
    Prec.high(wrapMarks),
    // Ahead of Markdown's Backspace (list markers), which an empty pair isn't.
    Prec.highest(keymap.of([{ key: 'Backspace', run: deleteBracketPair }])),
  ];
}

/** Each editor state's pairs, switched by the setting. */
export const autoCloseSlot = new Compartment();
