// Side covers (M4b part 3 §3): where a page's cover sits (the header band by
// default, or a tall strip on the left or right) and the strip's width. Both
// live in `.nimw/vault.json` (`coverSides`, `coverWidths`; Rust), never in
// the note, and are re-read when the vault or its tree changes, like cover
// heights.
import i18next from 'i18next';
import { create } from 'zustand';
import {
  coverSideSet,
  coverWidthSet,
  vaultSettingsGet,
  type CoverSide,
  type IpcResult,
  type VaultSettings,
} from '../ipc';
import { errorMessage } from './messages';
import { useToastStore } from './toastStore';
import { useVaultStore } from './vaultStore';

/** The narrowest strip. */
export const MIN_COVER_WIDTH = 160;
/** A strip without a width of its own. */
export const DEFAULT_COVER_WIDTH = 280;
/** Below this, the content beside a strip is too narrow: the cover shows as
 *  the header band instead (nothing is saved). */
export const MIN_CONTENT_WIDTH = 520;

/** The widest strip shown in a window this wide: 45% of it, never under the
 *  minimum. What is stored is never changed by it. */
export function coverWidthMax(windowWidth: number): number {
  return Math.max(MIN_COVER_WIDTH, Math.floor(windowWidth * 0.45));
}

interface CoverLayoutState {
  /** Pages whose cover sits beside the text. */
  sides: Record<string, 'left' | 'right'>;
  /** Pages with their own strip width. */
  widths: Record<string, number>;
  load: () => Promise<void>;
  /** Saves one page's placement (`top` clears it). It shows at once; a failed
   *  save puts the previous placement back, says why and answers `false`. */
  saveSide: (path: string, side: CoverSide) => Promise<boolean>;
  /** Saves (a number) or clears (`null`) one page's strip width. */
  saveWidth: (path: string, width: number | null) => Promise<void>;
}

/** A reply's placements and widths (a failed reply changes nothing). */
function apply(res: IpcResult<VaultSettings>): Partial<CoverLayoutState> {
  if (!res.ok || !res.value) return {};
  return { sides: res.value.coverSides ?? {}, widths: res.value.coverWidths ?? {} };
}

/** Counts saves: a reply (to a save or a load) only lands when no save
 *  started after its request, so a slow reply never undoes a later choice. */
let saves = 0;

/** Sets or clears `path` in a page map, as a new map. */
function withEntry<T>(map: Record<string, T>, path: string, value: T | undefined) {
  const next = { ...map };
  if (value === undefined) delete next[path];
  else next[path] = value;
  return next;
}

export const useCoverLayoutStore = create<CoverLayoutState>((set, get) => ({
  sides: {},
  widths: {},
  load: async () => {
    const asked = saves;
    const res = await vaultSettingsGet();
    if (asked === saves) set(apply(res));
  },
  saveSide: async (path, side) => {
    const mine = ++saves;
    const before = get().sides[path];
    set({ sides: withEntry(get().sides, path, side === 'top' ? undefined : side) });
    const res = await coverSideSet(path, side);
    if (res.ok) {
      if (mine === saves) set(apply(res));
      return true;
    }
    if (mine === saves) set({ sides: withEntry(get().sides, path, before) });
    useToastStore.getState().push({
      message: i18next.t('cover.sideNotSaved', { reason: errorMessage(res.error) }),
      tone: 'error',
    });
    return false;
  },
  saveWidth: async (path, width) => {
    const mine = ++saves;
    const before = get().widths[path];
    const px = width === null ? null : Math.round(width);
    set({ widths: withEntry(get().widths, path, px ?? undefined) });
    const res = await coverWidthSet(path, px);
    if (res.ok) {
      if (mine === saves) set(apply(res));
      return;
    }
    if (mine === saves) set({ widths: withEntry(get().widths, path, before) });
    useToastStore.getState().push({
      message: i18next.t('cover.widthNotSaved', { reason: errorMessage(res.error) }),
      tone: 'error',
    });
  },
}));

/** Where the page's cover sits, reactive to its entry. */
export function useCoverSide(path: string): CoverSide {
  return useCoverLayoutStore((s) => s.sides[path] ?? 'top');
}

/** The page's strip width before the window caps it. */
export function useCoverWidth(path: string): number {
  return useCoverLayoutStore((s) => s.widths[path] ?? DEFAULT_COVER_WIDTH);
}

// Re-read with each vault and after tree changes (renames move entries).
let timer: ReturnType<typeof setTimeout> | undefined;
useVaultStore.subscribe((s, prev) => {
  if (s.info === prev.info && s.nodes === prev.nodes) return;
  if (!s.info) {
    useCoverLayoutStore.setState({ sides: {}, widths: {} });
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => void useCoverLayoutStore.getState().load(), 100);
});
