// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks, emit, mockIPC } from '../../ipc/testing';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { openEncryptInPlace, useEncryptMenuItem, useEncryptRecovered } from './encryptInPlace';

afterEach(() => {
  useVaultStore.setState({ status: 'closed', info: null });
  useUiStore.getState().closeDialog();
  useToastStore.getState().clear();
  clearMocks();
});

const info = { name: 'Smartjob', root: '/v/Smartjob', report: {} as never };

describe('Encrypt "<name>"… (UX round §4.1)', () => {
  it('opens the encrypt dialog for a vault folder', async () => {
    mockIPC((cmd) => (cmd === 'folder_kind' ? 'plain' : null));
    await openEncryptInPlace('/v/Smartjob');
    expect(useUiStore.getState().dialog).toEqual({ type: 'encryptInPlace', root: '/v/Smartjob' });
  });

  it.each([
    ['/Users/jose/Documents', 'Encrypt a vault folder, not Documents.'],
    ['/Users/jose', 'Encrypt a vault folder, not jose.'],
    ['/', 'Encrypt a vault folder, not /.'],
    ['C:\\Users\\jose\\Desktop', 'Encrypt a vault folder, not Desktop.'],
  ])('a refused folder (%s, §8.10) gets no dialog, a toast saying why', async (path, text) => {
    mockIPC((cmd) => (cmd === 'folder_kind' ? 'refused' : null));
    await openEncryptInPlace(path);
    expect(useUiStore.getState().dialog).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(text);
  });

  it('a folder another device is converting gets no dialog, its error toasted', async () => {
    mockIPC((cmd) => {
      if (cmd === 'folder_kind') throw { kind: 'convertingElsewhere', message: 'x' };
    });
    await openEncryptInPlace('/v/Smartjob');
    expect(useUiStore.getState().dialog).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/another device/);
  });

  it('the menu item names the open plain vault, and is off for an encrypted one, the Quick notes vault and none', () => {
    const sent: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'menu_set_encrypt_item') sent.push((args as { vault: unknown }).vault);
    });
    act(() => useVaultStore.setState({ status: 'open', info }));
    const hook = renderHook(() => useEncryptMenuItem());
    expect(sent).toEqual(['Smartjob']);
    act(() => useVaultStore.setState({ info: { ...info, name: 'Other', root: '/v/Other' } }));
    expect(sent).toEqual(['Smartjob', 'Other']);
    act(() => useVaultStore.setState({ info: { ...info, encrypted: true } }));
    expect(sent.at(-1)).toBeNull();
    act(() => useVaultStore.setState({ info: { ...info, scratchpad: true } }));
    expect(sent.at(-1)).toBeNull();
    act(() => useVaultStore.setState({ info }));
    expect(sent.at(-1)).toBe('Smartjob');
    // The shell going (Welcome, Unlock) turns it off.
    hook.unmount();
    expect(sent.at(-1)).toBeNull();
  });
});

describe('an interrupted conversion, recovered on open', () => {
  it('toasts what happened to it', async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const hook = renderHook(() => useEncryptRecovered());
    await act(() => new Promise((r) => setTimeout(r)));
    await act(() =>
      emit('vault:encrypt-recovered', { path: '/v/Smartjob', outcome: 'rolledBack' }),
    );
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      'Encrypting “Smartjob” was interrupted; the vault is back as it was.',
    );
    await act(() => emit('vault:encrypt-recovered', { path: '/v/Smartjob', outcome: 'finished' }));
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Finished encrypting “Smartjob”.');
    hook.unmount();
  });

  it('heard while a vault opens, it is toasted once the open is over (leaving a vault clears toasts)', async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const hook = renderHook(() => useEncryptRecovered());
    await act(() => new Promise((r) => setTimeout(r)));
    act(() => useVaultStore.setState({ status: 'opening' }));
    await act(() => emit('vault:encrypt-recovered', { path: '/v/Smartjob', outcome: 'finished' }));
    useToastStore.getState().clear();
    expect(useToastStore.getState().toasts).toEqual([]);
    act(() => useVaultStore.setState({ status: 'locked' }));
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Finished encrypting “Smartjob”.');
    hook.unmount();
  });
});
