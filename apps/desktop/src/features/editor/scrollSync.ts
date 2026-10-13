// Split scroll sync (M2a §3.2): rendered blocks carry their source range
// (`data-source-start/end`), so the pane and the editor map onto each other.

const blocks = (pane: HTMLElement) => [
  ...pane.querySelectorAll<HTMLElement>('[data-source-start][data-source-end]'),
];
const startOf = (el: HTMLElement) => Number(el.dataset.sourceStart);
const endOf = (el: HTMLElement) => Number(el.dataset.sourceEnd);

/** Top of `el` within the pane's scrollable content. */
export const topIn = (pane: HTMLElement, el: HTMLElement): number =>
  el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;

/** The deepest rendered block containing source `offset`, else the next one. */
export function blockForOffset(pane: HTMLElement, offset: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const el of blocks(pane)) {
    // Document order: a later match inside an earlier one is deeper.
    if (startOf(el) <= offset && offset < endOf(el)) best = el;
    else if (!best && startOf(el) > offset) return el;
  }
  return best;
}

/** Source offset of the deepest block at the top edge of the pane. */
export function offsetAtTop(pane: HTMLElement): number | null {
  const y = pane.scrollTop;
  let best: HTMLElement | null = null;
  for (const el of blocks(pane)) {
    const top = topIn(pane, el);
    if (top <= y && y < top + el.getBoundingClientRect().height) best = el;
    else if (!best && top > y) return startOf(el);
  }
  return best ? startOf(best) : null;
}
