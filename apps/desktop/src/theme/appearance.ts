import type { Settings } from '../ipc';
import { derive } from './derive';
import { fontStack } from './fonts';
import { paletteCss } from './paletteCss';

/** Id of the `<style>` holding the custom-accent palette. */
export const CUSTOM_STYLE_ID = 'liber-custom-palette';

/** Applies the palette and the editor fonts (M2b §4–5): built-in palettes are
 *  an attribute on `<html>` (their CSS ships in palettes.css); a custom accent
 *  also gets a generated stylesheet with its light and dark tokens; fonts and
 *  text size are CSS variables on `<html>`. */
export function applyAppearance(
  s: Pick<Settings, 'palette' | 'accentColor' | 'fontLivePreview' | 'fontSource' | 'fontSize'>,
  root: HTMLElement = document.documentElement,
): void {
  root.style.setProperty('--font-live', fontStack(s.fontLivePreview, 'live'));
  root.style.setProperty('--font-source', fontStack(s.fontSource, 'source'));
  root.style.setProperty('--font-size-editor', `${s.fontSize}px`);
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
