// Favorites (M5b §19): the vault's ordered list, kept by Rust in
// `.nimw/vault.json` (it follows renames, the Trash and the Archive there).
import { create } from 'zustand';
import { favoritesGet, favoritesSet, type TreeNode } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';

interface FavoritesState {
  /** Every entry, those in the Trash or the Archive too (they come back). */
  paths: string[];
  load: () => Promise<void>;
  toggle: (path: string) => Promise<void>;
  /** Moves `path` to just before `before` (`null`: the end). */
  move: (path: string, before: string | null) => Promise<void>;
}

/** The favorites to show: entries in the tree (none in the Trash or the
 *  Archive, none missing), in order. */
export function shownFavorites(paths: string[], nodes: TreeNode[]): TreeNode[] {
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  return paths.flatMap((p) => {
    const node = byPath.get(p);
    const binned = p.startsWith('.trash/') || p.startsWith('.archive/');
    return node && !binned && node.kind !== 'attachment' ? [node] : [];
  });
}

export const useFavoritesStore = create<FavoritesState>((set, get) => {
  const save = async (next: string[]) => {
    set({ paths: next });
    const res = await favoritesSet(next);
    if (res.ok) set({ paths: Array.isArray(res.value) ? res.value : next });
    else {
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      await get().load();
    }
  };
  return {
    paths: [],
    load: async () => {
      if (!useVaultStore.getState().info) {
        set({ paths: [] });
        return;
      }
      const res = await favoritesGet();
      set({ paths: res.ok && Array.isArray(res.value) ? res.value : [] });
    },
    toggle: (path) => {
      const paths = get().paths;
      return save(paths.includes(path) ? paths.filter((p) => p !== path) : [...paths, path]);
    },
    move: (path, before) => {
      const rest = get().paths.filter((p) => p !== path);
      const at = before === null ? rest.length : rest.indexOf(before);
      rest.splice(at < 0 ? rest.length : at, 0, path);
      return save(rest);
    },
  };
});

/** Moves a shown favorite one place up (-1) or down (+1) among the shown ones. */
export function nudgeFavorite(path: string, step: -1 | 1) {
  const { paths, move } = useFavoritesStore.getState();
  const shown = shownFavorites(paths, useVaultStore.getState().nodes).map((n) => n.path);
  const i = shown.indexOf(path);
  if (i < 0 || i + step < 0 || i + step >= shown.length) return;
  void move(path, step < 0 ? shown[i - 1] : (shown[i + 2] ?? null));
}

// Renames, moves, the Trash and another vault change the list in Rust: read
// it again whenever the tree or the vault changes.
useVaultStore.subscribe((s, prev) => {
  if (s.nodes !== prev.nodes || s.info !== prev.info) void useFavoritesStore.getState().load();
});
