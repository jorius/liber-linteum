# Custom Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings → Appearance becomes a gallery of built-in palettes and the user's own named themes. Each theme has a full 16-colour editor for light and dark mode, with a contrast badge per colour, a live preview, and export/import. A new `secondary` colour paints tags, manual relationship lines and the filled favourite star.

**Architecture:**
- A theme is the existing `Palette` shape (`{ light, dark }` of `PaletteTokens`) plus a name, an id and a "derived" set.
- The pure logic lives in `theme/customThemes.ts`: derive and fill, the contrast checks, Fix, migration, and the import validator.
- Rust stores themes in `settings.json`, validated by type, and owns only the native save/open dialogs for export and import.
- `applyAppearance` renders the selected custom theme with the existing `paletteCss`.

**Tech Stack:** React 19, TypeScript, the existing OKLCH helpers (`theme/color.ts`, `theme/derive.ts`), Rust (serde), tauri-plugin-dialog.

**Spec:** `docs/superpowers/specs/2026-10-20-custom-themes-design.md`. Approved by Jose, §6 included.

## Global Constraints

- **Tokens:** the 16 tokens are the existing 15 plus `secondary`.
  - **Gallery order:** Brand, then Surfaces, then Text, then Accents.
  - **Spec mapping:** `accent`=Primary, `secondary`=Secondary, `bg`, `surface`, `border`, `side`, `sideText`, `sideSel`, `strong`, `body`, `text`, `muted`, `contrast`, `soft`, `mark`, `code`.
- **Contrast floors** (spec §3.3). Badges: AAA ≥ 7, AA ≥ 4.5, below 4.5 is "Low". Fix targets 4.5. Low contrast warns and never blocks.
- **Built-in secondary floors, per mode.** Each must hold (tested):
  - `secondary` on `surface` ≥ 4.5;
  - `secondary` on `--color-secondary-soft` ≥ 4.5;
  - `--color-edge-manual` (= `secondary`) on `--color-canvas` ≥ 3;
  - `--color-sidebar-secondary` on `side` ≥ 3.
- **Export file:** `{ "format": "liber-theme", "version": 1, "name", "light": {16}, "dark": {16} }`, named `<name>.liber-theme.json`.
  - **Import accepts only:**
    - exactly those 16 keys per mode;
    - `#rrggbb` values, with `rgba(r,g,b,a)` allowed for `sideSel` only;
    - files of 64 KB or less.
  - **Import naming:** a clashing name gets " 2", " 3", and so on.
- **Settings:** `palette` stays the Rust enum, with `custom` meaning "the theme in `customTheme`".
  - New fields: `customThemes: CustomTheme[]` and `customTheme: string | null`.
  - **Migration:** the old `palette: custom` plus `accentColor` becomes a theme named "Custom" (es: "Personalizado"), with every colour derived.
- **No `color-mix()`** and no regex lookbehind (Safari 15 floor). Fields use `.field-control`. Every string goes into both en and es.
- **Signed commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **The gate:** `LIBER_E2E_PORT=4398 LOGS=$SP/logs/themes CARGO_TARGET_DIR=$SP/target-themes $SP/check.sh all $SP/wt-themes` prints ALL-OK.

## Review Focus

1. **A settings file from today** (`palette: "custom"`, `accentColor: "#2aa198"`) opens with the same colours, now shown as a theme named "Custom" and selected. → Task 4, `migrates_custom_accent_once`.
2. **Deleting the selected custom theme** falls back to Lavender. There's never a blank palette. → Task 4, `deleting_the_selected_theme_falls_back`.
3. **A corrupt `customThemes` entry in settings.json** drops that one theme and keeps the others. → Task 3, `one_bad_theme_is_dropped_not_all`.
4. **Fix never changes the hue,** and stops at the nearest lightness that reaches 4.5. For a pair that can't reach 4.5 at any lightness, it returns the best one found. → Task 2, `fix_reaches_target_keeps_hue`.
5. **An import file with a 17th key, a `#fff` short hex, or `rgba` outside `sideSel`** is refused with a reason, and nothing changes. → Task 2, `import_validator_rejects`.

---

### Task 1: The `secondary` token and where it paints

**Files:**
- Modify:
  - `src/theme/palettes.ts` (`PaletteTokens.secondary`, a value per built-in palette and mode)
  - `src/theme/derive.ts` (derive a readable `secondary`)
  - `src/theme/paletteCss.ts` (new vars; `--color-edge-manual` = `secondary`; drop `MANUAL_EDGE`)
  - `src/theme/tokens.css` (Lavender defaults for the new vars, in all three blocks)
  - `src/theme/palettes.css` (regenerate with `pnpm gen:palettes`)
  - `src/features/editor/livePreview.ts:587` (`.cm-liber-tag`)
  - `src/features/preview/Preview.module.css` `.tag`
  - `src/features/page/PageView.module.css` `.tag`
  - `src/features/favorites/FavoritesSection.tsx` (`StarIcon`)
  - `src/features/explorer/TreeRow.tsx`
  - `src/features/favorites/FavoriteToggle.tsx`
- Test: `src/theme/palettes.test.ts`

**Interfaces:**
- **New CSS vars** (`paletteVars`):
  - `--color-secondary`: `t.secondary`
  - `--color-secondary-soft`: `mix(t.surface, t.secondary, 0.12)`
  - `--color-sidebar-secondary`: `p.dark.secondary`
  - `--color-edge-manual`: `t.secondary`
- **`StarIcon({ filled, size, side })`:** when filled, its colour is `var(--color-sidebar-secondary)` if `side`, otherwise `var(--color-secondary)`.
- **`derive(hex, secondaryHex?)`:** without `secondaryHex`, the secondary is the accent's hue + 150°, at chroma `min(c0, 0.14)`. Its lightness is walked like the accent's until it meets the floors.

- [ ] **Step 1:** In `palettes.test.ts`, write failing tests:
  - `%s %s: secondary meets its floors`: for every built-in palette and mode, the four Global Constraints floors hold.
  - In the derive sweep, assert the same floors for `derive(hex)`.
- [ ] **Step 2:** `pnpm --filter @liber/desktop exec vitest run src/theme` → FAIL.
- [ ] **Step 3:** Add `secondary` to the built-in palettes.
  - **Hues:** lavender 55, graphite 200, rosewood 165, saffron 255, persimmon 230, midnight 65, sepia 190.
  - **Ink:** chroma 0, so `secondary` is the same as `accent`.
  - **Lightness:** found by a throwaway script with `color.ts` (the first L meeting the floors). Paste the hex values into `palettes.ts`.
  - Implement the `derive` change and the new vars. Update `tokens.css` (Lavender values, light and dark). Run `pnpm gen:palettes`.
- [ ] **Step 4:** Restyle and re-run.
  - Tags (the three places) use `var(--color-secondary)` on `var(--color-secondary-soft)`.
  - Stars use the `side` prop from `TreeRow` and `FavoritesSection`.
  - Run the tests: they pass. The existing Global View, palette-CSS and "generated from palettes.ts" tests stay green.
- [ ] **Step 5:** Commit: `feat(theme): a secondary colour per palette — tags, manual relationships, the favourite star`.

### Task 2: `customThemes.ts`, the pure model

**Files:** Create `src/theme/customThemes.ts` and `src/theme/customThemes.test.ts`.

**Interfaces (Produces):**
- **Keys and types:**
  - `TOKEN_KEYS: readonly (keyof PaletteTokens)[]`, the 16 keys in gallery order.
  - `type TokenKey = keyof PaletteTokens`.
  - `interface CustomTheme { id: string; name: string; light: PaletteTokens; dark: PaletteTokens; derived: { light: TokenKey[]; dark: TokenKey[] } }`.
- **Creating and editing:**
  - `newTheme(from: Palette, name: string, id?: string): CustomTheme`. Nothing is marked derived when copying a built-in.
  - `setColor(t, mode, key, hex): CustomTheme`. Clears `key` from `derived[mode]`.
  - `resetColor(t, mode, key): CustomTheme`. Sets the derived value and re-adds `key`.
  - `fillDerived(t): CustomTheme`. Recomputes every key in `derived` from `derive(t.light.accent, t.light.secondary)` per mode.
- **Contrast:**
  - `CHECKS: Record<TokenKey, TokenKey[]>`, the backgrounds per key, as spec §3.3.
  - `badge(t, mode, key): { level: 'AAA'|'AA'|'Low'; ratio: number } | null`. Returns null for background tokens.
  - `fix(hex, bgs: string[], min = 4.5): string`. Same hue and chroma; moves lightness away from the backgrounds in 0.005 steps; returns the first value meeting `min` on all `bgs`, or the best found.
- **Names and migration:**
  - `uniqueName(name, taken: string[]): string`.
  - `migrateLegacy(accent: string, name: string): CustomTheme`. Every colour is derived.
- **Export and import:**
  - `toExport(t): string`, the JSON from Global Constraints.
  - `parseImport(text: string): { ok: true; theme: Omit<CustomTheme,'id'> } | { ok: false; reason: 'size'|'json'|'format'|'version'|'keys'|'value' }`.

- [ ] **Step 1:** Write failing tests:
  - `fill_only_touches_derived`
  - `set_then_reset_roundtrip`
  - `badges_match_floors`
  - `fix_reaches_target_keeps_hue` (Review Focus 4: use `hexToOklch` to check that hue and chroma are unchanged within 1° and 0.005)
  - `unique_name_appends_number`
  - `migrate_matches_old_derive` (the light and dark colours equal `derive(accent)`'s)
  - `export_import_roundtrip`
  - `import_validator_rejects`: cases 17 keys, `#fff`, `rgba` on `accent`, `format: "x"`, `version: 2`, and 65 KB of text, each giving its reason
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat(theme): custom theme model — derive/fill, contrast badges and fix, migration, export/import validation`.

### Task 3: Rust settings and the export/import commands

**Files:**
- Modify:
  - `src-tauri/src/settings.rs`
  - `src-tauri/src/lib.rs`
  - `src-tauri/build.rs`
  - `src-tauri/capabilities/main.json`, or the autogenerated permission file, following the `spell_import` pattern
- Create: `src-tauri/src/theme_commands.rs`
- Test:
  - unit tests in `settings.rs`
  - `src-tauri/tests/commands.rs` (the registered-command list test)

**Interfaces:**
- **Colour and theme types:**
  - `pub struct ThemeColor(String)` accepts `#rrggbb`, or `rgba(` + 3 integers 0–255 + an alpha 0–1 + `)`. Stored lower-case.
  - `pub struct ThemeTokens { …16 fields… }`, with camelCase serde names.
  - `pub struct CustomTheme { id: String /*1–64*/, name: String /*1–80*/, light: ThemeTokens, dark: ThemeTokens, derived: ThemeDerived }`.
  - `ThemeDerived { light: Vec<String>, dark: Vec<String> }`. Unknown key names are dropped.
- **Settings:**
  - `Settings.custom_themes: Vec<CustomTheme>` (at most 100) and `Settings.custom_theme: Option<String>`.
  - `parse_lenient` filters `customThemes` entry by entry, the same way as `recentVaults`.
  - `SettingsPatch` gains both fields.
- **Commands:**
  - `#[tauri::command] theme_export(app, name: String, json: String) -> CmdResult<bool>`. It opens the save dialog with the default name `<name>.liber-theme.json` and writes the file. It returns `false` if the user cancels.
  - `#[tauri::command] theme_import(app) -> CmdResult<Option<String>>`. It opens the open dialog with the filter `json` and returns the text. A file over 64 KB is refused with `invalidInput`.
  - Tests replace both dialogs through `AppState::cover_picker`, the same hook `spell_import` uses.
  - Every `std::fs` line in `theme_commands.rs` carries the comment `// seam: outside (app-chosen export/import path, not vault content)`.

- [ ] **Step 1:** Write failing tests:
  - `custom_themes_round_trip`
  - `one_bad_theme_is_dropped_not_all` (Review Focus 3)
  - `theme_color_accepts_hex_and_rgba_only`
  - `patch_sets_custom_theme`
  - `theme_import_refuses_over_64k`
  - `theme_export_writes_the_json` (through the picker hook into a temp dir)
- [ ] **Step 2:** `cargo test -p liber-desktop settings theme` → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(settings): custom themes in settings.json, plus theme export/import through the native dialogs`.

### Task 4: Applying a custom theme, and the migration

**Files:**
- Modify:
  - `src/ipc/index.ts` (the `Settings`/`SettingsPatch` fields `customThemes` and `customTheme`; `themeExport` and `themeImport`)
  - `src/theme/appearance.ts`
  - `src/stores/settingsStore.ts`
- Test:
  - `src/theme/appearance.test.ts`
  - `src/stores/stores.test.ts`

**Interfaces:**
- `applyAppearance(s)` takes `palette`, `customThemes` and `customTheme`.
  - When `palette === 'custom'`, it writes `paletteCss({ id: 'custom', light, dark })` for the selected theme.
  - When that theme is missing, it falls back to Lavender, so `data-palette` becomes `lavender` and the style is removed.
- `settingsStore.load()` runs the migration once. If `palette === 'custom'`, `customThemes` is empty and `customTheme` is null:
  1. it builds `migrateLegacy(accentColor, t('settings.customThemeLegacyName'))`;
  2. it applies the result, then patches `{ customThemes: [it], customTheme: it.id }`.

- [ ] **Step 1:** Write failing tests:
  - `migrates_custom_accent_once` (Review Focus 1): load with the legacy settings. It patches once, and a second load doesn't patch again.
  - `applies_selected_custom_theme`: the style text contains the theme's light `--color-accent`.
  - `deleting_the_selected_theme_falls_back` (Review Focus 2): `applyAppearance` with a missing id sets `lavender`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(theme): apply the selected custom theme, migrate a custom accent into one`.

### Task 5: The Appearance gallery and editor (option A)

**Files:**
- Create:
  - `src/features/dialogs/ThemeSettings.tsx` (the gallery, the editor and the preview)
  - `src/features/dialogs/ThemeSettings.module.css`
  - `src/features/dialogs/ThemeSettings.test.tsx`
- Modify:
  - `src/features/dialogs/SettingsDialog.tsx`: replace the palette fieldset, `Swatch` and `AccentEditor` with `<ThemeSettings />`, and drop `PALETTE_CHOICES`, `HEX` (if unused) and `derive`.
  - `src/i18n/locales/en.json` and `es.json`: new `settings.themes.*` keys; remove the `accent*` keys that are no longer used.

**Interfaces:**
- `ThemeSettings()` reads and writes through `useSettingsStore().update` and `useLatestSave`, the same as `AccentEditor` did.
- **Gallery:**
  - "Built-in" and "My themes" are each a `radiogroup` of cards.
  - "＋ New theme" calls `newTheme(current palette, uniqueName(t('settings.themes.newName'), names))`, selects it and opens the editor.
- **Editor**, shown when the selection is a custom theme:
  - a name field (`.field-control`; it saves on blur or Enter; a blank name reverts);
  - a Light/Dark segmented toggle (it edits that mode only and doesn't change `settings.theme`);
  - groups as in the spec, with Accents behind "N more colours";
  - each row: an `input type=color` swatch, a hex `.field-control`, the badge, Fix when the badge is Low, and ↺ when the colour has been set by hand;
  - "Fill the rest from Primary", Duplicate, Export…, Import…, and Delete (with a confirm in the existing `ConfirmDialog` style).
- For a built-in theme, the area shows "Duplicate to edit" instead of the editor.
- **Preview:** a static mini app coloured from the edited mode's tokens through inline style variables.
- **Saving:**
  - Edits save debounced at 150 ms through the latest-save pattern.
  - An import that fails shows the reason as a toast, using the existing toast helper.
  - Export and import call `themeExport(name, toExport(t))` and `themeImport()` → `parseImport` → append and select.

- [ ] **Step 1:** Write failing tests in `ThemeSettings.test.tsx`:
  - the gallery lists 8 built-ins plus the user's themes;
  - New creates "My theme", then "My theme 2", and selects it;
  - editing Primary patches `customThemes` and drops its derived mark;
  - "Fill the rest" leaves hand-set colours alone;
  - the Low badge offers Fix, and after Fix the badge reads AA;
  - Duplicate on a built-in creates an editable copy;
  - Delete confirms, removes the theme and selects Lavender;
  - import of a bad file shows the reason and changes nothing;
  - every control has an accessible name.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS. Also run `pnpm check:i18n`.
- [ ] **Step 5:** Commit: `feat(settings): Appearance gallery and full theme editor (round 3 option A)`.

### Task 6: e2e, mock and gate

**Files:**
- Modify: `e2e/ipcMock.ts` (settings fields, `theme_export` and `theme_import`), `playwright.config.ts` (add `themes` to WebKit `testMatch`)
- Create: `e2e/themes.spec.ts`

- [ ] **Step 1:** Write `e2e/themes.spec.ts`, which covers:
  1. create a theme, edit Primary, and see `--color-accent` on `:root` change;
  2. toggle Light/Dark editing;
  3. a Low badge, then Fix, then AA;
  4. duplicate a built-in;
  5. delete with confirm;
  6. an export → import round trip through the mock;
  7. axe passes on the Appearance panel in light and dark.
- [ ] **Step 2:** Run it before the mock exists → FAIL. Then add the mock → PASS in Chromium and WebKit.
- [ ] **Step 3:** Run the full gate until it prints ALL-OK.
- [ ] **Step 4:** Commit: `test(e2e): custom themes in Chromium and WebKit`.
- [ ] **Step 5:** Add the spec's "§7 As built" amendment with the ledger's rulings, and commit: `docs: custom themes §7 — as built`.

---

**Self-review:**
- **Spec coverage:**
  - §2 model and migration: Tasks 2–4.
  - §3 gallery, editor, badges, Fix, Fill and preview: Tasks 2 and 5.
  - §4 export/import: Tasks 2, 3 and 5.
  - §5 tests: Tasks 1–6.
  - §6 secondary uses: Task 1.
- **Type consistency:** `CustomTheme`, `TokenKey`, `TOKEN_KEYS` and `parseImport` are defined in Task 2 and used in Tasks 4 and 5. The Rust `CustomTheme` mirrors the TS shape, with camelCase serde names.
- **Proportion:** the plan is shorter than the code it describes; no function bodies, except the Fix algorithm in one line.
