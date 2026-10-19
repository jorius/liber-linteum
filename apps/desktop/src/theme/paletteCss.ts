// `.ts` extension: scripts/gen-palettes.ts runs this file directly in Node.
import { alpha, mix } from './color.ts';
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
    // The sidebar is dark in both modes: its drop feedback uses the dark accent.
    '--color-drop-bg': t.sideSel,
    '--color-drop-ring': p.dark.accent,
    '--color-highlight-bg': t.mark,
    '--color-code-bg': t.code,
    // Global View (M3a §4, §6): the canvas sits between page and card;
    // relationships are orange in every palette and drawn wider than links,
    // so the kinds differ by more than colour.
    '--color-canvas': mix(t.bg, t.surface, 0.35),
    '--color-card-border': mix(t.border, t.text, 0.05),
    '--color-edge-link': t.accent,
    '--color-edge-tree': t.muted,
    '--color-edge-manual': mode === 'light' ? MANUAL_EDGE.light : MANUAL_EDGE.dark,
  };
}

/** Manual-relationship edges (prototype `#c2571a`, kept readable on every canvas). */
export const MANUAL_EDGE = { light: '#b4501a', dark: '#e8935a' } as const;

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
