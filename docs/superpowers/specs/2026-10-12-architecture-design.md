# Notes In My Way — Architecture Design (plan doc v1)

> **Status:** Approved in design review · **Date:** 2026-10-12
> **Roles:** Jose — tech lead (decisions below are DECIDED) · PO — product owner
> **Companion to:** `notes-in-my-way-spec.md` v0.2 (the *what*). This file is the *how*.
> Requirement IDs (e.g. `GV-11`) refer to the product spec.

---

## 1. Decisions at a glance

| Area | Decision |
|------|----------|
| Desktop shell | **Tauri 2** (system webview: WebView2 / WKWebView / WebKitGTK) |
| Core | **Rust** crates, independent of Tauri |
| UI | **React + TypeScript**, Vite, CSS Modules + CSS custom-property tokens (no Tailwind) |
| UI state | Zustand (per-feature stores) |
| Editor | **CodeMirror 6** (Live Preview via decorations, Source, Split) |
| Rendering | unified/remark (mdast with positions) → React; custom micromark/remark extensions |
| Global View canvas | **React Flow** (`@xyflow/react`) + **elkjs** auto layout in a web worker |
| Block drag | dnd-kit in the rendered pane; moves become CodeMirror transactions |
| Index / search | **SQLite** (rusqlite, WAL) + **FTS5** (`unicode61 remove_diacritics 2`) |
| Metadata parsing (index) | pulldown-cmark + own extensions, in Rust |
| File watching | `notify` (+ debouncer), 200 ms |
| Trash | `trash` crate (OS trash, EXP-03) |
| Audio | `cpal` capture, `hound` WAV, `mp3lame-encoder` (LAME) MP3 |
| HTML sanitizing | DOMPurify, explicit allowlist + strict CSP |
| i18n | i18next, ICU JSON per locale |
| License | **GPL-3.0-or-later** |
| Platforms | macOS, Windows, Linux (`.deb`, `.AppImage`) shipped **simultaneously** |
| Toolchain | Node 22 LTS, pnpm workspaces, Rust stable pinned via `rust-toolchain.toml`, Tauri 2.x |

---

## 2. Repository layout and module boundaries

```
notes-in-my-way/
├─ apps/desktop/
│  ├─ src/                    React + TS UI
│  │  ├─ app/                 shell, screen routing (welcome / global / editor), settings
│  │  ├─ features/
│  │  │  ├─ explorer/         sidebar tree (EXP-*)
│  │  │  ├─ global-view/      canvas, cards, edges, layout (GV-*)
│  │  │  ├─ editor/           CodeMirror 6 modes (ED-*)
│  │  │  ├─ preview/          remark renderer + block DnD (DND-*)
│  │  │  ├─ audio/            recorder UI, inline player (AUD-*)
│  │  │  └─ search/           palette, filter chips (SR-*)
│  │  ├─ markdown/            remark/micromark plugins + sanitizer
│  │  ├─ ipc/                 typed wrappers over Tauri commands/events — the only IPC entry point
│  │  ├─ i18n/locales/{en,es}.json
│  │  └─ theme/               tokens (light, dark), bundled fonts
│  └─ src-tauri/              thin shell: commands, events, CSP, capabilities, app state
├─ crates/
│  ├─ nimw-vault/             FS model, scan, watch, atomic CAS writes, trash, link rewrite
│  ├─ nimw-markdown/          metadata extraction (title, frontmatter, tags, links, embeds, offsets)
│  ├─ nimw-index/             SQLite schema, incremental indexing, level/neighborhood/search queries
│  ├─ nimw-audio/             devices, capture thread, level meter, WAV/MP3 encoders
│  └─ nimw-import/            Notion export importer
├─ fixtures/                  shared Markdown fixtures + expected outputs (Rust and TS)
├─ design/                    prototype reference (not shipped)
└─ docs/                      product spec, this doc, ADRs
```

**Rules**
1. `crates/*` never depend on Tauri. They are tested with plain `cargo test`. `src-tauri` only adapts them to commands/events.
2. The UI never touches the filesystem; everything goes through `src/ipc/`. That module *is* the backend capability surface.
3. Dependency direction: `nimw-index → nimw-markdown`, `nimw-index → nimw-vault` (types only), `nimw-import → nimw-markdown`. No cycles; `nimw-audio` is standalone.
4. Two parsers exist (Rust extraction, TS rendering). Both are tested against `fixtures/`; a divergence fails CI.

---

## 3. Data and storage

### 3.1 Locations

| Data | Location | Notes |
|------|----------|-------|
| Notes, attachments | the vault (plain files) | source of truth |
| Per-vault app data | `<vault>/.nimw/vault.json`, `<vault>/.nimw/layout.json` | Hidden folder (Obsidian ignores it). Created lazily on first need, so opening a vault writes nothing (VLT-02). |
| Global settings | OS config dir `nimw/settings.json` | language, theme, default recording format, recent vaults |
| Index cache | OS cache dir `nimw/<sha256(vault-abs-path)[..16]>/index.sqlite` | Disposable, rebuildable; never inside the vault |

`vault.json`: `{ "version": 1, "viewMode": "drill"|"expand", "indexPicks": { "<folderPath>": "<pagePath>" }, "exclude": ["<glob>"], "attachments": { "mode": "vault"|"same"|"subfolder", "path": "attachments" } }`
`layout.json`: `{ "version": 1, "levels": { "<levelKey>": { "<nodePath>": { "x": 0, "y": 0 } } } }` where `levelKey` is the drilled path (`""` = level 0) or `expand:<rootPath>`.

### 3.2 Index schema (SQLite)

- `files(path PK, kind, parent, mtime, size, hash)`
- `pages(path PK, title, subtitle, cover, cover_y, excerpt, has_image, has_audio)`
- `tags(path, tag)`
- `links(src, target_raw, target_path NULL, kind ['link'|'embed'|'related'], label NULL, directed, start, end)`
- `fts` — FTS5 over `(title, name, tags, body)`; bm25 weights rank title/name/tags above body (SR-02, Q-SR-1)
- `meta(key, value)` — schema version; mismatch ⇒ rebuild

Incremental: on open, rows whose `(mtime, size)` differ are re-parsed on a rayon pool; unchanged rows are trusted.

### 3.3 Frontmatter keys owned by the app

```yaml
cover: attachments/rex-cover.png
cover-y: 40            # 0–100 (PG-02 reposition)
subtitle: Hero redesign · v3
tags: [character]      # read (PG-04); body #tags too
related:
  - "[[Sparda]]"                                               # undirected, unlabeled
  - { link: "[[Game 1]]", label: "playable version", directed: true }
```

Relationships live in the page where the drag started (GV-22). Reads accept both forms; writes use the string form whenever possible. All other frontmatter keys are preserved untouched (`yaml` Document API keeps formatting and comments).

### 3.4 Tier B syntax

| Feature | Syntax | In Obsidian |
|---------|--------|-------------|
| Columns | `::::columns` / `:::column` … `:::` / `::::` (generic directives) | `:::` lines show as text (accepted) |
| Toggles | foldable callouts `> [!note]- Title` | native |
| Highlights | `==text==` | native |
| Colored text | `<span data-color="red">…</span>`, `data-bg` for background; fixed theme-aware palette | plain text |
| Dividers | `---` | native |

### 3.5 Link resolution (PG-05)

File name is canonical, using Obsidian's rules (exact path → shortest unique path → first match by name). `[[` autocomplete searches titles and file names and inserts `[[file-name|Title]]` when they differ.

### 3.6 Exclusions (VLT-05)

Dot-folders are ignored everywhere. Attachment folders are hidden from the Global View but shown in the explorer. User globs from `vault.json.exclude` apply everywhere.

### 3.7 Write path

- **Single writer:** the Rust backend. `write_file(path, content, expectedHash)` is an atomic compare-and-swap: temp file in the same directory → fsync → rename (NFR-08). A hash mismatch returns `Conflict { current }` and nothing is written.
- **Content transforms live in TS** (CodeMirror transactions for body, `yaml` Document for frontmatter) and send full content.
- **Exception — rename/move (EXP-04):** Rust rewrites inbound links using byte offsets from `links`, one CAS write per affected file, then renames.

---

## 4. Runtime flows

### 4.1 Open, index, watch
1. `open_vault(path)` → scan (respecting exclusions) → diff against cache → background re-parse → `index:progress` events.
2. The UI renders from cache immediately; cards fill in as indexing completes.
3. `notify` watcher (200 ms debounce) → re-index changed files → `vault:changed { created, modified, deleted, renamed }` (VLT-04).
4. External rename = delete + create with equal hash within the debounce window ⇒ treated as rename; layout entries and index picks follow.

### 4.2 Editor
- One CodeMirror 6 `EditorState` per open page is the single source of truth.
- **Live Preview** = CM6 + decorations/widgets; **Source** = plain CM6; **Split** = CM6 left + rendered pane right (mdast → React), synced scroll via source positions (ED-02).
- **Undo** = CM6 history; every mutation (typing, drag, insert, cover/frontmatter change on the open page) is a transaction (ED-07).
- **Auto-save** on 500 ms idle, blur and close, via CAS (ED-08).
- **External change while open:** clean → silent reload; dirty → line-based 3-way merge (base = last saved); unclean merge → keep the user's text, write the external version as `<name> (conflict).md`, show a notice.

### 4.3 Block drag (DND-*)
- Each rendered block carries its source `[start, end)` from mdast positions.
- A drop builds one CM6 transaction moving that byte range (DND-04/05/06). List items moved across levels get their indentation prefix rewritten and nothing else. Headings move with their section (until the next heading of same or higher level); Alt-drag moves the line only (DND-07).
- Keyboard: move up/down, indent/outdent call the same transaction builders (Q-A11Y-1).

### 4.4 Global View
- `gv_level(nodePath)` → children cards + hierarchy edges + link/related edges **aggregated to the nearest visible ancestor** with counts (GV-25).
- `gv_neighborhood(pagePath)` → outgoing links, backlinks, relationships (GV-16).
- Card data: cover, title, subtitle, excerpt, kind, counts. Folder card uses its index note: page named like the folder, else `index.md`, else `vault.json.indexPicks`, else a summary card (GV-02).
- React Flow: custom card node, three edge types, each toggleable (GV-21). elkjs layered layout in a worker; user-pinned positions override and persist in `layout.json` (GV-30/31/32).
- Drill-down replaces the level and updates the breadcrumb. Expand inserts children beside the parent and re-lays out only unpinned nodes. Only open levels are mounted (NFR-02).
- Connect handle drag → `related:` patch on the source page → CAS write → re-index (GV-22).
- Keyboard: roving tabindex, arrows between cards, Enter = single click, Shift+Enter = double click.

### 4.5 Search
`search(query, filters)` → FTS5 match + SQL filters (project, folder, tags, links to/from, has_image, has_audio), 80 ms UI debounce.

---

## 5. Audio, attachments, import

### 5.1 Recording (`nimw-audio`)
- `audio_devices()` lists inputs (AUD-01). `audio_start(device, format, targetDir)` spawns a capture thread writing to `.clip-<ts>.part`; emits `audio:level` (RMS/peak, ~20 Hz) and elapsed time (AUD-07).
- `audio_stop()` → rename to `clip-YYYYMMDD-HHMMSS.{wav|mp3}` → UI inserts `![[…]]` at the cursor in one transaction (AUD-04). `audio_cancel()` deletes the part file.
- WAV: 16-bit PCM at the device rate. MP3: LAME 192 kbps CBR. Default from settings (WAV); switchable per take (AUD-02).
- macOS: `NSMicrophoneUsageDescription` + audio-input entitlement; permission denial shows guidance.

### 5.2 Upload and playback
- Upload via dialog or drop; accepted WAV, MP3, M4A (AUD-03); copied into the attachments folder.
- Custom React player over `<audio>` using the `asset:` protocol: play/pause, seek, time, duration (AUD-05). Unmount stops it (AUD-06); one clip plays at a time.

### 5.3 Images and covers
`save_attachment(bytes, name, pagePath)` resolves the attachments folder (mode or Obsidian `attachmentFolderPath`), de-duplicates (`name 1.png`), writes atomically, returns the vault path; the UI inserts `![[name.png]]` (ED-05). Covers: pick from vault or upload; vertical drag sets `cover-y` (PG-02).

### 5.4 Notion importer (`nimw-import`, IMP-*)
1. Input: Notion "Markdown & CSV" export zip, nested zips included. Unzip to a temp dir.
2. Strip trailing 32-hex IDs from names; resolve collisions with ` 1`, ` 2` suffixes.
3. Rewrite internal links to `[[Page]]` and asset links to vault-relative embeds.
4. `<aside>` → `> [!note]`; toggle `<details>` → `> [!note]-`.
5. Databases: each CSV row page gets frontmatter from its columns; the database gets an index page with a Markdown table linking rows.
6. **Dry run** returns counts and warnings; the user confirms; writes go only to the target folder (`Notion import YYYY-MM-DD/` in the vault, or a new vault). A report page summarizes the result.

---

## 6. Privacy and security

### 6.1 Zero network (P1, NFR-04) — three layers
1. **Not compiled in:** no Tauri http/updater/shell plugins; `cargo deny` bans HTTP-client crates (`reqwest`, `ureq`, `isahc`, `curl`, `hyper`) from the runtime dependency graph (build-only exceptions must be listed explicitly in `deny.toml`); ESLint (`no-restricted-globals`/`no-restricted-syntax`) bans `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `navigator.sendBeacon` in app code — IPC goes only through `@tauri-apps/api` inside `src/ipc/`. Only the donations link exists, via the `opener` plugin scoped to that single URL (OS browser).
2. **CSP:** `default-src 'self'; img-src 'self' asset: http://asset.localhost data: blob:; media-src 'self' asset: http://asset.localhost blob:; connect-src ipc: http://ipc.localhost; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.
3. **Test:** e2e opens a fixture vault full of remote references while a local proxy records outbound connections; asserts zero.

### 6.2 Embedded HTML
DOMPurify allowlist: formatting tags, tables, `details/summary`, `img/audio/video`, `span/div`, `kbd/sub/sup`, `mark`; attributes limited to `src`, `href`, `alt`, `title`, `width`, `height`, `data-color`, `data-bg`, `open`, `controls`. `style` is stripped. Every `src`/`href` must resolve inside the vault; remote → "remote content blocked" placeholder. External `<a href>` opens in the OS browser after confirmation.

### 6.3 Tauri hardening
Capabilities allowlist only our commands; `asset:` protocol scope = the open vault only; no remote origins; devtools disabled in release; every IPC path argument canonicalized and rejected if outside the vault.

---

## 7. i18n, theming, accessibility

- **i18n (NFR-07):** i18next + ICU JSON per locale; a new language = one file + one registry line. OS locale picks en/es on first run (Q-I18N-1). `Intl` for dates and numbers. CI checks key parity across locales.
- **Theming (Q-UI-1):** prototype values → CSS custom-property tokens; light + dark sets; default follows OS, override in Settings. Fonts bundled (OFL): Bricolage Grotesque, Plus Jakarta Sans, JetBrains Mono.
- **Accessibility (Q-A11Y-1):** keyboard everything (tree, card grid with roving tabindex, block moves), ARIA roles/live regions, visible focus, WCAG AA contrast in both themes, `axe-core` in component tests.

---

## 8. IPC surface (initial)

Commands: `app_info`, `open_vault`, `create_vault`, `vault_tree`, `read_file`, `write_file`, `create_entry`, `rename_entry`, `move_entry`, `trash_entry`, `save_attachment`, `gv_level`, `gv_neighborhood`, `search`, `settings_get/set`, `vault_settings_get/set`, `layout_get/set`, `audio_devices`, `audio_start/stop/cancel`, `import_notion_preview`, `import_notion_run`.
Events: `index:progress`, `vault:changed`, `audio:level`, `import:progress`.
All errors are a typed enum serialized as `{ kind, message }`; the TS wrappers map them to i18n keys.

---

## 9. Quality

### 9.1 Testing
- **Rust:** `cargo test` per crate; `proptest` invariants (block move byte preservation, link rewrite touches only targets, CAS never leaves partial files); `criterion` benches on a generated 10k-note vault.
- **TS:** Vitest + Testing Library + `axe-core`; Markdown plugins run against `fixtures/`.
- **E2E:** Playwright against the UI with mocked IPC (all OSes); WebdriverIO + `tauri-driver` against the real app (Linux, Windows); zero-network test on Linux.
- Test names include requirement IDs.

### 9.2 Performance budgets (NFR-03, 10k notes, mid-range 2022 laptop)

| Metric | Budget |
|--------|--------|
| Cold start → interactive (cached index) | < 2 s |
| First full index | < 30 s, background |
| Incremental re-index of one file | < 100 ms |
| Search | p95 < 50 ms |
| Global View level render (≤ 200 cards) | < 300 ms |
| Typing latency | < 16 ms |

Checked by a nightly benchmark job.

### 9.3 CI/CD (GitHub Actions)
- PR: rustfmt, clippy `-D warnings`, ESLint, Prettier, `tsc --noEmit`, `cargo test`, Vitest, i18n key parity, `cargo deny` (licenses compatible with GPL-3.0-or-later + network-crate bans) — matrix ubuntu/macos/windows.
- Release: `tauri-action` → `.dmg` (+ notarization), `.msi`/NSIS `.exe` (+ code signing), `.deb`, `.AppImage`, all in one release.
- Signing prerequisites (M8): Apple Developer ID; Windows certificate or Azure Trusted Signing.

---

## 10. Milestones

| M | Scope | Main IDs |
|---|-------|----------|
| M0 | Scaffold (below) | NFR-04 (CSP/capabilities), NFR-07, NFR-09 |
| M1 | Vault, explorer, index, watcher, CAS writes, trash, link rewrite | VLT-*, EXP-*, PG-01/04/05 |
| M2 | Editor modes, covers, subtitle, attachments, sanitizer, Tier B rendering | ED-*, PG-02/03, §5.1 |
| M3 | Global View | GV-* |
| M4 | Block drag-and-drop | DND-* |
| M5 | Search | SR-* |
| M6 | Audio | AUD-* |
| M7 | Notion importer | IMP-* |
| M8 | Packaging, signing, dark theme polish, a11y audit, perf budgets | NFR-* |

### M0 scaffold contents
- Cargo workspace with the 5 crates (stub public APIs, one passing test each) and the Tauri shell; pnpm workspace with `apps/desktop`.
- Tauri shell with the final CSP and capability lockdown.
- Frontend shell: screen routing (welcome / global / editor stubs), theme tokens light + dark, bundled fonts, i18n en/es with OS-locale detection, welcome screen ported from the prototype.
- One typed IPC round trip (`app_info`) proven end to end, with a test.
- Configs: rustfmt, clippy, ESLint, Prettier, Vitest, `deny.toml`, `rust-toolchain.toml`, `.editorconfig`, `.gitignore`.
- CI workflow (lint + test matrix + cargo-deny + i18n parity).
- `LICENSE` (GPL-3.0-or-later), `README.md`, prototype moved to `design/prototype/`, product spec moved to `docs/`.
