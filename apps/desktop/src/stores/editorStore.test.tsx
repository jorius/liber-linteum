import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '../features/toasts/Toaster';
import { clearMocks, emit, mockIPC, mockWindows } from '../ipc/testing';
import { fakeDisk } from '../test/fakeDisk';
import { installQuitGuard, resetEditorStore, useEditorStore } from './editorStore';
import { usePageStore } from './pageStore';
import { useToastStore } from './toastStore';

const editor = () => useEditorStore.getState();

beforeEach(() => useToastStore.getState().clear());
afterEach(() => {
  resetEditorStore();
  vi.useRealTimers();
  clearMocks();
});

describe('editorStore (M2a §3.3)', () => {
  it('review focus: switching pages mid-save saves the old page and leaves the new one alone', async () => {
    const disk = fakeDisk({ 'A.md': 'a\n', 'B.md': 'b\n' });
    await editor().open('A.md');
    editor().doc!.edit('a edited\n');
    const release = disk.holdWrites();
    const saving = editor().doc!.flush(); // write of A is in flight
    await editor().open('B.md');
    expect(editor().path).toBe('B.md');
    release();
    await saving;
    await editor().flushAll();
    expect(disk.files.get('A.md')).toBe('a edited\n');
    expect(disk.files.get('B.md')).toBe('b\n');
    expect(editor().doc!.text).toBe('b\n');
    expect(editor().status).toBe('saved');
    expect(disk.writes()).toEqual([{ path: 'A.md', text: 'a edited\n' }]);
  });

  it('a page whose save keeps failing stays open in the background until it saves', async () => {
    vi.useFakeTimers();
    const disk = fakeDisk({ 'A.md': 'a\n', 'B.md': 'b\n' });
    await editor().open('A.md');
    editor().doc!.edit('a2\n');
    disk.failWrites(1);
    await editor().open('B.md');
    expect(disk.files.get('A.md')).toBe('a\n');
    await vi.advanceTimersByTimeAsync(1000); // retry
    expect(disk.files.get('A.md')).toBe('a2\n');
    // Coming back finds the saved text.
    await editor().open('A.md');
    expect(editor().doc!.text).toBe('a2\n');
  });

  it('follows renames (own or external) keeping unsaved text', async () => {
    const disk = fakeDisk({ 'A/x.md': 'x\n' });
    await editor().open('A/x.md');
    editor().doc!.edit('x2\n');
    disk.files.set('B/x.md', disk.files.get('A/x.md')!);
    disk.files.delete('A/x.md');
    await editor().onExternalChange({
      created: [],
      modified: [],
      removed: [],
      renamed: [['A', 'B']],
    });
    expect(editor().path).toBe('B/x.md');
    await editor().flushAll();
    expect(disk.files.get('B/x.md')).toBe('x2\n');
  });

  it('deleted while dirty: orphaned, text kept; deleted while clean: closed', async () => {
    const disk = fakeDisk({ 'A.md': 'a\n', 'B.md': 'b\n' });
    await editor().open('A.md');
    editor().doc!.edit('keep me\n');
    disk.files.delete('A.md');
    await editor().onExternalChange({ created: [], modified: [], removed: ['A.md'], renamed: [] });
    expect(editor().orphaned).toBe(true);
    expect(editor().doc!.text).toBe('keep me\n');
    await editor().open('B.md');
    disk.files.delete('B.md');
    await editor().onExternalChange({ created: [], modified: [], removed: ['B.md'], renamed: [] });
    expect(editor().doc).toBeNull();
  });

  it('C2: renamed in Finder while an autosave runs: the text is saved at the new path', async () => {
    const disk = fakeDisk({ 'A.md': 'a\n' });
    await editor().open('A.md');
    editor().doc!.edit('typed\n');
    disk.files.set('B.md', disk.files.get('A.md')!);
    disk.files.delete('A.md'); // the watcher event is still being debounced...
    await editor().doc!.flush(); // ...when the autosave fires: NotFound
    await editor().onExternalChange({
      created: [],
      modified: [],
      removed: [],
      renamed: [['A.md', 'B.md']],
    });
    expect(editor().path).toBe('B.md');
    editor().doc!.edit('typed more\n');
    const unsaved = await editor().saveAll();
    expect({
      orphaned: editor().orphaned,
      onDisk: disk.files.get('B.md'),
      unsaved,
      status: editor().status,
    }).toEqual({ orphaned: false, onDisk: 'typed more\n', unsaved: [], status: 'saved' });
  });

  it('C2: deleted and recreated (sync tool) around an autosave: saving resumes', async () => {
    const disk = fakeDisk({ 'A.md': 'a\n' });
    await editor().open('A.md');
    editor().doc!.edit('typed\n');
    disk.files.delete('A.md');
    await editor().doc!.flush();
    disk.files.set('A.md', 'a\n');
    await editor().onExternalChange(
      { created: ['A.md'], modified: [], removed: ['A.md'], renamed: [] },
      () => true,
    );
    editor().doc!.edit('typed more\n');
    await editor().flushAll();
    expect({ orphaned: editor().orphaned, onDisk: disk.files.get('A.md') }).toEqual({
      orphaned: false,
      onDisk: 'typed more\n',
    });
  });

  it('C2: an orphaned page restored on disk is no longer orphaned and saves', async () => {
    const disk = fakeDisk({ 'A.md': 'a\n' });
    await editor().open('A.md');
    editor().doc!.edit('keep me\n');
    disk.files.delete('A.md');
    await editor().onExternalChange({ created: [], modified: [], removed: ['A.md'], renamed: [] });
    expect(editor().orphaned).toBe(true);
    disk.files.set('A.md', 'a\n'); // put back from the Trash
    await editor().onExternalChange({ created: ['A.md'], modified: [], removed: [], renamed: [] });
    expect(editor().orphaned).toBe(false);
    expect(await editor().saveAll()).toEqual([]);
    expect(disk.files.get('A.md')).toBe('keep me\n');
  });

  it('modified on disk reloads; a delete + recreate (atomic save) is a modify', async () => {
    const disk = fakeDisk({ 'A.md': 'a\n' });
    await editor().open('A.md');
    disk.files.set('A.md', 'new\n');
    await editor().onExternalChange(
      { created: ['A.md'], modified: [], removed: ['A.md'], renamed: [] },
      () => true,
    );
    expect(editor().doc!.text).toBe('new\n');
  });

  it('a conflict copy shows a toast whose "Open" button opens the copy', async () => {
    const disk = fakeDisk({ 'A.md': 'one\ntwo\n' });
    render(<Toaster />);
    await act(() => editor().open('A.md'));
    editor().doc!.edit('one\nMINE\n');
    disk.files.set('A.md', 'one\nTHEIRS\n');
    await act(() =>
      editor().onExternalChange({ created: [], modified: ['A.md'], removed: [], renamed: [] }),
    );
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent(
      'Someone else changed this page — their version was saved as “A (conflict)”',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await vi.waitFor(() => expect(usePageStore.getState().path).toBe('A (conflict).md'));
  });

  it('binary pages cannot be edited', async () => {
    mockIPC(() => {
      throw { kind: 'binary', message: 'not UTF-8 text: latin1.md' };
    });
    await editor().open('latin1.md');
    expect(editor().doc).toBeNull();
    expect(editor().error?.kind).toBe('binary');
  });

  it('flushes unsaved pages before the window closes (max 2 s)', async () => {
    mockWindows('main');
    const disk = fakeDisk({ 'A.md': 'a\n' });
    const calls = () => disk.calls.map(([c]) => c);
    await editor().open('A.md');
    editor().doc!.edit('typed just before quitting\n');
    await installQuitGuard();
    await emit('tauri://close-requested');
    await vi.waitFor(() => expect(calls()).toContain('plugin:window|destroy'));
    expect(disk.files.get('A.md')).toBe('typed just before quitting\n');
    expect(calls().indexOf('page_write')).toBeLessThan(calls().indexOf('plugin:window|destroy'));
  });

  it('m5: an orphaned page keeps the window open, says so, and a second close quits', async () => {
    mockWindows('main');
    const disk = fakeDisk({ 'A.md': 'a\n' });
    const calls = () => disk.calls.map(([c]) => c);
    render(<Toaster />);
    await act(() => editor().open('A.md'));
    editor().doc!.edit('keep me\n');
    disk.files.delete('A.md');
    await act(() =>
      editor().onExternalChange({ created: [], modified: [], removed: ['A.md'], renamed: [] }),
    );
    expect(editor().orphaned).toBe(true);
    await installQuitGuard();
    await act(() => emit('tauri://close-requested'));
    await screen.findByText(
      'Unsaved changes in “A” couldn’t be written, so the window stays open. Close it again to quit without them.',
    );
    expect(calls()).not.toContain('plugin:window|destroy');
    expect(editor().doc!.text).toBe('keep me\n');
    // Asked twice: the person chose to quit.
    await act(() => emit('tauri://close-requested'));
    await vi.waitFor(() => expect(calls()).toContain('plugin:window|destroy'));
  });

  it('m5: a page orphaned in the background is kept, blocks the close, and can be opened', async () => {
    mockWindows('main');
    const disk = fakeDisk({ 'A.md': 'a\n', 'B.md': 'b\n' });
    const calls = () => disk.calls.map(([c]) => c);
    render(<Toaster />);
    await act(() => editor().open('A.md'));
    editor().doc!.edit('keep me\n');
    disk.failWrites(1);
    await act(() => editor().open('B.md')); // A keeps retrying in the background
    disk.files.delete('A.md');
    await act(() =>
      editor().onExternalChange({ created: [], modified: [], removed: ['A.md'], renamed: [] }),
    );
    await installQuitGuard();
    await act(() => emit('tauri://close-requested'));
    await screen.findByText(/Unsaved changes in “A” couldn’t be written/);
    expect(calls()).not.toContain('plugin:window|destroy');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await vi.waitFor(() => expect(editor().path).toBe('A.md'));
    expect(editor().orphaned).toBe(true);
    expect(editor().doc!.text).toBe('keep me\n');
  });
});
