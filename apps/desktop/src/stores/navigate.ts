import { usePageStore } from './pageStore';
import { parentOf } from './tree';
import { useVaultStore } from './vaultStore';

/** Opens a page from anywhere (links, toasts): reveals and selects it in the
 *  explorer and shows it. */
export async function openPage(path: string): Promise<void> {
  const vault = useVaultStore.getState();
  const dir = parentOf(path);
  if (dir) vault.expand(dir);
  vault.select(path);
  await usePageStore.getState().load(path);
}
