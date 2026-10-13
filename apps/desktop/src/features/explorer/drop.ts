import { joinPath, nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';

/** Drop-target id for the vault root (dnd-kit ids can't be empty). */
export const ROOT_DROP_ID = '__vault_root__';

/** Destination path for dropping `from` into folder `target` (`''` = root), or
 * `null` when the drop is not allowed: onto itself, into its current folder,
 * or into its own descendant. */
export function planDrop(from: string, target: string): string | null {
  if (target === from || target.startsWith(`${from}/`)) return null;
  if (parentOf(from) === target) return null;
  return joinPath(target, nameOf(from));
}

/** Performs a drop through the store (rename = move). Returns whether it ran. */
export async function dropEntry(from: string, target: string): Promise<boolean> {
  const to = planDrop(from, target);
  if (!to) return false;
  const res = await useVaultStore.getState().rename(from, to);
  return res.ok;
}
