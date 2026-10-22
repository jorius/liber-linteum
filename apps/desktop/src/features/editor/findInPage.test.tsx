import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { fakeDisk } from '../../test/fakeDisk';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import {
  installFindKey,
  installNoFindBar,
  searchKeyTarget,
  useGlobalShortcuts,
} from '../shell/useGlobalShortcuts';
import { Editor } from './Editor';
import { findableView, openFindInPage } from './findInPage';
import { PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };

async function load(path: string) {
  const res = await PageDoc.load(path, hooks);
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
}

const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
const field = (name: string) =>
  document.querySelector<HTMLInputElement>(`.cm-search input[name=${name}]`);
const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`.cm-search button[name=${name}]`)!;

function Shortcuts() {
  useGlobalShortcuts(false);
  return null;
}

/** A page in the editor, with the main window's shortcuts. */
async function showPage(path: string, text: string) {
  fakeDisk({ [path]: text });
  const doc = await load(path);
  render(
    <>
      <Shortcuts />
      <Editor doc={doc} mode="livePreview" label="Page" />
    </>,
  );
  return viewOf();
}

/** Types `text` into a panel field, as CodeMirror's panel reads it (keyup). */
function typeInto(input: HTMLInputElement, text: string) {
  input.value = text;
  fireEvent.keyUp(input, { key: text.slice(-1) });
}

const ctrlF = (init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, {
    ctrlKey: true,
    key: 'f',
    code: 'KeyF',
    ...init,
  });

beforeEach(() => {
  useUiStore.setState({ screen: 'edit', dialog: null });
  useVaultStore.setState({ status: 'open' });
});

afterEach(() => {
  clearMocks();
  useUiStore.setState({ screen: 'edit', dialog: null });
});

describe('the F key: find in page or Search', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { code: 'KeyF', ...init });

  it('macOS: ⌘F finds in the page while the editor shows one, else Search; ⌘⇧F always Search', () => {
    expect(searchKeyTarget(key({ metaKey: true, key: 'f' }), true, true)).toBe('find');
    expect(searchKeyTarget(key({ metaKey: true, key: 'f' }), false, true)).toBe('search');
    expect(searchKeyTarget(key({ metaKey: true, shiftKey: true, key: 'F' }), true, true)).toBe(
      'search',
    );
    // Ctrl+F is "forward one character" on macOS: neither.
    expect(searchKeyTarget(key({ ctrlKey: true, key: 'f' }), true, true)).toBeNull();
    // A layout without a Latin F: the physical key.
    expect(searchKeyTarget(key({ metaKey: true, key: 'а' }), true, true)).toBe('find');
  });

  it('Windows and Linux: Ctrl+F finds in the page in the editor, else Search; Ctrl+Shift+F Search', () => {
    expect(searchKeyTarget(key({ ctrlKey: true, key: 'f' }), true, false)).toBe('find');
    expect(searchKeyTarget(key({ ctrlKey: true, key: 'f' }), false, false)).toBe('search');
    expect(searchKeyTarget(key({ ctrlKey: true, shiftKey: true, key: 'F' }), true, false)).toBe(
      'search',
    );
    expect(searchKeyTarget(key({ ctrlKey: true, altKey: true, key: 'f' }), true, false)).toBeNull();
    expect(searchKeyTarget(key({ ctrlKey: true, key: 'g', code: 'KeyG' }), true, false)).toBeNull();
  });
});

describe('find in page', () => {
  it('Ctrl+F in the editor opens find, steps through the matches and replaces one', async () => {
    const view = await showPage('A.md', '# A\n\nThe red wyrm and the blue wyrm.\n');
    act(() => view.focus());
    act(() => void ctrlF());
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(useUiStore.getState().dialog).toBeNull();
    // (Its field takes the keyboard through select(), which jsdom doesn't
    // turn into focus; the e2e test checks it.)
    const find = field('search')!;
    expect(find).toHaveAttribute('placeholder', 'Find in page');

    act(() => typeInto(find, 'wyrm'));
    expect(getSearchQuery(view.state).search).toBe('wyrm');
    const text = view.state.doc.toString();
    const first = text.indexOf('wyrm');
    const second = text.lastIndexOf('wyrm');
    act(() => void fireEvent.keyDown(find, { key: 'Enter', keyCode: 13 }));
    expect(view.state.selection.main.from).toBe(first);
    act(() => void fireEvent.keyDown(find, { key: 'F3', keyCode: 114 }));
    expect(view.state.selection.main.from).toBe(second);
    act(() => void fireEvent.keyDown(find, { key: 'Enter', keyCode: 13, shiftKey: true }));
    expect(view.state.selection.main.from).toBe(first);

    act(() => typeInto(field('replace')!, 'drake'));
    act(() => button('replace').click());
    expect(view.state.doc.toString()).toBe('# A\n\nThe red drake and the blue wyrm.\n');
    act(() => button('replaceAll').click());
    expect(view.state.doc.toString()).toBe('# A\n\nThe red drake and the blue drake.\n');
  });

  it('Escape closes it and gives the text back the keyboard', async () => {
    const view = await showPage('A.md', 'one two\n');
    act(() => void ctrlF());
    const find = field('search')!;
    act(() => find.focus());
    act(() => void fireEvent.keyDown(find, { key: 'Escape', keyCode: 27 }));
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(view.contentDOM).toHaveFocus();
  });

  it('opens from anywhere while the editor shows (the keyboard in the sidebar)', async () => {
    const view = await showPage('A.md', 'one\n');
    act(() => void fireEvent.keyDown(document.body, { ctrlKey: true, key: 'f', code: 'KeyF' }));
    expect(searchPanelOpen(view.state)).toBe(true);
  });

  it('Ctrl+Shift+F in the editor still opens the vault-wide Search', async () => {
    const view = await showPage('A.md', 'one\n');
    act(() => view.focus());
    act(() => void ctrlF({ shiftKey: true, key: 'F' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it('outside the editor (Global View, Trash) Ctrl+F opens Search, as before', async () => {
    const view = await showPage('A.md', 'one\n');
    for (const screen of ['global', 'trash'] as const) {
      act(() => useUiStore.setState({ screen, dialog: null }));
      expect(findableView()).toBeNull();
      act(() => void ctrlF());
      expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
      expect(searchPanelOpen(view.state)).toBe(false);
    }
  });

  it('not over a dialog', async () => {
    const view = await showPage('A.md', 'one\n');
    useUiStore.setState({ dialog: { type: 'settings' } });
    expect(openFindInPage()).toBe(false);
    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it('an archived page (read-only) gets find without replace', async () => {
    const view = await showPage('.archive/Old.md', 'old words\n');
    act(() => void ctrlF());
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(field('search')).not.toBeNull();
    expect(field('replace')).toBeNull();
    expect(document.querySelector('.cm-search button[name=replace]')).toBeNull();
  });

  it('speaks Spanish when the app does', async () => {
    await act(() => i18next.changeLanguage('es'));
    const view = await showPage('A.md', 'uno\n');
    act(() => void ctrlF());
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(field('search')).toHaveAttribute('placeholder', 'Buscar en la página');
    expect(field('replace')).toHaveAttribute('placeholder', 'Reemplazar por');
    expect(button('next')).toHaveTextContent('Siguiente');
    expect(button('replaceAll')).toHaveTextContent('Reemplazar todas');
    expect(document.querySelector('.cm-search')).toHaveTextContent('Distinguir mayúsculas');
  });

  it('follows a language change while the page is open', async () => {
    const view = await showPage('A.md', 'uno\n');
    await act(() => i18next.changeLanguage('es'));
    act(() => void ctrlF());
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(field('search')).toHaveAttribute('placeholder', 'Buscar en la página');
  });

  it('a single-file window: Ctrl+F finds in the file (no global shortcuts there)', async () => {
    fakeDisk({ 'notes.txt': 'plain text\n' });
    const doc = await load('notes.txt');
    render(<Editor doc={doc} mode="source" label="notes.txt" />);
    const stop = installFindKey(false);
    const view = viewOf();
    const e = new KeyboardEvent('keydown', {
      ctrlKey: true,
      key: 'f',
      code: 'KeyF',
      cancelable: true,
      bubbles: true,
    });
    act(() => void window.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(true);
    stop();
  });

  it('the webview’s own find bar stays off (WebView2) with find in page', async () => {
    await showPage('A.md', 'one\n');
    const stop = installNoFindBar(false);
    const e = new KeyboardEvent('keydown', { ctrlKey: true, key: 'f', cancelable: true });
    act(() => void window.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    // F3 (next match) is Edge's "find next" too.
    const f3 = new KeyboardEvent('keydown', { key: 'F3', shiftKey: true, cancelable: true });
    act(() => void window.dispatchEvent(f3));
    expect(f3.defaultPrevented).toBe(true);
    stop();
  });
});
