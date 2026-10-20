# M1a — Vault Core: Design

> **Status:** Approved in design review · **Date:** 2026-10-12
> **Roles:** Jose — tech lead (decisions below are DECIDED)
> **Parent docs:** product spec `docs/product-spec.md` (v0.2) · architecture `docs/superpowers/specs/2026-10-12-architecture-design.md` · M0 hand-off `docs/handoff/2026-10-12-m0-scaffold-handoff.md`
> **Scope:** the headless Rust core of milestone M1. The app integration (Tauri commands, settings store, welcome actions, explorer UI) is **M1b** and gets its own short design.

---

## 1. Goal and success criteria

M1a turns the M0 crate stubs into a working, fully tested vault engine: open an existing (Obsidian) vault without changing it, index it, keep the index in sync with changes made by other programs, and perform file operations — create, rename/move with link rewriting, trash — safely.

Success means:
1. Opening any fixture vault changes **no** file bytes or mtimes and creates no `.liber/` folder (VLT-02).
2. Titles, tags and links are extracted and resolved by Obsidian's rules (PG-01, PG-04, PG-05).
3. External creates/edits/deletes/renames are reflected in the index without restart (VLT-04).
4. Renaming or moving a page, attachment or folder rewrites every reference so no link changes target (EXP-02, EXP-04).
5. Delete moves to the OS trash (EXP-03).
6. Performance on a generated 10,000-note vault: first full index < 30 s, re-index of one file < 100 ms (NFR-01, NFR-03).
7. Everything runs headless (`cargo test`, `cargo bench`), with no Tauri dependency.

### 1.1 Decisions taken in the M1 design review

| Topic | Decision |
|---|---|
| Planning | M1 is split: **M1a core** (this doc) and **M1b app** (separate design + plan) |
| Page view in M1 | Read-only page view (title, tags, path, raw Markdown); CodeMirror arrives in M2 — M1b concern |
| Link rewrite on rename/move | **Automatic**, then a summary ("Updated links in N files"); a setting can turn it off (setting itself is M1b) |
| Vaults | One vault per window; switch via the welcome screen (M1b) |
| References rewritten | **All**: wikilinks (keeping `#heading` and `|alias`), embeds, Markdown links, frontmatter `related:` and `cover:` |
| Ambiguity | Rewrite affected links to the **shortest form that still resolves to the same file** |
| Benchmarks | Yes: criterion benches on a generated 10k-note vault |
| Test data | Synthetic fixture vaults in the repo only (no personal vaults) |
| Orchestration | New crate **`liber-session`** composing vault + markdown + index |

---

## 2. Crates and dependencies

```
liber-session ──► liber-vault      (filesystem only)
      │     ──► liber-markdown   (pure parsing, no I/O)
      └────► liber-index      (SQLite cache) ──► liber-markdown (record types only)
```

- `liber-vault` and `liber-markdown` depend on no internal crate.
- No crate depends on Tauri (M0 rule). `apps/desktop/src-tauri` will depend on `liber-session` only (M1b).
- `liber-audio` and `liber-import` are untouched in M1a.

### 2.1 New third-party crates (all GPL-3.0-compatible licenses, no network code)

| Crate | Version | License | Used by | Purpose |
|---|---|---|---|---|
| `rusqlite` (feature `bundled`) | 0.40.x | MIT | index | SQLite, WAL |
| `notify` | 8.2.x | CC0-1.0 | vault | file watching |
| `notify-debouncer-full` | 0.7.x (must pair with notify 8) | MIT/Apache-2.0 | vault | 200 ms debounce, rename stitching |
| `trash` | 5.2.x | MIT | vault | OS trash |
| `blake3` | 1.8.x | CC0/Apache-2.0 | vault, index | content hash |
| `yaml-rust2` | 0.13.x | MIT/Apache-2.0 | markdown | YAML with byte positions |
| `percent-encoding` | 2.3.x | MIT/Apache-2.0 | markdown, session | Markdown link destinations |
| `globset` | 0.4.x | Unlicense/MIT | vault | user exclude globs |
| `dunce` | 1.0.x | CC0/MIT-0/Apache-2.0 | vault | strip Windows `\\?\` prefixes |
| `unicode-normalization` | 0.1.x | MIT/Apache-2.0 | markdown | NFC keys for name matching |
| `thiserror` | 2.0.x | MIT/Apache-2.0 | all | error enums |
| `serde`, `serde_json` | 1.x | MIT/Apache-2.0 | vault | `.liber/vault.json`, `.obsidian/app.json` |
| `rayon` | 1.12.x | MIT/Apache-2.0 | session | parallel parsing |
| dev: `tempfile` 3.27.x, `proptest` 1.12.x, `criterion` 0.8.x | | MIT/Apache-2.0 | all | tests/benches |

`cargo deny check` must stay green; if a transitive license is new, it is added only if GPL-3.0-compatible.

---

## 3. `liber-vault` — filesystem only

All paths crossing the crate boundary are **vault-relative**.

### 3.1 `VaultPath`
- A validated relative path, stored with `/` separators, **exactly as named on disk** (no Unicode normalization: on Linux NFC and NFD names are different files; normalization is applied only to comparison keys, §4.4).
- Construction fails (`VaultError::OutsideVault`) for: empty path, absolute paths, any `..` or `.` component, Windows drive/UNC prefixes, NUL bytes, and — when resolved against the root — symlinks that point outside the vault.
- API: `VaultPath::new(&str) -> Result<VaultPath>`, `as_str()`, `parent() -> Option<VaultPath>` (`None` at root), `file_name()`, `stem()`, `extension()`, `join(&str) -> Result<VaultPath>`, `starts_with(&VaultPath)`.
- The root itself is represented as the empty-path variant `VaultPath::root()` where an API needs a directory (e.g. `create_page(dir = root, …)`).

### 3.2 `Vault`
- `Vault::open(root: &Path) -> Result<Vault>`:
  - canonicalizes `root` and strips Windows `\\?\` (via `dunce`);
  - reads, if present: `.obsidian/app.json` (only `attachmentFolderPath`) and `.liber/vault.json` (arch §3.1 schema; only `exclude` and `attachments` are used in M1a);
  - **writes nothing**.
- `root() -> &Path`, `attachment_dirs() -> AttachmentPolicy` (the resolved policy, used by the index to mark attachment folders hidden from the Global View later).
- `scan() -> Result<Vec<Entry>>` where `Entry { path: VaultPath, kind: EntryKind (File|Dir), mtime_ns: i128, size: u64 }`:
  - recursive walk, does not follow symlinked directories;
  - skips names where `is_hidden_name` (M0) is true, at any depth;
  - skips paths matching the user's exclude globs (`globset`, matched against the vault-relative path).
- `read(path) -> Result<(Vec<u8>, Hash)>`; `read_to_string` helper returning `VaultError::NotUtf8` when bytes are not UTF-8.
- `write_cas(path, content: &[u8], expected: Option<Hash>) -> Result<Hash>`:
  - `expected = Some(h)`: fails with `Conflict { current: Hash }` if the file's current hash ≠ `h`;
  - `expected = None`: create-only, fails with `AlreadyExists` if the path exists;
  - writes to a temp file in the **same directory** (`.<name>.liber-tmp-<random>`, hidden so watchers/scans skip it), `fsync`s it, renames over the target, `fsync`s the directory (Unix); on any error the temp file is removed;
  - preserves the existing file's permissions on overwrite.
- `create_dir(path)`, `rename(from, to)` (fails with `AlreadyExists` if `to` exists; case-only renames on case-insensitive filesystems are supported via a two-step rename through a temp name), `trash(path)` (via `trash` crate; `NotFound` if missing).
- `Hash`: BLAKE3, 32 bytes; `to_hex()`, `from_hex()`.

### 3.3 `Watcher`
- `Vault::watch(callback) -> Result<Watcher>` using `notify` + `notify-debouncer-full` (200 ms).
- Emits `WatchEvent::{Created(VaultPath), Modified(VaultPath), Removed(VaultPath), Renamed { from, to }, Overflow}`. Paths outside the vault, hidden or excluded are dropped before emission. Backend errors are surfaced as `Overflow` (forcing a rescan) rather than lost.
- Dropping the `Watcher` stops watching.

### 3.4 Errors
`VaultError::{NotFound(path), AlreadyExists(path), Conflict { path, current: Hash }, OutsideVault(String), NotUtf8(path), InvalidConfig { file, reason }, Io { path, source }}`. A malformed `.liber/vault.json` or `.obsidian/app.json` is **not** fatal: `open` succeeds with defaults and returns the problem in `Vault::warnings()`.

---

## 4. `liber-markdown` — pure parsing

### 4.1 Output types
```rust
pub struct PageMeta {
    pub title: String,               // PG-01 (existing extract_title)
    pub subtitle: Option<String>,    // frontmatter `subtitle`
    pub cover: Option<String>,       // frontmatter `cover` (raw)
    pub cover_y: Option<u8>,         // frontmatter `cover-y`, clamped 0..=100
    pub tags: Vec<Tag>,              // body + frontmatter, de-duplicated by key
    pub links: Vec<LinkRef>,
    pub excerpt: String,             // ≤ 200 chars, plain text
    pub has_image: bool,
    pub has_audio: bool,
    pub frontmatter_error: Option<String>,
}
pub struct Tag { pub text: String, pub key: String }   // key = lowercase
pub enum LinkKind { Wiki, Embed, Markdown, MarkdownImage, FrontmatterRelated, FrontmatterCover }
pub struct LinkRef {
    pub kind: LinkKind,
    pub target: String,              // decoded target, without #heading / |alias
    pub heading: Option<String>,
    pub alias: Option<String>,
    pub range: std::ops::Range<usize>, // byte range of the TARGET text in the source (as written, possibly %-encoded)
    pub encoded: bool,               // target was %-encoded in the source (Markdown links)
    pub angle: bool,                 // Markdown destination written as <…>
    pub label: Option<String>,       // related: object form
    pub directed: bool,              // related: object form
}
pub fn parse_page(source: &str, file_stem: &str) -> PageMeta;
```

### 4.2 Frontmatter
- Recognized only when the file starts with `---\n` (or `---\r\n`) and a closing `---` line exists; parsed with `yaml-rust2`'s event parser so scalar values carry byte positions.
- Keys read: `subtitle`, `cover`, `cover-y`, `tags` (sequence, or comma/space-separated string; leading `#` stripped), `related` (sequence of strings `"[[X]]"` or mappings `{link, label, directed}`).
- `related` entries produce `LinkKind::FrontmatterRelated` with `range` = the inner target bytes inside `[[…]]` within the YAML scalar. `cover` produces `LinkKind::FrontmatterCover` with `range` = the scalar's value bytes (excluding quotes).
- Malformed YAML: `frontmatter_error = Some(message)`, frontmatter fields left empty, body still parsed. Never panics.

### 4.3 Body
- Parsed with pulldown-cmark (`into_offset_iter`; options: tables, tasklists, strikethrough, YAML metadata blocks).
- **Ignored regions:** fenced and indented code blocks, inline code, HTML blocks and inline HTML (incl. comments). No links or tags are extracted from them.
- **Wikilinks / embeds:** `[[target]]`, `[[target#heading]]`, `[[target|alias]]`, `[[target#heading|alias]]`, `![[…]]`. Detected by scanning the source bytes of text regions (pulldown-cmark splits text at `[`); escaped `\[[` is not a link. `range` covers `target` only.
- **Markdown links/images:** from pulldown-cmark `Link`/`Image` events with destinations that have no URI scheme (`http:`, `https:`, `mailto:`, `file:`, `data:`, … are skipped) and are not pure fragments (`#x`). Destination is percent-decoded into `target`; `range` covers the destination as written (inside `<…>` if angle-bracketed); `encoded`/`angle` record the style. A `#heading` suffix goes to `heading`.
- **Tags (Obsidian rules):** `#` followed by `[\p{L}\p{N}_\-/]+` containing at least one non-digit; the `#` must be at the start of a text region or preceded by whitespace; trailing `/` dropped. Heading markers are not text, so `# Title` is never a tag.
- **Excerpt:** plain text of paragraphs and list items after the first H1 (or from the start if there is none), whitespace collapsed, truncated to 200 chars on a char boundary with `…`.
- **has_image / has_audio:** any Embed / MarkdownImage / Markdown link whose target extension (case-insensitive) is in `{png, jpg, jpeg, gif, webp, svg, avif, bmp}` / `{wav, mp3, m4a}`.

### 4.4 Link resolution (PG-05) — `liber_markdown::resolve`
A pure function over the set of vault file paths so it can be used by both the index and the rename planner:

```rust
pub struct FileSet { /* lowercase-keyed lookup by full path, by basename, by stem */ }
pub fn resolve(link: &LinkRef, source: &str /* vault path of linking file */, files: &FileSet) -> Option<String /* vault path */>;
pub fn shortest_unique_target(target_path: &str, source: &str, files: &FileSet, kind: LinkKind) -> String;
```

Rules:
1. Comparisons use a key = Unicode **NFC-normalized, lowercased** path (`unicode-normalization` crate), so `é` typed as one or two code points and `Ideas`/`ideas` match, as in Obsidian on macOS.
2. A target without an extension means `<target>.md`; with an extension, the exact file.
3. Wikilinks, embeds, `related`: try (a) exact vault path, (b) path relative to the source's folder, (c) unique file whose path ends with `/<target>`, (d) basename match. Multiple candidates → prefer same folder as source, then fewest path components, then lexicographic. Deterministic.
4. Markdown links and `cover`: relative to the source's folder; a leading `/` means vault root. No basename search.
5. `shortest_unique_target` returns the shortest suffix of `target_path` (dropping `.md` for Markdown pages in wiki-style kinds) that `resolve` maps back to exactly `target_path` from `source`; for Markdown/cover kinds it returns the relative path from the source folder (keeping `/`-rooted style if the original was rooted — the caller passes that flag).

---

## 5. `liber-index` — SQLite cache

### 5.1 Location and lifecycle
- `Index::open(db_path) -> Result<Index>`; the caller (session) passes `<OS cache dir>/liber/<cache_dir_name(vault)>/index.sqlite`.
- `PRAGMA journal_mode=WAL; foreign_keys=ON`. `meta.schema_version` ≠ `SCHEMA_VERSION` (1) or open/integrity failure → delete the file (and `-wal`/`-shm`) and create fresh. The index is a cache; nothing is lost.

### 5.2 Schema v1
| Table | Columns | Indexes |
|---|---|---|
| `meta` | `key TEXT PK, value TEXT` | |
| `files` | `path TEXT PK, parent TEXT, name TEXT, ext TEXT, kind TEXT CHECK(kind IN ('page','folder','attachment')), mtime_ns INTEGER, size INTEGER, hash TEXT` | `files(parent)` |
| `pages` | `path TEXT PK REFERENCES files ON DELETE CASCADE ON UPDATE CASCADE, title, subtitle, cover, cover_y, excerpt, has_image, has_audio, frontmatter_error` | |
| `tags` | `path REFERENCES files ON DELETE CASCADE ON UPDATE CASCADE, tag, tag_key` | `tags(tag_key)`, `tags(path)` |
| `links` | `id INTEGER PK, src REFERENCES files ON DELETE CASCADE ON UPDATE CASCADE, kind, target_raw, target_key, target_path NULL, heading, alias, start, end, encoded, angle, label, directed` | `links(target_path)`, `links(target_key)`, `links(src)` |

- `kind = 'page'` for `.md` files (case-insensitive extension), `'folder'` for directories, `'attachment'` otherwise. Non-UTF-8 `.md` files are stored as `attachment` with a warning.
- `target_key` = NFC-normalized lowercase basename of the target without `.md` (used to find links affected by creates/removes/renames).
- **No FTS in M1a** — search (M5) adds it with a schema bump.

### 5.3 API
- Writes: `upsert_file(&FileRow)`, `upsert_page(path, &PageMeta)` (replaces tags/links of that page), `remove(path)` (folder → removes the subtree), `rename(from, to)` (folder → whole subtree; relies on `ON UPDATE CASCADE` plus a `parent`/path prefix rewrite), batched via `Index::transaction(|tx| …)`.
- Resolution: `resolve_all(&FileSet)`, `resolve_affected(&FileSet, keys: &[String])`.
- Reads: `file_set() -> FileSet`, `stat(path) -> Option<(mtime_ns, size, hash)>`, `tree() -> Vec<TreeNode>` (sorted: folders first, then case-insensitive name), `page(path) -> Option<PageRow>` (meta + tags + outgoing links), `backlinks(path) -> Vec<LinkRow>` (with `src`), `links_into(prefix) -> Vec<LinkRow>` (all links whose `target_path` is the path or inside the folder prefix), `links_by_key(keys) -> Vec<LinkRow>`.

---

## 6. `liber-session` — one open vault

### 6.1 Lifecycle
```rust
pub struct VaultSession { /* Vault, Mutex<Index>, recent-own-writes table, event sink */ }
pub enum SessionEvent {
    Progress { done: usize, total: usize },
    Indexed(IndexReport),
    Changed { created: Vec<String>, modified: Vec<String>, removed: Vec<String>, renamed: Vec<(String, String)> },
}
impl VaultSession {
    pub fn open(root: &Path, cache_root: &Path, sink: impl Fn(SessionEvent) + Send + Sync + 'static) -> Result<VaultSession>;
    pub fn start_watching(&self) -> Result<()>;
}
```

### 6.2 Opening (incremental index)
1. `Vault::open`, then `Index::open(cache_root/liber/<cache_dir_name>/index.sqlite)`.
2. `scan()`; diff against `files` by `(mtime_ns, size)`.
3. New/changed entries: read + hash; same hash as stored → update stat only; otherwise `.md` → parse (in parallel with `rayon`), others → attachment row.
4. Rows missing from disk → removed.
5. Single writer applies all changes in batched transactions (≤ 500 rows per transaction); `Progress` every 200 files.
6. `resolve_all` once; emit `Indexed(IndexReport { files, pages, parsed, skipped_unchanged, removed, warnings, duration })`.

### 6.3 Operations
- `tree()`, `page(path)`, `backlinks(path)` — thin wrappers over the index.
- `create_page(dir: &VaultPath, name: &str) -> Result<VaultPath>`: appends `.md` if missing; empty content via `write_cas(None)`; index + `resolve_affected(stem)`. Name collisions → `AlreadyExists` (the UI proposes "Untitled", "Untitled 1", …).
- `create_folder(parent, name) -> Result<VaultPath>`.
- `trash(path)`: OS trash, `index.remove` (subtree for folders), `resolve_affected` for the removed basenames. Links to it become unresolved; nothing is rewritten.
- `rename(from, to, rewrite_links: bool) -> Result<RenameOutcome>`: §6.4. `rewrite_links = false` (the M1b setting) skips steps 2 and 4.

### 6.4 Rename / move with link rewrite (EXP-02, EXP-04)
1. **Validate:** both `VaultPath`s valid; `to` must not exist; a folder cannot move into itself.
2. **Plan (no side effects):**
   - `old = file_set()`; `new = old` with the renamed path(s) (whole subtree for folders) substituted.
   - Candidate links = `links_into(from)` ∪ `links_by_key(basenames of every moved file and of every existing file sharing those basenames)`.
   - For each candidate link `l` from source `s`: `before = resolve(l, s, old)` (with the moved file's old path), `after = resolve(l', s', new)` where `s'` is `s` moved if `s` itself was inside the moved folder. If `after` ≠ `before` mapped through the rename, compute replacement text `shortest_unique_target(mapped(before), s', new, l.kind)`, re-encoded (`%`) if `l.encoded`, wrapped if `l.angle`.
   - Also links *from* moved files whose meaning changes because their source folder changed (relative Markdown links) are included.
   - Result: per source file, a list of `(range, replacement)` edits.
3. **Move on disk:** `vault.rename(from, to)`; update the index rows (`index.rename`). Record in the own-writes table.
4. **Rewrite:** for each source file (at its new path if it moved): read, check the hash against the index (`expected`), apply edits from the highest `range.start` to the lowest, `write_cas(expected)`. On `Conflict`: re-read, re-parse, re-plan that file's edits, retry (max 3). Persisting failure → `failed.push((path, reason))`, continue with the next file.
5. Re-parse rewritten files, `upsert_page`, `resolve_affected`.
6. Return `RenameOutcome { moved: Vec<(String, String)>, updated_files: Vec<String>, updated_links: usize, failed: Vec<(String, String)> }`.

**Order rationale:** a crash between 3 and 4 leaves the vault in the same state as a rename done in Finder (links stale, file moved) — recoverable by renaming again. Rewriting first could leave links pointing at a file that never moved.
**No undo in M1** (multi-file revert); renaming back rewrites links back.

### 6.5 Watcher integration (VLT-04)
- `start_watching` spawns the vault watcher; events go through `apply(WatchEvent)`:
  - Created/Modified → stat, hash, compare to index, re-parse if changed, `resolve_affected`.
  - Removed → `index.remove`, `resolve_affected`.
  - Renamed (from the debouncer, or remove + create with equal hash inside the debounce window) → `index.rename`, **no link rewrite** (the other program owns that, as Obsidian does).
  - Overflow → full incremental rescan (§6.2 steps 2–6).
- **Own-write suppression:** every `write_cas`/`rename`/`create`/`trash` done by the session records `(path, resulting hash or tombstone, expiry = now + 2 s)`. A matching watcher event is dropped; a non-matching one is processed normally.
- Each processed batch emits one `Changed { … }` event.

### 6.6 Errors
`SessionError::{Vault(VaultError), Index(IndexError), NotIndexed(path), InvalidName(String)}`. No panics on user data; non-UTF-8 or unreadable files are warnings in `IndexReport`.

---

## 7. Testing

### 7.1 Fixture vaults (`fixtures/vaults/`, committed, small, readable)
- `obsidian-basic/`: nested folders, `.obsidian/app.json` (with `attachmentFolderPath`), `.git/` stub, attachments (tiny PNG, WAV), pages with frontmatter (`subtitle`, `cover`, `tags`, `related`), wikilinks with heading/alias, embeds, Markdown links (relative, rooted, %-encoded, angle), nested tags.
- `ambiguous-names/`: several `Ideas.md` at different depths, links that rely on the tie-break order.
- `edge-cases/`: links/tags inside code and HTML, malformed YAML, empty files, Unicode names (é, ñ, emoji, NFD-vs-NFC), a non-UTF-8 `.md`, CRLF line endings.
- Tests copy a fixture into a `tempfile::TempDir` before any mutating test; the committed fixtures are never written.

### 7.2 Required tests (named with requirement IDs)
- **VLT-02:** open every fixture; assert all file bytes + mtimes unchanged and no `.liber/` created.
- **PG-01/04/05:** one test per §4 rule (titles, tags, each link form, each resolution rule, tie-breaks, unresolved → resolved on create).
- **EXP-02/04:** rename page, attachment, folder; move between folders; ambiguity-inducing rename; links from moved files; encoded/angle/alias/heading preservation; frontmatter `related`/`cover` rewrite; `rewrite_links = false`; conflict retry (file changed between plan and write) and persistent-conflict reporting.
- **EXP-03:** trash removes from disk (to OS trash) and index; links become unresolved.
- **VLT-04:** with a real temp folder: external create, modify, delete, rename (incl. remove+create same hash), own writes suppressed. Event waits use polling with timeout (no fixed sleeps).
- **NFR-08:** `write_cas` never leaves partial content (proptest + injected failure after temp write); temp files never appear in scans/trees.
- **Property tests:** a rename-with-rewrite changes no bytes outside link target ranges; every link's resolved target is preserved (mapped through the rename) across random renames in random vaults.

### 7.3 Benchmarks (`crates/liber-session/benches/`, criterion)
- Deterministic generator: 10,000 notes, ~400 folders up to 6 levels, avg 8 links/note (mix of kinds), 3 tags/note, frontmatter on 50%, 1,000 attachments.
- Benches: first full index; reopen with no changes; re-index one modified file; rename a page with 100 backlinks.
- Targets (NFR-03): first index < 30 s, single-file re-index < 100 ms. Results are recorded in the M1a hand-off; regressions are reviewed, not CI-gated (CI runners are noisy).

---

## 8. Out of scope for M1a (→ M1b or later)

- Tauri commands, events, capabilities; settings store (`settings.json`, language/theme persistence, recent vaults, "rewrite links" setting); welcome actions; explorer UI; read-only page view; toasts; keyboard reachability decision — **M1b**.
- FTS / search — M5. Global View queries (`gv_level`, aggregation) — M3. Card positions (`layout.json`) — M3. Index-note picks — M3.
- Writing `.liber/vault.json` (M1a only reads it).
- Undo of renames.

## 9. Spec self-review notes
- Every success criterion in §1 maps to tests in §7.2/§7.3.
- Section dependencies are acyclic (§2). The rename planner depends only on `liber-markdown::resolve` + index reads, so it is unit-testable without a filesystem.
- Ambiguities resolved explicitly: Unicode/case handling (paths stored as on disk, NFC+lowercase only for matching — §3.1, §4.4.1), tie-break order (§4.4.3), crash ordering (§6.4), own-write window (§6.5, 2 s), batch size (§6.2, 500), progress cadence (§6.2, 200).

---

## 10. Amendments (2026-10-12, from compile-checking the M1a plan)

These supersede the sections they name; the M1a plan (`docs/superpowers/plans/2026-10-12-m1a-vault-core.md`, "Plan notes") records the evidence.

1. **Watcher (§3.3, §6.5):** `notify-debouncer-full` never reported deletes on macOS (FSEvents merges create/remove flags and the debouncer cancels them). Use **`notify-debouncer-mini` 0.7** (notify 8.2) with events `WatchEvent::{Changed(path), Removed(path), Overflow}`, classified by what exists on disk now. The session decides created vs. modified from the index, reconciles the **parent folder** of each reported path (a rename may arrive as only the new name), and pairs removed + new files with equal content hash as external renames.
2. **Own-write suppression (§6.5):** no 2-second table. Every session operation updates the index synchronously; `apply` skips any path whose disk stat (mtime, size) or content hash already equals the index. External edits made right after an own write are never missed.
3. **Resolution (§4.4):** rules (a) exact path and (b) path relative to the source apply only to targets that contain `/`; bare names go straight to the name search so the same-folder tie-break works (Obsidian behaviour). `resolve` takes `(kind, target, source, files)`. `shortest_unique_target` takes `rooted: bool` and, for wiki-style links, falls back to a vault-rooted `[[/Name]]` only when no path suffix is unique.
4. **Markdown destinations (§6.4):** a plain destination that needs a space is %-encoded instead of `<…>`-wrapped (wrapping would break a `#heading` suffix); encoded stays encoded, angle stays angle.
5. **Session events (§6.1/§6.3):** `create_page`, `create_folder`, `rename`, `trash` return results and do not emit `Changed`; `Changed` is only for external changes.
6. **Fixtures (§7.1):** `.trash/` replaces the `.git/` stub (git cannot commit a nested `.git`); NFD names are created at test runtime (git on macOS re-normalizes names); `.gitattributes` keeps fixture bytes exact.
7. **Test kit:** a test-only crate `liber-testkit` (fixture copies, snapshots, polling helpers, 10k-note generator).
8. **Watcher debouncing (final review, supersedes the library choice in amendment 1):** `notify-debouncer-mini` silently drops path-less "rescan needed" signals, so `liber-vault` debounces raw `notify` 8.2 events itself (200 ms of quiet, batches capped at 2 s). Rescan flags, backend errors and events on the vault root become `Overflow`; a `Changed` on an already-indexed folder reconciles its subtree.
9. **Rename safety (final review):** names created or renamed by the app may not contain `/ \ # | ^ [ ] : * " < > ?`, control characters, or start with `.`; every rewrite is checked before writing (no overlapping edits; same links, each still resolving to its file) and symlinked notes are never written — refused files are reported in `RenameOutcome.failed`.
