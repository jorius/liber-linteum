import { describe, expect, it } from 'vitest';
import { fit, panBy, zoomAt } from './panZoom';

const identity = { scale: 1, x: 0, y: 0 };

describe('Part B: pan and zoom maths', () => {
  it('zoomAt keeps the point under the pointer', () => {
    const v = zoomAt(identity, 2, 100, 50);
    expect(v.scale).toBe(2);
    // Content point (100,50) is drawn at x + 100·scale.
    expect(v.x + 100 * v.scale).toBe(100);
    expect(v.y + 50 * v.scale).toBe(50);
  });

  it('zoomAt clamps to 0.25 and 8', () => {
    expect(zoomAt(identity, 100, 0, 0).scale).toBe(8);
    expect(zoomAt(identity, 0.01, 0, 0).scale).toBe(0.25);
  });

  it('panBy adds', () => {
    expect(panBy({ scale: 2, x: 10, y: 20 }, 5, -7)).toEqual({ scale: 2, x: 15, y: 13 });
  });

  it('fit centres and never upscales', () => {
    expect(fit({ w: 200, h: 100 }, { w: 800, h: 600 })).toEqual({ scale: 1, x: 300, y: 250 });
    expect(fit({ w: 1600, h: 600 }, { w: 800, h: 600 }).scale).toBe(0.5);
  });
});
