# Hand-off: M0 Scaffold — Notes In My Way

> **Date:** 2026-10-12 · **Branch:** merged into `main` (merge commit `b7532b4`; the 20 M0 commits sat on `feat/m0-scaffold` on top of `9c47e19`; branch deleted). Not pushed; no remote configured.
> **Audience:** Jose (tech lead), or anyone continuing this work by hand without an AI agent.
> **Goal of this file:** everything you need to understand, run, verify, change and continue the M0 scaffold: what exists, why it is that way, every decision made on your behalf, what is *not* verified, and where M1 starts.

---

## Table of contents

1. [Status at a glance](#1-status-at-a-glance)
2. [Document map](#2-document-map)
3. [Decisions already taken (product + architecture)](#3-decisions-already-taken)
4. [Setting up a machine from zero](#4-setting-up-a-machine-from-zero)
5. [Day-to-day commands](#5-day-to-day-commands)
6. [Repository tour, file by file](#6-repository-tour-file-by-file)
7. [How the pieces connect (end-to-end walkthrough)](#7-how-the-pieces-connect)
8. [Recipes: how to extend the scaffold](#8-recipes)
9. [Privacy enforcement: the layers and how to check them](#9-privacy-enforcement)
10. [Tests: full inventory](#10-tests-full-inventory)
11. [CI pipeline](#11-ci-pipeline)
12. [Commit history of the branch](#12-commit-history)
13. [Rulings made on your behalf](#13-rulings-made-on-your-behalf)
14. [What is NOT verified — your manual checklist](#14-what-is-not-verified)
15. [Known gaps and deferred items (by milestone)](#15-known-gaps-and-deferred-items)
16. [Troubleshooting](#16-troubleshooting)
17. [Where M1 starts](#17-where-m1-starts)
18. [How this was built (process notes)](#18-how-this-was-built)

---

## 1. Status at a glance

| Area | State |
|---|---|
| Product spec | v0.2, **all 22 open questions + 2 gaps closed** (`docs/product-spec.md`) |
| Architecture | Approved plan doc (`docs/superpowers/specs/2026-10-12-architecture-design.md`) |
| M0 scaffold | **Implemented, reviewed, fixed, merged into `main`** (`b7532b4`) |
| Automated checks | `pnpm check` green (57 Vitest tests + 25 Rust tests incl. 3 real-IPC tests), `cargo deny check` ok |
| Real app window | **Verified on macOS** with screenshots: fonts, V0.1.0 via real IPC, live dark/light, Spanish OS locale (bundled app). Open: keyboard Tab reachability in WKWebView (see §14) |
| CI on GitHub | Workflow written; **never run on real runners** (no remote yet) |
| Merge | **Merged locally into `main`**; full `pnpm check` + `cargo deny check` re-run green on the merged result. Not pushed (see §17.1) |

What M0 deliberately does **not** contain: any vault, file, editor, Global View, search, audio or import functionality. Those are M1–M7. The welcome screen's four vault buttons are disabled with the note "Vault actions arrive in the next milestone."

---

## 2. Document map

| File | What it is | When to read it |
|---|---|---|
| `docs/product-spec.md` | Product spec v0.2: every requirement ID (VLT-, EXP-, PG-, GV-, ED-, DND-, AUD-, SR-, IMP-, NFR-), acceptance criteria, resolved questions (§10), decision log (§13) | Before building any feature: it is the *what* |
| `docs/superpowers/specs/2026-10-12-architecture-design.md` | Architecture: stack, repo layout, storage, frontmatter schema, Tier B syntax, runtime flows, IPC surface, privacy layers, testing, milestones M0–M8 | Before any structural change: it is the *how* |
| `docs/superpowers/plans/2026-10-12-m0-scaffold.md` | The 9-task implementation plan executed for M0 (full code per step) | To understand why a file looks the way it does |
| `docs/handoff/2026-10-12-m0-scaffold-handoff.md` | This file | Start here |
| `README.md` | Short onboarding: prerequisites, commands, layout, privacy summary | Quick reference |
| `design/prototype/` | Clickable HTML prototype (design reference only, never shipped). Open with `python3 -m http.server` inside that folder, then `Main.dc.html` | When porting UI: colors, spacing, copy |
| `LICENSE` | GPL-3.0 text (SPDX rendering — see §15) | — |

Requirement IDs are referenced in commit messages, test names and code comments (e.g. `PG-01`, `NFR-04`). `git log --grep NFR-04` and `grep -rn "NFR-04"` find everything related to a requirement.

---

## 3. Decisions already taken

### 3.1 Product decisions (spec §10, all DECIDED 2026-10-12 by Jose)

| ID | Decision |
|---|---|
| Q-IMP-1 | "Note" = **Notion**; Notion export importer is **in MVP** |
| Q-IMP-2 | No explicit export in MVP (the folder is the export) |
| Q-SEC-1..4 | Encryption **post-MVP**, whole-vault; unreadable by other tools while locked (accepted); lost password = lost data, with a clear warning |
| Q-FMT-1 | Tier B: columns, **toggles** (foldable callouts), **highlights** `==x==`, **colored text** `<span data-color>`, dividers. No callout colors / page icons |
| Q-PG-1 | Subtitle from frontmatter `subtitle:` |
| Q-GV-1 | Index note = page named like the folder or `index.md`; else user pick (stored in `.nimw/vault.json`); else folder summary card |
| Q-GV-2 | Root pages appear at level 0 as page cards |
| Q-GV-3 | Single-clicking a page shows its neighborhood (outgoing links, backlinks, relationships) |
| Q-GV-4 | Manual relationships may have an optional label |
| Q-GV-5 | Relationships stored in the **source page's frontmatter** (`related:`) |
| Q-GV-6 | Drill-down/Expand toggle is global and persisted |
| Q-GV-7 | Aggregated edges between visible cards (with count) + a toggle |
| Q-DND-1 | Dragging a heading moves its whole section (Alt-drag = line only) |
| Q-ED-1 | Attachments configurable; default `attachments/` subfolder next to the page; honors Obsidian's `attachmentFolderPath` |
| Q-AUD-1 | Global setting, **default WAV** (switchable per take) |
| Q-SR-1 | Full-text search yes; metadata matches rank higher |
| Q-I18N-1 | First language from OS locale; changeable on welcome screen |
| Q-UI-1 | Light + dark, follow OS, override in Settings |
| Q-UPD-1 | Manual updates only; app never phones home |
| Q-A11Y-1 | Keyboard + screen-reader basics, WCAG AA |
| Gap: links | File name is canonical for `[[links]]` (Obsidian rules); autocomplete inserts `[[file|Title]]` when they differ (PG-05) |
| Gap: projects | Dot-folders ignored everywhere; attachment folders hidden from Global View; user exclude globs (VLT-05) |
| All [PROPOSED] items | Promoted to DECIDED |

### 3.2 Architecture decisions

| Area | Decision |
|---|---|
| Shell | **Tauri 2** (system webviews: WebView2 / WKWebView / WebKitGTK) |
| Core | Rust crates under `crates/`, **never depending on Tauri** |
| UI | React 19 + TypeScript 6.0 + Vite 8, CSS Modules + CSS custom-property tokens (no Tailwind) |
| Editor (M2) | CodeMirror 6 (Live Preview via decorations, Source, Split) |
| Canvas (M3) | React Flow + elkjs |
| Index/search (M1/M5) | SQLite + FTS5 via rusqlite |
| i18n | i18next + ICU message format |
| License | **GPL-3.0-or-later** |
| Platforms | macOS, Windows, Linux (.deb, .AppImage) **shipped simultaneously** |
| Bundle identifier | `app.notesinmyway.desktop` — names OS config/cache dirs; **must not change after first release**. Change it now if you own a domain |

---

## 4. Setting up a machine from zero

### 4.1 Toolchain

| Tool | Version | Install |
|---|---|---|
| Node | ≥ 22.18 (24 LTS recommended; `.nvmrc` says 24; your Mac runs 26 fine) | nvm/fnm/Homebrew |
| pnpm | 12.11.2 (pinned in root `package.json` → `packageManager`) | `npm install -g pnpm@12.11.2` |
| Rust | 1.99.0 (pinned in `rust-toolchain.toml`) | **rustup recommended** (it honors the pin automatically). Your Mac uses Homebrew `rustc` 1.99.0, which ignores `rust-toolchain.toml` — fine as long as `rustc --version` ≥ 1.99 |
| cargo-deny | ≥ 0.20 | `brew install cargo-deny` or `cargo install cargo-deny --locked` |

### 4.2 Platform dependencies (Tauri 2)

- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Windows:** Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (preinstalled on Windows 11).
- **Linux (Debian/Ubuntu):**
  ```bash
  sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```
  (CI only needs `libwebkit2gtk-4.1-dev libdbus-1-dev pkg-config build-essential` because it doesn't bundle.)

### 4.3 First run

```bash
git clone <repo> notes-in-my-way && cd notes-in-my-way
pnpm install                           # JS deps for the whole workspace
pnpm build:ui                          # REQUIRED before any cargo build/test (see 16.1)
cargo test --workspace                 # Rust: 25 tests
pnpm test                              # Vitest: 57 tests
pnpm dev                               # opens the app window with hot reload
```

---

## 5. Day-to-day commands

All from the repo root.

| Command | What it does | Notes |
|---|---|---|
| `pnpm dev` | `tauri dev`: starts Vite on `http://localhost:1420`, compiles the Rust shell, opens the window. Frontend hot-reloads; Rust changes trigger a rebuild | Dev mode has **no CSP** (`devCsp: null`) because Vite injects an inline React-refresh script |
| `pnpm build` | `tauri build`: production installers for the current OS | Unsigned; signing is M8 |
| `pnpm --filter @nimw/desktop tauri build --debug --no-bundle` | Fast production-CSP debug binary at `target/debug/nimw-desktop` | Use this to check the real CSP/capabilities |
| `pnpm build:ui` | `tsc --noEmit && vite build` → `apps/desktop/dist` | Needed before cargo commands |
| `pnpm test` | Vitest, all frontend tests | `pnpm test -- <path>` does **not** filter |
| `pnpm --filter @nimw/desktop exec vitest run <files>` | Focused Vitest run | e.g. `... vitest run src/i18n` |
| `pnpm lint` | ESLint (incl. network ban) + `prettier --check .` | `pnpm format` fixes Prettier diffs |
| `pnpm typecheck` | `tsc --noEmit` | |
| `pnpm check:i18n` | Locale key-parity check (`node scripts/check-i18n.ts`, uses Node type stripping) | Exit 1 lists missing keys as `es: welcome.recent` |
| `cargo test --workspace` | All Rust tests (5 crates + shell + IPC integration tests) | Needs `apps/desktop/dist` |
| `cargo clippy --workspace --all-targets -- -D warnings` | Lints, warnings are errors | |
| `cargo fmt --all` | Format Rust | `style_edition = "2024"` |
| `cargo deny check` | Advisories, banned crates, licenses, sources | |
| `pnpm check` | **Everything CI runs**: lint, typecheck, test, check:i18n, build:ui, fmt --check, clippy, cargo test | Run before every commit/PR |

---

## 6. Repository tour, file by file

### 6.1 Root

| File | Purpose |
|---|---|
| `Cargo.toml` | Cargo workspace: members `crates/*` + `apps/desktop/src-tauri`; shared `[workspace.package]` (version 0.1.0, edition 2024, GPL-3.0-or-later, `publish = false`); shared dependency versions; lints (`unsafe_code = "forbid"`, clippy `all = warn`) |
| `Cargo.lock` | Committed (this is an app). Contains `reqwest`/`hyper` only because Tauri lists them for **mobile** targets; they are not compiled for desktop (see §13 ruling 4) |
| `rust-toolchain.toml` | Pins Rust 1.99.0 + rustfmt + clippy (rustup/CI) |
| `rustfmt.toml` | `style_edition = "2024"` |
| `deny.toml` | cargo-deny config — see §9 |
| `package.json` | Root pnpm workspace scripts (see §5), `packageManager: pnpm@12.11.2`, `engines.node >= 22.18`, Prettier |
| `pnpm-workspace.yaml` | Workspace = `apps/*`; `minimumReleaseAgeExclude` list (see 16.4) |
| `pnpm-lock.yaml` | Committed lockfile |
| `.prettierrc.json` / `.prettierignore` | `singleQuote`, `printWidth: 100`; ignores docs, markdown, design, generated files |
| `.editorconfig`, `.gitignore`, `.nvmrc` | Editor conventions, ignores (incl. `src-tauri/gen/schemas/`, `.playwright-mcp/`), Node 24 |
| `.github/workflows/ci.yml` | CI — see §11 |
| `LICENSE` | GPL-3.0 |
| `README.md` | Short onboarding |
| `design/prototype/` | Unzipped prototype (was `Clickable prototype-html.zip`) |
| `docs/` | Specs, plan, this hand-off |

### 6.2 Rust core crates (`crates/`)

Each crate is a stub with **one real, tested function** that M1+ will use. None depends on Tauri, so `cargo test -p <crate>` needs no UI build.

| Crate | Public API today | Requirement | Tests | Notes for the future |
|---|---|---|---|---|
| `nimw-markdown` | `extract_title(source: &str, file_stem: &str) -> String` — visible text of the first non-empty H1 (ATX or setext), inline formatting flattened, whitespace collapsed; YAML frontmatter is skipped (pulldown-cmark `ENABLE_YAML_STYLE_METADATA_BLOCKS`); else the file stem | PG-01 | 8 | Becomes the metadata extractor (frontmatter, tags, links with byte offsets) in M1. Uses `pulldown-cmark 0.13.4` without default features |
| `nimw-vault` | `is_hidden_name(name: &str) -> bool` — true for names starting with `.` (incl. `.` and `..`) | VLT-05 | 2 | Becomes scanning, watching (`notify`), atomic CAS writes, trash, link rewrite in M1 |
| `nimw-index` | `cache_dir_name(vault_abs_path: &Path) -> String` — first 16 hex chars of SHA-256 of the path's OS-encoded bytes (caller must canonicalize) | arch §3.1 | 2 | Becomes the SQLite/FTS5 index in M1/M5. Windows `\\?\` prefix normalization is still TODO (§15) |
| `nimw-audio` | `enum RecordingFormat { Wav (default), Mp3 }`, `.extension()`, serde `"wav"`/`"mp3"` | AUD-02, Q-AUD-1 | 3 | Becomes cpal capture + WAV/MP3 encoding in M6 |
| `nimw-import` | `strip_notion_id(name: &str) -> String` — removes a trailing ` <32 lowercase hex>` before end/`.`/`_` (keeps extension and `_all.csv`), last match wins, UTF-8 safe | IMP-02 | 5 | Becomes the Notion importer in M7. Edge: a name that is *only* an ID returns `""` (§15) |

### 6.3 Tauri shell (`apps/desktop/src-tauri/`)

| File | Purpose |
|---|---|
| `Cargo.toml` | Crate `nimw-desktop`, lib name `nimw_desktop`. Deps: `tauri 2.12.3`, `serde`. Dev-deps: `serde_json`, `tauri` with `test` feature. Does **not** inherit `unsafe_code = "forbid"` (Tauri macros may emit `unsafe`) |
| `build.rs` | `tauri_build::try_build` with an **AppManifest listing `["app_info"]`**. This switches Tauri to "every app command needs an explicit permission" mode and autogenerates `permissions/autogenerated/app_info.toml` (`allow-app-info`/`deny-app-info`) |
| `capabilities/main.json` | The only capability: window `main` may call **only** `allow-app-info`. No `core:default`, no plugins |
| `tauri.conf.json` | Product name, version 0.1.0, identifier, window (1280×820, min 900×600, label `main`), **production CSP** (exact string in §9), `freezePrototype: true`, `withGlobalTauri: false`, `dangerousDisableAssetCspModification: ["style-src"]`, `devCsp: null`, bundle targets `app, dmg, msi, nsis, deb, appimage`, macOS min 12.0 |
| `Info.plist` | Merged into the macOS bundle: `CFBundleLocalizations = [en, es]` so WKWebView reports Spanish in `navigator.languages` on a Spanish Mac (unverified — §14) |
| `src/main.rs` | Binary entry; hides the console on Windows release builds; calls `nimw_desktop::run()` |
| `src/lib.rs` | `configure(builder)` registers commands (shared by `run()` and tests); `run()` builds with `generate_context!()` |
| `src/commands.rs` | `AppInfo { name, version }` (camelCase serde), `build_app_info()` (name constant + `CARGO_PKG_VERSION`), `#[tauri::command] app_info()` + 2 unit tests |
| `tests/ipc.rs` | 3 integration tests driving the **real** context + capability through Tauri's mock runtime (see §10) |
| `icons/` | Generated from `icons/app-icon.svg` (prototype brand mark) via `pnpm --filter @nimw/desktop tauri icon src-tauri/icons/app-icon.svg`. Only desktop icons kept |
| `permissions/autogenerated/app_info.toml` | Generated by `tauri-build`; tracked by Tauri convention; do not edit |
| `gen/schemas/` | Generated, git-ignored |

### 6.4 Frontend (`apps/desktop/`)

| File | Purpose |
|---|---|
| `package.json` | `@nimw/desktop` (ESM). Scripts: `dev` (vite), `build`, `tauri`, `test` (vitest run), `lint`, `typecheck`, `check:i18n` |
| `index.html` | Root `<div id="root">`, no inline scripts (CSP `script-src 'self'`) |
| `vite.config.ts` | Port 1420 strict; ignores `src-tauri` in watch; build target `es2021/chrome105/safari15`; **`assetsInlineLimit: 0`** (fonts must never become `data:` URIs, CSP `font-src 'self'`); Vitest: jsdom, `css: true`, setup file, test globs |
| `tsconfig.json` | Strict, bundler resolution, `allowImportingTsExtensions` (for the Node-run i18n script), types `vite/client` + `node` |
| `eslint.config.js` | Flat config: JS + typescript-eslint recommended, react-hooks rules, **network ban** and **backend-import ban** (§9) |
| `scripts/check-i18n.ts` | CLI for locale parity; reads `src/i18n/locales/*.json` |
| `tests/network-ban.test.ts` | Lints code snippets through the real ESLint config to prove the bans fire (node environment) |
| `src/main.tsx` | Imports `tokens.css` + `base.css`, `applyTheme('system')`, `initI18n(detectLanguage(navigator.languages))`, then renders `<App/>` in StrictMode (no top-level await — Safari 15 target) |
| `src/app/App.tsx` | Holds `screen` state (`'welcome'` for now; M1 drives it from vault state) and the version from `useAppVersion` |
| `src/app/ScreenRouter.tsx` | `type Screen = 'welcome' \| 'global' \| 'editor'`; exhaustive switch to `Welcome` / `GlobalViewScreen` / `EditorScreen` |
| `src/app/useAppVersion.ts` | Calls `appInfo()`; cancels on unmount; on error: **silent outside Tauri**, `console.error` inside Tauri (`isTauri()`) |
| `src/app/icons.tsx` | SVG icons from the prototype (`BrandMark`, `PlusIcon`, `FolderIcon`, `VaultIcon`, `ImportIcon`, `LockIcon`); colors via tokens / `currentColor` |
| `src/features/welcome/Welcome.tsx` + `.module.css` | Ported welcome card: brand + version, title, tagline, language segmented toggle (`aria-pressed`, `lang` attr), 4 disabled actions each `aria-describedby` the coming-soon note, "Recent" (empty state), privacy footer |
| `src/features/global-view/GlobalViewScreen.tsx` | Stub (`<h1>Global view</h1>`), replaced in M3 |
| `src/features/editor/EditorScreen.tsx` | Stub (`<h1>Edit</h1>`), replaced in M2 |
| `src/ipc/index.ts` | **The only module that may import `@tauri-apps/api`.** Exports `AppInfo`, `appInfo()`, `isTauri` |
| `src/i18n/index.ts` | Locale registry `LOCALES = { en, es }`, `Language`, `SUPPORTED_LANGUAGES`, `detectLanguage()`, `initI18n()` (ICU plugin, react-i18next, keeps `<html lang>` in sync) |
| `src/i18n/parity.ts` | `findMissingKeys(locales)` — symmetric nested-key comparison |
| `src/i18n/locales/{en,es}.json` | 16 keys each (app, welcome, languages, screens, privacy) |
| `src/theme/tokens.css` | All design tokens (31 names). Light on `:root`; dark under `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])` **and** `:root[data-theme='dark']` (duplicated block — §13 ruling 6) |
| `src/theme/base.css` | `@fontsource` imports (Plus Jakarta Sans 400/500/600/700, Bricolage Grotesque 500/700, JetBrains Mono 400/500), box-sizing, body defaults, global `:focus-visible` outline |
| `src/theme/theme.ts` | `applyTheme('system'\|'light'\|'dark', root?)` — sets/removes `data-theme` |
| `src/test/setup.ts` | jest-dom matchers, i18n init (`en`) before all, reset to `en` before each, RTL cleanup |

---

## 7. How the pieces connect

### 7.1 Startup sequence (production)

1. OS starts `nimw-desktop` → `main()` → `nimw_desktop::run()`.
2. `run()` = `configure(Builder::default())` (registers `app_info`) + `generate_context!()` (embeds `tauri.conf.json`, the capability files and `apps/desktop/dist`).
3. Tauri opens window `main` and serves `dist/index.html` over its custom protocol with the CSP header from `tauri.conf.json` (style-src left untouched by Tauri's nonce injection).
4. `main.tsx`: CSS tokens + fonts load (local files, `font-src 'self'`) → `applyTheme('system')` (no `data-theme`, so CSS follows the OS) → `detectLanguage(navigator.languages)` → `initI18n(lang)` (also sets `<html lang>`) → render `<App/>`.
5. `App` renders `ScreenRouter screen="welcome"`; `useAppVersion` calls `appInfo()`.

### 7.2 The IPC round trip (`app_info`)

```
Welcome (version label)
  ← App ← useAppVersion()                       src/app/useAppVersion.ts
      → appInfo()                               src/ipc/index.ts   (invoke<AppInfo>('app_info'))
        → @tauri-apps/api/core invoke           (only importable inside src/ipc/)
          → Tauri IPC (connect-src ipc: http://ipc.localhost)
            → ACL check: window "main" has capability "main" granting "allow-app-info"
                                                 capabilities/main.json + build.rs AppManifest
              → commands::app_info()             src-tauri/src/commands.rs
              ← { "name": "Notes In My Way", "version": "0.1.0" }  (camelCase serde)
```

If any link breaks:
- **Inside Tauri:** the label is hidden **and** `console.error('app_info IPC failed', …)` appears in devtools.
- **Plain browser (`pnpm --filter @nimw/desktop dev`):** the label is hidden silently (no Tauri internals).
- **Tests:** `tests/ipc.rs` fails (real context + ACL), `ipc.test.ts` / `ScreenRouter.test.tsx` / `useAppVersion.test.tsx` cover the TS side.

### 7.3 Theme flow

`applyTheme('system')` removes `data-theme` → the `prefers-color-scheme: dark` media query decides, live, with no JS listener. `applyTheme('light'|'dark')` sets `data-theme`, overriding the OS. The Settings screen (later milestone) will call `applyTheme` with the persisted preference.

### 7.4 Language flow

`detectLanguage(navigator.languages)` picks the first supported base language (`es-MX`, `es_ES`, `ES`, `es-419` → `es`), else `en`. The welcome toggle calls `i18n.changeLanguage(lng)`; react-i18next re-renders and `<html lang>` follows. **The choice is not persisted yet** (§15).

---

## 8. Recipes

### 8.1 Add a new backend command (the pattern every milestone follows)

1. **Core logic** in the right `crates/nimw-*` crate, with unit tests (no Tauri).
2. **Command** in `apps/desktop/src-tauri/src/commands.rs` (or a new module): `#[tauri::command] pub fn my_cmd(...) -> Result<T, Error>`; keep it a thin adapter over the crate.
3. **Register** it in `lib.rs` → `configure()` → `generate_handler![commands::app_info, commands::my_cmd]`.
4. **Declare** it in `build.rs` → `AppManifest::new().commands(&["app_info", "my_cmd"])`.
5. **Grant** it in `capabilities/main.json` → `"permissions": ["allow-app-info", "allow-my-cmd"]` (kebab-case of the command name; check `apps/desktop/src-tauri/gen/schemas/desktop-schema.json` if unsure).
6. **Wrap** it in `apps/desktop/src/ipc/index.ts` as a typed function. Never call `invoke` anywhere else (ESLint will stop you).
7. **Test**: Rust unit test for the command, an integration test in `tests/ipc.rs` (copy `app_info_is_callable_from_the_main_window`), and a Vitest test with `mockIPC` for the wrapper.
8. Run `pnpm check`.

Forgetting step 4 or 5 → the call is rejected by the ACL; the IPC integration test catches it.

### 8.2 Add a Tauri plugin (e.g. dialog, opener for the donations link)

`pnpm --filter @nimw/desktop tauri add <plugin>` then grant **only** the needed permissions in `capabilities/main.json`, scoped as tightly as possible (e.g. opener scoped to the single donations URL, arch §6.1). Network plugins (`http`, `updater`, `shell`, `websocket`, `upload`) are **banned** in `deny.toml` and must stay banned. Import the plugin's JS API only inside `src/ipc/`.

### 8.3 Add a UI string

1. Add the key to **both** `src/i18n/locales/en.json` and `es.json`.
2. Use `const { t } = useTranslation(); t('group.key')`. ICU syntax: `{name}` for interpolation, `{count, plural, one {# note} other {# notes}}` for plurals.
3. `pnpm check:i18n` must stay green.

### 8.4 Add a language (NFR-07)

1. Create `src/i18n/locales/<code>.json` with every key.
2. Add it to `LOCALES` in `src/i18n/index.ts` (one line) and add `languages.<code>` to every locale file.
3. Add `<code>` to `CFBundleLocalizations` in `src-tauri/Info.plist`.
4. Update the `NFR-07 registry lists en and es` test.

### 8.5 Add/adjust a design token

Edit `src/theme/tokens.css`: light value in `:root`, dark value in **both** dark blocks (media query and `[data-theme='dark']`). Use it via `var(--token)` in a CSS Module. Never hard-code colors in components.

### 8.6 Add a screen

Create `src/features/<name>/<Name>Screen.tsx` (+ `.module.css`), extend the `Screen` union and the switch in `ScreenRouter.tsx` (TypeScript forces exhaustiveness), add a router test.

---

## 9. Privacy enforcement

Principle P1 / NFR-04: the app makes **zero** network requests. Four layers enforce it today:

| # | Layer | Where | What it blocks | How to check |
|---|---|---|---|---|
| 1 | **CSP** (runtime, webview) | `tauri.conf.json` → `app.security.csp` | Any `fetch`/XHR/WebSocket/EventSource to anything but IPC; remote images/fonts/media/frames/objects; forms; `<base>` | Built app devtools: no CSP violations; a remote `<img>` would be blocked |
| 2 | **Capability allowlist** (runtime, IPC) | `build.rs` AppManifest + `capabilities/main.json` | Any backend command or plugin not explicitly granted to window `main` | `cargo test -p nimw-desktop --test ipc` |
| 3 | **ESLint bans** (build time, TS) | `apps/desktop/eslint.config.js` | Globals `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`; the same via `window.`/`globalThis.`/`self.` (dot, bracket, destructuring); `sendBeacon` on any object chain; importing `@tauri-apps/api`, `@tauri-apps/api/*` or `@tauri-apps/plugin-*` outside `src/ipc/` (`@tauri-apps/api/mocks` allowed only in `*.test.ts(x)`) | `pnpm lint`; `tests/network-ban.test.ts` |
| 4 | **cargo-deny bans** (build time, Rust) | `deny.toml` | Crates `reqwest`, `ureq`, `isahc`, `curl`, `hyper`, `h2`, `attohttpc`, `tungstenite`, `tokio-tungstenite`, `tauri-plugin-{http,updater,shell,websocket,upload}` in the **desktop** dependency graph | `cargo deny check` |

Exact production CSP:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' asset: http://asset.localhost data: blob:;
media-src 'self' asset: http://asset.localhost blob:; font-src 'self';
connect-src ipc: http://ipc.localhost; frame-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'
```

Why `style-src 'unsafe-inline'` + `dangerousDisableAssetCspModification: ["style-src"]`: if Tauri injected a style nonce, browsers would ignore `'unsafe-inline'` and React `style={…}` attributes would be blocked. Scripts remain strictly `'self'`.

Known limits (documented, accepted): dynamic computed keys (`const k='fetch'; window[k]()`) evade static lint — the CSP is the backstop. The planned **end-to-end zero-network test** (fixture vault full of remote references + recording proxy, arch §6.1 layer 3) is not built yet — it needs vault content, so it belongs to M2.

---

## 10. Tests: full inventory

### 10.1 Rust (25 tests) — `cargo test --workspace`

| Location | Test | Pins |
|---|---|---|
| `crates/nimw-markdown/src/title.rs` | `pg_01_title_from_first_h1`, `pg_01_falls_back_to_file_stem`, `pg_01_h2_is_not_a_title`, `pg_01_ignores_hash_lines_inside_frontmatter`, `pg_01_first_h1_anywhere_in_the_page`, `pg_01_setext_h1_counts`, `pg_01_inline_formatting_is_flattened`, `pg_01_empty_h1_is_skipped` | PG-01 incl. H1 look-alikes (Review Focus 2) |
| `crates/nimw-vault/src/lib.rs` | `vlt_05_dot_folders_are_hidden`, `vlt_05_regular_names_are_visible` | VLT-05 |
| `crates/nimw-index/src/lib.rs` | `cache_name_is_sha256_prefix_of_path` (fixed vectors), `cache_name_is_16_lowercase_hex_chars` | arch §3.1 |
| `crates/nimw-audio/src/lib.rs` | `aud_02_default_format_is_wav`, `aud_02_extensions`, `aud_02_serializes_lowercase` | AUD-02, Q-AUD-1 |
| `crates/nimw-import/src/lib.rs` | `imp_02_strips_id_from_page_file`, `imp_02_strips_id_from_folder`, `imp_02_keeps_database_csv_suffix`, `imp_02_handles_dots_and_non_ascii_in_name`, `imp_02_leaves_non_ids_untouched` | IMP-02 (Review Focus 3) |
| `apps/desktop/src-tauri/src/commands.rs` | `app_info_reports_name_and_crate_version`, `app_info_serializes_camel_case` | IPC payload contract |
| `apps/desktop/src-tauri/tests/ipc.rs` | `app_info_is_callable_from_the_main_window`, `unregistered_command_is_rejected`, `app_info_is_denied_outside_the_main_window` | Real context + ACL path (mutation-verified: removing `allow-app-info` makes the first fail) |

### 10.2 Frontend (57 tests, 8 files) — `pnpm test`

| File | Covers |
|---|---|
| `src/ipc/ipc.test.ts` | `appInfo()` invokes `app_info` and returns the typed payload (mockIPC) |
| `tests/network-ban.test.ts` | NFR-04: global network APIs rejected; indirect forms (`window.fetch`, `globalThis['fetch']`, destructuring, `self.WebSocket`, `navigator.sendBeacon`, `window.navigator.sendBeacon`, …) rejected; backend imports rejected outside `src/ipc` (root, `/core`, `/event`, `plugin-http`), mocks allowed only in tests, core allowed inside `src/ipc` (Review Focus 5) |
| `src/theme/theme.test.ts` | Q-UI-1: `system` removes override; `light`/`dark` set it; default root |
| `src/i18n/i18n.test.ts` | Q-I18N-1 `detectLanguage` (9 locale-tag cases incl. `es_ES`, `ES`, `es-419`, empty, blank — Review Focus 1); NFR-07 registry; ICU interpolation; NFR-10 `<html lang>` sync |
| `src/i18n/parity.test.ts` | NFR-07 parity algorithm + shipped locales in parity |
| `src/features/welcome/Welcome.test.tsx` | Name/tagline/4 disabled actions/version; accessible description on each action; Q-I18N-1 toggle to Spanish (`aria-pressed`); version hidden when unknown; NFR-10 axe (color-contrast disabled in jsdom) |
| `src/app/ScreenRouter.test.tsx` | Each screen renders; `App` shows the backend version; `App` still renders outside Tauri (Review Focus 4) |
| `src/app/useAppVersion.test.tsx` | Version from backend; logs IPC failure inside Tauri; silent outside Tauri |

---

## 11. CI pipeline

`.github/workflows/ci.yml`, triggered on push to `main` and on pull requests; `contents: read`; superseded runs cancelled.

| Job | Runner | Steps |
|---|---|---|
| `frontend` | ubuntu-latest | checkout → pnpm (from `packageManager`) → Node from `.nvmrc` (cached) → `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm check:i18n` |
| `rust` | ubuntu, macos, windows (`fail-fast: false`) | checkout → Linux apt deps → `actions-rust-lang/setup-rust-toolchain` (honors `rust-toolchain.toml`, caches) → pnpm + Node → install → **`pnpm build:ui`** → `cargo fmt --check` (Linux only) → `cargo clippy --workspace --all-targets --locked -D warnings` → `cargo test --workspace --locked` |
| `deny` | ubuntu-latest | `EmbarkStudios/cargo-deny-action@v2` (full `cargo deny check`) |

**Never executed yet** (no GitHub remote). First run is the real test of: the apt package list on `ubuntu-latest`, `pnpm/action-setup@v4` with pnpm 12, Windows/macOS Tauri builds. Release/bundle/signing workflows are M8.

---

## 12. Commit history

`git log --oneline 9c47e19..b7532b4^2` (the merged branch's commits, oldest at bottom; the merge commit itself is `b7532b4`):

| Commit | Subject | Plan task |
|---|---|---|
| `5bdce3d` | chore: drop mobile icons and document release-age exclusions | final fix F8 |
| `96ef91c` | chore: broaden cargo-deny network bans | final fix F6 |
| `035f388` | ci: correct Linux system deps and document prerequisites | final fix F5 |
| `75345af` | fix: ban sendBeacon on any object chain | final fix F7 |
| `88e9aa8` | fix: keep keyboard focus ring visible on language toggle (NFR-10) | final fix F2 |
| `144f81f` | fix: sync html lang with UI language and add macOS bundle localizations (NFR-10, Q-I18N-1) | final fix F3/F4 |
| `d7a9abf` | fix: log IPC failures inside Tauri instead of hiding them | final fix F1b |
| `5249104` | test: exercise real IPC and capability path for app_info | final fix F1a |
| `cd1cf74` | docs: README with setup, commands and privacy guarantees | Task 9 |
| `a0de679` | ci: lint/test matrix, cargo-deny license and network-crate bans (NFR-04, NFR-09) | Task 8 |
| `5ca77da` | fix: attach coming-soon description to the disabled welcome actions (NFR-10) | Task 7 fix |
| `0026017` | feat: app shell, screen router stubs and welcome screen from prototype (Q-I18N-1, NFR-10) | Task 7 |
| `0684e54` | feat: i18n en/es with ICU, OS-locale detection and key parity check (NFR-07, Q-I18N-1) | Task 6 |
| `392f3d4` | feat: design tokens (light + dark following OS), bundled fonts (Q-UI-1) | Task 5 |
| `091523b` | fix: cover bracket/destructuring network bans and widen backend import ban | Task 4 fix |
| `d84cd00` | feat: typed ipc module and eslint network ban (NFR-04) | Task 4 |
| `60a24c8` | feat: tauri 2 shell with locked CSP/capabilities and app_info command (NFR-04) | Task 3 |
| `e82bc23` | feat: cargo workspace with core crate stubs (PG-01, VLT-05, AUD-02, IMP-02) | Task 2 |
| `5895f70` | chore: repo hygiene, GPL-3.0-or-later license, move spec and prototype | Task 1 |

On `main`: `9c47e19` (M0 plan), `d290a85` (spec v0.2 + architecture).

---

## 13. Rulings made on your behalf

Decisions taken during execution without asking you, each with what it costs if wrong. Undo any of them freely.

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| 1 | Worked on branch `feat/m0-scaffold` in the main checkout (no separate worktree) | Fresh repo, nothing to isolate from | None |
| 2 | Commit trailers name the model that actually wrote each commit (Haiku/Sonnet 5.5), not the plan's fixed "Opus 5.5" line | Truthful attribution | Trailer text only; rewrite before merge if you prefer |
| 3 | Task 1 "no references to old spec path" check scoped to specs + product spec (the plan doc legitimately mentions the old path) | Plan describes the move | None |
| 4 | `deny.toml` scans only the six desktop target triples | Tauri lists `reqwest`/`hyper` only for Android/iOS; not compiled for desktop (verified with `cargo tree --target x86_64-unknown-linux-gnu`) | Mobile graph unchecked; revisit if mobile is ever added |
| 5 | Backend-import ban widened to all `@tauri-apps/api*` and `@tauri-apps/plugin-*` outside `src/ipc/` (plan only banned `/core`) | Spec: UI reaches backend only via `src/ipc/`; the narrow rule had bypasses | Features needing e.g. events must wrap them in `src/ipc/` (intended) |
| 6 | Kept the duplicated dark token block | Plain CSS can't share one block across a media query and an attribute selector; `light-dark()` needs Safari 17.5+ but we target Safari 15 | Dark values must be edited in two places until M8 |
| 7 | Moved `aria-describedby` from the actions `<div>` onto each disabled button (plan placed it on the div) | A description on a generic element is never announced (NFR-10) | None |
| 8 | Accepted `[advisories] ignore = RUSTSEC-2024-0370` (`proc-macro-error` unmaintained) | Build-time proc-macro via Tauri's Linux GTK3 stack, no upgrade path; "unmaintained", not a vulnerability | Masks only that advisory ID; revisit when Tauri leaves gtk3 |
| 9 | Final fix wave (after whole-branch review) included: real IPC/ACL integration tests, IPC error logging inside Tauri, visible focus ring on language toggle, `<html lang>` sync, macOS `CFBundleLocalizations`, corrected Linux CI deps + README, broader network bans, `sendBeacon` any-chain ban, removed mobile icons, dated comment on pnpm release-age exclusions | All small, privacy/a11y-relevant, cheaper now than in M1 | Slightly larger M0 diff |
| 10 | Deferred to later milestones (see §15): canonical LICENSE text, Notion id-only names, Windows path prefixes in cache name, single-source version, i18n re-entrancy/registry check, `initI18n` `.catch`, language persistence, font OFL notices + npm license audit, scheduled advisories job, Rust OS-locale fallback | Not needed for M0 | Small; all tracked below |

Earlier, during brainstorming, you also chose (not rulings — your answers): Tauri 2 over Electron, GPL-3.0-or-later, all three platforms at once, subagent-driven execution, and every §10 product answer in §3.1.

---

## 14. Verification status of the real app

Update 2026-10-12 (after Ghostty got Screen Recording permission): the agent launched the real app and checked it with screenshots. Results:

### 14.1 Real window, production CSP — ✅ verified on macOS

```bash
pnpm --filter @nimw/desktop tauri build --debug --no-bundle
./target/debug/nimw-desktop
```

- [x] Welcome card renders with **Bricolage Grotesque** (title) and **Plus Jakarta Sans** (body) — bundled fonts load under the production CSP.
- [x] The label next to the logo reads **V0.1.0** → `app_info` passed the capability allowlist in the real WKWebView.
- [x] The English/Español toggle is styled (inline styles allowed by the CSP).
- [ ] **Keyboard focus — not verified, and a likely gap.** In WKWebView (like Safari), **Tab skips buttons unless macOS "Keyboard navigation" is enabled** (System Settings → Keyboard → Keyboard navigation; on this Mac `AppleKeyboardUIMode` is unset = off). The welcome screen has only buttons, so with the default macOS setting Tab may reach nothing. The focus-ring CSS fix is verified in Chromium; the reachability question is tracked for M1 (§15). The agent did not complete this check because synthetic Option+Tab is bound to a window switcher on this machine.
- [ ] Devtools console check for CSP violations: not done in the real window (verified 0 violations in the browser run instead).

Note: the unbundled binary shows "nimw-desktop" in the macOS menu bar; the bundled `.app` shows "Notes In My Way" with its own Dock icon (expected).

### 14.2 Dark mode — ✅ verified
- [x] Real window follows the OS appearance live: switching macOS Light ↔ Dark repainted the background and card without restart (your Dark setting was restored afterwards).

### 14.3 Spanish OS locale (Q-I18N-1) — ✅ verified (bundled app)
- [x] `pnpm --filter @nimw/desktop tauri build --debug --bundles app`, then `open -n "target/debug/bundle/macos/Notes In My Way.app" --args -AppleLanguages '(es)'` → the UI starts in **Spanish** ("Notas privadas…", Español pressed, "Idioma"). The bundle's `Info.plist` contains `CFBundleLocalizations = [en, es]`.
- The Rust `sys-locale` fallback is therefore **not needed** for macOS. Still to check on Windows (WebView2) and Linux (WebKitGTK, follows `LANG`).

### 14.4 CI on real runners
- [ ] After adding a GitHub remote and opening a PR, confirm all 5 jobs (frontend, rust ×3, deny) pass. Most likely first-run failures: Linux apt packages, pnpm 12 with `pnpm/action-setup@v4`.

### 14.5 Windows and Linux rendering
- [ ] Run `pnpm dev` once on Windows (WebView2) and Linux (WebKitGTK) — layout and fonts.

---

## 15. Known gaps and deferred items

| Item | Detail | Target |
|---|---|---|
| Language choice not persisted | Toggle resets on restart | Settings/persistence milestone (M1 settings store) |
| OS-locale detection on Windows/Linux | macOS verified (§14.3); confirm WebView2 / WebKitGTK report the OS language, else add a `sys-locale` Rust command | M1 |
| Keyboard reachability on macOS | WKWebView skips buttons on Tab when macOS Keyboard navigation is off (default). Decide: rely on the OS setting (Safari behaviour), or handle Tab/arrow navigation in-app for the welcome actions and the Global View (NFR-10, GV-18). Verify the focus ring in the real window | M1 |
| `initI18n` hardening | Re-running re-adds plugins (harmless now); no `.catch` in `main.tsx` (init failure = blank window) | M1 |
| Locale check scans folder, not registry | A JSON file missing from `LOCALES` (or vice versa) isn't caught | When adding a 3rd language |
| `cache_dir_name` on Windows | Canonical paths carry `\\?\` prefix; normalize before hashing | M1 |
| `strip_notion_id(" <id>.md")` → `".md"` | Would then be treated as hidden by VLT-05; map to "Untitled" | M7 |
| Version in 3 places | `tauri.conf.json`, workspace `Cargo.toml`, `apps/desktop/package.json`. Removing `version` from `tauri.conf.json` makes Tauri use Cargo's | M8 |
| LICENSE is the SPDX rendering | Same text; replace with `https://www.gnu.org/licenses/gpl-3.0.txt` (gnu.org was unreachable from the sandbox) | Before first release |
| Third-party notices | Fonts are OFL (ship their license text); npm dependency licenses aren't audited (cargo-deny covers Rust only) | M8 |
| pnpm release-age exclusions | `pnpm-workspace.yaml` exact-version exclusions for vitest 5.0.4, typescript-eslint 8.71.2, i18next 26.4.4 — remove once those versions are older than pnpm's minimum release age | Next dependency bump |
| Advisories job | `deny` job fails PRs when a new advisory is published; consider a scheduled advisories-only job | Later |
| Unused license allow entries | cargo-deny warns ISC/etc. unused — harmless | — |
| Stub screens | Global view / editor are bare headings | M2 / M3 |
| Zero-network e2e test | Fixture vault with remote references + recording proxy | M2 (needs rendering) |
| Signing / installers | Apple Developer ID, Windows code signing | M8 |
| White flash in dark mode | No window `backgroundColor` set | M8 polish |
| Missing reference image | Spec §6 mentions `new-graph-navigation.jpeg`, not in repo | Ask PO |

---

## 16. Troubleshooting

### 16.1 `cargo build`/`test` fails: "frontendDist … ../dist doesn't exist"
`tauri::generate_context!()` embeds `apps/desktop/dist`. Run `pnpm build:ui` first (CI does). Crates under `crates/` don't need it: `cargo test -p nimw-markdown` works without a UI build.

### 16.2 A command call fails with "… not allowed"
The ACL rejected it. Check the three places in recipe 8.1 steps 3–5 (handler, `build.rs` AppManifest, `capabilities/main.json`). `cargo test -p nimw-desktop --test ipc` reproduces it.

### 16.3 ESLint: "Import backend calls from src/ipc/ only."
You imported `@tauri-apps/api…` or a plugin outside `src/ipc/`. Add a typed wrapper in `src/ipc/index.ts` and import that.

### 16.4 `pnpm install` refuses a package version "newer than minimumReleaseAge"
pnpm 12 blocks very fresh releases (supply-chain protection). Prefer waiting/using an older version; if you must, add an **exact-version** entry under `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` with a dated comment.

### 16.5 `pnpm test -- src/foo` runs everything
Known: arguments aren't forwarded as filters. Use `pnpm --filter @nimw/desktop exec vitest run src/foo`.

### 16.6 Styles missing in the built app but fine in `pnpm dev`
Dev has no CSP. Check devtools for CSP violations; confirm `dangerousDisableAssetCspModification: ["style-src"]` is still present and no asset got inlined as `data:` (keep `assetsInlineLimit: 0`).

### 16.7 `rust-toolchain.toml` seems ignored
Homebrew `rustc` doesn't read it; rustup does. Either install rustup or keep Homebrew Rust ≥ 1.99.

### 16.8 `pnpm check:i18n` fails with a syntax error on old Node
It relies on Node's built-in TypeScript type stripping (Node ≥ 22.18). Upgrade Node.

### 16.9 Prettier fails in CI after editing JSON/TS
Run `pnpm format` and commit.

---

## 17. Where M1 starts

### 17.1 Publishing M0
M0 is merged locally into `main` (`b7532b4`). Nothing is pushed. To publish and get CI running:
```bash
git remote add origin <your GitHub repo URL>
git push -u origin main
```
The push to `main` triggers CI (§11). Then do §14 and watch the first run (§14.4). Start M1 on a new branch (e.g. `git checkout -b feat/m1-vault`).

### 17.2 M1 scope (arch §10): vault, explorer, index, watcher, CAS writes, trash, link rewrite — VLT-*, EXP-*, PG-01/04/05

Concrete starting points:
1. **Plan it first** (the way M0 was planned): a `docs/superpowers/plans/<date>-m1-vault.md` with tasks per crate.
2. `nimw-vault`: vault scan (respect `is_hidden_name` + attachment folders + exclude globs from `.nimw/vault.json`), `notify` watcher (200 ms debounce), atomic compare-and-swap `write_file(path, content, expected_hash)`, OS trash (`trash` crate), path canonicalization + "inside vault" validation for every IPC path argument (arch §6.3).
3. `nimw-markdown`: grow `extract_title` into full metadata extraction (frontmatter keys from arch §3.3, `#tags`, `[[links]]`/embeds with byte offsets).
4. `nimw-index`: SQLite schema from arch §3.2 (WAL, FTS5 `unicode61 remove_diacritics 2`), incremental re-parse by `(mtime, size)`; place DB at `<OS cache dir>/nimw/<cache_dir_name>/index.sqlite` (normalize Windows `\\?\` first).
5. Shell: commands `open_vault`, `create_vault`, `vault_tree`, `read_file`, `write_file`, `create_entry`, `rename_entry`, `move_entry`, `trash_entry`, events `index:progress`, `vault:changed` — each via recipe 8.1. Add `tauri-plugin-dialog` for folder pickers (recipe 8.2).
6. UI: enable the welcome buttons, explorer sidebar (`features/explorer/`), drive `App`'s `screen` from vault state, recent vaults list (needs a settings store in the OS config dir → also persists language and theme).
7. Carry over §15 items tagged M1.

---

## 18. How this was built

- **Brainstorming → spec → plan → execution.** Product questions were closed interactively (§3.1), the architecture was approved section by section, written to the architecture doc, then turned into the 9-task M0 plan with complete code per step.
- **Subagent-driven execution.** Each task was implemented by a fresh agent (cheaper models where the plan carried full code, mid-tier for integration-heavy tasks), then independently reviewed for spec compliance and code quality. Important findings went through fix rounds with scoped re-reviews (Tasks 4 and 7 needed one round each). A final whole-branch review (most capable model) produced 5 Important + 4 Minor findings, fixed in one wave and re-reviewed (all addressed).
- **Evidence.** Every task recorded RED/GREEN test evidence. The controller independently re-ran `pnpm check` + `cargo deny check` at the end and verified the production build's rendering under the real CSP in a browser.
- **Plan deviations** are exactly the rulings in §13.
