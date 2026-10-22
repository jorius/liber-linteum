# M2b — Editor UX iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the maintainer's M2a real-window feedback: rename a page from its title, a back arrow for followed internal links, eight palettes plus a custom accent, legible editor fonts with per-mode pickers, and an optional formatting toolbar.

**Architecture:** Settings (Rust-owned `settings.json`) gain six lenient fields; the UI applies them as a `data-palette` attribute, a generated custom-palette stylesheet and CSS variables on `<html>`. Palettes are data (`theme/palettes.ts`) compiled to `theme/palettes.css` by a script; the custom accent is derived in OKLCH at runtime. Formatting is a set of pure CodeMirror commands shared by the toolbar and the keymap. The link trail is a small store fed by `openPage(path, heading, via)`; the title is an in-place rename through the existing `vaultStore.rename`.

**Tech Stack:** Tauri 2 (Rust), `fontdb` 0.24, React 19, TypeScript 6, zustand 5, CodeMirror 6 (`@codemirror/lang-markdown` GFM tree), @fontsource 5.3, Vitest 5 + jsdom + Testing Library + axe-core, Playwright (Chromium + WebKit), pnpm 12 workspace, cargo.

**Spec:** `docs/superpowers/specs/2026-10-13-m2b-editor-ux-design.md` (section numbers below refer to it; §10 holds the palette values). Visual reference and the original derivation code: `docs/design/2026-10-13-m2b-palettes.html`. Previous hand-off: `docs/handoff/2026-10-12-m2a-editor-handoff.md`.

**How this plan was produced:** every task was executed in a clean clone of `main` at `1c9d0b1`, in order, with each RED observed and each GREEN passing the gate. Every code block below is the exact content of that replay: new files in full, changed files as unified diffs against the state the previous task left. Generated files (`pnpm-lock.yaml`, `Cargo.lock`, `palettes.css`) are produced by the commands in the steps. The plan's own deviations from the spec are listed at the end ("Spec amendments").

## Global Constraints

- Work from the repo root `notes-in-my-way/` on branch `feat/m2b-editor-ux` cut from `main` (`1c9d0b1`).
- Every dependency GPL-3.0-compatible; no network code (P1/NFR-04). `cargo deny check` must stay clean. New: `fontdb = "0.24.0"` (workspace), `@fontsource/atkinson-hyperlegible` 5.3.0, `@fontsource/literata` 5.3.0, `@fontsource/source-serif-4` 5.3.1, `@fontsource/ibm-plex-sans` 5.3.0, `@fontsource/ibm-plex-mono` 5.3.0, `@fontsource/source-code-pro` 5.3.1 (resolved through pnpm 12.11.2's release-age gate).
- The UI reaches the backend only through `apps/desktop/src/ipc/`; tests use `src/ipc/testing.ts`.
- Every new Tauri command is `async` through `vault_commands::blocking`, listed in `build.rs`, allowed in `capabilities/main.json`, in the `COMMANDS` list of `src-tauri/tests/commands.rs` (real-ACL allowed/denied test) and its source file in the async guard `nfr_ui_thread_never_runs_disk_or_index_commands`.
- Safari 15 floor (WKWebView, macOS 12): no regex lookbehind (lint rule), and no runtime `color-mix()` in new palette CSS.
- Every user-visible string goes through i18next (ICU syntax: `{name}`, not `{{name}}`) with `en` and `es` in parity (`pnpm check:i18n`).
- Palettes (spec §10, exact values in Task 2): `lavender` (default), `graphite`, `rosewood`, `saffron`, `persimmon`, `midnight`, `sepia`, `ink`, plus `custom`. Contrast floors per mode: text on bg ≥ 7, body on surface ≥ 7, muted ≥ 4.5, accent on surface ≥ 4.5, text on accent ≥ 4.5, sidebar text ≥ 7; derived custom accent ≥ 4.8 (light, on white) and ≥ 6 (dark, on the dark surface).
- Settings defaults: `palette: "lavender"`, `accentColor: "#d1477a"`, `fontLivePreview: "atkinson-hyperlegible"`, `fontSource: "jetbrains-mono"`, `fontSize: 15` (13–20), `toolbar: true`.
- Shortcuts: ⌘B, ⌘I, ⌘⇧X, ⌘⇧H, ⌘E, ⌘K, ⌘⌥0–6, ⌘⇧7/8/9, ⌘⇧.; ⌘[ / ⌘] are back/forward (never indentation); Tab / ⇧Tab indent only inside list items.
- Every GREEN step leaves clean (repo root): `pnpm lint`, `pnpm typecheck`, `pnpm check:i18n`, `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2`; for Rust changes also `pnpm build:ui && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && cargo deny check`. Never mask exit codes (`set -o pipefail`; no `&&` after `grep`). Run prettier **from the repo root** (the root `.prettierignore` excludes the generated `palettes.css`).
- Never set `LIBER_TRASH_TESTS=1` locally; never touch `~/Library/Application Support/app.liberlinteum.desktop`; agents never send keystrokes or clicks to the user's machine (Playwright only).
- Commits: conventional commits; every message ends with a `Co-Authored-By:` trailer naming the model that wrote the code.

## Review Focus

Five inputs the spec implies but does not spell out, most likely to bite first; each is pinned by a test in the owning task:

1. **⌘[ pressed while typing in the editor** — CodeMirror used to bind it to "indent less"; it must go back along the trail and leave the text alone. Pinned in Task 7: `Interactions.test.tsx` › "review focus: ⌘[ typed in the editor goes back instead of indenting" (plus `format.test.ts` › "⌘[ / ⌘] belong to back/forward, not to indentation").
2. **Renaming from the title with unsaved typing** — the rename must move the latest text, never an older version. Pinned in Task 8: `PageTitle.test.tsx` › "pending text is saved before the rename".
3. **A case-only rename on a case-insensitive disk** (`a.md` → `A.md`) — allowed, while a different page with the same name in another case is refused with an explanation. Pinned in Task 8: `PageTitle.test.tsx` › "names that cannot be files, or that are taken, are explained under the title".
4. **Extreme custom accents** (white, black, pure yellow, pure blue, greys) — the derived palette must stay readable in both modes. Pinned in Task 2: `palettes.test.ts` › "custom accent → palette" (48+ colours incl. a hue × lightness sweep).
5. **Installed font names with quotes or backslashes** — the family must be escaped in `font-family`, never break the declaration. Pinned in Task 3: `fonts.test.ts` › "an installed family is used by name, quoted and escaped, before the default stack".

---

## File Structure

| Path (under `apps/desktop/` unless noted) | Responsibility |
|---|---|
| `src-tauri/src/settings.rs` | `Palette`, `HexColor`, `FontChoice`, `FontSize`; new settings fields, lenient parse |
| `src-tauri/src/fonts.rs` | `fonts_list`: installed families (fontdb), cached |
| `src-tauri/src/menu.rs` | View → Back / Forward → `menu:navigate` |
| `src/theme/palettes.ts`, `color.ts`, `derive.ts`, `paletteCss.ts`, `palettes.css` (generated), `scripts/gen-palettes.ts` | Palette data, colour maths, custom accent, CSS generation |
| `src/theme/appearance.ts`, `fonts.ts`, `fonts.css`, `tokens.css` | Applying palette/fonts/size; bundled fonts |
| `src/features/dialogs/SettingsDialog.tsx` | Appearance / Editor / Files sections |
| `src/features/editor/format.ts`, `Toolbar.tsx`, `Editor.tsx` | Format commands, keymap, toolbar |
| `src/stores/trailStore.ts`, `navigate.ts`, `vaultStore.ts`, `features/shell/useGlobalShortcuts.ts` | Link trail |
| `src/features/page/PageTitle.tsx`, `PageHeader.tsx` | Editable title, back arrow, toolbar toggle |
| `e2e/m2b.spec.ts`, `e2e/zero-network.spec.ts`, `e2e/ipcMock.ts`, `playwright.config.ts` | Chromium + WebKit end-to-end |
| `docs/handoff/2026-10-13-m2b-editor-ux-handoff.md` (repo root) | Verbose hand-off |

---

### Task 1: Settings model — palette, accent colour, fonts, text size, toolbar

Spec §7. Six new settings, each with a default, persisted by Rust, reset on its own when a value is not understood (same leniency as M1b), and mirrored in the TS types.

**Files:**
- Modify: `apps/desktop/src-tauri/src/settings.rs`
- Test (modify): `apps/desktop/src-tauri/tests/commands.rs`
- Test (modify): `apps/desktop/src-tauri/tests/settings.rs`
- Modify: `apps/desktop/src/ipc/index.ts`
- Modify: `apps/desktop/src/stores/settingsStore.ts`
- Test (modify): `apps/desktop/src/stores/stores.test.ts`

**Interfaces:**
- Consumes: `SettingsStore`, `parse_lenient`, `SettingsPatch` (M1b); `DEFAULT_SETTINGS` (TS).
- Produces: Rust `liber_desktop::settings::{Palette, HexColor, FontChoice, FontSize, BUNDLED_FONTS, SYSTEM_FONT_PREFIX, MIN_FONT_SIZE, MAX_FONT_SIZE}`; `Settings`/`SettingsPatch` fields `palette, accent_color, font_live_preview, font_source, font_size, toolbar` (JSON `palette, accentColor, fontLivePreview, fontSource, fontSize, toolbar`). TS `PALETTE_IDS`, `PaletteId`, `PaletteChoice`, `FontChoice` and the same fields on `Settings`/`SettingsPatch` in `src/ipc/index.ts`; `DEFAULT_SETTINGS` extended.

- [ ] **Step 1: Write the failing tests**

Modify `apps/desktop/src-tauri/tests/commands.rs`:

```diff
--- a/apps/desktop/src-tauri/tests/commands.rs
+++ b/apps/desktop/src-tauri/tests/commands.rs
@@ -607,3 +607,39 @@ fn vlt_01_open_survives_an_unwritable_config_dir() {
     );
     call(&h.main, "vault_tree", json!({})).expect("the vault is open");
 }
+
+/// M2b §7: the new appearance/editor settings travel through `settings_set`
+/// and come back from `settings_get`; an invalid value is refused.
+#[test]
+fn m2b_settings_round_trip_over_ipc() {
+    let h = harness();
+    let saved = call(
+        &h.main,
+        "settings_set",
+        json!({ "patch": {
+            "palette": "graphite",
+            "accentColor": "#2AA198",
+            "fontLivePreview": "system:Avenir Next",
+            "fontSource": "source-code-pro",
+            "fontSize": 17,
+            "toolbar": false
+        }}),
+    )
+    .unwrap();
+    assert_eq!(saved["palette"], "graphite");
+    assert_eq!(saved["accentColor"], "#2aa198");
+    assert_eq!(saved["fontLivePreview"], "system:Avenir Next");
+    assert_eq!(saved["fontSource"], "source-code-pro");
+    assert_eq!(saved["fontSize"], 17);
+    assert_eq!(saved["toolbar"], false);
+    let got = call(&h.main, "settings_get", json!({})).unwrap();
+    assert_eq!(got["settings"]["palette"], "graphite");
+    assert!(
+        call(
+            &h.main,
+            "settings_set",
+            json!({ "patch": { "accentColor": "red" } })
+        )
+        .is_err()
+    );
+}
```

Modify `apps/desktop/src-tauri/tests/settings.rs`:

```diff
--- a/apps/desktop/src-tauri/tests/settings.rs
+++ b/apps/desktop/src-tauri/tests/settings.rs
@@ -37,7 +37,7 @@ fn patch_merges_saves_atomically_and_round_trips() {
             theme: Some(Theme::Dark),
             rewrite_links: Some(false),
             confirm_delete: None,
-            editor_mode: None,
+            ..Default::default()
         })
         .unwrap();
     assert_eq!(saved.language.as_deref(), Some("es"));
@@ -210,3 +210,97 @@ fn ed_01_editor_mode_defaults_to_live_preview_and_persists() {
     assert_eq!(s.theme, Theme::Dark);
     assert!(warning.unwrap().contains("editorMode"));
 }
+
+/// M2b §7: appearance and editor settings, each with a default, persisted,
+/// and reset on its own when a value can't be understood.
+#[test]
+fn m2b_appearance_and_editor_settings_default_and_persist() {
+    use liber_desktop::settings::{FontChoice, FontSize, HexColor, Palette};
+    let dir = tempfile::tempdir().unwrap();
+    let s = store(dir.path());
+    let d = s.get().0;
+    assert_eq!(d.palette, Palette::Lavender);
+    assert_eq!(d.accent_color, HexColor::parse("#d1477a").unwrap());
+    assert_eq!(d.font_live_preview.as_str(), "atkinson-hyperlegible");
+    assert_eq!(d.font_source.as_str(), "jetbrains-mono");
+    assert_eq!(d.font_size, FontSize::new(15));
+    assert!(d.toolbar);
+    s.update(SettingsPatch {
+        palette: Some(Palette::Custom),
+        accent_color: Some(HexColor::parse("#2AA198").unwrap()),
+        font_live_preview: Some(FontChoice::parse("system:Avenir Next").unwrap()),
+        font_source: Some(FontChoice::parse("ibm-plex-mono").unwrap()),
+        font_size: Some(FontSize::new(18)),
+        toolbar: Some(false),
+        ..Default::default()
+    })
+    .unwrap();
+    let saved: serde_json::Value =
+        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
+            .unwrap();
+    assert_eq!(saved["palette"], "custom");
+    assert_eq!(saved["accentColor"], "#2aa198", "stored lower-case");
+    assert_eq!(saved["fontLivePreview"], "system:Avenir Next");
+    assert_eq!(saved["fontSource"], "ibm-plex-mono");
+    assert_eq!(saved["fontSize"], 18);
+    assert_eq!(saved["toolbar"], false);
+    assert_eq!(store(dir.path()).get().0, s.get().0, "round-trips");
+}
+
+#[test]
+fn m2b_each_new_setting_is_reset_on_its_own() {
+    use liber_desktop::settings::{FontSize, Palette};
+    let dir = tempfile::tempdir().unwrap();
+    std::fs::write(
+        dir.path().join("settings.json"),
+        r#"{"palette":"neon","accentColor":"red","fontLivePreview":"comic-sans",
+            "fontSource":"system:","fontSize":"big","toolbar":"yes","theme":"dark"}"#,
+    )
+    .unwrap();
+    let (s, warning) = store(dir.path()).get();
+    assert_eq!(s.palette, Palette::Lavender);
+    assert_eq!(s.accent_color.as_str(), "#d1477a");
+    assert_eq!(s.font_live_preview.as_str(), "atkinson-hyperlegible");
+    assert_eq!(s.font_source.as_str(), "jetbrains-mono");
+    assert_eq!(s.font_size, FontSize::new(15));
+    assert!(s.toolbar);
+    assert_eq!(s.theme, Theme::Dark, "valid neighbours survive");
+    let warning = warning.unwrap();
+    for key in [
+        "palette",
+        "accentColor",
+        "fontLivePreview",
+        "fontSource",
+        "fontSize",
+        "toolbar",
+    ] {
+        assert!(warning.contains(key), "{key} in {warning}");
+    }
+}
+
+#[test]
+fn m2b_font_size_is_clamped_and_font_choices_are_bounded() {
+    use liber_desktop::settings::{FontChoice, FontSize, HexColor};
+    let dir = tempfile::tempdir().unwrap();
+    std::fs::write(dir.path().join("settings.json"), r#"{"fontSize":40}"#).unwrap();
+    assert_eq!(store(dir.path()).get().0.font_size, FontSize::new(20));
+    assert_eq!(FontSize::new(2).get(), 13);
+    assert!(FontChoice::parse("literata").is_some());
+    assert!(FontChoice::parse("system:Avenir Next").is_some());
+    assert!(FontChoice::parse("system:").is_none(), "empty family");
+    assert!(
+        FontChoice::parse("system:x\u{7}").is_none(),
+        "control characters"
+    );
+    assert!(
+        FontChoice::parse(&format!("system:{}", "a".repeat(200))).is_none(),
+        "at most 200 characters"
+    );
+    assert!(
+        FontChoice::parse("comic-sans").is_none(),
+        "unknown bundled id"
+    );
+    assert!(HexColor::parse("#ABCDEF").is_some());
+    assert!(HexColor::parse("#abc").is_none());
+    assert!(HexColor::parse("abcdef").is_none());
+}
```

Modify `apps/desktop/src/stores/stores.test.ts`:

```diff
--- a/apps/desktop/src/stores/stores.test.ts
+++ b/apps/desktop/src/stores/stores.test.ts
@@ -51,6 +51,17 @@ afterEach(async () => {
 });
 
 describe('settingsStore', () => {
+  it('M2b §7: the defaults match the Rust defaults (settings.rs)', () => {
+    expect(DEFAULT_SETTINGS).toMatchObject({
+      palette: 'lavender',
+      accentColor: '#d1477a',
+      fontLivePreview: 'atkinson-hyperlegible',
+      fontSource: 'jetbrains-mono',
+      fontSize: 15,
+      toolbar: true,
+    });
+  });
+
   it('review focus: a settings warning (reset values, unreadable file) is shown as a toast', async () => {
     backend({
       settings_get: () => ({
```

- [ ] **Step 2: Run them and watch them fail**

Run: `set -o pipefail; cargo test -p liber-desktop --test settings; pnpm --filter @liber/desktop exec vitest run src/stores/stores.test.ts`
Expected: Rust FAILS to compile — `unresolved imports liber_desktop::settings::FontChoice, …::FontSize, …::HexColor, …::Palette` and `struct SettingsPatch has no field named accent_color` (and the other new fields). Vitest: `× M2b §7: the defaults match the Rust defaults (settings.rs)`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src-tauri/src/settings.rs`:

```diff
--- a/apps/desktop/src-tauri/src/settings.rs
+++ b/apps/desktop/src-tauri/src/settings.rs
@@ -31,6 +31,154 @@ pub enum EditorMode {
     Split,
 }
 
+/// Colour palette (M2b §4); `Custom` derives one from `accent_color`.
+#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
+#[serde(rename_all = "lowercase")]
+pub enum Palette {
+    #[default]
+    Lavender,
+    Graphite,
+    Rosewood,
+    Saffron,
+    Persimmon,
+    Midnight,
+    Sepia,
+    Ink,
+    Custom,
+}
+
+/// A `#rrggbb` colour, stored lower-case.
+#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
+#[serde(try_from = "String", into = "String")]
+pub struct HexColor(String);
+
+impl HexColor {
+    pub fn parse(s: &str) -> Option<HexColor> {
+        let ok =
+            s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit());
+        ok.then(|| HexColor(s.to_ascii_lowercase()))
+    }
+
+    pub fn as_str(&self) -> &str {
+        &self.0
+    }
+}
+
+impl Default for HexColor {
+    fn default() -> HexColor {
+        HexColor("#d1477a".into())
+    }
+}
+
+impl TryFrom<String> for HexColor {
+    type Error = String;
+    fn try_from(s: String) -> Result<HexColor, String> {
+        HexColor::parse(&s).ok_or_else(|| format!("not a #rrggbb colour: {s}"))
+    }
+}
+
+impl From<HexColor> for String {
+    fn from(c: HexColor) -> String {
+        c.0
+    }
+}
+
+/// Fonts bundled with the app (M2b §5): Live Preview faces, then Source faces;
+/// `system-ui` / `system-mono` are the OS defaults.
+pub const BUNDLED_FONTS: &[&str] = &[
+    "atkinson-hyperlegible",
+    "literata",
+    "source-serif-4",
+    "ibm-plex-sans",
+    "plus-jakarta-sans",
+    "system-ui",
+    "jetbrains-mono",
+    "ibm-plex-mono",
+    "source-code-pro",
+    "system-mono",
+];
+
+/// Prefix of a font installed on the computer, e.g. `system:Avenir Next`.
+pub const SYSTEM_FONT_PREFIX: &str = "system:";
+const MAX_FONT_CHOICE: usize = 200;
+
+/// A bundled font id or `system:<Family Name>` (at most 200 characters, no
+/// control characters).
+#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
+#[serde(try_from = "String", into = "String")]
+pub struct FontChoice(String);
+
+impl FontChoice {
+    pub fn parse(s: &str) -> Option<FontChoice> {
+        let ok = if let Some(family) = s.strip_prefix(SYSTEM_FONT_PREFIX) {
+            !family.trim().is_empty()
+                && s.chars().count() <= MAX_FONT_CHOICE
+                && !s.chars().any(char::is_control)
+        } else {
+            BUNDLED_FONTS.contains(&s)
+        };
+        ok.then(|| FontChoice(s.to_string()))
+    }
+
+    pub fn as_str(&self) -> &str {
+        &self.0
+    }
+
+    fn bundled(id: &str) -> FontChoice {
+        FontChoice(id.to_string())
+    }
+}
+
+impl TryFrom<String> for FontChoice {
+    type Error = String;
+    fn try_from(s: String) -> Result<FontChoice, String> {
+        FontChoice::parse(&s).ok_or_else(|| format!("unknown font: {s}"))
+    }
+}
+
+impl From<FontChoice> for String {
+    fn from(c: FontChoice) -> String {
+        c.0
+    }
+}
+
+pub const MIN_FONT_SIZE: u8 = 13;
+pub const MAX_FONT_SIZE: u8 = 20;
+
+/// Editor text size in px, clamped to 13–20 (an out-of-range number is
+/// clamped, not reset).
+#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
+#[serde(from = "u32", into = "u8")]
+pub struct FontSize(u8);
+
+impl FontSize {
+    pub fn new(px: u32) -> FontSize {
+        FontSize(px.clamp(u32::from(MIN_FONT_SIZE), u32::from(MAX_FONT_SIZE)) as u8)
+    }
+
+    pub fn get(self) -> u8 {
+        self.0
+    }
+}
+
+impl Default for FontSize {
+    fn default() -> FontSize {
+        FontSize(15)
+    }
+}
+
+impl From<u32> for FontSize {
+    fn from(px: u32) -> FontSize {
+        FontSize::new(px)
+    }
+}
+
+impl From<FontSize> for u8 {
+    fn from(s: FontSize) -> u8 {
+        s.0
+    }
+}
+
 #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
 #[serde(rename_all = "camelCase")]
 pub struct RecentVault {
@@ -49,6 +197,13 @@ pub struct Settings {
     pub rewrite_links: bool,
     pub confirm_delete: bool,
     pub editor_mode: EditorMode,
+    pub palette: Palette,
+    pub accent_color: HexColor,
+    pub font_live_preview: FontChoice,
+    pub font_source: FontChoice,
+    pub font_size: FontSize,
+    /// Formatting toolbar shown (M2b §6).
+    pub toolbar: bool,
     pub recent_vaults: Vec<RecentVault>,
     /// Keys this build does not know (written by a newer version); kept on save.
     #[serde(flatten)]
@@ -64,6 +219,12 @@ impl Default for Settings {
             rewrite_links: true,
             confirm_delete: true,
             editor_mode: EditorMode::LivePreview,
+            palette: Palette::Lavender,
+            accent_color: HexColor::default(),
+            font_live_preview: FontChoice::bundled("atkinson-hyperlegible"),
+            font_source: FontChoice::bundled("jetbrains-mono"),
+            font_size: FontSize::default(),
+            toolbar: true,
             recent_vaults: Vec::new(),
             extra: serde_json::Map::new(),
         }
@@ -79,6 +240,12 @@ pub struct SettingsPatch {
     pub rewrite_links: Option<bool>,
     pub confirm_delete: Option<bool>,
     pub editor_mode: Option<EditorMode>,
+    pub palette: Option<Palette>,
+    pub accent_color: Option<HexColor>,
+    pub font_live_preview: Option<FontChoice>,
+    pub font_source: Option<FontChoice>,
+    pub font_size: Option<FontSize>,
+    pub toolbar: Option<bool>,
 }
 
 /// A recent vault as shown on the welcome screen.
@@ -127,6 +294,12 @@ fn parse_lenient(text: &str) -> Result<(Settings, Vec<String>), serde_json::Erro
     field!("rewriteLinks", rewrite_links);
     field!("confirmDelete", confirm_delete);
     field!("editorMode", editor_mode);
+    field!("palette", palette);
+    field!("accentColor", accent_color);
+    field!("fontLivePreview", font_live_preview);
+    field!("fontSource", font_source);
+    field!("fontSize", font_size);
+    field!("toolbar", toolbar);
     match map.remove("recentVaults") {
         None => {}
         Some(Value::Array(items)) => {
@@ -228,6 +401,24 @@ impl SettingsStore {
         if let Some(v) = patch.editor_mode {
             next.editor_mode = v;
         }
+        if let Some(v) = patch.palette {
+            next.palette = v;
+        }
+        if let Some(v) = patch.accent_color {
+            next.accent_color = v;
+        }
+        if let Some(v) = patch.font_live_preview {
+            next.font_live_preview = v;
+        }
+        if let Some(v) = patch.font_source {
+            next.font_source = v;
+        }
+        if let Some(v) = patch.font_size {
+            next.font_size = v;
+        }
+        if let Some(v) = patch.toolbar {
+            next.toolbar = v;
+        }
         self.save(&next)?;
         *s = next.clone();
         Ok(next)
```

Modify `apps/desktop/src/ipc/index.ts`:

```diff
--- a/apps/desktop/src/ipc/index.ts
+++ b/apps/desktop/src/ipc/index.ts
@@ -126,6 +126,23 @@ export interface RecentVault {
 
 export type EditorMode = 'livePreview' | 'source' | 'split';
 
+/** Built-in palettes (M2b §4); `custom` derives one from `accentColor`. */
+export const PALETTE_IDS = [
+  'lavender',
+  'graphite',
+  'rosewood',
+  'saffron',
+  'persimmon',
+  'midnight',
+  'sepia',
+  'ink',
+] as const;
+export type PaletteId = (typeof PALETTE_IDS)[number];
+export type PaletteChoice = PaletteId | 'custom';
+
+/** A bundled font id (theme/fonts.ts) or `system:<Family Name>`. */
+export type FontChoice = string;
+
 export interface Settings {
   version: number;
   /** `null` = follow the OS. */
@@ -134,6 +151,15 @@ export interface Settings {
   rewriteLinks: boolean;
   confirmDelete: boolean;
   editorMode: EditorMode;
+  palette: PaletteChoice;
+  /** `#rrggbb`, used when `palette` is `custom`. */
+  accentColor: string;
+  fontLivePreview: FontChoice;
+  fontSource: FontChoice;
+  /** Editor text size in px (13–20). */
+  fontSize: number;
+  /** Formatting toolbar shown. */
+  toolbar: boolean;
 }
 
 /** `language: 'system'` means follow the OS again. */
@@ -143,6 +169,12 @@ export interface SettingsPatch {
   rewriteLinks?: boolean;
   confirmDelete?: boolean;
   editorMode?: EditorMode;
+  palette?: PaletteChoice;
+  accentColor?: string;
+  fontLivePreview?: FontChoice;
+  fontSource?: FontChoice;
+  fontSize?: number;
+  toolbar?: boolean;
 }
 
 export interface SettingsResponse {
```

Modify `apps/desktop/src/stores/settingsStore.ts`:

```diff
--- a/apps/desktop/src/stores/settingsStore.ts
+++ b/apps/desktop/src/stores/settingsStore.ts
@@ -18,6 +18,12 @@ export const DEFAULT_SETTINGS: Settings = {
   rewriteLinks: true,
   confirmDelete: true,
   editorMode: 'livePreview',
+  palette: 'lavender',
+  accentColor: '#d1477a',
+  fontLivePreview: 'atkinson-hyperlegible',
+  fontSource: 'jetbrains-mono',
+  fontSize: 15,
+  toolbar: true,
 };
 
 interface SettingsState {
```

- [ ] **Step 4: Run the task's tests**

Run: `set -o pipefail; cargo test -p liber-desktop --test settings && cargo test -p liber-desktop --test commands m2b_ && pnpm --filter @liber/desktop exec vitest run src/stores/stores.test.ts`
Expected: PASS — settings 11, commands 1 (`m2b_settings_round_trip_over_ipc`), stores 23.

- [ ] **Step 5: Run the gate**

Run (repo root, each must exit 0): `set -o pipefail; pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 && pnpm build:ui && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && cargo deny check`
Expected: all clean (vitest 301 tests; cargo 188 + menu 2). If `cargo fmt --check` complains, run `cargo fmt --all` (the code blocks here are already formatted).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(settings): palette, accent colour, fonts, text size and toolbar settings (M2b §7)" -m "Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 2: Palettes — eight built-ins, custom accent in OKLCH, generated palettes.css

Spec §4 and §10. Palettes are data; `scripts/gen-palettes.ts` compiles them to `src/theme/palettes.css` (light block + both dark blocks per palette, in-between shades mixed to hex so nothing needs `color-mix()` at runtime). The custom accent is derived at runtime (`derive.ts`, a port of the reference page) and injected as a `<style>`. New tokens `--color-sidebar-selected`, `--color-highlight-bg`, `--color-code-bg` replace hard-coded colours in the explorer, Live Preview and the rendered pane.

**Files:**
- Modify: `.prettierignore`
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/scripts/gen-palettes.ts`
- Modify: `apps/desktop/src/features/editor/livePreview.ts`
- Modify: `apps/desktop/src/features/explorer/Explorer.module.css`
- Modify: `apps/desktop/src/features/preview/Preview.module.css`
- Modify: `apps/desktop/src/main.tsx`
- Modify: `apps/desktop/src/stores/settingsStore.ts`
- Test (modify): `apps/desktop/src/stores/stores.test.ts`
- Test (create): `apps/desktop/src/theme/appearance.test.ts`
- Create: `apps/desktop/src/theme/appearance.ts`
- Create: `apps/desktop/src/theme/color.ts`
- Create: `apps/desktop/src/theme/derive.ts`
- Create: `apps/desktop/src/theme/paletteCss.ts`
- Generated (commit as produced): `apps/desktop/src/theme/palettes.css`
- Test (create): `apps/desktop/src/theme/palettes.test.ts`
- Create: `apps/desktop/src/theme/palettes.ts`
- Modify: `apps/desktop/src/theme/tokens.css`

**Interfaces:**
- Consumes: Task 1: `PaletteId`, `PALETTE_IDS`, `Settings.palette`, `Settings.accentColor`, `DEFAULT_SETTINGS`.
- Produces: `theme/palettes.ts`: `PaletteTokens`, `Palette`, `PALETTES`. `theme/color.ts`: `hexToRgb`, `rgbToHex`, `mix`, `contrast`, `hexToOklch`, `oklchToHex`. `theme/derive.ts`: `derive(hex) → {light, dark}`, `LIGHT_ACCENT_FLOOR`, `DARK_ACCENT_FLOOR`. `theme/paletteCss.ts`: `paletteVars(p, mode)`, `paletteCss(p)`. `theme/appearance.ts`: `applyAppearance(settings, root?)`, `CUSTOM_STYLE_ID`. Script `pnpm --filter @liber/desktop gen:palettes`.

- [ ] **Step 1: Write the failing tests**

Modify `apps/desktop/src/stores/stores.test.ts`:

```diff
--- a/apps/desktop/src/stores/stores.test.ts
+++ b/apps/desktop/src/stores/stores.test.ts
@@ -103,6 +103,17 @@ describe('settingsStore', () => {
     expect(useSettingsStore.getState().settings.theme).toBe('light');
     expect(document.documentElement.dataset.theme).toBe('light');
   });
+
+  it('M2b §4: the palette applies on load and on update', async () => {
+    backend({
+      settings_get: () => ({ settings: { ...DEFAULT_SETTINGS, palette: 'sepia' } }),
+      settings_set: (a) => ({ ...DEFAULT_SETTINGS, ...(a.patch as object) }),
+    });
+    await useSettingsStore.getState().load();
+    expect(document.documentElement.dataset.palette).toBe('sepia');
+    await useSettingsStore.getState().update({ palette: 'ink' });
+    expect(document.documentElement.dataset.palette).toBe('ink');
+  });
 });
 
 describe('vaultStore', () => {
```

Create `apps/desktop/src/theme/appearance.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../stores/settingsStore';
import { applyAppearance, CUSTOM_STYLE_ID } from './appearance';

afterEach(() => {
  document.documentElement.removeAttribute('data-palette');
  document.getElementById(CUSTOM_STYLE_ID)?.remove();
});

describe('applyAppearance (M2b §4)', () => {
  it('a built-in palette is one attribute on <html>; nothing else is injected', () => {
    applyAppearance({ ...DEFAULT_SETTINGS, palette: 'midnight' });
    expect(document.documentElement.dataset.palette).toBe('midnight');
    expect(document.getElementById(CUSTOM_STYLE_ID)).toBeNull();
  });

  it('a custom accent injects one generated stylesheet and updates it in place', () => {
    applyAppearance({ ...DEFAULT_SETTINGS, palette: 'custom', accentColor: '#2aa198' });
    expect(document.documentElement.dataset.palette).toBe('custom');
    const style = document.getElementById(CUSTOM_STYLE_ID)!;
    expect(style.textContent).toContain(":root[data-palette='custom'] {");
    expect(style.textContent).toContain('--color-accent:');
    const first = style.textContent;
    applyAppearance({ ...DEFAULT_SETTINGS, palette: 'custom', accentColor: '#6d28d9' });
    expect(document.querySelectorAll(`#${CUSTOM_STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(CUSTOM_STYLE_ID)!.textContent).not.toBe(first);
    applyAppearance({ ...DEFAULT_SETTINGS, palette: 'sepia' });
    expect(document.getElementById(CUSTOM_STYLE_ID)).toBeNull();
  });
});
```

Create `apps/desktop/src/theme/palettes.test.ts`:

```ts
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '../ipc';
import { contrast } from './color';
import { derive } from './derive';
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
      expect(contrast(t.sideText, t.side), 'sidebar text').toBeGreaterThanOrEqual(7);
      for (const c of sharedText[mode]) {
        expect(contrast(c, t.surface), `${c} on surface`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
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
    expect(contrast(p.light.accent, p.light.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.dark.accent, p.dark.surface)).toBeGreaterThanOrEqual(6);
    expect(contrast(p.light.contrast, p.light.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.dark.contrast, p.dark.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.light.text, p.light.bg)).toBeGreaterThanOrEqual(7);
    expect(contrast(p.dark.text, p.dark.bg)).toBeGreaterThanOrEqual(7);
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/theme src/stores/stores.test.ts`
Expected: FAIL — `Failed to resolve import "./appearance"`, `Cannot find module './color'` (palettes.test.ts), and `× M2b §4: the palette applies on load and on update`.

- [ ] **Step 3: Implement**

After creating the files below, run `node apps/desktop/scripts/gen-palettes.ts` (or `pnpm --filter @liber/desktop gen:palettes`) to write `src/theme/palettes.css`, and add the generated file to the root `.prettierignore` (diff below). `paletteCss.ts` imports `./color.ts` with its extension because the generator runs it directly in Node.

Modify `.prettierignore`:

```diff
--- a/.prettierignore
+++ b/.prettierignore
@@ -8,3 +8,4 @@ docs
 *.md
 apps/desktop/src-tauri/gen
 apps/desktop/src-tauri/icons
+apps/desktop/src/theme/palettes.css
```

Modify `apps/desktop/package.json`:

```diff
--- a/apps/desktop/package.json
+++ b/apps/desktop/package.json
@@ -12,7 +12,8 @@
     "lint": "eslint .",
     "typecheck": "tsc --noEmit",
     "check:i18n": "node scripts/check-i18n.ts",
-    "test:e2e": "vite build && playwright test"
+    "test:e2e": "vite build && playwright test",
+    "gen:palettes": "node scripts/gen-palettes.ts"
   },
   "dependencies": {
     "@codemirror/commands": "^6.11.1",
```

Create `apps/desktop/scripts/gen-palettes.ts`:

```ts
// Writes src/theme/palettes.css from src/theme/palettes.ts (M2b §4).
// Run after changing a palette: `pnpm gen:palettes`.
import { writeFileSync } from 'node:fs';
import { paletteCss } from '../src/theme/paletteCss.ts';
import { PALETTES } from '../src/theme/palettes.ts';

const out = new URL('../src/theme/palettes.css', import.meta.url);
writeFileSync(
  out,
  `/* Generated by scripts/gen-palettes.ts from src/theme/palettes.ts — do not edit. */\n\n${PALETTES.map(paletteCss).join('\n')}`,
);
console.log(`wrote ${out.pathname}`);
```

Modify `apps/desktop/src/features/editor/livePreview.ts`:

```diff
--- a/apps/desktop/src/features/editor/livePreview.ts
+++ b/apps/desktop/src/features/editor/livePreview.ts
@@ -361,11 +361,11 @@ const theme = EditorView.baseTheme({
   '.cm-liber-em': { fontStyle: 'italic' },
   '.cm-liber-strong': { fontWeight: '700' },
   '.cm-liber-strike': { textDecoration: 'line-through' },
-  '.cm-liber-highlight': { background: 'var(--palette-yellow-bg)', borderRadius: '3px' },
+  '.cm-liber-highlight': { background: 'var(--color-highlight-bg)', borderRadius: '3px' },
   '.cm-liber-code': {
     fontFamily: 'var(--font-mono)',
     fontSize: '0.9em',
-    background: 'var(--color-surface-subtle)',
+    background: 'var(--color-code-bg)',
     borderRadius: '4px',
   },
   '.cm-liber-link': { color: 'var(--color-accent)', textDecoration: 'underline' },
```

Modify `apps/desktop/src/features/explorer/Explorer.module.css`:

```diff
--- a/apps/desktop/src/features/explorer/Explorer.module.css
+++ b/apps/desktop/src/features/explorer/Explorer.module.css
@@ -32,7 +32,7 @@
 }
 
 .selected {
-  background: color-mix(in srgb, var(--color-accent) 35%, var(--color-sidebar-bg));
+  background: var(--color-sidebar-selected);
   color: #fff;
 }
 
```

Modify `apps/desktop/src/features/preview/Preview.module.css`:

```diff
--- a/apps/desktop/src/features/preview/Preview.module.css
+++ b/apps/desktop/src/features/preview/Preview.module.css
@@ -44,7 +44,7 @@
 
 .content :not(pre) > code,
 .nested :not(pre) > code {
-  background: var(--color-surface-subtle);
+  background: var(--color-code-bg);
   border: 1px solid var(--color-border);
   border-radius: var(--radius-sm);
   padding: 0 4px;
@@ -80,7 +80,7 @@
 
 .content mark,
 .nested mark {
-  background: var(--palette-yellow-bg);
+  background: var(--color-highlight-bg);
   color: var(--color-text);
   border-radius: 3px;
   padding: 0 2px;
```

Modify `apps/desktop/src/main.tsx`:

```diff
--- a/apps/desktop/src/main.tsx
+++ b/apps/desktop/src/main.tsx
@@ -1,4 +1,5 @@
 import './theme/tokens.css';
+import './theme/palettes.css';
 import './theme/base.css';
 import { StrictMode } from 'react';
 import { createRoot } from 'react-dom/client';
```

Modify `apps/desktop/src/stores/settingsStore.ts`:

```diff
--- a/apps/desktop/src/stores/settingsStore.ts
+++ b/apps/desktop/src/stores/settingsStore.ts
@@ -8,6 +8,7 @@ import {
   type Settings,
   type SettingsPatch,
 } from '../ipc';
+import { applyAppearance } from '../theme/appearance';
 import { applyTheme } from '../theme/theme';
 import { useToastStore } from './toastStore';
 
@@ -37,6 +38,7 @@ interface SettingsState {
 
 async function apply(s: Settings) {
   applyTheme(s.theme);
+  applyAppearance(s);
   const lang = s.language ?? detectLanguage(navigator.languages);
   if (i18next.language !== lang) await i18next.changeLanguage(lang);
 }
```

Create `apps/desktop/src/theme/appearance.ts`:

```ts
import type { Settings } from '../ipc';
import { derive } from './derive';
import { paletteCss } from './paletteCss';

/** Id of the `<style>` holding the custom-accent palette. */
export const CUSTOM_STYLE_ID = 'liber-custom-palette';

/** Applies the palette (M2b §4): built-in palettes are an attribute on
 *  `<html>` (their CSS ships in palettes.css); a custom accent also gets a
 *  generated stylesheet with its light and dark tokens. */
export function applyAppearance(
  s: Pick<Settings, 'palette' | 'accentColor'>,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.palette = s.palette;
  const doc = root.ownerDocument;
  let style = doc.getElementById(CUSTOM_STYLE_ID);
  if (s.palette !== 'custom') {
    style?.remove();
    return;
  }
  if (!style) {
    style = doc.createElement('style');
    style.id = CUSTOM_STYLE_ID;
    doc.head.append(style);
  }
  style.textContent = paletteCss({ id: 'custom', ...derive(s.accentColor) });
}
```

Create `apps/desktop/src/theme/color.ts`:

```ts
// Colour maths for palettes (M2b §4): hex ↔ sRGB, WCAG contrast, OKLCH.
// Ported from docs/design/2026-10-13-m2b-palettes.html.

export type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** `#rrggbb` → sRGB channels in 0–1. */
export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** sRGB channels (clamped) → `#rrggbb`. */
export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** `a` blended toward `b` by `amount` (0 = a, 1 = b), in sRGB. */
export function mix(a: string, b: string, amount: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * amount) as Rgb);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#rrggbb` colours (1–21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `#rrggbb` → OKLCH `[lightness 0–1, chroma, hue degrees]`. */
export function hexToOklch(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI];
}

/** OKLCH → `#rrggbb`; chroma is reduced until the colour fits in sRGB. */
export function oklchToHex(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180;
  let c = C;
  let rgb: Rgb = [0, 0, 0];
  for (let i = 0; i < 30; i++) {
    const A = c * Math.cos(h);
    const B = c * Math.sin(h);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) break;
    c *= 0.9;
  }
  return rgbToHex(rgb.map(toGamma) as Rgb);
}
```

Create `apps/desktop/src/theme/derive.ts`:

```ts
import { contrast, hexToOklch, oklchToHex } from './color';
import type { PaletteTokens } from './palettes';

/** Accent contrast floors (M2b §4): text-sized accent on the surface. */
export const LIGHT_ACCENT_FLOOR = 4.8;
export const DARK_ACCENT_FLOOR = 6;

/** A complete light/dark palette from one accent colour (M2b §4): the accent
 *  is darkened (light mode) or lightened (dark mode) until it reads as text
 *  on the surface, chroma is capped, and neutrals take a faint tint of the
 *  accent's hue (none for greys). Ported from the reference page. */
export function derive(hex: string): { light: PaletteTokens; dark: PaletteTokens } {
  const [L0, c0, h] = hexToOklch(hex.toLowerCase());
  const tint = (c: number) => (c0 < 0.03 ? 0 : c);
  const at = (L: number, C: number) => oklchToHex(L, C, h);
  const lightSurface = '#ffffff';
  const darkSurface = at(0.205, tint(0.014));

  let lightAccent = hex;
  for (let x = Math.min(Math.max(L0, 0.15), 0.62); x > 0.1; x -= 0.01) {
    lightAccent = at(x, Math.min(c0, 0.17));
    if (contrast(lightAccent, lightSurface) >= LIGHT_ACCENT_FLOOR) break;
  }
  let darkAccent = hex;
  for (let x = Math.min(Math.max(L0, 0.7), 0.97); x < 0.99; x += 0.01) {
    darkAccent = at(x, Math.min(c0, 0.13));
    if (contrast(darkAccent, darkSurface) >= DARK_ACCENT_FLOOR) break;
  }
  const on = (bg: string) =>
    contrast('#ffffff', bg) >= contrast('#111111', bg) ? '#ffffff' : '#111111';

  return {
    light: {
      bg: at(0.965, tint(0.012)),
      surface: lightSurface,
      border: at(0.9, tint(0.02)),
      text: at(0.2, tint(0.02)),
      strong: at(0.24, tint(0.05)),
      body: at(0.38, tint(0.025)),
      muted: at(0.52, tint(0.03)),
      accent: lightAccent,
      soft: at(0.94, tint(0.035)),
      contrast: on(lightAccent),
      side: at(0.2, tint(0.015)),
      sideText: at(0.88, tint(0.02)),
      sideSel: 'rgba(255,255,255,.12)',
      mark: '#fbf1c7',
      code: at(0.945, tint(0.012)),
    },
    dark: {
      bg: at(0.17, tint(0.012)),
      surface: darkSurface,
      border: at(0.3, tint(0.02)),
      text: at(0.94, tint(0.01)),
      strong: at(0.97, tint(0.01)),
      body: at(0.84, tint(0.015)),
      muted: at(0.7, tint(0.02)),
      accent: darkAccent,
      soft: at(0.3, tint(0.05)),
      contrast: on(darkAccent),
      side: at(0.14, tint(0.01)),
      sideText: at(0.88, tint(0.02)),
      sideSel: 'rgba(255,255,255,.12)',
      mark: '#4a3f12',
      code: at(0.25, tint(0.014)),
    },
  };
}
```

Create `apps/desktop/src/theme/paletteCss.ts`:

```ts
// `.ts` extension: scripts/gen-palettes.ts runs this file directly in Node.
import { mix } from './color.ts';
import type { Palette, PaletteTokens } from './palettes';

/** A palette's mode as app CSS custom properties (M2b §4 mapping table). The
 *  in-between shades are mixed here as plain hex, so no `color-mix()` is
 *  needed at runtime. */
export function paletteVars(p: Palette, mode: 'light' | 'dark'): Record<string, string> {
  const t: PaletteTokens = p[mode];
  return {
    '--color-bg': t.bg,
    '--color-bg-dots': mix(t.bg, t.border, 0.6),
    '--color-surface': t.surface,
    '--color-surface-subtle': mix(t.surface, t.bg, 0.5),
    '--color-border': t.border,
    '--color-border-strong': mix(t.border, t.text, 0.1),
    '--color-text': t.text,
    '--color-text-strong': t.strong,
    '--color-text-body': t.body,
    '--color-text-muted': t.muted,
    '--color-text-faint': mix(t.muted, t.bg, 0.15),
    '--color-accent': t.accent,
    '--color-accent-hover': mix(t.accent, t.text, 0.15),
    '--color-accent-contrast': t.contrast,
    '--color-accent-soft': t.soft,
    '--color-focus': t.accent,
    '--color-sidebar-bg': t.side,
    '--color-sidebar-text': t.sideText,
    '--color-sidebar-selected': t.sideSel,
    // The sidebar is dark in both modes: its drop feedback uses the dark accent.
    '--color-drop-bg': t.sideSel,
    '--color-drop-ring': p.dark.accent,
    '--color-highlight-bg': t.mark,
    '--color-code-bg': t.code,
  };
}

const block = (selector: string, vars: Record<string, string>, indent = '') =>
  `${indent}${selector} {\n${Object.entries(vars)
    .map(([k, v]) => `${indent}  ${k}: ${v};`)
    .join('\n')}\n${indent}}\n`;

/** The palette's CSS: light on `[data-palette]`, dark for "system" in a dark
 *  OS and for an explicit dark theme (same pattern as tokens.css). */
export function paletteCss(p: Palette): string {
  const root = `:root[data-palette='${p.id}']`;
  const dark = { ...paletteVars(p, 'dark'), 'color-scheme': 'dark' };
  return (
    block(root, paletteVars(p, 'light')) +
    `@media (prefers-color-scheme: dark) {\n${block(`${root}:not([data-theme='light'])`, dark, '  ')}}\n` +
    block(`${root}[data-theme='dark']`, dark)
  );
}
```

`apps/desktop/src/theme/palettes.css` — generated: run `pnpm --filter @liber/desktop gen:palettes` (Step 3 creates the generator); never edit or prettier-format it by hand.

Create `apps/desktop/src/theme/palettes.ts`:

```ts
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
```

Modify `apps/desktop/src/theme/tokens.css`:

```diff
--- a/apps/desktop/src/theme/tokens.css
+++ b/apps/desktop/src/theme/tokens.css
@@ -20,6 +20,10 @@
   /* Drag-and-drop on the (always dark) sidebar: visible in both themes. */
   --color-drop-bg: rgba(185, 162, 230, 0.22);
   --color-drop-ring: #b9a2e6;
+  /* M2b §4: per-palette tokens (palettes.css overrides them). */
+  --color-sidebar-selected: rgba(185, 162, 230, 0.22);
+  --color-highlight-bg: #fbf1c7;
+  --color-code-bg: #efe9f6;
   --color-warn-bg: #fff1e3;
   --color-warn-border: #efc49c;
   --color-warn-text: #7a330b;
@@ -75,6 +79,8 @@
     --color-warn-border: #7a4a26;
     --color-warn-text: #f3c79f;
     --color-focus: #cbb8ef;
+    --color-highlight-bg: #4a3f12;
+    --color-code-bg: #2a2533;
     --palette-red: #ff9d92;
     --palette-red-bg: #4a1f1c;
     --palette-orange: #ffb877;
@@ -117,6 +123,8 @@
   --color-warn-border: #7a4a26;
   --color-warn-text: #f3c79f;
   --color-focus: #cbb8ef;
+  --color-highlight-bg: #4a3f12;
+  --color-code-bg: #2a2533;
   --palette-red: #ff9d92;
   --palette-red-bg: #4a1f1c;
   --palette-orange: #ffb877;
```

- [ ] **Step 4: Run the task's tests**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/theme src/stores`
Expected: PASS (119 tests: palettes, contrast for 8 palettes × 2 modes, derive sweep, appearance, stores).

- [ ] **Step 5: Run the gate**

Run (repo root, each must exit 0): `set -o pipefail; pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 && pnpm build:ui`
Expected: all clean (vitest 373 tests); `vite build` succeeds with `palettes.css` imported.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(theme): eight palettes, custom accent derived in OKLCH, generated palettes.css (M2b §4)" -m "Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 3: Fonts — bundled editor fonts, installed families via fonts_list, per-mode variables

Spec §5. Six @fontsource families (Latin + Latin Extended files only) ship with the app; installed families come from `fonts_list` (fontdb, local files, cached per session). `applyAppearance` sets `--font-live`, `--font-source`, `--font-size-editor`; the editor, Live Preview code and the rendered pane use them.

**Files:**
- Generated (commit as produced): `Cargo.lock`
- Modify: `Cargo.toml`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/build.rs`
- Modify: `apps/desktop/src-tauri/capabilities/main.json`
- Create: `apps/desktop/src-tauri/permissions/autogenerated/fonts_list.toml`
- Create: `apps/desktop/src-tauri/src/fonts.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test (modify): `apps/desktop/src-tauri/tests/commands.rs`
- Modify: `apps/desktop/src/features/editor/Editor.tsx`
- Modify: `apps/desktop/src/features/editor/livePreview.ts`
- Modify: `apps/desktop/src/features/preview/Preview.module.css`
- Modify: `apps/desktop/src/ipc/index.ts`
- Modify: `apps/desktop/src/main.tsx`
- Test (modify): `apps/desktop/src/theme/appearance.test.ts`
- Modify: `apps/desktop/src/theme/appearance.ts`
- Create: `apps/desktop/src/theme/fonts.css`
- Test (create): `apps/desktop/src/theme/fonts.test.ts`
- Create: `apps/desktop/src/theme/fonts.ts`
- Modify: `apps/desktop/src/theme/tokens.css`
- Generated (commit as produced): `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1: `FontChoice`, `BUNDLED_FONTS`, `Settings.fontLivePreview/fontSource/fontSize`. Task 2: `applyAppearance`.
- Produces: Command `fonts_list() → string[]` (`allow-fonts-list`); TS `fontsList()` in `ipc/index.ts`. `theme/fonts.ts`: `FontOption`, `LIVE_FONTS`, `SOURCE_FONTS`, `FontKind`, `fontStack(choice, kind)`, `systemChoice(family)`, `systemFamily(choice)`. CSS variables `--font-live`, `--font-source`, `--font-size-editor`.

- [ ] **Step 1: Add the dependencies**

Run `pnpm --filter @liber/desktop add @fontsource/atkinson-hyperlegible @fontsource/literata @fontsource/source-serif-4 @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono @fontsource/source-code-pro` (expected versions 5.3.0 / 5.3.0 / 5.3.1 / 5.3.0 / 5.3.0 / 5.3.1 through the release-age gate). The Rust dependency `fontdb = "0.24.0"` is added in Step 4 (workspace `Cargo.toml` diff); `cargo build` updates `Cargo.lock`.

- [ ] **Step 2: Write the failing tests**

Modify `apps/desktop/src-tauri/tests/commands.rs`:

```diff
--- a/apps/desktop/src-tauri/tests/commands.rs
+++ b/apps/desktop/src-tauri/tests/commands.rs
@@ -35,6 +35,7 @@ const COMMANDS: &[&str] = &[
     "links_resolve",
     "url_open",
     "file_open_external",
+    "fonts_list",
 ];
 
 struct Harness {
@@ -386,6 +387,7 @@ fn nfr_ui_thread_never_runs_disk_or_index_commands() {
         include_str!("../src/vault_commands.rs"),
         include_str!("../src/settings_commands.rs"),
         include_str!("../src/editor_commands.rs"),
+        include_str!("../src/fonts.rs"),
     ];
     let mut offenders = Vec::new();
     for src in sources {
@@ -643,3 +645,29 @@ fn m2b_settings_round_trip_over_ipc() {
         .is_err()
     );
 }
+
+/// M2b §5: the fonts installed on this computer, read locally (no network):
+/// unique family names, sorted, without hidden (dot) families.
+#[test]
+fn m2b_fonts_list_returns_installed_families() {
+    let h = harness();
+    let list = call(&h.main, "fonts_list", json!({})).unwrap();
+    let families: Vec<String> = list
+        .as_array()
+        .unwrap()
+        .iter()
+        .map(|v| v.as_str().unwrap().to_string())
+        .collect();
+    assert!(!families.is_empty(), "every desktop OS has fonts");
+    assert!(
+        families
+            .iter()
+            .all(|f| !f.starts_with('.') && !f.trim().is_empty())
+    );
+    let mut sorted = families.clone();
+    sorted.sort_by_key(|f| f.to_lowercase());
+    sorted.dedup_by_key(|f| f.to_lowercase());
+    assert_eq!(families, sorted, "sorted case-insensitively, no duplicates");
+    // Cached: a second call returns the same list.
+    assert_eq!(call(&h.main, "fonts_list", json!({})).unwrap(), list);
+}
```

Modify `apps/desktop/src/theme/appearance.test.ts`:

```diff
--- a/apps/desktop/src/theme/appearance.test.ts
+++ b/apps/desktop/src/theme/appearance.test.ts
@@ -4,6 +4,7 @@ import { applyAppearance, CUSTOM_STYLE_ID } from './appearance';
 
 afterEach(() => {
   document.documentElement.removeAttribute('data-palette');
+  document.documentElement.removeAttribute('style');
   document.getElementById(CUSTOM_STYLE_ID)?.remove();
 });
 
@@ -27,4 +28,17 @@ describe('applyAppearance (M2b §4)', () => {
     applyAppearance({ ...DEFAULT_SETTINGS, palette: 'sepia' });
     expect(document.getElementById(CUSTOM_STYLE_ID)).toBeNull();
   });
+
+  it('M2b §5: fonts and text size become CSS variables on <html>', () => {
+    applyAppearance({
+      ...DEFAULT_SETTINGS,
+      fontLivePreview: 'literata',
+      fontSource: 'system:Menlo',
+      fontSize: 18,
+    });
+    const style = document.documentElement.style;
+    expect(style.getPropertyValue('--font-live')).toBe("'Literata', Georgia, serif");
+    expect(style.getPropertyValue('--font-source')).toContain('"Menlo"');
+    expect(style.getPropertyValue('--font-size-editor')).toBe('18px');
+  });
 });
```

Create `apps/desktop/src/theme/fonts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fontStack, LIVE_FONTS, SOURCE_FONTS, systemChoice } from './fonts';

describe('fonts (M2b §5)', () => {
  it('bundled ids map to their stacks with a fallback', () => {
    expect(fontStack('atkinson-hyperlegible', 'live')).toBe(
      "'Atkinson Hyperlegible', system-ui, sans-serif",
    );
    expect(fontStack('literata', 'live')).toBe("'Literata', Georgia, serif");
    expect(fontStack('jetbrains-mono', 'source')).toBe(
      "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
    );
  });

  it('an installed family is used by name, quoted and escaped, before the default stack', () => {
    expect(fontStack(systemChoice('Avenir Next'), 'live')).toBe(
      '"Avenir Next", \'Atkinson Hyperlegible\', system-ui, sans-serif',
    );
    expect(fontStack('system:Odd "Name" \\ X', 'source')).toBe(
      '"Odd \\"Name\\" \\\\ X", \'JetBrains Mono\', ui-monospace, Menlo, Consolas, monospace',
    );
  });

  it('an unknown choice falls back to the default for that kind', () => {
    expect(fontStack('comic-sans', 'live')).toBe(fontStack('atkinson-hyperlegible', 'live'));
    expect(fontStack('system:', 'source')).toBe(fontStack('jetbrains-mono', 'source'));
  });

  it('the bundled lists match the ids the Rust settings accept (settings.rs BUNDLED_FONTS)', () => {
    expect([...LIVE_FONTS, ...SOURCE_FONTS].map((f) => f.id)).toEqual([
      'atkinson-hyperlegible',
      'literata',
      'source-serif-4',
      'ibm-plex-sans',
      'plus-jakarta-sans',
      'system-ui',
      'jetbrains-mono',
      'ibm-plex-mono',
      'source-code-pro',
      'system-mono',
    ]);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `set -o pipefail; cargo test -p liber-desktop --test commands; pnpm --filter @liber/desktop exec vitest run src/theme`
Expected: Rust FAILS to compile — `couldn't read apps/desktop/src-tauri/tests/../src/fonts.rs` (the async guard includes it). Vitest: `Failed to resolve import "./fonts"` and `× M2b §5: fonts and text size become CSS variables on <html>` (`expected '' to be "'Literata', Georgia, serif"`).

- [ ] **Step 4: Implement**

`Cargo.lock` — generated: `cargo build` writes it.

Modify `Cargo.toml`:

```diff
--- a/Cargo.toml
+++ b/Cargo.toml
@@ -33,6 +33,8 @@ tauri = "2.12.3"
 tauri-build = "2.7.2"
 tauri-plugin-dialog = "2.8.2"
 tauri-plugin-opener = "2.7.1"
+# M2b: installed font families (local files only)
+fontdb = "0.24.0"
 
 [workspace.lints.rust]
 unsafe_code = "forbid"
```

Modify `apps/desktop/package.json`:

```diff
--- a/apps/desktop/package.json
+++ b/apps/desktop/package.json
@@ -23,9 +23,15 @@
     "@codemirror/view": "^6.43.14",
     "@dnd-kit/core": "^6.3.1",
     "@dnd-kit/utilities": "^3.2.2",
+    "@fontsource/atkinson-hyperlegible": "^5.3.0",
     "@fontsource/bricolage-grotesque": "^5.3.0",
+    "@fontsource/ibm-plex-mono": "^5.3.0",
+    "@fontsource/ibm-plex-sans": "^5.3.0",
     "@fontsource/jetbrains-mono": "^5.3.0",
+    "@fontsource/literata": "^5.3.0",
     "@fontsource/plus-jakarta-sans": "^5.3.0",
+    "@fontsource/source-code-pro": "^5.3.1",
+    "@fontsource/source-serif-4": "^5.3.1",
     "@lezer/highlight": "^1.2.5",
     "@tauri-apps/api": "^2.12.3",
     "@tauri-apps/plugin-dialog": "^2.8.2",
```

Modify `apps/desktop/src-tauri/Cargo.toml`:

```diff
--- a/apps/desktop/src-tauri/Cargo.toml
+++ b/apps/desktop/src-tauri/Cargo.toml
@@ -17,6 +17,7 @@ tauri.workspace = true
 tauri-plugin-dialog.workspace = true
 tauri-plugin-opener.workspace = true
 percent-encoding.workspace = true
+fontdb.workspace = true
 serde.workspace = true
 serde_json.workspace = true
 thiserror.workspace = true
```

Modify `apps/desktop/src-tauri/build.rs`:

```diff
--- a/apps/desktop/src-tauri/build.rs
+++ b/apps/desktop/src-tauri/build.rs
@@ -22,6 +22,7 @@ const COMMANDS: &[&str] = &[
     "links_resolve",
     "url_open",
     "file_open_external",
+    "fonts_list",
 ];
 
 fn main() {
```

Modify `apps/desktop/src-tauri/capabilities/main.json`:

```diff
--- a/apps/desktop/src-tauri/capabilities/main.json
+++ b/apps/desktop/src-tauri/capabilities/main.json
@@ -25,6 +25,7 @@
     "allow-links-resolve",
     "allow-url-open",
     "allow-file-open-external",
+    "allow-fonts-list",
     "core:event:allow-listen",
     "core:event:allow-unlisten",
     "core:window:allow-destroy",
```

Create `apps/desktop/src-tauri/permissions/autogenerated/fonts_list.toml`:

```toml
# Automatically generated - DO NOT EDIT!

[[permission]]
identifier = "allow-fonts-list"
description = "Enables the fonts_list command without any pre-configured scope."
commands.allow = ["fonts_list"]

[[permission]]
identifier = "deny-fonts-list"
description = "Denies the fonts_list command without any pre-configured scope."
commands.deny = ["fonts_list"]
```

Create `apps/desktop/src-tauri/src/fonts.rs`:

```rust
//! Font families installed on this computer (M2b §5), for the Live Preview
//! and Source font pickers. Read from the local font files with `fontdb`
//! (no network, no file access from the webview); the webview then uses a
//! family by name in `font-family`.

use crate::error::CmdResult;
use crate::vault_commands::blocking;
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime};

/// The family names of every installed font: English names where a font has
/// several, hidden families (`.SF NS…`) removed, unique and sorted ignoring
/// case.
pub fn system_families() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut names: Vec<String> = db
        .faces()
        .filter_map(|face| {
            face.families
                .iter()
                .find(|(_, lang)| *lang == fontdb::Language::English_UnitedStates)
                .or_else(|| face.families.first())
                .map(|(name, _)| name.trim().to_string())
        })
        .filter(|name| !name.is_empty() && !name.starts_with('.'))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup_by_key(|n| n.to_lowercase());
    names
}

static FAMILIES: OnceLock<Vec<String>> = OnceLock::new();

/// Installed font families, read once per app session (scanning takes a
/// moment on machines with many fonts).
#[tauri::command]
pub async fn fonts_list<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<String>> {
    blocking(app, |_| Ok(FAMILIES.get_or_init(system_families).clone())).await
}
```

Modify `apps/desktop/src-tauri/src/lib.rs`:

```diff
--- a/apps/desktop/src-tauri/src/lib.rs
+++ b/apps/desktop/src-tauri/src/lib.rs
@@ -3,6 +3,7 @@ pub mod commands;
 pub mod dto;
 pub mod editor_commands;
 pub mod error;
+pub mod fonts;
 pub mod menu;
 pub mod navigation;
 pub mod settings;
@@ -94,6 +95,7 @@ pub fn configure<R: tauri::Runtime>(
         editor_commands::links_resolve,
         editor_commands::url_open,
         editor_commands::file_open_external,
+        fonts::fonts_list,
     ])
 }
 
```

Modify `apps/desktop/src/features/editor/Editor.tsx`:

```diff
--- a/apps/desktop/src/features/editor/Editor.tsx
+++ b/apps/desktop/src/features/editor/Editor.tsx
@@ -45,10 +45,14 @@ const sourceHighlight = HighlightStyle.define([
 const theme = EditorView.theme({
   '&': { height: '100%', color: 'var(--color-text)', backgroundColor: 'transparent' },
   '&.cm-focused': { outline: 'none' },
-  '.cm-scroller': { fontFamily: 'var(--font-body)', fontSize: '15.5px', lineHeight: '1.7' },
+  '.cm-scroller': {
+    fontFamily: 'var(--font-live)',
+    fontSize: 'var(--font-size-editor)',
+    lineHeight: '1.7',
+  },
   '&.cm-liber-source .cm-scroller': {
-    fontFamily: 'var(--font-mono)',
-    fontSize: '13.5px',
+    fontFamily: 'var(--font-source)',
+    fontSize: 'calc(var(--font-size-editor) * 0.9)',
     lineHeight: '1.6',
   },
   '.cm-content': { padding: '20px 0 40vh', caretColor: 'var(--color-text)' },
```

Modify `apps/desktop/src/features/editor/livePreview.ts`:

```diff
--- a/apps/desktop/src/features/editor/livePreview.ts
+++ b/apps/desktop/src/features/editor/livePreview.ts
@@ -363,16 +363,16 @@ const theme = EditorView.baseTheme({
   '.cm-liber-strike': { textDecoration: 'line-through' },
   '.cm-liber-highlight': { background: 'var(--color-highlight-bg)', borderRadius: '3px' },
   '.cm-liber-code': {
-    fontFamily: 'var(--font-mono)',
+    fontFamily: 'var(--font-source)',
     fontSize: '0.9em',
     background: 'var(--color-code-bg)',
     borderRadius: '4px',
   },
   '.cm-liber-link': { color: 'var(--color-accent)', textDecoration: 'underline' },
   '.cm-liber-tag': { color: 'var(--color-accent)', fontWeight: '600' },
-  '.cm-liber-codeblock': { fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
+  '.cm-liber-codeblock': { fontFamily: 'var(--font-source)', fontSize: '0.9em' },
   '.cm-liber-quote': { borderLeft: '3px solid var(--color-border-strong)', paddingLeft: '12px' },
-  '.cm-liber-frontmatter': { color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' },
+  '.cm-liber-frontmatter': { color: 'var(--color-text-muted)', fontFamily: 'var(--font-source)' },
   '.cm-liber-widget': { padding: '4px 0', cursor: 'default' },
   '.cm-liber-checkbox': { margin: '0 4px 0 0', verticalAlign: 'middle', cursor: 'pointer' },
 });
```

Modify `apps/desktop/src/features/preview/Preview.module.css`:

```diff
--- a/apps/desktop/src/features/preview/Preview.module.css
+++ b/apps/desktop/src/features/preview/Preview.module.css
@@ -1,7 +1,7 @@
 /* Rendered pane (M2a §4). */
 .content,
 .nested {
-  font: 400 15px/1.65 var(--font-body);
+  font: 400 var(--font-size-editor)/1.65 var(--font-live);
   color: var(--color-text-body);
   overflow-wrap: anywhere;
 }
@@ -38,7 +38,7 @@
 
 .content code,
 .nested code {
-  font-family: var(--font-mono);
+  font-family: var(--font-source);
   font-size: 0.9em;
 }
 
```

Modify `apps/desktop/src/ipc/index.ts`:

```diff
--- a/apps/desktop/src/ipc/index.ts
+++ b/apps/desktop/src/ipc/index.ts
@@ -247,6 +247,9 @@ export const linksResolve = (source: string, targets: LinkTarget[]) =>
 export const urlOpen = (url: string) => call<void>('url_open', { url });
 export const fileOpenExternal = (path: string) => call<void>('file_open_external', { path });
 
+/** Font families installed on this computer (M2b §5). */
+export const fontsList = () => call<string[]>('fonts_list');
+
 /** URL of a vault file for <img>/<audio> through the `liber-asset:` protocol
  *  (M2a §2.5); WebView2 on Windows reaches custom protocols over http. */
 export function assetUrl(path: string): string {
```

Modify `apps/desktop/src/main.tsx`:

```diff
--- a/apps/desktop/src/main.tsx
+++ b/apps/desktop/src/main.tsx
@@ -1,6 +1,7 @@
 import './theme/tokens.css';
 import './theme/palettes.css';
 import './theme/base.css';
+import './theme/fonts.css';
 import { StrictMode } from 'react';
 import { createRoot } from 'react-dom/client';
 import { App } from './app/App';
```

Modify `apps/desktop/src/theme/appearance.ts`:

```diff
--- a/apps/desktop/src/theme/appearance.ts
+++ b/apps/desktop/src/theme/appearance.ts
@@ -1,17 +1,22 @@
 import type { Settings } from '../ipc';
 import { derive } from './derive';
+import { fontStack } from './fonts';
 import { paletteCss } from './paletteCss';
 
 /** Id of the `<style>` holding the custom-accent palette. */
 export const CUSTOM_STYLE_ID = 'liber-custom-palette';
 
-/** Applies the palette (M2b §4): built-in palettes are an attribute on
- *  `<html>` (their CSS ships in palettes.css); a custom accent also gets a
- *  generated stylesheet with its light and dark tokens. */
+/** Applies the palette and the editor fonts (M2b §4–5): built-in palettes are
+ *  an attribute on `<html>` (their CSS ships in palettes.css); a custom accent
+ *  also gets a generated stylesheet with its light and dark tokens; fonts and
+ *  text size are CSS variables on `<html>`. */
 export function applyAppearance(
-  s: Pick<Settings, 'palette' | 'accentColor'>,
+  s: Pick<Settings, 'palette' | 'accentColor' | 'fontLivePreview' | 'fontSource' | 'fontSize'>,
   root: HTMLElement = document.documentElement,
 ): void {
+  root.style.setProperty('--font-live', fontStack(s.fontLivePreview, 'live'));
+  root.style.setProperty('--font-source', fontStack(s.fontSource, 'source'));
+  root.style.setProperty('--font-size-editor', `${s.fontSize}px`);
   root.dataset.palette = s.palette;
   const doc = root.ownerDocument;
   let style = doc.getElementById(CUSTOM_STYLE_ID);
```

Create `apps/desktop/src/theme/fonts.css`:

```css
/* Bundled editor fonts (M2b §5): Latin and Latin Extended only; other scripts
   fall back to system fonts through the stacks in fonts.ts. */
@import '@fontsource/atkinson-hyperlegible/latin-400.css';
@import '@fontsource/atkinson-hyperlegible/latin-ext-400.css';
@import '@fontsource/atkinson-hyperlegible/latin-400-italic.css';
@import '@fontsource/atkinson-hyperlegible/latin-ext-400-italic.css';
@import '@fontsource/atkinson-hyperlegible/latin-700.css';
@import '@fontsource/atkinson-hyperlegible/latin-ext-700.css';
@import '@fontsource/literata/latin-400.css';
@import '@fontsource/literata/latin-ext-400.css';
@import '@fontsource/literata/latin-400-italic.css';
@import '@fontsource/literata/latin-ext-400-italic.css';
@import '@fontsource/literata/latin-600.css';
@import '@fontsource/literata/latin-ext-600.css';
@import '@fontsource/source-serif-4/latin-400.css';
@import '@fontsource/source-serif-4/latin-ext-400.css';
@import '@fontsource/source-serif-4/latin-400-italic.css';
@import '@fontsource/source-serif-4/latin-ext-400-italic.css';
@import '@fontsource/source-serif-4/latin-600.css';
@import '@fontsource/source-serif-4/latin-ext-600.css';
@import '@fontsource/ibm-plex-sans/latin-400.css';
@import '@fontsource/ibm-plex-sans/latin-ext-400.css';
@import '@fontsource/ibm-plex-sans/latin-400-italic.css';
@import '@fontsource/ibm-plex-sans/latin-ext-400-italic.css';
@import '@fontsource/ibm-plex-sans/latin-600.css';
@import '@fontsource/ibm-plex-sans/latin-ext-600.css';
@import '@fontsource/ibm-plex-mono/latin-400.css';
@import '@fontsource/ibm-plex-mono/latin-ext-400.css';
@import '@fontsource/source-code-pro/latin-400.css';
@import '@fontsource/source-code-pro/latin-ext-400.css';
```

Create `apps/desktop/src/theme/fonts.ts`:

```ts
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
```

Modify `apps/desktop/src/theme/tokens.css`:

```diff
--- a/apps/desktop/src/theme/tokens.css
+++ b/apps/desktop/src/theme/tokens.css
@@ -53,6 +53,10 @@
   --font-display: 'Bricolage Grotesque', system-ui, sans-serif;
   --font-body: 'Plus Jakarta Sans', system-ui, sans-serif;
   --font-mono: 'JetBrains Mono', ui-monospace, monospace;
+  /* M2b §5: editor fonts (appearance.ts sets them from the settings). */
+  --font-live: 'Atkinson Hyperlegible', system-ui, sans-serif;
+  --font-source: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
+  --font-size-editor: 15px;
 }
 
 @media (prefers-color-scheme: dark) {
```

`pnpm-lock.yaml` — generated: `pnpm add` / `pnpm install` writes it.

- [ ] **Step 5: Run the task's tests**

Run: `set -o pipefail; cargo test -p liber-desktop --test commands && pnpm --filter @liber/desktop exec vitest run src/theme`
Expected: PASS — commands 20 (incl. `m2b_fonts_list_returns_installed_families` and `fonts_list` in the allowed/denied ACL list), theme 82.

- [ ] **Step 6: Run the gate**

Run (repo root, each must exit 0): `set -o pipefail; pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 && pnpm build:ui && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && cargo deny check`
Expected: all clean (vitest 378; cargo 189 + menu 2; `advisories ok, bans ok, licenses ok, sources ok`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(fonts): bundled editor fonts, installed families via fonts_list, per-mode font and size variables (M2b §5)" -m "Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 4: Settings dialog — Appearance, Editor and Files sections

Spec §4, §5, §7. Language stays on top; Appearance holds the theme, a palette grid (swatch chips + name) and, for `custom`, the accent editor (colour input + hex field with inline error + the contrast it reaches); Editor holds both font pickers (bundled + installed optgroups), text size and the toolbar switch; Files holds the existing two switches. Every change saves at once. The dialog already scrolls (`.dialog` has `overflow: auto`).

**Files:**
- Modify: `apps/desktop/src/features/dialogs/Dialogs.module.css`
- Test (create): `apps/desktop/src/features/dialogs/SettingsDialog.test.tsx`
- Modify: `apps/desktop/src/features/dialogs/SettingsDialog.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`

**Interfaces:**
- Consumes: Tasks 1–3: settings fields, `PALETTES`, `derive`, `contrast`, `LIVE_FONTS`, `SOURCE_FONTS`, `systemChoice`, `fontsList`.
- Produces: `SettingsDialog` (same props); strings `settings.sections.*`, `settings.palette`, `settings.palettes.*`, `settings.accent*`, `settings.font*`, `settings.toolbar` (en + es).

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/features/dialogs/SettingsDialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { SettingsDialog } from './SettingsDialog';

let patches: Record<string, unknown>[];

beforeEach(() => {
  patches = [];
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    if (cmd === 'settings_set') {
      patches.push(args.patch as Record<string, unknown>);
      return { ...useSettingsStore.getState().settings, ...(args.patch as object) };
    }
    if (cmd === 'fonts_list') return ['Avenir Next', 'Menlo'];
    return null;
  });
});
afterEach(() => {
  clearMocks();
  document.documentElement.removeAttribute('data-palette');
  document.documentElement.removeAttribute('style');
});

const open = () => render(<SettingsDialog onClose={() => undefined} />);

describe('Settings dialog (M2b §4, §5, §7)', () => {
  it('is grouped into Appearance, Editor and Files, and has no axe violations', async () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    for (const name of ['Appearance', 'Editor', 'Files']) {
      expect(within(dialog).getByRole('heading', { name, level: 3 })).toBeInTheDocument();
    }
    await screen.findByRole('option', { name: 'Avenir Next' }, { timeout: 2000 }).catch(() => null);
    const violations = await axe
      .run(dialog, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });

  it('a palette applies at once and is saved', async () => {
    open();
    await userEvent.click(screen.getByRole('radio', { name: 'Graphite' }));
    await waitFor(() => expect(patches).toEqual([{ palette: 'graphite' }]));
    expect(document.documentElement.dataset.palette).toBe('graphite');
  });

  it('a custom accent from the hex field: invalid input is explained and not saved', async () => {
    open();
    await userEvent.click(screen.getByRole('radio', { name: 'Custom accent' }));
    const hex = screen.getByRole('textbox', { name: 'Accent colour (hex)' });
    await userEvent.clear(hex);
    await userEvent.type(hex, 'pink{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('#rrggbb');
    await userEvent.clear(hex);
    await userEvent.type(hex, '#2AA198{Enter}');
    await waitFor(() =>
      expect(patches).toEqual([{ palette: 'custom' }, { accentColor: '#2aa198' }]),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/Accent contrast/)).toHaveTextContent(/\d+\.\d:1/);
  });

  it('the colour picker saves the accent too', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, palette: 'custom' } });
    open();
    fireEvent.change(screen.getByLabelText('Accent colour'), { target: { value: '#6d28d9' } });
    await waitFor(() => expect(patches).toEqual([{ accentColor: '#6d28d9' }]));
  });

  it('fonts: bundled and installed families per mode, text size and the toolbar', async () => {
    open();
    const live = screen.getByRole('combobox', { name: 'Live Preview font' });
    const source = screen.getByRole('combobox', { name: 'Source font' });
    expect(within(live).getByRole('option', { name: 'Atkinson Hyperlegible' })).toBeInTheDocument();
    expect(await within(source).findByRole('option', { name: 'Menlo' })).toBeInTheDocument();
    await userEvent.selectOptions(live, 'literata');
    await userEvent.selectOptions(source, 'system:Menlo');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Text size' }), '18');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show the formatting toolbar' }));
    await waitFor(() =>
      expect(patches).toEqual([
        { fontLivePreview: 'literata' },
        { fontSource: 'system:Menlo' },
        { fontSize: 18 },
        { toolbar: false },
      ]),
    );
    expect(document.documentElement.style.getPropertyValue('--font-source')).toContain('"Menlo"');
  });

  it('without the installed list (outside the app) the bundled fonts still work', async () => {
    mockIPC((cmd) => {
      if (cmd === 'fonts_list') throw { kind: 'io', message: 'no' };
      return null;
    });
    open();
    const live = screen.getByRole('combobox', { name: 'Live Preview font' });
    expect(within(live).getAllByRole('option').length).toBe(6);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/features/dialogs/SettingsDialog.test.tsx`
Expected: FAIL — all 6 tests (no "Appearance" heading, no "Graphite" radio, no "Accent colour (hex)" field, no font comboboxes).

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/dialogs/Dialogs.module.css`:

```diff
--- a/apps/desktop/src/features/dialogs/Dialogs.module.css
+++ b/apps/desktop/src/features/dialogs/Dialogs.module.css
@@ -116,3 +116,94 @@
   font-family: var(--font-mono);
   font-size: 13px;
 }
+
+/* Settings sections (M2b §7). */
+.section {
+  display: flex;
+  flex-direction: column;
+  gap: 10px;
+  padding-top: 12px;
+  border-top: 1px solid var(--color-border);
+}
+
+.sectionTitle {
+  margin: 0;
+  font: 700 14px var(--font-body);
+  letter-spacing: 0.02em;
+  color: var(--color-text-strong);
+}
+
+.palettes {
+  display: grid;
+  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
+}
+
+.palette {
+  display: flex;
+  align-items: center;
+  gap: 8px;
+  font-size: 13px;
+  color: var(--color-text-body);
+  cursor: pointer;
+}
+
+.chips {
+  display: inline-grid;
+  grid-template-columns: repeat(4, 10px);
+  border-radius: var(--radius-sm);
+  overflow: hidden;
+  border: 1px solid var(--color-border-strong);
+  flex: none;
+}
+
+.chip {
+  width: 10px;
+  height: 18px;
+}
+
+.accent {
+  display: flex;
+  flex-direction: column;
+  gap: 6px;
+}
+
+.accentRow {
+  display: flex;
+  gap: 8px;
+  align-items: center;
+}
+
+.colorInput {
+  width: 44px;
+  height: 32px;
+  padding: 2px;
+  border: 1px solid var(--color-border-strong);
+  border-radius: var(--radius-sm);
+  background: var(--color-surface-subtle);
+}
+
+.hexInput {
+  font: 400 14px var(--font-mono);
+  width: 10ch;
+  color: var(--color-text);
+  background: var(--color-surface-subtle);
+  border: 1px solid var(--color-border-strong);
+  border-radius: var(--radius-md);
+  padding: 6px 8px;
+}
+
+.hexInput[aria-invalid='true'] {
+  border-color: var(--color-warn-border);
+}
+
+.error {
+  margin: 0;
+  font-size: 13px;
+  color: var(--color-warn-text);
+}
+
+.hint {
+  margin: 0;
+  font-size: 12px;
+  color: var(--color-text-muted);
+}
```

Modify `apps/desktop/src/features/dialogs/SettingsDialog.tsx`:

```diff
--- a/apps/desktop/src/features/dialogs/SettingsDialog.tsx
+++ b/apps/desktop/src/features/dialogs/SettingsDialog.tsx
@@ -1,18 +1,29 @@
+import { useEffect, useId, useState, type KeyboardEvent } from 'react';
 import { useTranslation } from 'react-i18next';
 import { SUPPORTED_LANGUAGES } from '../../i18n';
-import type { Theme } from '../../ipc';
+import { fontsList, PALETTE_IDS, type PaletteChoice, type Theme } from '../../ipc';
 import { useSettingsStore } from '../../stores/settingsStore';
+import { contrast } from '../../theme/color';
+import { derive } from '../../theme/derive';
+import { LIVE_FONTS, SOURCE_FONTS, systemChoice, type FontOption } from '../../theme/fonts';
+import { PALETTES } from '../../theme/palettes';
 import { Dialog } from './Dialog';
 import styles from './Dialogs.module.css';
 
 const THEMES: Theme[] = ['system', 'light', 'dark'];
 const themeKey = { system: 'themeSystem', light: 'themeLight', dark: 'themeDark' } as const;
+const PALETTE_CHOICES: PaletteChoice[] = [...PALETTE_IDS, 'custom'];
+const SIZES = [13, 14, 15, 16, 17, 18, 19, 20];
+const HEX = /^#[0-9a-f]{6}$/i;
 
-/** Language, theme and file-operation settings; every change is saved at once. */
+/** Language, appearance (theme, palette, custom accent), editor (fonts, text
+ *  size, toolbar) and file settings; every change is saved at once (M2b §7). */
 export function SettingsDialog({ onClose }: { onClose: () => void }) {
   const { t } = useTranslation();
   const settings = useSettingsStore((s) => s.settings);
   const update = useSettingsStore((s) => s.update);
+  const installed = useInstalledFonts();
+  const ids = { appearance: useId(), editor: useId(), files: useId() };
 
   return (
     <Dialog title={t('settings.title')} onClose={onClose}>
@@ -31,37 +42,114 @@ export function SettingsDialog({ onClose }: { onClose: () => void }) {
           ))}
         </select>
       </label>
-      <fieldset className={styles.fieldset}>
-        <legend>{t('settings.theme')}</legend>
-        {THEMES.map((theme) => (
-          <label key={theme} className={styles.check}>
-            <input
-              type="radio"
-              name="theme"
-              value={theme}
-              checked={settings.theme === theme}
-              onChange={() => void update({ theme })}
-            />
-            {t(`settings.${themeKey[theme]}`)}
-          </label>
-        ))}
-      </fieldset>
-      <label className={styles.check}>
-        <input
-          type="checkbox"
-          checked={settings.rewriteLinks}
-          onChange={(e) => void update({ rewriteLinks: e.target.checked })}
+
+      <section className={styles.section} aria-labelledby={ids.appearance}>
+        <h3 id={ids.appearance} className={styles.sectionTitle}>
+          {t('settings.sections.appearance')}
+        </h3>
+        <fieldset className={styles.fieldset}>
+          <legend>{t('settings.theme')}</legend>
+          {THEMES.map((theme) => (
+            <label key={theme} className={styles.check}>
+              <input
+                type="radio"
+                name="theme"
+                value={theme}
+                checked={settings.theme === theme}
+                onChange={() => void update({ theme })}
+              />
+              {t(`settings.${themeKey[theme]}`)}
+            </label>
+          ))}
+        </fieldset>
+        <fieldset className={`${styles.fieldset} ${styles.palettes}`}>
+          <legend>{t('settings.palette')}</legend>
+          {PALETTE_CHOICES.map((id) => (
+            <label key={id} className={styles.palette}>
+              <input
+                type="radio"
+                name="palette"
+                value={id}
+                checked={settings.palette === id}
+                onChange={() => void update({ palette: id })}
+              />
+              <Swatch id={id} accent={settings.accentColor} />
+              <span>{t(`settings.palettes.${id}`)}</span>
+            </label>
+          ))}
+        </fieldset>
+        {settings.palette === 'custom' && (
+          <AccentEditor
+            value={settings.accentColor}
+            onSave={(accentColor) => void update({ accentColor })}
+          />
+        )}
+      </section>
+
+      <section className={styles.section} aria-labelledby={ids.editor}>
+        <h3 id={ids.editor} className={styles.sectionTitle}>
+          {t('settings.sections.editor')}
+        </h3>
+        <FontSelect
+          label={t('settings.fontLive')}
+          fonts={LIVE_FONTS}
+          installed={installed}
+          value={settings.fontLivePreview}
+          onChange={(fontLivePreview) => void update({ fontLivePreview })}
         />
-        {t('settings.rewriteLinks')}
-      </label>
-      <label className={styles.check}>
-        <input
-          type="checkbox"
-          checked={settings.confirmDelete}
-          onChange={(e) => void update({ confirmDelete: e.target.checked })}
+        <FontSelect
+          label={t('settings.fontSource')}
+          fonts={SOURCE_FONTS}
+          installed={installed}
+          value={settings.fontSource}
+          onChange={(fontSource) => void update({ fontSource })}
         />
-        {t('settings.confirmDelete')}
-      </label>
+        <label className={styles.field}>
+          <span>{t('settings.fontSize')}</span>
+          <select
+            className={styles.select}
+            value={settings.fontSize}
+            onChange={(e) => void update({ fontSize: Number(e.target.value) })}
+          >
+            {SIZES.map((px) => (
+              <option key={px} value={px}>
+                {t('settings.fontSizePx', { px })}
+              </option>
+            ))}
+          </select>
+        </label>
+        <label className={styles.check}>
+          <input
+            type="checkbox"
+            checked={settings.toolbar}
+            onChange={(e) => void update({ toolbar: e.target.checked })}
+          />
+          {t('settings.toolbar')}
+        </label>
+      </section>
+
+      <section className={styles.section} aria-labelledby={ids.files}>
+        <h3 id={ids.files} className={styles.sectionTitle}>
+          {t('settings.sections.files')}
+        </h3>
+        <label className={styles.check}>
+          <input
+            type="checkbox"
+            checked={settings.rewriteLinks}
+            onChange={(e) => void update({ rewriteLinks: e.target.checked })}
+          />
+          {t('settings.rewriteLinks')}
+        </label>
+        <label className={styles.check}>
+          <input
+            type="checkbox"
+            checked={settings.confirmDelete}
+            onChange={(e) => void update({ confirmDelete: e.target.checked })}
+          />
+          {t('settings.confirmDelete')}
+        </label>
+      </section>
+
       <div className={styles.buttons}>
         <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onClose}>
           {t('dialogs.close')}
@@ -70,3 +158,141 @@ export function SettingsDialog({ onClose }: { onClose: () => void }) {
     </Dialog>
   );
 }
+
+/** Installed font families (empty outside the app or on error). */
+function useInstalledFonts(): string[] {
+  const [families, setFamilies] = useState<string[]>([]);
+  useEffect(() => {
+    let live = true;
+    void fontsList().then((res) => {
+      if (live && res.ok && Array.isArray(res.value)) setFamilies(res.value);
+    });
+    return () => {
+      live = false;
+    };
+  }, []);
+  return families;
+}
+
+/** Light and dark background + accent of a palette, as four chips. */
+function Swatch({ id, accent }: { id: PaletteChoice; accent: string }) {
+  const p = id === 'custom' ? derive(accent) : PALETTES.find((x) => x.id === id)!;
+  return (
+    <span className={styles.chips} aria-hidden="true">
+      {[p.light.bg, p.light.accent, p.dark.bg, p.dark.accent].map((c, i) => (
+        <span key={i} className={styles.chip} style={{ background: c }} />
+      ))}
+    </span>
+  );
+}
+
+/** Colour picker + hex field for the custom accent, with the contrast the
+ *  derived palette reaches in each mode. */
+function AccentEditor({ value, onSave }: { value: string; onSave: (hex: string) => void }) {
+  const { t } = useTranslation();
+  const [draft, setDraft] = useState(value);
+  const [invalid, setInvalid] = useState(false);
+  const errorId = useId();
+  useEffect(() => setDraft(value), [value]);
+  const p = derive(value);
+
+  const commit = () => {
+    if (!HEX.test(draft)) {
+      setInvalid(true);
+      return;
+    }
+    setInvalid(false);
+    if (draft.toLowerCase() !== value) onSave(draft.toLowerCase());
+  };
+  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
+    if (e.key === 'Enter') {
+      e.preventDefault();
+      commit();
+    }
+  };
+
+  return (
+    <div className={styles.accent}>
+      <div className={styles.accentRow}>
+        <input
+          type="color"
+          className={styles.colorInput}
+          aria-label={t('settings.accentColor')}
+          value={value}
+          onChange={(e) => onSave(e.target.value.toLowerCase())}
+        />
+        <input
+          type="text"
+          className={styles.hexInput}
+          aria-label={t('settings.accentHex')}
+          aria-invalid={invalid}
+          aria-describedby={invalid ? errorId : undefined}
+          spellCheck={false}
+          value={draft}
+          onChange={(e) => setDraft(e.target.value.trim())}
+          onKeyDown={onKeyDown}
+          onBlur={commit}
+        />
+      </div>
+      {invalid && (
+        <p id={errorId} role="alert" className={styles.error}>
+          {t('settings.accentInvalid')}
+        </p>
+      )}
+      <p className={styles.hint}>
+        {t('settings.accentContrast', {
+          light: contrast(p.light.accent, p.light.surface).toFixed(1),
+          dark: contrast(p.dark.accent, p.dark.surface).toFixed(1),
+        })}
+      </p>
+    </div>
+  );
+}
+
+/** Bundled fonts, then the fonts installed on this computer. */
+function FontSelect({
+  label,
+  fonts,
+  installed,
+  value,
+  onChange,
+}: {
+  label: string;
+  fonts: readonly FontOption[];
+  installed: string[];
+  value: string;
+  onChange: (choice: string) => void;
+}) {
+  const { t } = useTranslation();
+  const known = new Set([...fonts.map((f) => f.id), ...installed.map(systemChoice)]);
+  return (
+    <label className={styles.field}>
+      <span>{label}</span>
+      <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
+        <optgroup label={t('settings.fontBundled')}>
+          {fonts.map((f) => (
+            <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
+              {f.label ?? t('settings.fontSystemDefault')}
+            </option>
+          ))}
+        </optgroup>
+        {(installed.length > 0 || !known.has(value)) && (
+          <optgroup label={t('settings.fontInstalled')}>
+            {!known.has(value) && value.startsWith('system:') && (
+              <option value={value}>{value.slice('system:'.length)}</option>
+            )}
+            {installed.map((family) => (
+              <option
+                key={family}
+                value={systemChoice(family)}
+                style={{ fontFamily: `"${family}"` }}
+              >
+                {family}
+              </option>
+            ))}
+          </optgroup>
+        )}
+      </select>
+    </label>
+  );
+}
```

Modify `apps/desktop/src/i18n/locales/en.json`:

```diff
--- a/apps/desktop/src/i18n/locales/en.json
+++ b/apps/desktop/src/i18n/locales/en.json
@@ -169,6 +169,35 @@
     "themeLight": "Light",
     "themeDark": "Dark",
     "rewriteLinks": "Update links when renaming or moving",
-    "confirmDelete": "Ask before moving to Trash"
+    "confirmDelete": "Ask before moving to Trash",
+    "sections": {
+      "appearance": "Appearance",
+      "editor": "Editor",
+      "files": "Files"
+    },
+    "palette": "Palette",
+    "palettes": {
+      "lavender": "Lavender",
+      "graphite": "Graphite",
+      "rosewood": "Rosewood",
+      "saffron": "Saffron",
+      "persimmon": "Persimmon",
+      "midnight": "Midnight",
+      "sepia": "Sepia",
+      "ink": "Ink",
+      "custom": "Custom accent"
+    },
+    "accentColor": "Accent colour",
+    "accentHex": "Accent colour (hex)",
+    "accentInvalid": "Use a colour like #rrggbb (six hex digits).",
+    "accentContrast": "Accent contrast: {light}:1 in light mode, {dark}:1 in dark mode",
+    "fontLive": "Live Preview font",
+    "fontSource": "Source font",
+    "fontBundled": "Included with the app",
+    "fontInstalled": "Installed on this computer",
+    "fontSystemDefault": "System default",
+    "fontSize": "Text size",
+    "fontSizePx": "{px} px",
+    "toolbar": "Show the formatting toolbar"
   }
 }
```

Modify `apps/desktop/src/i18n/locales/es.json`:

```diff
--- a/apps/desktop/src/i18n/locales/es.json
+++ b/apps/desktop/src/i18n/locales/es.json
@@ -169,6 +169,35 @@
     "themeLight": "Claro",
     "themeDark": "Oscuro",
     "rewriteLinks": "Actualizar enlaces al renombrar o mover",
-    "confirmDelete": "Preguntar antes de mover a la papelera"
+    "confirmDelete": "Preguntar antes de mover a la papelera",
+    "sections": {
+      "appearance": "Apariencia",
+      "editor": "Editor",
+      "files": "Archivos"
+    },
+    "palette": "Paleta",
+    "palettes": {
+      "lavender": "Lavanda",
+      "graphite": "Grafito",
+      "rosewood": "Palisandro",
+      "saffron": "Azafrán",
+      "persimmon": "Caqui",
+      "midnight": "Medianoche",
+      "sepia": "Sepia",
+      "ink": "Tinta",
+      "custom": "Color de acento propio"
+    },
+    "accentColor": "Color de acento",
+    "accentHex": "Color de acento (hex)",
+    "accentInvalid": "Usa un color como #rrggbb (seis dígitos hexadecimales).",
+    "accentContrast": "Contraste del acento: {light}:1 en modo claro, {dark}:1 en modo oscuro",
+    "fontLive": "Fuente de Vista en vivo",
+    "fontSource": "Fuente de Código",
+    "fontBundled": "Incluidas con la app",
+    "fontInstalled": "Instaladas en este equipo",
+    "fontSystemDefault": "Predeterminada del sistema",
+    "fontSize": "Tamaño del texto",
+    "fontSizePx": "{px} px",
+    "toolbar": "Mostrar la barra de formato"
   }
 }
```

- [ ] **Step 4: Run the task's tests**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/features/dialogs src/features/shell`
Expected: PASS (SettingsDialog 6, plus the existing shell/settings tests). The `Array.isArray` guard in `useInstalledFonts` matters: other suites' IPC mocks answer unknown commands with `null`.

- [ ] **Step 5: Run the gate**

Run (repo root, each must exit 0): `set -o pipefail; pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2`
Expected: all clean (vitest 384).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(settings): Appearance, Editor and Files sections — palettes, custom accent, fonts, text size, toolbar (M2b §4, §5, §7)" -m "Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 5: Formatting commands and keys

Spec §6 (commands and shortcuts) and §3 (keys). Pure CodeMirror commands, one transaction per run (one undo step) across every selection. The editor switches to the GFM syntax tree (`markdownLanguage`) so the toolbar can read strikethrough and task items; `editorKeymap` drops CodeMirror's `Mod-[` / `Mod-]` and adds Tab / Shift-Tab that indent only inside list items.

**Files:**
- Test (modify): `apps/desktop/src/features/editor/Editor.test.tsx`
- Modify: `apps/desktop/src/features/editor/Editor.tsx`
- Test (create): `apps/desktop/src/features/editor/format.test.ts`
- Create: `apps/desktop/src/features/editor/format.ts`

**Interfaces:**
- Consumes: `Editor.tsx` `createState` (M2a).
- Produces: `features/editor/format.ts`: types `InlineFormat`, `BlockFormat`, `ActiveFormat`; `MARKERS`; commands `toggleInline(kind)`, `setHeading(level)`, `toggleBlock(kind)`, `insertDivider`, `insertLink`, `listIndent(dir)`; `activeFormats(state) → Set<ActiveFormat>`; `formatKeymap`, `editorKeymap`.

- [ ] **Step 1: Write the failing tests**

Modify `apps/desktop/src/features/editor/Editor.test.tsx`:

```diff
--- a/apps/desktop/src/features/editor/Editor.test.tsx
+++ b/apps/desktop/src/features/editor/Editor.test.tsx
@@ -207,3 +207,24 @@ describe('task checkboxes outside the source text (feedback 2026-10-13)', () =>
     expect(viewOf().state.doc.toString()).toBe('> [!todo] List\n> - [x] a\n\nend\n');
   });
 });
+
+describe('formatting keys (M2b §6)', () => {
+  const mod = /Mac|iP(hone|ad)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
+  const press = (key: string, extra: KeyboardEventInit = {}) =>
+    act(() => {
+      viewOf().contentDOM.dispatchEvent(
+        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mod, ...extra }),
+      );
+    });
+
+  it('⌘B bolds the word at the cursor; ⌘[ is not indentation any more', async () => {
+    disk = fakeDisk({ 'K.md': 'hello world\n' });
+    const doc = await load('K.md');
+    render(<Editor doc={doc} mode="source" label="K" />);
+    act(() => viewOf().dispatch({ selection: { anchor: 8 } }));
+    await press('b');
+    expect(viewOf().state.doc.toString()).toBe('hello **world**\n');
+    await press('[');
+    expect(viewOf().state.doc.toString()).toBe('hello **world**\n');
+  });
+});
```

Create `apps/desktop/src/features/editor/format.test.ts`:

```ts
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  activeFormats,
  editorKeymap,
  insertDivider,
  insertLink,
  listIndent,
  setHeading,
  toggleBlock,
  toggleInline,
} from './format';

/** `‹…›` marks a selection, `¦` a cursor (several allowed). */
function stateOf(marked: string): EditorState {
  const ranges: { anchor: number; head: number }[] = [];
  let doc = '';
  let start = -1;
  for (const ch of marked) {
    if (ch === '‹') start = doc.length;
    else if (ch === '›') ranges.push({ anchor: start, head: doc.length });
    else if (ch === '¦') ranges.push({ anchor: doc.length, head: doc.length });
    else doc += ch;
  }
  return EditorState.create({
    doc,
    selection: EditorSelection.create(
      ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
      0,
    ),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      history(),
      markdown({ base: markdownLanguage }),
    ],
  });
}

function marked(state: EditorState): string {
  let out = state.doc.toString();
  const ranges = [...state.selection.ranges].sort((a, b) => b.from - a.from);
  for (const r of ranges) {
    out = r.empty
      ? `${out.slice(0, r.from)}¦${out.slice(r.from)}`
      : `${out.slice(0, r.from)}‹${out.slice(r.from, r.to)}›${out.slice(r.to)}`;
  }
  return out;
}

function run(cmd: StateCommand, input: string | EditorState): EditorState {
  let state = typeof input === 'string' ? stateOf(input) : input;
  const handled = cmd({ state, dispatch: (tr) => (state = tr.state) });
  expect(handled).toBe(true);
  return state;
}

const apply = (cmd: StateCommand, input: string) => marked(run(cmd, input));

describe('inline formats (M2b §6)', () => {
  it('wraps a selection and unwraps it again', () => {
    expect(apply(toggleInline('bold'), 'hello ‹world›')).toBe('hello **‹world›**');
    expect(apply(toggleInline('bold'), 'hello **‹world›**')).toBe('hello ‹world›');
    expect(apply(toggleInline('bold'), 'hello ‹**world**›')).toBe('hello ‹world›');
    expect(apply(toggleInline('strike'), '‹gone›')).toBe('~~‹gone›~~');
    expect(apply(toggleInline('highlight'), '‹mark›')).toBe('==‹mark›==');
    expect(apply(toggleInline('code'), '‹x = 1›')).toBe('`‹x = 1›`');
  });

  it('an empty cursor formats the word under it, or opens an empty pair', () => {
    expect(apply(toggleInline('bold'), 'hel¦lo there')).toBe('**hel¦lo** there');
    expect(apply(toggleInline('bold'), '**hel¦lo** there')).toBe('hel¦lo there');
    expect(apply(toggleInline('italic'), 'a ¦ b')).toBe('a *¦* b');
  });

  it('italic inside bold adds italic instead of breaking the bold', () => {
    expect(apply(toggleInline('italic'), '**wo¦rd**')).toBe('***wo¦rd***');
    expect(apply(toggleInline('italic'), '***wo¦rd***')).toBe('**wo¦rd**');
  });

  it('every selection at once, in one undo step', () => {
    const s = run(toggleInline('bold'), '‹one› and ‹two›');
    expect(marked(s)).toBe('**‹one›** and **‹two›**');
    let back = s;
    undo({ state: s, dispatch: (tr) => (back = tr.state) });
    expect(back.doc.toString()).toBe('one and two');
  });
});

describe('block formats', () => {
  it('headings set, replace and clear the # prefix of every selected line', () => {
    expect(apply(setHeading(2), 'Title¦')).toBe('## Title¦');
    expect(apply(setHeading(3), '# A¦')).toBe('### A¦');
    expect(apply(setHeading(0), '## A¦')).toBe('A¦');
    expect(apply(setHeading(1), '‹a\nb›')).toBe('‹# a\n# b›');
  });

  it('lists toggle their prefix, switch kinds and keep indentation', () => {
    expect(apply(toggleBlock('bullet'), '‹a\nb›')).toBe('‹- a\n- b›');
    expect(apply(toggleBlock('bullet'), '‹- a\n- b›')).toBe('‹a\nb›');
    expect(apply(toggleBlock('numbered'), '‹a\n\nb›')).toBe('‹1. a\n\n2. b›');
    expect(apply(toggleBlock('task'), '- a¦')).toBe('- [ ] a¦');
    expect(apply(toggleBlock('numbered'), '  - a¦')).toBe('  1. a¦');
    expect(apply(toggleBlock('bullet'), '¦')).toBe('- ¦');
  });

  it('quote adds and removes "> " in front of every line', () => {
    expect(apply(toggleBlock('quote'), '‹a\n- b›')).toBe('‹> a\n> - b›');
    expect(apply(toggleBlock('quote'), '‹> a\n> - b›')).toBe('‹a\n- b›');
  });

  it('a divider never turns the paragraph above into a heading', () => {
    expect(apply(insertDivider, 'text¦')).toBe('text\n\n---\n¦');
    expect(apply(insertDivider, 'text\n¦')).toBe('text\n\n---\n¦');
    expect(apply(insertDivider, '¦')).toBe('---\n¦');
  });

  it('a link wraps the selection and selects the address to type', () => {
    expect(apply(insertLink, 'see ‹site›')).toBe('see [site](‹url›)');
    expect(apply(insertLink, 'see ¦')).toBe('see [¦]()');
  });
});

describe('keys', () => {
  it('⌘[ / ⌘] belong to back/forward, not to indentation', () => {
    const keys = editorKeymap.map((b) => b.key);
    expect(keys).not.toContain('Mod-[');
    expect(keys).not.toContain('Mod-]');
    for (const k of ['Mod-b', 'Mod-i', 'Mod-Shift-x', 'Mod-Shift-h', 'Mod-e', 'Mod-k']) {
      expect(keys, k).toContain(k);
    }
    for (const n of [0, 1, 2, 3, 4, 5, 6]) expect(keys).toContain(`Mod-Alt-${n}`);
    for (const k of ['Mod-Shift-7', 'Mod-Shift-8', 'Mod-Shift-9', 'Mod-Shift-.']) {
      expect(keys).toContain(k);
    }
  });

  it('Tab indents only inside a list item; elsewhere it moves focus', () => {
    expect(apply(listIndent(1), '- a\n- b¦')).toBe('- a\n  - b¦');
    expect(apply(listIndent(-1), '- a\n  - b¦')).toBe('- a\n- b¦');
    const plain = stateOf('text¦');
    expect(listIndent(1)({ state: plain, dispatch: () => undefined })).toBe(false);
  });
});

describe('activeFormats (toolbar pressed state)', () => {
  const at = (input: string) => {
    const s = stateOf(input);
    ensureSyntaxTree(s, s.doc.length, 1000);
    return activeFormats(s);
  };
  it('reads the syntax tree at the cursor', () => {
    expect(at('**bo¦ld** and *it*')).toEqual(new Set(['bold']));
    expect(at('***bo¦th***')).toEqual(new Set(['bold', 'italic']));
    expect(at('~~ga¦ne~~ `co`')).toEqual(new Set(['strike']));
    expect(at('`co¦de`')).toEqual(new Set(['code']));
    expect(at('## He¦ad')).toEqual(new Set(['h2']));
    expect(at('- [ ] ta¦sk')).toEqual(new Set(['task']));
    expect(at('1. on¦e')).toEqual(new Set(['numbered']));
    expect(at('> - qu¦ote')).toEqual(new Set(['quote', 'bullet']));
    expect(at('a ==hi¦gh== b')).toEqual(new Set(['highlight']));
    expect(at('pla¦in')).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/features/editor/format.test.ts src/features/editor/Editor.test.tsx`
Expected: FAIL — `Failed to resolve import "./format"`; Editor: `× ⌘B bolds the word at the cursor; ⌘[ is not indentation any more` (`expected 'hello world\n' to be 'hello **world**\n'`).

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/editor/Editor.tsx`:

```diff
--- a/apps/desktop/src/features/editor/Editor.tsx
+++ b/apps/desktop/src/features/editor/Editor.tsx
@@ -1,5 +1,5 @@
-import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
-import { markdown } from '@codemirror/lang-markdown';
+import { history, historyKeymap } from '@codemirror/commands';
+import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
 import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
 import { Compartment, EditorState, Facet, Transaction, type Extension } from '@codemirror/state';
 import { drawSelection, EditorView, keymap } from '@codemirror/view';
@@ -11,6 +11,7 @@ import type { EditorMode } from '../../ipc';
 import { Preview } from '../preview/Preview';
 import styles from './Editor.module.css';
 import { followLinkAtCursor, livePreview, pagePath } from './livePreview';
+import { editorKeymap } from './format';
 import type { PageDoc } from './pageDoc';
 import { blockForOffset, offsetAtTop, topIn } from './scrollSync';
 import { toggleTaskIn } from './widgets';
@@ -169,12 +170,9 @@ function createState(d: PageDoc, mode: EditorMode, label: string): EditorState {
       history(),
       drawSelection(),
       EditorView.lineWrapping,
-      markdown(),
-      keymap.of([
-        { key: 'Mod-Enter', run: followLinkAtCursor },
-        ...defaultKeymap,
-        ...historyKeymap,
-      ]),
+      // GFM syntax tree: Source highlighting and the toolbar's pressed state.
+      markdown({ base: markdownLanguage }),
+      keymap.of([{ key: 'Mod-Enter', run: followLinkAtCursor }, ...editorKeymap, ...historyKeymap]),
       pagePath.of(() => d.path),
       theme,
       labelSlot.of(labelled(label)),
```

Create `apps/desktop/src/features/editor/format.ts`:

```ts
// Formatting commands (M2b §6): pure CodeMirror commands over the Markdown
// text — one transaction (one undo step) for every selection — plus the keys
// that run them with or without the toolbar.
import { defaultKeymap, indentLess, indentMore } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type SelectionRange,
  type StateCommand,
} from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';

export type InlineFormat = 'bold' | 'italic' | 'strike' | 'highlight' | 'code';
export type BlockFormat = 'bullet' | 'numbered' | 'task' | 'quote';
/** What the toolbar can show as pressed. */
export type ActiveFormat = InlineFormat | BlockFormat | `h${1 | 2 | 3 | 4 | 5 | 6}`;

export const MARKERS: Record<InlineFormat, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  highlight: '==',
  code: '`',
};

/** How many `ch` end `text` / start `text`. */
const runBefore = (text: string, ch: string) =>
  text.length - text.replace(new RegExp(`\\${ch}+$`), '').length;
const runAfter = (text: string, ch: string) =>
  text.length - text.replace(new RegExp(`^\\${ch}+`), '').length;

/** Whether runs of `before`/`after` marker characters wrap the text in this
 *  format: italic is an odd run (`*x*`, `***x***`), the others need their
 *  whole marker (`**x**` is bold, never italic). */
function wrapped(kind: InlineFormat, before: number, after: number): boolean {
  const len = MARKERS[kind].length;
  if (kind === 'italic') return before % 2 === 1 && after % 2 === 1;
  return before >= len && after >= len;
}

/** Wraps each selection (or the word at an empty cursor) in the format's
 *  markers, or unwraps it when it is already formatted. */
export function toggleInline(kind: InlineFormat): StateCommand {
  const m = MARKERS[kind];
  const k = m.length;
  const ch = m[0];
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((range) => {
      let { from, to } = range;
      if (range.empty) {
        const word = state.wordAt(range.head);
        if (!word) {
          return {
            changes: { from, insert: m + m },
            range: EditorSelection.cursor(from + k),
          };
        }
        ({ from, to } = word);
      }
      const text = state.sliceDoc(from, to);
      const before = runBefore(state.sliceDoc(Math.max(0, from - 6), from), ch);
      const after = runAfter(state.sliceDoc(to, to + 6), ch);
      const keep = (a: number, b: number) =>
        range.empty ? EditorSelection.cursor(range.head + a) : EditorSelection.range(from + a, b);
      if (wrapped(kind, before, after)) {
        return {
          changes: [
            { from: from - k, to: from },
            { from: to, to: to + k },
          ],
          range: keep(-k, to - k),
        };
      }
      const inside =
        text.length >= 2 * k &&
        wrapped(kind, runAfter(text, ch), runBefore(text, ch)) &&
        text.startsWith(m) &&
        text.endsWith(m);
      if (inside) {
        return {
          changes: [
            { from, to: from + k },
            { from: to - k, to },
          ],
          range: EditorSelection.range(from, to - 2 * k),
        };
      }
      return {
        changes: [
          { from, insert: m },
          { from: to, insert: m },
        ],
        range: keep(k, to + k),
      };
    });
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

/** Line numbers touched by the selections, in order, once each. */
function selectedLines(state: EditorState): number[] {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Applies per-line edits as one transaction; selections map through them. */
function editLines(
  state: EditorState,
  dispatch: (tr: ReturnType<EditorState['update']>) => void,
  edit: (text: string, index: number, lines: string[]) => string,
): boolean {
  const numbers = selectedLines(state);
  const texts = numbers.map((n) => state.doc.line(n).text);
  const changes: ChangeSpec[] = [];
  numbers.forEach((n, i) => {
    const line = state.doc.line(n);
    const next = edit(line.text, i, texts);
    if (next !== line.text) changes.push(...lineChange(line.from, line.text, next));
  });
  const set = state.changes(changes);
  // A selection that starts at a line start keeps covering the whole line
  // (prefix included); cursors stay after the text they were on.
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => {
      const atStart = !r.empty && state.doc.lineAt(r.from).from === r.from;
      const from = set.mapPos(r.from, atStart ? -1 : 1);
      const to = set.mapPos(r.to, 1);
      return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
    }),
    state.selection.mainIndex,
  );
  dispatch(
    state.update({ changes: set, selection, scrollIntoView: true, userEvent: 'input.format' }),
  );
  return true;
}

/** The smallest change turning `before` into `after` at `from` (only the
 *  prefix differs in practice), so cursors after it keep their place. */
function lineChange(from: number, before: string, after: string): ChangeSpec[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return [
    {
      from: from + head,
      to: from + before.length - tail,
      insert: after.slice(head, after.length - tail),
    },
  ];
}

const HEADING = /^(#{1,6})[ \t]+/;

/** Sets every selected line to heading `level` (0 = paragraph). */
export function setHeading(level: 0 | 1 | 2 | 3 | 4 | 5 | 6): StateCommand {
  return ({ state, dispatch }) =>
    editLines(state, dispatch, (text) => {
      const body = text.replace(HEADING, '');
      return level === 0 ? body : `${'#'.repeat(level)} ${body}`;
    });
}

/** indent, list marker (`- `, `1. `, `- [ ] `), rest. */
const LIST = /^(\s*)((?:[-*+][ \t]+\[[ xX]\][ \t]+)|(?:[-*+][ \t]+)|(?:\d+[.)][ \t]+))?(.*)$/;
const kindOf = (marker: string | undefined): BlockFormat | null =>
  !marker ? null : /\[[ xX]\]/.test(marker) ? 'task' : /^\d/.test(marker) ? 'numbered' : 'bullet';

/** Toggles a list kind or the quote on every selected line: removes it when
 *  every (non-blank) line already has it, otherwise sets it — replacing
 *  another list kind, renumbering numbered lists, keeping indentation. */
export function toggleBlock(kind: BlockFormat): StateCommand {
  return ({ state, dispatch }) => {
    const lines = selectedLines(state).map((n) => state.doc.line(n).text);
    const single = lines.length === 1;
    const counted = lines.filter((l) => single || l.trim() !== '');
    if (kind === 'quote') {
      const all = counted.every((l) => /^>/.test(l));
      return editLines(state, dispatch, (text) => {
        if (!single && text.trim() === '') return text;
        return all ? text.replace(/^> ?/, '') : `> ${text}`;
      });
    }
    const all = counted.every((l) => kindOf(LIST.exec(l)?.[2]) === kind);
    let number = 0;
    return editLines(state, dispatch, (text) => {
      if (!single && text.trim() === '') return text;
      const [, indent, , rest] = LIST.exec(text)!;
      if (all) return indent + rest;
      number += 1;
      const marker = kind === 'bullet' ? '- ' : kind === 'task' ? '- [ ] ' : `${number}. `;
      return indent + marker + rest;
    });
  };
}

/** A thematic break on its own line, with a blank line above it so the
 *  paragraph before never becomes a setext heading. */
export const insertDivider: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  let from: number;
  let insert: string;
  if (line.text.trim() !== '') {
    from = line.to;
    insert = '\n\n---\n';
  } else {
    const above = line.number > 1 ? state.doc.line(line.number - 1).text : '';
    from = line.from;
    insert = above.trim() !== '' ? '\n---\n' : '---\n';
  }
  dispatch(
    state.update({
      changes: { from, to: line.text.trim() === '' ? line.to : from, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};

/** `[selection](url)` with "url" selected to type over; empty → `[]()`. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range: SelectionRange) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: '[]()' },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const text = state.sliceDoc(range.from, range.to);
    const urlFrom = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}](url)` },
      range: EditorSelection.range(urlFrom, urlFrom + 3),
    };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
};

/** Tab / Shift-Tab: indent or outdent list items only; elsewhere the key is
 *  left to the browser, so Tab keeps moving focus out of the editor. */
export function listIndent(dir: 1 | -1): StateCommand {
  return (target) => {
    const inList = selectedLines(target.state).every((n) =>
      /^\s*([-*+]|\d+[.)])[ \t]/.test(target.state.doc.line(n).text),
    );
    if (!inList) return false;
    return dir === 1 ? indentMore(target) : indentLess(target);
  };
}

const HEADINGS = {
  ATXHeading1: 'h1',
  ATXHeading2: 'h2',
  ATXHeading3: 'h3',
  ATXHeading4: 'h4',
  ATXHeading5: 'h5',
  ATXHeading6: 'h6',
  SetextHeading1: 'h1',
  SetextHeading2: 'h2',
} as const;
const INLINE_NODES: Record<string, ActiveFormat> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strike',
  InlineCode: 'code',
  Blockquote: 'quote',
};

/** The formats at the main cursor, from the editor's (incremental) syntax
 *  tree; `==highlight==` has no node there, so it is found on the line. */
export function activeFormats(state: EditorState): Set<ActiveFormat> {
  const out = new Set<ActiveFormat>();
  const pos = state.selection.main.head;
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent!) {
    const name = node.name;
    if (name in INLINE_NODES) out.add(INLINE_NODES[name]);
    else if (name in HEADINGS) out.add(HEADINGS[name as keyof typeof HEADINGS]);
    else if (name === 'ListItem') {
      const list = node.parent?.name;
      const task = node.getChild('Task');
      if (!out.has('bullet') && !out.has('numbered') && !out.has('task')) {
        out.add(task ? 'task' : list === 'OrderedList' ? 'numbered' : 'bullet');
      }
    }
    if (!node.parent) break;
  }
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const after = line.text.slice(pos - line.from);
  if ((before.split('==').length - 1) % 2 === 1 && after.includes('==')) out.add('highlight');
  return out;
}

/** Formatting shortcuts (active with the toolbar hidden too). */
export const formatKeymap: readonly KeyBinding[] = [
  { key: 'Mod-b', run: toggleInline('bold') },
  { key: 'Mod-i', run: toggleInline('italic') },
  { key: 'Mod-Shift-x', run: toggleInline('strike') },
  { key: 'Mod-Shift-h', run: toggleInline('highlight') },
  { key: 'Mod-e', run: toggleInline('code') },
  { key: 'Mod-k', run: insertLink },
  ...([0, 1, 2, 3, 4, 5, 6] as const).map((n) => ({ key: `Mod-Alt-${n}`, run: setHeading(n) })),
  { key: 'Mod-Shift-7', run: toggleBlock('numbered') },
  { key: 'Mod-Shift-8', run: toggleBlock('bullet') },
  { key: 'Mod-Shift-9', run: toggleBlock('task') },
  { key: 'Mod-Shift-.', run: toggleBlock('quote') },
  { key: 'Tab', run: listIndent(1) },
  { key: 'Shift-Tab', run: listIndent(-1) },
];

/** The editor's keys: formatting first, then CodeMirror's defaults without
 *  ⌘[ / ⌘] (they go back and forward along the link trail, M2b §3). */
export const editorKeymap: readonly KeyBinding[] = [
  ...formatKeymap,
  ...defaultKeymap.filter((b) => b.key !== 'Mod-[' && b.key !== 'Mod-]'),
];
```

- [ ] **Step 4: Run the task's tests**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/features/editor`
Expected: PASS (format 12, the whole editor folder 59).

- [ ] **Step 5: Run the gate**

Run (repo root, each must exit 0): `set -o pipefail; pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2`
Expected: all clean (vitest 397).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(editor): formatting commands and shortcuts; ⌘[ / ⌘] freed for navigation, Tab indents only in lists (M2b §6)" -m "Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 6: Formatting toolbar and its header toggle

Spec §6. An ARIA toolbar above the editor in all three modes: inline buttons, a "Text style" heading menu, block buttons. One Tab stop (roving tabindex; arrows, Home, End). Buttons prevent `mousedown` so the editor keeps its selection; pressed state follows the cursor through a per-view callback (`toolbarOf`), re-rendering only when the set of formats changes. The page header gets an "Aa" toggle (`aria-pressed`) bound to the `toolbar` setting.

**Files:**
- Modify: `apps/desktop/src/features/editor/Editor.module.css`
- Modify: `apps/desktop/src/features/editor/Editor.tsx`
- Test (create): `apps/desktop/src/features/editor/Toolbar.test.tsx`
- Create: `apps/desktop/src/features/editor/Toolbar.tsx`
- Modify: `apps/desktop/src/features/page/PageHeader.tsx`
- Modify: `apps/desktop/src/features/page/PageView.module.css`
- Test (modify): `apps/desktop/src/features/page/PageView.test.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`

**Interfaces:**
- Consumes: Task 5: commands, `activeFormats`, `ActiveFormat`. Task 1: `settings.toolbar`.
- Produces: `features/editor/Toolbar.tsx` `Toolbar({ view, active })`; Editor renders it when `settings.toolbar`; `toolbar.*` strings (en + es).

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/features/editor/Toolbar.test.tsx`:

```tsx
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from './Editor';
import { PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;

async function show(text: string, cursor: number) {
  fakeDisk({ 'T.md': text });
  const res = await PageDoc.load('T.md', hooks);
  if (!res.ok) throw new Error(res.error.message);
  render(<Editor doc={res.value} mode="livePreview" label="T" />);
  act(() => viewOf().dispatch({ selection: { anchor: cursor } }));
}

beforeEach(() => useSettingsStore.setState({ settings: DEFAULT_SETTINGS }));
afterEach(() => clearMocks());

describe('formatting toolbar (M2b §6)', () => {
  it('runs a format on the editor and keeps the editor focused', async () => {
    await show('hello world\n', 8);
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Bold' }));
    expect(viewOf().state.doc.toString()).toBe('hello **world**\n');
    expect(viewOf().hasFocus).toBe(true);
    await waitFor(() =>
      expect(within(bar).getByRole('button', { name: 'Bold' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    await userEvent.selectOptions(within(bar).getByRole('combobox', { name: 'Text style' }), '2');
    expect(viewOf().state.doc.toString()).toBe('## hello **world**\n');
    await userEvent.click(within(bar).getByRole('button', { name: 'Task list' }));
    expect(viewOf().state.doc.toString()).toBe('- [ ] ## hello **world**\n');
  });

  it('the heading menu follows the cursor', async () => {
    await show('### Three\n\nplain\n', 4);
    const style = screen.getByRole('combobox', { name: 'Text style' });
    await waitFor(() => expect(style).toHaveValue('3'));
    act(() => viewOf().dispatch({ selection: { anchor: 13 } }));
    await waitFor(() => expect(style).toHaveValue('0'));
  });

  it('one Tab stop; arrow keys, Home and End move between the controls', async () => {
    await show('x\n', 0);
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    const items = within(bar).getAllByRole('button');
    const tabbable = [...bar.querySelectorAll('button, select')].filter(
      (el) => (el as HTMLElement).tabIndex === 0,
    );
    expect(tabbable).toHaveLength(1);
    items[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(items.at(-1));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(items.at(-1));
  });

  it('has no axe violations and is hidden when the setting is off', async () => {
    await show('x\n', 0);
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    const violations = await axe
      .run(bar, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
    act(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, toolbar: false } }));
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
});
```

Modify `apps/desktop/src/features/page/PageView.test.tsx`:

```diff
--- a/apps/desktop/src/features/page/PageView.test.tsx
+++ b/apps/desktop/src/features/page/PageView.test.tsx
@@ -85,6 +85,19 @@ describe('PageView (M2a §5)', () => {
     expect(screen.getByRole('region', { name: 'Preview' })).toHaveTextContent('body');
   });
 
+  it('M2b §6: the header button shows and hides the formatting toolbar', async () => {
+    const disk = fakeDisk({ 'A.md': '# A\n\nbody\n' });
+    render(<PageView />);
+    await open('A.md');
+    const toggle = screen.getByRole('button', { name: 'Formatting toolbar' });
+    expect(toggle).toHaveAttribute('aria-pressed', 'true');
+    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
+    await userEvent.click(toggle);
+    expect(disk.calls).toContainEqual(['settings_set', { patch: { toolbar: false } }]);
+    await waitFor(() => expect(screen.queryByRole('toolbar')).not.toBeInTheDocument());
+    expect(toggle).toHaveAttribute('aria-pressed', 'false');
+  });
+
   it('save status: Saved → Saving… → Saved; failures say "Unsaved — retrying"', async () => {
     const disk = fakeDisk({ 'A.md': '# A\n' });
     render(<PageView />);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/features/editor/Toolbar.test.tsx src/features/page/PageView.test.tsx`
Expected: FAIL — the 4 toolbar tests (no `toolbar` named "Formatting") and `× M2b §6: the header button shows and hides the formatting toolbar`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/editor/Editor.module.css`:

```diff
--- a/apps/desktop/src/features/editor/Editor.module.css
+++ b/apps/desktop/src/features/editor/Editor.module.css
@@ -44,3 +44,70 @@
   overflow: auto;
   padding: 20px 28px;
 }
+
+/* Editor frame: optional toolbar above the editor (M2b §6). */
+.frame {
+  flex: 1;
+  min-height: 0;
+  display: flex;
+  flex-direction: column;
+}
+
+.toolbar {
+  display: flex;
+  flex-wrap: wrap;
+  align-items: center;
+  gap: 2px;
+  padding: 4px 12px;
+  border-bottom: 1px solid var(--color-border);
+  background: var(--color-surface);
+}
+
+.tool,
+.toolSelect {
+  min-width: 30px;
+  height: 30px;
+  display: inline-grid;
+  place-items: center;
+  padding: 0 6px;
+  border: 0;
+  border-radius: var(--radius-sm);
+  background: transparent;
+  color: var(--color-text-body);
+  font: 500 14px var(--font-body);
+  cursor: pointer;
+}
+
+.tool:hover,
+.toolSelect:hover {
+  background: var(--color-surface-subtle);
+}
+
+.tool[aria-pressed='true'] {
+  background: var(--color-accent-soft);
+  color: var(--color-accent);
+}
+
+.tool:focus-visible,
+.toolSelect:focus-visible {
+  outline: 2px solid var(--color-focus);
+  outline-offset: -2px;
+}
+
+.toolSelect {
+  font-size: 13px;
+  padding-right: 4px;
+}
+
+.toolSep {
+  width: 1px;
+  height: 18px;
+  margin: 0 4px;
+  background: var(--color-border);
+}
+
+.toolMark {
+  background: var(--color-highlight-bg);
+  border-radius: 3px;
+  padding: 0 3px;
+}
```

Modify `apps/desktop/src/features/editor/Editor.tsx`:

```diff
--- a/apps/desktop/src/features/editor/Editor.tsx
+++ b/apps/desktop/src/features/editor/Editor.tsx
@@ -1,6 +1,6 @@
 import { history, historyKeymap } from '@codemirror/commands';
 import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
-import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
+import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
 import { Compartment, EditorState, Facet, Transaction, type Extension } from '@codemirror/state';
 import { drawSelection, EditorView, keymap } from '@codemirror/view';
 import { tags } from '@lezer/highlight';
@@ -8,12 +8,14 @@ import { diffIndices } from 'node-diff3';
 import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
 import { useTranslation } from 'react-i18next';
 import type { EditorMode } from '../../ipc';
+import { useSettingsStore } from '../../stores/settingsStore';
 import { Preview } from '../preview/Preview';
 import styles from './Editor.module.css';
 import { followLinkAtCursor, livePreview, pagePath } from './livePreview';
-import { editorKeymap } from './format';
+import { activeFormats, editorKeymap, type ActiveFormat } from './format';
 import type { PageDoc } from './pageDoc';
 import { blockForOffset, offsetAtTop, topIn } from './scrollSync';
+import { Toolbar } from './Toolbar';
 import { toggleTaskIn } from './widgets';
 
 /** Each page keeps its CodeMirror state (text, selection, undo) while the app
@@ -26,6 +28,8 @@ const pageDocOf = Facet.define<PageDoc, PageDoc | null>({
 });
 /** The Split pane of the component currently showing each view. */
 const paneOf = new WeakMap<EditorView, (text: string) => void>();
+/** The toolbar's pressed state of the component currently showing each view. */
+const toolbarOf = new WeakMap<EditorView, (state: EditorState) => void>();
 const modeSlot = new Compartment();
 const labelSlot = new Compartment();
 
@@ -184,6 +188,9 @@ function createState(d: PageDoc, mode: EditorMode, label: string): EditorState {
         },
       }),
       EditorView.updateListener.of((u) => {
+        if (u.docChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) {
+          toolbarOf.get(u.view)?.(u.state);
+        }
         if (!u.docChanged) return;
         const next = u.state.doc.toString();
         u.state.facet(pageDocOf)?.edit(next);
@@ -210,6 +217,13 @@ export function Editor({ doc, mode, label }: EditorProps) {
   const split = mode === 'split';
   // The text for the Split pane (cheap to track: the pane renders only in Split).
   const [text, setText] = useState(doc.text);
+  const showToolbar = useSettingsStore((s) => s.settings.toolbar);
+  const [toolbarView, setToolbarView] = useState<EditorView | null>(null);
+  const [active, setActive] = useState<Set<ActiveFormat>>(() => new Set());
+  const showFormats = useCallback((state: EditorState) => {
+    const next = activeFormats(state);
+    setActive((prev) => ([...prev].sort().join() === [...next].sort().join() ? prev : next));
+  }, []);
 
   const stateFor = (d: PageDoc): EditorState => states.get(d) ?? createState(d, mode, label);
 
@@ -218,10 +232,14 @@ export function Editor({ doc, mode, label }: EditorProps) {
     const v = new EditorView({ parent: host.current!, state: stateFor(current.current) });
     view.current = v;
     paneOf.set(v, setText);
+    toolbarOf.set(v, showFormats);
+    setToolbarView(v);
+    showFormats(v.state);
     return () => {
       states.set(current.current, v.state);
       current.current.sink = null;
       paneOf.delete(v);
+      toolbarOf.delete(v);
       v.destroy();
       view.current = null;
     };
@@ -235,6 +253,7 @@ export function Editor({ doc, mode, label }: EditorProps) {
       current.current.sink = null;
       current.current = doc;
       v.setState(stateFor(doc));
+      showFormats(v.state);
     }
     doc.sink = (next) => applyExternal(v, next);
     // Changed while it was in the background (reload or merge without a view).
@@ -292,13 +311,16 @@ export function Editor({ doc, mode, label }: EditorProps) {
   }, []);
 
   return (
-    <div className={split ? styles.split : styles.single}>
-      <div ref={host} className={mode === 'livePreview' ? styles.live : styles.source} />
-      {split && (
-        <div ref={pane} className={styles.pane} role="region" aria-label={t('editor.preview')}>
-          <Preview text={text} path={doc.path} onToggleTask={toggleTask} />
-        </div>
-      )}
+    <div className={styles.frame}>
+      {showToolbar && toolbarView && <Toolbar view={toolbarView} active={active} />}
+      <div className={split ? styles.split : styles.single}>
+        <div ref={host} className={mode === 'livePreview' ? styles.live : styles.source} />
+        {split && (
+          <div ref={pane} className={styles.pane} role="region" aria-label={t('editor.preview')}>
+            <Preview text={text} path={doc.path} onToggleTask={toggleTask} />
+          </div>
+        )}
+      </div>
     </div>
   );
 }
```

Create `apps/desktop/src/features/editor/Toolbar.tsx`:

```tsx
import type { StateCommand } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './Editor.module.css';
import {
  insertDivider,
  insertLink,
  setHeading,
  toggleBlock,
  toggleInline,
  type ActiveFormat,
} from './format';

interface Item {
  id: string;
  run: StateCommand;
  /** Pressed when the cursor is inside this format. */
  pressed?: ActiveFormat;
  icon: ReactNode;
}

const svg = (d: string) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const INLINE: Item[] = [
  { id: 'bold', run: toggleInline('bold'), pressed: 'bold', icon: <b>B</b> },
  { id: 'italic', run: toggleInline('italic'), pressed: 'italic', icon: <i>I</i> },
  { id: 'strike', run: toggleInline('strike'), pressed: 'strike', icon: <s>S</s> },
  {
    id: 'highlight',
    run: toggleInline('highlight'),
    pressed: 'highlight',
    icon: <span className={styles.toolMark}>H</span>,
  },
  {
    id: 'code',
    run: toggleInline('code'),
    pressed: 'code',
    icon: svg('M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4'),
  },
  {
    id: 'link',
    run: insertLink,
    icon: svg('M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1'),
  },
];
const BLOCK: Item[] = [
  {
    id: 'bullet',
    run: toggleBlock('bullet'),
    pressed: 'bullet',
    icon: svg('M3 4h.01M3 8h.01M3 12h.01M6 4h7M6 8h7M6 12h7'),
  },
  {
    id: 'numbered',
    run: toggleBlock('numbered'),
    pressed: 'numbered',
    icon: svg('M2.5 3.5h1v3M2.5 9.5h2l-2 2.5h2M6.5 4.5h7M6.5 11h7'),
  },
  {
    id: 'task',
    run: toggleBlock('task'),
    pressed: 'task',
    icon: svg('M2.5 3.5h4v4h-4zM3.5 5.5l1 1 1.5-2M9 5.5h4.5M2.5 10.5h4v3h-4zM9 12h4.5'),
  },
  {
    id: 'quote',
    run: toggleBlock('quote'),
    pressed: 'quote',
    icon: svg('M3 3.5v9M6 5h7M6 8h7M6 11h5'),
  },
  { id: 'divider', run: insertDivider, icon: svg('M2 8h12') },
];
const LEVELS = [0, 1, 2, 3, 4, 5, 6] as const;

/** The formatting toolbar (M2b §6): an ARIA toolbar with one Tab stop (arrow
 *  keys, Home and End move between controls); buttons show `aria-pressed`
 *  for the formats at the cursor and keep the editor's selection. */
export function Toolbar({ view, active }: { view: EditorView; active: Set<ActiveFormat> }) {
  const { t } = useTranslation();
  const bar = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const level = LEVELS.find((n) => n > 0 && active.has(`h${n}` as ActiveFormat)) ?? 0;

  const run = (cmd: StateCommand) => {
    cmd({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    view.focus();
  };
  const controls = () => [...(bar.current?.querySelectorAll<HTMLElement>('[data-tool]') ?? [])];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = controls();
    const at = all.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    const next =
      e.key === 'ArrowRight'
        ? (at + 1) % all.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + all.length) % all.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? all.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    setFocusIndex(next);
    all[next].focus();
  };
  let index = 0;
  const tab = () => (index++ === focusIndex ? 0 : -1);
  const button = (item: Item) => {
    const i = index;
    return (
      <button
        key={item.id}
        type="button"
        data-tool
        className={styles.tool}
        tabIndex={tab()}
        aria-label={t(`toolbar.${item.id}`)}
        title={t(`toolbar.${item.id}`)}
        aria-pressed={item.pressed ? active.has(item.pressed) : undefined}
        // Keep the editor's selection: the click runs on it.
        onMouseDown={(e) => e.preventDefault()}
        onFocus={() => setFocusIndex(i)}
        onClick={() => run(item.run)}
      >
        {item.icon}
      </button>
    );
  };

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={t('toolbar.label')}
      className={styles.toolbar}
      onKeyDown={onKeyDown}
    >
      {INLINE.map(button)}
      <span className={styles.toolSep} aria-hidden="true" />
      {(() => {
        const i = index;
        return (
          <select
            data-tool
            className={styles.toolSelect}
            tabIndex={tab()}
            aria-label={t('toolbar.heading')}
            value={level}
            onFocus={() => setFocusIndex(i)}
            onChange={(e) => run(setHeading(Number(e.target.value) as (typeof LEVELS)[number]))}
          >
            {LEVELS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t('toolbar.paragraph') : t('toolbar.headingN', { n })}
              </option>
            ))}
          </select>
        );
      })()}
      <span className={styles.toolSep} aria-hidden="true" />
      {BLOCK.map(button)}
    </div>
  );
}
```

Modify `apps/desktop/src/features/page/PageHeader.tsx`:

```diff
--- a/apps/desktop/src/features/page/PageHeader.tsx
+++ b/apps/desktop/src/features/page/PageHeader.tsx
@@ -2,6 +2,7 @@ import { useEffect, useState } from 'react';
 import { useTranslation } from 'react-i18next';
 import { assetUrl, linksResolve, type EditorMode, type Page } from '../../ipc';
 import { useEditorStore } from '../../stores/editorStore';
+import { useSettingsStore } from '../../stores/settingsStore';
 import { Breadcrumb } from './Breadcrumb';
 import { ModeToggle } from './ModeToggle';
 import styles from './PageView.module.css';
@@ -30,6 +31,7 @@ export function PageHeader({ page, mode }: { page: Page; mode: EditorMode }) {
   const status = useEditorStore((s) => s.status);
   const hasDoc = useEditorStore((s) => s.doc !== null);
   const large = useEditorStore((s) => s.large);
+  const toolbar = useSettingsStore((s) => s.settings.toolbar);
   const cover = useCover(page);
   return (
     <header className={styles.header}>
@@ -41,6 +43,18 @@ export function PageHeader({ page, mode }: { page: Page; mode: EditorMode }) {
               {t(`editor.${status}`)}
             </span>
           )}
+          {hasDoc && (
+            <button
+              type="button"
+              className={styles.toolbarToggle}
+              aria-pressed={toolbar}
+              title={t('toolbar.toggle')}
+              onClick={() => void useSettingsStore.getState().update({ toolbar: !toolbar })}
+            >
+              <span aria-hidden="true">Aa</span>
+              <span className={styles.srOnly}>{t('toolbar.toggle')}</span>
+            </button>
+          )}
           <ModeToggle mode={mode} />
         </div>
       </div>
```

Modify `apps/desktop/src/features/page/PageView.module.css`:

```diff
--- a/apps/desktop/src/features/page/PageView.module.css
+++ b/apps/desktop/src/features/page/PageView.module.css
@@ -209,3 +209,27 @@
   padding: 8px 14px;
   cursor: pointer;
 }
+
+/* Shows/hides the formatting toolbar (M2b §6). */
+.toolbarToggle {
+  height: 28px;
+  min-width: 34px;
+  padding: 0 8px;
+  border: 1px solid var(--color-border);
+  border-radius: var(--radius-sm);
+  background: var(--color-surface);
+  color: var(--color-text-muted);
+  font: 600 13px var(--font-body);
+  cursor: pointer;
+}
+
+.toolbarToggle[aria-pressed='true'] {
+  background: var(--color-accent-soft);
+  color: var(--color-accent);
+  border-color: transparent;
+}
+
+.toolbarToggle:focus-visible {
+  outline: 2px solid var(--color-focus);
+  outline-offset: 2px;
+}
```

Modify `apps/desktop/src/i18n/locales/en.json`:

```diff
--- a/apps/desktop/src/i18n/locales/en.json
+++ b/apps/desktop/src/i18n/locales/en.json
@@ -199,5 +199,23 @@
     "fontSize": "Text size",
     "fontSizePx": "{px} px",
     "toolbar": "Show the formatting toolbar"
+  },
+  "toolbar": {
+    "label": "Formatting",
+    "bold": "Bold",
+    "italic": "Italic",
+    "strike": "Strikethrough",
+    "highlight": "Highlight",
+    "code": "Inline code",
+    "link": "Link",
+    "heading": "Text style",
+    "paragraph": "Paragraph",
+    "headingN": "Heading {n}",
+    "bullet": "Bulleted list",
+    "numbered": "Numbered list",
+    "task": "Task list",
+    "quote": "Quote",
+    "divider": "Divider",
+    "toggle": "Formatting toolbar"
   }
 }
```

Modify `apps/desktop/src/i18n/locales/es.json`:

```diff
--- a/apps/desktop/src/i18n/locales/es.json
+++ b/apps/desktop/src/i18n/locales/es.json
@@ -199,5 +199,23 @@
     "fontSize": "Tamaño del texto",
     "fontSizePx": "{px} px",
     "toolbar": "Mostrar la barra de formato"
+  },
+  "toolbar": {
+    "label": "Formato",
+    "bold": "Negrita",
+    "italic": "Cursiva",
+    "strike": "Tachado",
+    "highlight": "Resaltado",
+    "code": "Código en línea",
+    "link": "Enlace",
+    "heading": "Estilo de texto",
+    "paragraph": "Párrafo",
+    "headingN": "Título {n}",
+    "bullet": "Lista con viñetas",
+    "numbered": "Lista numerada",
+    "task": "Lista de tareas",
+    "quote": "Cita",
+    "divider": "Separador",
+    "toggle": "Barra de formato"
   }
 }
```

- [ ] **Step 4: Run the task's tests**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/features/editor src/features/page`
Expected: PASS (Toolbar 4, PageView 11, rest unchanged).

- [ ] **Step 5: Run the gate**

Run (repo root, each must exit 0): `set -o pipefail; pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2`
Expected: all clean (vitest 402).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(editor): formatting toolbar — ARIA toolbar with pressed states, heading menu, header toggle (M2b §6)" -m "Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 7: Link trail — back arrow, ⌘[ / ⌘], View → Back / Forward

Spec §3. `openPage(path, heading, via)`: `link` pushes the page you were on (with its heading), `direct` starts a fresh trail, `trail` (back/forward) changes nothing else. Link callers pass `link`; the explorer resets; vault open/close resets; renames and removals (own and external) rewrite the trail. ⌘[ / ⌘] are app-level keys (they bubble from the editor, which no longer binds them); the macOS View menu gets Back / Forward items (no accelerators) that emit `menu:navigate`.

**Files:**
- Modify: `apps/desktop/src-tauri/src/menu.rs`
- Test (modify): `apps/desktop/src-tauri/tests/menu.rs`
- Modify: `apps/desktop/src/features/dialogs/LinkDialogs.tsx`
- Modify: `apps/desktop/src/features/explorer/ExplorerTree.tsx`
- Modify: `apps/desktop/src/features/page/PageHeader.tsx`
- Modify: `apps/desktop/src/features/page/PageView.module.css`
- Test (modify): `apps/desktop/src/features/page/PageView.test.tsx`
- Modify: `apps/desktop/src/features/preview/Preview.tsx`
- Test (modify): `apps/desktop/src/features/shell/Interactions.test.tsx`
- Modify: `apps/desktop/src/features/shell/useGlobalShortcuts.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/ipc/index.ts`
- Modify: `apps/desktop/src/main.tsx`
- Modify: `apps/desktop/src/stores/links.ts`
- Test (create): `apps/desktop/src/stores/navigate.test.ts`
- Modify: `apps/desktop/src/stores/navigate.ts`
- Test (modify): `apps/desktop/src/stores/stores.test.ts`
- Test (create): `apps/desktop/src/stores/trailStore.test.ts`
- Create: `apps/desktop/src/stores/trailStore.ts`
- Modify: `apps/desktop/src/stores/vaultStore.ts`

**Interfaces:**
- Consumes: `openPage`, `openNewPage` (M2a `navigate.ts`), `followLink` (`links.ts`), `vaultStore` rename/trash/change handling, `useGlobalShortcuts`, `menu.rs`.
- Produces: `stores/trailStore.ts`: `TrailEntry`, `useTrailStore` (`back`, `forward`, `followed`, `goBack`, `goForward`, `reset`, `renamed`, `removed`). `navigate.ts`: `Via`, `openPage(path, heading?, via?)`, `openNewPage(path, via?)`, `goBack()`, `goForward()`, `installMenuNavigation()`, `installMenuNavigationIfTauri()`. `ipc`: `onMenuNavigate(cb)`. Rust `menu::{BACK_ID, FORWARD_ID, NAVIGATE_EVENT}`. Strings `trail.back`.

- [ ] **Step 1: Write the failing tests**

Modify `apps/desktop/src-tauri/tests/menu.rs`:

```diff
--- a/apps/desktop/src-tauri/tests/menu.rs
+++ b/apps/desktop/src-tauri/tests/menu.rs
@@ -110,6 +110,12 @@ fn macos_menu_quit_is_ours_and_the_standard_items_stay() {
         texts("Edit"),
         ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"]
     );
+    // M2b §3: Back / Forward along the link trail (⌘[ / ⌘] are handled by the
+    // page itself, so the items carry no accelerator).
+    let view = texts("View");
+    for want in ["Back", "Forward"] {
+        assert!(view.iter().any(|t| t == want), "{want}: {view:?}");
+    }
     let window = texts("Window");
     for want in ["Minimize", "Zoom", "Close Window"] {
         assert!(window.iter().any(|t| t == want), "{want}: {window:?}");
@@ -160,6 +166,36 @@ fn quit_menu_item_requests_the_window_close_like_the_close_button() {
     );
 }
 
+/// M2b §3: View → Back / Forward tell the page to walk the link trail.
+fn back_and_forward_items_emit_menu_navigate() {
+    use tauri::Listener;
+    let got: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
+    let log = got.clone();
+    build_app("navigate").run_return(move |handle, event| {
+        if let RunEvent::Ready = event {
+            let log = log.clone();
+            handle.listen("menu:navigate", move |e| {
+                log.lock().unwrap().push(e.payload().to_string());
+            });
+            for id in [liber_desktop::menu::BACK_ID, liber_desktop::menu::FORWARD_ID] {
+                liber_desktop::menu::on_menu_event(
+                    handle,
+                    MenuEvent {
+                        id: MenuId::new(id),
+                    },
+                );
+            }
+            for window in handle.webview_windows().into_values() {
+                window.close().unwrap();
+            }
+        }
+    });
+    assert_eq!(
+        *got.lock().unwrap(),
+        ["\"back\"".to_string(), "\"forward\"".into()]
+    );
+}
+
 fn main() {
     #[cfg(target_os = "macos")]
     {
@@ -168,4 +204,6 @@ fn main() {
     }
     quit_menu_item_requests_the_window_close_like_the_close_button();
     println!("test quit_menu_item_requests_the_window_close_like_the_close_button ... ok");
+    back_and_forward_items_emit_menu_navigate();
+    println!("test back_and_forward_items_emit_menu_navigate ... ok");
 }
```

Modify `apps/desktop/src/features/page/PageView.test.tsx`:

```diff
--- a/apps/desktop/src/features/page/PageView.test.tsx
+++ b/apps/desktop/src/features/page/PageView.test.tsx
@@ -11,6 +11,7 @@ import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
 import { fakeDisk } from '../../test/fakeDisk';
 import { AUTOSAVE_MS } from '../editor/pageDoc';
 import { LARGE_NOTE_CHARS } from '../editor/livePreview';
+import { openPage } from '../../stores/navigate';
 import { PageView } from './PageView';
 
 const open = (path: string) => act(() => usePageStore.getState().load(path));
@@ -85,6 +86,18 @@ describe('PageView (M2a §5)', () => {
     expect(screen.getByRole('region', { name: 'Preview' })).toHaveTextContent('body');
   });
 
+  it('M2b §3: the back arrow appears after following a link and goes back', async () => {
+    fakeDisk({ 'A.md': '# A\n\n[[B]]\n', 'B.md': '# B\n' });
+    render(<PageView />);
+    await open('A.md');
+    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument();
+    await act(() => openPage('B.md', null, 'link'));
+    const back = await screen.findByRole('button', { name: 'Back to A' });
+    await userEvent.click(back);
+    await waitFor(() => expect(usePageStore.getState().path).toBe('A.md'));
+    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument();
+  });
+
   it('M2b §6: the header button shows and hides the formatting toolbar', async () => {
     const disk = fakeDisk({ 'A.md': '# A\n\nbody\n' });
     render(<PageView />);
```

Modify `apps/desktop/src/features/shell/Interactions.test.tsx`:

```diff
--- a/apps/desktop/src/features/shell/Interactions.test.tsx
+++ b/apps/desktop/src/features/shell/Interactions.test.tsx
@@ -8,6 +8,7 @@ import { usePageStore } from '../../stores/pageStore';
 import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
 import { useToastStore } from '../../stores/toastStore';
 import { childrenByParent } from '../../stores/tree';
+import { openPage } from '../../stores/navigate';
 import { useUiStore } from '../../stores/uiStore';
 import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
 import { dropEntry } from '../explorer/drop';
@@ -258,6 +259,66 @@ describe('global shortcuts (spec §3.5)', () => {
   });
 });
 
+describe('link trail keys (M2b §3)', () => {
+  it('⌘[ goes back and ⌘] forward along followed links', async () => {
+    backend({
+      page_get: (a) => ({
+        path: a.path,
+        title: String(a.path).replace(/\.md$/, ''),
+        subtitle: null,
+        cover: null,
+        tags: [],
+        links: 0,
+        backlinks: 0,
+        text: '',
+        truncated: false,
+        binary: false,
+      }),
+      page_read: () => ({ text: '', hash: 'h' }),
+    });
+    seed();
+    render(<AppShell />);
+    await act(() => openPage('Welcome.md'));
+    await act(() => openPage('Art/rex.md', null, 'link'));
+    document.body.focus();
+    await userEvent.keyboard('{Meta>}[[{/Meta}');
+    await waitFor(() => expect(usePageStore.getState().path).toBe('Welcome.md'));
+    await userEvent.keyboard('{Control>}]{/Control}');
+    await waitFor(() => expect(usePageStore.getState().path).toBe('Art/rex.md'));
+  });
+
+  it('review focus: ⌘[ typed in the editor goes back instead of indenting', async () => {
+    backend({
+      page_get: (a) => ({
+        path: a.path,
+        title: String(a.path).replace(/\.md$/, ''),
+        subtitle: null,
+        cover: null,
+        tags: [],
+        links: 0,
+        backlinks: 0,
+        text: '- item\n',
+        truncated: false,
+        binary: false,
+      }),
+      page_read: () => ({ text: '- item\n', hash: 'h' }),
+    });
+    seed();
+    render(<AppShell />);
+    await act(() => openPage('Welcome.md'));
+    await act(() => openPage('Art/rex.md', null, 'link'));
+    const content = await waitFor(() => {
+      const el = document.querySelector<HTMLElement>('.cm-content');
+      expect(el).not.toBeNull();
+      return el!;
+    });
+    content.focus();
+    await userEvent.keyboard('{Meta>}[[{/Meta}');
+    await waitFor(() => expect(usePageStore.getState().path).toBe('Welcome.md'));
+    expect(content.textContent).toBe('- item');
+  });
+});
+
 describe('keyboard focus is never lost (final review I1, NFR-10)', () => {
   const tabStops = () => screen.getAllByRole('treeitem').filter((el) => el.tabIndex === 0);
 
```

Create `apps/desktop/src/stores/navigate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, emit, mockIPC } from '../ipc/testing';
import { followLink } from './links';
import { goBack, goForward, installMenuNavigation, openPage } from './navigate';
import { usePageStore } from './pageStore';
import { useTrailStore } from './trailStore';
import { resetVaultStore } from './vaultStore';

const page = (path: string) => ({
  path,
  title: path.replace(/\.md$/, ''),
  subtitle: null,
  cover: null,
  tags: [],
  links: 0,
  backlinks: 0,
  text: '',
  truncated: false,
  binary: false,
});

beforeEach(() => {
  useTrailStore.getState().reset();
  mockIPC(
    (cmd, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      if (cmd === 'page_get') return page(args.path as string);
      if (cmd === 'page_read') return { text: '', hash: 'h' };
      return null;
    },
    { shouldMockEvents: true },
  );
});
afterEach(async () => {
  usePageStore.getState().clear();
  await resetVaultStore();
  clearMocks();
});

const at = () => usePageStore.getState().path;

describe('navigation and the link trail (M2b §3)', () => {
  it('links add to the trail; direct opens start a fresh one; back/forward walk it', async () => {
    await openPage('A.md');
    await openPage('B.md', null, 'link');
    await openPage('C.md', 'Part', 'link');
    expect(useTrailStore.getState().back.map((x) => x.path)).toEqual(['A.md', 'B.md']);
    await goBack();
    expect(at()).toBe('B.md');
    await goBack();
    expect(at()).toBe('A.md');
    expect(await goBack()).toBe(false);
    await goForward();
    await goForward();
    expect(at()).toBe('C.md');
    expect(usePageStore.getState().anchor?.heading).toBe('Part');
    await openPage('D.md');
    expect(useTrailStore.getState().back).toEqual([]);
  });

  it('a link to the page you are on does not grow the trail', async () => {
    await openPage('A.md');
    await openPage('A.md', 'Heading', 'link');
    expect(useTrailStore.getState().back).toEqual([]);
  });

  it('followLink is a link navigation', async () => {
    await openPage('A.md');
    followLink({
      type: 'page',
      kind: 'wiki',
      target: 'B',
      heading: null,
      resolved: 'B.md',
      source: 'A.md',
    });
    await vi.waitFor(() => expect(at()).toBe('B.md'));
    expect(useTrailStore.getState().back.map((x) => x.path)).toEqual(['A.md']);
  });

  it('View → Back / Forward in the app menu walk the trail (menu:navigate)', async () => {
    const stop = await installMenuNavigation();
    await openPage('A.md');
    await openPage('B.md', null, 'link');
    await emit('menu:navigate', 'back');
    await vi.waitFor(() => expect(at()).toBe('A.md'));
    await emit('menu:navigate', 'forward');
    await vi.waitFor(() => expect(at()).toBe('B.md'));
    stop();
  });
});
```

Modify `apps/desktop/src/stores/stores.test.ts`:

```diff
--- a/apps/desktop/src/stores/stores.test.ts
+++ b/apps/desktop/src/stores/stores.test.ts
@@ -4,6 +4,7 @@ import type { TreeNode } from '../ipc';
 import { clearMocks, emit, mockIPC } from '../ipc/testing';
 import { usePageStore } from './pageStore';
 import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';
+import { useTrailStore } from './trailStore';
 import { useToastStore } from './toastStore';
 import { resetVaultStore, useVaultStore } from './vaultStore';
 
@@ -117,6 +118,24 @@ describe('settingsStore', () => {
 });
 
 describe('vaultStore', () => {
+  it('M2b §3: renames and trashing in the app update the link trail; a new vault clears it', async () => {
+    backend({
+      entry_rename: () => ({ moved: [], updatedFiles: [], updatedLinks: 0, failed: [] }),
+      entry_trash: () => null,
+      vault_tree: () => [],
+      vault_open: () => ({ name: 'V', root: '/v', report: { warnings: [] } }),
+    });
+    const trail = useTrailStore.getState();
+    trail.followed({ path: 'Notes/A.md', heading: null });
+    trail.followed({ path: 'B.md', heading: null });
+    await useVaultStore.getState().rename('Notes', 'Archive');
+    expect(useTrailStore.getState().back.map((x) => x.path)).toEqual(['Archive/A.md', 'B.md']);
+    await useVaultStore.getState().trash('B.md');
+    expect(useTrailStore.getState().back.map((x) => x.path)).toEqual(['Archive/A.md']);
+    await useVaultStore.getState().open('/v');
+    expect(useTrailStore.getState().back).toEqual([]);
+  });
+
   it('VLT-01 open: closed → opening → open, with tree loaded', async () => {
     const gate = deferred<typeof info>();
     backend({ vault_open: () => gate.promise, vault_tree: () => tree });
```

Create `apps/desktop/src/stores/trailStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useTrailStore } from './trailStore';

const trail = () => useTrailStore.getState();
const e = (path: string, heading: string | null = null) => ({ path, heading });

beforeEach(() => trail().reset());

describe('link trail (M2b §3)', () => {
  it('following links builds the trail; back and forward walk it', () => {
    trail().followed(e('A.md'));
    trail().followed(e('B.md'));
    expect(trail().back).toEqual([e('A.md'), e('B.md')]);
    expect(trail().goBack(e('C.md'))).toEqual(e('B.md'));
    expect(trail().forward).toEqual([e('C.md')]);
    expect(trail().goBack(e('B.md'))).toEqual(e('A.md'));
    expect(trail().goBack(e('A.md'))).toBeNull();
    expect(trail().goForward(e('A.md'))).toEqual(e('B.md'));
    expect(trail().goForward(e('B.md'))).toEqual(e('C.md'));
    expect(trail().goForward(e('C.md'))).toBeNull();
  });

  it('a new link after going back drops the forward branch', () => {
    trail().followed(e('A.md'));
    trail().goBack(e('B.md'));
    trail().followed(e('A.md'));
    expect(trail().forward).toEqual([]);
  });

  it('reset clears both directions', () => {
    trail().followed(e('A.md'));
    trail().goBack(e('B.md'));
    trail().reset();
    expect(trail().back).toEqual([]);
    expect(trail().forward).toEqual([]);
  });

  it('renames (files and folders) are followed', () => {
    trail().followed(e('Notes/A.md', 'Intro'));
    trail().followed(e('B.md'));
    trail().renamed('Notes', 'Archive');
    trail().renamed('B.md', 'Bee.md');
    expect(trail().back).toEqual([e('Archive/A.md', 'Intro'), e('Bee.md')]);
  });

  it('deleted pages leave the trail, without two equal pages next to each other', () => {
    trail().followed(e('A.md'));
    trail().followed(e('B.md'));
    trail().followed(e('A.md'));
    trail().goBack(e('C.md'));
    trail().removed('B.md');
    expect(trail().back).toEqual([e('A.md')]);
    trail().removed('C.md');
    expect(trail().forward).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/stores src/features/page src/features/shell/Interactions.test.tsx; cargo test -p liber-desktop --test menu`
Expected: FAIL — `Failed to resolve import "./trailStore"`; once the store exists: `× followLink is a link navigation`, `× M2b §3: renames and trashing in the app update the link trail; a new vault clears it`, `× M2b §3: the back arrow appears after following a link and goes back`, `× ⌘[ goes back and ⌘] forward along followed links` (`expected 'Art/rex.md' to be 'Welcome.md'`), `TypeError: installMenuNavigation is not a function`; Rust: `cannot find value BACK_ID in module liber_desktop::menu`. ("review focus: ⌘[ typed in the editor…" is a guard over Task 5 + this task and passes once both exist.) Note: in `userEvent.keyboard`, `[` must be written `[[`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src-tauri/src/menu.rs`:

```diff
--- a/apps/desktop/src-tauri/src/menu.rs
+++ b/apps/desktop/src-tauri/src/menu.rs
@@ -15,15 +15,22 @@
 //! already granted (`core:window:allow-destroy`).
 
 use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
-use tauri::{AppHandle, Manager, Runtime};
+use tauri::{AppHandle, Emitter, Manager, Runtime};
 
 /// Id of our Quit item.
 pub const QUIT_ID: &str = "liber-quit";
+/// Ids of View → Back / Forward (M2b §3 link trail).
+pub const BACK_ID: &str = "liber-back";
+pub const FORWARD_ID: &str = "liber-forward";
+/// Event telling the page to walk the link trail; payload `"back"` or
+/// `"forward"`.
+pub const NAVIGATE_EVENT: &str = "menu:navigate";
 
 /// The app menu: About, Services, Hide, Hide Others, Show All, Quit (ours);
 /// Edit (Undo, Redo, Cut, Copy, Paste, Select All: macOS routes the text
-/// editing shortcuts through it); View (full screen); Window (Minimize, Zoom,
-/// Close Window).
+/// editing shortcuts through it); View (Back, Forward along the link trail —
+/// no accelerators: the page handles ⌘[ / ⌘] itself, which also works where
+/// there is no app menu; full screen); Window (Minimize, Zoom, Close Window).
 pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
     let pkg = app.package_info();
     let config = app.config();
@@ -72,11 +79,18 @@ pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
             &PredefinedMenuItem::select_all(app, None)?,
         ],
     )?;
+    let back = MenuItem::with_id(app, BACK_ID, "Back", true, None::<&str>)?;
+    let forward = MenuItem::with_id(app, FORWARD_ID, "Forward", true, None::<&str>)?;
     let view = Submenu::with_items(
         app,
         "View",
         true,
-        &[&PredefinedMenuItem::fullscreen(app, None)?],
+        &[
+            &back,
+            &forward,
+            &PredefinedMenuItem::separator(app)?,
+            &PredefinedMenuItem::fullscreen(app, None)?,
+        ],
     )?;
     let window = Submenu::with_items(
         app,
@@ -103,8 +117,12 @@ pub fn with_app_menu<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R
 
 /// Menu events (registered by `configure`).
 pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
-    if event.id() == QUIT_ID {
+    let id = event.id().0.as_str();
+    if id == QUIT_ID {
         request_quit(app);
+    } else if id == BACK_ID || id == FORWARD_ID {
+        let direction = if id == BACK_ID { "back" } else { "forward" };
+        let _ = app.emit(NAVIGATE_EVENT, direction);
     }
 }
 
```

Modify `apps/desktop/src/features/dialogs/LinkDialogs.tsx`:

```diff
--- a/apps/desktop/src/features/dialogs/LinkDialogs.tsx
+++ b/apps/desktop/src/features/dialogs/LinkDialogs.tsx
@@ -97,7 +97,7 @@ export function CreatePageDialog({
         const res = await entryCreatePage(dir, name);
         report(res);
         if (!res.ok) return;
-        await openNewPage(res.value);
+        await openNewPage(res.value, 'link');
       }}
       onClose={onClose}
     />
```

Modify `apps/desktop/src/features/explorer/ExplorerTree.tsx`:

```diff
--- a/apps/desktop/src/features/explorer/ExplorerTree.tsx
+++ b/apps/desktop/src/features/explorer/ExplorerTree.tsx
@@ -2,6 +2,7 @@ import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
 import { useTranslation } from 'react-i18next';
 import type { TreeNode } from '../../ipc';
 import { usePageStore } from '../../stores/pageStore';
+import { useTrailStore } from '../../stores/trailStore';
 import { joinPath, parentOf, remap } from '../../stores/tree';
 import { useVaultStore } from '../../stores/vaultStore';
 import styles from './Explorer.module.css';
@@ -96,7 +97,11 @@ export function ExplorerTree({
     vault.select(node.path);
     setFocused(node.path);
     if (node.kind === 'folder') vault.toggle(node.path);
-    else if (node.kind === 'page') void usePageStore.getState().load(node.path);
+    else if (node.kind === 'page') {
+      // Opening from the explorer starts a fresh link trail (M2b §3).
+      useTrailStore.getState().reset();
+      void usePageStore.getState().load(node.path);
+    }
   };
 
   const commitRename = (node: TreeNode, name: string) => {
```

Modify `apps/desktop/src/features/page/PageHeader.tsx`:

```diff
--- a/apps/desktop/src/features/page/PageHeader.tsx
+++ b/apps/desktop/src/features/page/PageHeader.tsx
@@ -2,7 +2,10 @@ import { useEffect, useState } from 'react';
 import { useTranslation } from 'react-i18next';
 import { assetUrl, linksResolve, type EditorMode, type Page } from '../../ipc';
 import { useEditorStore } from '../../stores/editorStore';
+import { goBack } from '../../stores/navigate';
 import { useSettingsStore } from '../../stores/settingsStore';
+import { useTrailStore } from '../../stores/trailStore';
+import { nameOf } from '../../stores/tree';
 import { Breadcrumb } from './Breadcrumb';
 import { ModeToggle } from './ModeToggle';
 import styles from './PageView.module.css';
@@ -32,11 +35,25 @@ export function PageHeader({ page, mode }: { page: Page; mode: EditorMode }) {
   const hasDoc = useEditorStore((s) => s.doc !== null);
   const large = useEditorStore((s) => s.large);
   const toolbar = useSettingsStore((s) => s.settings.toolbar);
+  const previous = useTrailStore((s) => s.back.at(-1) ?? null);
   const cover = useCover(page);
   return (
     <header className={styles.header}>
       <div className={styles.bar}>
-        <Breadcrumb path={page.path} />
+        <div className={styles.where}>
+          {previous && (
+            <button
+              type="button"
+              className={styles.back}
+              aria-label={t('trail.back', { name: nameOf(previous.path).replace(/\.md$/i, '') })}
+              title={t('trail.back', { name: nameOf(previous.path).replace(/\.md$/i, '') })}
+              onClick={() => void goBack()}
+            >
+              <span aria-hidden="true">←</span>
+            </button>
+          )}
+          <Breadcrumb path={page.path} />
+        </div>
         <div className={styles.controls}>
           {hasDoc && (
             <span role="status" aria-label={t('editor.saveStatus')} className={styles.status}>
```

Modify `apps/desktop/src/features/page/PageView.module.css`:

```diff
--- a/apps/desktop/src/features/page/PageView.module.css
+++ b/apps/desktop/src/features/page/PageView.module.css
@@ -233,3 +233,34 @@
   outline: 2px solid var(--color-focus);
   outline-offset: 2px;
 }
+
+/* Back arrow + breadcrumb (M2b §3). */
+.where {
+  display: flex;
+  align-items: center;
+  gap: 8px;
+  min-width: 0;
+}
+
+.back {
+  flex: none;
+  width: 28px;
+  height: 28px;
+  display: inline-grid;
+  place-items: center;
+  border: 1px solid var(--color-border);
+  border-radius: var(--radius-sm);
+  background: var(--color-surface);
+  color: var(--color-accent);
+  font-size: 15px;
+  cursor: pointer;
+}
+
+.back:hover {
+  background: var(--color-accent-soft);
+}
+
+.back:focus-visible {
+  outline: 2px solid var(--color-focus);
+  outline-offset: 2px;
+}
```

Modify `apps/desktop/src/features/preview/Preview.tsx`:

```diff
--- a/apps/desktop/src/features/preview/Preview.tsx
+++ b/apps/desktop/src/features/preview/Preview.tsx
@@ -149,7 +149,7 @@ function NoteEmbed({
         <button
           type="button"
           className={styles.cardButton}
-          onClick={() => void openPage(path, heading)}
+          onClick={() => void openPage(path, heading, 'link')}
         >
           {t('preview.open')}
         </button>
```

Modify `apps/desktop/src/features/shell/useGlobalShortcuts.ts`:

```diff
--- a/apps/desktop/src/features/shell/useGlobalShortcuts.ts
+++ b/apps/desktop/src/features/shell/useGlobalShortcuts.ts
@@ -1,11 +1,13 @@
 import { useEffect } from 'react';
 import { pickFolder } from '../../ipc';
+import { goBack, goForward } from '../../stores/navigate';
 import { dirFor } from '../../stores/tree';
 import { useUiStore } from '../../stores/uiStore';
 import { useVaultStore } from '../../stores/vaultStore';
 
 /** ⌘ (macOS) / Ctrl shortcuts (spec §3.5): ⇧E explorer, O open vault,
- * , settings, N new page, ⇧N new folder. Ignored while a dialog is open. */
+ * , settings, N new page, ⇧N new folder, [ / ] back and forward along the
+ * link trail (M2b §3). Ignored while a dialog is open. */
 export function useGlobalShortcuts(menuOpen: boolean) {
   useEffect(() => {
     const onKeyDown = (e: KeyboardEvent) => {
@@ -22,6 +24,10 @@ export function useGlobalShortcuts(menuOpen: boolean) {
       } else if (key === 'n') {
         const dir = dirFor(vault.nodes, vault.selected);
         void (e.shiftKey ? vault.createFolder(dir) : vault.createPage(dir));
+      } else if (key === '[' && !e.shiftKey) {
+        void goBack();
+      } else if (key === ']' && !e.shiftKey) {
+        void goForward();
       } else if (key === 'e' && e.shiftKey) {
         document
           .querySelector<HTMLElement>('[role="tree"] [role="treeitem"][tabindex="0"]')
```

Modify `apps/desktop/src/i18n/locales/en.json`:

```diff
--- a/apps/desktop/src/i18n/locales/en.json
+++ b/apps/desktop/src/i18n/locales/en.json
@@ -217,5 +217,8 @@
     "quote": "Quote",
     "divider": "Divider",
     "toggle": "Formatting toolbar"
+  },
+  "trail": {
+    "back": "Back to {name}"
   }
 }
```

Modify `apps/desktop/src/i18n/locales/es.json`:

```diff
--- a/apps/desktop/src/i18n/locales/es.json
+++ b/apps/desktop/src/i18n/locales/es.json
@@ -217,5 +217,8 @@
     "quote": "Cita",
     "divider": "Separador",
     "toggle": "Barra de formato"
+  },
+  "trail": {
+    "back": "Volver a {name}"
   }
 }
```

Modify `apps/desktop/src/ipc/index.ts`:

```diff
--- a/apps/desktop/src/ipc/index.ts
+++ b/apps/desktop/src/ipc/index.ts
@@ -265,6 +265,9 @@ export const onVaultProgress = (cb: (p: ProgressPayload) => void): Promise<Unlis
   listen<ProgressPayload>('vault:progress', (e) => cb(e.payload));
 export const onVaultChanged = (cb: (p: ChangedPayload) => void): Promise<UnlistenFn> =>
   listen<ChangedPayload>('vault:changed', (e) => cb(e.payload));
+/** View → Back / Forward in the app menu (M2b §3). */
+export const onMenuNavigate = (cb: (direction: 'back' | 'forward') => void): Promise<UnlistenFn> =>
+  listen<'back' | 'forward'>('menu:navigate', (e) => cb(e.payload));
 export const onVaultWarning = (cb: (p: WarningPayload) => void): Promise<UnlistenFn> =>
   listen<WarningPayload>('vault:warning', (e) => cb(e.payload));
 
```

Modify `apps/desktop/src/main.tsx`:

```diff
--- a/apps/desktop/src/main.tsx
+++ b/apps/desktop/src/main.tsx
@@ -7,6 +7,7 @@ import { createRoot } from 'react-dom/client';
 import { App } from './app/App';
 import { detectLanguage, initI18n } from './i18n';
 import { installQuitGuardIfTauri } from './stores/editorStore';
+import { installMenuNavigationIfTauri } from './stores/navigate';
 import { useSettingsStore } from './stores/settingsStore';
 import { applyTheme } from './theme/theme';
 
@@ -17,6 +18,7 @@ void initI18n(detectLanguage(navigator.languages))
   .then(() => useSettingsStore.getState().load())
   .then(() => {
     installQuitGuardIfTauri();
+    installMenuNavigationIfTauri();
     createRoot(document.getElementById('root')!).render(
       <StrictMode>
         <App />
```

Modify `apps/desktop/src/stores/links.ts`:

```diff
--- a/apps/desktop/src/stores/links.ts
+++ b/apps/desktop/src/stores/links.ts
@@ -38,7 +38,7 @@ export function followLink(action: LinkAction): void {
       if (action.resolved === null) {
         ui.openDialog({ type: 'createPage', source: action.source, target: action.target });
       } else if (isPage(action.resolved)) {
-        void openPage(action.resolved, action.heading);
+        void openPage(action.resolved, action.heading, 'link');
       } else {
         ui.openDialog({ type: 'openFile', path: action.resolved });
       }
```

Modify `apps/desktop/src/stores/navigate.ts`:

```diff
--- a/apps/desktop/src/stores/navigate.ts
+++ b/apps/desktop/src/stores/navigate.ts
@@ -1,17 +1,35 @@
+import { isTauri, onMenuNavigate } from '../ipc';
 import { usePageStore } from './pageStore';
+import { useTrailStore, type TrailEntry } from './trailStore';
 import { parentOf } from './tree';
 import { useVaultStore } from './vaultStore';
 
+/** How a page was reached (M2b §3): following an internal link adds the page
+ *  you were on to the trail; a direct navigation (explorer, toast, ⌘O) starts
+ *  a fresh trail; walking the trail itself changes nothing else. */
+export type Via = 'link' | 'direct' | 'trail';
+
 /** Opens a page the app just created (the watcher doesn't report our own
  *  writes, so the tree is refreshed first). */
-export async function openNewPage(path: string): Promise<void> {
+export async function openNewPage(path: string, via: Via = 'direct'): Promise<void> {
   await useVaultStore.getState().refreshTree();
-  await openPage(path);
+  await openPage(path, null, via);
 }
 
 /** Opens a page from anywhere (links, toasts): reveals and selects it in the
  *  explorer and shows it, scrolled to `heading` if given. */
-export async function openPage(path: string, heading?: string | null): Promise<void> {
+export async function openPage(
+  path: string,
+  heading?: string | null,
+  via: Via = 'direct',
+): Promise<void> {
+  const current = here();
+  const trail = useTrailStore.getState();
+  if (via === 'link') {
+    if (current && current.path !== path) trail.followed(current);
+  } else if (via === 'direct') {
+    trail.reset();
+  }
   const vault = useVaultStore.getState();
   const dir = parentOf(path);
   if (dir) vault.expand(dir);
@@ -19,3 +37,38 @@ export async function openPage(path: string, heading?: string | null): Promise<v
   await usePageStore.getState().load(path);
   usePageStore.getState().reveal(heading ?? null);
 }
+
+/** The page on screen and the heading it was opened at. */
+function here(): TrailEntry | null {
+  const { path, anchor } = usePageStore.getState();
+  return path ? { path, heading: anchor?.heading ?? null } : null;
+}
+
+/** ← / ⌘[: back along the link trail. False when there is nowhere to go. */
+export async function goBack(): Promise<boolean> {
+  const current = here();
+  if (!current) return false;
+  const to = useTrailStore.getState().goBack(current);
+  if (!to) return false;
+  await openPage(to.path, to.heading, 'trail');
+  return true;
+}
+
+/** ⌘]: forward along the link trail (after going back). */
+export async function goForward(): Promise<boolean> {
+  const current = here();
+  if (!current) return false;
+  const to = useTrailStore.getState().goForward(current);
+  if (!to) return false;
+  await openPage(to.path, to.heading, 'trail');
+  return true;
+}
+
+/** Follows View → Back / Forward from the app menu; returns the unsubscribe. */
+export async function installMenuNavigation(): Promise<() => void> {
+  return onMenuNavigate((direction) => void (direction === 'back' ? goBack() : goForward()));
+}
+
+export function installMenuNavigationIfTauri(): void {
+  if (isTauri()) void installMenuNavigation().catch(() => undefined);
+}
```

Create `apps/desktop/src/stores/trailStore.ts`:

```ts
import { create } from 'zustand';
import { remap } from './tree';

/** A page on the trail, with the heading it was opened at. */
export interface TrailEntry {
  path: string;
  heading: string | null;
}

interface TrailState {
  /** Pages before the current one, oldest first. */
  back: TrailEntry[];
  /** Pages after it (after going back), nearest last. */
  forward: TrailEntry[];
  /** A link was followed from `from`: it becomes the way back. */
  followed: (from: TrailEntry) => void;
  /** Leaves `current` for the previous page; `null` when there is none. */
  goBack: (current: TrailEntry) => TrailEntry | null;
  goForward: (current: TrailEntry) => TrailEntry | null;
  /** A direct navigation (explorer, ⌘O, …) starts a fresh trail. */
  reset: () => void;
  renamed: (from: string, to: string) => void;
  removed: (path: string) => void;
}

const same = (a: TrailEntry | undefined, b: TrailEntry) => a?.path === b.path;

/** Drops deleted pages and then repeated neighbours. */
function prune(list: TrailEntry[], gone: string): TrailEntry[] {
  const kept = list.filter((x) => remap(x.path, gone, gone) === null);
  return kept.filter((x, i) => !same(kept[i - 1], x));
}

/** The link trail (M2b §3): only followed internal links add to it; it lives
 *  in memory for the window. */
export const useTrailStore = create<TrailState>((set, get) => ({
  back: [],
  forward: [],
  followed: (from) => set((s) => ({ back: [...s.back, from], forward: [] })),
  goBack: (current) => {
    const { back, forward } = get();
    const to = back.at(-1);
    if (!to) return null;
    set({ back: back.slice(0, -1), forward: [...forward, current] });
    return to;
  },
  goForward: (current) => {
    const { back, forward } = get();
    const to = forward.at(-1);
    if (!to) return null;
    set({ back: [...back, current], forward: forward.slice(0, -1) });
    return to;
  },
  reset: () => set({ back: [], forward: [] }),
  renamed: (from, to) =>
    set((s) => {
      const move = (x: TrailEntry) => ({ ...x, path: remap(x.path, from, to) ?? x.path });
      return { back: s.back.map(move), forward: s.forward.map(move) };
    }),
  removed: (path) => set((s) => ({ back: prune(s.back, path), forward: prune(s.forward, path) })),
}));
```

Modify `apps/desktop/src/stores/vaultStore.ts`:

```diff
--- a/apps/desktop/src/stores/vaultStore.ts
+++ b/apps/desktop/src/stores/vaultStore.ts
@@ -24,6 +24,7 @@ import { useEditorStore, warnUnsaved } from './editorStore';
 import { errorMessage } from './messages';
 import { usePageStore } from './pageStore';
 import { useToastStore } from './toastStore';
+import { useTrailStore } from './trailStore';
 import { childrenByParent, joinPath, nextFreeName, parentOf, remap } from './tree';
 
 /** External changes arriving within this window trigger one tree refresh. */
@@ -110,10 +111,13 @@ export const useVaultStore = create<VaultState>((set, get) => {
     pending = null;
     if (!change) return;
     let { selected, expanded } = get();
+    const trail = useTrailStore.getState();
     for (const [from, to] of change.renamed) {
       selected = selected ? (remap(selected, from, to) ?? selected) : selected;
       expanded = new Set([...expanded].map((p) => remap(p, from, to) ?? p));
+      trail.renamed(from, to);
     }
+    for (const path of change.removed) trail.removed(path);
     set({ selected, expanded });
     await get().refreshTree();
     const present = new Set(get().nodes.map((n) => n.path));
@@ -169,6 +173,7 @@ export const useVaultStore = create<VaultState>((set, get) => {
       return res;
     }
     set({ info: res.value, selected: null, expanded: new Set(), renaming: null });
+    useTrailStore.getState().reset();
     usePageStore.getState().clear();
     useEditorStore.getState().reset();
     await get().refreshTree();
@@ -220,6 +225,7 @@ export const useVaultStore = create<VaultState>((set, get) => {
       useEditorStore.getState().reset();
       stopListening();
       await vaultClose();
+      useTrailStore.getState().reset();
       usePageStore.getState().clear();
       treeSeq++;
       set({ ...EMPTY, children: new Map(), expanded: new Set() });
@@ -301,6 +307,7 @@ export const useVaultStore = create<VaultState>((set, get) => {
         expanded: new Set([...expanded].map((p) => remap(p, from, to) ?? p)),
         renaming: null,
       });
+      useTrailStore.getState().renamed(from, to);
       get().expand(parentOf(to));
       await get().refreshTree();
       await usePageStore.getState().follow(from, to);
@@ -330,6 +337,7 @@ export const useVaultStore = create<VaultState>((set, get) => {
         toast().push({ message: errorMessage(res.error), tone: 'error' });
         return res;
       }
+      useTrailStore.getState().removed(path);
       const page = usePageStore.getState();
       if (page.path && remap(page.path, path, path)) page.clear();
       const selected = get().selected;
```

- [ ] **Step 4: Run the task's tests**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/stores src/features/page src/features/shell && cargo test -p liber-desktop --test menu`
Expected: PASS — trail 5, navigate 4, the header/shortcut/vault tests; menu: `macos_menu_quit_is_ours_and_the_standard_items_stay ... ok`, `quit_menu_item_requests_the_window_close_like_the_close_button ... ok`, `back_and_forward_items_emit_menu_navigate ... ok`.

- [ ] **Step 5: Run the gate**

Run (repo root, each must exit 0): `set -o pipefail; pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 && pnpm build:ui && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && cargo deny check`
Expected: all clean (vitest 415; cargo 189 + menu 3).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(navigation): link trail — back arrow, ⌘[ / ⌘], View → Back / Forward, follows renames and deletions (M2b §3)" -m "Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 8: The title is the file name, editable in place

Spec §2. The H1 holds an input showing the file stem. Enter or blur validates (`validateName`, duplicate in the loaded tree, case-only renames allowed) and calls `vaultStore.rename`, which flushes open pages first and rewrites links; the page and the trail follow. Escape restores. Failures (including the backend's `alreadyExists`) show inline. When the note's own title (first heading or `title:`) differs from the file name it is shown under the field. The fake disk learns `entry_rename` (case-insensitive like macOS).

**Files:**
- Modify: `apps/desktop/src/features/page/PageHeader.tsx`
- Test (create): `apps/desktop/src/features/page/PageTitle.test.tsx`
- Create: `apps/desktop/src/features/page/PageTitle.tsx`
- Modify: `apps/desktop/src/features/page/PageView.module.css`
- Test (modify): `apps/desktop/src/features/page/PageView.test.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Test (modify): `apps/desktop/src/test/fakeDisk.ts`

**Interfaces:**
- Consumes: `vaultStore.rename`, `validateName` (M1b), `errorMessage`, `nameOf`/`parentOf`; Task 7 trail (follows renames).
- Produces: `features/page/PageTitle.tsx` `PageTitle({ page })`; strings `page.titleLabel`, `page.titleTaken`, `page.titleInNote`. Two M2a header tests now expect the file name in the heading and "Title in the note: …" for the note title.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/features/page/PageTitle.test.tsx`:

```tsx
import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { PageView } from './PageView';

const open = (path: string) => act(() => usePageStore.getState().load(path));
const title = () => screen.getByRole('textbox', { name: 'Page title' });
const renames = (calls: [string, Record<string, unknown>][]) =>
  calls.filter(([c]) => c === 'entry_rename').map(([, a]) => a);

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
});
afterEach(async () => {
  usePageStore.getState().clear();
  resetEditorStore();
  await resetVaultStore();
  clearMocks();
});

describe('editable title (M2b §2)', () => {
  it('shows the file name and renames the file on Enter; the page follows', async () => {
    const disk = fakeDisk({ 'Notes/Old.md': '# Heading\n\nbody\n' });
    render(<PageView />);
    await open('Notes/Old.md');
    expect(screen.getByRole('heading', { level: 1 })).toContainElement(title());
    expect(title()).toHaveValue('Old');
    // The note's own title (first heading or `title:`) stays visible when it differs.
    expect(screen.getByText('Title in the note: Heading')).toBeInTheDocument();
    await userEvent.clear(title());
    await userEvent.type(title(), 'New name{Enter}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('Notes/New name.md'));
    expect(renames(disk.calls)).toEqual([{ from: 'Notes/Old.md', to: 'Notes/New name.md' }]);
    expect(title()).toHaveValue('New name');
    expect(disk.files.has('Notes/New name.md')).toBe(true);
  });

  it('Escape puts the name back; blur renames; an unchanged name does nothing', async () => {
    const disk = fakeDisk({ 'A.md': 'x\n' });
    render(<PageView />);
    await open('A.md');
    await userEvent.clear(title());
    await userEvent.type(title(), 'Z{Escape}');
    expect(title()).toHaveValue('A');
    expect(title()).toHaveFocus();
    await userEvent.type(title(), '{Enter}');
    expect(renames(disk.calls)).toEqual([]);
    await userEvent.type(title(), 'B');
    await userEvent.tab();
    await waitFor(() => expect(renames(disk.calls)).toEqual([{ from: 'A.md', to: 'AB.md' }]));
  });

  it('names that cannot be files, or that are taken, are explained under the title', async () => {
    const disk = fakeDisk({ 'Notes/A.md': 'x\n', 'Notes/B.md': 'y\n' });
    render(<PageView />);
    await open('Notes/A.md');
    await userEvent.clear(title());
    await userEvent.type(title(), 'a/b{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Names can\'t contain "/".');
    expect(title()).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(title());
    await userEvent.type(title(), 'b{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A page named “b” is already in this folder.',
    );
    expect([...disk.files.keys()].sort()).toEqual(['Notes/A.md', 'Notes/B.md']);
    // A case-only rename of the page itself is allowed.
    await userEvent.clear(title());
    await userEvent.type(title(), 'a{Enter}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('Notes/a.md'));
    expect([...disk.files.keys()].sort()).toEqual(['Notes/B.md', 'Notes/a.md']);
  });

  it('pending text is saved before the rename', async () => {
    const disk = fakeDisk({ 'A.md': 'one\n' });
    render(<PageView />);
    await open('A.md');
    act(() => {
      const v = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
      v.dispatch({ changes: { from: 0, insert: 'zero ' }, userEvent: 'input.type' });
    });
    await userEvent.clear(title());
    await userEvent.type(title(), 'B{Enter}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('B.md'));
    const order = disk.calls
      .map(([c]) => c)
      .filter((c) => c === 'page_write' || c === 'entry_rename');
    expect(order[0]).toBe('page_write');
    expect(order).toContain('entry_rename');
    expect(disk.files.get('B.md')).toBe('zero one\n');
  });

  it('a failed rename keeps the field open with the reason', async () => {
    fakeDisk(
      { 'A.md': 'x\n' },
      { entry_rename: () => Promise.reject({ kind: 'io', message: 'disk is read-only' }) },
    );
    render(<PageView />);
    await open('A.md');
    await userEvent.clear(title());
    await userEvent.type(title(), 'B{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('disk is read-only');
    expect(title()).toHaveValue('B');
    expect(usePageStore.getState().path).toBe('A.md');
  });

  it('has no axe violations', async () => {
    fakeDisk({ 'A.md': 'x\n' });
    render(<PageView />);
    await open('A.md');
    const header = screen.getByRole('banner');
    const violations = await axe
      .run(header, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
```

Modify `apps/desktop/src/features/page/PageView.test.tsx`:

```diff
--- a/apps/desktop/src/features/page/PageView.test.tsx
+++ b/apps/desktop/src/features/page/PageView.test.tsx
@@ -61,7 +61,9 @@ describe('PageView (M2a §5)', () => {
     expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
       'VaultCharacter Designrex',
     );
-    expect(screen.getByRole('heading', { level: 1, name: 'Generator Rex' })).toBeInTheDocument();
+    // M2b §2: the title is the file name; the note's own title is shown under it.
+    expect(screen.getByRole('heading', { level: 1, name: 'rex' })).toBeInTheDocument();
+    expect(screen.getByText('Title in the note: Generator Rex')).toBeInTheDocument();
     expect(screen.getByText('Hero redesign · v3')).toBeInTheDocument();
     expect(screen.getByRole('list', { name: 'Tags' })).toHaveTextContent('#character#redesign');
     expect(screen.getByText('8 links · 1 backlink')).toBeInTheDocument();
@@ -134,12 +136,12 @@ describe('PageView (M2a §5)', () => {
     fakeDisk({ 'A.md': '# Old\n' });
     render(<PageView />);
     await open('A.md');
-    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Old');
+    expect(screen.getByText('Title in the note: Old')).toBeInTheDocument();
     await act(async () => {
       view().dispatch({ changes: { from: 2, to: 5, insert: 'New' } });
       await useEditorStore.getState().flushAll();
     });
-    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New'));
+    await waitFor(() => expect(screen.getByText('Title in the note: New')).toBeInTheDocument());
   });
 
   it('deleted outside while dirty: the text stays and can be saved as a new page', async () => {
```

Modify `apps/desktop/src/test/fakeDisk.ts`:

```diff
--- a/apps/desktop/src/test/fakeDisk.ts
+++ b/apps/desktop/src/test/fakeDisk.ts
@@ -86,6 +86,18 @@ export function fakeDisk(initial: Record<string, string>, extra: Extra = {}): Fa
             binary: false,
           };
         }
+        case 'entry_rename': {
+          const text = files.get(args.from);
+          if (text === undefined) throw err('notFound', args.from);
+          // Case-insensitive like macOS/Windows; a case-only rename is fine.
+          const lower = args.to.toLowerCase();
+          if ([...files.keys()].some((k) => k.toLowerCase() === lower && k !== args.from)) {
+            throw err('alreadyExists', args.to);
+          }
+          files.delete(args.from);
+          files.set(args.to, text);
+          return { moved: [[args.from, args.to]], updatedFiles: [], updatedLinks: 0, failed: [] };
+        }
         case 'vault_tree':
           return [...files.keys()].map((path) => ({ path, kind: 'page' }));
         case 'links_resolve':
```

- [ ] **Step 2: Run them and watch them fail**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/features/page/PageTitle.test.tsx`
Expected: FAIL — 5 of 6 (no textbox "Page title"); the axe test passes already.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/page/PageHeader.tsx`:

```diff
--- a/apps/desktop/src/features/page/PageHeader.tsx
+++ b/apps/desktop/src/features/page/PageHeader.tsx
@@ -8,6 +8,7 @@ import { useTrailStore } from '../../stores/trailStore';
 import { nameOf } from '../../stores/tree';
 import { Breadcrumb } from './Breadcrumb';
 import { ModeToggle } from './ModeToggle';
+import { PageTitle } from './PageTitle';
 import styles from './PageView.module.css';
 
 /** The cover's vault path (`null`: none, remote or missing). */
@@ -78,7 +79,7 @@ export function PageHeader({ page, mode }: { page: Page; mode: EditorMode }) {
       {cover && (
         <img data-cover className={styles.cover} src={assetUrl(cover)} alt="" loading="lazy" />
       )}
-      <h1 className={styles.title}>{page.title}</h1>
+      <PageTitle page={page} />
       {page.subtitle && <p className={styles.subtitle}>{page.subtitle}</p>}
       {page.tags.length > 0 && (
         <ul className={styles.tags} aria-label={t('page.tags')}>
```

Create `apps/desktop/src/features/page/PageTitle.tsx`:

```tsx
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Page } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { validateName } from '../explorer/nameRules';
import styles from './PageView.module.css';

/** `Notes/My page.md` → `My page` and `.md`. */
function split(path: string): { stem: string; ext: string } {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/** The page title, editable in place (M2b §2): it is the file name, so Enter
 *  or leaving the field renames the file (links updated as for any rename);
 *  Escape puts the name back. The note's own title (first heading or
 *  `title:`) is shown under it when it differs. */
export function PageTitle({ page }: { page: Page }) {
  const { t } = useTranslation();
  const { stem, ext } = split(page.path);
  const [draft, setDraft] = useState(stem);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  useEffect(() => {
    setDraft(stem);
    setError(null);
  }, [stem]);

  const taken = () => t('page.titleTaken', { name: draft.trim() });

  const commit = async () => {
    const name = draft.trim();
    if (busy || name === stem) {
      setError(null);
      return;
    }
    const invalid = validateName(name);
    if (invalid) {
      setError(
        t(
          `explorer.nameErrors.${invalid.key}`,
          invalid.key === 'forbidden' ? { char: invalid.char } : {},
        ),
      );
      return;
    }
    const dir = parentOf(page.path);
    const to = dir ? `${dir}/${name}${ext}` : `${name}${ext}`;
    const same = (p: string) => p.toLowerCase() === to.toLowerCase();
    const clash = useVaultStore
      .getState()
      .nodes.some((n) => same(n.path) && n.path.toLowerCase() !== page.path.toLowerCase());
    if (clash) {
      setError(taken());
      return;
    }
    setBusy(true);
    const res = await useVaultStore.getState().rename(page.path, to);
    setBusy(false);
    if (!res.ok) setError(res.error.kind === 'alreadyExists' ? taken() : errorMessage(res.error));
    else setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(stem);
      setError(null);
    }
  };

  return (
    <>
      <h1 className={styles.title}>
        <input
          className={styles.titleInput}
          aria-label={t('page.titleLabel')}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          spellCheck={false}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => void commit()}
        />
      </h1>
      {error && (
        <p id={errorId} role="alert" className={styles.titleError}>
          {error}
        </p>
      )}
      {page.title && page.title !== stem && (
        <p className={styles.noteTitle}>{t('page.titleInNote', { title: page.title })}</p>
      )}
    </>
  );
}
```

Modify `apps/desktop/src/features/page/PageView.module.css`:

```diff
--- a/apps/desktop/src/features/page/PageView.module.css
+++ b/apps/desktop/src/features/page/PageView.module.css
@@ -264,3 +264,42 @@
   outline: 2px solid var(--color-focus);
   outline-offset: 2px;
 }
+
+/* Editable title (M2b §2): looks like the heading until hovered or focused. */
+.titleInput {
+  font: inherit;
+  color: inherit;
+  width: 100%;
+  margin: 0 0 0 -6px;
+  padding: 2px 6px;
+  border: 0;
+  border-radius: var(--radius-sm);
+  background: transparent;
+  outline: 1px dashed transparent;
+  text-overflow: ellipsis;
+}
+
+.titleInput:hover {
+  outline-color: var(--color-border-strong);
+}
+
+.titleInput:focus {
+  outline: 1px dashed var(--color-accent);
+  background: var(--color-accent-soft);
+}
+
+.titleInput[aria-invalid='true'] {
+  outline: 1px solid var(--color-warn-border);
+}
+
+.titleError {
+  margin: 0;
+  font-size: 13px;
+  color: var(--color-warn-text);
+}
+
+.noteTitle {
+  margin: 0;
+  font-size: 13px;
+  color: var(--color-text-muted);
+}
```

Modify `apps/desktop/src/i18n/locales/en.json`:

```diff
--- a/apps/desktop/src/i18n/locales/en.json
+++ b/apps/desktop/src/i18n/locales/en.json
@@ -89,7 +89,10 @@
     "binary": "This file isn't valid UTF-8 text, so it can't be shown.",
     "tags": "Tags",
     "meta": "{links, plural, one {# link} other {# links}} · {backlinks, plural, one {# backlink} other {# backlinks}}",
-    "breadcrumb": "Breadcrumb"
+    "breadcrumb": "Breadcrumb",
+    "titleLabel": "Page title",
+    "titleTaken": "A page named “{name}” is already in this folder.",
+    "titleInNote": "Title in the note: {title}"
   },
   "editor": {
     "conflictCopy": "Someone else changed this page — their version was saved as “{name}”",
```

Modify `apps/desktop/src/i18n/locales/es.json`:

```diff
--- a/apps/desktop/src/i18n/locales/es.json
+++ b/apps/desktop/src/i18n/locales/es.json
@@ -89,7 +89,10 @@
     "binary": "Este archivo no es texto UTF-8 válido, así que no se puede mostrar.",
     "tags": "Etiquetas",
     "meta": "{links, plural, one {# enlace} other {# enlaces}} · {backlinks, plural, one {# retroenlace} other {# retroenlaces}}",
-    "breadcrumb": "Ruta"
+    "breadcrumb": "Ruta",
+    "titleLabel": "Título de la página",
+    "titleTaken": "Ya hay una página llamada «{name}» en esta carpeta.",
+    "titleInNote": "Título en la nota: {title}"
   },
   "editor": {
     "conflictCopy": "Alguien más cambió esta página — su versión se guardó como «{name}»",
```

- [ ] **Step 4: Run the task's tests**

Run: `set -o pipefail; pnpm --filter @liber/desktop exec vitest run src/features/page`
Expected: PASS (21: PageTitle 6, PageView 11 with the two updated header tests, Breadcrumb 3, …).

- [ ] **Step 5: Run the gate**

Run (repo root, each must exit 0): `set -o pipefail; pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2`
Expected: all clean (vitest 421).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(page): the title is the file name and renames the page in place (M2b §2)" -m "Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 9: End-to-end in Chromium and WebKit; zero network across every palette

Spec §8. The built UI under the production CSP: toolbar, title rename, link trail and a palette switch run in **both** engines (WebKit ≈ WKWebView); the zero-network test repeats for every palette (and a custom accent) with installed fonts selected by name. The WebKit project's `testMatch` must be anchored to file names (a bare `/m2b/` also matches a parent folder such as `m2b-replay`, turning helpers into "tests"). CI installs both browsers.

**Files:**
- Test (modify): `apps/desktop/e2e/ipcMock.ts`
- Test (create): `apps/desktop/e2e/m2b.spec.ts`
- Test (modify): `apps/desktop/e2e/zero-network.spec.ts`
- Modify: `apps/desktop/playwright.config.ts`

**Interfaces:**
- Consumes: Everything above; `e2e/ipcMock.ts` (M2a).
- Produces: `e2e/m2b.spec.ts`; `installIpcMock({ pages, editorMode, settings? })` keeps settings state and records renames in `window.__liberRenames`.

- [ ] **Step 1: Write the end-to-end tests**

Modify `apps/desktop/e2e/ipcMock.ts`:

```diff
--- a/apps/desktop/e2e/ipcMock.ts
+++ b/apps/desktop/e2e/ipcMock.ts
@@ -4,9 +4,12 @@
 export function installIpcMock({
   pages,
   editorMode,
+  settings: overrides = {},
 }: {
   pages: Record<string, string>;
   editorMode: string;
+  /** Extra settings (palette, fonts, toolbar…) for M2b tests. */
+  settings?: Record<string, unknown>;
 }) {
   type Args = Record<string, unknown>;
   const w = window as unknown as Record<string, unknown>;
@@ -23,25 +26,31 @@ export function installIpcMock({
     truncated: false,
     binary: false,
   });
+  let settings: Record<string, unknown> = {
+    version: 1,
+    language: 'en',
+    theme: 'light',
+    rewriteLinks: true,
+    confirmDelete: true,
+    editorMode,
+    ...overrides,
+  };
   const handlers: Record<string, (a: Args) => unknown> = {
     app_info: () => ({ name: 'Liber Linteum', version: '0.0.0-e2e' }),
-    settings_get: () => ({
-      settings: {
-        version: 1,
-        language: 'en',
-        theme: 'light',
-        rewriteLinks: true,
-        confirmDelete: true,
-        editorMode,
-      },
-    }),
-    settings_set: (a) => ({
-      version: 1,
-      language: 'en',
-      theme: 'light',
-      editorMode,
-      ...(a.patch as object),
-    }),
+    settings_get: () => ({ settings }),
+    settings_set: (a) => {
+      settings = { ...settings, ...(a.patch as object) };
+      return settings;
+    },
+    fonts_list: () => ['Courier New', 'Menlo'],
+    entry_rename: (a) => {
+      const from = a.from as string;
+      const to = a.to as string;
+      pages[to] = pages[from];
+      delete pages[from];
+      ((w.__liberRenames ??= []) as unknown[]).push({ from, to });
+      return { moved: [[from, to]], updatedFiles: [], updatedLinks: 0, failed: [] };
+    },
     vaults_recent: () => [{ path: '/vault', name: 'vault', openedAt: '', missing: false }],
     vault_open: () => ({
       name: 'vault',
```

Create `apps/desktop/e2e/m2b.spec.ts`:

```ts
// M2b in the built UI, in Chromium and WebKit (≈ WKWebView): the formatting
// toolbar, renaming from the title, the link trail and switching palettes.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const PAGES = {
  'A.md': 'hello world\n\nSee [[B]].\n',
  'B.md': '# B\n\nThe second page.\n',
};

async function open(page: Page, name: string, editorMode = 'livePreview') {
  await page.addInitScript(installIpcMock, { pages: { ...PAGES }, editorMode });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
}

const writes = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as { __liberWrites?: { text: string }[] }).__liberWrites ?? []).map(
      (w) => w.text,
    ),
  );

test('the toolbar formats the word at the cursor and sets a heading', async ({ page }) => {
  await open(page, 'A');
  await page.locator('.cm-line', { hasText: 'hello world' }).click({ position: { x: 30, y: 5 } });
  const bar = page.getByRole('toolbar', { name: 'Formatting' });
  await bar.getByRole('button', { name: 'Bold' }).click();
  await expect(bar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('combobox', { name: 'Text style' }).selectOption('2');
  await expect
    .poll(() => writes(page))
    .toContainEqual(expect.stringMatching(/^## \*\*hello\*\* world/));
});

test('renaming from the title renames the file', async ({ page }) => {
  await open(page, 'A');
  const title = page.getByRole('textbox', { name: 'Page title' });
  await title.fill('Alpha');
  await title.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __liberRenames?: unknown[] }).__liberRenames),
    )
    .toEqual([{ from: 'A.md', to: 'Alpha.md' }]);
  await expect(title).toHaveValue('Alpha');
});

test('following a link shows the back arrow; ← and ⌘] walk the trail', async ({ page }) => {
  await open(page, 'A', 'split');
  await page.getByRole('region', { name: 'Preview' }).getByRole('link', { name: 'B' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('B');
  await page.getByRole('button', { name: 'Back to A' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
  await page.locator('body').press('Control+]');
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('B');
  await page.locator('body').press('Control+[');
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
});

test('a palette from Settings applies at once', async ({ page }) => {
  await open(page, 'A');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Graphite' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'graphite');
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
      ),
    )
    .toBe('#2448c4');
});
```

Modify `apps/desktop/e2e/zero-network.spec.ts`:

```diff
--- a/apps/desktop/e2e/zero-network.spec.ts
+++ b/apps/desktop/e2e/zero-network.spec.ts
@@ -41,9 +41,9 @@ async function scrollThrough(page: Page, selector: string) {
   }
 }
 
-async function openRemotePage(page: Page, mode: string) {
+async function openRemotePage(page: Page, mode: string, settings: Record<string, unknown> = {}) {
   const seen = await watchNetwork(page);
-  await page.addInitScript(installIpcMock, { pages: PAGES, editorMode: mode });
+  await page.addInitScript(installIpcMock, { pages: PAGES, editorMode: mode, settings });
   await page.goto('/');
   await page.getByRole('button', { name: /^vault/ }).click();
   await page.getByRole('treeitem', { name: 'remote' }).click();
@@ -85,3 +85,43 @@ for (const mode of ['livePreview', 'source', 'split']) {
     expect(outside).toEqual([]);
   });
 }
+
+// M2b: every palette (and a custom accent) with installed fonts picked by
+// name: still nothing leaves the machine, and the palette really applies.
+for (const palette of [
+  'lavender',
+  'graphite',
+  'rosewood',
+  'saffron',
+  'persimmon',
+  'midnight',
+  'sepia',
+  'ink',
+  'custom',
+]) {
+  test(`zero network requests: ${palette} palette with installed fonts`, async ({ page }) => {
+    const { outside, problems } = await openRemotePage(page, 'split', {
+      palette,
+      accentColor: '#2aa198',
+      fontLivePreview: 'system:Menlo',
+      fontSource: 'system:Courier New',
+    });
+    await expect(page.locator('html')).toHaveAttribute('data-palette', palette);
+    await expect
+      .poll(() =>
+        page.evaluate(() =>
+          getComputedStyle(document.documentElement).getPropertyValue('--font-live'),
+        ),
+      )
+      .toContain('"Menlo"');
+    await scrollThrough(page, '[role="region"][aria-label="Preview"]');
+    await page.waitForLoadState('networkidle');
+    await page.waitForTimeout(300);
+    const csp = await page.evaluate(
+      () => (window as unknown as { __liberCspViolations: string[] }).__liberCspViolations,
+    );
+    expect(problems).toEqual([]);
+    expect(csp).toEqual([]);
+    expect(outside).toEqual([]);
+  });
+}
```

- [ ] **Step 2: Run them**

Run: `set -o pipefail; export PLAYWRIGHT_BROWSERS_PATH=<browsers dir>; pnpm --filter @liber/desktop exec playwright install chromium webkit; pnpm test:e2e`
Expected: These exercise features built in Tasks 1–8, so they PASS straight away; a failure here is a real integration bug (or the `testMatch` pitfall above).

- [ ] **Step 3: Implement**

Modify `apps/desktop/playwright.config.ts`:

```diff
--- a/apps/desktop/playwright.config.ts
+++ b/apps/desktop/playwright.config.ts
@@ -13,7 +13,7 @@ export default defineConfig({
     {
       name: 'webkit',
       use: { ...devices['Desktop Safari'], browserName: 'webkit' },
-      testMatch: /checklist/,
+      testMatch: /\/(checklist|m2b)\.spec\.ts$/,
     },
   ],
   webServer: {
```

- [ ] **Step 4: Run the task's tests**

Run: `set -o pipefail; pnpm test:e2e`
Expected: PASS — 27 tests (Chromium: interceptor, 3 modes, 9 palettes, 3 checklist, 4 M2b; WebKit: 3 checklist, 4 M2b).

- [ ] **Step 5: Run the gate**

Run (repo root, each must exit 0): `set -o pipefail; pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(e2e): toolbar, title rename, link trail and palettes in Chromium and WebKit; zero network with every palette and installed fonts (M2b §8)" -m "Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 10: Full verification and the verbose hand-off

Run every check with its own exit code, then write the hand-off (same structure as M2a's). Real-window checks are for the maintainer (hand-off §9); agents never send keystrokes.

**Files:**
- Create: `docs/handoff/2026-10-13-m2b-editor-ux-handoff.md`

**Interfaces:**
- Consumes: Tasks 1–9.
- Produces: `docs/handoff/2026-10-13-m2b-editor-ux-handoff.md`.

- [ ] **Step 1: Run every check, each with its own exit code**

```bash
set -o pipefail
for c in "pnpm lint" "pnpm typecheck" "pnpm check:i18n" "pnpm --filter @liber/desktop exec vitest run --maxWorkers=2" "pnpm build:ui" "pnpm test:e2e" \
         "cargo fmt --all --check" "cargo clippy --workspace --all-targets -- -D warnings" \
         "cargo test --workspace" "cargo deny check"; do
  sh -c "$c" > /tmp/m2b-check.log 2>&1; echo "$? $c"; tail -3 /tmp/m2b-check.log
done
```

Expected: every line starts with `0`. Reference counts from the replay: vitest 421 tests in 50 files; Playwright 27; cargo 189 + 3 menu checks; `cargo deny`: `advisories ok, bans ok, licenses ok, sources ok`.

- [ ] **Step 2: Write the hand-off**

Create `docs/handoff/2026-10-13-m2b-editor-ux-handoff.md`:

```markdown
# M2b — Editor UX iteration: Hand-off

**Spec:** `docs/superpowers/specs/2026-10-13-m2b-editor-ux-design.md` · **Plan:** `docs/superpowers/plans/2026-10-13-m2b-editor-ux.md` · **Palette reference:** `docs/design/2026-10-13-m2b-palettes.html`
**Branch:** `feat/m2b-editor-ux` (from `main` `1c9d0b1`). Previous hand-off: `docs/handoff/2026-10-12-m2a-editor-handoff.md`.

This milestone is the maintainer's real-window feedback on M2a: rename from the title, a back arrow for followed links, more palettes plus a custom accent, legible fonts with per-mode pickers, and an optional formatting toolbar. The former M2b scope (covers, attachments, `[[` autocomplete) is now **M2c**.

## 1. Status at a glance

| Area | State |
|---|---|
| Settings model: `palette`, `accentColor`, `fontLivePreview`, `fontSource`, `fontSize`, `toolbar` (Rust + TS, lenient per field) | done, tested (Rust store + IPC round trip + TS defaults) |
| 8 palettes (Lavender default, Graphite, Rosewood, Saffron, Persimmon, Midnight, Sepia, Ink) + custom accent derived in OKLCH | done, tested (contrast floors for every palette × mode; derive sweep over 48+ colours; generated CSS up to date) |
| Fonts: 6 new bundled families (offline, Latin + Latin Extended) + installed families via `fonts_list` (fontdb) | done, tested (stacks + escaping; command over real ACL; async guard) |
| Settings dialog: Appearance (theme, palette grid, custom accent), Editor (fonts, size, toolbar), Files | done, tested (+ axe) |
| Formatting commands + shortcuts; ⌘[ / ⌘] freed; Tab indents only in lists | done, tested |
| Formatting toolbar (ARIA toolbar, pressed states, heading menu, header toggle) | done, tested (+ axe) |
| Link trail: ← in the header, ⌘[ / ⌘], View → Back / Forward, follows renames and deletions | done, tested (store, navigation, header, keys, menu event over the mock runtime) |
| Title = file name, editable in place (validation, duplicates, pending text saved first) | done, tested (+ axe) |
| E2E in Chromium **and WebKit**: toolbar, rename, trail, palettes; zero-network across all palettes with installed fonts | done (27 tests) |
| Real-window checks (§9) | **need you** |

Totals at the end of the replay: **421 vitest tests (50 files)**, **27 Playwright tests**, **192 cargo tests** (189 + 3 main-thread menu checks); eslint, prettier, tsc, i18n parity, clippy `-D warnings`, rustfmt and `cargo deny` all clean.

## 2. How to run

| What | Command (repo root) |
|---|---|
| Everything (CI gate) | `pnpm check` |
| UI unit tests | `pnpm test` (on a busy machine: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2`) |
| E2E (both engines) | once: `pnpm --filter @liber/desktop exec playwright install chromium webkit`; then `pnpm test:e2e` |
| Regenerate palette CSS after editing a palette | `pnpm --filter @liber/desktop gen:palettes` |
| App (dev) | `pnpm dev` |

## 3. Backend map (`apps/desktop/src-tauri/src/`)

| File | What changed |
|---|---|
| `settings.rs` | New types: `Palette` (lowercase ids + `custom`), `HexColor` (`#rrggbb`, stored lower-case), `FontChoice` (a `BUNDLED_FONTS` id or `system:<Family>`, ≤ 200 chars, no control characters), `FontSize` (13–20, out-of-range numbers are **clamped**, non-numbers reset). New `Settings`/`SettingsPatch` fields with defaults `lavender`, `#d1477a`, `atkinson-hyperlegible`, `jetbrains-mono`, `15`, `true`. `parse_lenient` resets each field on its own (warning names the key). |
| `fonts.rs` (new) | `system_families()` with `fontdb` (local files only): English family name when a font has several, hidden `.`-families dropped, unique + sorted ignoring case; cached in a `OnceLock` per app session. Command `fonts_list` is async via `blocking()`. |
| `menu.rs` | View menu gains **Back** (`liber-back`) and **Forward** (`liber-forward`) before Full Screen, **without accelerators** (the page handles ⌘[ / ⌘] itself — see §8.3). `on_menu_event` emits `menu:navigate` with `"back"` / `"forward"`. |
| `lib.rs` | Registers `fonts::fonts_list`. |
| `build.rs`, `capabilities/main.json` | `fonts_list` / `allow-fonts-list`. No other new permission: the menu event reaches the UI through the existing `core:event:allow-listen`. |
| Workspace `Cargo.toml` | `fontdb = "0.24.0"` (MIT; pulls `ttf-parser`, `memmap2`, `fontconfig-parser`, `roxmltree`, `slotmap`, all MIT/Apache/Zlib — `cargo deny` clean). |

Tests: `tests/settings.rs` (3 new), `tests/commands.rs` (`m2b_settings_round_trip_over_ipc`, `m2b_fonts_list_returns_installed_families`, `fonts_list` in the allowed/denied ACL list and in the async guard), `tests/menu.rs` (View has Back/Forward; `back_and_forward_items_emit_menu_navigate`).

## 4. Frontend map (`apps/desktop/src/`)

| Path | What it does |
|---|---|
| `theme/palettes.ts` | The 8 palettes: 15 tokens per mode (`bg surface border text strong body muted accent soft contrast side sideText sideSel mark code`), values from the reference page. |
| `theme/color.ts` | hex ↔ sRGB, `mix`, WCAG `contrast`, `hexToOklch`, `oklchToHex` (gamut-clamps by reducing chroma). |
| `theme/derive.ts` | `derive(hex)` → `{light, dark}` tokens: accent darkened until ≥ 4.8:1 on white, lightened until ≥ 6:1 on the dark surface, chroma capped 0.17/0.13, neutrals tinted toward the hue (not for greys, chroma < 0.03). |
| `theme/paletteCss.ts` | `paletteVars(p, mode)` (mock token → app CSS variables, in-between shades mixed as **hex**, no runtime `color-mix`), `paletteCss(p)` (light block + both dark blocks). |
| `theme/palettes.css` | **Generated** by `scripts/gen-palettes.ts` (ignored by prettier; a test fails if it is stale). |
| `theme/appearance.ts` | `applyAppearance(settings)`: `data-palette` on `<html>`, a `<style id="liber-custom-palette">` for the custom accent, and `--font-live`, `--font-source`, `--font-size-editor`. Called from `settingsStore.apply`. |
| `theme/fonts.ts`, `theme/fonts.css` | `LIVE_FONTS`, `SOURCE_FONTS`, `fontStack(choice, kind)` (installed families quoted and escaped before the default stack), `systemChoice`, `systemFamily`; the @fontsource imports. |
| `theme/tokens.css` | Defaults for the new tokens (`--color-sidebar-selected`, `--color-highlight-bg`, `--color-code-bg`) and the font variables. |
| `features/dialogs/SettingsDialog.tsx` | Sections Appearance / Editor / Files; `Swatch`, `AccentEditor` (colour input + hex field with inline error + contrast line), `FontSelect` (bundled + installed optgroups). |
| `features/editor/format.ts` | Commands: `toggleInline(kind)`, `setHeading(level)`, `toggleBlock(kind)`, `insertDivider`, `insertLink`, `listIndent(dir)`; `activeFormats(state)`; `formatKeymap`, `editorKeymap` (CodeMirror defaults minus `Mod-[` / `Mod-]`). |
| `features/editor/Toolbar.tsx` | The toolbar (roving tabindex, `aria-pressed`, heading `<select>` named "Text style"). Rendered by `Editor.tsx` above the editor when `settings.toolbar`. |
| `features/editor/Editor.tsx` | GFM parser (`markdown({ base: markdownLanguage })`), new keymap, `toolbarOf` per view (pressed state), font variables in the theme. |
| `features/page/PageTitle.tsx` | The editable title (file stem), validation, duplicate check, rename via `vaultStore.rename`, "Title in the note: …" when the note's own title differs. |
| `features/page/PageHeader.tsx` | ← back button (when the trail has a previous page), toolbar toggle ("Aa", `aria-pressed`), `PageTitle`. |
| `stores/trailStore.ts` | `back`/`forward` stacks; `followed`, `goBack`, `goForward`, `reset`, `renamed`, `removed`. |
| `stores/navigate.ts` | `openPage(path, heading, via)` with `Via = 'link' \| 'direct' \| 'trail'`; `goBack`, `goForward`; `installMenuNavigation(IfTauri)`. |
| `features/shell/useGlobalShortcuts.ts` | ⌘[ / ⌘] (Ctrl on Windows/Linux). |
| `stores/vaultStore.ts` | Resets the trail on vault open/close; forwards renames and removals (own and external) to the trail. |

## 5. Flows

- **Palette:** Settings radio → `settings_set {palette}` → `settingsStore.apply` → `applyAppearance` sets `data-palette` (built-in CSS in `palettes.css`) or injects the custom stylesheet. Instant, no reload.
- **Custom accent:** colour input (saves on change) or hex field (Enter/blur; invalid → inline alert, nothing saved) → `accentColor` → `derive` → stylesheet.
- **Fonts:** dialog asks `fonts_list` once per open (cached in Rust) → choosing an option saves `fontLivePreview`/`fontSource` → CSS variables. Code (inline and blocks) in Live Preview and the rendered pane uses the Source font.
- **Toolbar:** button `mousedown` is prevented (the editor keeps its selection) → command → one transaction (one undo step) → `view.focus()`. Pressed state: every doc/selection/syntax-tree change → `activeFormats` → toolbar re-renders only when the set changes.
- **Link trail:** link click / ⌘-click / Mod-Enter / embed "Open" / "Create page" from a link → `openPage(…, 'link')` pushes the page you were on (with its heading). Explorer click, conflict/orphan toasts, ⌘O → fresh trail. ← / ⌘[ / View → Back → `goBack()`; ⌘] / View → Forward → `goForward()`.
- **Title rename:** Enter or blur → validate (name rules, duplicate in the tree) → `vaultStore.rename` (flushes every open page first, rewrites links per setting, toast) → page and trail follow. Escape restores. Failures (incl. `alreadyExists` from the backend) show inline.

## 6. Recipes

- **Add a palette:** add its id to `PALETTE_IDS` (`ipc/index.ts`) and to `Palette` in `settings.rs` (lowercase), add the 15 light + 15 dark tokens to `theme/palettes.ts`, add `settings.palettes.<id>` in `en.json` and `es.json`, run `pnpm --filter @liber/desktop gen:palettes`. `palettes.test.ts` checks the contrast floors and that the CSS is current.
- **Add a toolbar item:** write a `StateCommand` in `format.ts` (test it with the `‹…›`/`¦` helpers in `format.test.ts`), optionally an `ActiveFormat` read in `activeFormats`, add an `Item` to `INLINE` or `BLOCK` in `Toolbar.tsx` (icon + `toolbar.<id>` strings in both locales), and a shortcut in `formatKeymap` if it has one.
- **Add a bundled font:** `pnpm --filter @liber/desktop add @fontsource/<name>`, import its `latin-*`/`latin-ext-*` files in `theme/fonts.css`, add it to `LIVE_FONTS` or `SOURCE_FONTS`, and its id to `BUNDLED_FONTS` in `settings.rs` (a test keeps the lists equal).

## 7. Tests inventory (new in M2b)

| File | Covers |
|---|---|
| `src-tauri/tests/settings.rs` | new fields: defaults, persistence, lower-casing, per-field reset, clamping, bounds |
| `src-tauri/tests/commands.rs` | settings round trip over IPC; `fonts_list` (non-empty, no dot families, sorted, cached); ACL + async guard |
| `src-tauri/tests/menu.rs` | View → Back / Forward present; `menu:navigate` emitted |
| `theme/palettes.test.ts` | ids, contrast floors per palette × mode (text 7:1, body 7:1, muted 4.5:1, accent 4.5:1, text on accent 4.5:1, sidebar 7:1, coloured text 4.5:1), token mapping, generated CSS current, derive sweep |
| `theme/appearance.test.ts`, `theme/fonts.test.ts` | attribute / stylesheet / variables; stacks, escaping, fallbacks, id lists |
| `features/dialogs/SettingsDialog.test.tsx` | sections + axe, palette, hex validation, colour input, fonts/size/toolbar, no installed list |
| `features/editor/format.test.ts` | every command incl. multi-selection undo, italic-in-bold, setext-safe divider, keys, Tab only in lists, `activeFormats` |
| `features/editor/Toolbar.test.tsx` | run + focus kept, pressed state, heading menu follows cursor, roving focus, axe, hidden by setting |
| `stores/trailStore.test.ts`, `stores/navigate.test.ts` | trail rules; link vs direct; heading restored; `followLink`; menu event |
| `features/page/PageTitle.test.tsx` | Enter/Escape/blur, invalid and duplicate names, case-only rename, pending text first, failure reason, axe |
| `features/page/PageView.test.tsx`, `features/shell/Interactions.test.tsx`, `stores/stores.test.ts`, `Editor.test.tsx` | header toggle, back arrow, ⌘[ / ⌘] (also from inside the editor), vault events → trail, palette applied by the store, ⌘B |
| `e2e/m2b.spec.ts` (Chromium + WebKit), `e2e/zero-network.spec.ts` | toolbar, title rename, trail, palette; zero network with every palette + installed fonts |

## 8. Rulings made on your behalf (deviations from the spec)

1. **The custom palette is a generated `<style>` element, not inline variables on `<html>`** (spec §4): a palette needs light *and* dark values, which one `style` attribute can't express. Allowed by the CSP (`style-src 'unsafe-inline'`).
2. **In-between shades are mixed to hex by the generator** instead of `color-mix()` at runtime, so palettes work on the Safari 15 floor.
3. **Back / Forward menu items have no accelerators** (spec §3 said "with those accelerators"): the page already handles ⌘[ / ⌘] (also on Windows/Linux and in the browser e2e), and a menu accelerator would fire the same navigation twice on platforms that deliver the key to both.
4. **The toolbar's pressed state comes from CodeMirror's Lezer syntax tree** (GFM), not the mdast model (spec §6): Source mode has no mdast model, and the Lezer tree is incremental. `==highlight==` (no Lezer node) is found on the cursor line.
5. **Link (⌘K) always writes `[text](url)`** with "url" selected; turning a selected page name into `[[Page]]` (spec §6) is left to M2c's `[[` autocomplete, which owns page lookup.
6. **The header shows the file name** (Obsidian's inline title); when the note's own title (first heading or `title:`) differs, it is shown under it as "Title in the note: …".
7. **Duplicate names** are checked against the explorer tree when it is loaded, and the backend's `alreadyExists` maps to the same inline message.
8. **Code in Live Preview and the rendered pane uses the Source font** (spec only named Source mode), so code looks the same everywhere.
9. **Versions:** `fontdb` 0.24.0; `@fontsource/atkinson-hyperlegible` 5.3.0, `literata` 5.3.0, `source-serif-4` 5.3.1, `ibm-plex-sans` 5.3.0, `ibm-plex-mono` 5.3.0, `source-code-pro` 5.3.1 (pnpm's release-age gate).
10. **Bold in Literata, Source Serif 4 and IBM Plex Sans uses their 600 weight** (only 400/600 are bundled, to keep the app small).

## 9. Needs the real window (you)

1. Atkinson Hyperlegible in Live Preview: typing feel and readability; try Literata and an installed font (e.g. Avenir Next) for Live Preview and Menlo for Source.
2. Every palette in light and dark (Settings → Appearance); the custom accent with a very light colour (yellow) and a near-black.
3. The toolbar in Live Preview, Source and Split: bold/italic/strike/highlight/code/link, headings, lists, quote, divider; ⌘B, ⌘I, ⌘⇧X, ⌘⇧H, ⌘E, ⌘K, ⌘⌥1–6, ⌘⇧7/8/9, ⌘⇧.; the "Aa" button hides/shows it.
4. Tab inside a list indents; Tab in a paragraph leaves the editor (keyboard users never get stuck).
5. Rename a page from its title; with backlinks (they update); try a name with `/` and an existing name.
6. Follow 3–4 links, then ←, ⌘[, ⌘], and View → Back / Forward in the menu; open a page from the explorer (the arrow disappears).
7. IME / dead keys in the title field.

## 10. Known gaps / deferred

| # | Gap | Target |
|---|---|---|
| a | `[[Page]]` from the Link button / ⌘K | M2c (autocomplete) |
| b | Toolbar customisation (reorder/hide items) | later |
| c | Bundled fonts cover Latin + Latin Extended only; other scripts use system fonts | later |
| d | `fonts_list` is read once per app session (install a font → restart) | later |
| e | Forward has no header button (shortcut + menu only, per spec) | — |
| f | The trail is per window and not persisted | — |

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `palettes.css is generated from palettes.ts` fails | run `pnpm --filter @liber/desktop gen:palettes`; never run prettier on that file (it's in `.prettierignore` — run prettier from the repo root) |
| Installed fonts missing from the pickers | `fonts_list` must be in `build.rs` + `capabilities/main.json` (`allow-fonts-list`); outside the app the list is empty by design |
| ⌘[ indents instead of going back | `editorKeymap` must keep filtering `Mod-[` / `Mod-]` |
| View → Back does nothing | `installMenuNavigationIfTauri()` must run in `main.tsx`; the UI needs `core:event:allow-listen` |
| E2E WebKit project runs the wrong files | its `testMatch` is anchored: `/\/(checklist|m2b)\.spec\.ts$/` (a bare `/m2b/` also matches folder names) |

## 12. Next steps

1. Your real-window pass (§9).
2. **M2c:** covers/subtitle editing, paste/drop attachments, `[[` autocomplete (incl. ⌘K → `[[…]]`), Create-page folders.
3. M3 Global View.
```

- [ ] **Step 3: Run the task's tests**

Run: `set -o pipefail; pnpm lint`
Expected: clean (the hand-off is Markdown; `.prettierignore` skips `docs`).

- [ ] **Step 4: Run the gate**

Run (repo root, each must exit 0): `set -o pipefail; pnpm check`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: verbose M2b hand-off" -m "Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

## Spec amendments (rulings made while replaying; amend the spec with these)

1. **Custom palette as a generated `<style>` element** (§4 said inline variables on `<html>`): a palette needs light and dark values. CSP-allowed (`style-src 'unsafe-inline'`).
2. **Derived shades mixed to hex by the generator**, no runtime `color-mix()` (Safari 15 floor).
3. **View → Back / Forward have no accelerators** (§3 said "with those accelerators"): ⌘[ / ⌘] are handled by the page (all platforms, also in the e2e browser); an accelerator would double-fire where the key reaches both.
4. **Toolbar pressed state from CodeMirror's Lezer (GFM) tree**, not mdast (§6): Source mode has no mdast model; `==highlight==` is detected on the cursor line.
5. **⌘K / Link always writes `[text](url)`** with "url" selected; selection → `[[Page]]` (§6) moves to M2c with `[[` autocomplete.
6. **Header shows the file name; the note's own title is shown under it ("Title in the note: …") when it differs** (§2 said the field shows the stem; the extra line keeps frontmatter/heading titles visible).
7. **Duplicate check** against the loaded explorer tree plus the backend's `alreadyExists`, same inline message.
8. **Code (inline and blocks) in Live Preview and the rendered pane uses the Source font** (§5 named Source mode only).
9. **Bundled weights:** 400 / 400 italic / 600 (700 for Atkinson Hyperlegible); bold text in Literata, Source Serif 4 and IBM Plex Sans renders with 600.
10. **`FontSize` out-of-range numbers are clamped** (e.g. 40 → 20) rather than reset; non-numbers reset.
11. **Explorer selection colour** now comes from each palette's `sideSel` token (`--color-sidebar-selected`), replacing the accent mix.

## Self-review

- **Spec coverage:** §2 → Task 8; §3 → Task 7 (+ Task 5 keymap); §4 → Tasks 2 and 4; §5 → Tasks 3 and 4; §6 → Tasks 5 and 6; §7 → Task 1 (+ Task 4 UI); §8 → tests in every task and Task 9; §9 out of scope respected; §10 values → Task 2 `palettes.ts` (copied verbatim from the reference page, checked by contrast tests).
- **Placeholders:** none; generated files are named with the command that produces them.
- **Type consistency:** `Via`, `TrailEntry`, `ActiveFormat`, `FontChoice`/`PaletteChoice`, `paletteCss`/`paletteVars`, `applyAppearance` are used with the same names and signatures in every later task (the replay compiled and type-checked after each task).
- **Review Focus:** five lines above, each with its pinning test in the owning task.
