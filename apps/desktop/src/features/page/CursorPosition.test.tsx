import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from '../editor/Editor';
import { PageDoc } from '../editor/pageDoc';
import { CursorPosition, positionOf } from './CursorPosition';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };

async function load(path: string) {
  const res = await PageDoc.load(path, hooks);
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
}

const viewOf = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
const button = () => document.querySelector<HTMLButtonElement>('[data-cursor-position]');
const select = (view: EditorView, anchor: number, head = anchor) =>
  act(() => view.dispatch({ selection: EditorSelection.single(anchor, head) }));

afterEach(() => clearMocks());

describe('positionOf', () => {
  it('line and column from 1; columns count characters (an emoji is one)', () => {
    const state = EditorState.create({ doc: '---\na: 1\n---\nhé 👩‍💻 x\n' });
    const at = (pos: number) => positionOf(state.update({ selection: { anchor: pos } }).state);
    expect(at(0)).toEqual({ line: 1, col: 1, selected: 0 });
    // Frontmatter lines count: line 4 is the text.
    const line4 = state.doc.line(4);
    expect(at(line4.from + 3)).toMatchObject({ line: 4, col: 4 });
    expect(at(line4.to)).toMatchObject({ line: 4, col: [...'hé 👩‍💻 x'].length + 1 });
  });

  it('every selection’s characters, summed', () => {
    const state = EditorState.create({
      doc: 'one two three',
      extensions: EditorState.allowMultipleSelections.of(true),
      selection: EditorSelection.create(
        [EditorSelection.range(0, 3), EditorSelection.range(4, 7), EditorSelection.cursor(9)],
        1,
      ),
    });
    expect(positionOf(state)).toEqual({ line: 1, col: 8, selected: 6 });
  });
});

describe('the cursor position beside the word count', () => {
  it('hidden until the editor has the keyboard; then follows the cursor and the selection', async () => {
    fakeDisk({ 'A.md': '# A\n\nfirst line\nsecond\n' });
    const doc = await load('A.md');
    render(
      <>
        <CursorPosition />
        <Editor doc={doc} mode="source" label="A" />
      </>,
    );
    expect(button()).toBeNull();
    const view = viewOf();
    act(() => view.focus());
    expect(button()).toHaveTextContent('Ln 1, Col 1');
    select(view, view.state.doc.line(3).from + 6);
    expect(button()).toHaveTextContent('Ln 3, Col 7');
    select(view, view.state.doc.line(3).from, view.state.doc.line(3).from + 5);
    expect(button()).toHaveTextContent('Ln 3, Col 6 · 5 selected');
    // Typing moves it too.
    select(view, view.state.doc.line(4).to);
    act(() =>
      view.dispatch({
        changes: { from: view.state.selection.main.head, insert: '!!' },
        selection: { anchor: view.state.selection.main.head + 2 },
      }),
    );
    expect(button()).toHaveTextContent('Ln 4, Col 9');
  });

  it('isn’t a live region (it would talk on every keystroke); it says what it does', async () => {
    fakeDisk({ 'A.md': 'x\n' });
    const doc = await load('A.md');
    render(
      <>
        <CursorPosition />
        <Editor doc={doc} mode="livePreview" label="A" />
      </>,
    );
    act(() => viewOf().focus());
    const b = screen.getByRole('button', { name: 'Ln 1, Col 1' });
    expect(b).not.toHaveAttribute('aria-live');
    expect(b).not.toHaveAttribute('role');
    expect(b.closest('[aria-live], [role="status"]')).toBeNull();
    expect(b).toHaveAttribute('title', 'Go to line (Ctrl+G)');
    expect(b).toHaveAttribute('aria-keyshortcuts', 'Control+G');
  });

  it('a click opens Go to line on the cursor’s line', async () => {
    fakeDisk({ 'A.md': 'a\nb\nc\n' });
    const doc = await load('A.md');
    render(
      <>
        <CursorPosition />
        <Editor doc={doc} mode="split" label="A" />
      </>,
    );
    const view = viewOf();
    act(() => view.focus());
    select(view, view.state.doc.line(2).from);
    await userEvent.click(button()!);
    const field = document.querySelector<HTMLInputElement>('.cm-liber-goto input');
    expect(field).not.toBeNull();
    expect(field).toHaveValue('2');
  });

  it('another page hides it until that one has the keyboard', async () => {
    fakeDisk({ 'A.md': 'a\n', 'B.md': 'b\n' });
    const a = await load('A.md');
    const b = await load('B.md');
    const { rerender } = render(
      <>
        <CursorPosition />
        <Editor doc={a} mode="source" label="A" />
      </>,
    );
    act(() => viewOf().focus());
    expect(button()).not.toBeNull();
    act(() => viewOf().contentDOM.blur());
    rerender(
      <>
        <CursorPosition />
        <Editor doc={b} mode="source" label="B" />
      </>,
    );
    expect(button()).toBeNull();
    act(() => viewOf().focus());
    expect(button()).toHaveTextContent('Ln 1, Col 1');
  });

  it('in Spanish', async () => {
    await act(() => i18next.changeLanguage('es'));
    fakeDisk({ 'A.md': 'uno dos\n' });
    const doc = await load('A.md');
    render(
      <>
        <CursorPosition />
        <Editor doc={doc} mode="source" label="A" />
      </>,
    );
    const view = viewOf();
    act(() => view.focus());
    expect(button()).toHaveTextContent('Lín 1, col 1');
    select(view, 0, 1);
    expect(button()).toHaveTextContent('Lín 1, col 2 · 1 seleccionado');
    select(view, 0, 7);
    expect(button()).toHaveTextContent('Lín 1, col 8 · 7 seleccionados');
    expect(button()).toHaveAttribute('title', 'Ir a la línea (Ctrl+G)');
  });
});
