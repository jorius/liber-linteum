import { create } from 'zustand';
import { search, type SearchHit, type SearchPage } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useVaultStore } from '../../stores/vaultStore';

/** Typing settles this long before a search runs (M5 §1). */
export const DEBOUNCE_MS = 80;

export interface SearchFilters {
  project: string | null;
  folder: string | null;
  tags: string[];
  linksTo: string | null;
  linksFrom: string | null;
  hasImage: boolean;
  hasAudio: boolean;
}

export const EMPTY_FILTERS: SearchFilters = {
  project: null,
  folder: null,
  tags: [],
  linksTo: null,
  linksFrom: null,
  hasImage: false,
  hasAudio: false,
};

/** One removable chip per active filter, in the Active row's order. */
export type ActiveFilter =
  | { kind: 'project' | 'folder' | 'linksTo' | 'linksFrom'; value: string }
  | { kind: 'tag'; value: string }
  | { kind: 'hasImage' | 'hasAudio' };

export function activeFilters(f: SearchFilters): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  if (f.project) out.push({ kind: 'project', value: f.project });
  if (f.folder) out.push({ kind: 'folder', value: f.folder });
  for (const t of f.tags) out.push({ kind: 'tag', value: t });
  if (f.linksTo) out.push({ kind: 'linksTo', value: f.linksTo });
  if (f.linksFrom) out.push({ kind: 'linksFrom', value: f.linksFrom });
  if (f.hasImage) out.push({ kind: 'hasImage' });
  if (f.hasAudio) out.push({ kind: 'hasAudio' });
  return out;
}

/** `filters` without `chip`. */
export function withoutFilter(f: SearchFilters, chip: ActiveFilter): SearchFilters {
  switch (chip.kind) {
    case 'tag':
      return { ...f, tags: f.tags.filter((t) => t !== chip.value) };
    case 'hasImage':
    case 'hasAudio':
      return { ...f, [chip.kind]: false };
    default:
      return { ...f, [chip.kind]: null };
  }
}

interface SearchState {
  text: string;
  filters: SearchFilters;
  /** The latest answer; `null` before the first. */
  page: SearchPage | null;
  /** Hits loaded by Show more, after `page.results`. */
  extra: SearchHit[];
  loading: boolean;
  /** Show more is fetching the next page. */
  loadingMore: boolean;
  error: string | null;
  /** The shown answer is behind the text or filters: a search is waiting
   *  for typing to settle, or running. */
  stale: () => boolean;
  /** The text changed: searches once typing settles. */
  setText: (text: string) => void;
  /** Filters changed: searches now. */
  setFilters: (patch: Partial<SearchFilters>) => void;
  removeFilter: (chip: ActiveFilter) => void;
  clearFilters: () => void;
  /** Backspace in an empty field: the last active filter goes. */
  removeLast: () => boolean;
  showMore: () => Promise<void>;
  /** Searches now with what's set (the dialog opening). */
  refresh: () => Promise<void>;
  reset: () => void;
}

let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function cancelTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export const useSearchStore = create<SearchState>((set, get) => {
  const query = (offset = 0) => {
    const { text, filters } = get();
    return { text, ...filters, offset };
  };
  /** A newer search, or a vault switch, makes this one's answer stale. */
  const run = async () => {
    cancelTimer();
    const mine = ++seq;
    set({ loading: true, loadingMore: false });
    const res = await search(query());
    if (mine !== seq) return;
    if (res.ok) set({ page: res.value, extra: [], loading: false, error: null });
    else set({ loading: false, error: errorMessage(res.error) });
  };
  return {
    text: '',
    filters: EMPTY_FILTERS,
    page: null,
    extra: [],
    loading: false,
    loadingMore: false,
    error: null,
    stale: () => timer !== null || get().loading,
    setText: (text) => {
      set({ text });
      cancelTimer();
      timer = setTimeout(() => void run(), DEBOUNCE_MS);
    },
    setFilters: (patch) => {
      set({ filters: { ...get().filters, ...patch } });
      void run();
    },
    removeFilter: (chip) => {
      set({ filters: withoutFilter(get().filters, chip) });
      void run();
    },
    clearFilters: () => {
      set({ filters: EMPTY_FILTERS });
      void run();
    },
    removeLast: () => {
      const chips = activeFilters(get().filters);
      const last = chips[chips.length - 1];
      if (!last) return false;
      get().removeFilter(last);
      return true;
    },
    showMore: async () => {
      const { page, extra, loadingMore } = get();
      if (!page || page.recent || loadingMore) return;
      const mine = seq;
      set({ loadingMore: true });
      const res = await search(query(page.results.length + extra.length));
      if (mine !== seq) return;
      set({ loadingMore: false });
      if (res.ok) set({ extra: [...get().extra, ...res.value.results] });
    },
    refresh: run,
    reset: () => {
      seq++;
      cancelTimer();
      set({
        text: '',
        filters: EMPTY_FILTERS,
        page: null,
        extra: [],
        loading: false,
        loadingMore: false,
        error: null,
      });
    },
  };
});

// The query and filters belong to one vault session (M5 §10.20).
useVaultStore.subscribe((s, prev) => {
  if (s.info !== prev.info) useSearchStore.getState().reset();
});
