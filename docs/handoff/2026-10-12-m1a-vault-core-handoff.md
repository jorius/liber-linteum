# Hand-off: M1a Vault Core — Notes In My Way

> **Date:** 2026-10-12 · **Branch:** `feat/m1a-vault-core` (from `main` @ `cc07e13`) · not pushed, no remote configured
> **Audience:** Jose (tech lead), or anyone continuing by hand without an AI agent.
> **Goal of this file:** everything needed to understand, run, change and build on the M1a vault engine — what exists, why, every decision taken on your behalf, what is not verified, and how M1b plugs in.
> **Read first if new:** `docs/handoff/2026-10-12-m0-scaffold-handoff.md` (setup, commands, privacy layers). This document only covers what M1a adds.

---

## 1. Status at a glance

**What M1a delivers:** a headless, fully tested Rust engine that opens an existing (Obsidian) vault **without changing a single byte**, indexes it into a SQLite cache, keeps the index in sync with changes made by other programs, and creates / renames / moves / trashes files with **automatic link rewriting** that never makes a link change target.

| Area | State |
|---|---|
| Requirements covered | VLT-01, VLT-02, VLT-04, VLT-05, EXP-01 (tree data), EXP-02, EXP-03, EXP-04, PG-01, PG-04, PG-05, NFR-01, NFR-03, NFR-08 — at engine level (no UI yet) |
| New crates | `nimw-session` (orchestration), `nimw-testkit` (test-only) |
| Grown crates | `nimw-vault`, `nimw-markdown`, `nimw-index` (M0 stubs → real) |
| Untouched | `nimw-audio`, `nimw-import`, the Tauri shell, the whole UI |
| Tests | see table §1.1 — all green |
| `cargo deny check` | ok (advisories, bans, licenses, sources) |
| Platforms verified | macOS (Apple M5 Pro, macOS 27.0.1). Linux/Windows: CI will be the first run (watcher behaviour differs per OS) |
| Merge | Not merged (see §13) |

### 1.1 Test counts per crate (`cargo test --workspace`, final branch)

| Crate | Tests |
|---|---|
| nimw-vault | 40 (16 unit + 10 open_scan + 2 path_hash + 4 watch + 8 write_ops) |
| nimw-markdown | 37 (33 unit + 2 fixture_pages + 1 frontmatter_api + 1 resolve_api) |
| nimw-index | 11 (2 unit + 9 index) |
| nimw-session | 35 (4 unit + 8 open + 13 rename + 2 rename_props + 8 watching) |
| nimw-testkit | 1 |
| (M0 crates + desktop shell, unchanged) | 13 (audio 3, import 5, desktop 2 + 3 IPC) |
| **Total Rust** | **137** (121 before the final-review fixes) |
| Frontend (Vitest, unchanged) | 57 |

### 1.2 Benchmarks (NFR-03) — 10,000 generated notes

Machine: Apple M5 Pro, macOS 27.0.1, `cargo bench -p nimw-session --bench vault` (criterion default settings; release profile).

| Benchmark | Result (criterion median) | Budget |
|---|---|---|
| First full index (empty cache) | **1.096 s** | < 30 s ✅ |
| Reopen, nothing changed | **156.6 ms** | — |
| Re-index one modified file | **11.7 ms** | < 100 ms ✅ |
| Rename a page with 100 backlinks (rewrites 100 files) | **958 ms** | — (no budget; see §11 g) |

After the final-review fixes (quick run, same machine): first index 1.056 s, reopen 150 ms, re-index one file 11.3 ms, rename with 100 backlinks 1.01 s (+5 % from the new after-write verification).

Generated vault shape (`VaultShape::TEN_K`): 10,000 notes, ~400 folders up to 6 levels, ~8 links/note of mixed kinds, 3 tags/note, frontmatter on half, 1,000 attachments, one hub page with 100 backlinks. Deterministic (`seed`).

### 1.3 What is NOT in M1a
- **M1b:** Tauri commands/events/capabilities, settings store (`settings.json`: language, theme, recent vaults, "rewrite links" toggle), welcome actions (create/open vault), explorer UI, read-only page view, toasts, keyboard-reachability decision.
- **M5:** full-text search (FTS5 table arrives with a schema bump).
- **M3:** Global View queries, card layout, index-note picks.
- Writing `.nimw/vault.json` (M1a only reads it). Undo of renames.

---

## 2. Document map

| File | What |
|---|---|
| `docs/product-spec.md` | Requirements (VLT-, EXP-, PG-, NFR- IDs) |
| `docs/superpowers/specs/2026-10-12-architecture-design.md` | Whole-app architecture |
| `docs/superpowers/specs/2026-10-12-m1a-vault-core-design.md` | **M1a design (binding)** — incl. §10 amendments |
| `docs/superpowers/plans/2026-10-12-m1a-vault-core.md` | 12-task plan with all code; "Plan notes" = deviations and why |
| `docs/handoff/2026-10-12-m0-scaffold-handoff.md` | Setup, commands, privacy layers, M0 decisions |
| this file | M1a hand-off |

---

## 3. Crate map

```
nimw-session ──► nimw-vault      (filesystem only)
      │     ──► nimw-markdown   (pure parsing + link resolution, no I/O)
      └────► nimw-index      (SQLite cache; never reads/writes vault files) ──► nimw-markdown (types, FileSet)
nimw-testkit (dev-dependency only): fixtures, snapshots, polling, 10k generator
```
No crate depends on Tauri. Only `nimw-session` composes the others; M1b's Tauri shell should depend on `nimw-session` only.

### 3.1 `nimw-vault` — filesystem only
Files: `src/{lib,error,hash,path,config,vault,scan,fsops,watch}.rs`.

| Item | Signature / meaning |
|---|---|
| `VaultPath` | Validated vault-relative path, `/`-separated, **exactly as on disk** (no Unicode normalization). `new(&str) -> Result<VaultPath>` rejects empty-but-not-root, absolute, `..`, `.`, drive/UNC prefixes, NUL; `root()`, `is_root()`, `as_str()`, `parent()`, `file_name()`, `stem()`, `extension()`, `join(&str)`, `starts_with(&VaultPath)`, `rebase(from, to) -> Option<VaultPath>`, `from_fs_path(root, path)`, `to_fs_path(root)` |
| `Hash` | BLAKE3, 32 bytes: `of(&[u8])`, `to_hex()`, `from_hex(&str)` |
| `Vault::open(root: &Path) -> Result<Vault>` | Canonicalizes (strips Windows `\\?\` via `dunce`); reads `.obsidian/app.json` (`attachmentFolderPath`) and `.nimw/vault.json` (`exclude`, `attachments`); **writes nothing**; bad config → defaults + `warnings()` |
| `root()`, `attachment_policy() -> &AttachmentPolicy`, `warnings() -> &[String]`, `is_excluded(rel)` | |
| `scan() -> Result<Scan>` | `Scan { entries: Vec<Entry>, skipped }`; `Entry { path, kind: EntryKind::{File, Dir}, mtime_ns, size }`; skips hidden names, exclude globs, `.nimw-tmp-` temp files; **never follows symlinked folders**; symlinked folders, symlinks pointing outside, non-UTF-8 names and **unreadable subfolders** are reported in `skipped` (only an unreadable vault root is an error). Symlinked **files** inside the vault are indexed (but never written through, §6) |
| `scan_from(dir)`, `list_dir(dir)`, `stat(path) -> Result<Option<Entry>>`, `fs_path(path)` | |
| `read(path) -> Result<(Vec<u8>, Hash)>`, `read_to_string(path) -> Result<(String, Hash)>` (`NotUtf8` error) | |
| `write_cas(path, content, expected: Option<Hash>) -> Result<Hash>` | Atomic compare-and-swap (NFR-08): temp file `.<name>.nimw-tmp-<random>` in the same folder → fsync → rename → fsync dir; `Some(h)` = must still be `h` else `Conflict { current }`; `None` = create-only else `AlreadyExists`; keeps permissions; refuses paths escaping through symlinks |
| `create_dir(path)`, `rename(from, to)` (fails if target exists; case-only renames via a temp hop), `trash(path)` (OS trash) | |
| `watch(callback) -> Result<Watcher>` | `notify` 8.2 with an **in-crate debouncer** (`DEBOUNCE` = 200 ms of quiet, batches capped at 2 s); callback gets `Vec<WatchEvent>` batches; `WatchEvent::{Changed(VaultPath), Removed(VaultPath), Overflow}`; hidden/excluded/outside paths dropped; backend errors, "rescan needed" signals and events on the vault root become `Overflow`; drop the `Watcher` to stop |
| `VaultError` | `NotFound`, `AlreadyExists`, `Conflict { path, current }`, `OutsideVault`, `NotUtf8`, `InvalidConfig { file, reason }`, `Io { path, source }`, `Watch` |
| `is_hidden_name(name)` | M0, unchanged |

**Never:** depend on Tauri; interpret Markdown; touch the index.

### 3.2 `nimw-markdown` — pure parsing, no I/O
Files: `src/{lib,title,types,wikilink,frontmatter,body,page,resolve}.rs`.

| Item | Signature / meaning |
|---|---|
| `parse_page(source: &str, file_stem: &str) -> PageMeta` | Everything the index needs from one page |
| `PageMeta` | `title, subtitle, cover, cover_y (0..=100), tags: Vec<Tag>, links: Vec<LinkRef>, excerpt (≤ 200 chars after first H1), has_image, has_audio, frontmatter_error: Option<String>` |
| `Tag` | `{ text, key }` (`key` = lowercase); `Tag::new(text)` |
| `LinkKind` | `Wiki, Embed, Markdown, MarkdownImage, FrontmatterRelated, FrontmatterCover`; `as_str()`, `parse()`, `is_wiki_style()` |
| `LinkRef` | `kind, target (decoded, without #heading/|alias), heading, alias, range (byte range of the TARGET text as written), encoded, angle, label, directed` |
| `FileSet` | All vault file paths with case/NFC-insensitive lookups: `new(iter)`, `insert`, `remove`, `contains`, `iter`, `len` |
| `resolve(kind, target, source, files) -> Option<String>` | PG-05 rules (§5) |
| `shortest_unique_target(target_path, source, files, kind, rooted) -> String` | Shortest link text that still resolves to `target_path` |
| `name_key(s)`, `link_key(target_or_path)`, `normalize_join(base_dir, rel)` | NFC + lowercase keys; path joining |
| `extract_title(source, file_stem)` | M0, unchanged |

**Never:** read files, hold state, depend on the index.

### 3.3 `nimw-index` — SQLite cache
Files: `src/{lib,schema,rows,index}.rs`. Schema v1 (`SCHEMA_VERSION = 1`): tables `meta`, `files`, `pages`, `tags`, `links` exactly as spec §5.2. **No FTS.**

| Item | Signature / meaning |
|---|---|
| `Index::open(db_path) -> Result<Index>` | WAL + foreign keys; wrong schema version, foreign or corrupt file → deleted and recreated (it is only a cache) |
| `open_in_memory()` | tests |
| `transaction(|tx: &Tx| …)` | the only way to write: `Tx` has `upsert_file(&FileRow)`, `upsert_page(path, &PageMeta)`, `remove(path)` (subtree for folders), `rename(from, to)` (subtree) |
| `stats() -> HashMap<String, Stat>`, `stat(path)`, `counts() -> (files, pages)` | incremental indexing |
| `file_set() -> FileSet`, `tree() -> Vec<TreeNode>` (folders first, then case-insensitive name), `page(path) -> Option<PageRow>`, `links_from(src)`, `backlinks(path)`, `links_into(prefix)`, `links_by_key(keys)` | reads |
| `resolve_all(&FileSet)`, `resolve_affected(&FileSet, keys)`, `resolve_from(&FileSet, src)` | link resolution maintenance |
| Rows | `FileKind::{Page, Folder, Attachment}`, `FileRow`, `Stat`, `TreeNode`, `LinkRow`, `PageRow` |
| `cache_dir_name(vault_abs_path)` | M0, unchanged (16 hex chars of SHA-256) |

**Never:** touch vault files.

### 3.4 `nimw-session` — one open vault
Files: `src/{lib,error,events,session,rename,watching}.rs`.

| Item | Signature / meaning |
|---|---|
| `VaultSession::open(root: &Path, cache_root: &Path, sink: impl Fn(SessionEvent) + Send + Sync + 'static) -> Result<(VaultSession, IndexReport)>` | Opens vault + index, incremental re-index; emits `Progress` and `Indexed` |
| `index_db_path(cache_root, vault_root) -> PathBuf` | `<cache_root>/nimw/<cache_dir_name(vault)>/index.sqlite` |
| `vault()`, `tree()`, `page(path)`, `backlinks(path)` | reads |
| `create_page(dir, name) -> Result<VaultPath>` | appends `.md`; empty file; `InvalidName` for empty/whitespace/hidden names, control characters and any of `/ \ # \| ^ [ ] : * " < > ?` (Obsidian's rule set — such names can't be linked to); `AlreadyExists` on collision |
| `create_folder(parent, name) -> Result<VaultPath>` | |
| `rename(from, to, rewrite_links: bool) -> Result<RenameOutcome>` | §6; the new name obeys the same name rules as `create_page` |
| `trash(path) -> Result<()>` | OS trash + index removal; links become unresolved |
| `start_watching(self: &Arc<Self>) -> Result<()>`, `stop_watching()`, `apply(events: Vec<WatchEvent>)` | §7 |
| `IndexReport` | `files, pages, parsed, skipped_unchanged, removed, warnings, duration` |
| `SessionEvent` | `Progress { done, total }`, `Indexed(IndexReport)`, `Changed { created, modified, removed, renamed }` (only for **external** changes) |
| `RenameOutcome` | `moved: Vec<(old, new)>` (one per file), `updated_files`, `updated_links`, `failed: Vec<(path, reason)>` |
| `SessionError` | `Vault(..)`, `Index(..)`, `NotIndexed(path)`, `InvalidName(String)`, `UnsafeRewrite(String)` (a link rewrite refused — file left unchanged, reported in `RenameOutcome.failed`) |

### 3.5 `nimw-testkit` — test-only (dev-dependency)
`fixture_path(name)`, `copy_fixture(name) -> TempDir`, `trashable_fixture(name)` (temp copy inside `$HOME`), `real_trash_tests_enabled()` (§9.4), `snapshot(root) -> BTreeMap<path, (bytes, mtime)>`, `wait_until(timeout, check)`, `VaultShape { … }` / `VaultShape::TEN_K`, `generate_vault(root, shape, seed) -> Vec<String>`.

---

## 4. How a vault is opened

1. `VaultSession::open(root, cache_root, sink)`.
2. `Vault::open(root)` — canonical root, configs read, warnings collected. **Nothing is written** (no `.nimw/`, no temp files).
3. `Index::open(index_db_path(cache_root, vault.root()))` — the database lives in the **OS cache dir** (M1b passes e.g. `dirs::cache_dir()`), never inside the vault. Schema mismatch / corruption → recreated.
4. `reindex_all()`:
   1. `vault.scan()` → current entries.
   2. Compare with `index.stats()` by `(mtime_ns, size)`. Unchanged → skipped without reading (**this is why reopening a 10k vault takes ~0.16 s**).
   3. New/changed: read + BLAKE3; same hash as stored → stat-only update; `.md` → `parse_page` in a `rayon` pass (currently serialized by a held warnings lock — deferred minor, §11 q); non-UTF-8 `.md` → stored as attachment + warning; other files → attachment rows; folders → folder rows.
   4. Index rows not on disk → removed.
   5. One writer applies everything in transactions of ≤ 500 rows; `Progress` every 200 files.
   6. `resolve_all` once; `Indexed(IndexReport)` emitted and returned.

**Why it writes nothing (VLT-02):** all writes go to the cache DB outside the vault; `Vault::open`/`scan` only read. Proven by `vlt_02_opening_any_fixture_changes_nothing` (byte + mtime snapshot of every fixture before/after, and no `.nimw/`).

---

## 5. Link resolution rules (PG-05)

Implemented in `nimw_markdown::resolve` (spec §4.4 + amendment 3).

1. Keys are **NFC-normalized + lowercased** (`ideas` = `Ideas`; `é` as 1 or 2 code points match). Paths themselves stay as on disk.
2. No extension → `<target>.md`; with extension → that exact file.
3. **Wiki-style links** (wikilinks, embeds, `related:`):
   - target **contains `/`**: (a) exact vault path, (b) relative to the source's folder, (c) unique file whose path ends with `/<target>`;
   - **bare name**: basename search directly;
   - several candidates → **same folder as source** first, then **fewest path components**, then lexicographic.
   - `[[/Name]]` (vault-rooted) is understood, and emitted only when no shorter form is unique.
4. **Markdown links and `cover:`**: relative to the source folder; leading `/` = vault root; no basename search.
5. Unresolved links keep `target_path = NULL` and resolve automatically when a matching file appears (`resolve_affected`).

**Worked example — `fixtures/vaults/ambiguous-names/`** (files: `Ideas.md`, `Projects/Ideas.md`, `Projects/Deep/Ideas.md`, `Archive/Old/Ideas.md`, `Projects/Other.md`, `Elsewhere/Note.md`, `Links.md`):

| Source | Link | Resolves to | Why |
|---|---|---|---|
| `Links.md` | `[[Ideas]]` | `Ideas.md` | same folder (root) wins |
| `Links.md` | `[[Projects/Ideas]]` | `Projects/Ideas.md` | exact path |
| `Links.md` | `[[Deep/Ideas]]` | `Projects/Deep/Ideas.md` | unique suffix `/Deep/Ideas.md` |
| `Links.md` | `[[Old/Ideas]]` | `Archive/Old/Ideas.md` | unique suffix |
| `Projects/Other.md` | `[[Ideas]]` | `Projects/Ideas.md` | same folder wins over root |
| `Elsewhere/Note.md` | `[[Ideas]]` | `Ideas.md` | no same-folder match → fewest components |

Pinned by `pg_05_ambiguous_names_follow_tie_breaks`.

---

## 6. Rename / move algorithm (EXP-02, EXP-04)

`VaultSession::rename(from, to, rewrite_links)` in `src/rename.rs` (spec §6.4 + amendment 4):

1. **Validate:** valid paths, `to` absent, a folder can't move into itself (`rename_rejects_invalid_requests`).
2. **Plan (no side effects):** `RenamePlan { old_files, new_files, moved }`.
   - Candidates = links into `from` (or its subtree) ∪ links whose `target_key` matches the basename of any moved file or any existing file sharing it ∪ links *from* moved files (their relative links change meaning).
   - For each candidate: resolve before (old file set) and after (new file set, source moved if inside the folder). If the target would change, compute `shortest_unique_target` for the moved-through target, keeping `#heading`/`|alias`, `%`-encoding and `<…>` style. A plain Markdown destination that would need a space is %-encoded (wrapping in `<…>` would break a `#heading`).
   - Per source file: list of `(byte range, replacement)` edits (`edits_for`).
3. **Move on disk** (`vault.rename`), then `index.rename` (subtree).
4. **Rewrite** each source file (at its post-move path):
   - a **symlinked note** is never written (it would become a plain file); it is reported in `failed` unless it needs no edits — its target file is rewritten instead;
   - read it (text + hash), plan edits, then **`checked_edits`**: sort, merge identical duplicates, **refuse overlapping edits**;
   - apply edits from the highest offset to the lowest (`apply_edits`);
   - **`verify`**: re-parse the new text — same number and kinds of links in the same order, and every link that resolved before resolves to the moved-through target after. Otherwise the file is left unchanged and reported (`UnsafeRewrite`), e.g. when no link text can point at a file inside a folder named with `#`;
   - `write_cas(expected = the hash just read)`. On `Conflict` (someone wrote in between): re-read, re-plan, retry — **max 3**. Persistent failure → `failed.push((path, reason))`, continue.
5. Re-parse rewritten files, `upsert_page`, `resolve_affected`.
6. Return `RenameOutcome`. M1b shows "Updated links in N files" from `updated_files.len()` and lists `failed`.

**Why move first, rewrite second:** a crash in between leaves the vault like a Finder rename (stale links, file moved) — recoverable by renaming again; the reverse order could leave links pointing at a file that never moved.

**Why no undo:** reverting writes across many files safely is its own feature; renaming back rewrites the links back.

**Guarantees:** property tests (`rename_props.rs`) check that random renames/moves never change bytes outside link target ranges and keep every link on its file. The final review found two inputs the generator didn't produce (linked images `[![a](x)](x)` and frontmatter with a blank first line) that corrupted notes — both are fixed and pinned by tests, and `checked_edits` + `verify` now refuse any rewrite that would overlap or move a link, whatever the input.

---

## 7. Watcher pipeline (VLT-04)

`src/watching.rs` (spec §6.5 + amendments 1–2):

1. `start_watching(&Arc<Self>)` starts `vault.watch`; the watcher holds a weak reference to the session (no cycle); `stop_watching()` drops it.
2. **Classification:** each debounced batch is a list of paths; each is classified by what exists **now**: exists → `Changed`, gone → `Removed`; backend errors, "rescan needed" flags (lost events, e.g. an inotify queue overflow) and events on the vault root → `Overflow`. (notify-debouncer-full was dropped because on macOS it never reported deletes; notify-debouncer-mini was then replaced by an in-crate debouncer because it silently drops path-less rescan signals.)
3. `apply(events)`:
   - For every reported path, **reconcile its parent folder** (`list_dir` vs index rows) — a rename can arrive as only the new name.
   - A `Changed` on an **already-indexed folder** (FSEvents' "rescan this folder") **reconciles that folder's whole subtree** (new, changed and vanished files).
   - `Changed` → compare stat, then hash, with the index; **identical → skip** (this is the own-write suppression: every session operation updates the index synchronously, so the watcher's echo of our own write matches and is dropped — no 2-second timer, so an external edit right after ours is never missed). Otherwise re-parse + `resolve_affected`.
   - `Removed` → `index.remove` (subtree) + `resolve_affected` with the keys of **every file that was inside** a removed folder, so links can move to another candidate.
   - An unreadable new folder becomes a warning; the rest of the batch is still applied.
   - A removed file and a new file with the **same content hash** in one batch → external rename: rows move, **links are not rewritten** (the other program owns that, like Obsidian).
   - `Overflow` → full incremental `reindex_all`.
4. Each batch with external effects emits one `SessionEvent::Changed { created, modified, removed, renamed }`.

Tests: `vlt_04_external_create_modify_delete_update_the_index`, `vlt_04_external_rename_moves_rows_without_rewriting_links`, `vlt_04_own_writes_are_not_reported_as_external_changes`, `vlt_04_overflow_triggers_full_rescan`, `review_focus_git_checkout_like_burst_converges`, `vlt_04_change_on_indexed_folder_reconciles_its_subtree`, `vlt_04_removed_folder_re_resolves_links_to_its_contents`, `vlt_04_unreadable_new_folder_does_not_drop_the_batch`; vault-level `vlt_04_rescan_flag_becomes_overflow`, `vlt_04_root_event_becomes_overflow`, `vlt_04_file_events_are_classified_by_disk_state`.

---

## 8. Recipes for M1b

### 8.1 Expose a session operation as a Tauri command
Follow the M0 recipe (M0 hand-off §8.1) with these specifics:
- App state: `tauri::State<Mutex<Option<Arc<VaultSession>>>>` (one vault per window). `open_vault(path)`:
  1. `let cache = app.path().app_cache_dir()?;` (the OS cache dir for `app.notesinmyway.desktop`)
  2. `VaultSession::open(path, &cache, move |ev| { let _ = app_handle.emit("vault:event", to_dto(ev)); })` — run it on a blocking thread (`tauri::async_runtime::spawn_blocking`): first index of a large vault takes ~1 s+.
  3. Wrap in `Arc`, call `start_watching()`, store in state.
- Commands are thin: parse `VaultPath::new(&s)` from the UI string (that is the path-traversal guard), call the session, map errors to `{ kind, message }`.
- Every new command: register in `configure()`, list in `build.rs` AppManifest, grant in `capabilities/main.json`, wrap in `src/ipc/index.ts`, add a `tests/ipc.rs` case.
- `SessionEvent::Changed` is only external; after a UI-initiated `create/rename/trash`, refresh the tree from the command's result.

### 8.2 Add a new extracted field (e.g. `icon:` frontmatter)
1. `nimw-markdown/src/types.rs` → field on `PageMeta`.
2. Extract in `frontmatter.rs` (or `body.rs`), with a unit test.
3. `nimw-index/src/schema.rs` → column; bump `SCHEMA_VERSION` (old caches rebuild automatically); write in `upsert_page`, read in `page()` → `PageRow`.
4. Session/UI pick it up via `page()`.

---

## 9. Tests and fixtures

### 9.1 Test files

| File | Pins |
|---|---|
| `nimw-vault/tests/path_hash.rs` | `VaultPath` validation (VLT-05 traversal guard), `Hash` (NFR-08) |
| `nimw-vault/tests/open_scan.rs` | VLT-01 open + Obsidian attachment setting + missing folder; VLT-05 hidden/sort/kinds/excludes/bad config; VLT-02 open+scan write nothing; Review Focus: symlinks outside/folder symlinks skipped |
| `nimw-vault/tests/write_ops.rs` | NFR-08 CAS create/update/conflict, permissions, no temp leftovers; EXP-02 create_dir/rename/case-only rename; EXP-03 real OS trash (gated, §9.4); Review Focus: writes through escaping symlinks refused |
| `nimw-vault/tests/watch.rs` | VLT-04 create/modify/remove/rename reported; VLT-05 hidden/excluded dropped; Review Focus: burst delivered without loss |
| `nimw-markdown` unit tests (`src/*.rs`) | every §4 extraction rule and §4.4 resolution rule |
| `nimw-markdown/tests/{frontmatter_api,fixture_pages,resolve_api}.rs` | public API over fixtures; links in code ignored |
| `nimw-index/tests/index.rs` | PG-04 tags; PG-05 resolve_all/affected/backlinks; EXP-01 tree order; EXP-02 folder rename subtree; EXP-03 folder remove; Review Focus: corrupt/foreign/old DB rebuilt |
| `nimw-session/tests/open.rs` | VLT-02 over every fixture; PG-01/04/05 on obsidian-basic; tie-breaks; edge cases → warnings not errors; NFR-03 incremental reopen; create page/folder resolves waiting links; EXP-03 trash (gated); Review Focus: names differing only by case (case-sensitive FS) |
| `nimw-session/tests/rename.rs` | EXP-04 wikilinks/related/Markdown links; attachment → cover/embeds; folder move rewrites only links that would break; moved page fixes its own relative links; ambiguity; rewrite disabled; case-only rename; invalid requests |
| `nimw-session/tests/rename_props.rs` | property tests: bytes outside targets unchanged; targets preserved |
| `nimw-session/tests/watching.rs` | VLT-04 external create/modify/delete, external rename, own writes suppressed, overflow rescan; Review Focus: git-checkout-like burst converges |
| `nimw-testkit` | generator determinism |
| `nimw-session/benches/vault.rs` | §1.2 benchmarks |

### 9.2 Fixture vaults (`fixtures/vaults/`, byte-exact via `.gitattributes: fixtures/** -text`)
- **`obsidian-basic/`**: `.obsidian/app.json` (attachment folder), `.trash/old.md` (hidden-folder stand-in for `.git/`), `Welcome.md`, `Character Design/{rex-draft.md, My characters.md, DMC/Sparda.md, assets/{rex-cover.png, rex-turnaround.png, voice-reference.mp3}}`, `Game Design/{Game 1.md, notes.txt}` — frontmatter (`subtitle`, `cover`, `tags`, `related` both forms), wikilinks with heading/alias, embeds, Markdown links (relative, rooted, %-encoded, angle), nested tags. Content mirrors the prototype's sample data.
- **`ambiguous-names/`**: §5 example.
- **`edge-cases/`**: `code.md` (links/tags inside code and HTML → ignored), `bad-yaml.md`, `empty.md`, `crlf.md`, `latin1.md` (invalid UTF-8 → attachment + warning), `target.md`, `unicode/Café ñandú 🎨.md`. NFD-named files are **not** committed (git on macOS re-normalizes names) and on-disk NFD behaviour has **no automated test yet** — NFC/NFD matching is unit-tested in `resolve`, and the final reviewer verified by hand on macOS that an NFD file links and renames correctly (§11).
- Mutating tests always work on a `TempDir` copy (`copy_fixture`); committed fixtures are never written.

### 9.3 Running focused tests
```bash
cargo test -p nimw-session --test rename                  # one test file
cargo test -p nimw-markdown resolve                       # name filter
cargo test -p nimw-vault --test watch -- --nocapture      # see watcher output
cargo bench -p nimw-session --bench vault -- --quick      # fast benchmark look (~1 min)
```

### 9.4 Tests that touch the real OS trash
`exp_03_trash_moves_to_os_trash` (vault) and `exp_03_trash_removes_from_index_and_unresolves_links` (session) move a `nimw-trash-test-*` folder from your home directory to the OS trash. They run **only when `NIMW_TRASH_TESTS=1`** — CI sets it (`.github/workflows/ci.yml`, rust job `env`); locally they print `skipped: …` and pass. Run them on purpose with `NIMW_TRASH_TESTS=1 cargo test -p nimw-vault exp_03`.

---

## 10. Rulings made on your behalf

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| 1 | **Watcher backend:** notify-debouncer-mini 0.7 instead of debouncer-full (itself replaced later, ruling 12); events `Changed/Removed/Overflow` classified by disk state; parent-folder reconciliation; hash-based external rename detection (spec amendment 1) | debouncer-full never reported deletes on macOS | One extra `read_dir` per touched folder per batch |
| 2 | **Own-write suppression** by comparing stat/hash with the synchronously updated index instead of a 2-s table (amendment 2) | Same effect; never misses an external edit right after ours | None observed |
| 3 | **Resolution:** exact/relative rules only for targets with `/`; `resolve(kind, target, source, files)`; rooted `[[/Name]]` fallback (amendment 3) | Otherwise same-folder tie-break could never apply; Obsidian behaves this way | Rooted form only in rare shadowing cases; it is an extension Obsidian may render as a different link |
| 4 | **Markdown destinations needing spaces are %-encoded**, not `<…>`-wrapped (amendment 4) | Wrapping breaks `#heading` suffixes | Slightly less readable link text in that case |
| 5 | **API additions** (`Scan.skipped`, `scan_from`, `list_dir`, `stat`, `fs_path`, `VaultError::Watch`, `TMP_MARKER`, `Index::open_in_memory/stats/links_from/resolve_from/counts`, `Tx`, `index_db_path`, `vault()`, `stop_watching`, `start_watching(&Arc<Self>)`) | Needed by later tasks | More public surface to maintain |
| 6 | **`Changed` events only for external changes**; own operations return results (amendment 5) | Avoids double UI refresh | M1b must refresh after its own calls |
| 7 | **Test kit crate** `nimw-testkit`; trash tests copy into `$HOME` (Linux temp dir is often another filesystem than the trash) | Shared helpers; real trash works | — |
| 8 | **Fixtures:** `.trash/` instead of `.git/`; NFD names not committed; `.gitattributes` keeps bytes exact (amendment 6) | git limitations | On-disk NFD only verified by hand (§11) |
| 9 | **Executor:** Tasks 1–12 were applied by cherry-picking the planning agent's verified replay commits (built on `e294f87`) instead of re-typing ~7.2k lines; each task was re-verified here on its own commit (fmt, clippy `-D warnings`, the crate's tests — all green) | Same code, already replayed RED→GREEN step by step | RED evidence comes from the planning replay, not this executor; the final fresh review covers the gap |
| 10 | **Real-trash tests gated** behind `NIMW_TRASH_TESTS=1` (CI sets it) — approved by you | Local runs no longer fill your Trash | Local runs don't exercise the real trash |

| 11 | **Final review:** re-graded M1 (rewrites replaced symlinked notes with plain files) from Minor to Important and fixed it | A symlink silently stopping to point at the shared original is data damage | Symlinked notes' links are reported, not auto-edited (their target file is) |
| 12 | **Final review:** replaced notify-debouncer-mini with an in-crate debouncer on notify 8.2 (200 ms quiet, 2 s cap) | debouncer-mini drops path-less rescan signals (I4) | Simpler than a library debouncer (no per-path timers); covered by real watcher tests |
| 13 | **Final review:** declined-to-judge items stand as set aside (other link-typed frontmatter keys, `%% %%` comment links, 958 ms rename, Linux/Windows watcher, hard links/xattrs, crash between disk and index rename, multi-instance) | Outside the spec's scope or harmless | Listed in §11 |

---

## 11. Known gaps / deferred

| # | Gap | Effect | Target |
|---|---|---|---|
| a | External **folder** renames are seen as remove + create | Pages are re-parsed and links re-resolve correctly, but rows are not moved (slower for big folders) | later (perf) |
| b | Incremental indexing is stat-based: a file rewritten within the same mtime tick with the same size looks unchanged | Picked up at the next real change or when the watcher reports it (watcher compares hashes) | accept |
| c | Frontmatter values written with YAML escape sequences (e.g. `"\u00e9"`) are **not indexed** as links | Such a `related:`/`cover:` link is invisible to backlinks and not updated on rename | when needed |
| d | `[[/Name]]` rooted form is an extension | Only emitted when no suffix is unique | accept |
| e | No FTS | Search is M5 | M5 |
| f | No undo for renames | Rename back manually | later |
| g | Rename with 100 backlinks takes ~0.96 s | Acceptable for M1, noticeable for very linked pages; UI should show progress/spinner | profile in M8 if needed |
| h | Watcher only verified on macOS | Linux (inotify) and Windows (ReadDirectoryChangesW) behave differently; lost-event signals now force a rescan, but a real overflow was only simulated | first CI run / manual check |
| j | Small race windows (final review M2): `write_cas` checks the hash before writing the temp file; create-only and `rename` check existence, then rename | A file written in that sub-millisecond window could be overwritten | use `renameat2(RENAME_NOREPLACE)` / `renamex_np(RENAME_EXCL)` |
| k | Reference-style Markdown links (`[x][ref]` / `[ref]: a.md`) and destinations with backslash escapes or HTML entities are not indexed or rewritten (M3) | Such links break silently on rename (Obsidian never creates them) | later |
| l | Frontmatter edge cases (M4): a closing `--- ` with trailing spaces drops the frontmatter; YAML aliases (`*x`) shift key/value pairs | Lost `related`/`subtitle` in those files | later |
| m | Case-colliding names on case-sensitive filesystems (M5): exact-match fallback depends on insertion order, so two file sets can disagree; the case-sensitive test only runs on Linux | Rare rename edge on Linux | later |
| n | `trash()` holds the index lock during the OS trash call (M6) | A macOS permission prompt would stall reads and the watcher | M1b (release the lock first) |
| o | Watcher warnings are delivered as `Indexed(IndexReport { files: 0, … })` (M7) | M1b could misread it as "0 files" | M1b: add `SessionEvent::Warning` |
| p | Excerpt resets on every H1, not only the first (M8) | Excerpt may start later than expected | later |
| q | Parallel parse serialized by a held warnings lock (M9) | First index slower than it could be (still ~30× under budget) | perf pass |
| r | `Index::open` deletes the DB on any error, incl. "database busy" (M10) | An unneeded re-index | later |
| s | Other link-typed frontmatter keys (`up: "[[X]]"`) are not indexed; links inside `%% %%` comments are indexed and rewritten | Spec scope (only `related`/`cover`) | if requested |
| i | `.nimw/vault.json` read, never written | Exclude globs editable only by hand | Settings milestone |

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Watcher tests time out on a busy machine | They poll up to 5–15 s for events; rerun, or run that file alone: `cargo test -p nimw-session --test watching` |
| macOS asks for permission when trash tests run | Normal for Finder trash access; only with `NIMW_TRASH_TESTS=1` |
| `cargo bench` takes ~5 min | criterion default sampling; use `-- --quick` |
| Index seems stale or broken | Delete the cache folder `<OS cache>/nimw/<16-hex>/` (or bump schema); next open rebuilds (~1 s per 10k notes) |
| `cargo deny` warns "license not encountered" | Unused allow entries; harmless |
| A fixture test fails after editing a fixture | Fixtures are byte-exact (`fixtures/** -text`); don't let an editor convert CRLF/encoding |
| `cargo test -p nimw-desktop` fails: `../dist` missing | Run `pnpm build:ui` first (M0 hand-off §16.1) |

---

## 13. Next steps

1. Merge `feat/m1a-vault-core` (final review done, fixes in — §14).
2. **M1b design + plan:** Tauri commands over `VaultSession` (§8.1), settings store (OS config dir: language, theme, recent vaults, rewrite-links toggle), welcome actions with the dialog plugin, explorer tree UI, read-only page view, toasts, keyboard reachability decision (M0 hand-off §15).
3. Push to GitHub to get the first CI run on Linux/Windows (watcher + trash behaviour).

---

## 14. Final review

A fresh whole-branch review (most capable model, read-only, reproducing each finding with throwaway tests) returned **With fixes**: 1 Critical, 5 Important, 10 Minor, plus 8 hand-off inaccuracies. All Critical/Important findings were fixed test-first (each new test watched failing, then passing), in commits `0f25c85`, `366cad1`, `551eaed`, `bf2b1c4`:

| Finding | Fix | Pinned by |
|---|---|---|
| **C1** rename corrupted notes through overlapping edits (linked images; frontmatter pulldown-cmark doesn't recognise) | Destination found from the link's *last* `](`; body parsing skips the frontmatter range; `checked_edits` refuses overlaps; `verify` refuses any rewrite that changes link count, kinds or targets | `exp_04_linked_image_has_distinct_ranges`, `exp_04_frontmatter_links_are_not_duplicated_as_body_links`, `exp_04_linked_image_and_unrecognised_frontmatter_rewrite_cleanly`, `exp_04_overlapping_edits_are_refused_and_duplicates_merged` |
| **I1** names with `#`, `\|`, `^`, `[`, `]`… produced unlinkable files and broken rewrites | Name validation on create and rename; `#`/`?` %-encoded in Markdown destinations; `verify` reports instead of writing a link that can't resolve | `exp_02_names_that_would_break_links_are_rejected`, `exp_04_markdown_destination_into_hash_folder_is_encoded`, `exp_04_unlinkable_rewrite_is_reported_not_written` |
| **I2** table alias `[[A\|alias]]` not extracted | Text regions merge across the escaped pipe; `\|` is the alias separator | `pg_05_table_alias_with_escaped_pipe_is_a_link` |
| **I3** one unreadable subfolder made the vault fail to open; the watcher dropped a whole batch | Unreadable subfolders/entries go to `skipped` / warnings | `vlt_01_unreadable_subfolder_is_skipped_not_fatal`, `vlt_04_unreadable_new_folder_does_not_drop_the_batch` |
| **I4** lost-event and folder-level rescan signals were dropped | In-crate debouncer keeps rescan flags → `Overflow`; root events → `Overflow`; `Changed` on an indexed folder reconciles its subtree | `vlt_04_rescan_flag_becomes_overflow`, `vlt_04_root_event_becomes_overflow`, `vlt_04_change_on_indexed_folder_reconciles_its_subtree` |
| **I5** a folder removed in one event left links unresolved instead of moving them to another candidate | Re-resolve with the keys of every file that was inside | `vlt_04_removed_folder_re_resolves_links_to_its_contents` |
| **M1 → Important** rewrites replaced symlinked notes with plain files | Rewrites never write a symlink | `exp_04_symlinked_notes_stay_symlinks` |
| Hand-off inaccuracies (M11) | Corrected in this document (§3.1, §3.3, §4, §6, §9.2, §10, §11) | — |

After the fixes: `pnpm check` green (57 Vitest + **137** Rust tests), `cargo deny check` ok, benchmarks within budget (§1.2). The remaining Minor findings are deferred in §11 (j–s). The reviewer's Review Focus check flagged #2 (case/Unicode on disk) and #4 (bursts) as under-pinned: #4 now has three more tests; #2 still lacks an on-disk NFD test and a Linux run of the case-sensitive test (§11 m).
