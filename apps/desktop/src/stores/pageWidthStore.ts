// Full page width (M4b part 2 §1): a page's own width, else the vault's,
// else the app's. Page and vault widths live in `.nimw/vault.json` (Rust);
// they're re-read when the vault or its tree changes (renames move them).
import { create } from 'zustand';
import {
  pageWidthSet,
  vaultSettingsGet,
  vaultSettingsSet,
  type IpcResult,
  type PageWidth,
  type VaultSettings,
} from '../ipc';
import { useSettingsStore } from './settingsStore';
import { useVaultStore } from './vaultStore';

interface PageWidthState {
  vault: PageWidth | null;
  pages: Record<string, PageWidth>;
  loaded: boolean;
  load: () => Promise<void>;
  /** Full ↔ readable for one page; stores an entry only when it differs
   *  from the vault/app default. */
  toggle: (path: string) => Promise<void>;
  setVault: (width: PageWidth | 'default') => Promise<void>;
}

/** A reply's widths (an older or failed reply changes nothing). */
function apply(res: IpcResult<VaultSettings>): Partial<PageWidthState> {
  if (!res.ok || !res.value) return {};
  return { vault: res.value.pageWidth ?? null, pages: res.value.pageWidths ?? {}, loaded: true };
}

/** The width the page shows. */
export function widthFor(path: string): PageWidth {
  const { vault, pages } = usePageWidthStore.getState();
  return pages[path] ?? vault ?? useSettingsStore.getState().settings.pageWidth;
}

export const usePageWidthStore = create<PageWidthState>((set, get) => ({
  vault: null,
  pages: {},
  loaded: false,
  load: async () => {
    set(apply(await vaultSettingsGet()));
  },
  toggle: async (path) => {
    const fallback = get().vault ?? useSettingsStore.getState().settings.pageWidth;
    const next: PageWidth = widthFor(path) === 'full' ? 'readable' : 'full';
    set(apply(await pageWidthSet(path, next === fallback ? null : next)));
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
