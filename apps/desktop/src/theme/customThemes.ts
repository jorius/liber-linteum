import { contrast, hexToOklch, mix, oklchToHex } from './color';
import { derive } from './derive';
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
}

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
  };
}

/** Each mode's derived colours, seeded from that mode's own primary (and its
 *  secondary when set by hand). */
function derivedValues(t: CustomTheme): { light: PaletteTokens; dark: PaletteTokens } {
  const seed = (mode: Mode) =>
    derive(t[mode].accent, t.derived[mode].includes('secondary') ? undefined : t[mode].secondary)[
      mode
    ];
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

/** The colour a token sits on, for contrast; the secondary sits on its tag tint too. */
function backgrounds(tokens: PaletteTokens, key: TokenKey): string[] {
  const bgs = (CHECKS[key] ?? []).map((k) => tokens[k]);
  if (key === 'secondary') bgs.push(mix(tokens.surface, tokens.secondary, 0.12));
  return bgs;
}

export interface Badge {
  level: 'AAA' | 'AA' | 'Low';
  ratio: number;
  bgs: string[];
}

/** WCAG contrast on the colour(s) it sits on (§3.3); `null` for backgrounds. */
export function badge(t: CustomTheme, mode: Mode, key: TokenKey): Badge | null {
  const tokens = t[mode];
  const bgs = backgrounds(tokens, key);
  if (bgs.length === 0 || !tokens[key].startsWith('#')) return null;
  const ratio = Math.min(...bgs.map((b) => contrast(tokens[key], b)));
  return { level: ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : 'Low', ratio, bgs };
}

/** The same hue and chroma at the nearest lightness that reads at `min` on
 *  every background, moving away from them; the best found otherwise. */
export function fix(hex: string, bgs: string[], min = 4.5): string {
  const [L0, C, H] = hexToOklch(hex);
  const score = (x: string) => Math.min(...bgs.map((b) => contrast(x, b)));
  const lightBgs = bgs.every((b) => hexToOklch(b)[0] > 0.6);
  const step = lightBgs ? -0.005 : 0.005;
  let best = hex;
  for (let L = L0; L >= 0 && L <= 1; L += step) {
    const x = oklchToHex(L, C, H);
    if (score(x) >= min) return x;
    if (score(x) > score(best)) best = x;
  }
  return best;
}

export function uniqueName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) if (!taken.includes(`${name} ${n}`)) return `${name} ${n}`;
}

const FORMAT = 'liber-theme';
const MAX_IMPORT = 64 * 1024;
const HEX = /^#[0-9a-f]{6}$/i;
const RGBA = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+|1\.0+)\s*\)$/i;

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
  if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 80)
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
      const valid = typeof c === 'string' && (HEX.test(c) || (k === 'sideSel' && RGBA.test(c)));
      if (!valid) return { ok: false, reason: 'value' };
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
