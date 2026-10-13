import type { Point, Position } from 'unist';

/** Maps UTF-16 offsets to unist points (1-based line/column). */
export function locator(src: string) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  const point = (offset: number): Point => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1, offset };
  };
  const position = (start: number, end: number): Position => ({
    start: point(start),
    end: point(end),
  });
  return { point, position };
}
