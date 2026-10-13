import { create } from 'zustand';
import { remap } from './tree';

/** A page on the trail, with the heading it was opened at. */
export interface TrailEntry {
  path: string;
  heading: string | null;
}

interface TrailState {
  /** Pages before the current one, oldest first. */
  back: TrailEntry[];
  /** Pages after it (after going back), nearest last. */
  forward: TrailEntry[];
  /** A link was followed from `from`: it becomes the way back. */
  followed: (from: TrailEntry) => void;
  /** Leaves `current` for the previous page; `null` when there is none. */
  goBack: (current: TrailEntry) => TrailEntry | null;
  goForward: (current: TrailEntry) => TrailEntry | null;
  /** A direct navigation (explorer, ⌘O, …) starts a fresh trail. */
  reset: () => void;
  renamed: (from: string, to: string) => void;
  removed: (path: string) => void;
}

const same = (a: TrailEntry | undefined, b: TrailEntry) => a?.path === b.path;

/** Drops deleted pages and then repeated neighbours. */
function prune(list: TrailEntry[], gone: string): TrailEntry[] {
  const kept = list.filter((x) => remap(x.path, gone, gone) === null);
  return kept.filter((x, i) => !same(kept[i - 1], x));
}

/** The link trail (M2b §3): only followed internal links add to it; it lives
 *  in memory for the window. */
export const useTrailStore = create<TrailState>((set, get) => ({
  back: [],
  forward: [],
  followed: (from) => set((s) => ({ back: [...s.back, from], forward: [] })),
  goBack: (current) => {
    const { back, forward } = get();
    const to = back.at(-1);
    if (!to) return null;
    set({ back: back.slice(0, -1), forward: [...forward, current] });
    return to;
  },
  goForward: (current) => {
    const { back, forward } = get();
    const to = forward.at(-1);
    if (!to) return null;
    set({ back: [...back, current], forward: forward.slice(0, -1) });
    return to;
  },
  reset: () => set({ back: [], forward: [] }),
  renamed: (from, to) =>
    set((s) => {
      const move = (x: TrailEntry) => ({ ...x, path: remap(x.path, from, to) ?? x.path });
      return { back: s.back.map(move), forward: s.forward.map(move) };
    }),
  removed: (path) => set((s) => ({ back: prune(s.back, path), forward: prune(s.forward, path) })),
}));
