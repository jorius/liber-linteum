import i18next from 'i18next';
import { useEffect } from 'react';
import { menuSetEncryptItem } from '../../ipc';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';

/** Encrypt the plain vault at `path` where it is (UX round §4): from Vault →
 *  Encrypt "<name>"…, the sidebar's vault menu and the New vault dialog.
 *  shortcut: replaced by the convert flow task (§4.2); until then it only says so. */
export const openEncryptInPlace: (path: string) => void = () => {
  useToastStore.getState().push({ message: i18next.t('newVault.encryptSoon') });
};

/** Keeps Vault → Encrypt "<name>"… named after the open plain vault, and off
 *  for an encrypted one, the Quick notes vault, and once the shell goes. */
export function useEncryptMenuItem(): void {
  const name = useVaultStore((s) =>
    s.info && !s.info.encrypted && !s.info.scratchpad ? s.info.name : null,
  );
  useEffect(() => void menuSetEncryptItem(name), [name]);
  useEffect(() => () => void menuSetEncryptItem(null), []);
}
