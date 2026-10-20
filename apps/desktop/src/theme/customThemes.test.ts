// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { contrast, hexToOklch } from './color';
import {
  badge,
  fillDerived,
  fix,
  migrateLegacy,
  newTheme,
  parseImport,
  resetColor,
  setColor,
  TOKEN_KEYS,
  toExport,
  uniqueName,
} from './customThemes';
import { derive } from './derive';
import { PALETTES } from './palettes';

const lavender = PALETTES[0];

describe('custom theme model (custom themes §2–§4)', () => {
  it('has the 16 tokens in gallery order', () => {
    expect(TOKEN_KEYS).toEqual([
      'accent',
      'secondary',
      'bg',
      'surface',
      'border',
      'side',
      'sideText',
      'sideSel',
      'strong',
      'body',
      'text',
      'muted',
      'contrast',
      'soft',
      'mark',
      'code',
    ]);
  });

  it('fill_only_touches_derived', () => {
    let t = migrateLegacy('#2aa198', 'Custom');
    t = setColor(t, 'light', 'bg', '#123456');
    t = setColor(t, 'light', 'accent', '#d1477a');
    const filled = fillDerived(t);
    expect(filled.light.bg).toBe('#123456');
    expect(filled.light.accent).toBe('#d1477a');
    expect(filled.derived.light).not.toContain('bg');
    // A derived colour follows the new primary.
    expect(filled.light.soft).toBe(derive('#d1477a').light.soft);
    // Each mode follows its own primary: a hand-set dark primary drives dark.
    const dark = fillDerived(setColor(t, 'dark', 'accent', '#e8935a'));
    expect(dark.dark.soft).toBe(derive('#e8935a').dark.soft);
  });

  it('set_then_reset_roundtrip', () => {
    const t = migrateLegacy('#2aa198', 'Custom');
    const set = setColor(t, 'dark', 'muted', '#777777');
    expect(set.dark.muted).toBe('#777777');
    expect(set.derived.dark).not.toContain('muted');
    const back = resetColor(set, 'dark', 'muted');
    expect(back.dark.muted).toBe(t.dark.muted);
    expect(back.derived.dark).toContain('muted');
  });

  it('badges_match_floors', () => {
    const t = newTheme(lavender, 'L');
    expect(badge(t, 'light', 'bg')).toBeNull();
    expect(badge(t, 'light', 'strong')?.level).toBe('AAA');
    const low = setColor(t, 'light', 'muted', '#cccccc');
    const b = badge(low, 'light', 'muted')!;
    expect(b.level).toBe('Low');
    expect(b.ratio).toBeCloseTo(contrast('#cccccc', t.light.surface), 1);
    const aa = setColor(t, 'light', 'muted', '#707070');
    expect(badge(aa, 'light', 'muted')?.level).toBe('AA');
  });

  it('fix_reaches_target_keeps_hue', () => {
    for (const [hex, bg] of [
      ['#e0a33a', '#ffffff'],
      ['#4b2f86', '#17151c'],
      ['#2aa198', '#f6f3f0'],
    ] as const) {
      const fixed = fix(hex, [bg]);
      expect(contrast(fixed, bg), `${hex} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      const [, c0, h0] = hexToOklch(hex);
      const [, c1, h1] = hexToOklch(fixed);
      expect(Math.abs(((h1 - h0 + 540) % 360) - 180), 'hue').toBeLessThan(3);
      expect(Math.abs(c1 - c0), 'chroma').toBeLessThan(0.03);
    }
    // Unreachable (mid grey on mid grey at 21:1): the best found, never a throw.
    expect(fix('#808080', ['#808080'], 30)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('unique_name_appends_number', () => {
    expect(uniqueName('My theme', [])).toBe('My theme');
    expect(uniqueName('My theme', ['My theme'])).toBe('My theme 2');
    expect(uniqueName('My theme', ['My theme', 'My theme 2'])).toBe('My theme 3');
  });

  it('migrate_matches_old_derive', () => {
    const t = migrateLegacy('#2aa198', 'Custom');
    const d = derive('#2aa198');
    expect(t.name).toBe('Custom');
    expect(t.light).toEqual(d.light);
    expect(t.dark).toEqual(d.dark);
    expect(t.derived.light).toEqual([...TOKEN_KEYS]);
  });

  it('export_import_roundtrip', () => {
    const t = setColor(newTheme(lavender, 'Selva'), 'light', 'accent', '#0e7c7b');
    const r = parseImport(toExport(t));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.theme.name).toBe('Selva');
    expect(r.theme.light).toEqual(t.light);
    expect(r.theme.dark).toEqual(t.dark);
    expect(r.theme.derived).toEqual({ light: [], dark: [] });
  });

  it('import_validator_rejects', () => {
    const good = JSON.parse(toExport(newTheme(lavender, 'X')));
    const cases: [unknown, string][] = [
      [{ ...good, light: { ...good.light, extra: '#000000' } }, 'keys'],
      [{ ...good, light: { ...good.light, accent: '#fff' } }, 'value'],
      [{ ...good, light: { ...good.light, accent: 'rgba(1,2,3,.5)' } }, 'value'],
      [{ ...good, format: 'x' }, 'format'],
      [{ ...good, version: 2 }, 'version'],
      [{ ...good, name: '' }, 'format'],
    ];
    for (const [value, reason] of cases)
      expect(parseImport(JSON.stringify(value)), reason).toEqual({ ok: false, reason });
    expect(parseImport('{ not json')).toEqual({ ok: false, reason: 'json' });
    expect(parseImport(' '.repeat(65 * 1024))).toEqual({ ok: false, reason: 'size' });
    // sideSel may be rgba.
    expect(parseImport(JSON.stringify(good)).ok).toBe(true);
    expect(good.light.sideSel).toMatch(/^rgba\(/);
  });
});
