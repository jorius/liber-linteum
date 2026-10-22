import { EditorSelection } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from './Editor';
import { linkQueryAt } from './linkComplete';
import { PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };

async function show(text: string, path = 'A.md') {
  fakeDisk({ [path]: text });
  const res = await PageDoc.load(path, hooks);
  if (!res.ok) throw new Error(res.error.message);
  render(<Editor doc={res.value} mode="source" label="A" />);
  return EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
}

/** Types `text` one character at a time, as the browser's input reaches
 *  CodeMirror: its input handlers first, else a plain insert. */
function type(view: EditorView, text: string) {
  for (const ch of text) {
    act(() => {
      const { from, to } = view.state.selection.main;
      const insert = () =>
        view.state.update({
          changes: { from, to, insert: ch },
          selection: { anchor: from + ch.length },
          userEvent: 'input.type',
        });
      const handled = view.state
        .facet(EditorView.inputHandler)
        .some((h) => h(view, from, to, ch, insert));
      if (!handled) view.dispatch(insert());
    });
  }
}

const backspace = (view: EditorView) =>
  act(() => {
    const e = new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 8 });
    if (!runScopeHandlers(view, e, 'editor')) {
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at - 1, to: at }, userEvent: 'delete.backward' });
    }
  });

const at = (view: EditorView, anchor: number, head = anchor) =>
  act(() => view.dispatch({ selection: EditorSelection.single(anchor, head) }));
const text = (view: EditorView) => view.state.doc.toString();
const cursor = (view: EditorView) => view.state.selection.main.head;

afterEach(() => {
  clearMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe('auto-close brackets and quotes', () => {
  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.autoCloseBrackets).toBe(true);
  });

  it('( [ { " and ` close themselves; typing the closer steps over it', async () => {
    const view = await show('\n');
    at(view, 0);
    type(view, '(');
    expect(text(view)).toBe('()\n');
    expect(cursor(view)).toBe(1);
    type(view, 'a)');
    expect(text(view)).toBe('(a)\n');
    expect(cursor(view)).toBe(3);
    for (const [open, pair] of [
      ['[', '[]'],
      ['{', '{}'],
      ['"', '""'],
      ['`', '``'],
    ]) {
      act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '\n' } }));
      at(view, 0);
      type(view, open);
      expect(text(view)).toBe(`${pair}\n`);
      type(view, pair[1]);
      expect(text(view)).toBe(`${pair}\n`);
      expect(cursor(view)).toBe(2);
    }
  });

  it("never pairs ' (an apostrophe in prose)", async () => {
    const view = await show('\n');
    at(view, 0);
    type(view, "don't 'x");
    expect(text(view)).toBe("don't 'x\n");
  });

  it('Backspace between an empty pair removes both', async () => {
    const view = await show('\n');
    at(view, 0);
    type(view, '(');
    backspace(view);
    expect(text(view)).toBe('\n');
    type(view, '"');
    backspace(view);
    expect(text(view)).toBe('\n');
  });

  it('a selection is wrapped; twice makes ** == ~~', async () => {
    const view = await show('one two three\n');
    for (const [mark, once, twice] of [
      ['*', '*two*', '**two**'],
      ['=', '=two=', '==two=='],
      ['~', '~two~', '~~two~~'],
      ['_', '_two_', '__two__'],
    ]) {
      act(() =>
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'one two three\n' },
        }),
      );
      at(view, 4, 7);
      type(view, mark);
      expect(text(view)).toBe(`one ${once} three\n`);
      expect(
        view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
      ).toBe('two');
      type(view, mark);
      expect(text(view)).toBe(`one ${twice} three\n`);
    }
    for (const [mark, wrapped] of [
      ["'", "'two'"],
      ['"', '"two"'],
      ['(', '(two)'],
      ['[', '[two]'],
      ['`', '`two`'],
    ]) {
      act(() =>
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'one two three\n' },
        }),
      );
      at(view, 4, 7);
      type(view, mark);
      expect(text(view)).toBe(`one ${wrapped} three\n`);
    }
  });

  it('without a selection, * _ = ~ are typed as usual', async () => {
    const view = await show('\n');
    at(view, 0);
    type(view, '*a_b=c~');
    expect(text(view)).toBe('*a_b=c~\n');
  });

  it('[[ leaves one ]] for the link autocomplete to step over', async () => {
    const view = await show('See \n');
    at(view, 4);
    type(view, '[[');
    expect(text(view)).toBe('See [[]]\n');
    expect(cursor(view)).toBe(6);
    expect(linkQueryAt(view.state, 6)).toMatchObject({ kind: 'file', closed: true });
    type(view, 'Rex]]');
    expect(text(view)).toBe('See [[Rex]]\n');
  });

  it('off: everything is typed as is', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoCloseBrackets: false } });
    const view = await show('one two\n');
    at(view, 0);
    type(view, '("[');
    expect(text(view)).toBe('("[one two\n');
    at(view, 7, 10);
    type(view, '*');
    expect(text(view)).toBe('("[one *\n');
  });

  it('follows the setting while the page is open', async () => {
    const view = await show('\n');
    act(() =>
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoCloseBrackets: false } }),
    );
    at(view, 0);
    type(view, '(');
    expect(text(view)).toBe('(\n');
    act(() => useSettingsStore.setState({ settings: DEFAULT_SETTINGS }));
    type(view, '(');
    expect(text(view)).toBe('(()\n');
  });

  it('archived pages are read-only: no pairs, no wrapping', async () => {
    const view = await show('old words\n', '.archive/Old.md');
    at(view, 0, 3);
    type(view, '*');
    // The plain insert is refused by the read-only filter too.
    expect(text(view)).toBe('old words\n');
  });

  it('text files close brackets too, but not quotes after a word', async () => {
    const view = await show('\n', 'notes.txt');
    at(view, 0);
    type(view, 'f(');
    expect(text(view)).toBe('f()\n');
    at(view, 0);
    type(view, 'say"');
    expect(text(view)).toBe('say"f()\n');
  });
});
