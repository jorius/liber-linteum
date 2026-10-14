import { describe, expect, it } from 'vitest';
import {
  CARD_H,
  CARD_W,
  columnsLayout,
  gridLayout,
  nearestInDirection,
  neighbourhoodLayout,
  withPinned,
  type XY,
} from './layout';

const obj = (m: Map<string, XY>) => Object.fromEntries(m);

describe('Global View layouts (M3a §7)', () => {
  it('grid: cells of 300 × 370 from (48, 48), as many columns as fit', () => {
    const cards = ['a', 'b', 'c', 'd', 'e'];
    expect(obj(gridLayout(cards, 1220))).toEqual({
      a: { x: 48, y: 48 },
      b: { x: 348, y: 48 },
      c: { x: 648, y: 48 },
      d: { x: 948, y: 48 },
      e: { x: 48, y: 418 },
    });
    expect(gridLayout(cards, 700).get('c'), 'two columns').toEqual({ x: 48, y: 418 });
    expect(gridLayout(cards, 100).get('b'), 'at least one').toEqual({ x: 48, y: 418 });
  });

  it('columns: children right of their parent, the parent level with its first child', () => {
    const children = new Map([
      ['A', ['A/1', 'A/2']],
      ['A/2', ['A/2/x']],
    ]);
    expect(obj(columnsLayout(['A', 'B'], children))).toEqual({
      A: { x: 48, y: 48 },
      'A/1': { x: 358, y: 48 },
      'A/2': { x: 358, y: 388 },
      'A/2/x': { x: 668, y: 388 },
      B: { x: 48, y: 728 },
    });
    expect(columnsLayout(['A'], new Map([['A', []]])).get('A')).toEqual({ x: 48, y: 48 });
  });

  it('neighbourhood: backlinks left, the page centred, links out right', () => {
    const at = neighbourhoodLayout([
      { path: 'p', relation: 'centre' },
      { path: 'in1', relation: 'in' },
      { path: 'out1', relation: 'out' },
      { path: 'both', relation: 'both' },
      { path: 'out2', relation: 'out' },
    ]);
    expect(obj(at)).toEqual({
      in1: { x: 48, y: 388 },
      p: { x: 358, y: 388 },
      out1: { x: 668, y: 48 },
      both: { x: 668, y: 388 },
      out2: { x: 668, y: 728 },
    });
    expect(obj(neighbourhoodLayout([{ path: 'p', relation: 'centre' }]))).toEqual({
      p: { x: 358, y: 48 },
    });
  });

  it('pinned positions override the layout, only for cards on the canvas', () => {
    const auto = new Map([
      ['a', { x: 48, y: 48 }],
      ['b', { x: 348, y: 48 }],
    ]);
    expect(obj(withPinned(auto, { b: { x: 5, y: 6 }, gone: { x: 1, y: 1 } }))).toEqual({
      a: { x: 48, y: 48 },
      b: { x: 5, y: 6 },
    });
  });

  it('GV-18 arrow keys: the nearest card in that direction, by card centres', () => {
    const at = new Map<string, XY>([
      ['c', { x: 300, y: 300 }],
      ['right', { x: 620, y: 320 }],
      ['farRight', { x: 950, y: 300 }],
      ['upRight', { x: 600, y: -100 }],
      ['down', { x: 280, y: 680 }],
      ['left', { x: 0, y: 290 }],
    ]);
    expect(nearestInDirection('c', at, 'right')).toBe('right');
    expect(nearestInDirection('c', at, 'down')).toBe('down');
    expect(nearestInDirection('c', at, 'left')).toBe('left');
    expect(nearestInDirection('c', at, 'up'), 'off-axis is still above').toBe('upRight');
    expect(nearestInDirection('left', at, 'left')).toBeNull();
    expect(nearestInDirection('missing', at, 'left')).toBeNull();
    expect(CARD_W).toBe(240);
    expect(CARD_H).toBe(300);
  });
});
