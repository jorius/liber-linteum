import type { Settings } from '../ipc';
import { derive } from './derive';
import { paletteCss } from './paletteCss';

/** Id of the `<style>` holding the custom-accent palette. */
export const CUSTOM_STYLE_ID = 'nimw-custom-palette';

/** Applies the palette (M2b §4): built-in palettes are an attribute on
 *  `<html>` (their CSS ships in palettes.css); a custom accent also gets a
 *  generated stylesheet with its light and dark tokens. */
export function applyAppearance(
  s: Pick<Settings, 'palette' | 'accentColor'>,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.palette = s.palette;
  const doc = root.ownerDocument;
  let style = doc.getElementById(CUSTOM_STYLE_ID);
  if (s.palette !== 'custom') {
    style?.remove();
    return;
  }
  if (!style) {
    style = doc.createElement('style');
    style.id = CUSTOM_STYLE_ID;
    doc.head.append(style);
  }
  style.textContent = paletteCss({ id: 'custom', ...derive(s.accentColor) });
}
