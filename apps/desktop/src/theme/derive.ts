import { contrast, hexToOklch, mix, oklchToHex } from './color';
import type { PaletteTokens } from './palettes';

/** Accent contrast floors (M2b §4): text-sized accent on the surface. */
export const LIGHT_ACCENT_FLOOR = 4.8;
export const DARK_ACCENT_FLOOR = 6;
/** Accent text on the accent-soft tint (tags, pressed toolbar buttons, the
 *  "Aa" toggle) must stay readable too, in both modes. */
export const SOFT_ACCENT_FLOOR = 4.5;

/** A complete light/dark palette from one accent colour (M2b §4): the accent
 *  is darkened (light mode) or lightened (dark mode) until it reads as text
 *  on the surface and on the accent-soft tint, chroma is capped, and neutrals take a faint tint of the
 *  accent's hue (none for greys). Ported from the reference page. */
/** The secondary colour (custom themes §2): the given one, or the accent's
 *  hue turned 150°, at the first lightness that reads on the surface, on its
 *  own tag tint and (as a relationship line) on the canvas. */
function secondaryFor(
  fallbackHue: number,
  c0: number,
  bg: string,
  surface: string,
  mode: 'light' | 'dark',
  given?: string,
): string {
  const [Lg, cg, hg] = given
    ? hexToOklch(given.toLowerCase())
    : [mode === 'light' ? 0.55 : 0.75, c0, fallbackHue];
  const chroma = Math.min(cg, mode === 'light' ? 0.17 : 0.14);
  const canvas = mix(bg, surface, 0.35);
  const ok = (x: string) =>
    contrast(x, surface) >= 4.6 &&
    contrast(x, mix(surface, x, 0.12)) >= 4.6 &&
    contrast(x, canvas) >= 3;
  const step = mode === 'light' ? -0.005 : 0.005;
  const start =
    mode === 'light' ? Math.min(Math.max(Lg, 0.15), 0.62) : Math.min(Math.max(Lg, 0.7), 0.97);
  for (let L = start; L > 0.05 && L < 0.99; L += step) {
    const x = oklchToHex(L, chroma, hg);
    if (ok(x)) return x;
  }
  return mode === 'light' ? '#000000' : '#ffffff';
}

export function derive(
  hex: string,
  secondary?: string,
): { light: PaletteTokens; dark: PaletteTokens } {
  const [L0, c0, h] = hexToOklch(hex.toLowerCase());
  const tint = (c: number) => (c0 < 0.03 ? 0 : c);
  const at = (L: number, C: number) => oklchToHex(L, C, h);
  const lightSurface = '#ffffff';
  const darkSurface = at(0.205, tint(0.014));
  const lightSoft = at(0.94, tint(0.035));
  const darkSoft = at(0.3, tint(0.05));

  let lightAccent = hex;
  for (let x = Math.min(Math.max(L0, 0.15), 0.62); x > 0.1; x -= 0.01) {
    lightAccent = at(x, Math.min(c0, 0.17));
    if (
      contrast(lightAccent, lightSurface) >= LIGHT_ACCENT_FLOOR &&
      contrast(lightAccent, lightSoft) >= SOFT_ACCENT_FLOOR
    )
      break;
  }
  let darkAccent = hex;
  for (let x = Math.min(Math.max(L0, 0.7), 0.97); x < 0.99; x += 0.01) {
    darkAccent = at(x, Math.min(c0, 0.13));
    if (
      contrast(darkAccent, darkSurface) >= DARK_ACCENT_FLOOR &&
      contrast(darkAccent, darkSoft) >= SOFT_ACCENT_FLOOR
    )
      break;
  }
  const lightBg = at(0.965, tint(0.012));
  const darkBg = at(0.17, tint(0.012));
  const h2 = (h + 150) % 360;
  const c2 = c0 < 0.03 ? 0 : Math.min(c0, 0.14);
  const on = (bg: string) =>
    contrast('#ffffff', bg) >= contrast('#111111', bg) ? '#ffffff' : '#111111';

  return {
    light: {
      bg: lightBg,
      surface: lightSurface,
      border: at(0.9, tint(0.02)),
      text: at(0.2, tint(0.02)),
      strong: at(0.24, tint(0.05)),
      body: at(0.38, tint(0.025)),
      muted: at(0.52, tint(0.03)),
      accent: lightAccent,
      secondary: secondaryFor(h2, c2, lightBg, lightSurface, 'light', secondary),
      soft: lightSoft,
      contrast: on(lightAccent),
      side: at(0.2, tint(0.015)),
      sideText: at(0.88, tint(0.02)),
      sideSel: 'rgba(255,255,255,.12)',
      mark: '#fbf1c7',
      code: at(0.945, tint(0.012)),
    },
    dark: {
      bg: darkBg,
      surface: darkSurface,
      border: at(0.3, tint(0.02)),
      text: at(0.94, tint(0.01)),
      strong: at(0.97, tint(0.01)),
      body: at(0.84, tint(0.015)),
      muted: at(0.7, tint(0.02)),
      accent: darkAccent,
      secondary: secondaryFor(h2, c2, darkBg, darkSurface, 'dark', secondary),
      soft: darkSoft,
      contrast: on(darkAccent),
      side: at(0.14, tint(0.01)),
      sideText: at(0.88, tint(0.02)),
      sideSel: 'rgba(255,255,255,.12)',
      mark: '#4a3f12',
      code: at(0.25, tint(0.014)),
    },
  };
}
