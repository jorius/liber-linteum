# Rename hand-off: Notes In My Way → Liber Linteum (2026-10-20)

Branch `feat/rename`, cut from `feat/r3` at 690ca04 (round 3, round 3b, spell checking and their review fixes). Plan: `docs/superpowers/plans/2026-10-20-rename-liber-linteum.md`. The repository and its folder (`notes-in-my-way`) are **not** renamed: Jose does that on GitHub and locally.

## 1. What changed

| Thing | Before | After |
|---|---|---|
| App name, window title, menus, About | Notes In My Way | Liber Linteum |
| Bundle id | `app.notesinmyway.desktop` | `app.liberlinteum.desktop` |
| Rust crates | `nimw-*` | `liber-*` (libs `liber_*`; the app crate is `liber-desktop`) |
| JS packages | `notes-in-my-way`, `@nimw/desktop` | `liber-linteum`, `@liber/desktop` |
| Env vars | `NIMW_E2E_PORT`, `NIMW_TRASH_TESTS`, `NIMW_PERF` | `LIBER_E2E_PORT`, `LIBER_TRASH_TESTS`, `LIBER_PERF` |
| Asset scheme | `nimw-asset:` | `liber-asset:` |
| A vault's settings folder | `.nimw/` | `.liber/` |
| Default global Scratchpad (new installs only) | `<Documents>/Notes In My Way/Scratchpad` | `<Documents>/Liber Linteum/Scratchpad` |
| Mac bundle | `Notes In My Way.app` | `Liber Linteum.app` |
| Windows installer | `Notes In My Way_0.1.0_x64-setup.exe` | `Liber Linteum_0.1.0_x64-setup.exe` |

Docs say Liber Linteum everywhere, historical specs and plans included. `README.md` and `docs/README.md` carry the rename note; the name research keeps its content with a "Chosen" line.

## 2. How old data keeps working

- **Vaults** (`crates/liber-vault/src/meta_dir.rs`). Opening a vault renames its `.nimw/` folder to `.liber/` once, in place: never copied, merged or deleted.
  - Both folders exist: `.liber/` wins, `.nimw/` is left byte-for-byte as it was, and the vault's warnings name both.
  - The rename fails (read-only media): the vault opens with a warning, and its settings read empty until a writable open migrates it.
  - A file (not a folder) named `.nimw`, or a vault with neither: nothing happens and nothing is created.
  - The recent-vaults list reads a not-yet-reopened vault's icon from `.nimw/vault.json` without moving anything.
- **App settings** (`apps/desktop/src-tauri/src/legacy_dirs.rs`). On launch, if the new config folder has no `settings.json`, the one from the sibling `app.notesinmyway.desktop` folder is copied in (temp file, then rename). That brings the recent vaults, the Scratchpad path, the language and the palette. If the new cache has no audio takes, leftover takes from the old cache's `audio/` are copied too. The old folders are only read; errors are logged and never block launch.
- **Not carried over:** each vault's search index rebuilds once; WebView conveniences reset (the outline width, dismissed hints, collapsed Favorites); imported spelling dictionaries would need re-importing (none exist yet).

## 3. What Jose will notice

- macOS asks for microphone permission again, because the permission belongs to the bundle id.
- The old app (`Notes In My Way.app`) and the old Windows install stay installed until you remove them. Their settings folders are never touched.
- The first open of each vault is a little slower while its index rebuilds.

## 4. Builds

- Mac: `<target>/release/bundle/macos/Liber Linteum.app`, `CFBundleIdentifier` `app.liberlinteum.desktop`.
- Windows: `<target>/x86_64-pc-windows-msvc/release/bundle/nsis/Liber Linteum_0.1.0_x64-setup.exe` (unsigned).

## 5. Gate

`check.sh all`: ALL-OK. vitest 1644, e2e 381 passed / 12 skipped (Chromium and WebKit), cargo 654 passed / 5 ignored; lint, typecheck, i18n, build, fmt, clippy and deny clean.

The final grep (`nimw`, `notes in my way`, `notesinmyway`, case-insensitive) finds nothing outside this allowlist: `meta_dir.rs` and its test, `legacy_dirs.rs` and its test, the name research, the rename plan, this hand-off, and the rename-note lines. The two legacy constants are pinned by tests with split literals, so a future sweep can't rewrite them.

## 6. For the next person

- Callers of the gate script pass `LIBER_E2E_PORT` now. The script reads the desktop package name from `apps/desktop/package.json`, so it works on branches from before and after the rename.
- Encryption E1 (`feat/enc-e1`) still uses the old prefix. Plan Task 7 renames its crate and format strings on that branch before its test vectors freeze; merging it here afterwards conflicts only in `Cargo.toml` and `Cargo.lock`.
- Rename the repository on GitHub and locally yourself.

## 7. Review fixes (fresh-context review)

| Finding | Fix | Test (RED → GREEN) |
|---|---|---|
| **I1.** A failed move left every reader on an empty `.liber/`, and the first write created a `.liber/` that then won over the old settings for good. Windows hits this when a file inside the old folder is held open. | One resolver (`meta_dir::resolve`). While only the old folder exists, `.liber/…` reads, writes and the spelling stamp go to the old folder, so settings work in place until the move succeeds. | `unmoved_legacy_folder_is_read_and_written_in_place` (liber-vault `tests/meta_dir.rs`) |
| **I2.** Takes are folders, so none were adopted. A naive fix would re-copy them after every recovery. | Adoption runs once: a `legacy-adopted` marker in the new config dir, and recursive copies of take folders that never follow links. | `copies_leftover_take_folders_once` (src-tauri `tests/legacy_dirs.rs`) |
| **M1.** Imported dictionaries weren't adopted. | `dictionaries/` is copied along with `settings.json`. | `copies_imported_dictionaries_with_the_settings` |
| **M2.** With both folders present, the vault icon still fell back to the old folder. | The icon peek goes through the resolver, so `.liber/` is the only source. | `both_exist_icon_comes_from_liber_only` |
| **M3.** The first open after the rename dropped every quick note's `autoNamed` flag, because the new cache starts with an empty index. | When the settings were found in the old folder, only notes changed since lose their flag (`Vault::opened_legacy_settings`). | `rename_review_flags_survive_the_first_open_after_the_rename` (liber-session) |
| **M4.** The adopted `settings.json` could come out empty after a power cut. | The temp file, and its folder on Unix, are fsynced before the rename. | none (a power cut can't be simulated) |
| **M5.** Using the old app after the new one splits settings between the two folders. | Documented in the README note and in §3 below. | — |
| **M6.** The doc comment said opening never writes. Migration warnings were English-only. File windows and the importer migrate silently. | The comment is fixed. The warnings are now codes (`metaDir.both`, `metaDir.unmoved:<error>`) that the UI translates (en, es). File windows: the warning repeats when the folder next opens as a vault. Importer: it opens a folder it just created, so there is nothing to move. | `rename review M6: the settings-folder warnings arrive as codes and are translated` (stores.test.ts) |

**Also for Jose (M5):** once Liber Linteum has opened a vault, don't use Notes In My Way on it again. The old app would recreate its settings folder. Liber Linteum keeps using its own and warns that the vault has both. Whatever the old app wrote is left on disk but not used.

