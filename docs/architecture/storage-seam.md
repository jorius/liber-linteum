# The storage seam

Since encryption phase E2, all vault content goes through one trait: `Storage`, in `crates/liber-vault/src/storage/`. `Vault` owns a `Box<dyn Storage>`. Today the only production implementation is `PlainStorage`, which keeps the pre-E2 behaviour. E3 adds `EncryptedStorage` behind the same trait, and its callers don't change. Spec: `superpowers/specs/2026-10-20-encryption-design.md` §8. Plan: `superpowers/plans/2026-10-20-enc-e2-storage-seam.md`.

Every path that crosses the trait is a `VaultPath`. There are three exceptions, and each exists to talk to the OS: `location()` (identity only), `os_path()` and `vault_path_of()`.

## The trait

| Method | Why it exists (the spec section E3 builds on) |
|---|---|
| `name` | The test switch and diagnostics (`"plain"`, `"pass-through"`) |
| `location` | The recent list, index identity and scratchpad detection key on the folder. An E3 vault is still a folder (§4.1) |
| `meta` / `children` | E3 lists ciphertext names and decrypts them (§4.3). `children` includes hidden names. `meta(_, Follow::InsideVault)` follows only a link whose target is inside the vault |
| `read` | Whole-note reads |
| `open_read` + `Reader` | Asset range requests decrypt only the chunks they cover (§4.2). Only a file can be opened; anything else is `NotFound`. `Reach::Visible` also refuses a hidden real location |
| `replace_atomic` | Every save writes a new file and then renames it (§4.2, the nonce rule). `Replace::CreateOnly` refuses when the target exists, both before and after the copy |
| `create_new` + `NewFile` | Append-only streaming, for bulk import and, in E3, recordings (§4.2). `flush()` is durability only, never the end of the stream; `finish()` commits. A file dropped without `finish` must not look complete: E3 deletes its temp file, while `PlainStorage` writes in place, so the caller removes the partial file (import does) |
| `create_dir` / `remove_file` / `remove_empty_dir` / `rename` | In E3, a rename re-encrypts only the moved entry's name (§4.3) |
| `trash_os` | The OS trash of a ciphertext file is still ciphertext |
| `os_path(use_)` | E3 answers `Open` with `Err(NotPermitted)`: the app layer asks the user before writing a decrypted copy (§5.5). It refuses `Reveal` and `FileUrl` too. `Reveal` refuses a hidden real location |
| `vault_path_of` | Drops and links from outside need mapping, or refusal, for a ciphertext tree |
| `same_entry` | Whether two paths name one entry (`Notes`/`notes` on a case-insensitive file system). Plain resolves both and compares canonical paths; E3 compares logical paths after its own name resolution, without decrypting content |
| `watch` | E3 translates ciphertext events into logical ones (§8). Lost events and any change on the vault root must be sent as `RawEvent::Overflow` (`Vault` also turns a root-path event into `Overflow`). Dropping the returned `WatchGuard` must drop the sink: that is what ends `Vault`'s debounce thread |

**`Meta` fields.**
- `len` is **logical**: the bytes a reader gets back. The asset protocol and the size checks rely on that.
- `mtime_ns` and `created` are **physical**: in E3 they are the ciphertext's. They still change exactly when the content changes, which is what incremental indexing needs.

**What stays in `Vault`, not `Storage`.** The hidden and excluded filters, watch batching and debounce, `write_cas`'s conflict check, and the `.liber` resolver are all policy, so every storage gets them. Symlink rules live in `PlainStorage`; encrypted storage has no symlinks.

## What stays outside the seam

These touch app folders, or files the user picked, never vault content:
- app settings (`src-tauri/settings.rs`) and the first-launch adoption of legacy dirs (`legacy_dirs.rs`);
- imported dictionaries (`spell_commands.rs`, `liber-spell`);
- audio takes in the app cache (`audio_commands.rs`, `liber-audio/record.rs`; E3 spec §4.2);
- the index DB (`liber-index`; E3 uses `:memory:` for encrypted vaults, spec §5.1);
- a new vault's own folder before `Vault::open` (`vault_commands.rs`, `scratchpad_commands.rs`, `notion_commands.rs`, `import.rs`);
- a Notion export zip (`archive.rs`);
- the outside source of an import or a drop (`attachments.rs`, `external.rs`, `HashingReader` in `fsops.rs`);
- single-file windows (`file_windows.rs`);
- the OS path that `os_path` already returned (`check_openable`);
- test fixtures (`liber-testkit`; E3 must write its fixtures through `Storage`);
- E3's epoch store (`epochs.rs`: vault ids and numbers) and the per-session decrypted copies (`decrypted_copies.rs`: plaintext read through `Vault`, wiped on lock and quit). These are two of E3's audited exceptions to "no plaintext outside the vault".

## The guard

`crates/liber-vault/tests/seam_guard.rs` reads every `crates/*/src/**/*.rs` and `apps/desktop/src-tauri/src/**/*.rs` file, up to the file's `#[cfg(test)] mod … {`.

The test fails on any line that matches this pattern:

```
std::fs|\bfs::|\bFile::|OpenOptions|read_dir|symlink_metadata|canonicalize|notify::|trash::|to_fs_path\(
```

There are three ways to pass:
- the file is allow-listed: `liber-vault/src/storage/`, `liber-testkit`, `settings.rs`, `legacy_dirs.rs`, `epochs.rs`, `decrypted_copies.rs` or `liber-crypto/src/vectors.rs`;
- the line carries `// seam: outside (<reason>)`;
- the line is the `to_fs_path` definition in `path.rs`, the one line-level entry. rustfmt moves a comment after `{` onto the next line, so this line can't carry the mark.

To fix a failure, route the call through `Vault`. Mark the line only if it truly never touches vault content.

**The check is textual.** It doesn't catch `Path::exists`, `is_file`, `is_dir` or `metadata` calls, or a dependency that does I/O for you. Nor does it see a grouped or aliased import (`use std::{fs as f}`), production code placed after a file's test module, or a module pulled in with `#[path]`. At the end of E2, every such call outside the seam was on an outside path or was a path computation.

**`os_path(Reveal)` as a visibility check is plain-only.** `file_commands`'s `folder_path` and scan's invalid-name message call `os_path(Reveal)` to ask "is this visible?" or to format an OS path. That works for `PlainStorage` only; E3 refuses `Reveal`. Don't copy the pattern into vault-side code, and give those two callers another answer in E3.

## Running the suite on another storage

`Vault::open` calls `open_storage`. In a build with the `test-storage` feature or `cfg(test)`, `LIBER_TEST_STORAGE` picks the storage:
- `plain` (the default);
- `pass-through`: a `PassThrough` that delegates every method to `PlainStorage`. A suite that passes on it doesn't depend on the concrete type. It is a smoke switch only: it can't catch a caller that relies on plain behaviour (a missing `finish`, an `os_path` that only plain answers). The real proof is `LIBER_TEST_STORAGE=encrypted` in E3.

- `encrypted` (E3, needs `liber-vault/test-params` too): `seal_in_place` moves the plaintext tree into a fresh encrypted vault in the same folder (passphrase `TEST_PASSPHRASE`, tiny Argon2 parameters) and unlocks it; a folder sealed already is just unlocked. It refuses a folder outside the system temp folder, so a committed fixture is never sealed. Symlinks and non-UTF-8 names are left out.

An unknown name panics, so a typo can't silently test plain storage.

```sh
LIBER_TEST_STORAGE=pass-through cargo test --workspace
LIBER_TEST_STORAGE=encrypted cargo test -p liber-vault -p liber-session -p liber-index -p liber-import \
  --features liber-vault/test-storage,liber-vault/test-params
```

On `encrypted`, a test that reads or writes the plaintext tree on disk after opening (or relies on symlinks, permission bits, mtimes set before opening, or OS paths) starts with `if liber_testkit::plain_disk_only() { return; }`. E3 Task 4 gated 161 tests this way; every other test passes on encrypted storage.

`vault_kind(root)` decides what a folder is: `Encrypted` when `liber-vault.json` parses as a vault header and `d/` is a folder; `Damaged` when there are signs of an encrypted vault that can't be one (a header that won't parse beside `d/`, a header without `d/`, or `d/` holding `.libere`/`.liberl`/`.libern` files without a header), which never opens as plain (`VaultError::Damaged`); otherwise `Plain`. A user's own `liber-vault.json`, or a folder named `d`, alone leave a vault plain.

Outside the switch, `Vault::open` on an encrypted folder fails with `VaultError::Locked`: an encrypted vault opens only through `EncryptedStorage::unlock` and `VaultSession::open_encrypted`, whose index lives in memory (spec §5.1).

The feature is enabled only through `[dev-dependencies]`: in liber-vault itself, liber-session, liber-import and src-tauri. Release builds never read the variable.

Tests that build their own storage with `PlainStorage::open` or `Vault::open_with` ignore the switch. So does `vault_icon_at`, which reads through `PlainStorage` directly.

## What E3 must do

- **`Storage::same_entry`**: implement it by comparing logical paths after E3's own name resolution. `Vault::same_entry` forwards to it.
- **`create_new`** returns a `NewFile`: `finish()` commits, `flush()` doesn't end the stream, and a drop without `finish` deletes the temp file.
- **`watch`** sends `Overflow` for lost events and root-level changes.
- **`os_path(_, Reveal)`** must refuse hidden names, as `PlainStorage` does. With no symlinks, the name alone decides.
- **Dropping the `WatchGuard`** must drop the sink.
- **`vault_icon_at(root)`** hardcodes `PlainStorage::open`. Route it through the vault's real storage.
- **`liber-testkit`** writes plaintext fixtures with `std::fs`. Under `encrypted`, fixtures must go through `Storage`.
