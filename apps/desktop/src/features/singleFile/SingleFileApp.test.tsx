import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC, mockWindows } from '../../ipc/testing';
import { setFileWindow, type FileInfo } from '../../ipc';
import { resetEditorStore, useEditorStore } from '../../stores/editorStore';
import { followLink } from '../../stores/links';
import { openPage } from '../../stores/navigate';
import { usePageWidthStore } from '../../stores/pageWidthStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { resetSingleFileStore, useSingleFileStore } from './singleFileStore';
import { SingleFileApp } from './SingleFileApp';

const PAGE: FileInfo = { name: 'note.md', kind: 'page', folder: '/Users/me/Notes', vault: null };

/** One file on disk, as Rust's file commands see it. */
function backend(info: FileInfo, text: string) {
  const calls: [string, Record<string, unknown>][] = [];
  let disk = text;
  let hash = 1;
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    switch (cmd) {
      case 'file_info':
        return info;
      case 'file_read':
        return { text: disk, hash: `h${hash}` };
      case 'file_write':
        disk = a.text as string;
        return { hash: `h${++hash}` };
      case 'file_rename':
        return a.newName;
      case 'file_links_resolve':
        return (a.targets as unknown[]).map(() => null);
      case 'file_follow':
        return 'window';
      case 'file_open_in_vault':
      case 'plugin:window|destroy':
        return null;
      case 'settings_set':
        return { ...DEFAULT_SETTINGS, ...(a.patch as object) };
    }
  });
  return calls;
}

const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;

beforeEach(() => {
  mockWindows('file-1');
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});
afterEach(() => {
  resetEditorStore();
  resetSingleFileStore();
  usePageWidthStore.setState({ vault: null, pages: {} });
  useToastStore.setState({ toasts: [] });
  clearMocks();
});

describe('M4c single-file window', () => {
  it('shows the file: its name, subtitle, the compact band and the editor; no vault features', async () => {
    backend(PAGE, '---\nsubtitle: Draft\n---\n# Hello\n');
    const { container } = render(<SingleFileApp />);
    expect(await screen.findByRole('textbox', { name: 'Page title' })).toHaveValue('note');
    expect(await screen.findByRole('textbox', { name: 'Subtitle' })).toHaveValue('Draft');
    expect(screen.getByRole('status', { name: 'Save status' })).toHaveTextContent('Saved');
    expect(screen.getByText('/Users/me/Notes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page width' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Editor mode' })).toBeInTheDocument();
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    // No explorer, Global View, close-vault or Attach.
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('button', { name: /Global view/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close vault' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Attach/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Vault' })).toBeNull();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('a text file shows the text view: lines, no mode switch or subtitle', async () => {
    backend({ ...PAGE, name: 'list.txt', kind: 'text' }, 'one\ntwo\n');
    render(<SingleFileApp />);
    expect(await screen.findByText(/3 lines/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'File name' })).toHaveValue('list');
    expect(screen.queryByRole('group', { name: 'Editor mode' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Subtitle' })).toBeNull();
  });

  it("saves typing to the window's own file", async () => {
    const calls = backend(PAGE, '# Hello\n');
    render(<SingleFileApp />);
    await screen.findByRole('textbox', { name: 'Page title' });
    await waitFor(() => expect(document.querySelector('.cm-editor')).not.toBeNull());
    act(() => view().dispatch({ changes: { from: 7, insert: '!' }, userEvent: 'input.type' }));
    await act(() => useEditorStore.getState().flushAll());
    expect(calls.find(([c]) => c === 'file_write')?.[1]).toEqual({
      text: '# Hello!\n',
      expectedHash: 'h1',
    });
  });

  it('renames the file in its folder; the editor keeps it', async () => {
    const calls = backend(PAGE, '# Hello\n');
    render(<SingleFileApp />);
    const title = await screen.findByRole('textbox', { name: 'Page title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Better{Enter}');
    await waitFor(() => expect(useSingleFileStore.getState().info?.name).toBe('Better.md'));
    expect(calls.find(([c]) => c === 'file_rename')?.[1]).toEqual({ newName: 'Better.md' });
    expect(useEditorStore.getState().path).toBe('Better.md');
  });

  it('deleted outside: nothing unsaved → says so; unsaved text → kept, with Save again', async () => {
    backend(PAGE, '# Hello\n');
    render(<SingleFileApp />);
    await screen.findByRole('textbox', { name: 'Page title' });
    await waitFor(() => expect(useEditorStore.getState().doc).not.toBeNull());
    act(() => view().dispatch({ changes: { from: 7, insert: '!' }, userEvent: 'input.type' }));
    await act(() => useSingleFileStore.getState().changed(true));
    expect(screen.getByText(/deleted or moved outside the app\. Your text/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save again' })).toBeInTheDocument();

    resetEditorStore();
    resetSingleFileStore();
    backend(PAGE, '# Hello\n');
    render(<SingleFileApp />);
    await waitFor(() => expect(useEditorStore.getState().doc).not.toBeNull());
    await act(() => useSingleFileStore.getState().changed(true));
    expect(screen.getAllByRole('button', { name: 'Close window' }).length).toBeGreaterThan(0);
  });

  it('Open in its vault: saves, hands the page over, closes the window', async () => {
    const calls = backend(
      { ...PAGE, vault: { root: '/v/Notes', name: 'Notes', page: 'Daily/note.md' } },
      '# Hello\n',
    );
    render(<SingleFileApp />);
    expect(await screen.findByRole('region', { name: 'Vault' })).toHaveTextContent(
      'This file is in your vault “Notes”.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open in its vault' }));
    await waitFor(() => expect(calls.map(([c]) => c)).toContain('plugin:window|destroy'));
    const order = calls.map(([c]) => c);
    expect(order.indexOf('file_open_in_vault')).toBeLessThan(
      order.indexOf('plugin:window|destroy'),
    );
  });
});

describe('M4c links and width in a single-file window', () => {
  it('another file opens in its own window; a missing one says so', async () => {
    const calls = backend(PAGE, '');
    setFileWindow('note.md');
    await openPage('Other.md');
    expect(calls).toContainEqual(['file_follow', { path: 'Other.md' }]);
    followLink({
      type: 'page',
      kind: 'wiki',
      target: 'Nowhere',
      heading: null,
      resolved: null,
      source: 'note.md',
    });
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      'No file named “Nowhere” in this folder.',
    );
    followLink({ type: 'file', path: 'doc.pdf' });
    await waitFor(() => expect(calls).toContainEqual(['file_follow', { path: 'doc.pdf' }]));
  });

  it('the width is this window’s own, saved nowhere', async () => {
    const calls = backend(PAGE, '');
    setFileWindow('note.md');
    await usePageWidthStore.getState().set('note.md', 'full');
    expect(usePageWidthStore.getState().pages).toEqual({ 'note.md': 'full' });
    await usePageWidthStore.getState().set('note.md', 'readable'); // the default: cleared
    expect(usePageWidthStore.getState().pages).toEqual({});
    expect(calls).toEqual([]);
  });
});
