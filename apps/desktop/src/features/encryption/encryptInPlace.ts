import i18next from 'i18next';
import { useEffect } from 'react';
import {
  folderKind,
  menuSetEncryptItem,
  onEncryptRecovered,
  type EncryptRecoveredPayload,
} from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { elsewhereAction, useVaultStore } from '../../stores/vaultStore';
import { quietly } from '../scratchpad/ScratchpadHost';

/** A folder's own name (either separator); a volume root is its path. */
export const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path;

/** "Encrypt a vault folder, not <folder>." (§8.10) */
export const refusedText = (path: string) =>
  i18next.t('encryptInPlace.refused', { folder: folderName(path) });

/** Encrypt the plain vault at `path` where it is (UX round §4, §8): from
 *  Vault → Encrypt "<name>"…, the sidebar's vault menu and the New vault
 *  dialog. A folder never encrypted in place gets a toast, not the dialog. */
export async function openEncryptInPlace(path: string): Promise<void> {
  const kind = await folderKind(path);
  const toast = useToastStore.getState();
  if (!kind.ok) {
    const undo = elsewhereAction(kind.error.kind, path);
    toast.push({ message: errorMessage(kind.error), tone: 'error', action: undo });
  } else if (kind.value === 'refused') toast.push({ message: refusedText(path), tone: 'error' });
  else useUiStore.getState().openDialog({ type: 'encryptInPlace', root: path });
}

/** Keeps Vault → Encrypt "<name>"… named after the open plain vault, and off
 *  for an encrypted one, the Quick notes vault, and once the shell goes. */
export function useEncryptMenuItem(): void {
  const name = useVaultStore((s) =>
    s.info && !s.info.encrypted && !s.info.scratchpad ? s.info.name : null,
  );
  useEffect(() => void menuSetEncryptItem(name), [name]);
  useEffect(() => () => void menuSetEncryptItem(null), []);
}

/** Toasts an interrupted conversion that an open finished or undid. Heard
 *  while a vault opens, it waits for the open to end: leaving the vault on
 *  screen clears toasts. */
export function useEncryptRecovered(): void {
  useRecoveredToasts(onEncryptRecovered, 'encryptInPlace');
}

/** [`useEncryptRecovered`] for either direction: `ns.finished` or
 *  `ns.interrupted`, heard through `subscribe`. */
export function useRecoveredToasts(
  subscribe: (cb: (p: EncryptRecoveredPayload) => void) => Promise<() => void>,
  ns: 'encryptInPlace' | 'decryptInPlace',
): void {
  useEffect(() => {
    let waiting: string[] = [];
    const flush = () => {
      waiting.forEach((message) => useToastStore.getState().push({ message }));
      waiting = [];
    };
    const unsubscribe = useVaultStore.subscribe((s) => s.status !== 'opening' && flush());
    let stopped = false;
    let stop: (() => void) | null = null;
    subscribe(({ path, outcome }) => {
      const key = outcome === 'finished' ? 'finished' : 'interrupted';
      waiting.push(i18next.t(`${ns}.${key}`, { name: folderName(path) }));
      if (useVaultStore.getState().status !== 'opening') flush();
    })
      .then((s) => (stopped ? quietly(s) : (stop = s)))
      .catch(() => undefined);
    return () => {
      stopped = true;
      if (stop) quietly(stop);
      unsubscribe();
    };
  }, [subscribe, ns]);
}
