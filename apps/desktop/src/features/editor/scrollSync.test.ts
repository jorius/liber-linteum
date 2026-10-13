import { describe, expect, it } from 'vitest';
import { blockForOffset, offsetAtTop } from './scrollSync';

/** A pane with blocks at fixed vertical positions (jsdom has no layout). */
function pane(blocks: [start: number, end: number, top: number, height: number, depth?: number][]) {
  const root = document.createElement('div');
  Object.defineProperty(root, 'getBoundingClientRect', { value: () => ({ top: 0, height: 500 }) });
  let parent = root;
  for (const [start, end, top, height, depth] of blocks) {
    const el = document.createElement('div');
    el.dataset.sourceStart = String(start);
    el.dataset.sourceEnd = String(end);
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ top: top - root.scrollTop, height }),
    });
    (depth ? parent : root).appendChild(el);
    parent = el;
  }
  return root;
}

describe('Split scroll sync (M2a §3.2)', () => {
  const p = pane([
    [0, 10, 0, 40],
    [12, 200, 50, 400], // a list…
    [14, 60, 60, 100, 1], // …and its first item
    [202, 220, 460, 30],
  ]);

  it('maps a source offset to the deepest block containing it', () => {
    expect(blockForOffset(p, 5)?.dataset.sourceStart).toBe('0');
    expect(blockForOffset(p, 20)?.dataset.sourceStart).toBe('14');
    expect(blockForOffset(p, 100)?.dataset.sourceStart).toBe('12');
    expect(blockForOffset(p, 11)?.dataset.sourceStart).toBe('12'); // between blocks: the next
  });

  it('maps the top of the pane back to a source offset', () => {
    p.scrollTop = 0;
    expect(offsetAtTop(p)).toBe(0);
    p.scrollTop = 70;
    expect(offsetAtTop(p)).toBe(14);
    p.scrollTop = 300;
    expect(offsetAtTop(p)).toBe(12);
  });
});
