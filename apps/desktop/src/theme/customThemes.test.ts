// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { contrast, hexToOklch, oklchToHex } from './color';
import {
  badge,
  CHECKS,
  fillDerived,
  fixColor,
  isThemeColor,
  MAX_NAME,
  migrateLegacy,
  newTheme,
  parseImport,
  resetColor,
  setColor,
  TOKEN_KEYS,
  toExport,
  uniqueName,
  type CustomTheme,
  type Mode,
  type TokenKey,
} from './customThemes';
import { derive } from './derive';
import { sidebarMarks } from './paletteCss';
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
    for (const [key, hex] of [
      ['secondary', '#e0a33a'],
      ['muted', '#cccccc'],
      ['accent', '#9bb7ff'],
    ] as const) {
      const t = setColor(newTheme(lavender, 'L'), 'light', key, hex);
      const fixed = fixColor(t, 'light', key);
      expect(badge(setColor(t, 'light', key, fixed), 'light', key)!.ratio).toBeGreaterThanOrEqual(
        4.5,
      );
      const [, c0, h0] = hexToOklch(hex);
      const [, c1, h1] = hexToOklch(fixed);
      if (c0 > 0.02) expect(Math.abs(((h1 - h0 + 540) % 360) - 180), 'hue').toBeLessThan(3);
      expect(Math.abs(c1 - c0), 'chroma').toBeLessThan(0.03);
    }
  });

  // Review I1, I2: Fix reaches 4.5 against every background its badge checks,
  // the tag tint included (recomputed from the new colour), searching both
  // ways; when no lightness passes it returns the best and stays honest.
  it('fix_reaches_45_wherever_some_lightness_does', () => {
    const passes = (t: CustomTheme, mode: Mode, key: TokenKey, x: string) =>
      badge(setColor(t, mode, key, x), mode, key)!.ratio >= 4.5;
    const somePasses = (t: CustomTheme, mode: Mode, key: TokenKey) => {
      const [, C, H] = hexToOklch(t[mode][key]);
      for (let L = 0; L <= 1.0001; L += 0.0025)
        if (passes(t, mode, key, oklchToHex(L, C, H))) return true;
      return false;
    };
    let checked = 0;
    for (const seed of ['#2aa198', '#d1477a', '#3a7bd5', '#808080', '#e0a33a']) {
      const base = migrateLegacy(seed, 'S');
      for (const mode of ['light', 'dark'] as const)
        for (const key of ['secondary', 'contrast', 'muted', 'accent'] as const)
          for (let h = 0; h < 360; h += 45)
            for (const L of [0.3, 0.5, 0.62, 0.7, 0.78]) {
              const t = setColor(base, mode, key, oklchToHex(L, 0.1, h));
              if (badge(t, mode, key)!.level !== 'Low') continue;
              checked++;
              const fixed = fixColor(t, mode, key);
              if (somePasses(t, mode, key))
                expect(passes(t, mode, key, fixed), `${seed} ${mode} ${key} L${L} h${h}`).toBe(
                  true,
                );
              else expect(badge(setColor(t, mode, key, fixed), mode, key)!.level).toBe('Low');
            }
    }
    expect(checked).toBeGreaterThan(50);
    // White text on a mid-tone primary: darkening is the way out.
    const blue = setColor(newTheme(lavender, 'B'), 'light', 'accent', '#3a7bd5');
    const onBlue = setColor(blue, 'light', 'contrast', '#ffffff');
    expect(badge(onBlue, 'light', 'contrast')!.level).toBe('Low');
    expect(
      badge(
        setColor(onBlue, 'light', 'contrast', fixColor(onBlue, 'light', 'contrast')),
        'light',
        'contrast',
      )!.ratio,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('unique_name_appends_number', () => {
    expect(uniqueName('My theme', [])).toBe('My theme');
    expect(uniqueName('My theme', ['My theme'])).toBe('My theme 2');
    expect(uniqueName('My theme', ['My theme', 'My theme 2'])).toBe('My theme 3');
    // Review M5: never over the 80-character cap, the number kept.
    const long = 'a'.repeat(MAX_NAME);
    const next = uniqueName(long, [long]);
    expect([...next].length).toBeLessThanOrEqual(MAX_NAME);
    expect(next.endsWith(' 2')).toBe(true);
    expect([...uniqueName('é'.repeat(90), [])].length).toBe(MAX_NAME);
  });

  // Review M6: Fill on an untouched migrated theme changes nothing.
  it('fill_on_untouched_migrated_theme_is_stable', () => {
    for (const x of ['#fb5c99', '#2aa198', '#d1477a', '#e0a33a', '#3a7bd5']) {
      const t = migrateLegacy(x, 'Custom');
      expect(fillDerived(t), x).toEqual(t);
    }
  });

  // Review I3, M11: one colour rule, the same as Rust's.
  it('colour_validity_matches_rust', () => {
    expect(isThemeColor('accent', '#0e7c7b')).toBe(true);
    expect(isThemeColor('accent', '#0E7C7B')).toBe(true);
    expect(isThemeColor('accent', 'rgba(1,2,3,.5)')).toBe(false);
    expect(isThemeColor('surface', 'rgba(255,255,255,1)')).toBe(false);
    expect(isThemeColor('sideSel', 'rgba(255, 255, 255, .12)')).toBe(true);
    expect(isThemeColor('sideSel', 'rgba(255,255,255,1)')).toBe(true);
    expect(isThemeColor('sideSel', 'rgba(300,0,0,.5)')).toBe(false);
    expect(isThemeColor('sideSel', 'rgba(0,0,0,1.5)')).toBe(false);
    expect(isThemeColor('sideSel', 'rgba(0,0,0,.)')).toBe(false);
    expect(isThemeColor('sideSel', '#ffffff')).toBe(true);
  });

  // Review M13: the sidebar's star and drop ring are checked on the theme's
  // own sidebar, in both modes; built-in and derived palettes meet 3:1.
  it('sidebar_marks_read_on_the_sidebar', () => {
    const palettes = [
      ...PALETTES,
      ...['#2aa198', '#d1477a', '#3a7bd5', '#e0a33a'].map((x) => ({
        id: 'custom' as const,
        ...derive(x),
      })),
    ];
    for (const p of palettes)
      for (const mode of ['light', 'dark'] as const) {
        const { star, ring } = sidebarMarks(p, mode);
        expect(contrast(star, p[mode].side), `${p.id} ${mode} star`).toBeGreaterThanOrEqual(3);
        expect(contrast(ring, p[mode].side), `${p.id} ${mode} ring`).toBeGreaterThanOrEqual(3);
      }
    // A light sidebar gets marks that read on it, and the Sidebar row says so.
    const t = setColor(
      setColor(newTheme(lavender, 'L'), 'light', 'side', '#f4f1ea'),
      'light',
      'sideText',
      '#222222',
    );
    const { star, ring } = sidebarMarks({ id: 'custom', light: t.light, dark: t.dark }, 'light');
    expect(contrast(star, '#f4f1ea')).toBeGreaterThanOrEqual(3);
    expect(contrast(ring, '#f4f1ea')).toBeGreaterThanOrEqual(3);
    expect(badge(t, 'light', 'side')!.level).not.toBe('Low');
    expect(CHECKS.side).toBeUndefined();
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
    expect(
      parseImport(
        JSON.stringify({ ...good, light: { ...good.light, sideSel: 'rgba(300,0,0,.5)' } }),
      ),
    ).toEqual({ ok: false, reason: 'value' });
    // sideSel may be rgba.
    expect(parseImport(JSON.stringify(good)).ok).toBe(true);
    expect(good.light.sideSel).toMatch(/^rgba\(/);
  });
});
