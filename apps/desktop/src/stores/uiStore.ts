import { create } from 'zustand';

export type DialogState =
  { type: 'move'; path: string } | { type: 'delete'; path: string } | { type: 'settings' } | null;

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
