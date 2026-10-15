// Jump and flash (M4b part 3 §6): an atom clicked in the Global View opens
// its page with the cursor on the block, scrolled into view, its lines
// tinted for a second so the eye finds it.
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

export const FLASH_MS = 1000;

const setFlash = StateEffect.define<{ from: number; to: number } | null>();

function linesOf(state: EditorState, from: number, to: number): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const mark = Decoration.line({ class: 'cm-nimw-flash' });
  for (let pos = from; pos <= to;) {
    const line = state.doc.lineAt(pos);
    deco.push(mark.range(line.from));
    if (line.to >= to) break;
    pos = line.to + 1;
  }
  return Decoration.set(deco);
}

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash))
        next = e.value ? linesOf(tr.state, e.value.from, e.value.to) : Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The editor extension: the flash's decorations and their tint. */
export const flash = [
  field,
  EditorView.baseTheme({
    '.cm-nimw-flash': {
      backgroundColor: 'var(--color-accent-soft)',
      transition: 'background-color 0.3s',
    },
  }),
];

/** Cursor on `from`, scrolled to the middle, `from`–`to` flashing for
 *  FLASH_MS. Offsets beyond a text that changed since are clamped. */
export function jumpTo(view: EditorView, from: number, to: number): void {
  const len = view.state.doc.length;
  const a = Math.max(0, Math.min(from, len));
  const b = Math.max(a, Math.min(to, len));
  view.dispatch({
    selection: { anchor: a },
    effects: [EditorView.scrollIntoView(a, { y: 'center' }), setFlash.of({ from: a, to: b })],
  });
  setTimeout(() => {
    // Gone (another page, the view closed): nothing to clear.
    if (!view.dom.isConnected || !view.state.field(field, false)) return;
    view.dispatch({ effects: setFlash.of(null) });
  }, FLASH_MS);
}
