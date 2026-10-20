# Encryption E3: Encrypted Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An encrypted vault opens, works and locks through the existing app. Notes, attachments, names, `.liber/` metadata, recordings and the search index never reach disk unencrypted. E4 builds the screens on top of the Tauri commands pinned here.

**Architecture:**
- `liber-vault` gains `EncryptedStorage`, a second implementation of E2's `Storage` trait built on `liber-crypto`. It maps logical `VaultPath`s to the ciphertext tree under `d/` (spec §4.1), with an in-memory name cache.
- `VaultSession` gets an encrypted constructor that uses an in-memory SQLite index.
- `src-tauri` gets the following, so that callers stay on logical paths and above the seam:
  - commands to create, unlock and lock;
  - the security operations;
  - an app-side store of the highest epoch seen;
  - a per-session temp folder for decrypted copies;
  - lock signals for sleep and screen lock;
  - an append-only recording path.

**Tech Stack:** Rust 1.99, `liber-crypto` (format v1, frozen), the existing `rusqlite` (in-memory), `notify`, `objc2` (macOS), and `windows-sys` 0.60.2 (Windows, already in `Cargo.lock`).

**Spec:**
- `docs/superpowers/specs/2026-10-20-encryption-design.md`: §4, §5, §6.2, §8, §9 and §10 for this phase, plus §16 as built.
- Format: `docs/security/vault-format-v1.md`.
- E3 requirements: `docs/handoff/2026-10-20-e1-handoff.md` §5.
- Depends on the E2 plan, `docs/superpowers/plans/2026-10-20-enc-e2-storage-seam.md`, being merged first.

## Global Constraints

- **The format is frozen.** E3 writes exactly format v1. `crates/liber-crypto/tests/vectors/v1` stays byte-identical. A file written by E3 must decrypt with `crates/liber-crypto/tests/xcheck/xcheck.py`'s logic; Task 8 checks this.
- **No plaintext outside the vault** (spec §5). The only exceptions are listed in Task 8's audit table:
  - the recent-vaults entry (path and folder name);
  - the epoch store (`vault_id` hex → epoch);
  - the per-session decrypted-copy folder, which is wiped on lock and on quit.
- **Writers only append** (format §13). Every save is a new file with a fresh salt, written to a temp name and then renamed. Nothing ever seeks back into a ciphertext file.
- **Names:**
  - at most 255 bytes, enforced by `encrypt_*`;
  - a decrypted name is used only if `Path::new(name).components()` is exactly one `Normal` component;
  - `.libern` side files are read up to 2048 bytes, and a larger one is unreadable.
- **Header writes go through `VaultHeader`** (verify-before-write, §16 #19). Never hand-edit `liber-vault.json`.
- **Rollback rule** (§16 #18): never open, or write, a vault at an epoch lower than the epoch store's value for its `vault_id`.
- **Argon2:**
  - Real vaults use `Argon2Params::calibrate()` and must pass `check_floor()`.
  - Only builds with the `liber-crypto/test-params` feature may create vaults below the floor.
- **Dependencies:**
  - new edges: `liber-vault → liber-crypto` (path), `src-tauri → liber-crypto` (path), and `windows-sys = { version = "0.60.2", features = ["Win32_System_StationsAndDesktops"] }` under `cfg(windows)`;
  - nothing else new;
  - `cargo deny check` and the cargo-xwin Windows build still pass.
- **P1:** zero network requests.
- **Commits:** signed, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never bypass signing.
- **Gate:** after every task, `$SP/check.sh all <worktree>` with `LIBER_E2E_PORT`.

## Review Focus

1. **A save that dies mid-write** (an I/O error after some chunks are written) leaves the previous version of the note readable and no stray logical file. → Task 2, `encrypted_save_failure_keeps_previous_version`.
2. **Renaming a folder that has same-named children in sibling folders** (`A/Notes.md`, `B/Notes.md`, then `A` → `C`) re-encrypts only `A`'s own name. Every child still opens, and `B/Notes.md` is untouched on disk. → Task 2, `folder_rename_touches_only_its_name`.
3. **A Dropbox or iCloud conflict copy of a note** shows up as `Name (conflict <label>).md` with readable content, and renaming it to a free name makes it an ordinary note. → Task 3, `conflict_copy_is_listed_and_can_be_renamed`.
4. **A ciphertext name that won't decrypt** (a stray file, or a different vault's file) is listed as unreadable. Scanning, trashing the parent, emptying Trash or renaming never deletes it. → Task 3, `unreadable_entries_are_never_deleted`.
5. **Locking while something is open** (an asset range read in flight, the watcher mid-batch, a recording running) gives `Locked` errors afterwards, never plaintext and never a panic. The take is kept. → Task 4, `lock_mid_read_returns_locked`, and Task 6, `lock_during_recording_keeps_the_take`.

---

## File structure

- `crates/liber-vault/src/storage/encrypted/mod.rs`: `EncryptedStorage`, keys, lock, create/unlock, and the `Storage` impl.
- `crates/liber-vault/src/storage/encrypted/names.rs`: the name cache, path mapping, long names, conflicts, unreadable entries.
- `crates/liber-vault/src/storage/encrypted/write.rs`: `replace_atomic`, the `create_new` finaliser, rename, trash.
- `crates/liber-vault/src/storage/encrypted/watch.rs`: event translation.
- `crates/liber-vault/tests/encrypted_storage.rs`, `crates/liber-vault/tests/encrypted_names.rs`.
- `crates/liber-session/src/session.rs`: `open_encrypted`.
- `apps/desktop/src-tauri/src/`:
  - `encryption_commands.rs` (new);
  - `epochs.rs` (new);
  - `decrypted_copies.rs` (new);
  - `lock_signals.rs` (new);
  - `audio_commands.rs`, `vault_commands.rs`, `settings.rs`, `error.rs`, `dto.rs`, `lib.rs`, and the capability files.
- `crates/liber-audio/src/stream_wav.rs` (new): an append-only WAV writer.

---

### Task 1: `EncryptedStorage` create, unlock, lock and reads

**Files:**
- Create: `crates/liber-vault/src/storage/encrypted/{mod.rs,names.rs}`, `crates/liber-vault/tests/encrypted_storage.rs`
- Modify:
  - `crates/liber-vault/Cargo.toml`: `liber-crypto = { path = "../liber-crypto" }`, and a `[features] test-params = ["liber-crypto/test-params"]`.
  - `crates/liber-crypto/Cargo.toml` and `src/header.rs`: `[features] test-params = []`, plus `#[cfg(any(test, feature = "test-params"))] pub fn create_insecure(passphrase, params)`, which delegates to `create_unchecked`.
  - `crates/liber-vault/src/storage/mod.rs`: the trait addition below.
  - `crates/liber-vault/src/lib.rs` and `error.rs`.

**Interfaces:**
- Consumes:
  - E2: `Storage`, `Meta`, `Child`, `Reader`, `Kind`, `Follow`, `Reach`.
  - liber-crypto: `VaultHeader::{create, parse, unlock, verify, to_bytes, merge_from}`, `Unlocked::{epoch, vault_id, subkeys, content_key}`, `NameCodec`, `FolderId`, `StreamReader::open`, `shorten`, `strip_conflict`, `RecoveryCode`, `Argon2Params`, `Unlock`.
- **E2 addition** (one default method on the trait, with no behaviour change for `PlainStorage`):
  ```rust
  fn as_encrypted(&self) -> Option<&EncryptedStorage> { None }
  ```
  plus `Vault::encrypted(&self) -> Option<&EncryptedStorage>`.
- Produces:
  ```rust
  pub const HEADER_FILE: &str = "liber-vault.json";
  pub fn is_encrypted_vault(root: &Path) -> bool;            // root/liber-vault.json is a file
  pub struct UnlockReport { pub vault_id: [u8; 16], pub epoch: u32, pub merged: Option<liber_crypto::MergeOutcome> }
  pub struct EncryptedStorage { /* root, keys: Mutex<Option<Keys>>, header: Mutex<VaultHeader>, cache */ }
  impl EncryptedStorage {
      pub fn create(root: &Path, passphrase: &str, params: Argon2Params) -> Result<(EncryptedStorage, RecoveryCode)>;
      pub fn unlock(root: &Path, with: Unlock<'_>) -> Result<(EncryptedStorage, UnlockReport)>;
      pub fn lock(&self);                                     // drops keys + caches; later calls → VaultError::Locked
      pub fn is_locked(&self) -> bool;
      pub fn vault_id(&self) -> [u8; 16];
      pub fn epoch(&self) -> u32;
  }
  // VaultError gains: Locked, WrongSecret, Crypto(String)
  ```
- **`create`:**
  - refuses a non-empty folder (`.DS_Store`, `Thumbs.db` and `desktop.ini` are allowed);
  - writes `liber-vault.json` via temp-then-rename;
  - writes `README.txt` with the text "This folder is an encrypted Liber Linteum vault. Open it with Liber Linteum.";
  - creates `d/`.
- **`unlock` maps errors** like this: `CryptoError::Authentication` → `WrongSecret`, `UnsupportedVersion` and `BadFormat` → `Crypto(..)`, and a missing header → `NotFound`.
- **Path mapping:**
  - The logical root `""` is `d/` with `FolderId::ROOT`.
  - Each logical component is looked up in its parent's decrypted listing (cached `HashMap<logical dir, Listing>`, where `Listing { physical: PathBuf, id: FolderId, entries: HashMap<String, Entry> }`).
  - `Meta.len` is the plaintext length: `StreamReader::open(..).len()` for files (cache it, keyed by physical mtime and size). `mtime_ns` is the physical file's (E2 ruling 1).

- [ ] **Step 1: Write the failing tests** in `tests/encrypted_storage.rs`, built with `--features test-params` and `create_insecure` params `{ m_kib: 64, t: 1, p: 1 }`:
  - `create_then_unlock_with_passphrase_and_recovery`. Check that:
    - `create` writes exactly `liber-vault.json`, `README.txt` and `d/`;
    - `is_encrypted_vault` is true;
    - unlocking with the passphrase works, and so does unlocking with the `RecoveryCode` returned by `create`;
    - a wrong passphrase gives `Err(VaultError::WrongSecret)`.
  - `create_refuses_non_empty_folder`: a folder holding `a.md` gives `Err(NotEmpty)`; a folder holding only `.DS_Store` works.
  - `read_back_through_the_trait`:
    - Write fixture plaintext through a test helper `seal_file(&storage, "A/b.md", b"hello")`. It uses the writer from Task 2; until then the helper builds the ciphertext with `NameCodec` + `StreamWriter`.
    - `children(root)` lists `A` (Dir), and `children("A")` lists `b.md` with `len == 5`.
    - `read("A/b.md") == b"hello"`.
    - `open_read(.., Reach::Any)` seeks to 2 and reads `b"llo"`.
  - `nothing_on_disk_is_plaintext`: after `seal_file` of `"Secret/Canary-7f3a.md"` with body `canary-7f3a`, walk the vault with `std::fs`. No file name and no file content contains `Canary` or `canary`.
  - `lock_drops_keys`: after `lock()`, `read` gives `Err(Locked)`, `children` gives `Err(Locked)`, and `is_locked()` is true.
- [ ] **Step 2: Run** `cargo test -p liber-vault --features test-params --test encrypted_storage`. Expected: FAIL to compile.
- [ ] **Step 3: Implement.** `Keys { unlocked: Unlocked }` lives behind `Mutex<Option<_>>`, and `lock()` sets it to `None`. The `Secret`s zeroize on drop. Long-name and conflict handling inside `children` arrive in Task 3. For now, an entry whose name won't decrypt becomes `Child::Unreadable("<physical path>: couldn't read the name (<reason>)")`.
- [ ] **Step 4: Run** the same command. Expected: 5 passed. Then run `cargo test -p liber-crypto` to show the vectors are unchanged.
- [ ] **Step 5: Commit**: `feat(vault): EncryptedStorage — create, unlock, lock, reads (E3)`.

### Task 2: Writes, folders, renames and trash

**Files:**
- Create: `crates/liber-vault/src/storage/encrypted/write.rs`
- Test: `crates/liber-vault/tests/encrypted_storage.rs` (append)

**Interfaces:**
- Consumes: Task 1, and `StreamWriter::{new, finish}`.
- Produces: the `Storage` write methods for `EncryptedStorage`.
  - **`replace_atomic`.** Encrypt into `<physical dir>/.<random hex>.liber-tmp`, then `finish()`, `sync_all`, and rename onto the physical name. `Replace::CreateOnly` refuses when the logical entry exists.
  - **`create_new`.** Returns `Box<dyn Write + Send>` wrapping `StreamWriter<File>`, which writes to a temp name. `flush()` finishes the stream (once), syncs, and renames into place. Later writes fail. `Drop` without `flush` deletes the temp file, so an incomplete stream never appears.
  - **`create_dir`.** A random `FolderId` and `encrypt_folder`.
  - **`remove_file` / `remove_empty_dir`.** These also remove the long-name side file.
  - **`rename`.**
    - A file is re-encrypted under the new parent with `encrypt_file`, and only its name changes; the ciphertext content is moved, not rewritten.
    - A folder keeps its `FolderId` and only its own name is re-encrypted.
    - A case-insensitive clash with a different entry gives `AlreadyExists`.
  - **`trash_os`.** Sends the physical entry, and its side file, to the OS trash.
  - **`os_path`.**
    - `Open` → `Err(VaultError::NotPermitted("decrypted copy needed"))`. The app layer offers a decrypted copy instead.
    - `Reveal` and `FileUrl` → `Err(NotPermitted)`.
    - `vault_path_of` → `None`.
- After every successful write, invalidate the cached listing of the written dir.

- [ ] **Step 1: Write the failing tests:**
  - `write_read_round_trip_and_overwrite`:
    - `replace_atomic("n.md", "v1", CreateOnly)`, then `read` gives `v1`.
    - `replace_atomic("n.md", "v2", Overwrite)` gives `v2`, and the physical file's first 48 bytes differ, because the salt is fresh.
    - `CreateOnly` again gives `Err(AlreadyExists)`.
  - `encrypted_save_failure_keeps_previous_version` (Review Focus 1): use a `#[cfg(test)]` injectable failure in `replace_atomic` after the first chunk, on a 200 000-byte save. The old content is still readable, and no temp file is listed by `children`.
  - `create_new_streams_and_finalises_on_flush`:
    - Write 150 000 bytes in 7 KiB pieces, then `flush()`. `read` equals the input.
    - A writer dropped without `flush` leaves no entry at all.
  - `folder_rename_touches_only_its_name` (Review Focus 2): set up `A/Notes.md` and `B/Notes.md`, then rename `A` → `C`. `C/Notes.md` and `B/Notes.md` both read, and `B`'s physical directory listing is byte-identical before and after.
  - `move_file_between_folders`: `A/x.md` → `B/x.md`. It reads, and the physical file under `A` is gone.
  - `case_clash_is_refused`: with `a.md` present, `create_dir("A.md")` and `replace_atomic("A.md", .., CreateOnly)` both give `Err(AlreadyExists)` on every OS.
  - `os_path_is_never_plaintext`: `os_path(.., OsUse::Open)` gives `Err(NotPermitted)`, and `vault_path_of(any)` gives `None`.
- [ ] **Step 2: Run** `cargo test -p liber-vault --features test-params --test encrypted_storage`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** in `write.rs`.
- [ ] **Step 4: Run** the same command. Expected: all pass.
- [ ] **Step 5: Commit**: `feat(vault): encrypted writes, folders, renames, trash (E3)`.

### Task 3: Long names, conflict copies, unreadable entries and the watcher

**Files:**
- Modify: `crates/liber-vault/src/storage/encrypted/names.rs`
- Create: `crates/liber-vault/src/storage/encrypted/watch.rs`, `crates/liber-vault/tests/encrypted_names.rs`

**Interfaces:**
- Produces:
  ```rust
  impl EncryptedStorage {
      /// Physical paths whose names couldn't be read on the last listing, with the reason. Never deleted by any operation.
      pub fn unreadable(&self) -> Vec<(PathBuf, String)>;
  }
  ```
  - **Long names.** On write, `shorten(encoded)` gives `<h>.liberl` plus a side file `<h>.libern` holding the encoded name, written as plain bytes. On listing, the side file is read up to 2048 bytes. Its contents must hash to `<h>` (format §14.5) or the entry is unreadable.
  - **Conflict copies.**
    - When decryption fails, `strip_conflict(on_disk)` is tried. A success lists the entry as `<stem> (conflict <label>)<.ext>`.
    - The cache maps that logical name to the physical conflict file, so reads, writes and renames work on it.
    - Renaming it re-encrypts the name normally.
  - **Unreadable.** Collected per listing. `remove_empty_dir` on a folder holding only unreadable entries gives `Err(NotEmpty)`. `trash_os` of a parent moves it whole, as the OS trash keeps the bytes.
  - **Watch.** Wraps `notify` on `<root>/d` (recursive). A physical path is translated through the name cache. A path the cache can't map gives `RawEvent::Overflow`, which makes the session rescan. Temp files (`.*.liber-tmp`) and `.libern` side files are dropped.

- [ ] **Step 1: Write the failing tests** in `tests/encrypted_names.rs`:
  - `long_names_round_trip`: a 180-character name round-trips. On disk the vault holds `<32 chars>.liberl` and `.libern`. Renaming it to a short name removes both.
  - `oversized_side_file_is_unreadable`: replace the `.libern` contents with 4096 bytes. The entry appears in `unreadable()` and not in `children`.
  - `conflict_copy_is_listed_and_can_be_renamed` (Review Focus 3): copy the physical `X.libere` to `X (conflicted copy 2026-10-20).libere`.
    - `children` lists `n.md` and `n (conflict conflicted copy 2026-10-20).md`, and both read.
    - Rename the copy to `n2.md`: it is readable, and the conflict-named physical file is gone.
  - `unreadable_entries_are_never_deleted` (Review Focus 4): drop `garbage.libere` and `zz.libere` (both random bytes) into `d/`, and `junk/` into a folder.
    - `unreadable()` lists them.
    - `remove_empty_dir` on that folder gives `Err(NotEmpty)`.
    - Renaming and trashing other entries leaves all three physical paths in place.
  - `watcher_translates_and_overflows_unknown`: start `watch`, then `replace_atomic("w.md")`. The sink gets `Changed("w.md")` within 2 s. Writing a random physical file under `d/` gives `Overflow`.
  - `decrypted_names_are_single_components`: a test-only sealed name containing `C:x` or `a:b` is listed as unreadable on every OS, never joined into a path.
- [ ] **Step 2: Run** `cargo test -p liber-vault --features test-params --test encrypted_names`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: all pass.
- [ ] **Step 5: Commit**: `feat(vault): encrypted long names, conflict copies, unreadable list, watcher (E3)`.

### Task 4: The session opens encrypted vaults (in-memory index) and the test-storage switch

**Files:**
- Modify:
  - `crates/liber-session/src/session.rs`;
  - `crates/liber-vault/src/storage/mod.rs` (`open_storage` gains `encrypted`, plus a test-only seal);
  - `crates/liber-vault/src/vault.rs` (`Vault::open` on an encrypted folder gives `Err(VaultError::Locked)`);
  - `crates/liber-testkit/src/lib.rs` (`plain_disk_only()`).
- Test: `crates/liber-session/tests/encrypted_session.rs`

**Interfaces:**
- Produces:
  ```rust
  impl VaultSession {
      /// An unlocked encrypted vault: the index lives in memory only (spec §5.1).
      pub fn open_encrypted(storage: EncryptedStorage, sink: impl Fn(SessionEvent) + Send + Sync + 'static)
          -> Result<(VaultSession, IndexReport)>;
      pub fn lock(&self);   // storage.lock(); drops the index's rows (DELETE all + VACUUM on :memory:); watcher stopped
  }
  ```
  - `VaultSession::open` and `open_encrypted` share one private `fn start(vault: Vault, index: Index, sink) -> Result<(VaultSession, IndexReport)>`.
  - The test switch:
    - `LIBER_TEST_STORAGE=encrypted`, under `cfg(any(test, feature = "test-storage"))` with `test-params`, makes `open_storage(root)` "seal in place": it moves the plaintext tree into a fresh encrypted vault with the passphrase `"liber-test-passphrase"` and tiny params, then unlocks it.
    - `liber_testkit::plain_disk_only()` returns `true` when that switch is set. Tests that assert on raw disk bytes start with `if liber_testkit::plain_disk_only() { return; }`.

- [ ] **Step 1: Write the failing tests** in `tests/encrypted_session.rs`:
  - `encrypted_session_indexes_in_memory_only`: open a sealed vault containing `Canary.md` ("canary-7f3a #tag").
    - `search("canary")` finds it.
    - The cache root passed to nothing contains no `index.sqlite`: assert that `tempdir` stays empty.
  - `lock_mid_read_returns_locked` (Review Focus 5): open a reader with `vault().open_read`, call `session.lock()`, then read from the reader. It gives `Err` (no panic, no bytes). `page_get` then gives `Err(Locked)`.
  - `plain_open_of_encrypted_folder_is_locked`: `Vault::open(encrypted_root)` gives `Err(VaultError::Locked)`.
- [ ] **Step 2: Run** `cargo test -p liber-session --test encrypted_session`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `Reader`s returned by `EncryptedStorage` hold an `Arc` to the key holder, so after `lock()` their next `read` returns an `io::Error` wrapping `Locked`.
- [ ] **Step 4: Run** the suite on the encrypted switch:
  ```bash
  LIBER_TEST_STORAGE=encrypted cargo test -p liber-vault -p liber-session -p liber-index -p liber-import --features liber-vault/test-storage,liber-vault/test-params
  ```
  Classify every failure and record the list in the ledger:
  - a real E3 bug: fix it;
  - a test asserting on raw disk bytes: gate it with `plain_disk_only()`.

  Expected: all pass, with at most the gated list skipped. Then run the plain `cargo test --workspace`. Expected: all pass.
- [ ] **Step 5: Commit**: `feat(session): open encrypted vaults with an in-memory index; LIBER_TEST_STORAGE=encrypted (E3)`.

### Task 5: App commands, the epoch store, header-conflict merge and decrypted copies

**Files:**
- Create:
  - `apps/desktop/src-tauri/src/encryption_commands.rs`
  - `apps/desktop/src-tauri/src/epochs.rs`
  - `apps/desktop/src-tauri/src/decrypted_copies.rs`
- Modify:
  - `vault_commands.rs` (`vault_open` on an encrypted folder gives `ErrorKind::Locked`; `RecentVaultDto.encrypted`; no icon for encrypted vaults);
  - `error.rs` (`Locked`, `WrongSecret`, `Rollback`);
  - `dto.rs` (`VaultInfo.encrypted`, `VaultInfo.recovery_void`);
  - `settings.rs` (`auto_lock_minutes`);
  - `lib.rs` (registering commands);
  - the capability files;
  - `apps/desktop/src/ipc/index.ts` (types only, for E4).
- Test: `apps/desktop/src-tauri/tests/encryption_commands.rs`

**Interfaces (the E3 → E4 contract, pinned):**

| Command | Arguments (camelCase over IPC) | Returns | Errors |
|---|---|---|---|
| `vault_open` (existing) | `path` | `VaultInfo` | **new:** `locked` when `is_encrypted_vault(path)` |
| `vault_create_encrypted` | `path: string, passphrase: string` | `{ info: VaultInfo, recovery: string }` | `notEmpty`, `invalidInput` (passphrase under 12 chars), `io` |
| `vault_unlock` | `path: string, secret: { kind: 'passphrase' \| 'recovery', value: string }` | `VaultInfo` | `wrongSecret`, `rollback`, `invalidInput` (a bad recovery code format), `io` |
| `vault_lock` | — | `void`, and emits `vault:locked` to `main` | `noVault` |
| `security_change_passphrase` | `current: string, next: string` | `void` | `wrongSecret`, `invalidInput`, `noVault`, `notPermitted` (the vault isn't encrypted) |
| `security_new_recovery` | `passphrase: string` | `string` (the new code) | `wrongSecret`, `noVault`, `notPermitted` |
| `vault_unreadable` | — | `{ osPath: string, reason: string }[]` | `noVault` |
| `vault_reveal_unreadable` | `osPath: string` | `void` | `notPermitted` (the path isn't in the current list) |
| `attachment_open_decrypted` | `path: string` | `void` (opens in the default app) | `notFound`, `noVault`, `io` |

- `VaultInfo` gains `encrypted: boolean` and `recoveryVoid: boolean`. `recoveryVoid` is true when the unlock's merge had `local_recovery_dropped`.
- `RecentVaultDto` gains `encrypted: boolean`.
- `Settings` gains `autoLockMinutes: number | null`: default `15`; valid values `1..=60` or `null` (never); anything else resets to 15 with a warning, like `sidebarWidth`.
- Events (main window):
  - `vault:locked` carries `{ path }`;
  - `vault:lock-request` carries `{ reason: 'sleep' | 'screenLock' }` (Task 7).
- **`vault_unlock` order:**
  1. `EncryptedStorage::unlock`.
  2. **Merge header conflict copies.** In the root, each file matching `liber-vault*.json` other than `liber-vault.json`, or a `.sync-conflict-` variant, is parsed and merged with `merge_from`. The merged header is written. Each merged copy then goes to the OS trash.
  3. **Epoch check.** `epochs::check_and_record(config_dir, vault_id, epoch)` returns `Err(Rollback)` if `epoch < stored`, and records `max` otherwise.
  4. `VaultSession::open_encrypted`.
  5. Recover recordings (Task 6).
  6. Push the recent entry.
- **`vault_lock` order:**
  1. stop any recording, keeping the take (Task 6);
  2. `session.lock()`;
  3. `state.set_session(None)`;
  4. `decrypted_copies::wipe()`;
  5. emit `vault:locked`.

  Flushing saves is the UI's job (E4), done before it calls this.
- **Quit:** `decrypted_copies::wipe()` also runs on exit, from the existing quit path.
- **`epochs.rs`:** the file `<config_dir>/vault-epochs.json`, holding `{ "<vault_id hex>": epoch }`, written atomically.
- **`decrypted_copies.rs`:**
  - one folder per app run, `<temp_dir>/liber-<pid>-<random>/`, created `0700` on unix;
  - files are written there under their logical file name, via `vault.read`;
  - opened with the existing opener;
  - `wipe()` removes the folder;
  - at startup, folders left by dead pids are removed.

- [ ] **Step 1: Write the failing tests** in `tests/encryption_commands.rs`, using the existing mock-app helpers and `test-params`:
  - `create_unlock_lock_cycle`:
    - `vault_create_encrypted` returns a 75-character code starting with `LIBER-`;
    - `vault_lock` emits `vault:locked`, and `page_get` then gives `noVault`;
    - `vault_open` gives `locked`;
    - `vault_unlock` with the passphrase works;
    - `vault_unlock` with the recovery code typed in lower case with spaces works;
    - `vault_unlock` with a wrong passphrase gives `wrongSecret`.
  - `rollback_is_refused`:
    1. Unlock (epoch 1, recorded).
    2. Rotate the header in a test helper (`begin_rotation` + `finish_rotation`) to epoch 2.
    3. Unlock (records 2).
    4. Restore the epoch-1 header bytes.
    5. Unlock with the old passphrase. It gives `rollback`.
  - `header_conflict_copy_is_merged`: a device slot is added in copy B, saved as `liber-vault (conflicted copy).json`. Unlock merges it, the copy is gone from the root, and the merged header opens with B's device secret.
  - `recovery_void_reported`: two copies each replace the recovery code, and the losing copy unlocks. `VaultInfo.recoveryVoid == true`.
  - `change_passphrase_and_new_recovery`:
    - after `security_change_passphrase`, the old passphrase gives `wrongSecret` and the new one opens;
    - `security_new_recovery` returns a code that opens, and the previous code gives `wrongSecret`.
  - `decrypted_copy_lives_only_until_lock`: `attachment_open_decrypted` writes a file under the session folder (use a fake opener in the test). After `vault_lock` the folder is gone.
  - `recent_list_marks_encrypted`: `vaults_recent` shows `encrypted: true` and no `icon`.
  - `asset_range_on_encrypted_vault`: a 200 000-byte `a.wav` in the vault. The asset protocol's `bytes=70000-70099` gives 206 with exactly the plaintext slice. A full request gives 200 with length 200 000. `Cache-Control: no-store` is present. This uses E2's `respond(Reader, …)` on `EncryptedStorage::open_read`.
- [ ] **Step 2: Run** `cargo test -p liber-desktop --test encryption_commands --features liber-vault/test-params`. Use the actual package name. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Calibrate Argon2 inside `vault_create_encrypted`, which runs on `spawn_blocking`. Real vaults must pass `check_floor`.
  - Passphrase and recovery `String`s from IPC go into `Zeroizing<String>` as soon as they arrive. The JS-side copies are a documented residual (spec §5).
- [ ] **Step 4: Run** the same command, then `cargo test --workspace`. Expected: all pass.
- [ ] **Step 5: Commit**: `feat(desktop): encrypted vault commands — create, unlock, lock, epochs, header merge, decrypted copies (E3)`.

### Task 6: Recordings in encrypted vaults

**Files:**
- Create: `crates/liber-audio/src/stream_wav.rs`
- Modify: `crates/liber-audio/src/{lib.rs,record.rs}`, `apps/desktop/src-tauri/src/audio_commands.rs`
- Test: `crates/liber-audio/src/stream_wav.rs` (unit tests), `apps/desktop/src-tauri/tests/encryption_commands.rs` (append)

**Interfaces:**
- Produces:
  ```rust
  /// [`record`] into an append-only writer (spec §4.2 Recordings): the WAV header carries
  /// placeholder sizes (0xFFFF_FFFF) and is never rewritten; no seek, ever.
  pub fn record_stream<W: std::io::Write>(host: &dyn Host, device: Option<&str>, writer: W,
      stop: &AtomicBool, on_level: &mut dyn FnMut(Level, Duration), max_bytes: u64) -> Result<Take, AudioError>;
  /// The same bytes with the RIFF and data sizes set from the data length.
  pub fn fix_wav_sizes(bytes: &mut Vec<u8>) -> Result<(), AudioError>;
  ```
- **Encrypted path in `audio_commands`,** used when `session.vault().encrypted()` is `Some`:
  - The take goes to `.liber/recording/<name>-<id>/take.json`, written with `replace_atomic`, plus `<name>.wav`, written with `vault.create_new` and then `record_stream`. It never goes to the cache dir.
  - **Stop:**
    1. `vault.read(wav)`;
    2. `fix_wav_sizes`;
    3. `replace_atomic` into the attachment destination today's stop path uses;
    4. remove the take folder.
  - **Recovery** at `vault_unlock` (Task 5 step 5): for each take folder, `EncryptedStorage::salvage(path)` gives the complete chunks; then `fix_wav_sizes`, saved as `clip-…-recovered.wav` where today's recovery saves it; then the take folder is removed. This needs one more inherent method: `pub fn salvage(&self, path: &VaultPath) -> Result<(Vec<u8>, bool)>`, built on `liber_crypto::salvage`.
  - `vault_lock` while recording:
    1. signal stop;
    2. join the record thread;
    3. **flush (finalise) the stream**;
    4. leave the take in `.liber/recording/` for the next unlock to recover;
    5. return.

  The plain path is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `stream_wav_never_seeks`: record a fake host's 3 s of 44.1 kHz stereo into a `Write`-only `Vec` wrapper whose `Seek` would panic. `fix_wav_sizes` then gives a WAV that `hound::WavReader` reads with the exact sample count.
  - `encrypted_take_round_trips` (desktop test, fake host): start, then stop. The attachment reads back as a valid WAV, and no `.wav` exists under the cache dir.
  - `lock_during_recording_keeps_the_take` (Review Focus 5): start, run 0.5 s of frames, then `vault_lock`. After `vault_unlock`, `clip-…-recovered.wav` exists and is a valid WAV of about 0.5 s, minus at most one chunk.
- [ ] **Step 2: Run** `cargo test -p liber-audio stream_wav` and the desktop test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same commands. Expected: PASS. Then run `cargo test --workspace`.
- [ ] **Step 5: Commit**: `feat(audio): encrypted recordings append into the vault and recover at unlock (E3)`.

### Task 7: Lock signals (sleep and screen lock)

**Files:**
- Create: `apps/desktop/src-tauri/src/lock_signals.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (start it once), `apps/desktop/src-tauri/Cargo.toml` (`windows-sys` under `cfg(windows)`)
- Test: `lock_signals.rs` unit tests

**Interfaces:**
- Produces: `pub fn start<R: Runtime>(app: AppHandle<R>)`. It emits `vault:lock-request { reason }` to `main` only while an encrypted session is open. It uses three signals:
  - **Sleep, on every OS.** A thread ticks every 5 s on a monotonic clock and compares wall-clock time against it. If the wall clock moved more than 30 s past the expected tick, the machine slept: emit `sleep`. The comparison is the pure function `fn slept(expected: SystemTime, now: SystemTime) -> bool`.
  - **Screen lock on macOS:** an `objc2` observer on `NSDistributedNotificationCenter` for `com.apple.screenIsLocked`, using the same technique as `quit_guard.rs`.
  - **Screen lock on Windows:** polled every 5 s. `OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP)` returning null means locked, and the transition to null emits `screenLock`.
  - **Linux:** sleep detection only; documented.

- [ ] **Step 1: Write the failing test** `slept_detects_a_jump`. Check that:
  - `slept(t, t + 6 s)` is false;
  - `slept(t, t + 40 s)` is true;
  - a backwards jump (`now < expected`) is false.
- [ ] **Step 2: Run** `cargo test -p liber-desktop lock_signals`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, then `cargo xwin check --target x86_64-pc-windows-msvc -p liber-desktop`, using the cross env from the README. Expected: PASS, and the Windows build compiles.
- [ ] **Step 5: Commit**: `feat(desktop): lock signals — sleep and screen lock (E3)`.

### Task 8: The leak audit, canary, performance and docs

**Files:**
- Create: `apps/desktop/src-tauri/tests/encrypted_canary.rs`, `crates/liber-session/tests/encrypted_perf.rs`
- Modify:
  - `docs/architecture/storage-seam.md` (EncryptedStorage);
  - `docs/architecture/index-and-database.md` (the in-memory index section);
  - the spec §16 (E3 as built);
  - `apps/desktop/src/` files that store anything in `localStorage` (audit only; see below).

**The audit table** goes into the spec §16 E3 entry: every app-side store touched while an encrypted vault is open, and what it holds.

| Store | Holds | Verdict |
|---|---|---|
| `settings.json` `recent` | path, folder name | allowed (§5.2) |
| `settings.json` other fields | app preferences, imported-dictionary metadata | no vault content |
| `vault-epochs.json` | vault_id → epoch | allowed (§16 #18) |
| the index cache dir | nothing; the index is in memory | test-asserted |
| the audio cache dir | nothing; takes live in the vault | test-asserted |
| the decrypted-copy folder | decrypted attachments, wiped on lock and quit | residual (§5.5) |
| WebView `localStorage` | `FavoritesSection`, `emoji.ts` recents, `SplitHint`, `Outline` | the implementer checks each key, and none may hold page text, titles or paths. Anything that holds titles or paths is keyed off for encrypted vaults (E4 implements the UI side) |

- [ ] **Step 1: Write the failing tests:**
  - `encrypted_canary` (desktop, fake audio host, `test-params`, with temp config, cache and temp dirs):
    1. Create an encrypted vault.
    2. Write a page named `Canary-7f3a.md` containing `canary-7f3a`, a folder `canary-7f3a/`, and an attachment holding the canary.
    3. Search for it, record 0.5 s, and call `attachment_open_decrypted`. Then call `vault_lock`.
    4. Byte-scan every file under the vault root, the config dir, the cache dir and the temp dir for `canary-7f3a`, case-insensitive. Expect zero hits.
  - `unlock_to_searchable_10k`: gated by `LIBER_PERF=1`, release build. Use `generate_vault` with 10 000 notes, sealed. The time from `open_encrypted` to the first successful `search`, excluding the Argon2 run, is at most 3 s (spec §10). Record the measured number in the spec.
- [ ] **Step 2: Run** `cargo test -p liber-desktop --test encrypted_canary --features liber-vault/test-params`. Expected: FAIL first only if a leak exists. Otherwise it is a guard: confirm it goes RED by temporarily writing the index to the cache dir, then revert.
- [ ] **Step 3: Write the docs** and the audit table. In the docs, state the two residuals: the JS-side passphrase strings, and Linux having no screen-lock signal.
- [ ] **Step 4: Run** `LIBER_PERF=1 cargo test --release -p liber-session --test encrypted_perf -- --nocapture`, then `$SP/check.sh all <worktree>`. Expected: within budget, and ALL-OK.
- [ ] **Step 5: Commit**: `test(desktop): encrypted canary and unlock perf; docs: E3 as built (E3)`.

---

## Rulings made while planning

1. **One E2 trait addition.** The only new trait method is `as_encrypted()`, with a default of `None`. Lock, salvage and the unreadable list stay inherent on `EncryptedStorage`, so `PlainStorage` doesn't grow. *Cost if wrong:* small; a later storage would need its own accessor.
2. **`liber-crypto` gets a `test-params` feature** that exposes `create_insecure`. Without it, the encrypted switch suite would run the 64 MiB Argon2 floor on every fixture open. Real create paths still enforce the floor. *Cost if wrong:* a feature flag a release build must never enable. `cargo tree -e features` on the desktop release build is checked in Task 8.
3. **`create_new` finalises on `flush()`** and deletes on `Drop` without it, so a half-written streamed file never appears. Both callers (the importer and the recorder) must call `flush()`. *Cost if wrong:* an importer that forgets would silently skip the file. Task 4's encrypted switch run catches it.
4. **Unreadable entries:** E3/E4 list them with "Show in Finder". "Export" of their content belongs with E5's decrypted export. *Cost if wrong:* the user can't copy an unreadable entry's content out until E5.
5. **Merged header conflict copies go to the OS trash**, never deleted. *Cost if wrong:* clutter in the trash.
6. **Rollback is refused**, not opened read-only with a warning. That's simpler and safe, and spec §16 #18 allows either. *Cost if wrong:* a user who restores an old backup must ask for help.
7. **Screen-lock detection:**
   - **macOS:** observes `com.apple.screenIsLocked`.
   - **Windows:** polls `OpenInputDesktop`.
   - **Linux:** has none, only the sleep clock-jump and idle timer.
   - *Cost if wrong:* on Windows, up to 5 s between locking the screen and the vault locking.
8. **The test switch "seals in place",** and tests that read raw disk bytes are gated with `plain_disk_only()`, rather than rewriting them. *Cost if wrong:* those tests cover plain storage only, so the gated list is ledgered for review.
