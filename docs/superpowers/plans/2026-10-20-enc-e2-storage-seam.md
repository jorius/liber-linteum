# Encryption E2: Storage Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every byte that crosses a vault's folder goes through one `Storage` trait, implemented today by `PlainStorage` with exactly the current behaviour, so E3 can add `EncryptedStorage` without touching callers.

**Architecture:**
- `liber-vault` gains `storage/` with the trait, its value types and `PlainStorage`. All of today's OS-level code moves into `PlainStorage`: symlink and outside-vault checks, temp-file atomic writes, case-only renames, OS trash, and `notify` translation.
- `Vault` owns a `Box<dyn Storage>`. Its public API stays logical (`VaultPath`), and the raw `fs_path`/`visible_fs_path` escape hatches are replaced by narrow trait-backed methods.
- A guard test keeps new `std::fs` calls out of vault code.
- A test-only switch lets the whole Rust suite run against another `Storage`.

**Tech Stack:** Rust 1.99, std I/O, the existing `notify`, `trash`, `dunce` and `blake3` crates. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-encryption-design.md` §8 (the storage seam) and §13 (E2: no behaviour change, parallel with E1).

## Global Constraints

- **No behaviour change.** The existing Rust, vitest and e2e suites stay green, unchanged except where a test calls a removed `fs_path`/`visible_fs_path` (Task 3 lists those).
- **Paths.** Every path crossing the trait is a `VaultPath`. The only exceptions are `location()` (identity) and `os_path()`/`vault_path_of()`, which exist to talk to the OS.
- **Dependencies.** None added. `cargo deny check` and the cargo-xwin Windows build still pass.
- **P1.** Zero network requests, as before.
- **Commits.** Signed, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never bypass signing.
- **Gate.** The gate after every task is `$SP/check.sh all <worktree>`. Tasks 1–3 may run `cargo test -p liber-vault` while iterating.

## Review Focus

1. **A symlinked note** (its target inside the vault) still opens and saves through its target, and a link-rewrite on rename still refuses to replace it with a plain file. → Task 4. The existing `exp_04_symlinked_notes_stay_symlinks` (`crates/liber-session/tests/rename.rs:388`) is the guard and must stay green unchanged.
2. **Saving over a file keeps its permissions**, for example an executable bit or read-only-for-group. Today's `set_permissions` copy must survive the move into `replace_atomic`. → Task 2, `replace_atomic_keeps_permissions` (unix).
3. **A ranged request on a 0-byte file, or past the end, answers 416, and a full read answers 200 with the exact length.** The `Reader` length must be the file's length when it opens. → Task 5, `asset_range_on_empty_file_is_416`.
4. **An import whose source fails mid-copy** (a read error or a full disk) leaves no partial file behind, as `import.rs` promises ("never leave half a file"). → Task 4, `import_failed_entry_leaves_no_partial_file`.
5. **Watch noise.** A temp file named `.<name>.liber-tmp-…`, a hidden path, or a path under an excluded glob never reaches the session. An event on the vault root itself is `Overflow`. → Task 3, `watch_drops_temp_hidden_excluded_and_flags_root`.

---

## Inventory (`git grep` of production code, `#[cfg(test)]` modules excluded, 2026-10-20)

There are 151 hits in 25 files for `std::fs | fs:: | File:: | OpenOptions | read_dir | symlink_metadata | .metadata() | canonicalize | .is_dir() | .is_file() | .exists() | notify:: | trash:: | tempfile`. A further 30 lines turn a vault path into an OS path (`fs_path(`, `visible_fs_path(`, `to_fs_path(`, `.root()`).

**Routed through the seam: 86 hits in 14 files**

| File (hits) | Today | After E2 |
|---|---|---|
| `liber-vault/src/fsops.rs` (32) | `fs_path`, `visible_fs_path`, `read`, `write_cas`, `create_dir_all`, `import_file`, `create_dir`, `rename`, `trash`, `sync_dir` | Bodies move to `PlainStorage` (`resolve`, `replace_atomic`, `create_dir`, `rename`, `trash_os`). `Vault::read/write_cas/import_file/create_dir_all/create_dir/rename/trash` keep their signatures and call `self.storage` |
| `liber-vault/src/scan.rs` (9) | `read_dir`, `symlink_metadata`, follow-a-symlink | `Vault::walk` uses `storage.children()`, and `storage.meta(_, Follow::InsideVault)` for symlinks; `mtime_ns()` moves into plain |
| `liber-vault/src/watch.rs` (7) | `notify` setup, OS→vault path translation, `exists()` | The OS side becomes `storage.watch()`. Batching, hidden and excluded filtering, sorting and dedup stay in `Vault` |
| `liber-vault/src/vault.rs` (5) | `canonicalize` + `is_dir` at open; `.liber` `create_dir`; `read_json` via `std::fs::read` | `PlainStorage::open(root)`; `storage.create_dir`; `read_json(&dyn Storage, rel, …)` |
| `liber-vault/src/layout.rs` (1) | `to_fs_path(root).symlink_metadata()` | `storage.meta(_, Follow::No).is_some()` |
| `liber-vault/src/icon.rs` (via `read_json(root)`) | `vault_icon_at(root)` | `vault_icon_at(root)` keeps its signature and reads through `PlainStorage::open(root)`. It serves the recent list, which never opens a session |
| `liber-session/src/bin.rs` (15) | `measure`, `page_icon`, `free_path`, `is_dir`, `bin_dir`, `parents_are_folders`, `trash_list`, `trash_delete_via` gone check, `prune_archive` `remove_dir` | `vault.meta(_, Follow::No)`, `vault.children()`, `vault.read()`, `vault.remove_empty_dir()` |
| `liber-session/src/quick_notes.rs` (1) | `read_dir(root)` for an exact-case name | `vault.children(&VaultPath::root())` |
| `liber-session/src/rename.rs` (1) | `symlink_metadata(fs_path)` (is it a symlink?) | `vault.meta(path, Follow::No)?.kind == Kind::Symlink` |
| `liber-session/src/session.rs` (1) | `metadata(fs_path).created()` for folder sort | `vault.meta(_, Follow::InsideVault)?.created` |
| `liber-session/src/attachments.rs` (2 of 5) | `from_fs_path(root, real)` (is the dropped file already inside?); `fs_path` for an absolute `file://` link | `vault.vault_path_of(&real)`; `vault.os_path(path, OsUse::FileUrl)` |
| `liber-session/src/external.rs` (path line 302) | `from_fs_path(root, real)` | `vault.vault_path_of(&real)` |
| `liber-import/src/import.rs` (3 of 4: lines 566, 567, 586) | `fs_path` + `OpenOptions::create_new` + `remove_file` on failure | `vault.create_new(path)` and `vault.remove_file(path)` |
| `src-tauri/src/asset.rs` (5) | `.trash` image: `root.join` + `symlink_metadata`; `respond_file(&Path)` opens and seeks a file | `vault.meta(".trash/<n>", Follow::No)`; `vault.open_read(path, Reach::Visible / Any)` → `respond(reader, mime, range)` |
| `src-tauri/src/editor_commands.rs` (path line 318) | `fs_path` → open with the default app | `vault.os_path(vp, OsUse::Open)` |
| `src-tauri/src/file_commands.rs` (2: lines 125, 291) | `metadata(fs_path).len()`; `fs_path` for opening | `vault.meta(..).len`; `vault.os_path(vp, OsUse::Open)` |

**Stays outside the seam.** Each kept line gets a trailing `// seam: outside (<reason>)` comment, which the guard test (Task 6) requires.

| File (hits) | Reason |
|---|---|
| `src-tauri/src/settings.rs` (8) | The app's own settings file in the app data dir, not vault content (whole file allow-listed) |
| `src-tauri/src/vault_commands.rs` (3) | Checks and creates the folder that is about to *become* a vault; no vault exists yet |
| `src-tauri/src/scratchpad_commands.rs` (3) | Creates the global Scratchpad folder in app data, which is then opened as a vault through `Vault::open` |
| `src-tauri/src/file_windows.rs` (3, plus `to_fs_path` line 127) | Single-file windows: one plain file outside any vault (M4c §3) |
| `src-tauri/src/file_commands.rs` (lines 65, 307) | Matching a single file against recent vaults by canonical path, and the real target of a followed link (M4c review I3) |
| `src-tauri/src/editor_commands.rs` (`check_openable`, 4) | Inspects the OS path that `os_path(Open)` returned, which is today the file itself (E3: a decrypted temp copy) |
| `src-tauri/src/audio_commands.rs` (17) | Takes live in the app cache dir and reach the vault only through `session.import_attachment` → `Vault::import_file`. E3 redesigns this (spec §4.2) |
| `src-tauri/src/notion_commands.rs` (1) | Checks the import target folder that doesn't exist yet |
| `liber-audio/src/record.rs` (2) | Writes a take to the cache path it is given |
| `liber-import/src/archive.rs` (5) | Reads the user's export zip, plus an OS temp file for a nested zip. It is input outside any vault |
| `liber-import/src/import.rs` (lines 555, 558) | Creates the new vault's own folder before `Vault::open` |
| `liber-index/src/index.rs` (3) | The index DB in the app cache (E3: `:memory:` for encrypted vaults, spec §5.1) |
| `liber-session/src/attachments.rs` (lines 103–118) | `metadata`/`canonicalize` of the *outside* source file being imported |
| `liber-testkit/src/lib.rs` (15) | Test-only crate that writes fixtures (whole file allow-listed; E3 converts fixtures into encrypted vaults through `Storage`) |

---

## File structure

- `crates/liber-vault/src/storage/mod.rs`: the `Storage` trait, value types, `open_storage()` (with the test switch), and `PassThrough` (test-only).
- `crates/liber-vault/src/storage/plain.rs`: `PlainStorage`. All OS calls of the vault crate live here.
- `crates/liber-vault/src/storage/plain_watch.rs`: `PlainStorage::watch`, holding `notify` and the OS→`VaultPath` translation moved from `watch.rs`.
- Modified: `fsops.rs`, `scan.rs`, `watch.rs`, `vault.rs`, `layout.rs`, `icon.rs`, `lib.rs`; the session, import and src-tauri files in the table above.
- `crates/liber-vault/tests/seam_guard.rs`: the guard.
- `docs/architecture/storage-seam.md`: a short reference, linked from `docs/README.md`.

---

### Task 1: The `Storage` trait and `PlainStorage` reads

**Files:**
- Create: `crates/liber-vault/src/storage/mod.rs`, `crates/liber-vault/src/storage/plain.rs`
- Modify: `crates/liber-vault/src/lib.rs` (add `mod storage;` and the re-exports)
- Test: `crates/liber-vault/tests/storage_plain.rs`

**Interfaces:**
- Produces (all re-exported from `liber_vault`):

```rust
pub trait ReadSeek: std::io::Read + std::io::Seek + Send {}
impl<T: std::io::Read + std::io::Seek + Send> ReadSeek for T {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Kind { File, Dir, Symlink, Other }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Follow { No, InsideVault }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Reach { Any, Visible }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum OsUse { Open, Reveal, FileUrl }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Replace { CreateOnly, Overwrite }

/// `len` is the LOGICAL size (bytes a reader gets back); `mtime_ns` and
/// `created` are the PHYSICAL file's (E3: the ciphertext's — still changes
/// exactly when content changes, which is what incremental indexing needs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Meta { pub kind: Kind, pub len: u64, pub mtime_ns: i128, pub created: Option<std::time::SystemTime> }

/// A direct child of a folder, hidden names included; `Unreadable` carries
/// the exact message `scan` reports today ("<dir>: entry not readable (…)",
/// "<os path>: name is not UTF-8").
#[derive(Debug)]
pub enum Child { Entry { name: String, meta: Meta }, Unreadable(String) }

pub struct Reader { pub len: u64, pub inner: Box<dyn ReadSeek> }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawEvent { Changed(VaultPath), Removed(VaultPath), Overflow }

pub struct WatchGuard(pub(crate) Box<dyn Send>);

pub trait Storage: Send + Sync + std::fmt::Debug {
    fn name(&self) -> &'static str;                                   // "plain"
    fn location(&self) -> &std::path::Path;                           // identity only
    fn meta(&self, path: &VaultPath, follow: Follow) -> Result<Option<Meta>>;
    fn children(&self, dir: &VaultPath) -> Result<Vec<Child>>;
    fn read(&self, path: &VaultPath) -> Result<Vec<u8>>;
    fn open_read(&self, path: &VaultPath, reach: Reach) -> Result<Reader>;
    fn replace_atomic(&self, path: &VaultPath, from: &mut dyn std::io::Read, mode: Replace) -> Result<()>;
    fn create_new(&self, path: &VaultPath) -> Result<Box<dyn std::io::Write + Send>>;
    fn create_dir(&self, path: &VaultPath) -> Result<()>;
    fn remove_file(&self, path: &VaultPath) -> Result<()>;
    fn remove_empty_dir(&self, path: &VaultPath) -> Result<()>;
    fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()>;
    fn trash_os(&self, path: &VaultPath) -> Result<()>;
    fn os_path(&self, path: &VaultPath, use_: OsUse) -> Result<std::path::PathBuf>;
    fn vault_path_of(&self, os: &std::path::Path) -> Option<VaultPath>;
    fn watch(&self, recursive: bool, sink: Box<dyn Fn(RawEvent) + Send>) -> Result<WatchGuard>;
}
pub struct PlainStorage { /* root: PathBuf (canonical) */ }
impl PlainStorage { pub fn open(root: &std::path::Path) -> Result<PlainStorage>; }
```

**Why each method exists (spec reference for E3):**
- `location`: the recent list, index identity, and scratchpad detection key on the folder. E3's vault is still a folder (§4.1).
- `meta` / `children`: E3 lists ciphertext names and decrypts them (§4.3); `len` is logical (§9 formula).
- `read`: whole-note reads.
- `open_read` + `Reader`: asset range requests decrypt only the chunks they cover (§4.2 random access).
- `replace_atomic`: every save writes a new file with a fresh salt, then renames (§4.2 writes, nonce rule).
- `create_new`: append-only streaming for bulk import and, in E3, recordings (§4.2: writers only append).
- `create_dir` / `remove_*` / `rename`: E3 renames re-encrypt only the moved entry's name (§4.3).
- `trash_os`: the OS trash of a ciphertext file is still ciphertext.
- `os_path(use_)`: E3 answers `Open` with a per-session decrypted temp copy (§5.5), and refuses or redirects `Reveal`/`FileUrl`.
- `vault_path_of`: drops and links from outside need mapping, or refusal, for a ciphertext tree.
- `watch`: E3 translates ciphertext events into logical ones (§8).
- `name`: the test switch and diagnostics.

- [ ] **Step 1: Write the failing tests** in `tests/storage_plain.rs`, each with its own `tempfile::tempdir()`:
  - `meta_reports_logical_len_and_physical_mtime`: write 5 bytes with `std::fs`. Then `meta(p, Follow::No)` is `Some(Meta { kind: File, len: 5, .. })` with `mtime_ns > 0`, and a missing path is `Ok(None)`.
  - `meta_follow_inside_vault` (unix): with `link.md → a.md` inside the vault, `Follow::No` gives `Kind::Symlink` and `Follow::InsideVault` gives `Kind::File, len` of `a.md`. With `out.md → /etc/hosts`, `Follow::InsideVault` is `Err(VaultError::OutsideVault(_))`. A dangling `gone.md → missing.md` is also `Err(OutsideVault(_))`. That is today's `symlink_target_meta` → `None` → "symlink points outside the vault" message, which `scan` keeps.
  - `children_lists_hidden_names_and_reports_unreadable`: `.liber`, `a.md` and `B` all appear as `Child::Entry` with the right kinds.
  - `read_and_open_read_return_the_same_bytes`: `open_read(p, Reach::Any)` has `len == 11`. Seek to 6, read 5, and get `b"world"`.
  - `open_read_visible_refuses_hidden_real_target` (unix): `v.png → .secret/k.png`. `Reach::Visible` gives `Err(OutsideVault)` and `Reach::Any` gives `Ok`. This mirrors the existing `write_ops.rs:182` cases.
  - `resolve_refuses_parent_symlink_outside` (unix): `sub → /tmp/elsewhere`, and `read("sub/x.md")` gives `Err(OutsideVault)`.
- [ ] **Step 2: Run** `cargo test -p liber-vault --test storage_plain`. Expected: FAIL to compile (`Storage`, `PlainStorage` not found).
- [ ] **Step 3: Implement** the types and the trait in `storage/mod.rs`. In `plain.rs`, implement `PlainStorage::open` (today's `Vault::open` canonicalize and `is_dir` checks, same errors) and `name`, `location`, `meta`, `children`, `read` and `open_read`.
  - Move `fs_path` → `PlainStorage::resolve(&self, &VaultPath) -> Result<PathBuf>` and `visible_fs_path` → `resolve_visible`, bodies unchanged.
  - Move `mtime_ns` from `scan.rs`.
  - Leave the write methods and `watch` as `unimplemented!()` until Task 2 and Task 3. They are unreachable, because `Vault` doesn't use `PlainStorage` yet.
- [ ] **Step 4: Run** `cargo test -p liber-vault --test storage_plain`. Expected: 6 passed.
- [ ] **Step 5: Commit**: `feat(vault): Storage trait and PlainStorage reads (E2)`.

### Task 2: `PlainStorage` writes, renames, trash and OS paths

**Files:**
- Modify: `crates/liber-vault/src/storage/plain.rs`
- Test: `crates/liber-vault/tests/storage_plain.rs`, and move the `nfr_08_injected_failure…` unit test from `fsops.rs` into a `#[cfg(test)]` module in `plain.rs`

**Interfaces:**
- Consumes: Task 1's types.
- Produces the rest of `PlainStorage`'s implementation. `replace_atomic` keeps today's guarantees:
  - a hidden temp name `.<file>{TMP_MARKER}<pid>-<n>` (`TMP_MARKER` stays re-exported);
  - `create_new(true)`, `sync_all`, copy the existing file's permissions, `rename`, `sync_dir`;
  - remove the temp file on any error;
  - with `Replace::CreateOnly`, `AlreadyExists` if the target exists before or after the copy (today's `import_file` double check);
  - `NotFound(parent)` when the parent folder is missing.

  A `pub(crate) fn replace_atomic_failing(&self, …)` hook, `#[cfg(test)]`, keeps the injected-failure test.

- [ ] **Step 1: Write the failing tests**:
  - `replace_atomic_overwrites_and_leaves_no_temp`: after an overwrite, the folder lists only `a.md` with the new bytes.
  - `replace_atomic_create_only_refuses_existing`: `Err(VaultError::AlreadyExists(_))`, and the content is unchanged.
  - `replace_atomic_missing_parent_is_not_found`: `Err(VaultError::NotFound(p))` with `p == "nope"`.
  - `replace_atomic_keeps_permissions` (unix): an existing file at mode `0o750`, overwritten, is still `0o750`.
  - `nfr_08_injected_failure_leaves_target_untouched_and_no_temp_file`: moved, assertions unchanged.
  - `create_new_streams_and_refuses_existing`: write `b"ab"` then `b"cd"` through the writer, drop it, read `b"abcd"`. A second `create_new` on the same path gives `Err(AlreadyExists)`.
  - `remove_empty_dir_refuses_non_empty`: `Err(VaultError::Io{..})`, and the folder still exists.
  - `rename_refuses_existing_target`, `rename_missing_source_is_not_found`.
  - `rename_case_only` (`#[cfg(any(target_os = "macos", windows))]`, skipped at runtime unless the temp volume is case-insensitive): `a.md` → `A.md` succeeds, and the listing shows `A.md`.
  - `trash_os_missing_is_not_found`. Never call a real OS trash in tests; `LIBER_TRASH_TESTS` stays off.
  - `os_path_matches_resolve_for_every_use`: for each `OsUse`, it returns `root.join("a.md")`.
  - `vault_path_of_maps_inside_and_rejects_outside`: `root/x/y.md` → `Some("x/y.md")`, and `/tmp/z` → `None`.
- [ ] **Step 2: Run** `cargo test -p liber-vault --test storage_plain`. Expected: the new tests FAIL (panics at `unimplemented!`).
- [ ] **Step 3: Implement.** Move the bodies from `fsops.rs`:
  - the `write_cas_inner` temp/rename part → `replace_atomic`;
  - the `import_file` copy loop → `replace_atomic` reading from `&mut dyn Read`;
  - `rename` with `same_entry` → `rename`;
  - `trash` → `trash_os`;
  - `sync_dir` → `plain.rs`.

  Then:
  - `create_new` is `OpenOptions::new().write(true).create_new(true)` on `resolve(path)`, boxed.
  - `remove_empty_dir` is `std::fs::remove_dir`.
  - `os_path` is `resolve` for every `OsUse` in plain storage.
  - `vault_path_of` is `VaultPath::from_fs_path(&self.root, os).ok()`.
- [ ] **Step 4: Run** `cargo test -p liber-vault --test storage_plain`. Expected: all pass.
- [ ] **Step 5: Commit**: `feat(vault): PlainStorage writes, renames, trash and OS paths (E2)`.

### Task 3: `Vault` runs on `Storage` (liber-vault internals and the watcher)

**Files:**
- Create: `crates/liber-vault/src/storage/plain_watch.rs`
- Modify:
  - `vault.rs` (struct field, `open`, `open_with`, `read_json`, `.liber` creation);
  - `fsops.rs` (thin wrappers);
  - `scan.rs`, `watch.rs`, `layout.rs`, `icon.rs`, `lib.rs`.
- Modify tests: `crates/liber-vault/tests/write_ops.rs:182-185`, `crates/liber-vault/tests/open_scan.rs:185,290-291`. Move the `watch.rs` unit tests on `PathFilter` into `plain_watch.rs`.

**Interfaces:**
- Consumes: `Storage`, `PlainStorage`, `RawEvent`, `WatchGuard`, `Follow`, `Reach`, `OsUse`, `Replace` (Tasks 1–2).
- Produces, on `Vault`, for Tasks 4–5:

```rust
impl Vault {
    pub fn open(root: &Path) -> Result<Vault>;                         // unchanged signature
    pub fn open_with(storage: Box<dyn Storage>) -> Result<Vault>;
    pub fn root(&self) -> &Path;                                        // = storage.location(); identity only
    pub fn storage_name(&self) -> &'static str;
    pub fn meta(&self, path: &VaultPath, follow: Follow) -> Result<Option<Meta>>;
    pub fn children(&self, dir: &VaultPath) -> Result<Vec<Child>>;
    pub fn open_read(&self, path: &VaultPath, reach: Reach) -> Result<Reader>;
    pub fn create_new(&self, path: &VaultPath) -> Result<Box<dyn std::io::Write + Send>>;
    pub fn remove_file(&self, path: &VaultPath) -> Result<()>;
    pub fn remove_empty_dir(&self, path: &VaultPath) -> Result<()>;
    pub fn os_path(&self, path: &VaultPath, use_: OsUse) -> Result<PathBuf>;
    pub fn vault_path_of(&self, os: &Path) -> Option<VaultPath>;
    // unchanged signatures, now over storage: read, read_to_string, write_cas,
    // create_dir_all, create_dir, import_file, rename, trash, scan, scan_from,
    // list_dir, stat, watch, watch_folder
}
// REMOVED: pub fn fs_path, pub fn visible_fs_path
```

- `PlainStorage::watch(recursive, sink)` owns `notify::recommended_watcher` and calls `sink` once per OS path:
  - `need_rescan`, a backend error, or the root itself becomes `RawEvent::Overflow`;
  - otherwise the path is translated with today's `PathFilter::visible` canonical-parent logic, minus the hidden/excluded filter, and becomes `Changed` if `exists()`, else `Removed`.
- `Vault::watch_with` keeps the debounce thread (`DEBOUNCE`, `MAX_BATCH_WAIT`). It receives `RawEvent`s, drops root, hidden (`is_hidden_path`) and excluded paths, collapses any batch containing `Overflow` to `[Overflow]`, then sorts and dedups as today.

- [ ] **Step 1: Write the failing test** `watch_drops_temp_hidden_excluded_and_flags_root` in `crates/liber-vault/tests/watch.rs`, driving `Vault::open_with` with a test `Storage` (a struct in the test file that delegates to `PlainStorage` and whose `watch` stores the sink so the test can inject `RawEvent`s):
  - inject `Changed(".a.md.liber-tmp-1-0")`, `Changed(".liber/vault.json")`, `Changed("build/x.md")` with the exclude `build/**` in `.liber/vault.json`, and `Changed("ok.md")`;
  - expect exactly one batch, `[WatchEvent::Changed("ok.md")]`;
  - then inject `Overflow` and `Changed("ok.md")` and expect `[WatchEvent::Overflow]`.
- [ ] **Step 2: Run** `cargo test -p liber-vault --test watch`. Expected: FAIL to compile (`open_with` not found).
- [ ] **Step 3: Implement the rewiring:**
  - `Vault { storage: Box<dyn Storage>, … }`. `Vault::open(root)` = `open_with(open_storage(root)?)`, where `open_storage` is Task 6's switch; for now it is `Box::new(PlainStorage::open(root)?)`.
  - `read_json(storage: &dyn Storage, rel, warnings)` reads with `storage.read`, mapping `NotFound` → default as today.
  - `fsops.rs` methods become wrappers:
    - `write_cas` reads the current bytes and hash via `storage.read`, keeps the conflict logic, then calls `storage.replace_atomic(path, &mut &content[..], mode)`;
    - `import_file` wraps `File::open(src)` in a reader that feeds `blake3` as it reads, and calls `replace_atomic(.., Replace::CreateOnly)`.
  - `create_dir_all` uses `storage.meta`/`create_dir`.
  - `scan.rs`'s `walk` uses `storage.children` and `storage.meta(_, Follow::InsideVault)` for `Kind::Symlink` children. The skip messages are the same text.
  - `layout.rs::path_exists` uses `storage.meta(_, Follow::No)`. `icon.rs::vault_icon_at(root)` reads through `PlainStorage::open(root)`.
  - Rewrite the tests that called the removed methods:
    - `write_ops.rs:182-185` → `vault.open_read(&p(x), Reach::Visible)`: refused cases `Err(OutsideVault)`; `ok.png` `Ok`; `missing.png` `Err(NotFound)`. This is the same decision with a different signal for a missing file; record it as a ruling.
    - `open_scan.rs:185` → `vault.os_path(.., OsUse::Open)`.
    - `open_scan.rs:290-291` → `open_read(.., Reach::Visible)`, `is_ok` / `is_err` on files that exist.
- [ ] **Step 4: Run** `cargo test -p liber-vault`. Expected: all pass, the moved tests included.
- [ ] **Step 5: Commit**: `refactor(vault): Vault runs on Storage; fs_path/visible_fs_path removed (E2)`.

### Task 4: liber-session and liber-import on the Vault API

**Files:**
- Modify: `crates/liber-session/src/{bin.rs,quick_notes.rs,rename.rs,session.rs,attachments.rs,external.rs}`, `crates/liber-import/src/import.rs`
- Test: `crates/liber-session/tests/rename.rs`, `crates/liber-import/src/import.rs` (its test module)

**Interfaces:**
- Consumes: Task 3's `Vault` methods.
- Produces: no new API. These crates make no direct `std::fs` call on vault content.

- [ ] **Step 1: Write the failing tests:**
  - `import_failed_entry_leaves_no_partial_file`, in the `import.rs` test module:
    1. Build the module's `sample()` zip, but with an extra attachment `Big.bin` of 256 KiB of pseudo-random bytes, stored *deflated*.
    2. Corrupt 16 bytes in the middle of `Big.bin`'s compressed data. Find the offset via `ZipArchive::by_name("…/Big.bin")?.data_start()` + compressed_size / 2.
    3. Run `write(…)`. The vault has no `Big.bin` at its planned path, the report's warnings mention `Big.bin`, and every other file was written.

    `exp_04_symlinked_notes_stay_symlinks` (rename.rs:388) is the Review Focus guard; it stays as it is.
- [ ] **Step 2: Run** `cargo test -p liber-session --test rename` and `cargo test -p liber-import`. Expected: the import test PASSES on today's code, because today's `remove_file` already cleans up. That makes it a regression guard, not a RED; note it in the ledger. Then confirm it goes RED by temporarily deleting the `remove_file` line, and restore the line.
- [ ] **Step 3: Implement**, replacing each routed line from the inventory table:
  - `bin.rs`:
    - `measure(&Vault, &VaultPath)` recurses with `children` and `Kind`, never following symlinks;
    - `page_icon` reads through `vault.read` (still skipped above 1 MiB, using `meta.len`);
    - the existence and `is_dir` checks use `vault.meta(_, Follow::No)`;
    - `bin_dir` refuses `Some(Meta{kind != Dir})`;
    - `trash_list` uses `children(".trash")`;
    - `prune_archive` uses `remove_empty_dir`.
  - `quick_notes.rs` uses `children(root)`. `rename.rs` checks `Kind::Symlink`. `session.rs` uses `meta(.., Follow::InsideVault)?.created`.
  - `attachments.rs`: `vault_path_of` and `os_path(.., OsUse::FileUrl)`.
  - `external.rs:302` uses `vault_path_of`.
  - `import.rs` `step` uses `vault.create_new(&p)` and, on error, `vault.remove_file(&p)`.
  - Mark the kept outside lines with `// seam: outside (<reason>)`.
- [ ] **Step 4: Run** `cargo test --workspace`. Expected: all pass.
- [ ] **Step 5: Commit**: `refactor(session, import): vault content only through the Vault API (E2)`.

### Task 5: src-tauri on the Vault API

**Files:**
- Modify: `apps/desktop/src-tauri/src/{asset.rs,editor_commands.rs,file_commands.rs}`; mark the kept lines in `audio_commands.rs`, `file_windows.rs`, `vault_commands.rs`, `scratchpad_commands.rs` and `notion_commands.rs`
- Test: `apps/desktop/src-tauri/tests/asset.rs`

**Interfaces:**
- Consumes: `Vault::open_read`, `Reach`, `Reader`, `Vault::meta`, `Vault::os_path`, `OsUse`.
- Produces: `fn respond(reader: Reader, mime: &'static str, range: Option<&str>) -> AssetResponse` in `asset.rs`. It replaces `respond_file(&Path, …)`, with the same 200/206/416 behaviour, `MAX_PIECE`, and the `Accept-Ranges`/`Content-Range` headers.

- [ ] **Step 1: Write the failing tests** in `tests/asset.rs`:
  - `asset_range_on_empty_file_is_416`: on a 0-byte `e.wav`, `bytes=0-` gives status 416 with `Content-Range: bytes */0`, and no range gives 200 with an empty body.
  - `asset_range_reads_from_reader_offset`: a 100-byte file, `bytes=10-19`, gives 206 with body `[10..20]` and `Content-Range: bytes 10-19/100`.
  - `asset_trashed_image_symlink_is_404` (unix): `.trash/x.png` as a symlink gives 404, as today.
- [ ] **Step 2: Run** `cargo test -p liber-desktop --test asset`. Use the crate's actual package name from `apps/desktop/src-tauri/Cargo.toml`. Expected: the new tests fail to compile, because the `respond` shape isn't reachable yet, or they fail.
- [ ] **Step 3: Implement.**
  - `serve_from` uses `vault.open_read(&path, Reach::Visible)`, mapping `Err` → 404 as today, then `respond(reader, mime, range)`.
  - `serve_trashed_image` checks `vault.meta(".trash", No)` is `Dir` and `vault.meta(".trash/<n>", No)` is `File`, then `open_read(.., Reach::Any)`.
  - `editor_commands.rs:318` and `file_commands.rs:291` use `os_path(.., OsUse::Open)`; `file_commands.rs:125` uses `meta(.., Follow::InsideVault)?.len`.
- [ ] **Step 4: Run** `cargo test --workspace`, then `$SP/check.sh all <worktree>`. Expected: ALL-OK, e2e included (asset ranges for audio, covers, attachments).
- [ ] **Step 5: Commit**: `refactor(desktop): asset protocol and open-with through the Vault API (E2)`.

### Task 6: The seam guard, the test-storage switch, and docs

**Files:**
- Create: `crates/liber-vault/tests/seam_guard.rs`, `docs/architecture/storage-seam.md`
- Modify:
  - `crates/liber-vault/src/storage/mod.rs` (`open_storage`, `PassThrough`);
  - `crates/liber-vault/Cargo.toml` (`[features] test-storage = []`);
  - the `[dev-dependencies]` of `liber-session`, `liber-import` and src-tauri (`liber-vault = { path = …, features = ["test-storage"] }`);
  - `docs/README.md`.

**Interfaces:**
- Produces:

```rust
/// The storage `Vault::open` uses: `PlainStorage`, unless built with
/// `test-storage` (or `cfg(test)`) and `LIBER_TEST_STORAGE` names another.
/// Unknown names panic, so a typo can't silently test plain storage.
pub(crate) fn open_storage(root: &Path) -> Result<Box<dyn Storage>>;
#[cfg(any(test, feature = "test-storage"))]
pub struct PassThrough(PlainStorage);   // name() == "pass-through"; every method delegates
```

- The test switch values in E2 are `plain` (the default) and `pass-through`. E3 adds `encrypted`, and then must make fixtures go through `Storage`: `liber-testkit` writes plaintext with `std::fs` today.

- [ ] **Step 1: Write the failing tests:**
  - `seam_guard` in `tests/seam_guard.rs`. It walks `crates/*/src/**/*.rs` and `apps/desktop/src-tauri/src/**/*.rs` from `CARGO_MANIFEST_DIR/../..`, and considers only lines before a file's first `#[cfg(test)]`. It matches `std::fs|\bfs::|File::|OpenOptions|read_dir|symlink_metadata|canonicalize|notify::|trash::|to_fs_path\(`.
    - **Allowed:** files under `crates/liber-vault/src/storage/`, `crates/liber-testkit/`, `apps/desktop/src-tauri/src/settings.rs`, and any line carrying `// seam: outside (`.
    - **Assertion:** the list of offending `path:line` is empty.
    - **Self-test:** a second test, `seam_guard_catches_an_offender`, feeds the matcher one in-memory line `let x = std::fs::read(p);` with the path `crates/liber-session/src/x.rs` and expects one offender.
  - `test_switch_selects_pass_through` in `storage/mod.rs` `#[cfg(test)]`. With `LIBER_TEST_STORAGE=pass-through` set via a scoped env guard, `Vault::open(tmp).storage_name() == "pass-through"`; unset, it is `"plain"`.
- [ ] **Step 2: Run** `cargo test -p liber-vault --test seam_guard`. Expected: FAIL, listing any line Tasks 4–5 missed. Mark each truly outside line with `// seam: outside (<reason>)` using the reasons from the inventory, and route anything else.
- [ ] **Step 3: Implement** `open_storage`, which reads `LIBER_TEST_STORAGE` only under `cfg(any(test, feature = "test-storage"))`, and `PassThrough`. Write `docs/architecture/storage-seam.md` in at most one page:
  - the trait table, with the same "why" column as Task 1;
  - logical vs physical `Meta` fields;
  - the outside list;
  - how to run the suite on another storage: `LIBER_TEST_STORAGE=pass-through cargo test --workspace`.

  Link it from `docs/README.md`.
- [ ] **Step 4: Run** `cargo test -p liber-vault --test seam_guard`, then `LIBER_TEST_STORAGE=pass-through cargo test --workspace`, then `$SP/check.sh all <worktree>`. Expected: the guard passes; the workspace suite passes on pass-through; ALL-OK.
- [ ] **Step 5: Commit**: `test(vault): seam guard and LIBER_TEST_STORAGE switch; docs: storage seam (E2)`.

---

## Rulings made while planning

1. **`Meta.len` is logical; `mtime_ns`/`created` are physical.** Incremental indexing needs "changed when content changed", which the ciphertext's mtime gives. The asset protocol and size checks need the logical size. *Cost if wrong:* E3 recomputes `len`, one field.
2. **Hidden and excluded filtering stays in `Vault`, not `Storage`.** It is policy, the same for every storage. Symlink rules live in `PlainStorage`, because encrypted storage has no symlinks.
3. **`write_cas` with `None` now re-checks absence right before the rename,** as `import_file` already did. This closes a tiny create-vs-create race and is the only behavioural difference. *Cost if wrong:* nil; it can only refuse a write that would have silently overwritten.
4. **`visible_fs_path` on a missing file returned `Ok(path)`; `open_read(.., Visible)` returns `NotFound`.** Every production caller then read the file and turned the error into a 404 anyway. Two tests change their assertion.
5. **The audio cache, index DB, app settings, global scratchpad creation and single-file windows stay outside the seam** (inventory table). E3 handles the audio and index cases per spec §4.2 and §5.1.
