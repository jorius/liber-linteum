// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { openEncryptInPlace, useEncryptMenuItem } from './encryptInPlace';

afterEach(() => {
  useVaultStore.setState({ status: 'closed', info: null });
  useToastStore.getState().clear();
  clearMocks();
});

const info = { name: 'Smartjob', root: '/v/Smartjob', report: {} as never };

describe('Encrypt "<name>"… (UX round §4.1)', () => {
  it('the stub says the convert flow is next', () => {
    openEncryptInPlace('/v/Smartjob');
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      'Encrypting in place is coming in the next step.',
    );
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
