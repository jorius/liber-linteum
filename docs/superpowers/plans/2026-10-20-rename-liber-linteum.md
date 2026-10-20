# Rename to Liber Linteum: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the product is renamed from "Notes In My Way" / `nimw` to **Liber Linteum** / `liber` everywhere except the repository itself. Existing vaults keep working, and so do existing app settings.

**Architecture:**
- **One mechanical sweep.** A scripted, ordered substitution table plus `git mv` of the crate directories renames the code (Task 1).
- **Two small hand-written migrations** keep old data reachable:
  - a vault's `.nimw/` becomes `.liber/` on open (Task 2);
  - the new app copies settings from the old bundle id's folder on first launch (Task 3).
- **Then:**
  - product identity (Task 4);
  - docs (Task 5);
  - the final grep gate and builds (Task 6);
  - a separate task for the encryption branch (Task 7).

**Tech stack:** Rust workspace (Tauri 2), React/TS, pnpm, Playwright. No new dependencies.

**Spec:** Jose's decisions of 2026-10-20, as recorded in this session and restated here:
- the display name is "Liber Linteum", exactly;
- the code prefix is `liber`;
- `.nimw/` → `.liber/` with migration;
- the new bundle id comes with a copy of settings;
- docs are renamed everywhere;
- the repository is **not** renamed.

The encryption spec (`docs/superpowers/specs/2026-10-20-encryption-design.md` §4) is updated by Task 5 and Task 7.

## Global Constraints

- **Base.** `feat/r3` *after* round 3b (`feat/r3b`) and spell checking (`feat/spell`) have landed on it. Work in `$SP/wt-rename` on a new branch `feat/rename`.
- **Identifiers:**

  | Old | New |
  |---|---|
  | display name "Notes In My Way" | "Liber Linteum" |
  | bundle id `app.notesinmyway.desktop` | `app.liberlinteum.desktop` |
  | root package `notes-in-my-way` | `liber-linteum` |
  | `@nimw/desktop` | `@liber/desktop` |
  | crate `nimw-X` / lib `nimw_X` | `liber-X` / `liber_X` |
  | `nimw-desktop` | `liber-desktop` |
  | URI scheme `nimw-asset:` / `nimw-asset.localhost` | `liber-asset:` / `liber-asset.localhost` |
  | `NIMW_E2E_PORT` | `LIBER_E2E_PORT` |
  | `NIMW_TRASH_TESTS` | `LIBER_TRASH_TESTS` |
  | `NIMW_PERF` | `LIBER_PERF` |
  | `NIMW_TEST_STORAGE` (E2 plan) | `LIBER_TEST_STORAGE` |
  | vault folder `.nimw/` | `.liber/` |
  | temp marker `.nimw-tmp-` | `.liber-tmp-` |
  | index cache subdir `nimw` | `liber` |
  | headers `x-nimw-name`, `x-nimw-page` | `x-liber-name`, `x-liber-page` |
  | CSS classes, `data-nimw-*`, `localStorage` keys `nimw.*` | `liber-*`, `data-liber-*`, `liber.*` |
  | default global Scratchpad (new installs) `<Documents>/Notes In My Way/Scratchpad` | `<Documents>/Liber Linteum/Scratchpad` |

  An existing Scratchpad keeps its stored path: it is `scratchpadPath` in the settings, which Task 3 copies.
- **The legacy names live in exactly two allowlisted source files plus their tests:**
  - `crates/liber-vault/src/meta_dir.rs` (`LEGACY_META_DIR = ".nimw"`)
  - `apps/desktop/src-tauri/src/legacy_dirs.rs` (`LEGACY_IDENTIFIER = "app.notesinmyway.desktop"`)
- **Never modify, move or delete the old app folders** (`…/app.notesinmyway.desktop`). Tests use temp dirs only and never touch `~/Library/Application Support/app.notesinmyway.desktop`. Never run `LIBER_TRASH_TESTS=1` / `NIMW_TRASH_TESTS=1`.
- **Leave alone:** the repository, its directory (`notes-in-my-way`), and GitHub/remote URLs and absolute paths that contain `notes-in-my-way`.
- **Commits:** signed commits, each ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never bypass signing. No push.
- **Gate per task:** `LIBER_E2E_PORT=<free port> $SP/check.sh all $SP/wt-rename`. Until Task 1 lands, the port variable is `NIMW_E2E_PORT`.

## Review Focus

1. **The old app re-created `.nimw/` after migration,** or a sync conflict brought it back, so both `.liber/` and `.nimw/` exist. Expected: `.liber/` wins, `.nimw/` stays byte-for-byte untouched, and a warning names both. Test: Task 2, `both_exist_liber_wins_and_nimw_is_untouched`.
2. **A vault on read-only media,** or one whose rename fails. Expected:
   - open still succeeds, with a warning;
   - nothing is deleted;
   - the next writable open migrates the vault.

   Test: Task 2, `rename_failure_keeps_nimw_and_warns` (unix, `chmod 0o555`).
3. **A second launch after migration, when the user has since changed a setting.** Expected: the new `settings.json` is never overwritten by the old one. Test: Task 3, `never_overwrites_new_settings`.
4. **An unrecovered audio take left in the old cache** (`<old cache>/audio/*.wav`). Expected: it is copied into the new cache's `audio/` so the next Start recovers it, and the original stays in place. Test: Task 3, `copies_leftover_takes`.
5. **The mechanical sweep rewrites a legacy constant.** Expected: the pinned-value tests catch it. Tests: Task 2, `legacy_meta_dir_is_pinned`, and Task 3, `legacy_identifier_is_pinned`.

---

### Task 1: Mechanical code rename (no behaviour change)

**Files:**
- `git mv crates/nimw-{audio,import,index,markdown,session,spell,testkit,vault} crates/liber-…`
- Modify every tracked text file under `crates/`, `apps/`, `.github/`, `fixtures/` and `design/`, plus the root files `Cargo.toml`, `package.json`, `deny.toml`, `.gitignore` and `.prettierignore`. Exclude `docs/` (Task 5) and every binary file.

**Interfaces:**
- Produces: the crate, package and env-var names in the Global Constraints table. Task 2 relies on the sweep having turned every `".nimw/…"` path constant into `".liber/…"` (for example `NIMW_JSON = ".nimw/vault.json"` → `LIBER_JSON = ".liber/vault.json"`).

- [ ] **Step 1: Set up.**
  1. Confirm that `git log feat/r3` contains the round 3b and spelling merges.
  2. Run `git worktree add $SP/wt-rename -b feat/rename feat/r3`.
- [ ] **Step 2: Write the sweep script** `$SP/rename-sweep.sh` (not committed).
  1. `git mv` each crate directory.
  2. Run `git grep -Il -e nimw -e NIMW -e Nimw -- <paths above>`.
  3. Apply these **ordered**, case-sensitive substitutions with `perl -pi`:
     1. `@nimw/` → `@liber/`
     2. `nimw_` → `liber_`
     3. `nimw-` → `liber-`
     4. `NIMW_` → `LIBER_`
     5. `Nimw` → `Liber`
     6. `nimw` → `liber`
     7. standalone `\bNIMW\b` (comments and prose in code) → `Liber Linteum`

  It does **not** touch "Notes In My Way" or `notesinmyway`; Task 4 owns those.
- [ ] **Step 3: Run the script, then fix by hand:**
  - set `package.json` `"name"` to `"liber-linteum"`;
  - run `pnpm install --frozen-lockfile=false --offline` so `pnpm-lock.yaml` picks up `@liber/desktop`;
  - run `cargo metadata >/dev/null` to refresh `Cargo.lock`.
- [ ] **Step 4: Verify that no code mentions the old prefix.**
  - Run: `git grep -Iin nimw -- crates apps .github fixtures design Cargo.toml package.json deny.toml`
  - Expected: no output.
- [ ] **Step 5: Gate.**
  - Run: `LIBER_E2E_PORT=4401 $SP/check.sh all $SP/wt-rename`
  - Expected: `ALL-OK`, with test counts equal to feat/r3's. Existing vault tests now create and read `.liber/`, which is consistent.
- [ ] **Step 6: Commit:** `chore(rename): nimw → liber in code — crates, packages, env vars, scheme, identifiers (Liber Linteum)`.

### Task 2: A vault's `.nimw/` becomes `.liber/` on open

**Files:**
- Create: `crates/liber-vault/src/meta_dir.rs` and `crates/liber-vault/tests/meta_dir.rs`.
- Modify:
  - `crates/liber-vault/src/vault.rs` (`Vault::open` calls `migrate` before any read);
  - `crates/liber-vault/src/icon.rs` (`vault_icon_at` peeks at the legacy file);
  - `crates/liber-vault/src/lib.rs` (the hidden-names test list also covers `LEGACY_META_DIR`);
  - `crates/liber-session/src/bin.rs` (the protected-names list, around line 684, holds both `META_DIR` and `LEGACY_META_DIR`).

**Interfaces:**
- Produces:
  - `pub const META_DIR: &str = ".liber";`
  - `pub const LEGACY_META_DIR: &str = ".nimw";`
  - `pub(crate) fn migrate(root: &Path, warnings: &mut Vec<String>)`
- Rules, applied in order:
  - **`.liber` is a dir:** do nothing. If `.nimw` is also a dir, push a warning that names both and says `.nimw` was left untouched.
  - **Otherwise, `.nimw` is a dir:** `std::fs::rename(root/.nimw, root/.liber)`. On error, push a warning and continue. Never copy, delete or merge.
  - **Neither is a dir,** including when `.nimw` is a regular file: do nothing and create nothing (VLT-02).
- `vault_icon_at(root)` reads `.liber/vault.json` and falls back to `<LEGACY_META_DIR>/vault.json` without renaming anything. The recent list shows icons for vaults that haven't been reopened yet.

- [ ] **Step 1: Write the failing tests** in `tests/meta_dir.rs`:
  - `old_vault_migrates_on_open`: the vault has `.nimw/vault.json` with `{"favorites":["A.md"]}` and `.nimw/trash.json`. After `Vault::open`:
    - `.liber/vault.json` and `.liber/trash.json` exist with identical bytes;
    - `.nimw` is gone;
    - `favorites()` returns `["A.md"]`.
  - `fresh_vault_open_creates_nothing`: neither directory exists after open. The first favorite write creates `.liber/vault.json`.
  - `both_exist_liber_wins_and_nimw_is_untouched`:
    - the files in `.nimw/` are byte-identical after open;
    - reads come from `.liber/`;
    - `vault.warnings()` contains a string with `".nimw"`.
  - `rename_failure_keeps_nimw_and_warns` (`#[cfg(unix)]`):
    - set the root to `0o555`, then open; it returns `Ok`;
    - `.nimw/` still exists with its files, and there is a warning;
    - restore `0o755`, open again, and the vault is migrated.
  - `a_file_named_nimw_is_ignored`: a regular file `.nimw` is left alone, and nothing is created.
  - `icon_peek_does_not_migrate`: on a legacy vault with an icon, `vault_icon_at` returns the icon and `.nimw` still exists.
  - `legacy_meta_dir_is_pinned`: `assert_eq!(LEGACY_META_DIR, concat!(".", "ni", "mw"))`. The split literal survives any future sweep.
- [ ] **Step 2: Run** `cargo test -p liber-vault --test meta_dir`. Expected: FAIL, because `meta_dir` doesn't exist yet.
- [ ] **Step 3: Implement** `meta_dir.rs` per the Interfaces block. Call `meta_dir::migrate(&root, &mut warnings)` as the first statement after `warnings` is created in `Vault::open`. Point the two lists named in Files at the constants instead of literals.
- [ ] **Step 4: Run** `cargo test --workspace`. Expected: PASS.
- [ ] **Step 5: Gate.** Expected: `ALL-OK`.
- [ ] **Step 6: Commit:** `feat(vault): a vault's .nimw/ folder becomes .liber/ on open — never merged, never deleted (rename)`.

### Task 3: The new app adopts the old app's settings

**Files:**
- Create: `apps/desktop/src-tauri/src/legacy_dirs.rs` and `apps/desktop/src-tauri/tests/legacy_dirs.rs`.
- Modify: `apps/desktop/src-tauri/src/lib.rs`, in the OS-dirs `setup` branch only (around line 129). Call `legacy_dirs::adopt(&config, &cache)` before `SettingsStore::load(&config)`. Log errors with `eprintln!`; they never block launch.

**Interfaces:**
- Produces:
  - `pub const LEGACY_IDENTIFIER: &str = "app.notesinmyway.desktop";`
  - `pub struct Adopted { pub settings: bool, pub audio_takes: usize }`
  - `pub fn adopt(config_dir: &Path, cache_dir: &Path) -> std::io::Result<Adopted>`
- **Where the old folders are.** Each legacy folder is the sibling `<dir>.parent()/LEGACY_IDENTIFIER`. That holds on:
  - macOS: `~/Library/Application Support`, `~/Library/Caches`;
  - Windows: `%APPDATA%`, `%LOCALAPPDATA%`;
  - Linux: `~/.config`, `~/.cache`.
- **Settings.** If `config_dir/settings.json` is missing and the legacy `settings.json` is a regular file:
  1. create `config_dir`;
  2. copy the file to `settings.json.tmp`;
  3. rename it into place.

  The file carries the recent vaults, `scratchpadPath`, language and palette.
- **Audio takes.** If the legacy `cache/audio/` exists and the new `cache_dir/audio/` holds no files, copy each regular file in it (no recursion).
- **Not copied:** the index cache rebuilds, and WebView `localStorage` conveniences reset.
- **Never written:** any legacy path.

- [ ] **Step 1: Write the failing tests:**
  - `copies_settings_into_an_empty_new_dir`.
  - `never_overwrites_new_settings`: the new dir already has `settings.json` holding different bytes, which are unchanged afterwards. A second call returns `settings: false`.
  - `old_dir_is_never_modified`: every legacy file's bytes and mtime are equal before and after.
  - `no_legacy_dir_is_a_noop`.
  - `corrupt_legacy_settings_are_copied_and_load_falls_back`: `adopt`, then `SettingsStore::load` gives defaults, with no panic.
  - `copies_leftover_takes`.
  - `legacy_identifier_is_pinned`: `assert_eq!(LEGACY_IDENTIFIER, concat!("app.notes", "inmyway.desktop"))`.
- [ ] **Step 2: Run** `cargo test -p liber-desktop --test legacy_dirs`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Gate.** Expected: `ALL-OK`.
- [ ] **Step 6: Commit:** `feat(desktop): first launch adopts settings and leftover takes from app.notesinmyway.desktop, never touching it (rename)`.

### Task 4: Product identity

**Files:**
- `apps/desktop/src-tauri/tauri.conf.json`: `productName` and window `title` become "Liber Linteum"; `identifier` becomes `app.liberlinteum.desktop`. That id is reverse-DNS, `[A-Za-z0-9.-]` only, doesn't end in `.app`, and is unique.
- `apps/desktop/src-tauri/Info.plist`: the microphone text.
- `apps/desktop/index.html`: `<title>`.
- `src-tauri/src/commands.rs`: `app_info` name and its tests.
- `src-tauri/src/scratchpad_commands.rs`: `DEFAULT_PARENT` becomes "Liber Linteum", and its doc comment.
- `src-tauri/src/lib.rs`: the `expect` message, and the doc comment at line 37.
- `src-tauri/Cargo.toml`: `description`.
- `src/i18n/locales/{en,es}.json`: `app.name` and every string that contains the name.
- `fixtures/vaults/obsidian-basic/Welcome.md`.
- Every e2e or unit assertion on the name.
- Test: `apps/desktop/src-tauri/tests/identity.rs` (new).

The icons hold no text and `BrandMark` has no letter, so they stay unchanged.

**Interfaces:**
- Consumes: Task 3's `LEGACY_IDENTIFIER`.
- Produces: the shipped names. The app bundle is `Liber Linteum.app`; the Windows installer is `Liber Linteum_0.1.0_x64-setup.exe`.

- [ ] **Step 1: Write the failing test** `identity_matches_the_rename` in `tests/identity.rs`. It parses `tauri.conf.json` and asserts:
  - `productName == "Liber Linteum"`;
  - `identifier == "app.liberlinteum.desktop"`;
  - `identifier != legacy_dirs::LEGACY_IDENTIFIER`.

  Then update the existing app-info assertions to "Liber Linteum". They are RED until Step 3.
- [ ] **Step 2: Run** `cargo test -p liber-desktop identity app_info`. Expected: FAIL.
- [ ] **Step 3: Sweep these files.**
  - Replace `Notes In My Way` → `Liber Linteum` and `notesinmyway` → `liberlinteum` in all code paths from Task 1. `legacy_dirs.rs` and its test are excluded.
  - Check the Spanish strings read naturally: the name stays untranslated, e.g. «fuera de Liber Linteum».
- [ ] **Step 4: Verify.**
  - Run: `git grep -Iin -e 'notes in my way' -e notesinmyway -- crates apps fixtures design ':!apps/desktop/src-tauri/src/legacy_dirs.rs' ':!apps/desktop/src-tauri/tests/legacy_dirs.rs'`
  - Expected: no output.
- [ ] **Step 5: Gate.** Expected: `ALL-OK`.
- [ ] **Step 6: Commit:** `feat(rename): the product is Liber Linteum — name, bundle id app.liberlinteum.desktop, window titles, strings`.

### Task 5: Docs, everywhere

**Files:**
- All of `docs/**`, plus `README.md` and `THIRD-PARTY-NOTICES.md`.
- **Exceptions:**
  - `docs/research/2026-10-20-name-research.md`: it is about choosing the name. Add only a top line: "**Chosen (2026-10-20): Liber Linteum.**"
  - This plan.

**Interfaces:**
- Consumes: the Global Constraints table and Task 7's format-string table, so the encryption spec, E1/E2 plans and security docs say the same thing as the code.

- [ ] **Step 1: Run the Task 1 substitution table, then the Task 4 table, then the Task 7 table** over the files.
  - Prose `NIMW` becomes "Liber Linteum".
  - Paths and URLs containing `notes-in-my-way` stay unchanged.
- [ ] **Step 2: Add the rename note** under the title of `README.md` and of `docs/README.md`. The note is exactly:

  > Renamed from Notes In My Way on 2026-10-20. Existing vaults keep working: their `.nimw/` folder becomes `.liber/` the first time they open, and the app copies its settings from `app.notesinmyway.desktop`, which it never changes.
- [ ] **Step 3: Verify the docs.**
  - Run: `git grep -Iin -e nimw -e 'notes in my way' -e notesinmyway -- docs README.md THIRD-PARTY-NOTICES.md ':!docs/research/2026-10-20-name-research.md' ':!docs/superpowers/plans/2026-10-20-rename-liber-linteum.md' | grep -v 'Renamed from Notes In My Way'`
  - Expected: no output.
  - Then run `pnpm lint`. Expected: Prettier clean.
- [ ] **Step 4: Commit:** `docs(rename): Liber Linteum everywhere, with the rename note`.

### Task 6: Final grep gate and builds

- [ ] **Step 1: Run the whole-repo gate.**
  - Run: `git grep -Iin -e nimw -e 'notes in my way' -e notesinmyway -- . ':!crates/liber-vault/src/meta_dir.rs' ':!crates/liber-vault/tests/meta_dir.rs' ':!apps/desktop/src-tauri/src/legacy_dirs.rs' ':!apps/desktop/src-tauri/tests/legacy_dirs.rs' ':!docs/research/2026-10-20-name-research.md' ':!docs/superpowers/plans/2026-10-20-rename-liber-linteum.md' | grep -v 'Renamed from Notes In My Way'`
  - Expected: no output.
- [ ] **Step 2: Gate.** Expected: `ALL-OK`.
- [ ] **Step 3: Mac build.**
  - Run: `CARGO_TARGET_DIR=<repo>/target pnpm tauri build --bundles app`.
  - Expected: `target/release/bundle/macos/Liber Linteum.app` exists.
  - Also run `/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "…/Liber Linteum.app/Contents/Info.plist"`. Expected: `app.liberlinteum.desktop`.
- [ ] **Step 4: Windows cross-build** with the cargo-xwin command from the batch 6 hand-off. Expected: `target/x86_64-pc-windows-msvc/release/bundle/nsis/Liber Linteum_0.1.0_x64-setup.exe`.
- [ ] **Step 5: Hand-off.** Write `docs/handoff/2026-10-20-rename-handoff.md` and add it to the Step 1 allowlist. It covers:
  - macOS asks for microphone permission again, because permission is tied to the bundle id;
  - the old app and its Windows install remain; uninstall them yourself;
  - the outline width, dismissed hints, collapsed Favorites and recent icons reset;
  - each vault's index rebuilds once;
  - callers of `$SP/check.sh` now pass `LIBER_E2E_PORT`;
  - Jose renames the repo on GitHub and locally himself.

  Commit: `docs: rename hand-off`.

### Task 7 (on `feat/enc-e1`, before E1 Task 7 freezes vectors): encryption format strings

**Files:**
- `git mv crates/nimw-crypto crates/liber-crypto`.
- The root `Cargo.toml` workspace entries.
- Every file under the crate.
- On that branch: `docs/superpowers/plans/2026-10-20-enc-e1-crypto-core.md`, `docs/superpowers/plans/2026-10-20-enc-e2-storage-seam.md` and `docs/superpowers/specs/2026-10-20-encryption-design.md`, so later E1 task briefs carry the new strings.

**Interfaces (the v1 format strings from now on):**

| Old | New |
|---|---|
| HKDF/AAD labels `nimw/v1/*`. All of them: `content`, `name`, `header`, `index`, `file`, `slot`, `slot/recovery`, `slot/device`, `slot/keyring`, `retiring`, `recovery-check`, `keyring/mac`, `keyring/commit`, `keyring-slot` | `liber/v1/*` |
| file magic `NIMWE` | `LIBER`. Still 5 bytes, so the 48-byte header layout is unchanged. |
| recovery prefix `NIMW-` | `LIBER-`. Display `^LIBER(-[0-9A-HJKMNP-TV-Z]{4}){14}$`; parse accepts 56 characters bare, or 61 with the prefix. |
| header file `nimw-vault.json`, `"format":"nimw-vault"` | `liber-vault.json`, `"format":"liber-vault"` |
| keyring file `keyring.nimwk`, `"format":"nimw-keyring"` | `keyring.liberk`, `"format":"liber-keyring"` |
| suffixes `.nimwe`, `.nimwl`, `.nimwn` | `.libere`, `.liberl`, `.libern`. The `shorten` on-disk length becomes 32 + 7. |
| recording dir `.nimw/recording/` | `.liber/recording/` |
| crate `nimw-crypto` / `nimw_crypto` | `liber-crypto` / `liber_crypto` |

- [ ] **Step 1: Write the failing tests.**
  - Add `magic_is_liber`: `assert_eq!(&MAGIC, b"LIBER")`.
  - Update the recovery display and parse tests to the `LIBER-` prefix and the 61-character form.
  - Update any test asserting `nimw/v1/` labels.
- [ ] **Step 2: Run** `cargo test -p liber-crypto`. Expected: FAIL.
- [ ] **Step 3: Apply** the Task 1 substitution table to the crate and to the three docs. Then make the targeted edits: magic `NIMWE` → `LIBER`, and the recovery length arithmetic.
- [ ] **Step 4: Run** `cargo test -p liber-crypto && cargo clippy -p liber-crypto --all-targets -- -D warnings && cargo deny check`. Expected: PASS.
- [ ] **Step 5: Commit** on `feat/enc-e1`: `chore(crypto): format strings and crate renamed for Liber Linteum (liber/v1, LIBER magic, LIBER- recovery, .libere)`.

  Record in the E1 ledger that later task briefs use these strings. When E1 merges into the renamed `feat/r3`, conflicts are limited to `Cargo.toml` and `Cargo.lock`.

---

**Self-review**
- **Spec coverage:**
  - names, prefix and env vars: Task 1;
  - `.nimw` migration with the both-exist rule: Task 2;
  - bundle id with the settings copy, Windows paths included: Task 3;
  - visible strings and the About name: Task 4;
  - docs everywhere: Task 5;
  - grep gate and both builds: Task 6;
  - encryption labels before the freeze: Task 7;
  - the repo untouched: Global Constraints.
- **Not planned, because there's nothing to do:**
  - icons with text: none exist;
  - the `BrandMark` "N": the brand mark has no letter; the "N" was only in the welcome mock.
- **Ordering:** the sweep runs first, so Task 2 relies on the constants already reading `.liber/…`. Legacy literals exist only in the two allowlisted files, and their pinned tests use split literals so a later sweep can't rewrite them.
