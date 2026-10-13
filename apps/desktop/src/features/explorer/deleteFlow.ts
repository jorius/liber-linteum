import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

/** Delete with confirmation (spec §4.2), or straight to Trash when the
 * `confirmDelete` setting is off. */
export function requestDelete(path: string) {
  if (useSettingsStore.getState().settings.confirmDelete) {
    useUiStore.getState().openDialog({ type: 'delete', path });
  } else {
    void useVaultStore.getState().trash(path);
  }
}
