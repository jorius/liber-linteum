import { describe, expect, it } from 'vitest';
import { placePopup } from './placePopup';

const viewport = { width: 1000, height: 800 };
const size = { width: 320, height: 300 };

describe('placePopup (M4b §4: the ⌘K picker stays in the window)', () => {
  it('opens under the line, aligned with it', () => {
    expect(placePopup({ top: 100, bottom: 120, left: 200 }, size, viewport)).toEqual({
      top: 126,
      left: 200,
      above: false,
    });
  });

  it('flips above the line when there is no room below', () => {
    expect(placePopup({ top: 700, bottom: 720, left: 200 }, size, viewport)).toEqual({
      top: 394,
      left: 200,
      above: true,
    });
  });

  it('keeps inside the window at the right edge', () => {
    expect(placePopup({ top: 100, bottom: 120, left: 900 }, size, viewport).left).toBe(672);
  });

  it('stays clamped to the nearest edge when the line scrolls out of view', () => {
    const below = placePopup({ top: 1200, bottom: 1220, left: 200 }, size, viewport);
    expect(below.top).toBe(800 - 8 - 300);
    const above = placePopup({ top: -400, bottom: -380, left: 200 }, size, viewport);
    expect(above.top).toBe(8);
  });

  it('a window too short for either side gets the larger side, clamped', () => {
    const short = { width: 1000, height: 400 };
    const p = placePopup({ top: 150, bottom: 170, left: 0 }, size, short);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + size.height).toBeLessThanOrEqual(400 - 8 + 0.5);
    expect(p.left).toBe(8);
  });

  it('never goes under the drawn title bar (custom title bar §2)', () => {
    const withBar = { ...viewport, top: 38 };
    const above = placePopup({ top: -400, bottom: -380, left: 200 }, size, withBar);
    expect(above.top).toBe(38 + 8);
    // A menu at a low row opens upwards, below the bar.
    const low = placePopup({ top: 700, bottom: 700, left: 200 }, size, withBar);
    expect(low.above).toBe(true);
    expect(low.top).toBeGreaterThanOrEqual(38 + 8);
  });
});
