# Batch 6 — the `main` merge, text-file search, the docs review, M6 audio clips, M7 Notion import: Hand-off

**What batch 6 is for:** Jose asked on 2026-10-18 to merge everything locally into `main` (no push), make `.txt` files searchable, review the documentation and add a detailed reference for the SQLite database and the indexing process, and build M6 (audio clips) and M7 (the Notion importer).

**Branch:** `feat/batch6`, cut from `main` at `de2378e`. **Not merged into `main`**: Jose checks first. Nothing is pushed; there is no remote.

**Specs:**
- M6: `docs/superpowers/specs/2026-10-14-m6-audio-design.md`. §10 holds the batch 6 amendments (Jose: "Keep as written"); §11 holds the batch 6 review.
- Text-file search: `docs/superpowers/specs/2026-10-14-m5-search-design.md` §12, including its review subsection.
- M7: `docs/superpowers/specs/2026-10-18-m7-notion-import-design.md` (new). §2 holds Jose's answers, §12 the rulings, §15 the amendments from building it, §16 the batch 6 review.

**Plans (as run):**
- `docs/superpowers/plans/2026-10-18-m6-audio.md`
- `docs/superpowers/plans/2026-10-18-m7-notion-import.md`

**How it was built:**
1. **The merge.** Nine signed `--no-ff` merges into local `main`, one per milestone (M2c → M3a → M3b → M4 → M4b → M4b part 3 → M4c → M5 → M5b). `main` ends at `de2378e`, whose tree is identical to `feat/m5b-feedback`.
2. **Jose's answers before building.** M7: the Notion **Markdown & CSV** zip only; imports **always go into a new vault**; databases become an **index page plus one page per row** (CSV columns as frontmatter). M6: keep the spec as written (WAV/MP3, clips in the page's attachments folder, microphone only while recording, no transcription).
3. **Four streams in parallel**, each in its own worktree with its own full gate: `feat/batch6-docs`, `feat/batch6-txt-search`, `feat/m6-audio`, `feat/m7-import`.
4. **Integration** by cherry-pick in that order. One performance fix came out of it (`5ac7f4b`, see §1.6).
5. **Two fresh-context Opus reviews:** the Notion importer with a security focus, and audio, text search and the pragmas. One Critical and 15 Important findings in total, plus minors.
6. **Two parallel fix passes**, `fix/b6-import` (17 commits) and `fix/b6-audio` (10 commits). Every fix has a test that failed first, except where noted.
7. **Final integration** of both fix passes onto `feat/batch6`: no conflicts; gate, Windows check, perf and dev-server check, then this hand-off and the builds.

---

## 1. What changed

### 1.1 `main` now holds M0–M5b

| Merge | Commit |
|---|---|
| M2c page extras | `df485c2` |
| M3a Global View | `0d2edbd` |
| M3b relationships | `eefffdb` |
| M4 block moves | `b625ac2` |
| M4b feedback (parts 1–2) | `a082b70` |
| M4b part 3 | `c292a32` |
| M4c Scratchpad and single-file windows | `5c62eb4` |
| M5 search | `2e927ee` |
| M5b third feedback round | `de2378e` |

All nine merge commits carry an SSH signature (`git log --show-signature` reports "No signature" only because `gpg.ssh.allowedSignersFile` isn't configured on this machine; the signatures are in the commit objects).

### 1.2 Text and code files are searchable (index schema 5)

- **Which files:** exactly the ones the text view opens: `nimw_session::is_text_path` (the M4b part 2 extension and name list) plus `is_text_content` (UTF-8, no NUL byte, at most 2 MB). A `.txt` that isn't UTF-8 or is bigger than 2 MB stays a plain attachment, with no warning.
- **What's indexed:** a `page_text` row with the file name as title and name, its folders, and the whole text as body. No tags, no links. For every other purpose (links, Global View, explorer, cards) a text file stays an attachment.
- **In the search dialog:**
  - a text hit shows its extension (`TXT`, `JSON`, `LOG`) in place of a thumbnail, or a code glyph for names without one (`Makefile`);
  - it gets a snippet like a page, from the first 64 K characters and only when its body matched;
  - **Enter** and **Shift+Enter** both open it in the text view;
  - a **Text files** chip in the SHOW row narrows results to them, with its count.
- **Kept in step on:** open, rescan, watcher create/change/rename/delete, saving from the text view, creating or importing a file in the app, and a rename that changes whether the extension counts as text (`a.txt` → `a.pdf` drops the text, `b.bin` → `b.txt` loads it).
- **Schema 4 → 5** rebuilds the index once, on first open of each vault.

### 1.3 The docs review and the new database reference

- **New: `docs/architecture/index-and-database.md`** — where each vault's database lives (the app cache folder, `cache_dir_name`), the SQLite setup and pragmas, every table, column, index, trigger and the FTS5 external-content table at schema 5, the version history (1 → 5), the indexing pipeline from scan to watcher, how search sits on top, invariants and failure modes, how to inspect it with `sqlite3`, how to force a rebuild, and the performance budgets and tests.
- **New: `docs/README.md`** — where to start, and a table of every milestone's spec and hand-off.
- **`README.md`** — status (it still said "M0 scaffold"), Node 24, the 7 crates, the two capability files, `pnpm test:e2e` and `NIMW_E2E_PORT`, the release perf tests, the Windows cargo-xwin cross-build, and `libasound2-dev` on Linux.
- **Architecture design** — a new **§0 "As built"** listing where the code differs from the v1 design, §3.2 pointing to the new reference, and a Status column in the milestone table.
- **Product spec** — only factually settled rows: EXP-03 now describes the vault Trash, persona status cells, and changelog lines for 2026-10-15 and 2026-10-18. No requirement was rewritten.

### 1.4 M6 — audio clips (WAV only)

- **Record clip:** a microphone button in the page header controls, beside Format. It opens the **recorder bar** under the header band: microphone select (remembered for the session), **Start recording**, then the timer, a 16-bar level meter, **Stop & insert** and **Cancel**, plus **Upload clip…** (WAV, MP3, M4A through a Rust dialog). A polite live region announces the state every 10 s.
- **Where the clip goes:** a take is written to the app's cache folder, never into the vault while recording. **Stop** imports it with the normal attachment rule (the page's attachments folder, ` 1` de-duplication, re-index) as `clip-YYYYMMDD-HHMMSS.wav`, and inserts `![[…]]` at the cursor position from when recording started, mapped through every edit since, in one undoable step, into the page the take started on — wherever that page is now.
- **Player:** every audio embed on its own line gets a custom player (play/pause, seek slider, time). One clip plays at a time per window; playback stops when the page is left.
- **Not available:** on archived pages, text files and single-file windows (no button; Rust refuses `.archive/` pages; the audio commands are main-window only).
- **Privacy:** the microphone stream exists only while recording, and is dropped on stop, cancel, error, window reload or close, vault switch and app exit. Automated tests never touch a real microphone (a synthetic host is installed whenever tests run).
- **macOS:** `NSMicrophoneUsageDescription` and `CFBundleLocalizations` (en, es) are in `src-tauri/Info.plist`. A denied microphone gives silence, not an error, so after 3 s of exact silence the bar points to System Settings → Privacy & Security → Microphone.
- **MP3 is deferred,** and there's no WAV/MP3 toggle or `recordingFormat` setting yet. Why: the only maintained encoder crate (`mp3lame-encoder`, LGPL-3.0) builds LAME with autotools `configure`, which can't target Windows MSVC from the Mac under cargo-xwin (three approaches tried, all failed). Shipping MP3 on two systems out of three would break the "all desktop OSes ship together" rule. The way back: a pure-Rust encoder, or building LAME's C files with `cc` and its `configMS.h`.
- **Crates:** `cpal` 0.18.2 (Apache-2.0), `hound` 3.5.1 (Apache-2.0).

### 1.5 M7 — the Notion importer

- **Where:** **File → Import from Notion…** and **Import a Notion export** on the Welcome screen (it used to be disabled).
- **Flow:**
  1. choose the export zip (Rust dialog);
  2. choose the parent folder and the new vault's name (Rust dialog; the name is checked as you type, and an existing folder is refused before the export is read again);
  3. **preview**: pages, databases, rows and attachments counted, warnings listed — nothing is written yet;
  4. **Import**, with progress and **Stop** (Escape stops too);
  5. the new vault opens at **`Notion import report.md`**.
- **What it converts:**
  - Notion's 32-hex id suffixes are stripped from file and folder names; collisions are numbered;
  - internal links become `[[wikilinks]]` (with the folder when the name is ambiguous); links to a database CSV point at its index page; asset links become vault-relative embeds; external links stay;
  - `<aside>` becomes a `> [!note]` callout, `<details>/<summary>` a foldable `> [!note]-` callout; other HTML is kept as written (the renderer sanitizes it);
  - **databases:** each row's CSV columns become frontmatter (dates to ISO, ranges `A → B` as quoted ISO ranges, numbers, checkboxes to booleans, multi-select to lists, relations to `[[links]]`); `_all.csv` is preferred; the database becomes `Tasks.md` with a Markdown table linking every row, beside its `Tasks/` folder of row pages; a row with no page gets one.
- **Untrusted input:** every path component is rebuilt, never used as given. `..`, absolute paths, drive letters, UNC, NUL and symlink entries are skipped with a warning; `.obsidian`, `.git`, `.nimw` become `-obsidian`, `-git`, `-nimw`; Windows device names are refused (also after truncation). Limits on entry count, total size, compression ratio, Markdown text (1 GiB) and multi-part parts are checked before anything is expanded. Writes are create-only inside the brand-new folder.
- **Failure and cancel:** the partial vault is kept with a report saying how far it got. The dialog offers **Open it anyway** and **Show in Finder / Explorer** (acting only on the vault Rust recorded).
- **Speed:** a synthetic 5,000-page export with 1,000 rows and 500 attachments previews in about 80 ms and imports in about 0.6 s (budget 60 s).
- **Crates:** `zip` 9.0.5 (MIT; deflate via `flate2` + `zlib-rs`, MIT/Apache-2.0 and Zlib), `tempfile` (MIT/Apache-2.0) for multi-part exports.

### 1.6 Index pragmas

`crates/nimw-index/src/index.rs` now sets `cache_size = -32000` (about 32 MB per open vault, a ceiling, not memory reserved up front) and `temp_store = MEMORY`. Profiling showed search reading pages from disk on every query with SQLite's default 2 MB cache, and the facet temp tables going to a file. After the change, search p95 dropped from about 50 ms to about 44 ms on the same loaded machine, with 1,000 text files added to the reference vault.

### 1.7 `cargo deny` advisory ignores

Three advisories published on 2026-10-18 — RUSTSEC-2026-0370, -0371, -0372 — mark zbus's `zvariant`, `zbus_names` and `zvariant_derive` as unmaintained. They reach the app only on Linux, through `tauri-plugin-opener` and `tauri-plugin-single-instance`. They made `cargo deny` fail on `main` too. They are ignored in `deny.toml` with a written reason, the same way RUSTSEC-2024-0370 already was. "Unmaintained" is not a known vulnerability; revisit when Tauri updates those plugins.

## 2. Totals

- **Commits on `feat/batch6` since `de2378e`:** 55, all signed. 113 files changed, about 10,200 lines added.
- **Final gate** (`check.sh all` on the integrated tip, fresh build dir): ALL-OK.
  - vitest: **1536** tests in 140 files;
  - e2e: **344** passed, 8 skipped (Chromium and WebKit);
  - cargo: **602** passed, 0 failed, 5 ignored (the ignored ones are the release perf tests);
  - install, lint, typecheck, i18n, build, fmt, clippy, deny: all OK.
- **Windows:** `cargo xwin check --target x86_64-pc-windows-msvc` exit 0, no warnings.
- **Search perf (NFR-03, release, 10k pages + 1,000 text files):** p95 **46.6 ms**, p50 21.6 ms, first full index 1.42 s, re-index one page 21.5 ms — measured at load average about 5 (a release compile had just finished). Earlier runs at load about 2–4: 43.5–44.4 ms. The 50 × 2 MB name-matched text files case: p95 0.4 ms (it was about 880 ms before the review fix).
- **Dev-server check** (Vite dev, Chromium and WebKit): the `m5-search` (including a `.txt` hit), `m6-audio` (recorder bar and player) and `m7-notion` (dialog from the Welcome screen) specs, 24 passed, with their page-error assertions.

## 3. Needs the real window

### Jose, on the Mac (the built `.app`, see §5)

The index rebuilds once on first open of each vault (schema 5).

**Audio**
1. Open a page, click the microphone button. macOS asks for microphone access: **allow** it. Start recording, speak, watch the level meter and the timer; **Stop & insert**. A `clip-….wav` lands in the page's attachments folder and a player appears on its own line where the cursor was.
2. Record again and **Cancel**: nothing is written to the vault.
3. In System Settings, deny the app the microphone, record: after about 3 s the bar shows the "No sound is reaching the app…" hint.
4. Start a take, then type and move the cursor elsewhere in the page; Stop: the clip lands where the cursor was **when recording started**.
5. Start a take and rename the page (or move it to another folder) mid-take; Stop: the clip goes into the page's **new** attachments folder.
6. **Quit from the Dock mid-take** (Auto save on, the default): the take is stopped and inserted before the app quits (a logout is cancelled once).
7. Recovery: force-quit the app mid-take (Activity Monitor), reopen, start a new recording: a toast lists a `clip-…-recovered.wav` imported next to the original page (not linked into the page — link it by hand).
8. With a USB microphone: unplug it mid-take: the bar says the microphone was disconnected, and Stop & insert keeps what was recorded.
9. A long clip (10+ minutes): play and seek around — seeking should be quick.
10. **Upload clip…** with an MP3 and an M4A file.
11. Archived pages, text files and single-file windows show no microphone button.

**Language**
12. With macOS set to Spanish, the app opens in Spanish (this broke in a commit during M6 and is fixed, with a test).

**Notion import** — with a real export of yours (Settings → Export all workspace content → Markdown & CSV, "Include subpages")
13. File → Import from Notion…, choose the zip, choose a parent folder and a name. Check the preview's counts and warnings.
14. Import: the new vault opens at `Notion import report.md`. Check the warnings make sense.
15. Open a database's index page (e.g. `Tasks.md`): every row is in the table and links to its page. Open a row page: its properties are in the frontmatter (Source mode), dates as ISO, multi-selects as lists, relations as `[[links]]`, date ranges as quoted ranges.
16. Check callouts (`<aside>`) and toggles (`<details>`), nested pages, links between pages, and images.
17. Try a name that already exists in the chosen folder: it is refused before anything is read.
18. Start an import and press Stop: the dialog offers **Open it anyway** and **Show in Finder**; the partial vault has a report saying it was cancelled.

**Text search**
19. Put a `.txt` or `.log` with a distinctive word in a vault; ⌘F, type the word: it's found with a `TXT` badge and a snippet; Enter opens it in the text view; the **Text files** chip narrows to text files.
20. Rename `notes.txt` to `notes.pdf` in Finder: it stops showing as a text hit.

### The friend, on Windows (the `.exe`, see §5)

1. Recording through WASAPI with the default and another input device: level meter, Stop & insert, Cancel, Upload clip….
2. Quit (or close the window) mid-take: the clip is kept and inserted.
3. Playing and seeking a long clip.
4. Notion import: the zip and folder dialogs, preview, import, report; **Show in Explorer** after a stopped import.
5. Text search on a `.txt`.

## 4. Reviews, fix passes, deferred items, rulings

### Review of the Notion importer (security focus)

No way was found to write outside the new vault. Fixed, each with a test that failed first: **I1** a panic on a CSV cell like `2026-10-1é`; **I2** quadratic link rewriting (a 1 MiB line of `[` took minutes) and preview not cancellable; **I3** every converted page held in memory; **I4** multi-part exports could fill the temp disk; **I5** every CSV treated as a database (attached CSVs were lost); **I6** one date range turned a date column into broken lists; **I7** the UI and the Rust grants could drift (a cancelled re-pick cleared the first pick); **I8** a failed import didn't say a partial vault existed. Minors M1–M10 (folder-creation errors ignored, one bad entry stopping the import, the report lost on a full disk, frontmatter injection through date values and YAML keys, report spoofing through names, a device name surviving truncation, name checks differing between page and Rust, a lost cancel, focus lost at Import, the initial total) are all fixed. Nothing deferred.

### Review of audio, text search and the pragmas

Fixed, each with a test that failed first except where noted:
- **C1 (Critical):** Dock Quit, logout or shutdown with Auto save on lost the whole take. Now a system quit mid-take goes through the windows' close prompts, the WAV header is rewritten every 2 s, and leftovers are recovered at the next Start.
- **I1** a failed Stop deleted the take (now kept until it's safely in the vault; a disk-full mid-take keeps what was flushed); **I2** Stop imported against the page's old path; **I3** Start could record for one page and insert into another; **I4** a reloaded window left the microphone on; **I5** takes over 4 GiB came out corrupt (now capped at about 5 h 47 min of 48 kHz stereo); **I6** the asset server read and hashed the whole file on every range request; **I7** a 2 MB log matched by name made a search take about 880 ms; **I8** `CFBundleLocalizations` had been dropped from `Info.plist`, so a Spanish Mac would open in English.
- Minors fixed: M1 (renames that change text eligibility), M2 (a bounded queue in the microphone callback — no test, it's the real-microphone path), M3 (quit asks Save / Don't Save / Cancel before stopping the take), M4 (a take still starting is stopped by a vault switch), M5 (one cache folder per take).
- The pragma change (32 MB cache, in-memory temp store) was judged safe.

### Deferred

- **M6 audio M6:** with neither a live editor view nor a stored state, insertion falls back to position 0 (above the frontmatter). The pattern predates M6 (drops do the same).
- **M6 audio M7:** one clip at a time holds only within a window; raw `<audio>` in notes and other windows can play at the same time.
- **MP3 recording** (§1.4).
- **Linux:** building needs `libasound2-dev` (CI and M8).

### Rulings to confirm (taken on Jose's behalf)

**Audio (M6 spec §10–§11)**
1. WAV only for now; MP3 deferred (why in §1.4).
2. Record clip is a microphone button in the page header; the recorder bar opens under the header and also holds Upload clip….
3. Takes are staged in the app's cache folder, not the vault; Stop imports them through the normal attachment rule.
4. Clip names: `clip-YYYYMMDD-HHMMSS` in local time, proposed by the page; Rust accepts only that shape.
5. A denied microphone on macOS shows a hint after 3 s of exact silence (macOS gives silence, not an error).
6. A clip inserted in the middle of a line shows as text; the player appears only for a clip on its own line.
7. Auto save off + Don't Save leaves the recorded clip in the attachments folder, unlinked.
8. A system quit mid-take always goes through the close prompts, whatever the auto save setting (a logout is cancelled once).
9. Recovered clips are imported next to their page but **not linked into it**; a toast lists them until dismissed.
10. A take ends itself at 4,000,000,000 bytes (about 5 h 47 min of 48 kHz stereo).
11. Range requests are served at most 8 MiB at a time.
12. No `audio_record_current` command: after a window reload Rust has already stopped and kept the take.

**Text search (M5 spec §12)**
13. Text files are in results by default; the **Text files** chip only narrows to them (no "exclude" chip yet).
14. Links-from keeps a text file a page links to (the brief said exclude it).
15. Shift+Enter on a text hit opens the text view, like Enter (a text file has no Global View card).
16. Recent lists text files alongside pages.
17. Snippets come only from the first 64 K characters and only when the body matched.

**Notion import (M7 spec §12, §15, §16)**
18. Nested zips are expanded only for Notion's multi-part shape; any other `.zip` is an attachment.
19. A top-level `Export-<id>` folder is dropped.
20. HTML other than `<aside>` and `<details>` is kept as written.
21. Cancel or failure keeps the partial vault, with a report; no rollback; it isn't opened automatically (the dialog offers to).
22. Multi-select is detected heuristically (comma-separated short values); a date column or a value with `, ` then a year is never a list.
23. Dates become ISO; times kept when present; `A → B` ranges are quoted ISO ranges.
24. Notion page icons and covers aren't imported (the Markdown export doesn't carry them).
25. A database's index page sits beside its rows' folder (`Tasks.md` + `Tasks/`); `_all.csv` wins over the plain CSV.
26. Row pages lose their `Key: value` property lines; the values live in frontmatter only.
27. Relations resolve relative to the CSV's folder.
28. A CSV is a database only when Notion named it (an id in its name) or its rows' folder exists; any other CSV is an attachment.
29. Only a full disk stops an import; every other per-file error is a warning and the import continues.
30. Vault paths over 600 bytes are skipped (named in the report), not shortened.
31. The name rules live in two places (the page mirrors Rust's); Rust still enforces them.
32. Pages are converted twice (once to plan for warnings, once to write): about 1.3× the time, still far under budget.
33. Imports write plain create-only files with no per-file fsync (a crash leaves a partial vault anyway).

**Other**
34. `cache_size = -32000` and `temp_store = MEMORY` for every open vault's index.
35. RUSTSEC-2026-0370/0371/0372 ignored in `deny.toml` with a reason (Linux-only, unmaintained, no known vulnerability).

## 5. Builds

Built from the `feat/batch6` tip into the repo's own `target/` (it survives reboots):

- **Mac:** `target/release/bundle/macos/Notes In My Way.app` — ad-hoc signed only. Quit any running copy (⌘Q) and open the new one.
- **Windows:** `target/x86_64-pc-windows-msvc/release/bundle/nsis/Notes In My Way_0.1.0_x64-setup.exe` — unsigned (SmartScreen: More info → Run anyway). Cross-built on the Mac:

  ```bash
  cd apps/desktop
  export CARGO_HOME=$HOME/.nimw-cross/cargo RUSTUP_HOME=$HOME/.nimw-cross/rustup RUSTUP_TOOLCHAIN=1.99.0 XWIN_ACCEPT_LICENSE=1
  export PATH="/opt/homebrew/opt/rustup/bin:$CARGO_HOME/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
  pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
  ```

**One-time index rebuild:** the schema goes 4 → 5, so every vault rebuilds its index on first open (about 1.5 s for 10k notes).

## 6. Backlog the docs review surfaced

Found while writing `docs/architecture/index-and-database.md`; none is a regression, all predate batch 6:

1. **Orphaned index databases are never cleaned up.** A moved, renamed or deleted vault leaves its database in the app cache folder.
2. **Huge attachments are read whole to hash them** on first index and on every change (`Vault::read`), so a multi-GB attachment costs that much memory.
3. **Change detection trusts mtime and size only.** A rewrite that keeps both is missed until the next real change.
4. **Renames done while the app is closed** become a delete plus a create: links re-resolve, but icons, favourites, sort choices and Global View positions are dropped.
5. **A database corrupted while a vault is open** isn't noticed until the next open (where `PRAGMA quick_check` fails and it's rebuilt).
6. **A search holds the session's index mutex** for about 20–40 ms, blocking watcher and save re-indexing meanwhile; stale debounced searches aren't cancelled.

Also open from earlier rounds: the older `vault_open(path)` gap (a compromised page could open any folder as a vault), a file inside `.archive` opened directly from Finder is editable, the Trash measuring its size on every sidebar refresh, and no Favorites chip in search.

## 7. Next

**M8, packaging:** signed and notarized macOS builds (with the hardened runtime and the audio-input entitlement), signed Windows installers, Linux packages (with `libasound2-dev` at build time), the accessibility audit, the dark-theme polish and the performance budgets in CI. Needs Jose's answers first (signing identities, which Linux formats).

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `cargo deny` fails on RUSTSEC-2026-0370/0371/0372 | the ignores are in `deny.toml` on this branch; on an older branch, cherry-pick that change |
| Tests in two worktrees give identical "before/after" numbers | they share a `CARGO_TARGET_DIR` and reuse stale binaries; give each worktree its own target dir, or `cargo clean -p` the workspace crates |
| `read fixture dir: NotFound` in cargo tests | a test binary was built in a removed worktree: `cargo clean -p nimw-testkit -p nimw-desktop -p nimw-session -p nimw-vault -p nimw-index -p nimw-markdown -p nimw-audio -p nimw-import` |
| The app opens in English on a Spanish Mac | `CFBundleLocalizations` must be in `src-tauri/Info.plist` (pinned by `tests/bundle.rs`) |
| No sound recorded on macOS, no error | the microphone permission was denied: System Settings → Privacy & Security → Microphone |
| Linux build fails in `alsa-sys` | install `libasound2-dev` |
| `mp3lame-sys` fails under cargo-xwin | expected: MP3 is deferred (§1.4); don't add the crate back without a Windows-capable build |
