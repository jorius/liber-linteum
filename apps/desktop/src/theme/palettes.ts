import type { PaletteId } from '../ipc';

/** The 15 colours a palette defines per mode (M2b §4, §10). */
export interface PaletteTokens {
  /** Page background. */
  bg: string;
  /** Cards, header, editor. */
  surface: string;
  border: string;
  /** Default text. */
  text: string;
  /** Headings and the title. */
  strong: string;
  /** Running text. */
  body: string;
  /** Secondary text. */
  muted: string;
  /** Links, buttons, focus. */
  accent: string;
  /** Tags, manual relationship lines, the filled favourite star (custom
   *  themes §2). */
  secondary: string;
  /** Accent tint (selection, callouts). */
  soft: string;
  /** Text on the accent. */
  contrast: string;
  /** Sidebar background (always dark). */
  side: string;
  sideText: string;
  /** Selected row in the sidebar. */
  sideSel: string;
  /** `==highlight==` background. */
  mark: string;
  /** Inline code background. */
  code: string;
}

export interface Palette {
  id: PaletteId | 'custom';
  light: PaletteTokens;
  dark: PaletteTokens;
}

/** Built-in palettes, values from docs/design/2026-10-13-m2b-palettes.html
 *  (spec §10). Lavender is the default. */
export const PALETTES: readonly Palette[] = [
  {
    id: 'lavender',
    light: {
      bg: '#f4eff8',
      surface: '#ffffff',
      border: '#e6ddef',
      text: '#1d1a22',
      strong: '#2c1f4a',
      body: '#4a4058',
      muted: '#6b5f80',
      accent: '#4b2f86',
      secondary: '#a2540d',
      soft: '#e9e1f4',
      contrast: '#ffffff',
      side: '#1f1d24',
      sideText: '#d9d4e2',
      sideSel: 'rgba(185,162,230,.22)',
      mark: '#fbf1c7',
      code: '#efe9f6',
    },
    dark: {
      bg: '#17151c',
      surface: '#1f1d26',
      border: '#322d3d',
      text: '#ece8f2',
      strong: '#f3eefb',
      body: '#cfc8db',
      muted: '#a59cb5',
      accent: '#b9a2e6',
      secondary: '#e0843e',
      soft: '#2f2742',
      contrast: '#1b1426',
      side: '#121016',
      sideText: '#d9d4e2',
      sideSel: 'rgba(185,162,230,.22)',
      mark: '#4a3f12',
      code: '#2a2533',
    },
  },
  {
    id: 'graphite',
    light: {
      bg: '#f2f3f5',
      surface: '#ffffff',
      border: '#dfe1e6',
      text: '#17181c',
      strong: '#111827',
      body: '#3d4250',
      muted: '#606676',
      accent: '#2448c4',
      secondary: '#187478',
      soft: '#e2e8fb',
      contrast: '#ffffff',
      side: '#17181c',
      sideText: '#d5d8df',
      sideSel: 'rgba(138,164,255,.2)',
      mark: '#fdf0a8',
      code: '#eceef2',
    },
    dark: {
      bg: '#111216',
      surface: '#18191e',
      border: '#2a2c33',
      text: '#e7e9ee',
      strong: '#f4f5f8',
      body: '#c6cad3',
      muted: '#949aa8',
      accent: '#8ea7ff',
      secondary: '#2bb3b9',
      soft: '#1f2846',
      contrast: '#0d1124',
      side: '#0b0c0f',
      sideText: '#d2d5dc',
      sideSel: 'rgba(138,164,255,.18)',
      mark: '#4b4417',
      code: '#20222a',
    },
  },
  {
    id: 'rosewood',
    light: {
      bg: '#f7f0f1',
      surface: '#ffffff',
      border: '#ecdcdf',
      text: '#221a1c',
      strong: '#3d1424',
      body: '#52404a',
      muted: '#76616a',
      accent: '#8c2a4c',
      secondary: '#1c7758',
      soft: '#f4e1e7',
      contrast: '#ffffff',
      side: '#221a1d',
      sideText: '#e6d6db',
      sideSel: 'rgba(240,163,187,.2)',
      mark: '#fbeaa9',
      code: '#f2e7ea',
    },
    dark: {
      bg: '#191315',
      surface: '#211a1d',
      border: '#3a2b31',
      text: '#f1e8eb',
      strong: '#fbf2f5',
      body: '#d8c8ce',
      muted: '#ab97a0',
      accent: '#f2a5bd',
      secondary: '#46b68c',
      soft: '#43222f',
      contrast: '#2a0f19',
      side: '#120d0f',
      sideText: '#e1d2d7',
      sideSel: 'rgba(240,163,187,.18)',
      mark: '#4d4219',
      code: '#2c2227',
    },
  },
  {
    id: 'saffron',
    light: {
      bg: '#f6f4ee',
      surface: '#fffefb',
      border: '#e7e2d4',
      text: '#1f1b12',
      strong: '#2f2410',
      body: '#4b4334',
      muted: '#6e6552',
      accent: '#8a5800',
      secondary: '#2769b7',
      soft: '#f6e9cc',
      contrast: '#ffffff',
      side: '#1f1c16',
      sideText: '#e2dccd',
      sideSel: 'rgba(242,192,99,.2)',
      mark: '#dfeaf7',
      code: '#f0ece1',
    },
    dark: {
      bg: '#16140f',
      surface: '#1e1b14',
      border: '#332e22',
      text: '#efe9dc',
      strong: '#f8f3e8',
      body: '#d6ceba',
      muted: '#a99f88',
      accent: '#f2c063',
      secondary: '#5fa1f3',
      soft: '#3a2f17',
      contrast: '#231a05',
      side: '#100e0a',
      sideText: '#e0d8c6',
      sideSel: 'rgba(242,192,99,.18)',
      mark: '#1f3550',
      code: '#29251b',
    },
  },
  {
    id: 'persimmon',
    light: {
      bg: '#f4f3f4',
      surface: '#ffffff',
      border: '#e4e1e4',
      text: '#1d191a',
      strong: '#2e1810',
      body: '#463f40',
      muted: '#6a6163',
      accent: '#b03f17',
      secondary: '#187193',
      soft: '#fbe4da',
      contrast: '#ffffff',
      side: '#1d1a1b',
      sideText: '#e1dadb',
      sideSel: 'rgba(255,154,118,.2)',
      mark: '#fcefa6',
      code: '#efecee',
    },
    dark: {
      bg: '#151213',
      surface: '#1d191a',
      border: '#33292a',
      text: '#f0e9e7',
      strong: '#faf3f1',
      body: '#d5cac8',
      muted: '#a8999a',
      accent: '#ff9a76',
      secondary: '#28acdf',
      soft: '#43241a',
      contrast: '#2a0e04',
      side: '#0f0c0d',
      sideText: '#e0d6d4',
      sideSel: 'rgba(255,154,118,.18)',
      mark: '#4b4317',
      code: '#282223',
    },
  },
  {
    id: 'midnight',
    light: {
      bg: '#eef0f8',
      surface: '#ffffff',
      border: '#dadff0',
      text: '#151a2e',
      strong: '#1b1f4a',
      body: '#3a4060',
      muted: '#5d6384',
      accent: '#3b3fbf',
      secondary: '#965a0c',
      soft: '#e1e3fa',
      contrast: '#ffffff',
      side: '#141733',
      sideText: '#d2d6f0',
      sideSel: 'rgba(150,156,255,.22)',
      mark: '#f8eda6',
      code: '#e8eaf5',
    },
    dark: {
      bg: '#0d0f22',
      surface: '#141731',
      border: '#252a4d',
      text: '#e4e6f7',
      strong: '#f1f2fc',
      body: '#c3c7e6',
      muted: '#8d92b8',
      accent: '#a3a8ff',
      secondary: '#d98a2e',
      soft: '#262b5e',
      contrast: '#0b0d26',
      side: '#080918',
      sideText: '#cdd1ee',
      sideSel: 'rgba(163,168,255,.2)',
      mark: '#4a4318',
      code: '#1c2042',
    },
  },
  {
    id: 'sepia',
    light: {
      bg: '#f3ead8',
      surface: '#fbf5e9',
      border: '#e3d6bb',
      text: '#2b2116',
      strong: '#3b2a17',
      body: '#4f3f2c',
      muted: '#75634c',
      accent: '#8b4513',
      secondary: '#116f6a',
      soft: '#f0dcc2',
      contrast: '#ffffff',
      side: '#2b241b',
      sideText: '#e7dcc8',
      sideSel: 'rgba(214,160,110,.22)',
      mark: '#f5dd8a',
      code: '#efe3cc',
    },
    dark: {
      bg: '#1c1814',
      surface: '#241f19',
      border: '#3a3127',
      text: '#ece2d0',
      strong: '#f5ecdc',
      body: '#d3c6b0',
      muted: '#a8987f',
      accent: '#e3a774',
      secondary: '#30b4ad',
      soft: '#44301f',
      contrast: '#24140a',
      side: '#14110d',
      sideText: '#ddd1bc',
      sideSel: 'rgba(227,167,116,.2)',
      mark: '#4d4119',
      code: '#2c261f',
    },
  },
  {
    id: 'ink',
    light: {
      bg: '#ffffff',
      surface: '#ffffff',
      border: '#d4d4d4',
      text: '#000000',
      strong: '#000000',
      body: '#1a1a1a',
      muted: '#4d4d4d',
      accent: '#000000',
      secondary: '#000000',
      soft: '#ececec',
      contrast: '#ffffff',
      side: '#000000',
      sideText: '#f2f2f2',
      sideSel: 'rgba(255,255,255,.18)',
      mark: '#ffe94d',
      code: '#f0f0f0',
    },
    dark: {
      bg: '#000000',
      surface: '#0a0a0a',
      border: '#3a3a3a',
      text: '#ffffff',
      strong: '#ffffff',
      body: '#e6e6e6',
      muted: '#b3b3b3',
      accent: '#ffffff',
      secondary: '#ffffff',
      soft: '#262626',
      contrast: '#000000',
      side: '#000000',
      sideText: '#f2f2f2',
      sideSel: 'rgba(255,255,255,.16)',
      mark: '#6b5d00',
      code: '#1a1a1a',
    },
  },
];
