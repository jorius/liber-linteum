// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../markdown/sanitize';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** `--name: #hex` pairs of one rule block (light: first `:root {`, dark: `[data-theme='dark']`). */
function tokens(block: string): Map<string, string> {
  return new Map([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

const light = tokens(css.slice(0, css.indexOf('@media')));
const dark = tokens(css.slice(css.indexOf(":root[data-theme='dark']")));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('palette tokens (M2a §4: readable in light and dark)', () => {
  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s: every color is ≥ 4.5:1 on its tint and on the page surface', (_, t) => {
    for (const color of PALETTE) {
      const fg = t.get(`--palette-${color}`)!;
      const bg = t.get(`--palette-${color}-bg`)!;
      expect(fg, color).toBeDefined();
      expect(contrast(fg, bg), `${color} on its tint`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fg, t.get('--color-surface')!), `${color} on surface`).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(t.get('--color-text')!, bg), `text on ${color}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
