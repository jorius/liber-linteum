// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '../ipc';
import { contrast } from './color';
import { DARK_ACCENT_FLOOR, derive, LIGHT_ACCENT_FLOOR } from './derive';
import { paletteCss, paletteVars } from './paletteCss';
import { PALETTES } from './palettes';

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
/** The shared coloured-text palette (`--palette-*`, not their `-bg`) per mode. */
function coloredText(block: string): string[] {
  return [...block.matchAll(/--palette-[a-z]+:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
}
const sharedText = {
  light: coloredText(tokensCss.slice(0, tokensCss.indexOf('@media'))),
  dark: coloredText(tokensCss.slice(tokensCss.indexOf(":root[data-theme='dark']"))),
};

describe('built-in palettes (M2b §4, §10)', () => {
  it('are the eight ids the settings know, in order', () => {
    expect(PALETTES.map((p) => p.id)).toEqual([...PALETTE_IDS]);
  });

  it.each(PALETTES.flatMap((p) => (['light', 'dark'] as const).map((m) => [p.id, m] as const)))(
    '%s %s: text, accent and coloured text stay readable',
    (id, mode) => {
      const t = PALETTES.find((p) => p.id === id)![mode];
      expect(contrast(t.text, t.bg), 'text on background').toBeGreaterThanOrEqual(7);
      expect(contrast(t.body, t.surface), 'body on surface').toBeGreaterThanOrEqual(7);
      expect(contrast(t.muted, t.surface), 'muted on surface').toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.accent, t.surface), 'accent on surface').toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.contrast, t.accent), 'text on accent').toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.accent, t.soft), 'accent on accent-soft').toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.sideText, t.side), 'sidebar text').toBeGreaterThanOrEqual(7);
      for (const c of sharedText[mode]) {
        expect(contrast(c, t.surface), `${c} on surface`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});

/** M5b §6: the save status reads "Saved" in green and "Unsaved" in red, on
 *  the header (surface) and on its veiled pill over a cover. */
describe('save status colours (M5b §6)', () => {
  it.each(PALETTES.flatMap((p) => (['light', 'dark'] as const).map((m) => [p.id, m] as const)))(
    '%s %s: success and danger text are readable on the surface',
    (id, mode) => {
      const vars = paletteVars(
        PALETTES.find((p) => p.id === id)!,
        mode,
      );
      expect(vars['--color-success'], 'success').toMatch(/^#[0-9a-f]{6}$/);
      for (const key of ['--color-success', '--color-danger']) {
        expect(contrast(vars[key], vars['--color-surface']), `${key}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('the default tokens define --color-success in both modes', () => {
    expect(tokensCss.split('--color-success:').length - 1).toBe(3);
  });
});

/** Global View colours (M3a §4, §6): plain hex, and every edge kind stands
 *  out from the canvas (WCAG 1.4.11 non-text contrast, 3:1). */
const GV_TOKENS = [
  '--color-canvas',
  '--color-card-border',
  '--color-edge-link',
  '--color-edge-tree',
  '--color-edge-manual',
] as const;

function expectReadableGlobalView(vars: Record<string, string>, at: string) {
  for (const key of GV_TOKENS) expect(vars[key], `${at} ${key}`).toMatch(/^#[0-9a-f]{6}$/);
  for (const edge of ['--color-edge-link', '--color-edge-tree', '--color-edge-manual']) {
    expect(
      contrast(vars[edge], vars['--color-canvas']),
      `${at} ${edge} on canvas`,
    ).toBeGreaterThanOrEqual(3);
  }
  expect(
    contrast(vars['--color-accent'], vars['--color-surface']),
    `${at} card title`,
  ).toBeGreaterThanOrEqual(4.5);
  // M4b part 3 §4: a folder card's kind label, accent on its tinted head.
  expect(
    contrast(vars['--color-accent'], vars['--color-accent-soft']),
    `${at} folder kind label`,
  ).toBeGreaterThanOrEqual(4.5);
}

describe('Global View tokens (M3a §4, §6)', () => {
  it.each(PALETTES.flatMap((p) => (['light', 'dark'] as const).map((m) => [p.id, m] as const)))(
    '%s %s: canvas, card border and edges',
    (id, mode) => {
      expectReadableGlobalView(
        paletteVars(
          PALETTES.find((p) => p.id === id)!,
          mode,
        ),
        `${id} ${mode}`,
      );
    },
  );

  it('the default tokens (before settings load) define them too, in both modes', () => {
    for (const key of GV_TOKENS) {
      expect(tokensCss.split(`${key}:`).length - 1, key).toBe(3);
    }
  });
});

/** Shades that used to be color-mix() (M3b §7, Safari 15): the sidebar's
 *  hover, pressed and divider shades as plain hex, the backdrops as rgba. */
const SIDEBAR_SHADES = [
  '--color-sidebar-hover',
  '--color-sidebar-active',
  '--color-sidebar-divider',
] as const;
const BACKDROPS = ['--color-backdrop', '--color-overlay'] as const;

describe('Safari 15 shades (M3b §7)', () => {
  it.each(PALETTES.flatMap((p) => (['light', 'dark'] as const).map((m) => [p.id, m] as const)))(
    '%s %s: sidebar shades and backdrops',
    (id, mode) => {
      const p = PALETTES.find((x) => x.id === id)!;
      const vars = paletteVars(p, mode);
      for (const key of SIDEBAR_SHADES) {
        expect(vars[key], key).toMatch(/^#[0-9a-f]{6}$/);
        expect(vars[key], `${key} differs from the sidebar`).not.toBe(p[mode].side);
        expect(
          contrast(p[mode].sideText, vars[key]),
          `sidebar text on ${key}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const key of BACKDROPS)
        expect(vars[key], key).toMatch(/^rgba\(\d+, \d+, \d+, 0\.\d+\)$/);
      expect(vars['--color-backdrop']).toMatch(/, 0\.6\)$/);
      expect(vars['--color-overlay']).toMatch(/, 0\.7\)$/);
    },
  );

  it('the default tokens define them too, in both modes', () => {
    for (const key of [...SIDEBAR_SHADES, ...BACKDROPS]) {
      expect(tokensCss.split(`${key}:`).length - 1, key).toBe(3);
    }
  });
});

describe('palette CSS', () => {
  it('maps every token and derives the in-between shades as plain hex (Safari 15)', () => {
    const vars = paletteVars(PALETTES[1], 'light');
    expect(vars['--color-accent']).toBe('#2448c4');
    expect(vars['--color-highlight-bg']).toBe('#fdf0a8');
    expect(vars['--color-code-bg']).toBe('#eceef2');
    expect(vars['--color-sidebar-selected']).toBe('rgba(138,164,255,.2)');
    expect(vars['--color-focus']).toBe('#2448c4');
    // The sidebar is dark in both modes, so its drop ring uses the dark accent.
    expect(vars['--color-drop-ring']).toBe('#8ea7ff');
    for (const key of [
      '--color-bg-dots',
      '--color-surface-subtle',
      '--color-border-strong',
      '--color-text-faint',
      '--color-accent-hover',
    ]) {
      expect(vars[key], key).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('writes a light block and both dark blocks per palette', () => {
    const css = paletteCss(PALETTES[1]);
    expect(css).toContain(":root[data-palette='graphite'] {");
    expect(css).toContain(
      "@media (prefers-color-scheme: dark) {\n  :root[data-palette='graphite']:not([data-theme='light']) {",
    );
    expect(css).toContain(":root[data-palette='graphite'][data-theme='dark'] {");
  });

  it('palettes.css is generated from palettes.ts (run `pnpm gen:palettes`)', () => {
    const file = readFileSync(new URL('./palettes.css', import.meta.url), 'utf8');
    expect(file).toBe(
      `/* Generated by scripts/gen-palettes.ts from src/theme/palettes.ts — do not edit. */\n\n${PALETTES.map(paletteCss).join('\n')}`,
    );
  });
});

describe('custom accent → palette (M2b §4, derive.ts)', () => {
  const hexes = [
    '#ffffff',
    '#000000',
    '#ffff00',
    '#0000ff',
    '#ff0000',
    '#00ff00',
    '#d1477a',
    '#2aa198',
    '#808080',
    '#f5d000',
    '#6d28d9',
    '#ff6a00',
  ];
  // A sweep over the hue circle at three lightness levels as well.
  for (let h = 0; h < 360; h += 30) {
    for (const l of [25, 50, 80]) {
      const c = (n: number) => {
        const k = (n + h / 30) % 12;
        const a = (Math.min(l, 100 - l) / 100) * 0.9;
        const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(v * 255)
          .toString(16)
          .padStart(2, '0');
      };
      hexes.push(`#${c(0)}${c(8)}${c(4)}`);
    }
  }

  it.each(hexes)('%s: the accent is readable in light and dark mode', (hex) => {
    const p = derive(hex);
    const floors = { light: LIGHT_ACCENT_FLOOR, dark: DARK_ACCENT_FLOOR };
    for (const mode of ['light', 'dark'] as const) {
      const t = p[mode];
      const at = `${mode}:`;
      expect(contrast(t.accent, t.surface), `${at} accent on surface`).toBeGreaterThanOrEqual(
        floors[mode],
      );
      // Tags, pressed toolbar buttons and the "Aa" toggle put accent text on
      // the accent-soft tint.
      expect(contrast(t.accent, t.soft), `${at} accent on accent-soft`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.contrast, t.accent), `${at} text on accent`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.text, t.bg), `${at} text on background`).toBeGreaterThanOrEqual(7);
      expectReadableGlobalView(paletteVars({ id: 'custom', ...p }, mode), `${hex} ${mode}`);
    }
    for (const v of Object.values(p.light).concat(Object.values(p.dark))) {
      expect(v).toMatch(/^(#[0-9a-f]{6}|rgba\(.*\))$/);
    }
  });

  it('greys stay grey; colours tint the neutrals toward their hue', () => {
    const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r, g, b] = channels(derive('#808080').light.bg);
    expect(r === g && g === b, 'grey background').toBe(true);
    const [pr, pg] = channels(derive('#d1477a').light.bg);
    expect(pr, 'pink tints the background toward red').toBeGreaterThan(pg);
  });
});

/** Buttons and the header band (M4b §1, §3). */
const BUTTON_TOKENS = [
  '--color-surface-veil',
  '--color-danger',
  '--color-danger-contrast',
] as const;

describe('buttons and the header veil (M4b §1, §3)', () => {
  const palettes = [
    ...PALETTES,
    ...['#d1477a', '#2aa198', '#f5d000', '#808080', '#ffffff', '#000000'].map((hex) => ({
      id: 'custom' as const,
      ...derive(hex),
    })),
  ];
  it.each(
    palettes.flatMap((p, i) => (['light', 'dark'] as const).map((m) => [i, p.id, m] as const)),
  )(
    '#%s %s %s: primary and danger buttons are readable; the veil is translucent surface',
    (i, _id, mode) => {
      const vars = paletteVars(palettes[i], mode);
      expect(
        contrast(vars['--color-accent-contrast'], vars['--color-accent']),
        'primary: text on accent',
      ).toBeGreaterThanOrEqual(4.5);
      expect(vars['--color-danger'], 'danger').toMatch(/^#[0-9a-f]{6}$/);
      expect(
        contrast(vars['--color-danger-contrast'], vars['--color-danger']),
        'danger: text on danger',
      ).toBeGreaterThanOrEqual(4.5);
      expect(vars['--color-surface-veil']).toMatch(/^rgba\(\d+, \d+, \d+, 0\.88\)$/);
    },
  );

  it('the default tokens define them too, in both modes', () => {
    for (const key of BUTTON_TOKENS) {
      expect(tokensCss.split(`${key}:`).length - 1, key).toBe(3);
    }
  });
});

/** `rgba(r, g, b, a)` over an opaque `#rrggbb`, as `#rrggbb`. */
function over(rgba: string, under: string): string {
  const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number);
  const u = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
  return `#${[r, g, b]
    .map((c, i) =>
      Math.round(c * a + u[i] * (1 - a))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const pageCss = readFileSync(
  new URL('../features/page/PageView.module.css', import.meta.url),
  'utf8',
);

describe('review focus: text on the veil over any cover (M4b §1)', () => {
  const palettes = [
    ...PALETTES,
    ...['#d1477a', '#2aa198', '#f5d000', '#808080', '#ffffff', '#000000'].map((hex) => ({
      id: 'custom' as const,
      ...derive(hex),
    })),
  ];
  it.each(
    palettes.flatMap((p, i) => (['light', 'dark'] as const).map((m) => [i, p.id, m] as const)),
  )('#%s %s %s: pill text meets AA on the veil over black and over white', (i, _id, mode) => {
    const vars = paletteVars(palettes[i], mode);
    for (const image of ['#000000', '#ffffff']) {
      const pill = over(vars['--color-surface-veil'], image);
      for (const text of ['--color-text', '--color-text-body'] as const) {
        expect(contrast(vars[text], pill), `${text} over ${image}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('muted text in a pill is drawn in the body colour (muted alone falls to ~4.0:1)', () => {
    const rule = /\.bandCover \.pill \{([^}]*)\}/.exec(pageCss)?.[1] ?? '';
    expect(rule).toContain('--color-text-muted: var(--color-text-body);');
  });
});

/** Syntax colours (M4b part 2 §2): one set per palette and mode, every
 *  token ≥ 4.5:1 on that palette's code background. */
const CODE_TOKENS = [
  '--code-keyword',
  '--code-string',
  '--code-number',
  '--code-comment',
  '--code-function',
  '--code-type',
  '--code-meta',
  '--code-variable',
  '--code-punct',
] as const;

describe('code tokens (M4b part 2 §2)', () => {
  const check = (vars: Record<string, string>, at: string) => {
    for (const key of CODE_TOKENS) {
      expect(vars[key], `${at} ${key}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(
        contrast(vars[key], vars['--color-code-bg']),
        `${at} ${key} on code-bg`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    // Keywords, strings and functions are told apart by more than lightness.
    expect(
      new Set([vars['--code-keyword'], vars['--code-string'], vars['--code-function']]).size,
    ).toBe(3);
  };
  it.each(PALETTES.flatMap((p) => (['light', 'dark'] as const).map((m) => [p.id, m] as const)))(
    '%s %s',
    (id, mode) =>
      check(
        paletteVars(
          PALETTES.find((p) => p.id === id)!,
          mode,
        ),
        `${id} ${mode}`,
      ),
  );
  it.each(['#d1477a', '#ffffff', '#000000', '#ffff00', '#2aa198', '#808080'])(
    'custom accent %s',
    (hex) => {
      const p = { id: 'custom', ...derive(hex) } as unknown as (typeof PALETTES)[number];
      check(paletteVars(p, 'light'), `${hex} light`);
      check(paletteVars(p, 'dark'), `${hex} dark`);
    },
  );
  it('the default tokens define them too, in both modes', () => {
    for (const key of CODE_TOKENS) expect(tokensCss.split(`${key}:`).length - 1, key).toBe(3);
  });
});
