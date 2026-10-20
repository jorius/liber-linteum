# M4c, Stream F — Single-file windows: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open any single Markdown, text or code file from Finder, the Dock, File → Open File… or the command line, each in its own lightweight window with the editor, and nothing from a vault — a window that can read and write only that file.

**Architecture:**
- **A window grant per file (Rust, `file_windows.rs`):** opening a file records `{label → grant}` in a managed `FileWindows` registry *before* the window exists. A grant holds a `liber_vault::Vault` opened read-only-config at the file's folder (its path checks: no `..`, no absolute paths, no symlink escapes, hidden names refused), the file's name in that folder, its kind (Markdown page or text file) and a non-recursive folder watcher filtered to the file. Re-opening a file whose grant exists focuses that window. The grant goes when its window is destroyed.
- **Commands without paths (`file_commands.rs`):** `file_info`, `file_read`, `file_write(text, expectedHash)`, `file_conflict_copy(text)`, `file_recreate`, `file_rename(newName)` act on the calling window's grant (`tauri::Window::label()`). Read-only helpers resolve links and read sibling notes inside the folder. `file_follow(path)` opens a folder-relative file the user clicked: Markdown and text in another file window, documents and media in their default app. `file_open_in_vault` hands the page to the main window. `file_open_dialog` is the Rust-side Open File… dialog.
- **Capabilities:** `capabilities/file.json` for windows `file-*` lists only the file commands, settings, fonts, `url_open`, `app_info`, event listen/unlisten and window destroy. Vault commands are denied there; the file commands are denied in `main` (except the dialog). Real-ACL tests cover both directions.
- **Assets:** the `liber-asset:` handler serves a file window's requests from its grant's folder (same checks as the vault; `/.external/` is refused), keyed by the URI-scheme context's webview label.
- **Opening:** macOS `RunEvent::Opened` and `bundle.fileAssociations` (role Editor, rank Alternate; in `tauri.macos.conf.json` only — the Windows installer's association macro replaces the default app); Windows/Linux command-line paths at launch and from a second launch via `tauri-plugin-single-instance` (registered in `run()` only, never in tests); File → Open File… (⌘⇧O) in the macOS menu, the same shortcut in the page elsewhere, and an "Open a file" button on the Welcome screen.
- **Menu events** go to the focused window only (a toggle broadcast to two windows flipped the setting twice).
- **Frontend:** the same bundle. A window whose label starts with `file-` boots `SingleFileApp`. The IPC layer remaps the page commands (`page_read`/`text_read` → `file_read`, writes, conflict copies, re-creation, link resolution; outside files and `[[` suggestions are empty) so `PageDoc`, `editorStore`, the Editor and the preview work unchanged. `openPage`/`followLink` open other files through `file_follow`. Width is per window (session only). Paste/drop of attachments and the Attach button are off.

**Tech Stack:** Rust (Tauri 2.12, `liber-vault`, `liber-session` helpers, `liber-markdown::resolve`), `tauri-plugin-single-instance` 2.5 (Windows/Linux only); React 19 + TS, zustand, CodeMirror 6; Vitest, Playwright (Chromium + WebKit).

**Spec:** `docs/superpowers/specs/2026-10-14-m4c-scratchpad-design.md` §3, §4 (path grants, capabilities), §5 (single-file tests). §8 records this stream's amendments.

## Global Constraints

- Every command async through `vault_commands::blocking()`; real-ACL tests for every new command.
- No path from the page decides what a file window may read or write: the grant does.
- i18n en + es (parity check); axe-clean in light and dark; keyboard parity; Safari 15 floor (no regex lookbehind, no `color-mix`, no `structuredClone` in new code).
- No new npm packages (the gate installs offline). One new Rust crate (single-instance), target-gated.
- Shared files (`lib.rs`, `menu.rs`, `build.rs`, `capabilities/main.json`, `tauri.conf.json`, locales, `main.tsx`, `Welcome.tsx`) get small additive edits; new code lives in `file_windows.rs`, `file_commands.rs`, `opening.rs`, `features/singleFile/`.
- Signed commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A file window asking for another path:** `file_read` etc. take no path; `file_note_read("../secret.md")`, `"/etc/hosts"`, hidden names and symlinks pointing out of the folder are refused, and the asset handler refuses the same (tests in Tasks 2, 3, 5).
2. **The same file opened twice** (Finder twice, a link to itself, a different spelling of the path, a symlink to it): one window, focused (Task 2 canonical-path test).
3. **The file changed, renamed or deleted outside while the window has unsaved text:** the watcher reports it to that window only; the text is kept (orphan flow, "Save again" re-creates the file) (Tasks 6, 9).
4. **Quit with several windows holding unsaved text:** every window's close guard flushes (menu Quit closes every window; each window installs the guard) (Task 9, real window).
5. **Ineligible files** (an image, an executable, a folder, a 50 MB log, a non-UTF-8 `.txt`): never opened as a window, or opened with the "can't be edited" notice — never written (Tasks 2, 3).

---

### Task 1: `liber-vault` — a non-recursive folder watch

**Files:** Modify `crates/liber-vault/src/watch.rs`.

**Interfaces:** Produces `Vault::watch_folder<F>(&self, callback: F) -> Result<Watcher>` — same batching and filtering as `watch`, `RecursiveMode::NonRecursive`; events in subfolders never reach it.

- [ ] Test `watch_folder_reports_only_the_folders_own_files`: temp dir with `sub/`; start `watch_folder`; write `a.md` and `sub/b.md`; within 3 s the callback saw `Changed("a.md")` and never `sub/b.md`.
- [ ] Run → fails (no method). Implement by passing the mode into a shared private `watch_with(mode, callback)`. Run → passes. Commit.

### Task 2: `file_windows.rs` — eligibility, grants, the registry, opening a window

**Files:** Create `apps/desktop/src-tauri/src/file_windows.rs`; modify `lib.rs` (module, `.manage(FileWindows::default())`); test `apps/desktop/src-tauri/tests/file_windows.rs`.

**Interfaces (produces):**
```rust
pub enum FileKind { Page, Text }                    // serde "page" | "text"
pub fn file_kind(name: &str) -> Option<FileKind>;   // .md/.markdown → Page; liber_session::is_text_path → Text
pub struct FileGrant { /* vault: Vault at the folder, name: Mutex<VaultPath>, kind, watcher */ }
impl FileGrant {
  pub fn name(&self) -> VaultPath; pub fn kind(&self) -> FileKind; pub fn vault(&self) -> &Vault;
  pub fn real_path(&self) -> PathBuf; pub fn set_name(&self, name: VaultPath);
}
#[derive(Default)] pub struct FileWindows { .. }
impl FileWindows {
  /// Canonical, existing, eligible file → (label, grant, existed).
  pub fn grant(&self, path: &Path) -> CmdResult<(String, Arc<FileGrant>, bool)>;
  pub fn get(&self, label: &str) -> Option<Arc<FileGrant>>;
  pub fn revoke(&self, label: &str);
}
pub const FILE_WINDOW_PREFIX: &str = "file-";
pub fn open_file_window<R: Runtime>(app: &AppHandle<R>, path: &Path) -> CmdResult<String>;
pub fn grant_for(app, label) -> CmdResult<Arc<FileGrant>>;  // `notPermitted` without one
```

- [ ] Tests (unit, no app): `.md`, `.markdown`, `.txt`, `.json`, `Makefile` eligible; `.png`, `.exe`, `.pdf`, no extension not; `grant` refuses a folder (`notAFile`), a missing file (`notFound`), an ineligible one (`notAText`); the same file through `./x/../note.md` or a symlink gets the same label with `existed = true`; two files get `file-1`, `file-2`.
- [ ] Tests (mock app): `open_file_window` creates a window labelled `file-N` titled with the file name; opening it again returns the same label and creates no second window; destroying the window revokes the grant.
- [ ] Implement; run `cargo test -p liber-desktop --test file_windows`; commit.

### Task 3: file commands

**Files:** Create `apps/desktop/src-tauri/src/file_commands.rs`; modify `lib.rs` (handler list), `build.rs` (COMMANDS), `editor_commands.rs` (`conflict_reply` → `pub(crate)`); test in `tests/file_windows.rs`.

**Interfaces (produces; all `#[tauri::command] async`, taking `window: tauri::Window<R>`):**
```text
file_info() -> { name, kind: "page"|"text", folder: String, vault: { root, name, page } | null }
file_read() -> PageText { text, hash }                  // page: UTF-8 (`binary`); text: is_text_content (`notAText`)
file_write(text, expectedHash) -> WriteResult { hash }  // CAS; conflict reply as page_write
file_conflict_copy(text) -> String                      // "<stem> (conflict).md" next to it, create-only
file_recreate() -> String                               // the file again, empty, create-only (orphan "Save again")
file_rename(newName) -> String                          // same folder, same extension; window title follows
file_links_resolve(targets) -> (String|null)[]          // liber_markdown::resolve over the folder (depth ≤ 3)
file_note_read(path) -> PageText                        // read-only: another note or text file in the folder
file_follow(path) -> "window" | "opened"                // md/text → another file window; doc/media → default app
file_open_in_vault() -> ()                              // main window opens the vault at this page
file_open_dialog() -> ()                                // Rust-side dialog → open_file_window for each pick
```
- [ ] Tests (real IPC, window `file-1` with a granted temp file): read/write round-trip and a stale hash → `conflict` with `currentText`; a `.txt` with a NUL byte → `notAText`, never written; rename keeps the extension, refuses `/`, `..`, a hidden name and an existing name; `file_note_read("../x.md")`, `"/etc/hosts"`, `".hidden.md"`, a symlink out → refused; `file_links_resolve` finds `[[Sub/Deep]]` at depth 3 but not 4, and Markdown `img/a.png`; `file_info.vault` names a recent vault containing the file and is `null` otherwise; `file_conflict_copy` never overwrites.
- [ ] Implement; run; commit.

### Task 4: capabilities and the ACL in both directions

**Files:** Create `capabilities/file.json`; modify `capabilities/main.json` (`allow-file-open-dialog`), `build.rs`; test `tests/file_windows.rs`.

- [ ] Test `every_file_command_is_allowed_in_file_windows_and_denied_in_main` (except `file_open_dialog`, allowed in both); `vault_commands_are_denied_in_file_windows` (every name in the M1b list except `app_info`, `settings_get`, `settings_set`, `fonts_list`, `url_open`); a window labelled `other` gets neither.
- [ ] Implement; run; commit.

### Task 5: the asset protocol per window

**Files:** Modify `asset.rs` (extract `serve_from(vault, uri_path, range)`), `lib.rs` (branch on `ctx.webview_label()`), `file_windows.rs` (`serve_file_asset`); test `tests/asset.rs` or `tests/file_windows.rs`.

- [ ] Tests: a granted folder serves `img/a.png` (200, range 206), refuses `../x.png`, `.hidden/a.png`, `.external/<anything>` (403), a symlink out (404); an unknown `file-9` label → 404; `main` still serves its vault.
- [ ] Implement; run; commit.

### Task 6: watching the file

**Files:** `file_windows.rs` (watcher started with the grant, re-keyed on rename); test unit.

**Interfaces:** event `file:changed` emitted to the window's label with `{ removed: bool }`; `pub fn change_for(name: &VaultPath, batch: &[WatchEvent]) -> Option<bool>` (Some(removed)), `Overflow` → `Some(false)` (re-read).
- [ ] Tests for `change_for`; implement; commit.

### Task 7: opening files — menu, Opened, command line, single instance, associations; menu events to the focused window

**Files:** Create `opening.rs`; modify `menu.rs` (File submenu with Open File… ⌘⇧O; `emit_focused`), `lib.rs` (`run()` with `RunEvent::Opened`, CLI paths in setup, single-instance on Windows/Linux), `Cargo.toml` (target-gated dep), `tauri.macos.conf.json` (new: `bundle.fileAssociations` md/markdown/txt, role Editor, rank Alternate); test `tests/menu.rs`, unit tests in `opening.rs`.

**Interfaces:** `pub fn paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf>` (skips flags and `-psn_…`, joins relative paths on `cwd`, keeps eligible existing files); `pub fn paths_from_urls(urls: &[url::Url]) -> Vec<PathBuf>` (`file:` only); `pub fn open_paths(app, paths)`.
- [ ] Tests: args parsing; urls parsing; the menu has File → Open File… with `CmdOrCtrl+Shift+O`; menu events reach only the focused window.
- [ ] Implement; run `cargo test -p liber-desktop`; commit.

### Task 8: IPC — file commands and the file-window remap

**Files:** Modify `src/ipc/index.ts`; test `src/ipc/fileWindow.test.ts`.

**Interfaces:** `isFileWindowLabel()`, `setFileWindow(name: string | null)`, `fileWindowName()`; `fileInfo`, `fileRename`, `fileFollow`, `fileOpenInVault`, `fileOpenDialog`, `onFileChanged`, `onOpenInVault`. In a file window: `pageRead(p)`/`textRead(p)` → `file_read` when `p` is the window's name, else `file_note_read`; `pageWrite`/`textWrite` → `file_write`; `pageCreateConflictCopy` → `file_conflict_copy`; `entryCreatePage`/`entryCreateText` → `file_recreate`; `linksResolve` → `file_links_resolve`; `linksExternal` → all `null`; `linkSuggest` → `[]`.
- [ ] Tests with `mockIPC` for each remap and for the main-window path staying unchanged; implement; commit.

### Task 9: the single-file window UI

**Files:** Create `src/features/singleFile/{SingleFileApp.tsx, FileBand.tsx, OpenInVaultBar.tsx, boot.ts, SingleFile.module.css, SingleFileApp.test.tsx}`; modify `src/main.tsx` (branch), `features/page/PageTitle.tsx` (`rename` prop), `stores/pageWidthStore.ts` (per-window width), `stores/settingsStore.ts` consumer (reload on focus).

- [ ] Tests: renders the file name (renamable; Enter calls `file_rename` and the doc follows), the subtitle for `.md` only, the band (Saved, word count, Format, width, outline, mode), the editor; a `.txt` shows the text view; no sidebar, no Global View switch, no Settings vault section; `file:changed` reloads, `{removed}` with unsaved text shows the "Save again" banner; "Open in its vault" shows only with `info.vault` and flushes then calls `file_open_in_vault` then destroys the window; axe clean.
- [ ] Implement; commit.

### Task 10: links, width, attachments and toolbar in a file window

**Files:** Modify `stores/navigate.ts` (`openPage` → `fileFollow` in a file window), `stores/links.ts` (unresolved → toast; files → `fileFollow`), `features/editor/Toolbar.tsx` (no Attach), `features/editor/attachments.ts` (paste/drop of files off), `stores/pageWidthStore.ts`.
- [ ] Tests for each branch; implement; commit.

### Task 11: the main window — Open a file, open-in-vault

**Files:** Modify `features/welcome/Welcome.tsx` ("Open a file"), `src/main.tsx` (⌘⇧O off macOS; `file:open-in-vault` listener and `?vault=&page=` on a fresh main window), `stores/` helper `openInVault(root, page)`.
- [ ] Tests; implement; commit.

### Task 12: e2e (Chromium + WebKit)

**Files:** Create `e2e/fileWindowMock.ts`, `e2e/m4c-files.spec.ts`; modify `playwright.config.ts` (WebKit `testMatch`).
- [ ] A file window renders a `.md` with its name, subtitle and band, types and saves through `file_write`, renames, shows "Open in its vault"; a `.txt` file shows the text view; axe on the band and bar (light, dark); no page errors.

### Task 13: spec amendments, gate, dev-server check

- [ ] Spec §8; full gate ALL-OK; Vite dev server on port 4342: main page and a file window (`label file-1` in a throwaway mock) load with no page errors in Chromium and WebKit (throwaway spec, deleted).
