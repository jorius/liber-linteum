import { folderIconSet, vaultIconSet } from '../../ipc';
import { setFrontmatter } from '../../markdown/frontmatterEdit';
import { errorMessage } from '../../stores/messages';
import { editRelations } from '../../stores/relations';
import { useToastStore } from '../../stores/toastStore';
import { childrenByParent, isArchived } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';

export type IconTarget = { kind: 'page' | 'folder'; path: string } | { kind: 'vault' };

/** Shows `icon` on `path`'s row at once; the next tree refresh (after the
 *  save is indexed) agrees. */
function showOnRow(path: string, icon: string | null) {
  useVaultStore.setState((s) => {
    const nodes = s.nodes.map((n) =>
      n.path !== path ? n : icon ? { ...n, icon } : { path: n.path, kind: n.kind },
    );
    // `children` also holds the Archive's rows, which `nodes` leaves out.
    const archive = [...s.children.values()].flat().filter((n) => isArchived(n.path));
    return { nodes, children: childrenByParent([...nodes, ...archive]) };
  });
}

/** Sets (or, with `null`, removes) an optional emoji icon (M5b §4): a page's
 *  goes in its frontmatter (`icon:`), through its open document or a
 *  compare-and-swap write; a folder's and the vault's in `.nimw/vault.json`. */
export async function setIcon(target: IconTarget, icon: string | null): Promise<boolean> {
  if (target.kind === 'page') {
    const done = await editRelations(target.path, (text) => setFrontmatter(text, { icon }));
    if (done === false) return false;
    showOnRow(target.path, icon);
    return true;
  }
  const res =
    target.kind === 'folder' ? await folderIconSet(target.path, icon) : await vaultIconSet(icon);
  if (!res.ok) {
    useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    return false;
  }
  if (target.kind === 'folder') showOnRow(target.path, icon);
  else
    useVaultStore.setState((s) => ({
      info: s.info ? { ...s.info, icon: icon ?? undefined } : s.info,
    }));
  return true;
}
