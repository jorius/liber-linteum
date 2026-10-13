import { create } from 'zustand';
import { pageGet, type ChangedPayload, type Page } from '../ipc';
import { errorMessage } from './messages';
import { useToastStore } from './toastStore';
import { remap } from './tree';

export type PageViewState = 'empty' | 'loading' | 'ready' | 'deleted';

interface PageState {
  path: string | null;
  page: Page | null;
  state: PageViewState;
  load: (path: string) => Promise<void>;
  clear: () => void;
  /** Follows renames of the open page (own or external). */
  follow: (from: string, to: string) => Promise<void>;
  /** `exists` reports whether a path is in the freshly refreshed tree, so a
   *  file an editor saved by delete + rewrite reloads instead of reading as
   *  deleted (final review, upgraded M7). */
  onExternalChange: (c: ChangedPayload, exists?: (path: string) => boolean) => Promise<void>;
}

let seq = 0;

export const usePageStore = create<PageState>((set, get) => ({
  path: null,
  page: null,
  state: 'empty',
  load: async (path) => {
    const mine = ++seq;
    set({ path, state: get().path === path && get().page ? get().state : 'loading' });
    const res = await pageGet(path);
    if (mine !== seq) return; // a newer load won
    if (res.ok) set({ page: res.value, state: 'ready' });
    else if (res.error.kind === 'notFound') set({ page: null, state: 'deleted' });
    else {
      set({ page: null, path: null, state: 'empty' });
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    }
  },
  clear: () => {
    seq++;
    set({ path: null, page: null, state: 'empty' });
  },
  follow: async (from, to) => {
    const path = get().path;
    const next = path ? remap(path, from, to) : null;
    if (next) await get().load(next);
  },
  onExternalChange: async (c, exists) => {
    const path = get().path;
    if (!path) return;
    for (const [from, to] of c.renamed) {
      if (remap(path, from, to)) return get().follow(from, to);
    }
    const stillThere = exists?.(path) ?? false;
    if (c.removed.some((r) => remap(path, r, r) !== null) && !stillThere) {
      seq++;
      set({ state: 'deleted' });
      return;
    }
    const touched =
      c.modified.includes(path) || c.created.includes(path) || c.removed.includes(path);
    if (touched || (get().state === 'deleted' && stillThere)) await get().load(path);
  },
}));
