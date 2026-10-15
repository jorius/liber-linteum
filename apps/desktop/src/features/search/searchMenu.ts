// View → Search… (M5 §4): the menu says `menu:search`; the search dialog
// opens over whatever shows, while a vault is open.
import { isTauri, onMenuSearch } from '../../ipc';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

export function openSearch(): void {
  if (useVaultStore.getState().status !== 'open') return;
  useUiStore.getState().openDialog({ type: 'search' });
}

export function installSearchMenuIfTauri(): void {
  if (!isTauri()) return;
  void onMenuSearch(openSearch).catch(() => undefined);
}
