// View → Search… (M5 §4): the menu says `menu:search`; the search dialog
// opens over whatever shows, while a vault is open.
import { isTauri, onMenuSearch } from '../../ipc';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useSearchStore } from './searchStore';

/** The longest selection that becomes the search text (M5b §7.3). */
const PREFILL_MAX = 80;

/** A short one-line selection in the editor, as ⌘F's search text. */
function editorSelection(): string | null {
  if (!document.activeElement?.closest('.cm-content')) return null;
  const text = document.getSelection()?.toString().trim() ?? '';
  return text && text.length <= PREFILL_MAX && !/[\r\n]/.test(text) ? text : null;
}

/** Opens Search, once: the menu and the page may both answer ⌘F. Like the
 *  page's shortcuts, it waits while another dialog is open. */
export function openSearch(): void {
  if (useVaultStore.getState().status !== 'open') return;
  if (useUiStore.getState().dialog) return;
  const prefill = editorSelection();
  if (prefill) useSearchStore.getState().setText(prefill);
  useUiStore.getState().openDialog({ type: 'search' });
}

export function installSearchMenuIfTauri(): void {
  if (!isTauri()) return;
  void onMenuSearch(openSearch).catch(() => undefined);
}
