// Global View state (M3a §5, §7): the drill-down stack (breadcrumb), the
// cards expanded in place, the loaded levels, edges and pinned positions.
import { create } from 'zustand';
import {
  gvChildren,
  gvEdges,
  layoutGet,
  layoutSet,
  type CardPosition,
  type GlobalViewMode,
  type GvCard,
  type GvEdge,
  type GvLevel,
  type GvLevelRef,
} from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';

/** Saving a dragged card waits this long for the next drag (M3a §7). */
export const PIN_SAVE_MS = 300;

/** Arch §3.1 level keys: `""` vault, a folder path, `page:<path>`. */
export const levelKey = (ref: GvLevelRef): string =>
  ref.kind === 'vault' ? '' : ref.kind === 'folder' ? ref.path : `page:${ref.path}`;

/** The level a card's single click opens. */
export const nextLevel = (card: GvCard): GvLevelRef =>
  card.kind === 'page' ? { kind: 'page', path: card.path } : { kind: 'folder', path: card.path };

/** The layout key of what the canvas shows. */
export const canvasKey = (mode: GlobalViewMode, root: GvLevelRef): string =>
  mode === 'expand' ? `expand:${levelKey(root)}` : levelKey(root);

/** What the canvas shows, derived from the loaded levels. */
export interface Canvas {
  /** Every card on the canvas, once. */
  cards: GvCard[];
  /** The root level's cards, in order. */
  roots: string[];
  /** Expand in place: the cards each expanded card added. */
  children: Map<string, string[]>;
  /** A page level's page (Drill-down). */
  centre: string | null;
}

const EMPTY_CANVAS: Canvas = { cards: [], roots: [], children: new Map(), centre: null };

export function buildCanvas(
  mode: GlobalViewMode,
  root: GvLevelRef,
  expanded: GvLevelRef[],
  levels: Record<string, GvLevel>,
): Canvas {
  const base = levels[levelKey(root)];
  if (!base) return EMPTY_CANVAS;
  const cards = [...base.cards];
  const roots = cards.map((c) => c.path);
  const children = new Map<string, string[]>();
  if (mode === 'drill') return { cards, roots, children, centre: base.centre };
  const shown = new Set(roots);
  for (const ref of expanded) {
    if (ref.kind === 'vault' || !shown.has(ref.path)) continue;
    const level = levels[levelKey(ref)];
    if (!level) continue;
    const added = level.cards.filter((c) => c.path !== ref.path && !shown.has(c.path));
    for (const c of added) shown.add(c.path);
    cards.push(...added);
    children.set(
      ref.path,
      added.map((c) => c.path),
    );
  }
  return { cards, roots, children, centre: null };
}

interface GvState {
  /** Drill-down levels opened, vault first (the breadcrumb); its last entry
   *  is also the root of an Expand canvas. */
  stack: GvLevelRef[];
  /** Expand in place: the cards expanded, in the order they were opened. */
  expanded: GvLevelRef[];
  levels: Record<string, GvLevel>;
  canvas: Canvas;
  edges: GvEdge[];
  /** Pinned positions of the current canvas. */
  pinned: Record<string, CardPosition>;
  /** The card with keyboard focus (roving tabindex). */
  focus: string | null;
  loaded: boolean;
  /** Reads what the canvas shows: levels (falling back from deleted ones),
   *  edges and pinned positions. */
  load: () => Promise<void>;
  /** A single click: the next level (Drill-down) or expand / collapse. */
  open: (card: GvCard) => Promise<void>;
  /** Breadcrumb: back to `stack[i]`. */
  back: (i: number) => Promise<void>;
  /** Escape (M3a §5): one level up, or collapse `path` in Expand. */
  up: (path: string | null) => Promise<void>;
  /** The mode changed: keep the root level, forget expansions. */
  modeChanged: () => Promise<void>;
  pin: (path: string, at: CardPosition) => void;
  resetLayout: () => Promise<void>;
  setFocus: (path: string | null) => void;
  reset: () => void;
}

const mode = (): GlobalViewMode => useSettingsStore.getState().settings.globalViewMode;
let seq = 0;
let pinTimer: ReturnType<typeof setTimeout> | null = null;

export const useGvStore = create<GvState>((set, get) => {
  /** Cards `path` added, and theirs, recursively (Expand). */
  function subtree(path: string): Set<string> {
    const out = new Set<string>();
    const walk = (p: string) => {
      for (const kid of get().canvas.children.get(p) ?? []) {
        if (!out.has(kid)) {
          out.add(kid);
          walk(kid);
        }
      }
    };
    walk(path);
    return out;
  }

  function savePins() {
    pinTimer = null;
    const { stack, canvas, pinned } = get();
    const shown = new Set(canvas.cards.map((c) => c.path));
    // Entries for cards no longer on the canvas are pruned here (M3a §7).
    const kept = Object.fromEntries(Object.entries(pinned).filter(([p]) => shown.has(p)));
    void layoutSet(canvasKey(mode(), stack[stack.length - 1]), kept);
  }

  return {
    stack: [{ kind: 'vault' }],
    expanded: [],
    levels: {},
    canvas: EMPTY_CANVAS,
    edges: [],
    pinned: {},
    focus: null,
    loaded: false,
    load: async () => {
      const mine = ++seq;
      const m = mode();
      let stack = get().stack;
      let expanded = m === 'expand' ? get().expanded : [];
      const levels: Record<string, GvLevel> = {};
      // The root level, or the nearest one above it that still exists.
      while (stack.length) {
        const root = stack[stack.length - 1];
        const res = await gvChildren(root);
        if (mine !== seq) return;
        if (res.ok) {
          levels[levelKey(root)] = res.value;
          break;
        }
        stack = stack.length > 1 ? stack.slice(0, -1) : [{ kind: 'vault' }];
        expanded = [];
        if (root.kind === 'vault') return; // no vault open
      }
      const results = await Promise.all(expanded.map((ref) => gvChildren(ref)));
      if (mine !== seq) return;
      expanded = expanded.filter((ref, i) => {
        const res = results[i];
        if (res.ok) levels[levelKey(ref)] = res.value;
        return res.ok;
      });
      const root = stack[stack.length - 1];
      const canvas = buildCanvas(m, root, expanded, levels);
      const [edges, pinned] = await Promise.all([
        gvEdges(canvas.cards.map((c) => c.path)),
        layoutGet(canvasKey(m, root)),
      ]);
      if (mine !== seq) return;
      const shown = new Set(canvas.cards.map((c) => c.path));
      const focus = get().focus;
      set({
        stack,
        expanded,
        levels,
        canvas,
        // A layout or edge read that fails (or answers nothing) just means
        // none: the canvas still shows.
        edges: edges.ok && Array.isArray(edges.value) ? edges.value : [],
        pinned: pinned.ok && pinned.value ? pinned.value : {},
        focus: focus && shown.has(focus) ? focus : null,
        loaded: true,
      });
    },
    open: async (card) => {
      if (mode() === 'drill') {
        set({ stack: [...get().stack, nextLevel(card)], focus: null });
        return get().load();
      }
      const expanded = get().expanded;
      if (expanded.some((r) => r.kind !== 'vault' && r.path === card.path)) {
        const gone = subtree(card.path);
        gone.add(card.path);
        set({ expanded: expanded.filter((r) => r.kind === 'vault' || !gone.has(r.path)) });
      } else {
        set({ expanded: [...expanded, nextLevel(card)] });
      }
      return get().load();
    },
    back: async (i) => {
      set({ stack: get().stack.slice(0, Math.max(1, i + 1)), expanded: [], focus: null });
      return get().load();
    },
    up: async (path) => {
      if (mode() === 'expand') {
        const ref = get().expanded.find((r) => r.kind !== 'vault' && r.path === path);
        const card = get().canvas.cards.find((c) => c.path === path);
        if (ref && card) return get().open(card);
        return;
      }
      if (get().stack.length > 1) return get().back(get().stack.length - 2);
    },
    modeChanged: async () => {
      set({ expanded: [], focus: null });
      return get().load();
    },
    pin: (path, at) => {
      set({ pinned: { ...get().pinned, [path]: at } });
      if (pinTimer) clearTimeout(pinTimer);
      pinTimer = setTimeout(savePins, PIN_SAVE_MS);
    },
    resetLayout: async () => {
      if (pinTimer) clearTimeout(pinTimer);
      pinTimer = null;
      set({ pinned: {} });
      const { stack } = get();
      await layoutSet(canvasKey(mode(), stack[stack.length - 1]), {});
    },
    setFocus: (focus) => set({ focus }),
    reset: () => {
      seq++;
      if (pinTimer) clearTimeout(pinTimer);
      pinTimer = null;
      set({
        stack: [{ kind: 'vault' }],
        expanded: [],
        levels: {},
        canvas: EMPTY_CANVAS,
        edges: [],
        pinned: {},
        focus: null,
        loaded: false,
      });
    },
  };
});
