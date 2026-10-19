import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useToastStore } from '../../stores/toastStore';
import { applyMove, modelFor } from './blockCommands';
import { editorKeymap } from './format';

let view: EditorView | null = null;
function editor(doc: string, cursor: number): EditorView {
  view = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [history(), keymap.of(editorKeymap)],
    }),
  });
  return view;
}
const press = (v: EditorView, key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    v.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
const text = (v: EditorView) => v.state.doc.toString();

afterEach(() => {
  view?.destroy();
  view = null;
  useToastStore.getState().clear();
  document.body.innerHTML = '';
});

describe('moving blocks from the editor (M4 §5)', () => {
  it('Alt+↓ on a list item moves it below the next one; one undo puts it back', async () => {
    const v = editor('- a\n  - a1\n- b\n- c\n', 1);
    await press(v, 'ArrowDown', { altKey: true });
    // The item with its nested one: not a line move.
    expect(text(v)).toBe('- b\n- a\n  - a1\n- c\n');
    // The cursor stays in the moved item.
    expect(v.state.doc.lineAt(v.state.selection.main.head).text).toBe('- a');
    undo(v);
    expect(text(v)).toBe('- a\n  - a1\n- b\n- c\n');
  });

  it('Alt+↑ on a heading moves its section; right after typing, undo first takes back only the move', async () => {
    const v = editor('## A\n\na\n\n## B\n\nb\n', 0);
    act(() => v.dispatch({ selection: { anchor: v.state.doc.length } }));
    act(() =>
      v.dispatch({ changes: { from: v.state.doc.length, insert: 'x' }, userEvent: 'input.type' }),
    );
    act(() => v.dispatch({ selection: { anchor: '## A\n\na\n\n## '.length } }));
    await press(v, 'ArrowUp', { altKey: true });
    expect(text(v)).toBe('## B\n\nb\nx\n\n## A\n\na');
    undo(v);
    expect(text(v)).toBe('## A\n\na\n\n## B\n\nb\nx');
  });

  it('Alt+↑ / ↓ moves table rows', async () => {
    const v = editor('| h |\n|---|\n| 1 |\n| 2 |\n', '| h |\n|---|\n| 1'.length);
    await press(v, 'ArrowDown', { altKey: true });
    expect(text(v)).toBe('| h |\n|---|\n| 2 |\n| 1 |\n');
  });

  it('Alt+↑ / ↓ on a table’s header or delimiter row does nothing: those rows aren’t blocks (final review M3)', async () => {
    const doc = 'Intro\n\n| h | i |\n|---|---|\n| 1 | 2 |\n\nEnd\n';
    for (const at of [doc.indexOf('| h'), doc.indexOf('|---') + 2]) {
      for (const key of ['ArrowUp', 'ArrowDown']) {
        const v = editor(doc, at);
        await press(v, key, { altKey: true });
        expect(text(v), `${key} at ${at}`).toBe(doc);
        v.destroy();
      }
    }
    // A selection reaching into the header from a body row: the same.
    const v = editor(doc, 0);
    act(() => v.dispatch({ selection: { anchor: doc.indexOf('|---'), head: doc.indexOf('| 1') } }));
    await press(v, 'ArrowDown', { altKey: true });
    expect(text(v)).toBe(doc);
  });

  it('in a paragraph Alt+↑ stays CodeMirror’s line move', async () => {
    const v = editor('one\ntwo\n', 5);
    await press(v, 'ArrowUp', { altKey: true });
    expect(text(v)).toBe('two\none\n');
  });

  it('a refused move changes nothing and says so', () => {
    const v = editor('- a\n\nPara\n\n- b\n', 0);
    const { model } = modelFor(v.state);
    const para = model.units.find((u) => u.kind === 'paragraph')!;
    expect(applyMove(v, para, { scope: 'top', before: null })).toBe('refused');
    expect(text(v)).toBe('- a\n\nPara\n\n- b\n');
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('This block can’t be moved here.');
  });

  it('the model is reused for an unchanged document', () => {
    const v = editor('P1\n\nP2\n', 0);
    expect(modelFor(v.state)).toBe(modelFor(v.state));
  });
});

describe('a large note (review focus)', () => {
  it('after the first, Alt+↑ in a 200 KB note takes well under 100 ms (the model re-parses incrementally)', async () => {
    let note = '';
    for (let i = 0; note.length < 200_000; i++) {
      note += `## Section ${i}\n\nParagraph ${i} with **bold** and [[link]].\n\n`;
    }
    note += '- a\n- b\n- c\n';
    const v = editor(note, note.length - 2);
    await press(v, 'ArrowUp', { altKey: true }); // the first move parses the note
    const t = performance.now();
    await press(v, 'ArrowUp', { altKey: true });
    expect(performance.now() - t).toBeLessThan(100);
    expect(text(v).endsWith('- c\n- a\n- b\n')).toBe(true);
  }, 30_000);
});
