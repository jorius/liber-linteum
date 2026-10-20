// Page width (M4b part 2 §1; `wide`: M4b part 3): a page's own width, else
// the vault's, else the app's. Page and vault widths live in
// `.liber/vault.json` (Rust); they're re-read when the vault or its tree
// changes (renames move them).
import { create } from 'zustand';
import {
  fileWindowName,
  pageWidthSet,
  vaultSettingsGet,
  vaultSettingsSet,
  type IpcResult,
  type PageWidth,
  type VaultSettings,
  type WideElements,
} from '../ipc';
import { useSettingsStore } from './settingsStore';
import { useVaultStore } from './vaultStore';

interface PageWidthState {
  vault: PageWidth | null;
  pages: Record<string, PageWidth>;
  loaded: boolean;
  load: () => Promise<void>;
  /** One page's width; `null`, or the default's own width, clears its entry
   *  so the page follows the default again (part 2 §10.2). */
  set: (path: string, width: PageWidth | null) => Promise<void>;
  setVault: (width: PageWidth | 'default') => Promise<void>;
}

/** A reply's widths (an older or failed reply changes nothing). */
function apply(res: IpcResult<VaultSettings>): Partial<PageWidthState> {
  if (!res.ok || !res.value) return {};
  return { vault: res.value.pageWidth ?? null, pages: res.value.pageWidths ?? {}, loaded: true };
}

/** The width a page without its own shows: the vault's, else the app's. */
export function fallbackWidth(): PageWidth {
  return usePageWidthStore.getState().vault ?? useSettingsStore.getState().settings.pageWidth;
}

/** The width the page shows. */
export function widthFor(path: string): PageWidth {
  return usePageWidthStore.getState().pages[path] ?? fallbackWidth();
}

export const usePageWidthStore = create<PageWidthState>((set) => ({
  vault: null,
  pages: {},
  loaded: false,
  load: async () => {
    set(apply(await vaultSettingsGet()));
  },
  set: async (path, width) => {
    const own = width === fallbackWidth() ? null : width;
    // A single-file window has no vault to keep it in: this window's, for
    // as long as it is open (M4c §3).
    if (fileWindowName() !== null) {
      set((s) => {
        const pages = { ...s.pages };
        if (own) pages[path] = own;
        else delete pages[path];
        return { pages };
      });
      return;
    }
    set(apply(await pageWidthSet(path, own)));
  },
  setVault: async (width) => {
    set(apply(await vaultSettingsSet({ pageWidth: width })));
  },
}));

/** The page's width, reactive to every level. */
export function usePageWidth(path: string): PageWidth {
  const own = usePageWidthStore((s) => s.pages[path] ?? s.vault);
  const app = useSettingsStore((s) => s.settings.pageWidth);
  return own ?? app;
}

/** Whether the page has a width of its own (Reset to default clears it). */
export function useOwnPageWidth(path: string): boolean {
  return usePageWidthStore((s) => s.pages[path] !== undefined);
}

/** The kinds that go wide on a `wide` page (M4b part 3). */
export function useWideElements(): WideElements {
  return useSettingsStore((s) => s.settings.wideElements);
}

// Re-read with each vault and after tree changes (renames move entries).
let timer: ReturnType<typeof setTimeout> | undefined;
useVaultStore.subscribe((s, prev) => {
  if (s.info === prev.info && s.nodes === prev.nodes) return;
  if (!s.info) {
    usePageWidthStore.setState({ vault: null, pages: {}, loaded: false });
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => void usePageWidthStore.getState().load(), 100);
});
