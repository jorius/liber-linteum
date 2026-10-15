// Wide elements (M4b part 3): on a `wide` page, text keeps the readable
// measure while the kinds chosen in Settings escape it, centred on the text
// column, up to the editor's width. Live Preview's host says which kinds
// (data-wide-*) and how far they may reach past the text on each side
// (--nimw-wide-m, --nimw-wide-r); the CSS in Editor.module.css does the rest.
import type { PageWidth, WideElements } from '../../ipc';

/** Live Preview's side padding around the measure (Editor.module.css). */
export const LIVE_PADDING = 40;

const KINDS: (keyof WideElements)[] = ['tables', 'code', 'diagrams', 'images', 'maths'];

/** Where the text column is, and how far a wide element may reach: the
 *  scroller's edges, or the line-number gutter's, less the side padding. */
export interface WideRoom {
  textLeft: number;
  textRight: number;
  leftBound: number;
  rightBound: number;
}

/** How far past the text a wide element may reach: `m` on both sides
 *  (it grows evenly while both have room), then `r` on the right. On a wide
 *  page the line numbers sit at the editor's edge (M5b §7.2), so both sides
 *  have the same room and `m` equals `r`. */
export function wideExtents(room: WideRoom): { m: number; r: number } {
  const left = Math.max(0, Math.floor(room.textLeft - room.leftBound));
  const right = Math.max(0, Math.floor(room.rightBound - room.textRight));
  return { m: Math.min(left, right), r: right };
}

/** The host's attributes naming the kinds that go wide; none unless the
 *  page is `wide`. */
export function wideAttrs(width: PageWidth, kinds: WideElements): Record<string, string> {
  const out: Record<string, string> = {};
  if (width !== 'wide') return out;
  for (const kind of KINDS) if (kinds[kind]) out[`data-wide-${kind}`] = '';
  return out;
}

/** The widest of `lines` in columns, a tab counting as four: a code
 *  block's width in `ch`, so its lines share one box. */
export function widestLine(lines: Iterable<string>): number {
  let widest = 0;
  for (const line of lines) {
    let cols = 0;
    for (const ch of line) cols += ch === '\t' ? 4 : 1;
    if (cols > widest) widest = cols;
  }
  return widest;
}
