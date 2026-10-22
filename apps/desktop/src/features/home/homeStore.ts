// A vault's home: what shows when it opens, a page (or text file) or the
// Global View. Rust keeps it in `.liber/vault.json`, where it follows renames
// and moves and is cleared when its page goes to the Trash or the Archive or
// is deleted; `vault_open` sends it with the vault.
import i18next from 'i18next';
import { create } from 'zustand';
import { homeGet, homeSet, type Home, type VaultInfo } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { openPage } from '../../stores/navigate';
import { useToastStore } from '../../stores/toastStore';
import { nameOf } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { onVaultOpened, useVaultStore } from '../../stores/vaultStore';
import { announce } from '../editor/announce';

interface HomeState {
  home: Home | null;
  /** Reads it again from Rust (after a rename, a move, the Trash). */
  load: () => Promise<void>;
  /** Saves `home` (`null`: nothing chosen); false when Rust refused it. */
  set: (home: Home | null) => Promise<boolean>;
}

/** The home page's path, when the home is a page. */
export const homePageOf = (home: Home | null | undefined): string | null =>
  home?.kind === 'page' ? home.path : null;

/** A vault where homes are offered: not the global Scratchpad, which keeps
 *  opening to its quick notes. */
export const homeOffered = (info: VaultInfo | null | undefined): boolean =>
  !!info && !info.scratchpad;

/** One page's name as the tree shows it. */
const shown = (path: string) => nameOf(path).replace(/\.md$/i, '');

export const useHomeStore = create<HomeState>((set, get) => {
  // The newest read or save wins: a tree refresh's read never undoes a choice
  // made since.
  let seq = 0;
  return {
    home: null,
    load: async () => {
      const mine = ++seq;
      if (!homeOffered(useVaultStore.getState().info)) {
        set({ home: null });
        return;
      }
      const res = await homeGet();
      if (mine === seq && res.ok) set({ home: res.value ?? null });
    },
    set: async (home) => {
      const mine = ++seq;
      set({ home }); // shown at once
      const res = await homeSet(home);
      if (res.ok) {
        if (mine === seq) set({ home: res.value ?? null });
        return true;
      }
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      await get().load();
      return false;
    },
  };
});

/** Makes `path` the home page, or (already it) leaves the vault without one. */
export async function toggleHomePage(path: string): Promise<void> {
  const store = useHomeStore.getState();
  const was = homePageOf(store.home) === path;
  const ok = await store.set(was ? null : { kind: 'page', path });
  if (ok) {
    announce(i18next.t(was ? 'home.removedPage' : 'home.setPageDone', { name: shown(path) }), true);
  }
}

/** Makes the Global View the home, or (already it) leaves none. */
export async function toggleGlobalViewHome(): Promise<void> {
  const store = useHomeStore.getState();
  const was = store.home?.kind === 'globalView';
  const ok = await store.set(was ? null : { kind: 'globalView' });
  if (ok) announce(i18next.t(was ? 'home.globalViewRemoved' : 'home.globalViewSet'), true);
}

/** Shows `home`: its page in the editor (a fresh link trail, the page first
 *  on it), or the Global View. A page that isn't in the tree (gone since,
 *  not synced yet) leaves the editor asking for one, as with no home. */
export async function goHome(home: Home | null | undefined): Promise<void> {
  if (!home) return;
  if (home.kind === 'globalView') {
    useUiStore.getState().setScreen('global');
    return;
  }
  const { children } = useVaultStore.getState();
  const dir = home.path.includes('/') ? home.path.slice(0, home.path.lastIndexOf('/')) : '';
  if (!children.get(dir)?.some((n) => n.path === home.path)) return;
  await openPage(home.path);
}

// Each open goes home, unless its caller shows a page of its own next (a
// file opened from outside, a Notion import's report): the request wins.
onVaultOpened(async (info, { home }) => {
  useHomeStore.setState({ home: homeOffered(info) ? (info.home ?? null) : null });
  if (home && homeOffered(info)) await goHome(info.home);
});

// Renames, moves, the Trash and another vault change it in Rust: read it
// again whenever the tree changes; a closed vault has none.
useVaultStore.subscribe((s, prev) => {
  if (!s.info && prev.info) useHomeStore.setState({ home: null });
  else if (s.info && s.nodes !== prev.nodes) void useHomeStore.getState().load();
});
