// Editor fonts (M2b §5). Bundled faces load offline from @fontsource
// (fonts.css); an installed family is used by name (`system:<Family>`).

export interface FontOption {
  id: string;
  /** Shown in the picker; `null` = translated "System default". */
  label: string | null;
  stack: string;
}

/** Live Preview and the rendered pane. Default: Atkinson Hyperlegible. */
export const LIVE_FONTS: readonly FontOption[] = [
  {
    id: 'atkinson-hyperlegible',
    label: 'Atkinson Hyperlegible',
    stack: "'Atkinson Hyperlegible', system-ui, sans-serif",
  },
  { id: 'literata', label: 'Literata', stack: "'Literata', Georgia, serif" },
  { id: 'source-serif-4', label: 'Source Serif 4', stack: "'Source Serif 4', Georgia, serif" },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', stack: "'IBM Plex Sans', system-ui, sans-serif" },
  {
    id: 'plus-jakarta-sans',
    label: 'Plus Jakarta Sans',
    stack: "'Plus Jakarta Sans', system-ui, sans-serif",
  },
  {
    id: 'system-ui',
    label: null,
    stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
];

/** Source mode and the Split's source side. Default: JetBrains Mono. */
export const SOURCE_FONTS: readonly FontOption[] = [
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    stack: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
  },
  {
    id: 'ibm-plex-mono',
    label: 'IBM Plex Mono',
    stack: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
  },
  {
    id: 'source-code-pro',
    label: 'Source Code Pro',
    stack: "'Source Code Pro', ui-monospace, Menlo, Consolas, monospace",
  },
  { id: 'system-mono', label: null, stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
];

export type FontKind = 'live' | 'source';

const SYSTEM = 'system:';
const lists = { live: LIVE_FONTS, source: SOURCE_FONTS };

/** The settings value for an installed family. */
export const systemChoice = (family: string) => `${SYSTEM}${family}`;

/** The installed family a choice names, or `null` for a bundled font. */
export const systemFamily = (choice: string): string | null =>
  choice.startsWith(SYSTEM) && choice.slice(SYSTEM.length).trim()
    ? choice.slice(SYSTEM.length)
    : null;

/** CSS `font-family` for a choice; unknown choices get the default. */
export function fontStack(choice: string, kind: FontKind): string {
  const fallback = lists[kind][0].stack;
  const family = systemFamily(choice);
  if (family !== null) return `"${family.replace(/[\\"]/g, '\\$&')}", ${fallback}`;
  return [...LIVE_FONTS, ...SOURCE_FONTS].find((f) => f.id === choice)?.stack ?? fallback;
}
