// Cover resize: a page's own cover height, else the app's default
// (Settings → Editor). Page heights live in `.liber/vault.json`
// `coverHeights` (Rust), never in the note; they're re-read when the vault or
// its tree changes (renames move them, deletions drop them), like page widths.
import i18next from 'i18next';
import { create } from 'zustand';
import { coverHeightSet, vaultSettingsGet, type IpcResult, type VaultSettings } from '../ipc';
import { errorMessage } from './messages';
import { useSettingsStore } from './settingsStore';
import { useToastStore } from './toastStore';
import { useVaultStore } from './vaultStore';

/** The smallest cover band: the M4b header band. */
export const MIN_COVER_HEIGHT = 132;

/** The tallest the band is shown in a window this tall: 60% of it, never
 *  under the minimum. What is stored is never changed by it. */
export function coverMax(windowHeight: number): number {
  return Math.max(MIN_COVER_HEIGHT, Math.floor(windowHeight * 0.6));
}

interface CoverHeightState {
  pages: Record<string, number>;
  loaded: boolean;
  load: () => Promise<void>;
  /** Saves (a number) or clears (`null`) one page's height. It shows at once;
   *  a failed save puts the previous height back and says why. */
  save: (path: string, height: number | null) => Promise<void>;
}

/** A reply's heights (a failed reply changes nothing). */
function apply(res: IpcResult<VaultSettings>): Partial<CoverHeightState> {
  if (!res.ok || !res.value) return {};
  return { pages: res.value.coverHeights ?? {}, loaded: true };
}

/** The height the page's cover asks for, before the window caps it. */
export function coverHeightFor(path: string): number {
  return (
    useCoverHeightStore.getState().pages[path] ?? useSettingsStore.getState().settings.coverHeight
  );
}

/** Counts saves: a reply (to a save or a load) only lands when no save
 *  started after its request, so a slow reply never undoes a later drag. */
let saves = 0;

export const useCoverHeightStore = create<CoverHeightState>((set, get) => ({
  pages: {},
  loaded: false,
  load: async () => {
    const asked = saves;
    const res = await vaultSettingsGet();
    if (asked === saves) set(apply(res));
  },
  save: async (path, height) => {
    const mine = ++saves;
    const before = get().pages;
    const pages = { ...before };
    if (height === null) delete pages[path];
    else pages[path] = Math.round(height);
    set({ pages });
    const res = await coverHeightSet(path, height === null ? null : Math.round(height));
    if (res.ok) {
      if (mine === saves) set(apply(res));
      return;
    }
    // Put back only what this save changed, unless a later save has since.
    if (mine === saves) {
      const now = { ...get().pages };
      if (before[path] === undefined) delete now[path];
      else now[path] = before[path];
      set({ pages: now });
    }
    useToastStore.getState().push({
      message: i18next.t('cover.heightNotSaved', { reason: errorMessage(res.error) }),
      tone: 'error',
    });
  },
}));

/** The page's cover height, reactive to the page entry and the default. */
export function useCoverHeight(path: string): number {
  const own = useCoverHeightStore((s) => s.pages[path]);
  const app = useSettingsStore((s) => s.settings.coverHeight);
  return own ?? app;
}

// Re-read with each vault and after tree changes (renames move entries).
let timer: ReturnType<typeof setTimeout> | undefined;
useVaultStore.subscribe((s, prev) => {
  if (s.info === prev.info && s.nodes === prev.nodes) return;
  if (!s.info) {
    useCoverHeightStore.setState({ pages: {}, loaded: false });
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => void useCoverHeightStore.getState().load(), 100);
});
