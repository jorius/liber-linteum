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

/** Where popups may go; `top` is the first usable row (below the title bar
 *  the page draws outside macOS, custom title bar §2). */
export interface Viewport {
  width: number;
  height: number;
  top?: number;
}

/** The window's area for popups: below the drawn title bar, if there is one. */
export function windowViewport(): Viewport {
  const bar = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height');
  return { width: window.innerWidth, height: window.innerHeight, top: parseFloat(bar) || 0 };
}

export function placePopup(
  anchor: Anchor,
  size: { width: number; height: number },
  viewport: Viewport,
): { top: number; left: number; above: boolean } {
  const first = (viewport.top ?? 0) + MARGIN;
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - size.height;
  const roomBelow = viewport.height - MARGIN - below;
  const roomAbove = anchor.top - GAP - first;
  let top: number;
  let flipped = false;
  if (size.height <= roomBelow || roomBelow >= roomAbove) top = below;
  else {
    top = above;
    flipped = true;
  }
  return {
    top: clamp(top, first, Math.max(first, viewport.height - MARGIN - size.height)),
    left: clamp(anchor.left, MARGIN, Math.max(MARGIN, viewport.width - MARGIN - size.width)),
    above: flipped,
  };
}
