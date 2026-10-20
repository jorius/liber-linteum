import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { followLink } from '../../stores/links';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { PageScreen } from '../../test/pageScreen';
import { AUTOSAVE_MS } from '../editor/pageDoc';

const open = (path: string) => act(() => usePageStore.getState().load(path));
const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, outline: true } });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
});
afterEach(async () => {
  usePageStore.getState().clear();
  resetEditorStore();
  useToastStore.getState().clear();
  await resetVaultStore();
  vi.useRealTimers();
  clearMocks();
});

describe('text and code files (M4b part 2 §6)', () => {
  it('open in a Source-style text view without page features', async () => {
    const disk = fakeDisk({ 'conf/app.json': '{\n  "name": "liber"\n}\n' });
    render(<PageScreen />);
    await open('conf/app.json');
    const name = screen.getByRole('textbox', { name: 'File name' });
    expect(name).toHaveValue('app');
    expect(screen.getByText('.json')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Subtitle' })).not.toBeInTheDocument();
    for (const gone of ['Page width', 'Outline', 'Formatting toolbar']) {
      expect(screen.queryByRole('button', { name: gone })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Editor mode' })).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('tree', { name: 'Outline' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Save status' })).toHaveTextContent('Saved');
    expect(screen.getByText('4 lines · 22 characters')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('conf');
    // Monospace Source style, line numbers, highlighting by file type.
    expect(view().dom).toHaveClass('cm-liber-source');
    expect(document.querySelector('.cm-lineNumbers')).not.toBeNull();
    await waitFor(() =>
      expect(
        document.querySelector('.cm-liber-code-string, .cm-liber-code-function'),
      ).not.toBeNull(),
    );
    // Autosaves through text_write.
    vi.useFakeTimers();
    act(() => view().dispatch({ changes: { from: 0, insert: '\n' }, userEvent: 'input.type' }));
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS));
    expect(disk.calls.some(([c]) => c === 'text_write')).toBe(true);
    expect(disk.files.get('conf/app.json')).toBe('\n{\n  "name": "liber"\n}\n');
  });

  it('renaming keeps the extension', async () => {
    const disk = fakeDisk({ 'notes.txt': 'one\n' });
    render(<PageScreen />);
    await open('notes.txt');
    const name = screen.getByRole('textbox', { name: 'File name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'ideas{Enter}');
    await waitFor(() =>
      expect(disk.calls).toContainEqual(['entry_rename', { from: 'notes.txt', to: 'ideas.txt' }]),
    );
  });

  it('final review I4: renaming from the name field keeps the keyboard there, and the view', async () => {
    fakeDisk({ 'notes.txt': 'one\n' });
    render(<PageScreen />);
    await open('notes.txt');
    const editor = document.querySelector('.cm-editor');
    const name = screen.getByRole('textbox', { name: 'File name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'ideas{Enter}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('ideas.txt'));
    await waitFor(() => expect(usePageStore.getState().state).toBe('ready'));
    expect(screen.getByRole('textbox', { name: 'File name' })).toBe(name);
    expect(name).toHaveFocus();
    expect(name).toHaveValue('ideas');
    expect(document.querySelector('.cm-editor')).toBe(editor);
  });

  it('a file that is not eligible text offers its default app', async () => {
    fakeDisk({ 'data.csv': 'a,b\0' });
    render(<PageScreen />);
    await open('data.csv');
    expect(screen.getByText('This file opens in its default app.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open in default app' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'openFile', path: 'data.csv' });
  });

  it('links to text files open them in the app', async () => {
    fakeDisk({ 'A.md': '[[notes.txt]]\n', 'notes.txt': 'hello\n' });
    render(<PageScreen />);
    await open('A.md');
    await act(async () =>
      followLink({
        type: 'page',
        kind: 'wiki',
        target: 'notes.txt',
        heading: null,
        resolved: 'notes.txt',
        source: 'A.md',
      }),
    );
    await waitFor(() => expect(usePageStore.getState().path).toBe('notes.txt'));
    expect(await screen.findByRole('textbox', { name: 'File name' })).toHaveValue('notes');
    // The back arrow returns along the link trail, as from a page (final review M9).
    await userEvent.click(screen.getByRole('button', { name: 'Back to A' }));
    await waitFor(() => expect(usePageStore.getState().path).toBe('A.md'));
  });

  it('final review I3: rewritten outside as non-text while edited, the edits stay with a notice, a toast and Save as new file', async () => {
    const disk = fakeDisk({ 'data.csv': 'José,Bogotá\n' });
    render(<PageScreen />);
    await open('data.csv');
    act(() =>
      view().dispatch({ changes: { from: 12, insert: 'mine\n' }, userEvent: 'input.type' }),
    );
    disk.files.set('data.csv', 'Jos\0,Bogot\0\n'); // Excel's Windows-1252 export
    await act(() =>
      usePageStore
        .getState()
        .onExternalChange({ created: [], modified: ['data.csv'], removed: [], renamed: [] }),
    );
    const notice =
      'This file changed outside Liber Linteum and is no longer plain text it can edit. ' +
      'Your unsaved changes are kept here: copy them, or save them as a new file.';
    expect(screen.getByText(notice)).toBeInTheDocument();
    expect(view().state.doc.toString()).toBe('José,Bogotá\nmine\n');
    expect(screen.getByRole('status', { name: 'Save status' })).toHaveTextContent('Not saved');
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      '“data.csv” changed outside Liber Linteum and is no longer plain text it can edit. ' +
        'Your unsaved changes are kept in the app.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save as new file' }));
    await waitFor(() =>
      expect([...disk.files.values()].filter((t) => t === 'José,Bogotá\nmine\n')).toHaveLength(1),
    );
    expect(disk.files.get('data.csv')).toBe('Jos\0,Bogot\0\n');
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  it('final review I3: rewritten outside as non-text with nothing unsaved, it opens in its default app', async () => {
    const disk = fakeDisk({ 'data.csv': 'a,b\n' });
    render(<PageScreen />);
    await open('data.csv');
    disk.files.set('data.csv', 'a,b\0\n');
    await act(() =>
      usePageStore
        .getState()
        .onExternalChange({ created: [], modified: ['data.csv'], removed: [], renamed: [] }),
    );
    expect(screen.getByText('This file opens in its default app.')).toBeInTheDocument();
    expect(document.querySelector('.cm-editor')).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('NFR-10: no axe violations', async () => {
    fakeDisk({ 'run.sh': 'echo hi\n' });
    render(<PageScreen />);
    await open('run.sh');
    const violations = await axe
      .run(document.body, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
