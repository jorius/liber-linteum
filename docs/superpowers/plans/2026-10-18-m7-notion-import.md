# M7 Notion Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a Notion "Markdown & CSV" export zip into a new vault, after a dry-run preview.

**Architecture:**
- `crates/nimw-import` holds the whole pipeline, as pure functions over the zip and a plan:
  - `archive`: reading, nested parts, safety, limits;
  - `names`: id strip, clean, dedupe;
  - `markdown`: links, callouts, row properties;
  - `database`: CSV, inference, index page;
  - `import`: plan, preview, write.
- It writes only through `nimw-vault`.
- The desktop app adds five commands and one dialog. The page never sends a path.

**Tech Stack:**
- Rust: `zip` 9 (deflate via flate2 + zlib-rs only), `tempfile`, `nimw-vault`, `nimw-session` (name rules).
- Frontend: React and zustand. i18n via ICU messages.

**Spec:** `docs/superpowers/specs/2026-10-18-m7-notion-import-design.md`

## Global Constraints

**Writing:**
- Writes only inside the new vault folder, create-only, through `VaultPath` and `nimw-vault` (spec §8).
- The target must not exist. Its parent must be the folder Rust just picked.

**Zip limits:**
- 200,000 entries, 16 GiB total, 4 GiB per entry.
- A ratio of 1,000:1 for entries over 1 MiB.
- Markdown and CSV entries up to 32 MiB.

**Name rules:** the same as the app's, via `sanitize_file_name`. De-duplication uses " 1", " 2", and is case-insensitive and NFC-normalized.

**Desktop commands:**
- Async through `blocking()`.
- Allowed in `main` only, and denied in `file-*` windows.
- Real-ACL tests both ways.

**App-wide rules:**
- i18n en and es, axe-clean in light and dark, keyboard parity, the Safari 15 floor.
- Signed commits with the Co-Authored-By trailer.
- No network.

## Review Focus

1. **A malicious zip.** Zip-slip names, symlink entries, a lying size header and a deflate bomb must be refused before any write. Nothing must be created outside `<parent>/<name>`.
2. **Large multi-part exports.** Nested part zips go through temp files that must be cleaned up, even on cancel or error.
3. **Name collisions after id stripping.** These include case-only and NFC/NFD collisions on macOS and Windows. Links must point at the de-duplicated names.
4. **Database rows whose page names differ from their CSV titles** (truncation or sanitizing). Expect warnings, not silent mismatches, and no lost rows.
5. **Cancel mid-import.** The partial vault and its report must be consistent; files written so far stay valid, with no half-written ones.

---

### Task 1: The archive reader

**Files:** create `crates/nimw-import/src/archive.rs`; update `Cargo.toml` and `lib.rs`.

**Interfaces (produces):**
- `pub struct Limits { entries, total, entry, ratio, text }`, with `Limits::default()`.
- `pub struct Export`, built by `Export::open(path: &Path, limits: &Limits) -> Result<Export>`.
- Its members:
  - `entries() -> &[Entry]`, where `Entry { path: Vec<String>, size: u64, part: usize, index: usize }`;
  - `warnings() -> &[String]`;
  - `read_text(&Entry) -> Result<String>`;
  - `copy_to(&Entry, &mut dyn Write) -> Result<u64>`.

**Tests (all fail first):**
- a plain export lists its files;
- the `Export-<id>` root is dropped;
- multi-part zips are expanded;
- a stray `.zip` inside an export stays an entry;
- `../x`, `/x`, `C:x`, `a/./b` and symlink entries are refused, each with a warning;
- the entry-count limit is refused;
- a bomb over the ratio is refused;
- a declared-size lie is caught on copy.

- [ ] Write the tests.
- [ ] Watch them fail.
- [ ] Implement.
- [ ] Watch them pass.
- [ ] Commit.

### Task 2: Names

**Files:** create `crates/nimw-import/src/names.rs`.

**Interfaces (produces):**
- `pub fn clean_component(raw: &str) -> String`: strip the id, sanitize, trim, handle device names, cap at 200 bytes.
- `pub struct NameMap`, built by `NameMap::build(paths: &[Vec<String>]) -> NameMap`. Its methods:
  - `get(&[String]) -> Option<&str>`: the original path to its vault path;
  - `folder_of(&[String])`.

**Tests:**
- the id is stripped;
- forbidden characters are replaced;
- device names are suffixed;
- the 200-byte cut lands on a char boundary;
- duplicates in one folder become `X.md`, `X 1.md`;
- case and NFC duplicates collide;
- `Page.md` and `Page/` coexist;
- the order is stable.

### Task 3: Markdown conversion

**Files:** create `crates/nimw-import/src/markdown.rs`.

**Interfaces:**
- *Consumes:* a `Resolver` trait (`fn page(&self, rel: &str) -> Option<String>`, `fn database(&self, rel) -> Option<String>`, `fn asset(&self, rel) -> Option<String>`), supplied by Task 5.
- *Produces:* `pub fn convert(text: &str, own_dir: &[String], r: &dyn Resolver, warnings: &mut Vec<String>) -> String`, plus `pub fn strip_properties(text: &str, keys: &[String]) -> String`.

**Tests:**
- a `.md` link becomes `[[X]]` or `[[X|Text]]`;
- an ambiguous target becomes the full path;
- a `.csv` link points to the index page;
- an image becomes `![[path]]`;
- external and anchor links are untouched;
- code fences and code spans are untouched;
- a missing target is kept, with a warning;
- an aside becomes a callout;
- details/summary becomes a folded callout;
- nesting works;
- property lines are stripped only for CSV keys and only right after the H1.

### Task 4: Databases

**Files:** create `crates/nimw-import/src/database.rs`.

**Interfaces (produces):**
- `pub fn parse_csv(text: &str) -> Vec<Vec<String>>`.
- `pub fn frontmatter(headers: &[String], rows: &[Vec<String>], r: &dyn Resolver) -> Vec<String>`: one YAML block per row.
- `pub fn index_page(title: &str, folder: &str, rows: &[(String, Vec<String>)], headers: &[String]) -> String`.

**Tests:**
- quotes, newlines and the BOM in CSV;
- inference of booleans, numbers, dates (Notion and ISO), relations, multi-select and text;
- leading zeros stay text;
- empty cells are omitted;
- YAML quoting is safe;
- the index table escapes `|` and newlines.

### Task 5: Plan, preview and import

**Files:**
- create `crates/nimw-import/src/import.rs`;
- add `Vault::import_reader` in `crates/nimw-vault/src/fsops.rs`, refactoring `import_file` to use it.

**Interfaces (produces):**
- `pub fn plan(export: &Export) -> Result<Plan>` and `pub struct Preview { pages, databases, rows, attachments, folders, bytes, warnings }`, from `Plan::preview()`.
- `pub fn write(export: &Export, plan: &Plan, target: &Path, progress: &mut dyn FnMut(u64, u64), cancel: &AtomicBool) -> Result<Report>`, where `Report { root, report_page, cancelled, written }`.
- `pub fn suggested_name(zip: &Path) -> String`.

**Tests:**
- the full synthetic export imports, and the expected files and contents exist;
- `_all.csv` is preferred;
- CSV-only rows get pages;
- an unmatched page raises a warning;
- an existing target is refused;
- cancelling halfway leaves the report with `cancelled`;
- the report lists the warnings;
- the preview counts are right;
- perf, as `--ignored`.

### Task 6: Desktop commands

**Files:**
- create `apps/desktop/src-tauri/src/notion_commands.rs`;
- edit `lib.rs`, `build.rs`, `capabilities/main.json`, `menu.rs`;
- add tests in `tests/notion.rs`, with the denied list in `tests/file_windows.rs`.

**Interfaces:**
- *Consumes:* `nimw_import::{Export, plan, write, suggested_name}`.
- *Produces:* `notion_pick_zip`, `notion_pick_parent`, `notion_preview`, `notion_import(name)`, `notion_cancel`, plus the `notion:progress` and `menu:notionImport` events.

**Tests:**
- the real ACL allows `main` and denies `file-*`;
- preview with no zip picked is `notPermitted`;
- import with an invalid name, or into an existing folder, is refused;
- import with the pickers overridden opens the vault;
- the menu item emits to `main`.

### Task 7: The import dialog

**Files:**
- create `apps/desktop/src/features/notion/NotionImportDialog.tsx`, `notionStore.ts`, `Notion.module.css` and their tests;
- edit `ipc/index.ts`, `uiStore.ts`, `DialogHost.tsx`, `Welcome.tsx`, the menu listener, the en/es locales, and `e2e/ipcMock.ts`;
- create `e2e/m7-notion.spec.ts`;
- edit `playwright.config.ts`.

**Tests:**
- the steps are enabled in order;
- name validation;
- the preview renders counts and warnings;
- the progress bar;
- cancel;
- on success, `vaultStore` opens the vault and the report page;
- on error, a message shows;
- axe;
- the e2e covers the whole flow in Chromium and WebKit.
