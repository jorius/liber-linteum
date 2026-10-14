import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GvCard, GvLevel, GvLevelRef } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { buildCanvas, canvasKey, levelKey, useGvStore } from './gvStore';

/** A card with defaults; folders get a `kind` of project/folder. */
function card(path: string, kind: GvCard['kind'] = 'page', extra: Partial<GvCard> = {}): GvCard {
  return {
    path,
    kind,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
    subtitle: null,
    cover: null,
    coverRemote: false,
    coverY: null,
    excerpt: '',
    hasImage: false,
    hasAudio: false,
    indexPage: null,
    pages: 0,
    folders: 0,
    childTitles: [],
    relation: null,
    ...extra,
  };
}

/** The levels of a small vault: projects A and B, A/Sub, pages linking. */
const LEVELS: Record<string, GvLevel> = {
  '': { cards: [card('A', 'project'), card('B', 'project'), card('root.md')], centre: null },
  A: { cards: [card('A/Sub', 'folder'), card('A/a.md'), card('A/b.md')], centre: null },
  'A/Sub': { cards: [card('A/Sub/deep.md')], centre: null },
  B: { cards: [card('B/q.md')], centre: null },
  'page:A/a.md': {
    cards: [
      card('A/a.md', 'page', { relation: 'centre' }),
      card('B/q.md', 'page', { relation: 'out' }),
      card('root.md', 'page', { relation: 'in' }),
    ],
    centre: 'A/a.md',
  },
};

let calls: [string, Record<string, unknown>][];
let levels: Record<string, GvLevel>;

beforeEach(() => {
  calls = [];
  levels = { ...LEVELS };
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useGvStore.getState().reset();
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push([cmd, args]);
    if (cmd === 'gv_children') {
      const key = levelKey(args.level as GvLevelRef);
      const found = levels[key];
      if (!found) throw { kind: 'notFound', message: key };
      return found;
    }
    if (cmd === 'gv_edges') return [];
    if (cmd === 'layout_get') return {};
    return null;
  });
});

afterEach(() => {
  vi.useRealTimers();
  clearMocks();
});

const paths = () => useGvStore.getState().canvas.cards.map((c) => c.path);
const mode = (m: 'drill' | 'expand') =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, globalViewMode: m } });

describe('Global View store (M3a §5)', () => {
  it('drill-down: a click opens the next level; the breadcrumb goes back', async () => {
    const gv = useGvStore.getState();
    await gv.load();
    expect(paths()).toEqual(['A', 'B', 'root.md']);
    await gv.open(card('A', 'project'));
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }, { kind: 'folder', path: 'A' }]);
    expect(paths()).toEqual(['A/Sub', 'A/a.md', 'A/b.md']);
    await useGvStore.getState().open(card('A/a.md'));
    expect(paths()).toEqual(['A/a.md', 'B/q.md', 'root.md']);
    expect(useGvStore.getState().canvas.centre).toBe('A/a.md');
    // Edges are asked for exactly what is on the canvas.
    expect(calls.filter(([c]) => c === 'gv_edges').at(-1)?.[1]).toEqual({
      visible: ['A/a.md', 'B/q.md', 'root.md'],
    });
    await useGvStore.getState().back(0);
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }]);
    expect(paths()).toEqual(['A', 'B', 'root.md']);
  });

  it('expand in place: children join beside the card, no duplicates; a second click collapses', async () => {
    mode('expand');
    const gv = useGvStore.getState();
    await gv.load();
    await gv.open(card('A', 'project'));
    expect(paths()).toEqual(['A', 'B', 'root.md', 'A/Sub', 'A/a.md', 'A/b.md']);
    await useGvStore.getState().open(card('A/Sub', 'folder'));
    // a.md's neighbourhood: root.md is already on the canvas, B/q.md isn't
    // (only its folder card B is).
    await useGvStore.getState().open(card('A/a.md'));
    const canvas = useGvStore.getState().canvas;
    expect(canvas.cards.map((c) => c.path)).toEqual([
      'A',
      'B',
      'root.md',
      'A/Sub',
      'A/a.md',
      'A/b.md',
      'A/Sub/deep.md',
      'B/q.md',
    ]);
    expect(canvas.children.get('A')).toEqual(['A/Sub', 'A/a.md', 'A/b.md']);
    expect(canvas.children.get('A/Sub')).toEqual(['A/Sub/deep.md']);
    expect(canvas.children.get('A/a.md')).toEqual(['B/q.md']);
    expect(useGvStore.getState().stack, 'the root level stays').toEqual([{ kind: 'vault' }]);
    // Collapsing A takes everything expanded from it.
    await useGvStore.getState().open(card('A', 'project'));
    expect(paths()).toEqual(['A', 'B', 'root.md']);
    expect(useGvStore.getState().expanded).toEqual([]);
  });

  it('a level that no longer exists falls back to the nearest one that does', async () => {
    const gv = useGvStore.getState();
    await gv.load();
    await gv.open(card('A', 'project'));
    await useGvStore.getState().open(card('A/Sub', 'folder'));
    delete levels['A/Sub'];
    await useGvStore.getState().load();
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }, { kind: 'folder', path: 'A' }]);
    expect(paths()).toEqual(['A/Sub', 'A/a.md', 'A/b.md']);
  });

  it('GV-31: dragged positions are saved per canvas (debounced, only cards on it); reset clears them', async () => {
    vi.useFakeTimers();
    const gv = useGvStore.getState();
    await gv.load();
    useGvStore.setState({ pinned: { gone: { x: 0, y: 0 } } });
    gv.pin('A', { x: 10, y: 20 });
    gv.pin('B', { x: 30, y: 40 });
    expect(calls.some(([c]) => c === 'layout_set')).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.filter(([c]) => c === 'layout_set')).toEqual([
      ['layout_set', { level: '', positions: { A: { x: 10, y: 20 }, B: { x: 30, y: 40 } } }],
    ]);
    await useGvStore.getState().resetLayout();
    expect(calls.at(-1)).toEqual(['layout_set', { level: '', positions: {} }]);
    expect(useGvStore.getState().pinned).toEqual({});
  });

  it('failing edge and layout reads leave the cards showing', async () => {
    mockIPC((cmd, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      if (cmd === 'gv_children') return levels[levelKey(args.level as GvLevelRef)];
      if (cmd === 'gv_edges') throw { kind: 'io', message: 'x' };
      return undefined; // layout_get answering nothing
    });
    await useGvStore.getState().load();
    expect(paths()).toEqual(['A', 'B', 'root.md']);
    expect(useGvStore.getState().edges).toEqual([]);
    expect(useGvStore.getState().pinned).toEqual({});
  });

  it('shownKey names the level the canvas holds: the breadcrumb moves first, the key when the level arrives', async () => {
    await useGvStore.getState().load();
    expect(useGvStore.getState().shownKey).toBe('');
    const opening = useGvStore.getState().open(card('A', 'project'));
    expect(useGvStore.getState().stack.at(-1)).toEqual({ kind: 'folder', path: 'A' });
    expect(useGvStore.getState().shownKey, 'still the vault while A loads').toBe('');
    await opening;
    expect(useGvStore.getState().shownKey).toBe('A');
    mode('expand');
    await useGvStore.getState().modeChanged();
    expect(useGvStore.getState().shownKey).toBe('expand:A');
  });

  it('a slower, older load never overwrites a newer one', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    mockIPC(async (cmd, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      if (cmd === 'gv_children') {
        const key = levelKey(args.level as GvLevelRef);
        if (key === '') await held;
        return levels[key];
      }
      if (cmd === 'gv_edges') return [];
      if (cmd === 'layout_get') return {};
      return null;
    });
    const first = useGvStore.getState().load();
    useGvStore.setState({ stack: [{ kind: 'vault' }, { kind: 'folder', path: 'B' }] });
    await useGvStore.getState().load();
    release();
    await first;
    expect(paths()).toEqual(['B/q.md']);
  });
});

describe('New entry folder (GV-17)', () => {
  it('is the vault root, the folder shown or the folder of a page level; in Expand, the focused card', async () => {
    const gv = useGvStore.getState();
    await gv.load();
    expect(gv.entryDir()).toBe('');
    await gv.open(card('A', 'project'));
    expect(useGvStore.getState().entryDir()).toBe('A');
    await useGvStore.getState().open(card('A/a.md'));
    expect(useGvStore.getState().entryDir()).toBe('A');
    mode('expand');
    await useGvStore.getState().back(0);
    useGvStore.getState().setFocus('B');
    expect(useGvStore.getState().entryDir()).toBe('B');
    useGvStore.getState().setFocus('root.md');
    expect(useGvStore.getState().entryDir()).toBe('');
  });
});

describe('canvas helpers', () => {
  it('canvas keys follow the arch §3.1 level keys', () => {
    expect(levelKey({ kind: 'vault' })).toBe('');
    expect(levelKey({ kind: 'folder', path: 'A' })).toBe('A');
    expect(levelKey({ kind: 'page', path: 'A/a.md' })).toBe('page:A/a.md');
    expect(canvasKey('drill', { kind: 'folder', path: 'A' })).toBe('A');
    expect(canvasKey('expand', { kind: 'vault' })).toBe('expand:');
  });

  it('buildCanvas without the expanded level loaded shows just the root', () => {
    const canvas = buildCanvas('expand', { kind: 'vault' }, [{ kind: 'folder', path: 'A' }], {
      '': LEVELS[''],
    });
    expect(canvas.cards.map((c) => c.path)).toEqual(['A', 'B', 'root.md']);
  });
});
