import { folderPageOf, isArchived, joinPath, nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';

/** Drop-target id for the vault root (dnd-kit ids can't be empty). */
export const ROOT_DROP_ID = '__vault_root__';

/** Whether `path` is a page in the open vault (round 3 §9.3: pages are targets). */
const isPage = (path: string) =>
  useVaultStore.getState().nodes.some((n) => n.path === path && n.kind === 'page');

/** The folder a page target heads: its own folder for a folder page, else the
 *  folder of its name next to it (made when the drop runs). */
function folderOf(page: string): string {
  const dir = parentOf(page);
  return folderPageOf(dir, useVaultStore.getState().children) === page
    ? dir
    : joinPath(dir, nameOf(page).replace(/\.md$/i, ''));
}

/** Destination path for dropping `from` into folder `target` (`''` = root) or
 * under page `target`, or `null` when the drop is not allowed: onto itself,
 * into its current folder, into its own descendant, or (for a page target)
 * into or out of the Archive. */
export function planDrop(from: string, target: string): string | null {
  if (target === from) return null;
  if (isPage(target)) {
    if (isArchived(target) || isArchived(from)) return null;
    target = folderOf(target);
  }
  if (target === from || target.startsWith(`${from}/`)) return null;
  if (parentOf(from) === target) return null;
  return joinPath(target, nameOf(from));
}

/** Performs a drop through the store (rename = move; a page target becomes a
 *  folder page first). Returns whether it ran. */
export async function dropEntry(from: string, target: string): Promise<boolean> {
  if (!planDrop(from, target)) return false;
  const vault = useVaultStore.getState();
  const res = isPage(target)
    ? await vault.moveUnder(from, target)
    : await vault.rename(from, joinPath(target, nameOf(from)));
  return res.ok;
}
