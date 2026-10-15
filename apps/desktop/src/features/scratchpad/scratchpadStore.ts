// Quick notes in the open vault (M4c §2, §7): its scratch folder and the
// notes still named after their first line. Rust is the authority; this is
// what the explorer and the auto-name watcher read.
import { create } from 'zustand';
import { quickNotesState } from '../../ipc';
import { useVaultStore } from '../../stores/vaultStore';

interface ScratchpadState {
  /** The open vault's scratch folder; `null` in the global Scratchpad (its
   *  root is the scratch place) or with no vault open. */
  folder: string | null;
  /** Notes still named after their first line. */
  autoNamed: Set<string>;
  /** Re-reads both from the backend. */
  load: () => Promise<void>;
  add: (path: string) => void;
  /** The auto-name moved a note: it keeps following its first line. */
  moved: (from: string, to: string) => void;
  drop: (path: string) => void;
  reset: () => void;
}

let seq = 0;

export const useScratchpadStore = create<ScratchpadState>((set, get) => ({
  folder: null,
  autoNamed: new Set(),
  load: async () => {
    const mine = ++seq;
    const res = await quickNotesState();
    if (mine !== seq) return; // a newer load (or a reset) won
    if (!res.ok || !res.value) {
      set({ folder: null, autoNamed: new Set() });
      return;
    }
    set({ folder: res.value.folder, autoNamed: new Set(res.value.autoNamed) });
  },
  add: (path) => set({ autoNamed: new Set(get().autoNamed).add(path) }),
  moved: (from, to) => {
    const next = new Set(get().autoNamed);
    next.delete(from);
    next.add(to);
    set({ autoNamed: next });
  },
  drop: (path) => {
    const next = new Set(get().autoNamed);
    next.delete(path);
    set({ autoNamed: next });
  },
  reset: () => {
    seq++;
    set({ folder: null, autoNamed: new Set() });
  },
}));

/** Keeps the store in step with the open vault: loaded when a vault opens
 *  and after every tree refresh (the scratch folder follows renames made in
 *  Finder too), cleared when it closes. Returns the unsubscribe. */
export function installScratchpadSync(): () => void {
  return useVaultStore.subscribe((s, prev) => {
    if (s.info === prev.info && s.nodes === prev.nodes) return;
    if (s.info) void useScratchpadStore.getState().load();
    else useScratchpadStore.getState().reset();
  });
}
