import { usePageStore } from './pageStore';
import { parentOf } from './tree';
import { useVaultStore } from './vaultStore';

/** Opens a page the app just created (the watcher doesn't report our own
 *  writes, so the tree is refreshed first). */
export async function openNewPage(path: string): Promise<void> {
  await useVaultStore.getState().refreshTree();
  await openPage(path);
}

/** Opens a page from anywhere (links, toasts): reveals and selects it in the
 *  explorer and shows it, scrolled to `heading` if given. */
export async function openPage(path: string, heading?: string | null): Promise<void> {
  const vault = useVaultStore.getState();
  const dir = parentOf(path);
  if (dir) vault.expand(dir);
  vault.select(path);
  await usePageStore.getState().load(path);
  usePageStore.getState().reveal(heading ?? null);
}
