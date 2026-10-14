import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { useToastStore } from '../../stores/toastStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { PageScreen } from '../../test/pageScreen';

const open = (path: string) => act(() => usePageStore.getState().load(path));
const title = () => screen.getByRole('textbox', { name: 'Page title' });
const renames = (calls: [string, Record<string, unknown>][]) =>
  calls.filter(([c]) => c === 'entry_rename').map(([, a]) => a);

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
});
afterEach(async () => {
  usePageStore.getState().clear();
  useToastStore.getState().clear();
  resetEditorStore();
  await resetVaultStore();
  clearMocks();
});

describe('editable title (M2b §2)', () => {
  it('shows the file name and renames the file on Enter; the page follows', async () => {
    const disk = fakeDisk({ 'Notes/Old.md': '# Heading\n\nbody\n' });
    render(<PageScreen />);
    await open('Notes/Old.md');
    expect(screen.getByRole('heading', { level: 1 })).toContainElement(title());
    expect(title()).toHaveValue('Old');
    // The note's own title (first heading or `title:`) stays visible when it differs.
    expect(screen.getByText('Title in the note: Heading')).toBeInTheDocument();
    await userEvent.clear(title());
    await userEvent.type(title(), 'New name{Enter}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('Notes/New name.md'));
    expect(renames(disk.calls)).toEqual([{ from: 'Notes/Old.md', to: 'Notes/New name.md' }]);
    expect(title()).toHaveValue('New name');
    expect(disk.files.has('Notes/New name.md')).toBe(true);
  });

  it('final review I3: focus stays on the title after renaming with Enter (NFR-10)', async () => {
    fakeDisk({ 'A.md': 'x\n' });
    render(<PageScreen />);
    await open('A.md');
    await userEvent.clear(title());
    await userEvent.type(title(), 'B{Enter}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('B.md'));
    await waitFor(() => expect(usePageStore.getState().state).toBe('ready'));
    expect(title()).toHaveValue('B');
    expect(title()).toHaveFocus();
    await userEvent.type(title(), 'x{Escape}');
    expect(title()).toHaveValue('B');
    expect(title()).toHaveFocus();
  });

  it('Escape puts the name back; blur renames; an unchanged name does nothing', async () => {
    const disk = fakeDisk({ 'A.md': 'x\n' });
    render(<PageScreen />);
    await open('A.md');
    await userEvent.clear(title());
    await userEvent.type(title(), 'Z{Escape}');
    expect(title()).toHaveValue('A');
    expect(title()).toHaveFocus();
    await userEvent.type(title(), '{Enter}');
    expect(renames(disk.calls)).toEqual([]);
    await userEvent.type(title(), 'B');
    await userEvent.tab();
    await waitFor(() => expect(renames(disk.calls)).toEqual([{ from: 'A.md', to: 'AB.md' }]));
  });

  it('final review m6: a blur because the window lost focus keeps the edit uncommitted', async () => {
    const disk = fakeDisk({ 'A.md': 'x\n' });
    render(<PageScreen />);
    await open('A.md');
    await userEvent.type(title(), 'B');
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      act(() => title().blur()); // switching to another app mid-edit
      await act(async () => {});
      expect(renames(disk.calls)).toEqual([]);
      expect(title()).toHaveValue('AB');
    } finally {
      hasFocus.mockRestore();
    }
    // Back in the window: Enter (or a real in-app blur) still commits.
    title().focus();
    await userEvent.type(title(), '{Enter}');
    await waitFor(() => expect(renames(disk.calls)).toEqual([{ from: 'A.md', to: 'AB.md' }]));
  });

  it('names that cannot be files, or that are taken, are explained under the title', async () => {
    const disk = fakeDisk({ 'Notes/A.md': 'x\n', 'Notes/B.md': 'y\n' });
    render(<PageScreen />);
    await open('Notes/A.md');
    await userEvent.clear(title());
    await userEvent.type(title(), 'a/b{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Names can\'t contain "/".');
    expect(title()).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(title());
    await userEvent.type(title(), 'b{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A page named “b” is already in this folder.',
    );
    expect([...disk.files.keys()].sort()).toEqual(['Notes/A.md', 'Notes/B.md']);
    // A case-only rename of the page itself is allowed.
    await userEvent.clear(title());
    await userEvent.type(title(), 'a{Enter}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('Notes/a.md'));
    expect([...disk.files.keys()].sort()).toEqual(['Notes/B.md', 'Notes/a.md']);
  });

  it('final review m11b: with the tree loaded, a name differing only in case from another page is refused before any rename; a case-only rename of the page itself is allowed', async () => {
    const disk = fakeDisk({ 'Notes/a.md': 'x\n', 'Notes/B.md': 'y\n' });
    await act(() => useVaultStore.getState().refreshTree());
    expect(useVaultStore.getState().nodes.map((n) => n.path)).toContain('Notes/B.md');
    render(<PageScreen />);
    await open('Notes/a.md');
    await userEvent.clear(title());
    await userEvent.type(title(), 'b{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A page named “b” is already in this folder.',
    );
    expect(renames(disk.calls)).toEqual([]); // the tree check refused it, not the backend
    await userEvent.clear(title());
    await userEvent.type(title(), 'A{Enter}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('Notes/A.md'));
    expect(renames(disk.calls)).toEqual([{ from: 'Notes/a.md', to: 'Notes/A.md' }]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect([...disk.files.keys()].sort()).toEqual(['Notes/A.md', 'Notes/B.md']);
  });

  it('pending text is saved before the rename', async () => {
    const disk = fakeDisk({ 'A.md': 'one\n' });
    render(<PageScreen />);
    await open('A.md');
    act(() => {
      const v = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
      v.dispatch({ changes: { from: 0, insert: 'zero ' }, userEvent: 'input.type' });
    });
    await userEvent.clear(title());
    await userEvent.type(title(), 'B{Enter}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('B.md'));
    const order = disk.calls
      .map(([c]) => c)
      .filter((c) => c === 'page_write' || c === 'entry_rename');
    expect(order[0]).toBe('page_write');
    expect(order).toContain('entry_rename');
    expect(disk.files.get('B.md')).toBe('zero one\n');
  });

  it('a failed rename keeps the field open with the reason', async () => {
    fakeDisk(
      { 'A.md': 'x\n' },
      { entry_rename: () => Promise.reject({ kind: 'io', message: 'disk is read-only' }) },
    );
    render(<PageScreen />);
    await open('A.md');
    await userEvent.clear(title());
    await userEvent.type(title(), 'B{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('disk is read-only');
    expect(title()).toHaveValue('B');
    expect(usePageStore.getState().path).toBe('A.md');
  });

  it('final review m4: a failed title rename is reported once, under the title (no toast)', async () => {
    fakeDisk(
      { 'A.md': 'x\n', 'B.md': 'y\n' },
      {
        entry_rename: (a) =>
          a.to === 'C.md'
            ? Promise.reject({ kind: 'io', message: 'disk is read-only' })
            : Promise.reject({ kind: 'alreadyExists', message: String(a.to) }),
      },
    );
    render(<PageScreen />);
    await open('A.md');
    await userEvent.clear(title());
    await userEvent.type(title(), 'B{Enter}'); // taken, though the tree didn't know
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A page named “B” is already in this folder.',
    );
    await userEvent.clear(title());
    await userEvent.type(title(), 'C{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('disk is read-only');
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('M3a §5: a title focus request (New entry) focuses and selects the name once', async () => {
    fakeDisk({ 'Notes/Untitled.md': '' });
    act(() => usePageStore.getState().requestTitleFocus('Notes/Untitled.md'));
    render(<PageScreen />);
    await open('Notes/Untitled.md');
    await waitFor(() => expect(document.activeElement).toBe(title()));
    const input = title() as HTMLInputElement;
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Untitled'.length]);
    expect(usePageStore.getState().titleFocus, 'consumed').toBeNull();
  });

  it('has no axe violations', async () => {
    fakeDisk({ 'A.md': 'x\n' });
    render(<PageScreen />);
    await open('A.md');
    const header = screen.getByRole('banner');
    const violations = await axe
      .run(header, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
