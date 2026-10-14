import { describe, expect, it } from 'vitest';
import { exitPoint, strokeOf } from './edges';

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
