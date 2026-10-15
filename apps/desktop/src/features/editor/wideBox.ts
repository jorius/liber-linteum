// Wide elements (M4b part 3): on a `wide` page, text keeps the readable
// measure while the kinds chosen in Settings escape it, centred on the text
// column, up to the editor's width. Live Preview's host says which kinds
// (data-wide-*) and how wide they may get (--nimw-wide-max); the CSS in
// Editor.module.css does the rest.
import type { PageWidth, WideElements } from '../../ipc';

/** Live Preview's side padding around the measure (Editor.module.css). */
export const LIVE_PADDING = 40;

const KINDS: (keyof WideElements)[] = ['tables', 'code', 'diagrams', 'images', 'maths'];

/** The widest a wide element may be: the scroller less the gutter and both
 *  side paddings. Centred on the text column, it then stays clear of the
 *  gutter and of the scroller's edges. */
export function wideMax(scroller: number, gutter: number, padding: number): number {
  return Math.max(0, Math.floor(scroller - gutter - 2 * padding));
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
