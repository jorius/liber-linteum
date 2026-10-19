// Favorites (M5b §19): the vault's ordered list, kept by Rust in
// `.nimw/vault.json` (it follows renames, the Trash and the Archive there).
import i18next from 'i18next';
import { create } from 'zustand';
import { favoritesGet, favoritesSet, type TreeNode } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { announce } from '../editor/announce';
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
  // One save at a time, each applied to the list Rust holds at its turn: a
  // rename there since the last read isn't undone, and saves can't land out of
  // order (round-2 review M8).
  let queue: Promise<void> = Promise.resolve();
  const change = (edit: (paths: string[]) => string[]) => {
    set({ paths: edit(get().paths) }); // shown at once
    const turn = queue.then(async () => {
      const now = await favoritesGet();
      const base = now.ok && Array.isArray(now.value) ? now.value : get().paths;
      const res = await favoritesSet(edit(base));
      if (res.ok && Array.isArray(res.value)) set({ paths: res.value });
      else if (!res.ok) {
        useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
        await get().load();
      }
    });
    queue = turn.catch(() => undefined);
    return turn;
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
    toggle: (path) =>
      change((paths) =>
        paths.includes(path) ? paths.filter((p) => p !== path) : [...paths, path],
      ),
    move: (path, before) =>
      change((paths) => {
        const rest = paths.filter((p) => p !== path);
        const at = before === null ? rest.length : rest.indexOf(before);
        rest.splice(at < 0 ? rest.length : at, 0, path);
        return rest;
      }),
  };
});

/** Moves a shown favorite one place up (-1) or down (+1) among the shown
 *  ones, and says where it went (round-2 review M10). */
export function nudgeFavorite(path: string, step: -1 | 1) {
  const { paths, move } = useFavoritesStore.getState();
  const shown = shownFavorites(paths, useVaultStore.getState().nodes).map((n) => n.path);
  const i = shown.indexOf(path);
  if (i < 0 || i + step < 0 || i + step >= shown.length) return;
  void move(path, step < 0 ? shown[i - 1] : (shown[i + 2] ?? null));
  announce(
    i18next.t('favorites.movedTo', {
      name: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, ''),
      position: i + step + 1,
      count: shown.length,
    }),
    true,
  );
}

// Renames, moves, the Trash and another vault change the list in Rust: read
// it again whenever the tree or the vault changes.
useVaultStore.subscribe((s, prev) => {
  if (s.nodes !== prev.nodes || s.info !== prev.info) void useFavoritesStore.getState().load();
});
