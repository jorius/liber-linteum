// `.ts` extension: scripts/gen-palettes.ts runs this file directly in Node.
import { alpha, contrast, hexToOklch, mix, oklchToHex } from './color.ts';
import type { Palette, PaletteTokens } from './palettes';

/** A palette's mode as app CSS custom properties (M2b §4 mapping table). The
 *  in-between shades are mixed here as plain hex, so no `color-mix()` is
 *  needed at runtime. */
export function paletteVars(p: Palette, mode: 'light' | 'dark'): Record<string, string> {
  const t: PaletteTokens = p[mode];
  return {
    '--color-bg': t.bg,
    '--color-bg-dots': mix(t.bg, t.border, 0.6),
    '--color-surface': t.surface,
    '--color-surface-subtle': mix(t.surface, t.bg, 0.5),
    '--color-border': t.border,
    '--color-border-strong': mix(t.border, t.text, 0.1),
    '--color-text': t.text,
    '--color-text-strong': t.strong,
    '--color-text-body': t.body,
    '--color-text-muted': t.muted,
    '--color-text-faint': mix(t.muted, t.bg, 0.15),
    '--color-accent': t.accent,
    '--color-accent-hover': mix(t.accent, t.text, 0.15),
    '--color-accent-contrast': t.contrast,
    '--color-accent-soft': t.soft,
    // Custom themes §2, §6: tags (text on its own tint) and the filled star;
    // the sidebar's star and drop ring read on the sidebar itself.
    '--color-secondary': t.secondary,
    '--color-secondary-soft': mix(t.surface, t.secondary, 0.12),
    '--color-sidebar-secondary': sidebarMarks(p, mode).star,
    '--color-focus': t.accent,
    '--color-sidebar-bg': t.side,
    '--color-sidebar-text': t.sideText,
    '--color-sidebar-selected': t.sideSel,
    // Hover, pressed and divider shades on the (always dark) sidebar, and the
    // backdrops behind dialogs and the opening overlay: generated here, not
    // with color-mix(), which Safari before 16.2 drops (M3b §7).
    '--color-sidebar-hover': mix(t.side, t.sideText, 0.12),
    '--color-sidebar-active': mix(t.side, t.sideText, 0.16),
    '--color-sidebar-divider': mix(t.side, t.sideText, 0.15),
    '--color-backdrop': alpha(t.bg, 0.6),
    '--color-overlay': alpha(t.bg, 0.7),
    '--color-drop-bg': t.sideSel,
    '--color-drop-ring': sidebarMarks(p, mode).ring,
    '--color-highlight-bg': t.mark,
    '--color-code-bg': t.code,
    // Global View (M3a §4, §6): the canvas sits between page and card;
    // relationships are drawn wider than links, so the kinds differ by more
    // than colour.
    '--color-canvas': mix(t.bg, t.surface, 0.35),
    '--color-card-border': mix(t.border, t.text, 0.05),
    '--color-edge-link': t.accent,
    '--color-edge-tree': t.muted,
    // Custom themes §2: relationships take the palette's secondary colour.
    '--color-edge-manual': t.secondary,
    // M4b §1, §3: the header band's pills over a cover (translucent surface,
    // no color-mix()), and the danger button, fixed per mode like the manual
    // edge so it reads as "danger" in every palette.
    '--color-surface-veil': alpha(t.surface, 0.88),
    // 0.1.2: the band's rows as glass over a cover; the veil above returns
    // when the OS asks for more contrast or less transparency.
    '--color-surface-glass': alpha(t.surface, 0.38),
    '--color-danger': DANGER[mode].bg,
    '--color-danger-contrast': DANGER[mode].text,
    // M5b §6: "Saved" in green, readable on this palette's header and on its
    // veiled pill over a black or white cover (final review M14).
    '--color-success': readableOn(
      [t.surface, mix(t.surface, '#000000', 0.12), mix(t.surface, '#ffffff', 0.12)],
      145,
      0.14,
      mode,
    ),
    // M4b part 2 §2: syntax colours, readable on this palette's code background.
    ...codeTokens(t.code, t.text, t.muted, mode),
  };
}

/** The sidebar's filled star and drop ring (custom themes review M13): the
 *  dark-mode secondary and accent, which suit the usual dark sidebar, unless
 *  they read below 3:1 on this mode's sidebar (a custom light one); then the
 *  variant that reads best. */
export function sidebarMarks(p: Palette, mode: 'light' | 'dark'): { star: string; ring: string } {
  const side = p[mode].side;
  const pick = (dark: string, light: string) =>
    contrast(dark, side) >= 3 || contrast(dark, side) >= contrast(light, side) ? dark : light;
  return {
    star: pick(p.dark.secondary, p.light.secondary),
    ring: pick(p.dark.accent, p.light.accent),
  };
}

/** Hue and chroma per syntax token (OKLCH); lightness is found per palette. */
const CODE_HUES = {
  '--code-keyword': [305, 0.16],
  '--code-string': [145, 0.14],
  '--code-number': [50, 0.15],
  '--code-function': [255, 0.15],
  '--code-type': [85, 0.13],
  '--code-meta': [0, 0.15],
  '--code-comment': [270, 0.02],
} as const;

/** The first lightness, walking from the starting point away from the
 *  background, at which `hue` reads at ≥ 4.6:1 on `bg` (each of them). */
function readableOn(
  bg: string | string[],
  hue: number,
  chroma: number,
  mode: 'light' | 'dark',
): string {
  const step = mode === 'light' ? -0.01 : 0.01;
  const bgs = typeof bg === 'string' ? [bg] : bg;
  for (let L = mode === 'light' ? 0.52 : 0.78; L > 0.05 && L < 0.99; L += step) {
    const hex = oklchToHex(L, chroma, hue);
    if (bgs.every((b) => contrast(hex, b) >= 4.6)) return hex;
  }
  return mode === 'light' ? '#000000' : '#ffffff';
}

/** Syntax token colours for a code background (Safari 15: plain hex). */
function codeTokens(
  code: string,
  text: string,
  muted: string,
  mode: 'light' | 'dark',
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, [hue, chroma]] of Object.entries(CODE_HUES))
    out[key] = readableOn(code, hue, chroma, mode);
  out['--code-variable'] = text;
  out['--code-punct'] =
    contrast(muted, code) >= 4.5 ? muted : readableOn(code, hexToOklch(muted)[2], 0.02, mode);
  return out;
}

/** Danger buttons (Delete, Remove, Discard): the shared red, text ≥ 4.5:1. */
export const DANGER = {
  light: { bg: '#b42318', text: '#ffffff' },
  dark: { bg: '#ff9d92', text: '#1b1426' },
} as const;

const block = (selector: string, vars: Record<string, string>, indent = '') =>
  `${indent}${selector} {\n${Object.entries(vars)
    .map(([k, v]) => `${indent}  ${k}: ${v};`)
    .join('\n')}\n${indent}}\n`;

/** The palette's CSS: light on `[data-palette]`, dark for "system" in a dark
 *  OS and for an explicit dark theme (same pattern as tokens.css). */
export function paletteCss(p: Palette): string {
  const root = `:root[data-palette='${p.id}']`;
  const dark = { ...paletteVars(p, 'dark'), 'color-scheme': 'dark' };
  return (
    block(root, paletteVars(p, 'light')) +
    `@media (prefers-color-scheme: dark) {\n${block(`${root}:not([data-theme='light'])`, dark, '  ')}}\n` +
    block(`${root}[data-theme='dark']`, dark)
  );
}
