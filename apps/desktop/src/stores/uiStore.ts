import { create } from 'zustand';

export type DialogState =
  | { type: 'move'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'settings' }
  /** Link to a page that doesn't exist yet (M2a §3.4). */
  | { type: 'createPage'; source: string; target: string }
  | { type: 'openExternal'; url: string }
  | { type: 'openFile'; path: string }
  | null;

interface UiState {
  dialog: DialogState;
  openDialog: (d: Exclude<DialogState, null>) => void;
  closeDialog: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
}));
