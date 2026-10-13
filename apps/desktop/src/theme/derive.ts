import { contrast, hexToOklch, oklchToHex } from './color';
import type { PaletteTokens } from './palettes';

/** Accent contrast floors (M2b §4): text-sized accent on the surface. */
export const LIGHT_ACCENT_FLOOR = 4.8;
export const DARK_ACCENT_FLOOR = 6;

/** A complete light/dark palette from one accent colour (M2b §4): the accent
 *  is darkened (light mode) or lightened (dark mode) until it reads as text
 *  on the surface, chroma is capped, and neutrals take a faint tint of the
 *  accent's hue (none for greys). Ported from the reference page. */
export function derive(hex: string): { light: PaletteTokens; dark: PaletteTokens } {
  const [L0, c0, h] = hexToOklch(hex.toLowerCase());
  const tint = (c: number) => (c0 < 0.03 ? 0 : c);
  const at = (L: number, C: number) => oklchToHex(L, C, h);
  const lightSurface = '#ffffff';
  const darkSurface = at(0.205, tint(0.014));

  let lightAccent = hex;
  for (let x = Math.min(Math.max(L0, 0.15), 0.62); x > 0.1; x -= 0.01) {
    lightAccent = at(x, Math.min(c0, 0.17));
    if (contrast(lightAccent, lightSurface) >= LIGHT_ACCENT_FLOOR) break;
  }
  let darkAccent = hex;
  for (let x = Math.min(Math.max(L0, 0.7), 0.97); x < 0.99; x += 0.01) {
    darkAccent = at(x, Math.min(c0, 0.13));
    if (contrast(darkAccent, darkSurface) >= DARK_ACCENT_FLOOR) break;
  }
  const on = (bg: string) =>
    contrast('#ffffff', bg) >= contrast('#111111', bg) ? '#ffffff' : '#111111';

  return {
    light: {
      bg: at(0.965, tint(0.012)),
      surface: lightSurface,
      border: at(0.9, tint(0.02)),
      text: at(0.2, tint(0.02)),
      strong: at(0.24, tint(0.05)),
      body: at(0.38, tint(0.025)),
      muted: at(0.52, tint(0.03)),
      accent: lightAccent,
      soft: at(0.94, tint(0.035)),
      contrast: on(lightAccent),
      side: at(0.2, tint(0.015)),
      sideText: at(0.88, tint(0.02)),
      sideSel: 'rgba(255,255,255,.12)',
      mark: '#fbf1c7',
      code: at(0.945, tint(0.012)),
    },
    dark: {
      bg: at(0.17, tint(0.012)),
      surface: darkSurface,
      border: at(0.3, tint(0.02)),
      text: at(0.94, tint(0.01)),
      strong: at(0.97, tint(0.01)),
      body: at(0.84, tint(0.015)),
      muted: at(0.7, tint(0.02)),
      accent: darkAccent,
      soft: at(0.3, tint(0.05)),
      contrast: on(darkAccent),
      side: at(0.14, tint(0.01)),
      sideText: at(0.88, tint(0.02)),
      sideSel: 'rgba(255,255,255,.12)',
      mark: '#4a3f12',
      code: at(0.25, tint(0.014)),
    },
  };
}
