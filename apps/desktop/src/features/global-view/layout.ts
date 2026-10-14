// Global View layouts (M3a §7): deterministic placements taken from the
// prototype (`design/prototype/Main.dc.html`), plus pinned overrides and the
// arrow-key geometry (GV-18). Pure functions.
import type { GvRelation } from '../../ipc';

export const CARD_W = 240;
export const CARD_H = 300;
/** Grid cells (drill-down vault and folder levels). */
export const CELL_W = 300;
export const CELL_H = 370;
/** Columns (Expand, neighbourhoods). */
export const COL_W = 310;
export const ROW_H = 340;
export const ORIGIN = 48;

export interface XY {
  x: number;
  y: number;
}

/** Rows of as many 300-px columns as fit `width` (at least one). */
export function gridLayout(paths: string[], width: number): Map<string, XY> {
  const cols = Math.max(1, Math.floor((width - ORIGIN - CARD_W) / CELL_W) + 1);
  return new Map(
    paths.map((p, i) => [
      p,
      { x: ORIGIN + (i % cols) * CELL_W, y: ORIGIN + Math.floor(i / cols) * CELL_H },
    ]),
  );
}

/** Expand in place: each expansion fills the column right of its card, rows
 *  in depth-first order; a card with children sits level with the first. */
export function columnsLayout(roots: string[], children: Map<string, string[]>): Map<string, XY> {
  const out = new Map<string, XY>();
  let row = 0;
  const place = (path: string, depth: number) => {
    const x = ORIGIN + depth * COL_W;
    const kids = children.get(path) ?? [];
    if (!kids.length) {
      out.set(path, { x, y: ORIGIN + row * ROW_H });
      row++;
      return;
    }
    out.set(path, { x, y: ORIGIN + row * ROW_H });
    for (const kid of kids) place(kid, depth + 1);
  };
  for (const root of roots) place(root, 0);
  return out;
}

/** A page level: backlinks left, the page in the middle, links out (and
 *  both ways) right; each column centred on the page. */
export function neighbourhoodLayout(
  cards: { path: string; relation: GvRelation | null }[],
): Map<string, XY> {
  const left = cards.filter((c) => c.relation === 'in');
  const right = cards.filter((c) => c.relation === 'out' || c.relation === 'both');
  const centre = cards.find((c) => c.relation === 'centre');
  const rows = Math.max(left.length, right.length, 1);
  const top = (n: number) => ORIGIN + ((rows - n) * ROW_H) / 2;
  const out = new Map<string, XY>();
  left.forEach((c, i) => out.set(c.path, { x: ORIGIN, y: top(left.length) + i * ROW_H }));
  if (centre) out.set(centre.path, { x: ORIGIN + COL_W, y: top(1) });
  right.forEach((c, i) =>
    out.set(c.path, { x: ORIGIN + 2 * COL_W, y: top(right.length) + i * ROW_H }),
  );
  return out;
}

/** `auto` with the pinned positions of cards that are on the canvas. */
export function withPinned(auto: Map<string, XY>, pinned: Record<string, XY>): Map<string, XY> {
  const out = new Map(auto);
  for (const [path, at] of Object.entries(pinned)) if (out.has(path)) out.set(path, at);
  return out;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** The card an arrow key moves to: the nearest one whose centre lies that way,
 *  preferring cards within 45° of the arrow (GV-18). */
export function nearestInDirection(
  from: string,
  at: Map<string, XY>,
  dir: Direction,
): string | null {
  const here = at.get(from);
  if (!here) return null;
  let best: { path: string; score: number } | null = null;
  for (const [path, p] of at) {
    if (path === from) continue;
    const dx = p.x - here.x;
    const dy = p.y - here.y;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    const score = along + across * 2 + (across > along ? 10_000 : 0);
    if (!best || score < best.score) best = { path, score };
  }
  return best?.path ?? null;
}
