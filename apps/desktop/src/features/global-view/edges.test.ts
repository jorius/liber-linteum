import { describe, expect, it } from 'vitest';
import {
  chipWidth,
  dashScale,
  elbowPath,
  exitPoint,
  focusEdges,
  labelOf,
  strokeOf,
  strongest,
  type DrawnEdge,
} from './edges';

describe('Global View edges (M3a §6)', () => {
  it('end at the card border, 5 px out, on the line between centres', () => {
    const box = { x: 0, y: 0, w: 240, h: 300 }; // centre (120, 150)
    expect(exitPoint(box, { x: 1000, y: 150 })).toEqual({ x: 245, y: 150 });
    expect(exitPoint(box, { x: 120, y: -500 })).toEqual({ x: 120, y: -5 });
    // At 45° a card taller than wide is left through its side: (240, 270) + 5 px.
    const corner = exitPoint(box, { x: 1120, y: 1150 });
    expect(corner.x).toBeCloseTo(243.54, 1);
    expect(corner.y).toBeCloseTo(273.54, 1);
    expect(exitPoint(box, { x: 120, y: 150 })).toEqual({ x: 120, y: 150 });
  });

  it('GV-21: every kind differs by more than colour (width or dash pattern)', () => {
    const kinds = [
      strokeOf('link', false),
      strokeOf('link', true),
      strokeOf('tree', false),
      strokeOf('manual', false),
      strokeOf('manual', true),
    ];
    const shapes = new Set(kinds.map((s) => `${s.width}/${s.dash ?? 'solid'}`));
    expect(shapes.size).toBe(kinds.length);
  });

  it('M4b part 3 §5: parent/child is thin and solid, links from inside folders long dashes', () => {
    expect(strokeOf('tree', false)).toMatchObject({ width: 1.25 });
    expect(strokeOf('tree', false).dash).toBeUndefined();
    expect(strokeOf('link', true)).toMatchObject({ width: 3, dash: '10 6' });
  });
});

describe('parent/child routing (M4b part 3 §5)', () => {
  const box = (x: number, y: number, w = 240, h = 300) => ({ x, y, w, h });
  /** The path's commands, and its points in order. */
  const parse = (d: string) => {
    const cmds = d.replace(/[^MLHV]/g, '');
    let x = 0;
    let y = 0;
    const points: [number, number][] = [];
    for (const [, c, a, b] of d.matchAll(/([MLHV])(-?[\d.]+)(?:,(-?[\d.]+))?/g)) {
      if (c === 'M' || c === 'L') [x, y] = [Number(a), Number(b)];
      else if (c === 'H') x = Number(a);
      else y = Number(a);
      points.push([x, y]);
    }
    return { cmds, points };
  };

  it('a tree drawn top-down (atoms): down from the parent, across, down into the child', () => {
    const { cmds, points } = parse(elbowPath(box(0, 0), box(400, 500), 'v'));
    expect(cmds).toBe('MVHV');
    expect(points[0]).toEqual([120, 305]); // the parent's bottom, 5 px out
    expect(points[points.length - 1]).toEqual([520, 495]); // the child's top, 5 px out
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      expect(a[0] === b[0] || a[1] === b[1], 'orthogonal').toBe(true);
    }
  });

  it('a child beside (Expand in place): right from the parent, down, right into the child', () => {
    const { cmds, points } = parse(elbowPath(box(0, 0), box(310, 340)));
    expect(cmds).toBe('MHVH');
    expect(points[0]).toEqual([245, 150]);
    expect(points[points.length - 1]).toEqual([305, 490]);
    // And to the left, or above, the mirror images.
    expect(parse(elbowPath(box(400, 0), box(0, 0))).cmds).toBe('MHVH');
    expect(parse(elbowPath(box(0, 800), box(0, 0))).points[0]).toEqual([120, 795]);
  });

  it('overlapping cards: a straight line between centres', () => {
    expect(elbowPath(box(0, 0), box(10, 10))).toBe('M120,150L130,160');
  });
});

describe('count chips (M4b part 3 §5)', () => {
  const e = (extra: Partial<DrawnEdge>): DrawnEdge => ({
    id: 'x',
    source: 'A',
    target: 'B',
    kind: 'link',
    aggregated: true,
    directed: false,
    count: 12,
    label: null,
    ...extra,
  });
  const words = (count: number, kind: string) => `${count} ${kind === 'manual' ? 'rel' : 'links'}`;

  it('say how many links an edge stands for; a relationship keeps its label', () => {
    expect(labelOf(e({}), words)).toBe('12 links');
    expect(labelOf(e({ count: 1 }), words)).toBeNull();
    expect(labelOf(e({ kind: 'manual', label: 'mentor of', count: 1 }), words)).toBe('mentor of');
    expect(labelOf(e({ kind: 'manual', label: 'mentor of', count: 3 }), words)).toBe(
      'mentor of · 3 rel',
    );
    expect(labelOf(e({ kind: 'manual', label: 'x'.repeat(30), count: 1 }), words)).toBe(
      `${'x'.repeat(23)}…`,
    );
  });

  it('a chip is as wide as its text', () => {
    expect(chipWidth('12 links')).toBeGreaterThan(chipWidth('3'));
    expect(chipWidth('')).toBeGreaterThan(0);
  });
});

describe('focus mode (M4b part 3 §5)', () => {
  function canvas() {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="react-flow__node" data-id="A"></div>
      <div class="react-flow__node" data-id="B"></div>
      <div class="react-flow__node" data-id="C"></div>
      <div class="react-flow__node" data-id="D"></div>
      <svg>
        <path data-a="A" data-b="B"></path>
        <path data-a="C" data-b="A"></path>
        <path data-a="C" data-b="D"></path>
        <text data-a="A" data-b="B">2 links</text>
      </svg>`;
    return root;
  }
  const hot = (root: HTMLElement) =>
    [...root.querySelectorAll('[data-gv-hot]')].map(
      (el) =>
        (el as HTMLElement).dataset.id ??
        `${el.getAttribute('data-a')}-${el.getAttribute('data-b')}`,
    );

  it("a card's edges and neighbours stay lit; leaving lights everything again", () => {
    const root = canvas();
    focusEdges(root, 'A');
    expect(root).toHaveAttribute('data-gv-focusing');
    expect(hot(root).sort()).toEqual(['A', 'A-B', 'A-B', 'B', 'C', 'C-A']);
    focusEdges(root, 'D');
    expect(hot(root).sort()).toEqual(['C', 'C-D', 'D']);
    focusEdges(root, null);
    expect(root).not.toHaveAttribute('data-gv-focusing');
    expect(hot(root)).toEqual([]);
  });

  it('paths with quotes or brackets are matched literally', () => {
    const root = document.createElement('div');
    root.innerHTML = '<svg><path></path></svg>';
    const path = root.querySelector('path')!;
    path.setAttribute('data-a', 'a "b" [c].md');
    path.setAttribute('data-b', 'z');
    focusEdges(root, 'a "b" [c].md');
    expect(path).toHaveAttribute('data-gv-hot');
  });
});

describe('edge drawing budget (final review I2)', () => {
  const to = (id: string, count: number, aggregated = true): DrawnEdge => ({
    id,
    source: 'A',
    target: id,
    kind: 'link',
    aggregated,
    directed: false,
    count,
    label: null,
  });

  it('keeps every direct edge and the strongest aggregated ones, ties in order', () => {
    const edges = [to('d', 1, false), to('a', 3), to('b', 9), to('c', 3), to('e', 1)];
    const out = strongest(edges, 2);
    expect(out.edges.map((e) => e.id)).toEqual(['d', 'a', 'b']);
    expect(out).toMatchObject({ aggregated: 4, hidden: 2 });
    expect(strongest(edges, 4)).toEqual({ edges, aggregated: 4, hidden: 0 });
  });

  it('dash patterns lengthen when zoomed out, in steps of √2, never when zoomed in', () => {
    expect(dashScale(1)).toBe(1);
    expect(dashScale(2)).toBe(1);
    expect(dashScale(0.5)).toBeCloseTo(2);
    expect(dashScale(0.25)).toBeCloseTo(4);
    expect(dashScale(0.7)).toBeCloseTo(Math.SQRT2);
    expect(dashScale(0)).toBe(1);
  });
});
