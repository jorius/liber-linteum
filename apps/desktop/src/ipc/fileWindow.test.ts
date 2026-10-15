import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  entryCreatePage,
  entryCreateText,
  fileFollow,
  fileInfo,
  fileOpenDialog,
  fileOpenInVault,
  fileRename,
  isFileWindowLabel,
  linkSuggest,
  linksExternal,
  linksResolve,
  pageCreateConflictCopy,
  pageRead,
  pageWrite,
  setFileWindow,
  textRead,
  textWrite,
  windowLabel,
} from './index';

afterEach(() => {
  setFileWindow(null);
  clearMocks();
});

function backend() {
  const calls: [string, unknown][] = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'file_read' || cmd === 'file_note_read') return { text: 'x', hash: 'h' };
    if (cmd === 'file_write') return { hash: 'h2' };
    if (cmd === 'file_conflict_copy') return 'note (conflict).md';
    if (cmd === 'file_recreate') return 'note.md';
    if (cmd === 'file_links_resolve') return ['Other.md'];
    if (cmd === 'file_info') return { name: 'note.md', kind: 'page', folder: '/d', vault: null };
    if (cmd === 'file_rename') return 'Better.md';
    if (cmd === 'file_follow') return 'window';
    if (cmd === 'file_open_dialog') return ['a.png'];
    return null;
  });
  return calls;
}

describe('M4c single-file windows: the IPC layer', () => {
  it('knows its window from the label Tauri gives it', () => {
    mockWindows('file-3');
    expect(windowLabel()).toBe('file-3');
    expect(isFileWindowLabel()).toBe(true);
    mockWindows('main');
    expect(isFileWindowLabel()).toBe(false);
  });

  it('passes the file commands their arguments', async () => {
    const calls = backend();
    expect(await fileInfo()).toEqual({
      ok: true,
      value: { name: 'note.md', kind: 'page', folder: '/d', vault: null },
    });
    await fileRename('Better.md');
    await fileFollow('Other.md');
    await fileOpenInVault();
    expect(await fileOpenDialog()).toEqual({ ok: true, value: ['a.png'] });
    expect(calls).toEqual([
      ['file_info', {}],
      ['file_rename', { newName: 'Better.md' }],
      ['file_follow', { path: 'Other.md' }],
      ['file_open_in_vault', {}],
      ['file_open_dialog', {}],
    ]);
  });

  it("sends the page commands to the window's own file, never a path to write", async () => {
    const calls = backend();
    setFileWindow('note.md');
    await pageRead('note.md');
    await textRead('note.md');
    await pageRead('Other.md'); // an embed: read only
    await pageWrite('note.md', 'new', 'h');
    await textWrite('note.md', 'new', 'h');
    await pageCreateConflictCopy('note.md', 'theirs');
    await entryCreatePage('', 'note');
    await entryCreateText('', 'note.md');
    await linksResolve('note.md', [{ kind: 'wiki', target: 'Other' }]);
    expect(calls).toEqual([
      ['file_read', {}],
      ['file_read', {}],
      ['file_note_read', { path: 'Other.md' }],
      ['file_write', { text: 'new', expectedHash: 'h' }],
      ['file_write', { text: 'new', expectedHash: 'h' }],
      ['file_conflict_copy', { text: 'theirs' }],
      ['file_recreate', {}],
      ['file_recreate', {}],
      ['file_links_resolve', { targets: [{ kind: 'wiki', target: 'Other' }] }],
    ]);
    // Writing anything else is refused before it reaches Rust.
    const other = await pageWrite('Other.md', 'x', 'h');
    expect(other.ok).toBe(false);
    expect(calls).toHaveLength(9);
  });

  it('has no outside files and no vault pages to suggest in a file window', async () => {
    const calls = backend();
    setFileWindow('note.md');
    expect(await linksExternal('note.md', [{ kind: 'markdown', target: '/etc/x.png' }])).toEqual({
      ok: true,
      value: [null],
    });
    expect(await linkSuggest('note.md', 'a', false)).toEqual({ ok: true, value: [] });
    expect(calls).toEqual([]);
  });

  it('leaves the main window on the vault commands', async () => {
    const calls = backend();
    await pageRead('A.md');
    await linksResolve('A.md', []);
    expect(calls.map(([c]) => c)).toEqual(['page_read', 'links_resolve']);
  });
});
