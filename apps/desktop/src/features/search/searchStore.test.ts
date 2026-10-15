import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchPage, SearchQuery } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useVaultStore } from '../../stores/vaultStore';
import { DEBOUNCE_MS, EMPTY_FILTERS, activeFilters, useSearchStore } from './searchStore';

const page = (paths: string[], extra: Partial<SearchPage> = {}): SearchPage => ({
  results: paths.map((path) => ({
    path,
    title: path,
    cover: null,
    tags: [],
    hasImage: false,
    hasAudio: false,
    snippet: null,
  })),
  total: paths.length,
  facets: { projects: [], tags: [], linksTo: [], linksFrom: null, hasImage: 0, hasAudio: 0 },
  recent: false,
  indexing: false,
  ...extra,
});

let queries: SearchQuery[];
/** Answers, by text; a function lets a test hold an answer back. */
let answer: (q: SearchQuery) => SearchPage | Promise<SearchPage>;

beforeEach(() => {
  queries = [];
  answer = (q) => page([`${q.text || 'recent'}.md`]);
  useSearchStore.getState().reset();
  mockIPC((cmd, raw) => {
    if (cmd !== 'search') return null;
    const q = (raw as { query: SearchQuery }).query;
    queries.push(q);
    return answer(q);
  });
});
afterEach(() => {
  vi.useRealTimers();
  clearMocks();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('search store (M5 §4)', () => {
  it('debounces typing: three keys in 50 ms send one search', async () => {
    vi.useFakeTimers();
    const s = useSearchStore.getState();
    s.setText('d');
    await vi.advanceTimersByTimeAsync(20);
    s.setText('dr');
    await vi.advanceTimersByTimeAsync(20);
    s.setText('dra');
    expect(queries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(queries.map((q) => q.text)).toEqual(['dra']);
    expect(useSearchStore.getState().page?.results[0].path).toBe('dra.md');
  });

  it('drops a stale answer that arrives last', async () => {
    let release: (p: SearchPage) => void = () => undefined;
    answer = (q) =>
      q.text === 'dra' ? new Promise<SearchPage>((r) => (release = r)) : page(['dragon.md']);
    useSearchStore.setState({ text: 'dra' });
    const first = useSearchStore.getState().refresh();
    useSearchStore.setState({ text: 'dragon' });
    await useSearchStore.getState().refresh();
    release(page(['dra.md']));
    await first;
    expect(useSearchStore.getState().page?.results[0].path).toBe('dragon.md');
  });

  it('a filter change searches at once, with every filter', async () => {
    useSearchStore.getState().setFilters({ tags: ['lore'], hasImage: true });
    await flush();
    expect(queries[0]).toMatchObject({ text: '', tags: ['lore'], hasImage: true, offset: 0 });
  });

  it('removes chips one at a time, the last first, and clears all', async () => {
    const s = useSearchStore.getState();
    s.setFilters({ project: 'Lore', tags: ['a', 'b'], linksTo: 'Smaug' });
    expect(activeFilters(useSearchStore.getState().filters).map((c) => c.kind)).toEqual([
      'project',
      'tag',
      'tag',
      'linksTo',
    ]);
    expect(s.removeLast()).toBe(true);
    expect(useSearchStore.getState().filters.linksTo).toBeNull();
    s.removeFilter({ kind: 'tag', value: 'a' });
    expect(useSearchStore.getState().filters.tags).toEqual(['b']);
    s.clearFilters();
    expect(useSearchStore.getState().filters).toEqual(EMPTY_FILTERS);
    expect(s.removeLast()).toBe(false);
  });

  it('Show more asks for the next page and appends it', async () => {
    answer = (q) =>
      q.offset
        ? page(['p51.md'])
        : { ...page(['p1.md']), total: 2, results: page(['p1.md']).results };
    useSearchStore.setState({ text: 'p' });
    await useSearchStore.getState().refresh();
    await useSearchStore.getState().showMore();
    expect(queries[1].offset).toBe(1);
    expect(useSearchStore.getState().extra.map((h) => h.path)).toEqual(['p51.md']);
    // A new search starts the list over.
    await useSearchStore.getState().refresh();
    expect(useSearchStore.getState().extra).toEqual([]);
  });

  it('keeps the query between openings and forgets it when the vault changes', async () => {
    useSearchStore.getState().setText('kept');
    useSearchStore.getState().setFilters({ tags: ['x'] });
    await flush();
    expect(useSearchStore.getState().text).toBe('kept');
    useVaultStore.setState({ info: { name: 'Other', root: '/other' } as never });
    expect(useSearchStore.getState().text).toBe('');
    expect(useSearchStore.getState().filters).toEqual(EMPTY_FILTERS);
    expect(useSearchStore.getState().page).toBeNull();
  });

  it('an answer that comes back after a vault switch is ignored', async () => {
    let release: (p: SearchPage) => void = () => undefined;
    answer = () => new Promise<SearchPage>((r) => (release = r));
    const pending = useSearchStore.getState().refresh();
    useSearchStore.getState().reset();
    release(page(['old-vault.md']));
    await pending;
    expect(useSearchStore.getState().page).toBeNull();
  });

  it('a failed search says why', async () => {
    mockIPC(() => {
      throw { kind: 'noVault', message: 'no vault' };
    });
    await useSearchStore.getState().refresh();
    expect(useSearchStore.getState().error).toBeTruthy();
    expect(useSearchStore.getState().loading).toBe(false);
  });

  it('Show more asks once while a page is loading (final review M6)', async () => {
    let release!: () => void;
    answer = (q) => {
      if (!q.offset) return { ...page(['p1.md']), total: 3 };
      return new Promise((r) => (release = () => r(page([`more${q.offset}.md`]))));
    };
    useSearchStore.setState({ text: 'p' });
    await useSearchStore.getState().refresh();
    const first = useSearchStore.getState().showMore();
    const second = useSearchStore.getState().showMore();
    expect(useSearchStore.getState().loadingMore).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(queries.filter((q) => q.offset)).toHaveLength(1);
    expect(useSearchStore.getState().extra.map((h) => h.path)).toEqual(['more1.md']);
    expect(useSearchStore.getState().loadingMore).toBe(false);
  });

  it('says when its answer is behind the text (final review I2)', async () => {
    vi.useFakeTimers();
    await useSearchStore.getState().refresh();
    expect(useSearchStore.getState().stale()).toBe(false);
    useSearchStore.getState().setText('smaug');
    expect(useSearchStore.getState().stale()).toBe(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(useSearchStore.getState().stale()).toBe(false);
  });
});
