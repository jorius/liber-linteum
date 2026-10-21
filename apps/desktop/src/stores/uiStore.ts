import { create } from 'zustand';

export type DialogState =
  | { type: 'move'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'settings' }
  /** Link to a page that doesn't exist yet (M2a §3.4). */
  | { type: 'createPage'; source: string; target: string }
  | { type: 'openExternal'; url: string }
  /** `external`: an absolute path outside the vault (M4b part 3 §9);
   *  `network`: on another computer, not loaded yet (final review C1). */
  | { type: 'openFile'; path: string; external?: boolean; network?: boolean }
  /** A page's relationships, or (with `other`) those between two cards'
   *  pages (M3b §3). */
  | { type: 'relations'; page: string; other?: string }
  /** A folder's index note (M3b §4); `current`: the page picked now;
   *  `only`: the folder's single page, its index note already (GV-02 rule 4). */
  | { type: 'indexPick'; folder: string; current: string | null; only?: string }
  /** "Where should quick notes live?" (M4c §2); `then: 'quickNote'` takes
   *  the quick note that asked. Rendered by `ScratchpadHost` (it also shows
   *  on the Welcome screen). */
  | { type: 'scratchpadSetup'; then: 'quickNote' | 'none' }
  /** Search (M5 §4). */
  | { type: 'search' }
  /** Import from Notion (M7 §3). Rendered by `NotionHost` (it also shows on
   *  the Welcome screen). */
  | { type: 'notionImport' }
  /** New encrypted vault in the folder just picked (E4); `CreateEncryptedHost`. */
  | { type: 'createEncrypted'; path: string }
  /** The vault's recovery key was replaced on another device (E4). */
  | { type: 'recoveryVoid' }
  /** Save / Don't Save / Cancel before unsaved text is left (M5b §6, auto
   *  save off). `id` tells two questions apart. */
  | { type: 'unsaved'; id: number; paths: string[]; answer: (c: UnsavedChoice) => void }
  /** Restore or Unarchive found something new in the old place: keep both?
   *  (M5b §5.2; final review M3: from the banner and the toasts too). */
  | {
      type: 'binClash';
      kind: 'trash' | 'archive';
      path: string;
      /** Called once: keep both (true) or cancel (false). */
      answer: (keepBoth: boolean) => void;
    }
  | null;

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

/** Which screen the open vault shows (M3a §2); the Trash and the Archive
 *  (M5b §5) show in place of the editor. */
export type Screen = 'edit' | 'global' | 'trash';

interface UiState {
  dialog: DialogState;
  screen: Screen;
  /** The floating button's Edit / Global view / Search are shown (M5b §2.2). */
  actionsOpen: boolean;
  setActionsOpen: (open: boolean) => void;
  setScreen: (screen: Screen) => void;
  openDialog: (d: Exclude<DialogState, null>) => void;
  closeDialog: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  dialog: null,
  screen: 'edit',
  setScreen: (screen) => set({ screen }),
  actionsOpen: false,
  setActionsOpen: (actionsOpen) => set({ actionsOpen }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
}));
