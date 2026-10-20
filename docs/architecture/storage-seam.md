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
| `create_new` | Append-only streaming, for bulk import and, in E3, recordings (§4.2) |
| `create_dir` / `remove_file` / `remove_empty_dir` / `rename` | In E3, a rename re-encrypts only the moved entry's name (§4.3) |
| `trash_os` | The OS trash of a ciphertext file is still ciphertext |
| `os_path(use_)` | E3 answers `Open` with a per-session decrypted temp copy (§5.5), and refuses or redirects `Reveal` and `FileUrl`. `Reveal` refuses a hidden real location |
| `vault_path_of` | Drops and links from outside need mapping, or refusal, for a ciphertext tree |
| `watch` | E3 translates ciphertext events into logical ones (§8). Dropping the returned `WatchGuard` must drop the sink: that is what ends `Vault`'s debounce thread |

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
- test fixtures (`liber-testkit`; E3 must write its fixtures through `Storage`).

## The guard

`crates/liber-vault/tests/seam_guard.rs` reads every `crates/*/src/**/*.rs` and `apps/desktop/src-tauri/src/**/*.rs` file, up to the file's `#[cfg(test)] mod … {`.

The test fails on any line that matches this pattern:

```
std::fs|\bfs::|\bFile::|OpenOptions|read_dir|symlink_metadata|canonicalize|notify::|trash::|to_fs_path\(
```

There are two ways to pass:
- the file is allow-listed: `liber-vault/src/storage/`, `liber-testkit`, `settings.rs`, `legacy_dirs.rs` or `liber-crypto/src/vectors.rs`;
- the line ends with `// seam: outside (<reason>)`.
- the line is the `to_fs_path` definition in `path.rs`, the one line-level entry. rustfmt moves a comment after `{` onto the next line, so this line can't carry the mark.

To fix a failure, route the call through `Vault`. Mark the line only if it truly never touches vault content.

**The check is textual.** It doesn't catch `Path::exists`, `is_file`, `is_dir` or `metadata` calls, or a dependency that does I/O for you. At the end of E2, every such call outside the seam was on an outside path or was a path computation.

## Running the suite on another storage

`Vault::open` calls `open_storage`. In a build with the `test-storage` feature or `cfg(test)`, `LIBER_TEST_STORAGE` picks the storage:
- `plain` (the default);
- `pass-through`: a `PassThrough` that delegates every method to `PlainStorage`. A suite that passes on it doesn't depend on the concrete type.

An unknown name panics, so a typo can't silently test plain storage. E3 adds `encrypted`.

```sh
LIBER_TEST_STORAGE=pass-through cargo test --workspace
```

The feature is enabled only through `[dev-dependencies]`: in liber-vault itself, liber-session, liber-import and src-tauri. Release builds never read the variable.

Tests that build their own storage with `PlainStorage::open` or `Vault::open_with` ignore the switch. So does `vault_icon_at`, which reads through `PlainStorage` directly.

## What E3 must do

- **`Vault::same_entry`** compares two `os_path(.., Open)` results by canonical path. For `EncryptedStorage`, `Open` gives a temp copy, so it needs its own identity check.
- **`os_path(_, Reveal)`** must refuse hidden names, as `PlainStorage` does. With no symlinks, the name alone decides.
- **Dropping the `WatchGuard`** must drop the sink.
- **`vault_icon_at(root)`** hardcodes `PlainStorage::open`. Route it through the vault's real storage.
- **`liber-testkit`** writes plaintext fixtures with `std::fs`. Under `encrypted`, fixtures must go through `Storage`.
