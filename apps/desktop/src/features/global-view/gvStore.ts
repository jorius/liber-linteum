// Global View state (M3a §5, §7): the drill-down stack (breadcrumb), the
// cards expanded in place, the loaded levels, edges and pinned positions.
import i18next from 'i18next';
import { create } from 'zustand';
import {
  gvChildren,
  gvEdges,
  layoutGet,
  layoutSet,
  type CardPosition,
  type CommandError,
  type GlobalViewMode,
  type GvCard,
  type GvEdge,
  type GvLevel,
  type GvLevelRef,
  type IpcResult,
} from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { relate } from '../../stores/relations';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { onBeforeVaultSwitch, useVaultStore } from '../../stores/vaultStore';

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

/** The page a card stands for in a relationship (M3b §2): itself, or a
 *  folder's index note; `null` for a folder without one. */
export const pageOf = (card: GvCard): string | null =>
  card.kind === 'page' ? card.path : card.indexPage;

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
  /** Titles of the page levels opened, by path: their breadcrumb labels
   *  (final review m1). */
  titles: Record<string, string>;
  canvas: Canvas;
  /** Layout key of the level `canvas` was loaded for (the stack changes
   *  first, the canvas when the level arrives). */
  shownKey: string | null;
  edges: GvEdge[];
  /** Pinned positions of the current canvas. */
  pinned: Record<string, CardPosition>;
  /** The card with keyboard focus (roving tabindex). */
  focus: string | null;
  /** Connect mode (M3b §2): the card a relationship starts from. */
  connectFrom: GvCard | null;
  loaded: boolean;
  /** Reads what the canvas shows: levels (falling back from deleted ones;
   *  any other failure keeps what is shown), edges and pinned positions. */
  load: () => Promise<void>;
  /** A single click: the next level (Drill-down; none for a page level's
   *  own page) or expand / collapse. */
  open: (card: GvCard) => Promise<void>;
  /** Breadcrumb: back to `stack[i]`, focus on the card that opened the
   *  level after it. */
  back: (i: number) => Promise<void>;
  /** Escape (M3a §5): one level up, or collapse `path` in Expand. */
  up: (path: string | null) => Promise<void>;
  /** The mode changed: keep the root level, forget expansions. */
  modeChanged: () => Promise<void>;
  /** The folder New entry creates its page in (GV-17, M3a §5). */
  entryDir: () => string;
  pin: (path: string, at: CardPosition) => void;
  resetLayout: () => Promise<void>;
  setFocus: (path: string | null) => void;
  /** "Connect to…": the next card picked completes the relationship. */
  startConnect: (card: GvCard) => void;
  cancelConnect: () => void;
  /** A card picked in connect mode (click, Enter). */
  completeConnect: (target: GvCard) => Promise<void>;
  /** A drag from `from`'s connect handle dropped on `to` (or on nothing). */
  connectByDrag: (from: string, to: string | null) => Promise<void>;
  reset: () => void;
}

const mode = (): GlobalViewMode => useSettingsStore.getState().settings.globalViewMode;
let seq = 0;
let pinTimer: ReturnType<typeof setTimeout> | null = null;
type Positions = Record<string, CardPosition>;
/** A drag waiting for its save: the key of the canvas it was made on and
 *  that canvas's pins, taken at the drag (final review I1) — a reload or a
 *  new level never drops it or files it under another key. */
let pending: { key: string; positions: Positions } | null = null;
/** Saves sent and not yet answered, by key: a read of that level may still
 *  come back without them. */
const inFlight = new Map<string, Positions>();
/** The same saves, to wait for before the vault switches. */
const sending = new Set<Promise<void>>();

/** A failed save was reported; the next failure is, once one succeeds. */
let saveFailed = false;

/** Saves run in the background: a failure is toasted once, not per drag
 *  (final review m8). */
function reportSave(res: IpcResult<void>) {
  if (res.ok) {
    saveFailed = false;
  } else if (!saveFailed) {
    saveFailed = true;
    useToastStore.getState().push({
      message: i18next.t('gv.layoutSaveFailed', { error: errorMessage(res.error) }),
      tone: 'error',
    });
  }
}

/** The drill stack and expansions of the canvas shown. */
let shownAt: { stack: GvLevelRef[]; expanded: GvLevelRef[] } | null = null;

/** Sends the waiting drag now. */
function flushPins() {
  if (pinTimer) clearTimeout(pinTimer);
  pinTimer = null;
  const save = pending;
  pending = null;
  if (!save) return;
  inFlight.set(save.key, save.positions);
  const sent = layoutSet(save.key, save.positions).then((res) => {
    if (inFlight.get(save.key) === save.positions) inFlight.delete(save.key);
    sending.delete(sent);
    reportSave(res);
  });
  sending.add(sent);
}

/** Pins of `key` not yet on disk (sent, or still waiting). */
function unsaved(key: string): Positions {
  return { ...inFlight.get(key), ...(pending?.key === key ? pending.positions : {}) };
}

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

  /** A level read failing for another reason than being gone (a busy or
   *  closing session): the breadcrumb stays on the level the canvas shows,
   *  and the error is told (final review m12). */
  function unreadable(error: CommandError) {
    if (shownAt && get().stack !== shownAt.stack) {
      set({ stack: shownAt.stack, expanded: shownAt.expanded });
    }
    // No vault: it is closing, and the view starts over with the next one.
    if (error.kind !== 'noVault') {
      useToastStore.getState().push({ message: errorMessage(error), tone: 'error' });
    }
  }

  /** A folder without an index note can't take part (M3b §2). */
  function needsIndex(card: GvCard): boolean {
    if (pageOf(card)) return false;
    useToastStore.getState().push({
      message: i18next.t('gv.relations.noIndex', { name: card.title }),
      tone: 'error',
    });
    return true;
  }

  /** Relates the pages `from` and `to` stand for: a new relationship (the
   *  edges are re-read), or the dialog of the one that exists. */
  async function relateCards(from: GvCard, to: GvCard) {
    if (needsIndex(from) || needsIndex(to)) return;
    const source = pageOf(from)!;
    const target = pageOf(to)!;
    if (source === target) return;
    const res = await relate(source, target);
    if (res.status === 'created') {
      useToastStore.getState().push({ message: i18next.t('gv.relations.created'), tone: 'info' });
      await get().load();
    } else if (res.status === 'exists') {
      useUiStore.getState().openDialog({ type: 'relations', page: source, other: target });
    }
  }

  return {
    connectFrom: null,
    stack: [{ kind: 'vault' }],
    expanded: [],
    levels: {},
    titles: {},
    canvas: EMPTY_CANVAS,
    shownKey: null,
    edges: [],
    pinned: {},
    focus: null,
    loaded: false,
    load: async () => {
      flushPins();
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
        if (res.error.kind !== 'notFound' || root.kind === 'vault') return unreadable(res.error);
        stack = stack.length > 1 ? stack.slice(0, -1) : [{ kind: 'vault' }];
        expanded = [];
      }
      const results = await Promise.all(expanded.map((ref) => gvChildren(ref)));
      if (mine !== seq) return;
      for (const res of results) {
        if (!res.ok && res.error.kind !== 'notFound') return unreadable(res.error);
      }
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
      const key = canvasKey(m, root);
      shownAt = { stack, expanded };
      const centre = canvas.cards.find((c) => c.path === canvas.centre);
      set({
        stack,
        expanded,
        levels,
        titles: centre ? { ...get().titles, [centre.path]: centre.title } : get().titles,
        canvas,
        shownKey: key,
        // A layout or edge read that fails (or answers nothing) just means
        // none: the canvas still shows.
        edges: edges.ok && Array.isArray(edges.value) ? edges.value : [],
        pinned: { ...(pinned.ok && pinned.value ? pinned.value : {}), ...unsaved(key) },
        focus: focus && shown.has(focus) ? focus : null,
        loaded: true,
      });
    },
    open: async (card) => {
      // Connect mode: a click picks the other card (no navigation, M3b §2).
      if (get().connectFrom) return get().completeConnect(card);
      if (mode() === 'drill') {
        // The page this level is about: already open (final review m2).
        if (card.path === get().canvas.centre) return;
        const titles = card.kind === 'page' ? { ...get().titles, [card.path]: card.title } : null;
        set({ stack: [...get().stack, nextLevel(card)], focus: null, ...(titles && { titles }) });
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
      set({ connectFrom: null });
      const stack = get().stack.slice(0, Math.max(1, i + 1));
      // A level is opened from the card of the same path: the keyboard goes
      // back to it (final review m13).
      const left = get().stack[stack.length];
      const focus = left && left.kind !== 'vault' ? left.path : null;
      set({ stack, expanded: [], focus });
      return get().load();
    },
    up: async (path) => {
      if (get().connectFrom) return get().cancelConnect();
      if (mode() === 'expand') {
        const ref = get().expanded.find((r) => r.kind !== 'vault' && r.path === path);
        const card = get().canvas.cards.find((c) => c.path === path);
        if (ref && card) return get().open(card);
        return;
      }
      if (get().stack.length > 1) return get().back(get().stack.length - 2);
    },
    modeChanged: async () => {
      set({ expanded: [], focus: null, connectFrom: null });
      return get().load();
    },
    entryDir: () => {
      const parent = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
      const { stack, focus, canvas } = get();
      const focused =
        mode() === 'expand' && focus ? canvas.cards.find((c) => c.path === focus) : null;
      if (focused) return focused.kind === 'page' ? parent(focused.path) : focused.path;
      const root = stack[stack.length - 1];
      if (root.kind === 'vault') return '';
      return root.kind === 'folder' ? root.path : parent(root.path);
    },
    pin: (path, at) => {
      const { shownKey: key, canvas } = get();
      if (key === null) return;
      const pinned = { ...get().pinned, [path]: at };
      set({ pinned });
      if (pending && pending.key !== key) flushPins();
      // Entries of deleted paths are pruned here (M3a §7); a card merely off
      // the canvas (a collapsed child in Expand) keeps its place (final
      // review I6).
      const kept = new Set(canvas.cards.map((c) => c.path));
      for (const n of useVaultStore.getState().nodes) kept.add(n.path);
      pending = {
        key,
        positions: Object.fromEntries(Object.entries(pinned).filter(([p]) => kept.has(p))),
      };
      if (pinTimer) clearTimeout(pinTimer);
      pinTimer = setTimeout(flushPins, PIN_SAVE_MS);
    },
    resetLayout: async () => {
      const { stack, shownKey } = get();
      const key = shownKey ?? canvasKey(mode(), stack[stack.length - 1]);
      // A drag on this canvas still waiting is superseded; one on another
      // canvas is saved first.
      if (pending?.key === key) {
        if (pinTimer) clearTimeout(pinTimer);
        pinTimer = null;
        pending = null;
      } else flushPins();
      inFlight.delete(key);
      set({ pinned: {} });
      reportSave(await layoutSet(key, {}));
    },
    setFocus: (focus) => set({ focus }),
    startConnect: (card) => {
      if (needsIndex(card)) return;
      set({ connectFrom: card, focus: card.path });
    },
    cancelConnect: () => set({ connectFrom: null }),
    completeConnect: async (target) => {
      const from = get().connectFrom;
      if (!from || target.path === from.path) return;
      set({ connectFrom: null });
      await relateCards(from, target);
    },
    connectByDrag: async (from, to) => {
      if (!to || to === from) return;
      const cards = get().canvas.cards;
      const a = cards.find((c) => c.path === from);
      const b = cards.find((c) => c.path === to);
      if (a && b) await relateCards(a, b);
    },
    reset: () => {
      seq++;
      if (pinTimer) clearTimeout(pinTimer);
      pinTimer = null;
      pending = null;
      inFlight.clear();
      saveFailed = false;
      shownAt = null;
      set({
        connectFrom: null,
        stack: [{ kind: 'vault' }],
        expanded: [],
        levels: {},
        titles: {},
        canvas: EMPTY_CANVAS,
        shownKey: null,
        edges: [],
        pinned: {},
        focus: null,
        loaded: false,
      });
    },
  };
});

// A drag still waiting is saved into its own vault before another opens or
// it closes; a new vault (or none) starts the view over at level 0. The
// view subscribes to the vault store, which knows nothing of it (m15).
onBeforeVaultSwitch(async () => {
  flushPins();
  await Promise.all([...sending]);
});
useVaultStore.subscribe((s, prev) => {
  if (s.info !== prev.info) useGvStore.getState().reset();
});
