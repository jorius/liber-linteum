import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, emit, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { openNewVault } from '../encryption/CreateEncryptedHost';
import { openEncryptInPlace } from '../encryption/encryptInPlace';
import { installSaveKey, installShellMenu, openSettings } from './shellMenu';
import { useEditorStore } from '../../stores/editorStore';

const prompt = vi.hoisted(() => ({ needs: false, answer: true, order: [] as string[] }));
vi.mock('../encryption/encryptInPlace', () => ({ openEncryptInPlace: vi.fn() }));
vi.mock('../editor/unsavedPrompt', () => ({
  needsUnsavedPrompt: () => prompt.needs,
  confirmUnsaved: async () => {
    prompt.order.push('prompt');
    return prompt.answer;
  },
}));

let calls: { cmd: string; args: unknown }[];

beforeEach(() => {
  calls = [];
  Object.assign(prompt, { needs: false, answer: true, order: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useUiStore.setState({ dialog: null });
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'settings_set') {
        const patch = (args as { patch: Record<string, unknown> }).patch;
        return { ...useSettingsStore.getState().settings, ...patch };
      }
      if (cmd === 'plugin:dialog|open') {
        prompt.order.push('picker');
        return '/v/new';
      }
      return null;
    },
    { shouldMockEvents: true },
  );
});
afterEach(() => clearMocks());

describe('M5b §2.1, §2.5: the app menu items the page answers', () => {
  it('Settings… opens the Settings dialog (menu:settings), over Search too', async () => {
    useVaultStore.setState({ status: 'open' });
    useUiStore.getState().openDialog({ type: 'search' });
    const stop = await installShellMenu({ main: true });
    await emit('menu:settings', null);
    await vi.waitFor(() => expect(useUiStore.getState().dialog).toEqual({ type: 'settings' }));
    stop();
    useVaultStore.setState({ status: 'closed' });
  });

  it('Settings… does nothing on Welcome or Unlock, where it isn’t shown', async () => {
    const stop = await installShellMenu({ main: true });
    for (const status of ['closed', 'locked'] as const) {
      useVaultStore.setState({ status });
      openSettings();
      await emit('menu:settings', null);
      expect(useUiStore.getState().dialog).toBeNull();
    }
    stop();
    useVaultStore.setState({ status: 'closed' });
  });

  it('New Vault takes the place of a non-sticky dialog', async () => {
    useUiStore.getState().openDialog({ type: 'search' });
    await openNewVault();
    expect(useUiStore.getState().dialog).toEqual({ type: 'newVault' });
  });

  it('Vault → Close Vault closes the vault; Open Vault… asks for a folder', async () => {
    const close = vi.fn(async () => undefined);
    useVaultStore.setState({ close });
    const stop = await installShellMenu({ main: true });
    await emit('menu:vault', 'close');
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await emit('menu:vault', 'open');
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'plugin:dialog|open')).toBe(true));
    stop();
  });

  it('Vault → New Vault… opens the New vault dialog (it picks the folder itself)', async () => {
    const stop = await installShellMenu({ main: true });
    await emit('menu:vault', 'new');
    await vi.waitFor(() => expect(useUiStore.getState().dialog).toEqual({ type: 'newVault' }));
    useUiStore.setState({ dialog: null });
    stop();
  });

  it('Vault → Encrypt “<name>”… encrypts the open plain vault, nothing else', async () => {
    const stop = await installShellMenu({ main: true });
    const info = { name: 'Notes', root: '/v/Notes', report: {} as never };
    for (const state of [
      { status: 'closed' as const, info: null },
      { status: 'open' as const, info: { ...info, encrypted: true } },
      { status: 'locked' as const, info },
    ]) {
      useVaultStore.setState(state);
      await emit('menu:vault', 'encrypt');
    }
    expect(openEncryptInPlace).not.toHaveBeenCalled();
    useVaultStore.setState({ status: 'open', info });
    await emit('menu:vault', 'encrypt');
    await vi.waitFor(() => expect(openEncryptInPlace).toHaveBeenCalledWith('/v/Notes'));
    useVaultStore.setState({ status: 'closed', info: null });
    stop();
  });

  it('Vault → New Encrypted Vault… is gone: its old payload does nothing', async () => {
    const stop = await installShellMenu({ main: true });
    await emit('menu:vault', 'newEncrypted');
    await new Promise((r) => setTimeout(r, 10));
    expect(useUiStore.getState().dialog).toBeNull();
    expect(calls.map((c) => c.cmd)).not.toContain('plugin:dialog|open');
    stop();
  });

  it('View → Toggle Sidebar flips sidebarCollapsed (menu:sidebar)', async () => {
    const stop = await installShellMenu({ main: true });
    await emit('menu:sidebar', null);
    await vi.waitFor(() =>
      expect(useSettingsStore.getState().settings.sidebarCollapsed).toBe(true),
    );
    stop();
  });

  it('a file window answers Settings, never the vault or sidebar items', async () => {
    const close = vi.fn(async () => undefined);
    useVaultStore.setState({ close });
    const stop = await installShellMenu({ main: false });
    await emit('menu:vault', 'close');
    await emit('menu:sidebar', null);
    await emit('menu:settings', null);
    await vi.waitFor(() => expect(useUiStore.getState().dialog).toEqual({ type: 'settings' }));
    expect(close).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.cmd === 'settings_set')).toEqual([]);
    stop();
  });
});

describe('⌘S (M5b §6)', () => {
  it('saves the current page, in every window, and keeps the browser from saving', () => {
    const flush = vi.fn(async () => undefined);
    useEditorStore.setState({ doc: { flush } as never });
    const stop = installSaveKey();
    const e = new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true });
    window.dispatchEvent(e);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, shiftKey: true }));
    expect(flush).toHaveBeenCalledTimes(1);
    stop();
    useEditorStore.setState({ doc: null });
  });
});

describe('E4 Task 4 review', () => {
  it('asks about unsaved text before the New vault dialog opens', async () => {
    prompt.needs = true;
    await openNewVault();
    expect(prompt.order).toEqual(['prompt']);
    expect(useUiStore.getState().dialog).toEqual({ type: 'newVault' });
  });

  it('Cancel on the unsaved question opens nothing', async () => {
    Object.assign(prompt, { needs: true, answer: false });
    await openNewVault();
    expect(prompt.order).toEqual(['prompt']);
    expect(useUiStore.getState().dialog).toBeNull();
  });

  it('Settings never replaces a create dialog holding its code', () => {
    useVaultStore.setState({ status: 'open' });
    useUiStore.setState({ dialog: { type: 'newVault' }, held: true });
    openSettings();
    expect(useUiStore.getState().dialog).toEqual({ type: 'newVault' });
    useUiStore.getState().closeDialog();
    useVaultStore.setState({ status: 'closed' });
  });
});
