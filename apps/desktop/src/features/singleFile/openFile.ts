// Opening files on their own (M4c §3): File → Open File… (⌘⇧O; ⌘O opens a
// folder as a vault), the Welcome screen's "Open a file", and — in the main
// window — a page handed over by a single-file window ("Open in its vault").
import i18next from 'i18next';
import { fileOpenDialog, isTauri, onMenuOpenFile, onOpenInVault } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { openPage } from '../../stores/navigate';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';

/** The OS file dialog (Rust side); each file it can show opens in a window
 *  of its own. Says which picks it couldn't open. */
export async function openFileDialog(): Promise<void> {
  const res = await fileOpenDialog();
  const toasts = useToastStore.getState();
  if (!res.ok) {
    toasts.push({ message: errorMessage(res.error), tone: 'error' });
  } else if (res.value.length) {
    toasts.push({
      message: i18next.t('singleFile.cantOpen', { count: res.value.length }),
      detail: res.value,
      tone: 'error',
    });
  }
}

/** Whether ⌘⇧O is the app menu's (macOS): the page must not run it again. */
const menuHasIt = () => /Mac/i.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);

/** Ctrl+⇧O (⌘⇧O) where there is no app menu. */
export function onOpenFileKey(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
  if (e.key.toLowerCase() !== 'o' && e.code !== 'KeyO') return;
  e.preventDefault();
  void openFileDialog();
}

/** File → Open File… from the menu, and its shortcut elsewhere. */
export function installOpenFile(): void {
  if (!isTauri()) return;
  void onMenuOpenFile(() => void openFileDialog()).catch(() => undefined);
  if (!menuHasIt()) window.addEventListener('keydown', onOpenFileKey);
}

/** Opens `root` (unless it is the open vault) and shows `page`. */
export async function openInVault(root: string, page: string | null): Promise<void> {
  const vault = useVaultStore.getState();
  if (vault.info?.root !== root) {
    // A page asked for wins over the vault's home.
    const res = await vault.open(root, { home: !page });
    if (!res.ok) return;
  }
  if (page) await openPage(page);
}

/** The main window takes pages single-file windows hand over; a main window
 *  made for one finds it in its address. */
export function installOpenInVault(): void {
  const params = new URLSearchParams(window.location.search);
  const root = params.get('vault');
  if (root) void openInVault(root, params.get('page'));
  if (isTauri()) {
    void onOpenInVault(({ root, page }) => void openInVault(root, page)).catch(() => undefined);
  }
}
