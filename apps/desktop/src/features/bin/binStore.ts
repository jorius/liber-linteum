import { create } from 'zustand';
import { binList, type BinItem } from '../../ipc';

/** The vault's Trash and Archive lists (M5b §5), refreshed with the tree. */
interface BinState {
  trash: BinItem[];
  archive: BinItem[];
  refresh: () => Promise<void>;
  reset: () => void;
}

let seq = 0;

export const useBinStore = create<BinState>((set) => ({
  trash: [],
  archive: [],
  refresh: async () => {
    const mine = ++seq;
    const res = await binList();
    // A newer refresh won, no vault, or nothing answered (a mocked backend).
    if (mine !== seq || !res.ok || !res.value) return;
    set({ trash: res.value.trash, archive: res.value.archive });
  },
  reset: () => {
    seq++;
    set({ trash: [], archive: [] });
  },
}));
