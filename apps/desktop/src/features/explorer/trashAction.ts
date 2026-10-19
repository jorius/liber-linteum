import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

/** Move to the vault's Trash (M5b §5.1): with the confirmation dialog, or
 *  straight away when the `confirmDelete` setting is off. */
export function requestTrash(path: string) {
  if (useSettingsStore.getState().settings.confirmDelete) {
    useUiStore.getState().openDialog({ type: 'delete', path });
  } else {
    void useVaultStore.getState().trash(path);
  }
}
