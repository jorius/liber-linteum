import i18next from 'i18next';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';

/** Takes an earlier session left behind are in the vault now (batch 6
 *  review C1): say where, until dismissed. Also after an unlock (E4). */
export function announceRecovered(paths: string[]): void {
  if (!paths.length) return;
  useToastStore.getState().push({
    message: i18next.t('audio.recovered', { count: paths.length }),
    detail: paths,
  });
  void useVaultStore.getState().refreshTree();
}
