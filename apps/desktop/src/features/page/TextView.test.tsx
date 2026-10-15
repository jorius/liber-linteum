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
  await resetVaultStore();
  vi.useRealTimers();
  clearMocks();
});

describe('text and code files (M4b part 2 §6)', () => {
  it('open in a Source-style text view without page features', async () => {
    const disk = fakeDisk({ 'conf/app.json': '{\n  "name": "nimw"\n}\n' });
    render(<PageScreen />);
    await open('conf/app.json');
    const name = screen.getByRole('textbox', { name: 'File name' });
    expect(name).toHaveValue('app');
    expect(screen.getByText('.json')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Subtitle' })).not.toBeInTheDocument();
    for (const gone of ['Full width', 'Outline', 'Formatting toolbar']) {
      expect(screen.queryByRole('button', { name: gone })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Editor mode' })).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('tree', { name: 'Outline' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Save status' })).toHaveTextContent('Saved');
    expect(screen.getByText('4 lines · 21 characters')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('conf');
    // Monospace Source style, line numbers, highlighting by file type.
    expect(view().dom).toHaveClass('cm-nimw-source');
    expect(document.querySelector('.cm-lineNumbers')).not.toBeNull();
    await waitFor(() =>
      expect(document.querySelector('.cm-nimw-code-string, .cm-nimw-code-function')).not.toBeNull(),
    );
    // Autosaves through text_write.
    vi.useFakeTimers();
    act(() => view().dispatch({ changes: { from: 0, insert: '\n' }, userEvent: 'input.type' }));
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS));
    expect(disk.calls.some(([c]) => c === 'text_write')).toBe(true);
    expect(disk.files.get('conf/app.json')).toBe('\n{\n  "name": "nimw"\n}\n');
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
