import { create } from 'zustand';

/** Network files the user loaded (M4b part 3, final review C1): each load
 *  bumps `loads`, so previews ask Rust about their outside files again. */
interface OutsideState {
  loads: number;
  loaded: () => void;
}

export const useOutsideStore = create<OutsideState>((set) => ({
  loads: 0,
  loaded: () => set((s) => ({ loads: s.loads + 1 })),
}));
