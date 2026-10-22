import { EditorSelection, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { installEditorKeys, useGlobalShortcuts } from '../shell/useGlobalShortcuts';
import { Editor } from './Editor';
import { goToLine, isGoToLineKey, lineTarget } from './goToLine';
import { PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
const TEXT = '---\ntags: [a]\n---\n# Title\n\nfirst\nsecond line\nthird\n';

function Shortcuts() {
  useGlobalShortcuts(false);
  return null;
}

async function show(path = 'A.md', text = TEXT, shortcuts = true) {
  fakeDisk({ [path]: text });
  const res = await PageDoc.load(path, hooks);
  if (!res.ok) throw new Error(res.error.message);
  render(
    <>
      {shortcuts && <Shortcuts />}
      <Editor doc={res.value} mode="livePreview" label="A" />
    </>,
  );
  return EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
}

const dialog = () => document.querySelector<HTMLElement>('.cm-liber-goto');
const field = () => dialog()!.querySelector<HTMLInputElement>('input')!;
const ctrlG = (target: Element = document.body) =>
  fireEvent.keyDown(target, { ctrlKey: true, key: 'g', code: 'KeyG' });
const lineOf = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head);
const colOf = (view: EditorView) => view.state.selection.main.head - lineOf(view).from + 1;

beforeEach(() => {
  useUiStore.setState({ screen: 'edit', dialog: null });
  useVaultStore.setState({ status: 'open' });
});

afterEach(() => {
  clearMocks();
  useUiStore.setState({ screen: 'edit', dialog: null });
});

describe('what Go to line reads', () => {
  const doc = Text.of(['one', 'two two', 'three', 'four', 'five']);
  const line = (n: number) => doc.line(n).from;
  const from3 = line(3); // the cursor on line 3

  it('a line, from 1; past the end, the last; 0, the first', () => {
    expect(lineTarget('2', doc, from3)).toBe(line(2));
    expect(lineTarget(' 5 ', doc, from3)).toBe(line(5));
    expect(lineTarget('99', doc, from3)).toBe(line(5));
    expect(lineTarget('0', doc, from3)).toBe(line(1));
  });

  it('line:column, both from 1 as the cursor position shows them; past the line, its end', () => {
    expect(lineTarget('2:1', doc, from3)).toBe(line(2));
    expect(lineTarget('2:5', doc, from3)).toBe(line(2) + 4);
    expect(lineTarget('2:99', doc, from3)).toBe(line(2) + 'two two'.length);
    // A column alone: on the cursor's line.
    expect(lineTarget(':3', doc, from3)).toBe(line(3) + 2);
  });

  it('+n / -n lines from the cursor’s, kept inside the file', () => {
    expect(lineTarget('+1', doc, from3)).toBe(line(4));
    expect(lineTarget('-2', doc, from3)).toBe(line(1));
    expect(lineTarget('-9', doc, from3)).toBe(line(1));
    expect(lineTarget('+9', doc, from3)).toBe(line(5));
    expect(lineTarget('+1:2', doc, from3)).toBe(line(4) + 1);
  });

  it('anything else is not a line', () => {
    for (const bad of ['', ' ', 'abc', '+', '1:', '1.5', '2:x', '--1', '%50']) {
      expect(lineTarget(bad, doc, from3), bad).toBeNull();
    }
  });

  it('Ctrl+G on every platform: never ⌘G (find next on macOS), nor with ⇧ or ⌥', () => {
    const key = (init: KeyboardEventInit) =>
      isGoToLineKey(new KeyboardEvent('keydown', { code: 'KeyG', ...init }));
    expect(key({ ctrlKey: true, key: 'g' })).toBe(true);
    expect(key({ ctrlKey: true, key: 'п' })).toBe(true); // a layout without a Latin G
    expect(key({ metaKey: true, key: 'g' })).toBe(false);
    expect(key({ ctrlKey: true, shiftKey: true, key: 'G' })).toBe(false);
    expect(key({ ctrlKey: true, altKey: true, key: 'g' })).toBe(false);
    expect(key({ ctrlKey: true, key: 'f', code: 'KeyF' })).toBe(false);
  });
});

describe('Go to line', () => {
  it('Ctrl+G opens it on the cursor’s line; Enter jumps there (frontmatter lines count)', async () => {
    const view = await show();
    act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(6).from) }));
    act(() => void ctrlG());
    expect(dialog()).not.toBeNull();
    expect(field()).toHaveValue('6');
    expect(dialog()).toHaveTextContent('Line 6 of 9');
    act(() => {
      field().value = '7:4';
      fireEvent.keyDown(field(), { key: 'Enter' });
    });
    expect(lineOf(view).number).toBe(7);
    expect(lineOf(view).text).toBe('second line');
    expect(colOf(view)).toBe(4);
    await act(() => Promise.resolve());
    expect(dialog()).toBeNull();
  });

  it('relative: +2 and -3 from the cursor’s line', async () => {
    const view = await show();
    act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(4).from) }));
    act(() => void goToLine(view));
    act(() => {
      field().value = '+2';
      fireEvent.keyDown(field(), { key: 'Enter' });
    });
    expect(lineOf(view).number).toBe(6);
    await act(() => Promise.resolve());
    act(() => void goToLine(view));
    act(() => {
      field().value = '-3';
      fireEvent.click(dialog()!.querySelector('button.cm-button')!);
    });
    expect(lineOf(view).number).toBe(3);
  });

  it('a target that isn’t a line keeps it open, marked invalid', async () => {
    const view = await show();
    const before = view.state.selection.main.head;
    act(() => void goToLine(view));
    act(() => {
      field().value = 'abc';
      fireEvent.keyDown(field(), { key: 'Enter' });
    });
    expect(dialog()).not.toBeNull();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(view.state.selection.main.head).toBe(before);
  });

  it('Escape closes it and gives the text back the keyboard', async () => {
    const view = await show();
    act(() => void goToLine(view));
    act(() => field().focus());
    act(() => void fireEvent.keyDown(field(), { key: 'Escape' }));
    await act(() => Promise.resolve());
    expect(dialog()).toBeNull();
    expect(view.contentDOM).toHaveFocus();
  });

  it('a second Ctrl+G keeps one field', async () => {
    await show();
    act(() => void ctrlG());
    act(() => void ctrlG());
    expect(document.querySelectorAll('.cm-liber-goto')).toHaveLength(1);
  });

  it('nothing outside the editor (Global View) or over a dialog', async () => {
    await show();
    act(() => useUiStore.setState({ screen: 'global' }));
    act(() => void ctrlG());
    expect(dialog()).toBeNull();
    act(() => useUiStore.setState({ screen: 'edit', dialog: { type: 'settings' } }));
    act(() => void ctrlG());
    expect(dialog()).toBeNull();
  });

  it('read-only (archived) pages too: it only moves the cursor', async () => {
    const view = await show('.archive/Old.md', 'a\nb\nc\n');
    act(() => void goToLine(view));
    act(() => {
      field().value = '3';
      fireEvent.keyDown(field(), { key: 'Enter' });
    });
    expect(lineOf(view).number).toBe(3);
    expect(view.state.doc.toString()).toBe('a\nb\nc\n');
  });

  it('speaks Spanish when the app does', async () => {
    await act(() => i18next.changeLanguage('es'));
    const view = await show();
    act(() => void goToLine(view));
    expect(dialog()).toHaveTextContent('Ir a la línea');
    expect(dialog()).toHaveTextContent('Línea 1 de 9');
    expect(dialog()!.querySelector('button.cm-button')).toHaveTextContent('Ir');
    expect(dialog()!.querySelector('.cm-dialog-close')).toHaveAttribute('aria-label', 'Cerrar');
  });

  it('a single-file window: Ctrl+G (no global shortcuts there)', async () => {
    const view = await show('notes.txt', 'a\nb\nc\n', false);
    const stop = installEditorKeys(false);
    const e = new KeyboardEvent('keydown', {
      ctrlKey: true,
      key: 'g',
      code: 'KeyG',
      cancelable: true,
      bubbles: true,
    });
    act(() => void window.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    expect(dialog()).not.toBeNull();
    expect(view.dom.contains(dialog())).toBe(true);
    stop();
  });

  it('Ctrl+G inside the editor isn’t find next (that is ⌘G, macOS only)', async () => {
    const view = await show();
    act(() => view.focus());
    act(() => void ctrlG(view.contentDOM));
    expect(dialog()).not.toBeNull();
    expect(document.querySelector('.cm-search')).toBeNull();
  });
});
