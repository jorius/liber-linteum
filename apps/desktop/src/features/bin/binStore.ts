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
    if (mine !== seq || !res.ok) return; // a newer refresh won, or no vault
    set({ trash: res.value.trash, archive: res.value.archive });
  },
  reset: () => {
    seq++;
    set({ trash: [], archive: [] });
  },
}));
