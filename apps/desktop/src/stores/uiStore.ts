import { create } from 'zustand';

export type DialogState =
  | { type: 'move'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'settings' }
  /** Link to a page that doesn't exist yet (M2a §3.4). */
  | { type: 'createPage'; source: string; target: string }
  | { type: 'openExternal'; url: string }
  /** `external`: an absolute path outside the vault (M4b part 3 §9). */
  | { type: 'openFile'; path: string; external?: boolean }
  /** A page's relationships, or (with `other`) those between two cards'
   *  pages (M3b §3). */
  | { type: 'relations'; page: string; other?: string }
  /** A folder's index note (M3b §4); `current`: the page picked now;
   *  `only`: the folder's single page, its index note already (GV-02 rule 4). */
  | { type: 'indexPick'; folder: string; current: string | null; only?: string }
  | null;

/** Which screen the open vault shows (M3a §2). */
export type Screen = 'edit' | 'global';

interface UiState {
  dialog: DialogState;
  screen: Screen;
  setScreen: (screen: Screen) => void;
  openDialog: (d: Exclude<DialogState, null>) => void;
  closeDialog: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  dialog: null,
  screen: 'edit',
  setScreen: (screen) => set({ screen }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
}));
