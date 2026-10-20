import { contrast, hexToOklch, mix, oklchToHex } from './color';
import { derive } from './derive';
import { sidebarMarks } from './paletteCss';
import type { Palette, PaletteTokens } from './palettes';

/** Custom themes (custom themes spec): a named palette the user builds. */
export type TokenKey = keyof PaletteTokens;
export type Mode = 'light' | 'dark';

export interface CustomTheme {
  id: string;
  name: string;
  light: PaletteTokens;
  dark: PaletteTokens;
  /** Colours not set by hand; "Fill the rest" recomputes only these. */
  derived: { light: TokenKey[]; dark: TokenKey[] };
  /** The accent a migrated theme was derived from (review M6): a derived
   *  primary is re-derived from it, so Fill doesn't drift. */
  seed?: string;
}

/** Longest theme name, in characters (the same cap as Rust's). */
export const MAX_NAME = 80;
/** Most themes kept (the same cap as Rust's). */
export const MAX_THEMES = 100;

/** The 16 colours in gallery order: Brand, Surfaces, Text, Accents (§3). */
export const TOKEN_KEYS: readonly TokenKey[] = [
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
];

/** What each colour is read against (§3.3); background colours have none. */
export const CHECKS: Partial<Record<TokenKey, TokenKey[]>> = {
  accent: ['surface', 'soft'],
  secondary: ['surface'],
  strong: ['surface'],
  body: ['surface'],
  text: ['surface', 'bg'],
  muted: ['surface'],
  contrast: ['accent'],
  sideText: ['side'],
};

const randomId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function newTheme(from: Palette, name: string, id = randomId()): CustomTheme {
  return {
    id,
    name,
    light: { ...from.light },
    dark: { ...from.dark },
    derived: { light: [], dark: [] },
  };
}

/** A custom accent from before custom themes, as a theme with every colour derived. */
export function migrateLegacy(accent: string, name: string): CustomTheme {
  const d = derive(accent);
  return {
    id: randomId(),
    name,
    light: d.light,
    dark: d.dark,
    derived: { light: [...TOKEN_KEYS], dark: [...TOKEN_KEYS] },
    seed: accent.toLowerCase(),
  };
}

/** Each mode's derived colours, seeded from that mode's own primary (and its
 *  secondary when set by hand). */
function derivedValues(t: CustomTheme): { light: PaletteTokens; dark: PaletteTokens } {
  const seed = (mode: Mode) =>
    derive(
      t.seed && t.derived[mode].includes('accent') ? t.seed : t[mode].accent,
      t.derived[mode].includes('secondary') ? undefined : t[mode].secondary,
    )[mode];
  return { light: seed('light'), dark: seed('dark') };
}

export function setColor(t: CustomTheme, mode: Mode, key: TokenKey, value: string): CustomTheme {
  return {
    ...t,
    [mode]: { ...t[mode], [key]: value },
    derived: { ...t.derived, [mode]: t.derived[mode].filter((k) => k !== key) },
  };
}

export function resetColor(t: CustomTheme, mode: Mode, key: TokenKey): CustomTheme {
  const d = derivedValues(t)[mode];
  const keys = t.derived[mode].includes(key) ? t.derived[mode] : [...t.derived[mode], key];
  return { ...t, [mode]: { ...t[mode], [key]: d[key] }, derived: { ...t.derived, [mode]: keys } };
}

/** "Fill the rest from Primary": recompute every colour still marked derived. */
export function fillDerived(t: CustomTheme): CustomTheme {
  const d = derivedValues(t);
  const fill = (mode: Mode) => {
    const out = { ...t[mode] };
    for (const k of t.derived[mode]) out[k] = d[mode][k];
    return out;
  };
  return { ...t, light: fill('light'), dark: fill('dark') };
}

/** The colours a token is read against; the secondary sits on its tag tint
 *  too, and the Sidebar row is checked against its star and drop ring
 *  (review M13), both recomputed from `t` as it stands. */
function backgrounds(t: CustomTheme, mode: Mode, key: TokenKey): string[] {
  const tokens = t[mode];
  if (key === 'side') {
    const { star, ring } = sidebarMarks({ id: 'custom', light: t.light, dark: t.dark }, mode);
    return [star, ring];
  }
  const bgs = (CHECKS[key] ?? []).map((k) => tokens[k]);
  if (key === 'secondary') bgs.push(mix(tokens.surface, tokens.secondary, 0.12));
  return bgs;
}

/** The floor a colour must reach: text 4.5:1, the sidebar's marks 3:1 (non-text). */
const floor = (key: TokenKey) => (key === 'side' ? 3 : 4.5);

export interface Badge {
  level: 'AAA' | 'AA' | 'Low';
  ratio: number;
}

/** WCAG contrast on the colour(s) it sits on (§3.3); `null` for backgrounds. */
export function badge(t: CustomTheme, mode: Mode, key: TokenKey): Badge | null {
  const value = t[mode][key];
  const bgs = backgrounds(t, mode, key);
  if (bgs.length === 0 || !value.startsWith('#')) return null;
  const ratio = Math.min(...bgs.map((b) => contrast(value, b)));
  return { level: ratio >= 7 ? 'AAA' : ratio >= floor(key) ? 'AA' : 'Low', ratio };
}

/** The nearest lightness, same hue and chroma, at which `key` reaches its
 *  floor on everything its badge checks (dependent colours recomputed per
 *  try), looking both lighter and darker (review I1, I2); the best-reading
 *  one when no lightness passes. */
export function fixColor(t: CustomTheme, mode: Mode, key: TokenKey): string {
  const value = t[mode][key];
  const [L0, C, H] = hexToOklch(value);
  const score = (x: string) => badge(setColor(t, mode, key, x), mode, key)!.ratio;
  let best = value;
  let bestScore = score(value);
  for (let d = 0.0025; d <= 1; d += 0.0025)
    for (const L of [L0 - d, L0 + d]) {
      if (L < 0 || L > 1) continue;
      const x = oklchToHex(L, C, H);
      const r = score(x);
      if (r >= floor(key)) return x;
      if (r > bestScore) [best, bestScore] = [x, r];
    }
  return best;
}

/** At most `max` characters, never splitting one. */
const cut = (s: string, max: number) => [...s].slice(0, max).join('').trimEnd();

/** `name` cut to the cap, numbered when taken; the number always fits. */
export function uniqueName(name: string, taken: string[]): string {
  const base = cut(name, MAX_NAME);
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const next = cut(base, MAX_NAME - suffix.length) + suffix;
    if (!taken.includes(next)) return next;
  }
}

const HEX = /^#[0-9a-f]{6}$/i;
const RGBA = /^rgba\(([^)]*)\)$/i;

/** One rule with Rust (review I3, M11): `#rrggbb` everywhere, and
 *  `rgba(r,g,b,a)` (r, g, b 0–255, a 0–1) for the sidebar selection only. */
export function isThemeColor(key: TokenKey, value: string): boolean {
  if (HEX.test(value)) return true;
  const m = key === 'sideSel' ? RGBA.exec(value) : null;
  if (!m) return false;
  const parts = m[1].split(',').map((x) => x.trim());
  if (parts.length !== 4) return false;
  const [r, g, b, a] = parts;
  const channel = (c: string) => /^\d{1,3}$/.test(c) && Number(c) <= 255;
  const alpha = /^[\d.]+$/.test(a) && Number(a) >= 0 && Number(a) <= 1;
  return channel(r) && channel(g) && channel(b) && alpha;
}

const FORMAT = 'liber-theme';
const MAX_IMPORT = 64 * 1024;

/** The export file (§4). */
export function toExport(t: CustomTheme): string {
  return `${JSON.stringify({ format: FORMAT, version: 1, name: t.name, light: t.light, dark: t.dark }, null, 2)}\n`;
}

export type ImportResult =
  | { ok: true; theme: Omit<CustomTheme, 'id'> }
  | { ok: false; reason: 'size' | 'json' | 'format' | 'version' | 'keys' | 'value' };

/** Reads an export file (§4); imported colours are all hand-set. */
export function parseImport(text: string): ImportResult {
  if (text.length > MAX_IMPORT) return { ok: false, reason: 'size' };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'json' };
  }
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== 'object' || o.format !== FORMAT) return { ok: false, reason: 'format' };
  if (o.version !== 1) return { ok: false, reason: 'version' };
  if (typeof o.name !== 'string' || !o.name.trim() || [...o.name].length > MAX_NAME)
    return { ok: false, reason: 'format' };
  const modes: Partial<Record<Mode, PaletteTokens>> = {};
  for (const mode of ['light', 'dark'] as const) {
    const m = o[mode] as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') return { ok: false, reason: 'keys' };
    const keys = Object.keys(m);
    if (keys.length !== TOKEN_KEYS.length || !TOKEN_KEYS.every((k) => keys.includes(k)))
      return { ok: false, reason: 'keys' };
    for (const k of TOKEN_KEYS) {
      const c = m[k];
      if (typeof c !== 'string' || !isThemeColor(k, c)) return { ok: false, reason: 'value' };
    }
    modes[mode] = Object.fromEntries(
      TOKEN_KEYS.map((k) => [k, (m[k] as string).toLowerCase()]),
    ) as unknown as PaletteTokens;
  }
  return {
    ok: true,
    theme: {
      name: o.name.trim(),
      light: modes.light!,
      dark: modes.dark!,
      derived: { light: [], dark: [] },
    },
  };
}
