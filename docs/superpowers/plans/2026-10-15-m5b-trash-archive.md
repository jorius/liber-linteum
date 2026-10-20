# M5b Stream C — Trash and Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete moves items into the vault's own `.trash/`, which has a Trash view (Restore, Delete from vault, Empty Trash). Archive moves items into `.archive/`; archived pages stay indexed and linkable but are hidden from the explorer, the Global View and default search.

**Architecture:**
- **`liber-vault`:**
  - learns one exception to "hidden is invisible": the root `.archive` folder is scanned, stat-ed, watched and served (`is_hidden_path`).
  - Item records live in `.liber/trash.json` and `.liber/archive.json`, through the existing `update_json_object`.
- **`liber-session`:** a new `bin.rs` module holds the moves:
  - **trash** is a vault rename into `.trash/` plus an index removal;
  - **restore** is a rename back plus `apply([Changed])`;
  - **archive / unarchive** are `rename_with_hook`, so links are rewritten;
  - **permanent delete** goes through an injected OS-trash call, so tests never use the real trash.
- **Desktop:** a new `bin_commands.rs`.
- **UI:**
  - a `SidebarFoot` with Archived and Trash rows;
  - two new screens, `trash` and `archive`, rendered by a `BinView`;
  - an archived-page banner;
  - search's MEDIA row becomes SHOW, with an Archived chip.

**Tech stack:** Rust (liber-vault, liber-session, liber-index, Tauri 2 commands), React 19 + zustand, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-m5b-feedback-design.md` §5, plus the amendments in §13.

## Global Constraints

- Every command is async through `blocking()`, with real-ACL tests. Bin commands are denied in `file-*` windows.
- NEVER set `LIBER_TRASH_TESTS=1`. OS-trash calls are injected (`*_via`) in tests.
- i18n en + es; axe-clean in light and dark; the Safari 15 floor (no lookbehind, `structuredClone` or `color-mix` in new code).
- Notes are never written by trash or restore. Archive and unarchive rewrite links only when the `rewriteLinks` setting is on, the same rule as rename.
- Signed commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A crash between moving an item and recording it.** The record is written first and the move second. Listing drops records whose item is gone, and shows unrecorded `.trash` entries (Obsidian's, or crash leftovers) with no original path.
2. **Restoring onto an existing path.** Returns `AlreadyExists` unless `keepBoth`, which picks `name 1`; the item is never overwritten.
3. **Trashing the Scratchpad folder, `.liber`, `.trash`, `.archive` itself or the vault root.** Refused with a clear error. Otherwise the scratch-folder setting would follow the folder into `.trash`.
4. **Unsaved text in a page being trashed or archived.** `flushAll` runs before the move, and the open page follows the move (archive) or clears (trash).
5. **An archived page reached through a link.** It opens, with a banner offering Unarchive. Links to it count as resolved.

---

### Task 1: The archive is visible to the vault

**Files:**
- Modify: `crates/liber-vault/src/lib.rs`, `scan.rs`, `watch.rs`, `fsops.rs`
- Modify: `apps/desktop/src-tauri/src/asset.rs`

**Interfaces:**
- Produces: `liber_vault::ARCHIVE_DIR = ".archive"`, `TRASH_DIR = ".trash"`, and `is_hidden_path(&str) -> bool`, which is true when any component is hidden, except a leading `.archive`.

- [ ] Test `archive_is_scanned_and_stat_ed_but_other_hidden_folders_are_not`: a vault with `.archive/P/a.md`, `.trash/b.md` and `.obsidian/c.md` scans to the `.archive` entries only, and `stat(".archive/P/a.md")` is `Some`. It fails first.
- [ ] Use `is_hidden_path` in `walk`, where a root-level `.archive` is allowed, and in `stat`, `watch` and `visible_fs_path`. Use it for the asset check in `asset.rs`.
- [ ] The test passes, and `cargo test -p liber-vault` passes.
- [ ] Commit.

### Task 2: Session trash, restore and permanent delete

**Files:**
- Create: `crates/liber-session/src/bin.rs`
- Modify: `session.rs` (`trash` now moves into `.trash`), `lib.rs`

**Interfaces:**
- Produces:
  - `BinItem { path, from: Option<String>, at: Option<u64>, folder: bool }`
  - `VaultSession::trash(&VaultPath) -> Result<VaultPath>`, returning the path inside `.trash`
  - `trash_list() -> Result<Vec<BinItem>>`
  - `trash_restore(&VaultPath, keep_both: bool) -> Result<VaultPath>`
  - `trash_delete_via(&[VaultPath], os) -> Result<()>`
  - `trash_delete(&[VaultPath])`
  - `trash_empty_via(os)`
- [ ] Tests that fail first:
  - trash then restore round trip; layout entries and auto-name flags follow;
  - a name clash in `.trash` gets a ` 1` suffix;
  - a restore clash gives `AlreadyExists` without `keepBoth`, and `name 1` with it;
  - restore recreates missing folders and indexes the item;
  - the list drops stale records and shows unrecorded entries;
  - the scratch folder, hidden paths and `.archive` itself are refused;
  - permanent delete calls the injected OS trash and forgets the records and sizes;
  - links to a trashed page become unresolved, and resolve again after restore.
- [ ] Implement.
- [ ] Run `cargo test -p liber-session`; it passes.
- [ ] Commit.

### Task 3: Session archive and unarchive; index and search flag

**Files:**
- Modify: `bin.rs`, `session.rs` (`tree` hides `.archive`), `global_view.rs` (hides `.archive`)
- Modify: `crates/liber-index/src/search.rs` (`SearchQuery.archived`, `Facets.archived`, exclusion by default)

**Interfaces:**
- Produces:
  - `archive(&VaultPath, rewrite: bool) -> Result<RenameOutcome>`
  - `archive_list()`
  - `unarchive(&VaultPath, keep_both, rewrite) -> Result<RenameOutcome>`
  - `SearchQuery.archived: bool`, `Facets.archived: u32`
- [ ] Tests that fail first:
  - archive then unarchive round trip, with links resolving throughout;
  - a path link `[[P/a]]` is rewritten when rewrite is on;
  - the tree and the Global View root don't show `.archive`;
  - search hides archived pages unless `archived: true`, and the facet counts them;
  - the scratch folder is refused.
- [ ] Implement.
- [ ] Commit.

### Task 4: Commands, ACL and IPC

**Files:**
- Create: `apps/desktop/src-tauri/src/bin_commands.rs`
- Modify: `lib.rs`, `build.rs`, `capabilities/main.json`, `tests/commands.rs`, `tests/file_windows.rs`, `search_commands.rs`, `vault_commands.rs` (`entry_trash` returns the inner path)
- Modify: `apps/desktop/src/ipc/index.ts`, `e2e/ipcMock.ts`

**Commands:**
- `bin_list`
- `trash_restore`
- `trash_delete`
- `trash_empty`
- `entry_archive`
- `archive_restore`

- [ ] Real-ACL tests: allowed in main, denied in `file-*`. They fail first.
- [ ] Implement.
- [ ] Commit.

### Task 5: UI

**Files:**
- Create: `features/bin/binStore.ts`, `features/bin/BinView.tsx`, `features/bin/SidebarFoot.tsx`, `features/bin/Bin.module.css`, `features/explorer/trashAction.ts`
- Modify: `AppShell.tsx`, `Sidebar.tsx`, `uiStore.ts` (screens `trash` and `archive`), `vaultStore.ts` (trash with an Undo toast, archive), `ContextMenu.tsx` (Archive), `PageView.tsx` (the archived banner), `searchStore.ts` and `SearchDialog.tsx` (SHOW row), and the locale files.
- [ ] Component tests that fail first:
  - the foot rows' counts and keyboard behaviour;
  - BinView list, Restore (with the clash prompt), Delete and Empty, each confirming the count;
  - axe;
  - the trash toast's Undo restores;
  - the context menu's Archive;
  - the banner on a `.archive/` page;
  - the search Archived chip.
- [ ] Implement.
- [ ] Commit.

### Task 6: E2E, spec amendments, gate

- [ ] Write `e2e/m5b-trash.spec.ts` for Chromium and WebKit:
  - delete, then Trash shows the item, then Restore;
  - archive, then the explorer hides it, then Archived lists it, then Unarchive.
- [ ] Add the spec to WebKit's `testMatch`.
- [ ] Append spec §13.
- [ ] Run `check.sh all`; it must print ALL-OK.
- [ ] Run the dev-server check.
- [ ] Commit.
