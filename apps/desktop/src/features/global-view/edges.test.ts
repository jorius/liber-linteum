import { describe, expect, it } from 'vitest';
import { dashScale, exitPoint, strokeOf, strongest, type DrawnEdge } from './edges';

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
