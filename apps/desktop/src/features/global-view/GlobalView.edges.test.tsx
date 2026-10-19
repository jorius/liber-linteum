// Global View edges in the rendered canvas (M3a §6). Level 0 of the 10k
// reference vault has ~2,600 aggregated edges, nearly all with a count:
// drawn as React Flow edges with HTML count labels they took 1.5–2.5 s in
// WebKit against NFR-03's 300 ms (final review I2).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GvCard, GvEdge, GvLevel, GvLevelRef } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { installReactFlowStubs } from '../../test/reactFlow';
import { EdgeLayer, MAX_AGGREGATED, type DrawnEdge } from './edges';
import { GlobalView } from './GlobalView';
import { levelKey, useGvStore } from './gvStore';

beforeAll(installReactFlowStubs);

function card(path: string, kind: GvCard['kind'] = 'project'): GvCard {
  return {
    path,
    kind,
    title: path,
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
  };
}

const edge = (from: string, to: string, extra: Partial<GvEdge> = {}): GvEdge => ({
  from,
  to,
  kind: 'link',
  aggregated: true,
  directed: false,
  count: 1,
  label: null,
  ...extra,
});

let level0: GvLevel;
let edges: GvEdge[];

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useGvStore.getState().reset();
  useUiStore.setState({ screen: 'global' });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'gv_children':
        if (levelKey(args.level as GvLevelRef) !== '') throw { kind: 'notFound', message: 'x' };
        return level0;
      case 'gv_edges':
        return edges;
      case 'layout_get':
        return {};
      default:
        return null;
    }
  });
  return clearMocks;
});

const drawn = (selector = '[data-gv-edge]') => document.querySelectorAll(selector);

describe('Global View edges (M3a §6, final review I2)', () => {
  it('a count is SVG text drawn with its edge, not an HTML label', async () => {
    level0 = { cards: [card('A'), card('B'), card('C')], centre: null };
    edges = [edge('A', 'B', { count: 3 }), edge('A', 'C', { aggregated: false })];
    render(<GlobalView />);
    await waitFor(() => expect(drawn()).toHaveLength(2));
    expect(drawn('[data-gv-edge="link-aggregated"]')).toHaveLength(1);
    expect(drawn('[data-gv-edge="link"]')).toHaveLength(1);
    const counts = drawn('[data-gv-count]');
    expect(counts).toHaveLength(1);
    expect([counts[0]!.namespaceURI, counts[0]!.localName]).toEqual([
      'http://www.w3.org/2000/svg',
      'text',
    ]);
    expect(counts[0]).toHaveTextContent('×3');
    expect(document.querySelector('.react-flow__edgelabel-renderer')?.childElementCount ?? 0).toBe(
      0,
    );
  });

  it('thousands of edges are one decorative layer: no React Flow edge per edge', async () => {
    const n = 80; // 3,160 pairs, direct links (aggregated ones are capped)
    level0 = { cards: Array.from({ length: n }, (_, i) => card(`P${i}`)), centre: null };
    edges = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        edges.push(edge(`P${i}`, `P${j}`, { aggregated: false, count: 2 + (i % 9) }));
      }
    }
    render(<GlobalView />);
    await screen.findByRole('button', { name: 'P0' });
    await waitFor(() => expect(drawn()).toHaveLength(edges.length), { timeout: 10_000 });
    expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(0);
    const layers = new Set([...drawn()].map((p) => p.closest('svg')));
    expect(layers.size).toBe(1);
    const [layer] = layers;
    expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(layer!.querySelectorAll('[data-gv-count]')).toHaveLength(edges.length);
  }, 30_000);

  it(`draws only the ${MAX_AGGREGATED} strongest aggregated edges, and says so`, async () => {
    const n = 40; // 780 aggregated pairs, plus one direct link
    level0 = { cards: Array.from({ length: n }, (_, i) => card(`P${i}`)), centre: null };
    edges = [edge('P0', 'P1', { aggregated: false })];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) edges.push(edge(`P${i}`, `P${j}`, { count: 1 + i + j }));
    }
    render(<GlobalView />);
    await waitFor(() =>
      expect(drawn('[data-gv-edge="link-aggregated"]')).toHaveLength(MAX_AGGREGATED),
    );
    expect(drawn('[data-gv-edge="link"]')).toHaveLength(1);
    expect(
      screen.getByText('Showing the 500 strongest of 780 links from inside folders.'),
    ).toBeVisible();
    // The weakest pairs went (P0–P2: ×3), the strongest stayed (P38–P39: ×78).
    const counts = [...drawn('[data-gv-count]')].map((t) => Number(t.textContent!.slice(1)));
    expect(Math.max(...counts)).toBe(78);
    expect(counts).not.toContain(3);
  });

  it('a long manual label shows its full text on hover, without panning (final review m4)', async () => {
    const long = 'inspired by the very long relationship label';
    level0 = { cards: [card('A'), card('B')], centre: null };
    edges = [
      edge('A', 'B', { kind: 'manual', aggregated: false, directed: true, label: long }),
      edge('A', 'C', { count: 5 }),
    ];
    level0.cards.push(card('C'));
    render(<GlobalView />);
    await waitFor(() => expect(drawn('[data-gv-count]')).toHaveLength(2));
    const [manual, count] = drawn('[data-gv-count]');
    expect(manual!.querySelector('title')).toHaveTextContent(long);
    expect(manual!.lastChild).toHaveTextContent('inspired by the very lo…');
    // The layer ignores the pointer; a label with a title must take it (for
    // the tooltip) and not start a pan.
    expect(getComputedStyle(manual!).pointerEvents).toBe('all');
    expect(manual).toHaveClass('nopan');
    expect(getComputedStyle(count!).pointerEvents).toBe('none');
    expect(count!.querySelector('title')).toBeNull();
  });

  it('no note while every edge is drawn', async () => {
    level0 = { cards: [card('A'), card('B')], centre: null };
    edges = [edge('A', 'B', { count: 4 })];
    render(<GlobalView />);
    await waitFor(() => expect(drawn()).toHaveLength(1));
    expect(screen.queryByText(/strongest/)).toBeNull();
  });

  it('M3b: a manual edge opens the relationships between its two cards', async () => {
    level0 = { cards: [card('A.md', 'page'), card('B.md', 'page'), card('C')], centre: null };
    edges = [
      edge('A.md', 'B.md', { kind: 'manual', aggregated: false, label: 'why' }),
      edge('A.md', 'C', { kind: 'manual', aggregated: true }),
    ];
    render(<GlobalView />);
    await waitFor(() => expect(drawn()).toHaveLength(2));
    // Only the direct relationship takes the pointer: an aggregated one stands
    // for many inside folders.
    const hits = document.querySelectorAll<SVGPathElement>('[data-gv-hit]');
    expect(hits).toHaveLength(1);
    expect(hits[0].classList).toContain('nopan');
    fireEvent.click(hits[0]);
    expect(useUiStore.getState().dialog).toEqual({
      type: 'relations',
      page: 'A.md',
      other: 'B.md',
    });
  });

  it('a relationship of a folder card is direct: drawn without the inside-folders toggle, and opens its index note’s dialog (final review I3)', async () => {
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        globalViewEdges: { ...DEFAULT_SETTINGS.globalViewEdges, aggregated: false },
      },
    });
    const gamma = { ...card('Gamma'), indexPage: 'Gamma/b.md', indexFrom: 'picked' as const };
    const alpha = { ...card('Alpha'), indexPage: 'Alpha/Alpha.md', indexFrom: 'named' as const };
    level0 = { cards: [alpha, gamma, card('Delta'), card('zeta.md', 'page')], centre: null };
    edges = [
      edge('Gamma', 'Alpha', { kind: 'manual', aggregated: false, directed: true }),
      edge('Gamma', 'zeta.md', { kind: 'manual', aggregated: false }),
      edge('Delta', 'zeta.md', { kind: 'manual', aggregated: true }),
    ];
    render(<GlobalView />);
    await waitFor(() => expect(drawn('[data-gv-edge="manual"]')).toHaveLength(2));
    expect(drawn('[data-gv-edge="manual-aggregated"]')).toHaveLength(0);
    const hits = document.querySelectorAll<SVGPathElement>('[data-gv-hit]');
    expect(hits).toHaveLength(2);
    fireEvent.click(hits[0]);
    expect(useUiStore.getState().dialog).toEqual({
      type: 'relations',
      page: 'Gamma/b.md',
      other: 'Alpha/Alpha.md',
    });
    fireEvent.click(hits[1]);
    expect(useUiStore.getState().dialog).toEqual({
      type: 'relations',
      page: 'Gamma/b.md',
      other: 'zeta.md',
    });
  });
});

describe('EdgeLayer hit paths (final review m16)', () => {
  it('a card that moves leaves the other edges’ hit paths alone (they are memoised)', () => {
    // Counts the edge layer's reads of each card's position (React Flow
    // reads every position on each change itself): a hit path that
    // re-renders reads its two cards' positions to draw itself.
    const reads = new Map<string, number>();
    const at = (id: string, x: number, y: number) => ({
      get x() {
        if (/edges\.tsx/.test(new Error().stack ?? '')) reads.set(id, (reads.get(id) ?? 0) + 1);
        return x;
      },
      get y() {
        return y;
      },
    });
    const node = (id: string, position: { x: number; y: number }): Node => ({
      id,
      position,
      data: { card: card(id, 'page') },
      style: { width: 240, height: 300 },
    });
    const manual = (source: string, target: string): DrawnEdge => ({
      id: `manual:${source}→${target}`,
      source,
      target,
      kind: 'manual',
      aggregated: false,
      directed: false,
      count: 1,
      label: null,
    });
    const onRelations = vi.fn();
    const view = (nodes: Node[]) => (
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={[]}>
          <EdgeLayer edges={[manual('A.md', 'B.md')]} onRelations={onRelations} />
        </ReactFlow>
      </ReactFlowProvider>
    );
    const a = node('A.md', at('A.md', 0, 0));
    const b = node('B.md', at('B.md', 400, 0));
    const { rerender } = render(view([a, b, node('C.md', at('C.md', 0, 400))]));
    expect(document.querySelectorAll('[data-gv-hit]')).toHaveLength(1);
    reads.clear();
    // C is dragged: a drag frame.
    rerender(view([a, b, node('C.md', at('C.md', 40, 400))]));
    expect(reads.get('A.md') ?? 0).toBe(0);
    expect(reads.get('B.md') ?? 0).toBe(0);
    fireEvent.click(document.querySelector('[data-gv-hit]')!);
    expect(onRelations).toHaveBeenCalledWith('A.md', 'B.md');
  });
});
