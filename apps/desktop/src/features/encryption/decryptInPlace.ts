import { useEffect } from 'react';
import { menuSetDecryptItem, onDecryptRecovered } from '../../ipc';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useRecoveredToasts } from './encryptInPlace';

/** Decrypt the open encrypted vault where it is (encryption UX §10): from
 *  Vault → Decrypt "<name>"… and the sidebar's vault menu. */
export function openDecryptInPlace(): void {
  const { status, info } = useVaultStore.getState();
  if (status !== 'open' || !info?.encrypted || info.scratchpad) return;
  useUiStore.getState().openDialog({ type: 'decryptInPlace', root: info.root });
}

/** Keeps Vault → Decrypt "<name>"… named after the open encrypted vault,
 *  and off for a plain one, the Quick notes vault, and once the shell goes. */
export function useDecryptMenuItem(): void {
  const name = useVaultStore((s) =>
    s.info && s.info.encrypted && !s.info.scratchpad ? s.info.name : null,
  );
  useEffect(() => void menuSetDecryptItem(name), [name]);
  useEffect(() => () => void menuSetDecryptItem(null), []);
}

/** Toasts an interrupted decryption that an open finished or undid. */
export function useDecryptRecovered(): void {
  useRecoveredToasts(onDecryptRecovered, 'decryptInPlace');
}
