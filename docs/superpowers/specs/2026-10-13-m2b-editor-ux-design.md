# M2b — Editor UX iteration: Design

**Status:** approved in conversation 2026-10-13 (Jose), from his real-window feedback on M2a (M2a hand-off §14).
**Visual reference:** `docs/design/2026-10-13-m2b-palettes.html` (also published privately as https://claude.ai/artifact/2qEG27CumXPUF1j15uxfcm) — palettes in an app mock, the custom-accent derivation code, toolbar/back-arrow/title mock.
**Roadmap change:** this is **M2b**. The former M2b scope (covers/subtitle editing, paste/drop attachments, `[[` autocomplete, Create-page folders) moves to **M2c**.

---

## 1. Goal and success criteria

Make the editor comfortable for daily use:

1. **Title editing:** the page title under the breadcrumb is editable in place and renames the file (links updated).
2. **Back arrow (link trail):** after following internal links you can walk back (and forward) along them.
3. **Palettes:** 8 built-in palettes + a custom accent from which a complete, readable light/dark palette is derived.
4. **Fonts:** legible default reading font for Live Preview; independent font pickers for Live Preview and Source, plus text size; bundled fonts work offline, installed system fonts are selectable.
5. **Formatting toolbar:** an optional, toggleable toolbar with the usual inline/block formatting, plus keyboard shortcuts that work with it hidden.

Non-negotiables carried over: no network (P1/NFR-04, zero-network e2e extended), async commands via `blocking()` with ACL tests, i18n en+es parity, axe-clean, Safari 15 floor (no regex lookbehind), Obsidian-compatible Markdown output.

---

## 2. Title editing (`features/page/PageHeader.tsx` → `PageTitle.tsx`)

- The H1 title becomes a single-line editable field styled as the heading (an `<input>` that looks like the H1 at rest; dashed outline + soft accent fill on hover/focus, as in the mock). Accessible name "Page title"; it keeps the heading role for the page's H1 (`<h1>` wrapping the input).
- **Commit:** Enter or blur. **Cancel:** Escape (restores the name, keeps focus). Empty or unchanged → no-op.
- **Validation:** reuse `features/explorer/nameRules.ts` `validateName`; plus "a page with that name already exists in this folder" (case-insensitive on macOS/Windows; case-only rename allowed, M1a). Errors show inline under the title (`role="alert"`, i18n) and the field stays in edit mode.
- **Flow:** `editorStore` flushes the page's pending text first (`flush`, max 2 s) → `vaultStore.rename(from, to)` (same path as explorer rename: link rewriting per the `rewriteLinks` setting, toast with count) → PageDoc follows the rename (M2a `moveTo`) → breadcrumb/tree/back trail update from the rename event.
- The name shown is the file stem (no `.md`); the extension is preserved. Frontmatter `title:` is **not** changed (Obsidian semantics: the file name is the title).
- Failure (rename refused, I/O) → inline error with the backend message mapped like explorer rename; text never lost.

## 3. Back arrow — link trail (`stores/trailStore.ts`)

- **State:** `{ back: Entry[], forward: Entry[] }`, `Entry = { path: string; heading: string | null }`, in memory per window (not persisted).
- **Push:** only navigations that follow an internal link: ⌘-click / Mod-Enter in Live Preview, link clicks in the rendered pane and Live Preview widgets, an embed's "Open" button, creating a page from an unresolved link. `followLink`/`openPage` gain a `via: 'link' | 'direct'` argument; `via: 'link'` pushes the *current* page onto `back` and clears `forward`.
- **Reset (fresh trail):** `via: 'direct'` — explorer, breadcrumb, ⌘O/vault switch, new page from the explorer, conflict-toast "Open", orphan "Open".
- **UI:** a ← button left of the breadcrumb, shown only when `back.length > 0`; tooltip/aria-label "Back to <page name>". ⌘[ = back, ⌘] = forward (also in the app menu: View → Back / Forward, disabled when empty). No forward button in the header (shortcut + menu only).
- **Keys:** ⌘[ / ⌘] are app navigation (menu items View → Back / Forward with those accelerators; \`menu.rs\` emits \`menu:navigate\` {direction} to the main window, which already may listen). CodeMirror's default \`Mod-[\` / \`Mod-]\` (indent less/more) are removed from the editor keymap; list indentation is Tab / ⇧Tab **only when the cursor is in a list item** (elsewhere Tab keeps moving focus, so the editor never traps keyboard users; Escape then Tab always leaves).
- **Vault events:** rename → rewrite matching entries; delete → drop entries for that path (and collapse duplicates next to each other); vault close → clear.
- Back/forward navigation itself does not push; it moves the current page between stacks. The scroll position/heading of the entry is restored via `reveal(heading)`.

## 4. Palettes and custom accent (`theme/palettes.ts`, `theme/tokens.css`)

- **Built-in palettes** (ids): `lavender` (default, today's values), `graphite`, `rosewood`, `saffron`, `persimmon`, `midnight`, `sepia`, `ink`. Exact values in §10. Each defines light and dark sets of the 15 mock tokens; they map onto the app tokens:

  | Mock token | App token(s) |
  |---|---|
  | bg | `--color-bg` (+ `--color-bg-dots` = mix(bg, border, 60%)) |
  | surface | `--color-surface` (+ `--color-surface-subtle` = mix(surface, bg, 50%)) |
  | border | `--color-border` (+ `--color-border-strong` = mix(border, text, 10%)) |
  | text / strong / body / muted | `--color-text` / `--color-text-strong` / `--color-text-body` / `--color-text-muted` (+ `--color-text-faint` = mix(muted, bg, 15%)) |
  | accent / soft / contrast | `--color-accent` / `--color-accent-soft` / `--color-accent-contrast` (+ `--color-accent-hover` = mix(accent, text, 15%); `--color-focus` = accent) |
  | side / sideText / sideSel | `--color-sidebar-bg` / `--color-sidebar-text` / `--color-sidebar-selected` (new) ; drop feedback (`--color-drop-*`) derives from sideSel/accent |
  | mark / code | `--color-highlight-bg` (new; `==highlight==`) / `--color-code-bg` (new) |

  Warn colours, the coloured-text palette (`--palette-*`), radii, shadows stay shared.
- **Mechanism:** `<html data-palette="graphite" data-theme="…">`; `tokens.css` keeps Lavender on `:root`; each palette is a generated block `:root[data-palette=X]` (light) + the existing dark pattern (`@media (prefers-color-scheme: dark) :root[data-palette=X]:not([data-theme=light])` and `:root[data-palette=X][data-theme=dark]`). Generated at build time from `palettes.ts` by a small script into `theme/palettes.css` (checked in; a test asserts it is up to date). Switching is instant (attribute change).
- **Custom accent:** `palette: "custom"` + `accentColor: "#rrggbb"`. `theme/derive.ts` = the OKLCH derivation from the reference page (`derive(hex) → {light, dark}`): light accent darkened until ≥ 4.8:1 on white, dark accent lightened until ≥ 6:1 on the dark surface, chroma capped (0.17 light / 0.13 dark), neutrals tinted toward the hue (none for greys, chroma < 0.03), out-of-gamut colours reduced in chroma, `contrast` = white or #111 whichever contrasts more. Applied as inline CSS custom properties on `<html>` (style attribute — allowed by the CSP's `style-src 'unsafe-inline'`).
- **Settings → Appearance:** Light/Dark/System (as today) + a grid of palette swatch buttons (radio group, name + light/dark preview chips) + "Custom accent" (native colour input + hex field; live preview; shows the resulting contrast ratios).
- Contrast tests: every built-in palette's accent on surface ≥ 4.5:1 and text on bg ≥ 7:1 in both modes; `derive` meets its floors for a sweep of hues × lightness incl. #fff, #000, #ff0, #00f.

## 5. Fonts (`theme/fonts.ts`, `src-tauri/src/fonts.rs`)

- **Bundled (offline, @fontsource, SIL OFL 1.1):** Atkinson Hyperlegible (400, 700, 400 italic), Literata (400, 600, 400 italic), Source Serif 4 (400, 600, 400 italic), IBM Plex Sans (400, 600, 400 italic), IBM Plex Mono (400), Source Code Pro (400); already bundled: Plus Jakarta Sans, Bricolage Grotesque, JetBrains Mono. Latin + Latin-ext subsets only (size); other scripts fall back through the stack to system fonts.
- **Defaults:** Live Preview + rendered pane = Atkinson Hyperlegible; Source = JetBrains Mono; size 15 px. UI chrome keeps Plus Jakarta Sans / Bricolage.
- **Settings → Editor:** "Live Preview font", "Source font", "Text size" (13–20 px, 1 px steps). Each font picker lists: *Bundled* group, then *Installed on this computer* (families from `fonts_list`), plus "System default". Each option renders in its own font. The Split pane follows the Live Preview font; Source mode and the Split's source side follow the Source font.
- **`fonts_list` command:** async via `blocking()`; `fontdb::Database::load_system_fonts()` → unique family names (localized names → English when available), sorted case-insensitively, hidden families starting with `.` removed; cached for the app session. ACL allow + test. `fontdb` (MIT/Apache-2.0) reads local files only — `cargo deny` must stay clean.
- **Applying:** CSS custom properties `--font-live`, `--font-source`, `--font-size-editor` on `<html>`; a chosen system family is used by name in `font-family` (no `@font-face`, no file access from the webview). Unknown/missing family → falls back to the default stack.

## 6. Formatting toolbar (`features/editor/format.ts`, `Toolbar.tsx`)

- **Placement:** a row under the page header, above the editor, in all three modes (in Split it acts on the source side). Hidden/shown by a header button ("Formatting toolbar", pressed state) and Settings → Editor; remembered globally (`toolbar`, default `true`).
- **Items:** Bold, Italic, Strikethrough, Highlight, Inline code, Link │ Heading dropdown (Paragraph, H1–H6) │ Bullet list, Numbered list, Task list, Quote, Divider. ARIA toolbar pattern (roving tabindex, arrow keys), each button `aria-pressed` when the cursor is inside that style.
- **Commands** (pure functions over `EditorState` → `TransactionSpec`, one undo step each, all selections):
  - Inline (`**`, `*`, `~~`, `==`, `` ` ``): toggle — wrap the selection (or the word at an empty cursor; empty with no word → insert pair and place cursor inside); if the selection is already wrapped (inside or just outside the markers), unwrap. Markers use Obsidian forms.
  - Link: selection → `[selection](url)` with "url" selected; a selection that is a page name → `[[selection]]` when it resolves (via `links_resolve`); empty → `[]()`.
  - Heading level: set/replace the `#` prefix of every selected line; Paragraph removes it.
  - Lists/quote: toggle the line prefix on every selected line (`- `, `1. ` renumbered, `- [ ] `, `> `); switching between list kinds replaces the prefix; nested indentation kept.
  - Divider: inserts `\n---\n` on its own line.
  - "Active" state from the parsed model at the cursor (mdast ancestors), not regexes.
- **Shortcuts** (CodeMirror keymap, active with the toolbar hidden too): ⌘B, ⌘I, ⌘⇧X strikethrough, ⌘⇧H highlight, ⌘E code, ⌘K link, ⌘⌥0 paragraph, ⌘⌥1–6 headings, ⌘⇧7 numbered, ⌘⇧8 bullet, ⌘⇧9 task, ⌘⇧. quote. (Windows/Linux: Ctrl.) Shortcuts must not clash with the app menu (⌘H is Hide on macOS — highlight uses ⌘⇧H).

## 7. Settings (Rust `settings.rs`, lenient as before)

New fields with defaults: `palette: "lavender"` (unknown id → default + warning), `accentColor: "#d1477a"` (must match `^#[0-9a-fA-F]{6}$`), `fontLivePreview: "atkinson-hyperlegible"`, `fontSource: "jetbrains-mono"` (bundled id or `system:<Family Name>`, ≤ 200 chars), `fontSize: 15` (clamped 13–20), `toolbar: true`. `SettingsPatch` gains the same; the Settings dialog grows sections (Appearance, Editor, Files) and becomes scrollable.

## 8. Testing

- Unit: format commands (each item × empty cursor / word / selection / multi-selection / already formatted / undo), heading/list prefix toggling incl. renumbering; trail rules (push, reset, back/forward, rename/delete rewrite); `derive` contrast floors sweep; palette CSS generation up to date; title validation and flow (flush → rename → follow); settings parsing (Rust + TS).
- Rust: `fonts_list` (non-empty on CI hosts, no dot-families, sorted, async guard, ACL); settings leniency for each new field.
- Component: Toolbar (pressed states, roving focus, axe), Settings sections (axe), PageTitle (Enter/Escape/blur/errors, axe), back arrow visibility.
- e2e (Chromium + WebKit): toolbar bold/heading/task on a page; title rename via header; follow a link then ← back and ⌘[; palette switch changes `--color-accent`; zero-network test runs with every palette and with a system font selected.
- Real window (Jose): typing feel with Atkinson; each palette in light/dark; custom accent; toolbar in all modes; title rename with backlinks; back arrow over a few hops.

## 9. Out of scope (→ M2c and later)

Covers/subtitle editing, paste/drop attachments, `[[` autocomplete, Create-page folders (M2c); per-vault themes; user CSS snippets; importing Obsidian themes; per-page fonts; toolbar customisation (reordering items).

## 10. Palette values (from the reference page; L = light, D = dark)

Token meanings: `bg` page background · `surface` cards/header/editor · `border` · `text` default text · `strong` headings/title · `body` running text · `muted` secondary text · `accent` links/buttons/focus · `soft` accent tint · `contrast` text on accent · `side` sidebar · `sideText` sidebar text · `sideSel` sidebar selection · `mark` `==highlight==` background · `code` inline-code background.

| Token | Lavender L | Lavender D | Graphite L | Graphite D | Rosewood L | Rosewood D | Saffron L | Saffron D |
|---|---|---|---|---|---|---|---|---|
| `bg` | `#f4eff8` | `#17151c` | `#f2f3f5` | `#111216` | `#f7f0f1` | `#191315` | `#f6f4ee` | `#16140f` |
| `surface` | `#ffffff` | `#1f1d26` | `#ffffff` | `#18191e` | `#ffffff` | `#211a1d` | `#fffefb` | `#1e1b14` |
| `border` | `#e6ddef` | `#322d3d` | `#dfe1e6` | `#2a2c33` | `#ecdcdf` | `#3a2b31` | `#e7e2d4` | `#332e22` |
| `text` | `#1d1a22` | `#ece8f2` | `#17181c` | `#e7e9ee` | `#221a1c` | `#f1e8eb` | `#1f1b12` | `#efe9dc` |
| `strong` | `#2c1f4a` | `#f3eefb` | `#111827` | `#f4f5f8` | `#3d1424` | `#fbf2f5` | `#2f2410` | `#f8f3e8` |
| `body` | `#4a4058` | `#cfc8db` | `#3d4250` | `#c6cad3` | `#52404a` | `#d8c8ce` | `#4b4334` | `#d6ceba` |
| `muted` | `#6b5f80` | `#a59cb5` | `#606676` | `#949aa8` | `#76616a` | `#ab97a0` | `#6e6552` | `#a99f88` |
| `accent` | `#4b2f86` | `#b9a2e6` | `#2448c4` | `#8ea7ff` | `#8c2a4c` | `#f2a5bd` | `#8a5800` | `#f2c063` |
| `soft` | `#e9e1f4` | `#2f2742` | `#e2e8fb` | `#1f2846` | `#f4e1e7` | `#43222f` | `#f6e9cc` | `#3a2f17` |
| `contrast` | `#ffffff` | `#1b1426` | `#ffffff` | `#0d1124` | `#ffffff` | `#2a0f19` | `#ffffff` | `#231a05` |
| `side` | `#1f1d24` | `#121016` | `#17181c` | `#0b0c0f` | `#221a1d` | `#120d0f` | `#1f1c16` | `#100e0a` |
| `sideText` | `#d9d4e2` | `#d9d4e2` | `#d5d8df` | `#d2d5dc` | `#e6d6db` | `#e1d2d7` | `#e2dccd` | `#e0d8c6` |
| `sideSel` | `rgba(185,162,230,.22)` | `rgba(185,162,230,.22)` | `rgba(138,164,255,.2)` | `rgba(138,164,255,.18)` | `rgba(240,163,187,.2)` | `rgba(240,163,187,.18)` | `rgba(242,192,99,.2)` | `rgba(242,192,99,.18)` |
| `mark` | `#fbf1c7` | `#4a3f12` | `#fdf0a8` | `#4b4417` | `#fbeaa9` | `#4d4219` | `#dfeaf7` | `#1f3550` |
| `code` | `#efe9f6` | `#2a2533` | `#eceef2` | `#20222a` | `#f2e7ea` | `#2c2227` | `#f0ece1` | `#29251b` |

| Token | Persimmon L | Persimmon D | Midnight L | Midnight D | Sepia L | Sepia D | Ink L | Ink D |
|---|---|---|---|---|---|---|---|---|
| `bg` | `#f4f3f4` | `#151213` | `#eef0f8` | `#0d0f22` | `#f3ead8` | `#1c1814` | `#ffffff` | `#000000` |
| `surface` | `#ffffff` | `#1d191a` | `#ffffff` | `#141731` | `#fbf5e9` | `#241f19` | `#ffffff` | `#0a0a0a` |
| `border` | `#e4e1e4` | `#33292a` | `#dadff0` | `#252a4d` | `#e3d6bb` | `#3a3127` | `#d4d4d4` | `#3a3a3a` |
| `text` | `#1d191a` | `#f0e9e7` | `#151a2e` | `#e4e6f7` | `#2b2116` | `#ece2d0` | `#000000` | `#ffffff` |
| `strong` | `#2e1810` | `#faf3f1` | `#1b1f4a` | `#f1f2fc` | `#3b2a17` | `#f5ecdc` | `#000000` | `#ffffff` |
| `body` | `#463f40` | `#d5cac8` | `#3a4060` | `#c3c7e6` | `#4f3f2c` | `#d3c6b0` | `#1a1a1a` | `#e6e6e6` |
| `muted` | `#6a6163` | `#a8999a` | `#5d6384` | `#8d92b8` | `#75634c` | `#a8987f` | `#4d4d4d` | `#b3b3b3` |
| `accent` | `#b03f17` | `#ff9a76` | `#3b3fbf` | `#a3a8ff` | `#8b4513` | `#e3a774` | `#000000` | `#ffffff` |
| `soft` | `#fbe4da` | `#43241a` | `#e1e3fa` | `#262b5e` | `#f0dcc2` | `#44301f` | `#ececec` | `#262626` |
| `contrast` | `#ffffff` | `#2a0e04` | `#ffffff` | `#0b0d26` | `#ffffff` | `#24140a` | `#ffffff` | `#000000` |
| `side` | `#1d1a1b` | `#0f0c0d` | `#141733` | `#080918` | `#2b241b` | `#14110d` | `#000000` | `#000000` |
| `sideText` | `#e1dadb` | `#e0d6d4` | `#d2d6f0` | `#cdd1ee` | `#e7dcc8` | `#ddd1bc` | `#f2f2f2` | `#f2f2f2` |
| `sideSel` | `rgba(255,154,118,.2)` | `rgba(255,154,118,.18)` | `rgba(150,156,255,.22)` | `rgba(163,168,255,.2)` | `rgba(214,160,110,.22)` | `rgba(227,167,116,.2)` | `rgba(255,255,255,.18)` | `rgba(255,255,255,.16)` |
| `mark` | `#fcefa6` | `#4b4317` | `#f8eda6` | `#4a4318` | `#f5dd8a` | `#4d4119` | `#ffe94d` | `#6b5d00` |
| `code` | `#efecee` | `#282223` | `#e8eaf5` | `#1c2042` | `#efe3cc` | `#2c261f` | `#f0f0f0` | `#1a1a1a` |

---

## 11. Amendments from planning (plan `docs/superpowers/plans/2026-10-13-m2b-editor-ux.md`, replayed end-to-end)
These override the sections above where they conflict.

1. **Custom palette** is applied as a generated `<style id="nimw-custom-palette">` element (light + dark blocks), not inline custom properties on `<html>` — a palette needs both light and dark values, which inline properties cannot express.
2. **Derived tokens** (`bg-dots`, `surface-subtle`, `border-strong`, `text-faint`, `accent-hover`) are computed to hex when `palettes.css` is generated (and in `derive.ts` for the custom accent), not with runtime `color-mix()` — Safari 15 lacks it.
3. **View → Back / Forward** menu items carry no keyboard accelerators: the page handles ⌘[ / ⌘] itself, and a menu accelerator could fire the navigation twice. The menu items still work by click and emit `menu:navigate`.
4. **Toolbar active state** comes from CodeMirror's Lezer syntax tree (available in every mode), not the remark model (absent in Source mode); `==highlight==` is detected by scanning the cursor line.
5. **⌘K / Link** always writes `[text](url)`; turning a selected page name into `[[Page]]` moves to M2c with `[[` autocomplete.
6. **Title field** shows the file name; when the note's frontmatter `title:` or first H1 differs, it is shown underneath as "Title in the note: …".
7. **Duplicate names** are checked against the loaded tree and again via the backend's "already exists" error; both show the same message.
8. **Code** (inline and fenced) in Live Preview and the rendered pane uses the Source font.
9. **Bundled weights:** 400, 400 italic and 600 (Atkinson Hyperlegible also 700); bold in Literata, Source Serif 4 and IBM Plex Sans renders at 600.
10. **Text size** outside 13–20 is clamped (not reset to 15).
11. **Explorer selection** uses each palette's `sideSel`.
12. **Versions:** `fontdb` 0.24.0; @fontsource atkinson-hyperlegible 5.3.0, literata 5.3.0, source-serif-4 5.3.1, ibm-plex-sans 5.3.0, ibm-plex-mono 5.3.0, source-code-pro 5.3.1. CI installs Playwright `chromium webkit`.

## 12. Amendments from Jose's real-window check (2026-10-13)
These override the sections above (and M2a §3.2 / ED-04) where they conflict.

1. **Links in Live Preview follow on a plain click**, as in Obsidian: a click on a link shown rendered (its line is not touched by the selection) opens it — resolved page, `#heading`, "Create page" for an unresolved target, confirmation for a web link. On the cursor line the link shows its source and a click places the cursor (that is how a link is edited; arrow keys work too). Shift-click extends the selection; ⌘/Ctrl-click and ⌘↩ still follow any link.
2. **Line numbers** (`lineNumbers`, default `false`; Settings → Editor "Show line numbers"; View → Toggle Line Numbers): a CodeMirror gutter in Live Preview and Source, and on the source side of Split (the rendered pane has no lines). In Live Preview the gutter sits beside the centred text. Lines inside a rendered block widget (table, callout, columns, rule, lone embed) carry no number, so the count jumps past them, as in Obsidian.
3. **Formatting-toolbar toggle**: the header button is a bordered "Format" button with an icon (accessible name "Formatting toolbar", `aria-pressed`), styled like the mode switch, whose tooltip says what a click does ("Hide/Show the formatting toolbar"). View → Toggle Formatting Toolbar flips it too. The View items are plain (no checkmark): they emit `menu:toggle` with the settings key (`"toolbar"` / `"lineNumbers"`) and the page flips the setting.
4. **Top bar**: the Edit · Global view group uses the same box as the settings / close buttons — 40 px high, 1 px `border-strong`, `radius-md`, surface background; the selected segment keeps the accent-soft fill.
5. **Block widgets** in Live Preview render with `white-space: normal` (CodeMirror's pre-wrapped whitespace turned the renderer's newline text nodes into blank lines above tables and callouts).
