import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  entryRename,
  ipcCall,
  onVaultChanged,
  onVaultProgress,
  pageGet,
  pickFolder,
  settingsSet,
  toCommandError,
  vaultOpen,
  vaultTree,
} from './index';

afterEach(() => clearMocks());

describe('M1b ipc commands', () => {
  it('passes camelCase arguments and returns ok results', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'vault_open') return { name: 'V', root: '/v', report: { pages: 1 } };
      if (cmd === 'entry_rename')
        return { moved: [], updatedFiles: ['a.md'], updatedLinks: 2, failed: [] };
      if (cmd === 'settings_set') return { theme: 'dark' };
    });
    expect(await vaultOpen('/v')).toEqual({
      ok: true,
      value: { name: 'V', root: '/v', report: { pages: 1 } },
    });
    const renamed = await entryRename('a.md', 'b/a.md');
    expect(renamed.ok && renamed.value.updatedLinks).toBe(2);
    await settingsSet({ theme: 'dark' });
    expect(calls).toEqual([
      ['vault_open', { path: '/v' }],
      ['entry_rename', { from: 'a.md', to: 'b/a.md' }],
      ['settings_set', { patch: { theme: 'dark' } }],
    ]);
  });

  it('turns thrown backend errors into typed results, never exceptions', async () => {
    mockIPC((cmd) => {
      if (cmd === 'vault_tree') throw { kind: 'noVault', message: 'no vault is open' };
      if (cmd === 'page_get') throw 'plain string failure';
    });
    expect(await vaultTree()).toEqual({
      ok: false,
      error: { kind: 'noVault', message: 'no vault is open' },
    });
    expect(await pageGet('x.md')).toEqual({
      ok: false,
      error: { kind: 'io', message: 'plain string failure' },
    });
    expect(await ipcCall(() => Promise.reject(new Error('boom')))).toEqual({
      ok: false,
      error: { kind: 'io', message: 'boom' },
    });
    expect(toCommandError({ kind: 42 })).toEqual({ kind: 'io', message: '[object Object]' });
  });

  it('subscribes to vault events', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true });
    const progress: unknown[] = [];
    const changed: unknown[] = [];
    const un1 = await onVaultProgress((p) => progress.push(p));
    const un2 = await onVaultChanged((c) => changed.push(c));
    await emit('vault:progress', { done: 1, total: 2 });
    await emit('vault:changed', { created: ['a.md'], modified: [], removed: [], renamed: [] });
    expect(progress).toEqual([{ done: 1, total: 2 }]);
    expect(changed).toEqual([{ created: ['a.md'], modified: [], removed: [], renamed: [] }]);
    un1();
    un2();
    await emit('vault:progress', { done: 2, total: 2 });
    expect(progress).toHaveLength(1);
  });

  it('picks a folder through the dialog plugin', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'plugin:dialog|open') return '/Users/ana/Notes';
    });
    expect(await pickFolder()).toBe('/Users/ana/Notes');
    expect(calls[0][0]).toBe('plugin:dialog|open');
    expect((calls[0][1] as { options: { directory: boolean } }).options.directory).toBe(true);
    mockIPC(() => null);
    expect(await pickFolder()).toBeNull();
  });
});
