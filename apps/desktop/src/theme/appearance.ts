import type { Settings } from '../ipc';
import { fontStack } from './fonts';
import { paletteCss } from './paletteCss';

/** Id of the `<style>` holding the selected custom theme. */
export const CUSTOM_STYLE_ID = 'liber-custom-palette';

/** Applies the palette and the editor fonts (M2b §4–5): built-in palettes are
 *  an attribute on `<html>` (their CSS ships in palettes.css); a custom theme
 *  (custom themes §2) also gets a generated stylesheet with its light and dark
 *  tokens, and falls back to Lavender when it no longer exists; fonts and text
 *  size are CSS variables on `<html>`. */
export function applyAppearance(
  s: Pick<
    Settings,
    'palette' | 'customThemes' | 'customTheme' | 'fontLivePreview' | 'fontSource' | 'fontSize'
  >,
  root: HTMLElement = document.documentElement,
): void {
  root.style.setProperty('--font-live', fontStack(s.fontLivePreview, 'live'));
  root.style.setProperty('--font-source', fontStack(s.fontSource, 'source'));
  root.style.setProperty('--font-size-editor', `${s.fontSize}px`);
  const theme =
    s.palette === 'custom' ? s.customThemes.find((t) => t.id === s.customTheme) : undefined;
  root.dataset.palette = s.palette === 'custom' && !theme ? 'lavender' : s.palette;
  const doc = root.ownerDocument;
  let style = doc.getElementById(CUSTOM_STYLE_ID);
  if (!theme) {
    style?.remove();
    return;
  }
  if (!style) {
    style = doc.createElement('style');
    style.id = CUSTOM_STYLE_ID;
    doc.head.append(style);
  }
  style.textContent = paletteCss({ id: 'custom', light: theme.light, dark: theme.dark });
}
