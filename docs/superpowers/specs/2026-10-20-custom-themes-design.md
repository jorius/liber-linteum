# Custom themes: design

Status: **draft for the maintainer's approval** (2026-10-20). Mock: option A, "Gallery + full editor", which the maintainer picked. The mock lives in the brainstorm companion (`.superpowers/brainstorm/54734-1792525893/content/appearance.html`, first card) and is not committed.

## 0. Intent

Requirement: "Custom accent" is hard to find, and it only lets the user choose the accent. The user should be able to choose whatever they like: primary and secondary colours, the whole palette.

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
  - *My call (the maintainer didn't specify):* secondary colours `#tags`, the manual relationship lines in Global View (today a hard-coded orange, `--color-edge-manual`) and the filled favourite ★.
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

## 6. Open for the maintainer

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

### 7.1 Review fixes (2026-10-20)

A fresh-context review found 4 Important and 11 Minor issues. All are fixed test-first, in commits c3dc6e9 and 2bf7204.

- **Fix (I1, I2).** `fixColor(theme, mode, key)` searches lightness in both directions from the current value, keeping the hue and chroma. Each try recomputes the colours that depend on the token, such as the tag tint under the secondary. It returns the nearest value that reaches the floor. If no lightness reaches it, it returns the best-reading value, and the badge honestly stays Low. A property test sweeps 5 seeds × 2 modes × 4 tokens × 8 hues × 5 lightnesses, and checks against a brute-force search.
- **One colour rule (I3, M11).**
  - UI: `isThemeColor` in `customThemes.ts`.
  - Rust: `ThemeTokens` uses `HexColor` for 15 tokens and `ThemeColor` for `sideSel`, with plain-digit channels.
  - The rule:
    - `#rrggbb` for every token;
    - `rgba(r,g,b,a)` (r, g, b 0–255, a 0–1) only for the sidebar selection.

  A save Rust refuses shows a toast. The draft returns to the saved theme and pending saves are dropped. The vitest and e2e mocks refuse what Rust refuses.
- **Errors are said (I4).** Import ("too big", "couldn't be read"), export, delete and add failures each show a translated toast.
- **Limits (M5, M7).**
  - Names are cut to 80 characters before a number is added.
  - The 101st theme is refused with "You can keep up to 100 themes…". Rust now refuses a patch with more than 100 themes instead of cutting it.
- **Migration (M6, §2).**
  - A migrated theme keeps `seed` (its original accent), so "Fill the rest" on an untouched migrated theme changes nothing.
  - The legacy `accentColor` is dropped in the same save as the migration (`accentColor: ""` clears it). Rust's `accent_color` is now optional and absent by default.
  - If that save fails, the user is told, the accent stays, and the next launch tries again.
- **Stale selection (M8).** `palette: custom` with a missing theme shows the Lavender card as selected, and "Duplicate to edit" names the copy "Lavender copy".
- **Mode (M9).** The editor opens on the app's current light/dark mode.
- **Focus (M10).**
  - After Fix, focus is on the row's hex field.
  - Delete moves focus to the confirm, and Cancel moves it back.
  - After deleting, focus goes to the selected card.
  - Each badge describes its hex field.
- **Unknown tokens (M12).** `deny_unknown_fields` is gone: a newer build's 17th token is ignored, not a reason to drop the theme. Import files still need exactly the 16 keys.
- **Sidebar marks (M13).**
  - The star and the drop ring use the dark-mode secondary and accent when those read at 3:1 on this mode's sidebar. Otherwise they use whichever variant reads better. Built-in palettes are unchanged.
  - The Sidebar row gets a badge for them, with a 3:1 non-text floor.
  - The floors test covers built-in and derived palettes.
- **Import size (M14).** `theme_import` caps the bytes it actually reads at 64 KB + 1, so a FIFO whose metadata says 0 is still capped. A non-UTF-8 file returns `binary`.
- **Tests (M15).**
  - "Fill the rest" now asserts that a derived colour changed.
  - Fix is tested across hues, tokens and backgrounds.
  - The e2e test edits the dark primary and checks that each mode keeps its own.
  - The store test covers a failed migration save.
