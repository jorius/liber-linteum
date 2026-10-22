// The page's side of the app menu's shell items (M5b §2.1, §2.5, §6), and the
// same actions for the vault menu and the shortcuts.
import {
  isTauri,
  onMenuSave,
  onMenuSettings,
  onMenuSidebar,
  onMenuVault,
  pickFolder,
} from '../../ipc';
import { openNewVault } from '../encryption/CreateEncryptedHost';
import { openDecryptInPlace } from '../encryption/decryptInPlace';
import { openEncryptInPlace } from '../encryption/encryptInPlace';
import { useEditorStore } from '../../stores/editorStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { refuseWhileConverting, useVaultStore } from '../../stores/vaultStore';

/** Settings shows in the shell: on Welcome or Unlock it would be an unseen
 *  dialog that refuses the next one. A sticky dialog refuses it itself. */
export const openSettings = () => {
  if (useVaultStore.getState().status === 'open') openSettingsHere();
};

/** A file window: Settings always shows. */
const openSettingsHere = () => void useUiStore.getState().openDialog({ type: 'settings' });

/** Another vault, through the folder dialog (as ⌘O). */
export const openAnotherVault = () => {
  if (refuseWhileConverting()) return;
  void pickFolder()
    .catch(() => null)
    .then((path) => (path ? useVaultStore.getState().open(path) : undefined));
};

/** Vault → Encrypt "<name>"… (and the sidebar's vault menu): the open plain
 *  vault, where it is. */
export const encryptThisVault = () => {
  const { status, info } = useVaultStore.getState();
  if (status === 'open' && info && !info.encrypted && !info.scratchpad)
    void openEncryptInPlace(info.root);
};

/** Vault → Decrypt "<name>"… (and the sidebar's vault menu): the open
 *  encrypted vault, where it is (encryption UX §10.1). */
export const decryptThisVault = () => openDecryptInPlace();

export const closeVault = () => void useVaultStore.getState().close();

export const toggleSidebar = () => {
  const { settings, update } = useSettingsStore.getState();
  const collapsing = !settings.sidebarCollapsed;
  const active = document.activeElement;
  // The keyboard follows the toggle when the sidebar it was in goes, and
  // back when it returns (final review I5).
  const move = collapsing
    ? !!active?.closest('aside')
    : active === document.body || !!active?.closest('[data-sidebar-toggle]');
  void update({ sidebarCollapsed: collapsing }).then((res) => {
    if (res.ok && move) {
      setTimeout(() => document.querySelector<HTMLElement>('[data-sidebar-toggle]')?.focus());
    }
  });
};

/** ⌘S / File → Save: the current page, now (with auto save off, the only
 *  way it is written, M5b §6). */
export const saveNow = () => void useEditorStore.getState().doc?.flush();

/** Settings and Save act on this window; the vault items and the sidebar only
 *  on the main one (file windows have neither). Returns the unsubscribe. */
export async function installShellMenu({ main }: { main: boolean }): Promise<() => void> {
  const stops = await Promise.all([
    onMenuSettings(main ? openSettings : openSettingsHere),
    onMenuSave(saveNow),
    ...(main
      ? [
          onMenuVault((what) => {
            if (what === 'open') openAnotherVault();
            else if (what === 'close') closeVault();
            else if (what === 'new') void openNewVault();
            else if (what === 'encrypt') encryptThisVault();
            else if (what === 'decrypt') decryptThisVault();
            else if (what === 'lock') void useVaultStore.getState().lock('menu');
          }),
          onMenuSidebar(toggleSidebar),
        ]
      : []),
  ]);
  return () => stops.forEach((stop) => stop());
}

export function installShellMenuIfTauri(main: boolean): void {
  if (isTauri()) void installShellMenu({ main }).catch(() => undefined);
}

/** ⌘S / Ctrl+S saves the current page in every window (M5b §6), where there
 *  is no app menu too; the webview never gets to "save the page" itself.
 *  Returns the stop. */
export function installSaveKey(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() !== 's' && e.code !== 'KeyS') return;
    e.preventDefault();
    saveNow();
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
