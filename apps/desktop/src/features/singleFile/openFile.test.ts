import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useToastStore } from '../../stores/toastStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { onOpenFileKey, openFileDialog, openInVault } from './openFile';

function backend(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: string[] = [];
  mockIPC((cmd, args) => {
    calls.push(cmd);
    return handlers[cmd]?.((args ?? {}) as Record<string, unknown>);
  });
  return calls;
}

afterEach(async () => {
  useToastStore.setState({ toasts: [] });
  await resetVaultStore();
  clearMocks();
});

describe('M4c Open File… and Open in its vault', () => {
  it('names the picks it could not open', async () => {
    backend({ file_open_dialog: () => ['photo.png'] });
    await openFileDialog();
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.message).toBe('This file opens in other apps, not here.');
    expect(toast?.detail).toEqual(['photo.png']);
  });

  it('Ctrl+⇧O runs it; Ctrl+O (open a vault) does not', async () => {
    const calls = backend({ file_open_dialog: () => [] });
    const key = (init: KeyboardEventInit) =>
      new KeyboardEvent('keydown', { cancelable: true, ...init });
    const plain = key({ key: 'o', ctrlKey: true });
    onOpenFileKey(plain);
    expect(plain.defaultPrevented).toBe(false);
    const shifted = key({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true });
    onOpenFileKey(shifted);
    expect(shifted.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(calls).toEqual(['file_open_dialog']);
  });

  it('opens the vault (unless it is open) and shows the page', async () => {
    const info = { name: 'Notes', root: '/v/Notes', report: { pages: 1, warnings: [] } };
    const calls = backend({
      vault_open: () => info,
      vault_tree: () => [{ path: 'Daily/note.md', kind: 'page' }],
      page_read: () => ({ text: '# n\n', hash: 'h' }),
      page_get: () => ({ path: 'Daily/note.md', title: 'note', tags: [], text: '' }),
    });
    await openInVault('/v/Notes', 'Daily/note.md');
    expect(useVaultStore.getState().info?.root).toBe('/v/Notes');
    expect(calls).toContain('page_get');
    calls.length = 0;
    await openInVault('/v/Notes', 'Daily/note.md');
    expect(calls).not.toContain('vault_open');
  });
});
