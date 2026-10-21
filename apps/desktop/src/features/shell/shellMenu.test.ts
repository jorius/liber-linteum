import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, emit, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { installSaveKey, installShellMenu, newEncryptedVault, openSettings } from './shellMenu';
import { useEditorStore } from '../../stores/editorStore';

const prompt = vi.hoisted(() => ({ needs: false, answer: true, order: [] as string[] }));
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
  it('Settings… opens the Settings dialog (menu:settings)', async () => {
    const stop = await installShellMenu({ main: true });
    await emit('menu:settings', null);
    await vi.waitFor(() => expect(useUiStore.getState().dialog).toEqual({ type: 'settings' }));
    stop();
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

  it('Vault → New Encrypted Vault… picks a folder, then opens the create dialog', async () => {
    mockIPC((cmd) => (cmd === 'plugin:dialog|open' ? '/v/new' : undefined), {
      shouldMockEvents: true,
    });
    const stop = await installShellMenu({ main: true });
    await emit('menu:vault', 'newEncrypted');
    await vi.waitFor(() =>
      expect(useUiStore.getState().dialog).toEqual({ type: 'createEncrypted', path: '/v/new' }),
    );
    useUiStore.setState({ dialog: null });
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
  it('asks about unsaved text before the folder picker, so no question replaces the dialog', async () => {
    prompt.needs = true;
    await newEncryptedVault();
    expect(prompt.order).toEqual(['prompt', 'picker']);
    expect(useUiStore.getState().dialog).toEqual({ type: 'createEncrypted', path: '/v/new' });
  });

  it('Cancel on the unsaved question stops before the picker', async () => {
    Object.assign(prompt, { needs: true, answer: false });
    await newEncryptedVault();
    expect(prompt.order).toEqual(['prompt']);
    expect(useUiStore.getState().dialog).toBeNull();
  });

  it('Settings never replaces an open dialog', () => {
    useUiStore.setState({ dialog: { type: 'createEncrypted', path: '/v/new' } });
    openSettings();
    expect(useUiStore.getState().dialog).toEqual({ type: 'createEncrypted', path: '/v/new' });
  });
});
