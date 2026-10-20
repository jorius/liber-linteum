# Custom themes: design

Status: **draft for Jose's approval** (2026-10-20). Mock: option A, "Gallery + full editor", which Jose picked. The mock lives in the brainstorm companion (`.superpowers/brainstorm/54734-1792525893/content/appearance.html`, first card) and is not committed.

## 0. Intent

Jose: "'Custom accent' isn't that easy to identify and the user is only choosing the accent. I would like the user to choose whatever they like: primary, secondary colours, the whole palette."

Today, Settings → Appearance offers 8 built-in palettes plus "Custom accent". Custom accent takes one colour and derives the other 14 tokens per mode in OKLCH (`theme/derive.ts`). A palette is 15 colours per mode (`theme/palettes.ts`, `PaletteTokens`).

## 1. Goals, non-goals and anti-goals

**Goals**

- Users create any number of named themes. Each theme sets every colour for light and dark mode.
- Built-in palettes and the user's own themes sit side by side as cards. Picking a card applies it right away.
- The editor groups the colours, shows how readable each one is, previews the result live, and can fill in anything left unset from the primary colour.
- Themes can be duplicated, renamed, deleted, exported to a file and imported from one.

**Non-goals**

- Per-vault themes.
- Fonts. They keep their existing settings.
- Gradients, images and transparency controls.
- Theme sharing over the network. There is no network.

**Anti-goals**

- An editor that lets someone make the app unreadable without saying so. Low contrast gets a warning, never a block.
- Losing the user's current "Custom accent" colour when they upgrade.

## 2. The model

- **A new token, `secondary` (per mode), so a palette has 16 colours.**
  - *My call (Jose didn't specify):* secondary colours `#tags`, the manual relationship lines in Global View (today a hard-coded orange, `--color-edge-manual`) and the filled favourite ★.
  - Every built-in palette gets a hand-picked secondary that passes contrast in both modes.
- **The theme record:**
  `CustomTheme { id: string, name: string, light: PaletteTokens, dark: PaletteTokens, derived: { light: TokenKey[], dark: TokenKey[] } }`.
  `derived` lists the colours the user hasn't set by hand. "Fill the rest" recomputes only those.
- **Storage:** app settings `customThemes: CustomTheme[]`. `palette` is either a built-in id or `custom:<id>`.
- **Migration:** a settings file that has `palette: 'custom'` plus `accentColor` gets one theme named "Custom" (es: "Personalizado"), built from `derive(accentColor)` with everything marked derived. `palette` then points at it, and `accentColor` is kept until the next save, then dropped.

## 3. Settings → Appearance (option A)

1. **"Built-in" row:** a card for each palette. A card shows a mini sidebar, a page with the accent and secondary as bars, and the name. The current theme's card has the accent outline.
2. **"My themes" row:** the user's themes as cards, then "＋ New theme". A new theme starts as a copy of the current theme and is named "My theme", "My theme 2", and so on. It is selected and opens in the editor.
3. **The editor** appears under the gallery when one of *your* themes is selected. Built-in themes are read-only and show a "Duplicate to edit" button instead.
   - **Header:**
     - the name, editable in place;
     - Light / Dark toggle (it switches which mode you edit and preview; the app's own mode setting is unchanged);
     - Duplicate, Export…, Import…, Delete (Delete asks first).
   - **Groups**, as in the mock. Each row has a swatch (opens the colour picker), the name, a one-line use, a hex field and a readability badge.
     - **Brand:** Primary (`accent`), Secondary (`secondary`).
     - **Surfaces:** Background (`bg`), Pages and cards (`surface`), Borders (`border`), Sidebar (`side`), Sidebar text (`sideText`), Sidebar selection (`sideSel`).
     - **Text:** Headings (`strong`), Body text (`body`), Default text (`text`), Secondary text (`muted`), Text on primary (`contrast`).
     - **Accents:** Selection tint (`soft`), Highlight (`mark`), Code background (`code`).
     - The first two groups are open. The rest open behind "▸ N more colours", as in the mock.
   - **Readability badge:** the WCAG contrast ratio against the colour it sits on. Text tokens are checked against `surface`, `contrast` against `accent`, `sideText` against `side`, and `accent`/`secondary` against `surface` and `soft`.
     - It reads "AAA n.n" (≥ 7), "AA n.n" (≥ 4.5) or "Low n.n" (warning colour).
     - Each "Low" badge offers "Fix", which nudges lightness in OKLCH until the colour reaches 4.5.
   - **Buttons:**
     - "Fill the rest from Primary" re-derives every colour still marked derived.
     - Editing a colour by hand removes its derived mark. A row's ↺ restores its derived value.
   - **Live preview** beside the editor: a mini app showing a heading, body text, a link, a tag, a highlight, buttons and the sidebar.
   - **Saving:** the real app follows edits live (debounced 150 ms), and edits save the way other settings do.
4. **"Custom accent" goes away.** Its place is taken by "＋ New theme" and the migration above.

## 4. Export and import

- **Export** writes `<name>.liber-theme.json`: `{ "format": "liber-theme", "version": 1, "name", "light": {16 hex}, "dark": {16 hex} }`, through the native save dialog.
- **Import** reads that file through the native open dialog. Before accepting it, import checks:
  - `format` and `version`;
  - exactly the 16 known keys per mode;
  - every value is `#rrggbb`, or `rgba(…)` for `sideSel`;
  - the file is under 64 KB.

  If the name clashes, a number is appended. Imported colours are all marked as hand-set.

## 5. Testing

- **Unit:**
  - the migration from `custom` + `accentColor`;
  - the derived and hand-set bookkeeping;
  - "Fill the rest";
  - contrast pairs and the "Fix" nudge, which reaches ≥ 4.5 without changing hue;
  - the import validator, which rejects bad keys, values, size and format;
  - the name dedupe;
  - `secondary` in every built-in palette meets the floors in both modes.
- **e2e (Chromium + WebKit):**
  - create a theme, edit Primary, and see the app change;
  - toggle Light/Dark editing;
  - a Low badge, then Fix, then AA;
  - duplicate a built-in;
  - delete with confirm;
  - export, then import round-trip, through the IPC mock;
  - axe-clean in light and dark.
- The existing palette and contrast tests stay green.

## 6. Open for Jose

- **Secondary's uses:** tags, manual relationship lines and the favourite ★. This is my call; say if you'd rather it colour something else, e.g. callouts or the Global View cards.

## 7. As built (2026-10-20)

Built on `feat/themes` (plan `docs/superpowers/plans/2026-10-20-custom-themes.md`, 6 tasks). The gate passes: vitest 1681, e2e 391 passed and 12 skipped (Chromium and WebKit), cargo 732 passed and 5 ignored, plus lint, typecheck, i18n, fmt, clippy and deny.

Rulings made while building:

1. **Secondary per palette.** Manual relationship lines now follow each palette's secondary instead of one fixed orange (`MANUAL_EDGE` is gone).
   - Ink's secondary equals its accent (Ink is monochrome).
   - Built-in secondaries were hand-tuned with hues lavender 55, graphite 200, rosewood 165, saffron 255, persimmon 230, midnight 65 and sepia 190, then tested against these floors in both modes: surface ≥ 4.5, tag tint ≥ 4.5, canvas ≥ 3, star on the sidebar ≥ 3.
2. **The tag tint** is `mix(surface, secondary, 0.12)`. On the always-dark sidebar the star uses the dark-mode secondary (`--color-sidebar-secondary`).
3. **"Fill the rest" seeds each mode from that mode's own primary,** so a hand-set dark primary drives the dark colours.
4. **Settings shape.** `palette` stays the Rust enum (`custom`), plus `customTheme` (an id) and `customThemes`. A `customTheme: ""` patch clears the selection. One bad theme in settings.json is dropped and the rest are kept.
5. **Migration** runs only when `palette` is `custom` and there are no themes yet. A deleted selection falls back to Lavender and never brings the old accent back.
6. **Fold.** Accents (selection tint, highlight, code) fold behind "Show 3 more colours". Brand, Surfaces and Text stay open, following mock A, which shows Text open (§3 had said "the first two groups").
7. **Delete confirms inline** in the editor rather than in a dialog over Settings.
8. **"Import…"** sits next to "New theme" so it is always reachable.
9. **A valid hex saves as it is typed** (debounced), so closing Settings keeps it.
10. **Mermaid's diagram cache key** uses the selected theme's colours instead of `accentColor`.
11. **The export and import commands** carry a `// seam: outside` note on each file-system line, for the E2 storage seam guard.
