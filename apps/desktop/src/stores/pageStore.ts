import { create } from 'zustand';
import { pageGet, type ChangedPayload, type Page } from '../ipc';
import { useEditorStore } from './editorStore';
import { errorMessage } from './messages';
import { useToastStore } from './toastStore';
import { remap } from './tree';

export type PageViewState = 'empty' | 'loading' | 'ready' | 'deleted';

/** A heading to scroll to (link with `#Heading`); `nonce` re-triggers the same one. */
export interface Anchor {
  heading: string;
  nonce: number;
}

interface PageState {
  path: string | null;
  page: Page | null;
  state: PageViewState;
  anchor: Anchor | null;
  /** Asks the title field of `path` to take focus with the name selected
   *  (a page just made from the Global View, M3a §5); consumed once. */
  titleFocus: { path: string } | null;
  requestTitleFocus: (path: string) => void;
  clearTitleFocus: () => void;
  /** Asks the editor to take the keyboard when it next shows, unless
   *  something else has it (leaving the Global View drops it, M3a final
   *  review I4); consumed once. */
  editorFocus: boolean;
  requestEditorFocus: () => void;
  clearEditorFocus: () => void;
  /** Scrolls the open page to `heading`. */
  reveal: (heading: string | null) => void;
  /** Opens `path` (header data + editor). */
  load: (path: string) => Promise<void>;
  /** Re-reads the header data (title, tags, counts) of the open page. */
  refresh: () => Promise<void>;
  clear: () => void;
  /** Follows renames of the open page (own or external). */
  follow: (from: string, to: string) => Promise<void>;
  /** `exists` reports whether a path is in the freshly refreshed tree, so a
   *  file an editor saved by delete + rewrite reloads instead of reading as
   *  deleted (final review, upgraded M7). */
  onExternalChange: (c: ChangedPayload, exists?: (path: string) => boolean) => Promise<void>;
}

let seq = 0;
let watchingSaves = false;

/** Our own saves aren't reported by the watcher: refresh the header data
 *  (title, tags, link counts) after each one. Subscribed on first use, not at
 *  module load, because the stores import each other. */
function watchSaves() {
  if (watchingSaves) return;
  watchingSaves = true;
  useEditorStore.subscribe((s, prev) => {
    if (s.path && s.path === prev.path && prev.hash && s.hash !== prev.hash) {
      void usePageStore.getState().refresh();
    }
  });
}

export const usePageStore = create<PageState>((set, get) => ({
  path: null,
  page: null,
  state: 'empty',
  anchor: null,
  titleFocus: null,
  requestTitleFocus: (path) => set({ titleFocus: { path } }),
  clearTitleFocus: () => set({ titleFocus: null }),
  editorFocus: false,
  requestEditorFocus: () => set({ editorFocus: true }),
  clearEditorFocus: () => set({ editorFocus: false }),
  reveal: (heading) =>
    set({ anchor: heading ? { heading, nonce: (get().anchor?.nonce ?? 0) + 1 } : null }),
  load: async (path) => {
    watchSaves();
    const mine = ++seq;
    const same = get().path === path;
    set({
      path,
      state: same && get().page ? get().state : 'loading',
      anchor: same ? get().anchor : null,
    });
    const editing = useEditorStore.getState().open(path);
    const res = await pageGet(path);
    await editing;
    if (mine !== seq) return; // a newer load won
    if (res.ok) set({ page: res.value, state: 'ready' });
    else if (res.error.kind === 'notFound') set({ page: null, state: 'deleted' });
    else {
      set({ page: null, path: null, state: 'empty' });
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    }
  },
  refresh: async () => {
    const path = get().path;
    if (!path || get().state !== 'ready') return;
    const mine = seq;
    const res = await pageGet(path);
    if (mine === seq && res.ok) set({ page: res.value });
  },
  clear: () => {
    seq++;
    set({ path: null, page: null, state: 'empty', anchor: null, editorFocus: false });
    void useEditorStore.getState().close();
  },
  follow: async (from, to) => {
    useEditorStore.getState().follow(from, to);
    const path = get().path;
    const next = path ? remap(path, from, to) : null;
    if (!next) return;
    // Same document under a new name: keep the page shown (header mounted) while
    // it reloads, so focus in the header (the title just renamed) isn't lost
    // (final review I3, NFR-10).
    const page = get().page;
    if (page && get().state === 'ready') set({ path: next, page: { ...page, path: next } });
    await get().load(next);
  },
  onExternalChange: async (c, exists) => {
    await useEditorStore.getState().onExternalChange(c, exists);
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
