const NBSP = String.fromCharCode(0xa0);

/** Says `text` to screen readers through the app's polite live region
 *  (visually hidden, made on first use): the `[[` list's match count
 *  (M4b §4), "Copied" (final review M7). Unchanged text isn't read again
 *  unless `repeat` (a no-break space then tells it apart). */
export function announce(text: string, repeat = false): void {
  let region = document.querySelector<HTMLElement>('[data-nimw-status]');
  if (!region) {
    region = document.createElement('div');
    region.setAttribute('data-nimw-status', '');
    region.setAttribute('role', 'status');
    region.className = 'nimw-sr-only';
    document.body.appendChild(region);
  }
  region.textContent = repeat && region.textContent === text ? text + NBSP : text;
}
