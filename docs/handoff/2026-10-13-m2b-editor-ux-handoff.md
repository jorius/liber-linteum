# M2b — Editor UX iteration: Hand-off

**Spec:** `docs/superpowers/specs/2026-10-13-m2b-editor-ux-design.md` · **Plan:** `docs/superpowers/plans/2026-10-13-m2b-editor-ux.md` · **Palette reference:** `docs/design/2026-10-13-m2b-palettes.html`
**Branch:** `feat/m2b-editor-ux` (from `main` `1c9d0b1`). Previous hand-off: `docs/handoff/2026-10-12-m2a-editor-handoff.md`.

This milestone is Jose's real-window feedback on M2a: rename from the title, a back arrow for followed links, more palettes plus a custom accent, legible fonts with per-mode pickers, and an optional formatting toolbar. The former M2b scope (covers, attachments, `[[` autocomplete) is now **M2c**.

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

Totals after the final-review fix pass (§13): **439 vitest tests (50 files)**, **27 Playwright tests** (Chromium + WebKit), **192 cargo tests** (189 + 3 main-thread menu checks); eslint, prettier, tsc, i18n parity, clippy `-D warnings`, rustfmt and `cargo deny` all clean.

## 2. How to run

| What | Command (repo root) |
|---|---|
| Everything (CI gate) | `pnpm check` |
| UI unit tests | `pnpm test` (on a busy machine: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2`) |
| E2E (both engines) | once: `pnpm --filter @nimw/desktop exec playwright install chromium webkit`; then `pnpm test:e2e` |
| Regenerate palette CSS after editing a palette | `pnpm --filter @nimw/desktop gen:palettes` |
| App (dev) | `pnpm dev` |

## 3. Backend map (`apps/desktop/src-tauri/src/`)

| File | What changed |
|---|---|
| `settings.rs` | New types: `Palette` (lowercase ids + `custom`), `HexColor` (`#rrggbb`, stored lower-case), `FontChoice` (a `BUNDLED_FONTS` id or `system:<Family>`, ≤ 200 chars, no control characters), `FontSize` (13–20; out-of-range whole numbers ≥ 0 are **clamped**; negative numbers, fractions like `15.5` and non-numbers **reset to 15** — the type is `u32`). New `Settings`/`SettingsPatch` fields with defaults `lavender`, `#d1477a`, `atkinson-hyperlegible`, `jetbrains-mono`, `15`, `true`. `parse_lenient` resets each field on its own (warning names the key). |
| `fonts.rs` (new) | `system_families()` with `fontdb` (local files only): English family name when a font has several, hidden `.`-families dropped, unique + sorted ignoring case; cached in a `OnceLock` per app session. Command `fonts_list` is async via `blocking()`. |
| `menu.rs` | View menu gains **Back** (`nimw-back`) and **Forward** (`nimw-forward`) before Full Screen, **without accelerators** (the page handles ⌘[ / ⌘] itself — see §8.3). `on_menu_event` emits `menu:navigate` with `"back"` / `"forward"`. |
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
| `theme/appearance.ts` | `applyAppearance(settings)`: `data-palette` on `<html>`, a `<style id="nimw-custom-palette">` for the custom accent, and `--font-live`, `--font-source`, `--font-size-editor`. Called from `settingsStore.apply`. |
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

- **Add a palette:** add its id to `PALETTE_IDS` (`ipc/index.ts`) and to `Palette` in `settings.rs` (lowercase), add the 15 light + 15 dark tokens to `theme/palettes.ts`, add `settings.palettes.<id>` in `en.json` and `es.json`, run `pnpm --filter @nimw/desktop gen:palettes`. `palettes.test.ts` checks the contrast floors and that the CSS is current.
- **Add a toolbar item:** write a `StateCommand` in `format.ts` (test it with the `‹…›`/`¦` helpers in `format.test.ts`), optionally an `ActiveFormat` read in `activeFormats`, add an `Item` to `INLINE` or `BLOCK` in `Toolbar.tsx` (icon + `toolbar.<id>` strings in both locales), and a shortcut in `formatKeymap` if it has one.
- **Add a bundled font:** `pnpm --filter @nimw/desktop add @fontsource/<name>`, import its `latin-*`/`latin-ext-*` files in `theme/fonts.css`, add it to `LIVE_FONTS` or `SOURCE_FONTS`, and its id to `BUNDLED_FONTS` in `settings.rs` (a test keeps the lists equal).

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
8. **Your Spanish layout:** ⌘[ / ⌘] (with or without ⌥) go back/forward. The tests use the `e.key`/`e.code` values WKWebView *should* report; please confirm on the real keyboard.
9. Rename from the title, then Cmd-Tab to another app mid-edit and back: the rename must **not** have happened (it commits on Enter or a click elsewhere in the app). Focus stays in the title after Enter/Escape.
10. Triple-click a line and press Bullet/H1: only that line changes. Tab in a numbered list nests the item (renumbered to `1.`); ⇧Tab un-nests; ⇧Tab on a top-level item moves focus backwards.
11. Pick a custom accent by dragging the colour picker: the final colour sticks after closing Settings; tags and pressed toolbar buttons stay readable.
12. Whether installed fonts render in the WKWebView (Safari restricts user-installed fonts for fingerprinting; the reviewer could not verify WKWebView's behaviour).

## 10. Known gaps / deferred

| # | Gap | Target |
|---|---|---|
| a | `[[Page]]` from the Link button / ⌘K | M2c (autocomplete) |
| b | Toolbar customisation (reorder/hide items) | later |
| c | Bundled fonts cover Latin + Latin Extended only; other scripts use system fonts | later |
| d | `fonts_list` is read once per app session (install a font → restart) | later |
| e | Forward has no header button (shortcut + menu only, per spec) | — |
| f | The trail is per window and not persisted | — |
| g | Nested numbered items keep the outer count when the list buttons renumber; outer numbers after a Tab-nest are not renumbered | later |
| h | Two cursors in one word double-wrap (`****hello****`); `_**x**_` + Italic wraps again | later |
| i | View → Back / Forward are always enabled (spec: disabled when empty) | later |
| j | A valid bundled font id from the other list (e.g. `fontLivePreview: "jetbrains-mono"` in settings.json) applies, but the picker shows the default | later |
| k | Title rename flush has no 2 s cap (one write attempt, same as the explorer rename) | — |

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `palettes.css is generated from palettes.ts` fails | run `pnpm --filter @nimw/desktop gen:palettes`; never run prettier on that file (it's in `.prettierignore` — run prettier from the repo root) |
| Installed fonts missing from the pickers | `fonts_list` must be in `build.rs` + `capabilities/main.json` (`allow-fonts-list`); outside the app the list is empty by design |
| ⌘[ indents instead of going back | `editorKeymap` must keep filtering `Mod-[` / `Mod-]` |
| View → Back does nothing | `installMenuNavigationIfTauri()` must run in `main.tsx`; the UI needs `core:event:allow-listen` |
| E2E WebKit project runs the wrong files | its `testMatch` is anchored: `/\/(checklist|m2b)\.spec\.ts$/` (a bare `/m2b/` also matches folder names) |

## 12. Next steps

1. Your real-window pass (§9).
2. **M2c:** covers/subtitle editing, paste/drop attachments, `[[` autocomplete (incl. ⌘K → `[[…]]`), Create-page folders.
3. M3 Global View.

## 13. Final review and fix pass

Reviewer (opus, fresh context) on `2fa7ab1..7473d1f`: **0 Critical, 3 Important, 12 Minor**, no data-loss path; CSS injection through settings ruled out (Rust validates `HexColor`/`FontChoice`; fonts set via `setProperty`; the custom `<style>` contains only derived hex). Re-graded by effect, 9 minors joined the fix pass. Fixed in three parallel worktrees (A: format commands; B: title, trail, shortcuts; C: theme, settings), cherry-picked; every fix has a test that failed first.

| # | Finding | Fix | Test(s) |
|---|---|---|---|
| I1 | Triple-click / Shift+↓ selections also formatted the next line | `selectedLines` stops before a line the selection merely touches at its start | `format.test.ts` "a selection ending at a line start…" |
| I2 | Tab in a numbered list didn't nest (2 spaces under `1. `; and a nested list must start at 1 to interrupt a paragraph) | indent to the parent's text column (`- ` 2, `1. ` 3, `10. ` 4) and renumber the moved item; ⇧Tab mirrors | `format.test.ts` "Tab nests an item…", verified with `parsePage` |
| I3 | Focus lost after renaming from the title (header unmounted during reload) | `pageStore.follow` remaps the shown page first, so the header stays mounted | `PageTitle.test.tsx` "final review I3…" |
| m1↑ | Custom accent on the soft tint < 4.5:1 (tags, pressed buttons) | accent loops also require ≥ 4.5 on the soft tint (light accent slightly darker); reference page mirrors it | `palettes.test.ts` sweep + built-ins |
| m2↑ | Atomic external save (delete + re-create) dropped the page from the trail | prune after `refreshTree`, keep entries present again | `stores.test.ts` "final review m2…" |
| m3↑ | "Back to <current page>" after pruning | `removed(path, {exists, current})` drops the current page from the near end of both stacks | `navigate.test.ts`, `trailStore.test.ts` |
| m4↑ | Failed title rename shown inline **and** as a toast | `vaultStore.rename(from, to, { quiet })`; title passes `quiet` | `PageTitle.test.tsx`, `stores.test.ts` |
| m5↑ | ⌘[ / ⌘] unusable where brackets need ⌥ (Spanish, German, French Mac) | accept bracket `key` with/without ⌥ and physical `BracketLeft/Right` when it isn't an ordinary shortcut character | `Interactions.test.tsx` "final review m5…" |
| m6↑ | Switching apps mid-edit committed a half-typed title (vault-wide link rewrite) | blur commits only when `document.hasFocus()` | `PageTitle.test.tsx` "final review m6…" |
| m7↑ | ⇧Tab on a top-level item swallowed (focus trap) | list Tab/⇧Tab return false when nothing changes | `format.test.ts` |
| m8↑ | `_x_` / `__x__` didn't toggle off; bare `- [ ]` → `- [ ] [ ]` | `_` counts as a marker; empty task recognised | `format.test.ts` |
| m10↑ | Hex error stuck; colour drag fired concurrent saves (last colour could lose) | error clears when valid; `useLatestSave` (150 ms settle, one save in flight, last value wins, flushed on close) | `SettingsDialog.test.tsx` |
| m11 | ⌘[ review-focus test couldn't fail; duplicate check untested with a tree | indented-list test pressing Ctrl (jsdom's Mod) for ⌘[ and ⌘]; tree-loaded duplicate + case-only test | `Interactions.test.tsx`, `PageTitle.test.tsx` |

`src/test/setup.ts` stubs `document.hasFocus()` → true (jsdom returns false mid-blur). Deferred minors: §10 g–k.
