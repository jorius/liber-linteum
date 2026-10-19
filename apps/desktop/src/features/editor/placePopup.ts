// Where a popup anchored to a line of text goes (M4b §4): under the line, or
// above it when there's no room below, always inside the window — also when
// the line itself has scrolled out of view.

export interface Anchor {
  top: number;
  bottom: number;
  left: number;
}

const GAP = 6;
const MARGIN = 8;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function placePopup(
  anchor: Anchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; above: boolean } {
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - size.height;
  const roomBelow = viewport.height - MARGIN - below;
  const roomAbove = anchor.top - GAP - MARGIN;
  let top: number;
  let flipped = false;
  if (size.height <= roomBelow || roomBelow >= roomAbove) top = below;
  else {
    top = above;
    flipped = true;
  }
  return {
    top: clamp(top, MARGIN, Math.max(MARGIN, viewport.height - MARGIN - size.height)),
    left: clamp(anchor.left, MARGIN, Math.max(MARGIN, viewport.width - MARGIN - size.width)),
    above: flipped,
  };
}
