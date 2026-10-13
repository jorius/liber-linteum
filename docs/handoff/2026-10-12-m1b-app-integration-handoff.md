# Hand-off: M1b App Integration — Notes In My Way

> **Date:** 2026-10-12 · **Merged into `main`** (branch `feat/m1b-app-integration` from `323740e`, deleted) · not pushed, no remote configured
> **Audience:** Jose, or anyone continuing by hand.
> **Read first if new:** `docs/handoff/2026-10-12-m0-scaffold-handoff.md` (setup, commands, privacy layers) and `docs/handoff/2026-10-12-m1a-vault-core-handoff.md` (the engine). This document covers what M1b adds: the app you can actually use.

---

## 1. Status at a glance

**What M1b delivers:** the desktop app now opens real vaults. Welcome → Create / Open / Open Obsidian vault / Recent → an Obsidian-style app shell with a file explorer (create, inline rename, drag-and-drop move, "Move to…", delete to the OS trash with confirmation, links rewritten on rename/move), a read-only page view, toasts, a settings dialog (language, theme, rewrite links, confirm delete) that persists, and a keyboard model that does not depend on macOS "Keyboard navigation".

| Area | State |
|---|---|
| Requirements | VLT-01, VLT-02, VLT-04, VLT-05, EXP-01…EXP-05, Q-I18N-1, Q-UI-1, NFR-04, NFR-10 (app level) |
| Tests | **140 Vitest** (frontend) + **159 Rust** — all green; `cargo deny check` ok |
| Real window (Jose, macOS) | Opening the test vault, browsing, page view: **"So far, so good"** (2026-10-12). Stuck-opening bug found and fixed (§9 #1). Full checklist results beyond that were not itemised. |
| Real window (agent) | App builds and launches; native folder picker opens; screenshots taken (no synthetic input, by your rule) |
| Not verified | Pointer/keyboard drag-and-drop gestures and the real OS-trash prompt only by your quick pass; Windows/Linux; CI |
| Not done (by design) | Editing and rendered preview (**M2**), Global View (M3), block moving inside a page (M4), search (M5), audio (M6), Notion import (M7) |
| Merge | Merged locally into `main` after this document (see §11) |

### 1.1 Your feedback recorded for the next milestones
- **Breadcrumb** in the page header (`Vault › Folder › Page`, segments reveal the folder) → **M2** design.
- **Preview and editing** → **M2** (Live Preview, Source, Split with rendered pane).
- **Moving content inside a page** (blocks) → **M4** (drag blocks in the rendered preview); depends on M2.

---

## 2. Document map

| File | What |
|---|---|
| `docs/superpowers/specs/2026-10-12-m1b-app-integration-design.md` | **M1b design (binding)**, incl. §8 amendments 1–13 |
| `docs/superpowers/plans/2026-10-12-m1b-app-integration.md` | 10-task plan with full code; "Plan notes" 1–11 |
| `docs/superpowers/specs/2026-10-12-m1a-vault-core-design.md` | Engine design |
| `docs/handoff/2026-10-12-m1a-vault-core-handoff.md` | Engine hand-off (crate APIs, link rules, rename algorithm) |
| `docs/handoff/2026-10-12-m0-scaffold-handoff.md` | Setup, commands, privacy layers |
| `docs/product-spec.md`, `docs/superpowers/specs/2026-10-12-architecture-design.md` | Product requirements and architecture |

---

## 3. Backend map (`apps/desktop/src-tauri/src/`)

| File | Responsibility |
|---|---|
| `lib.rs` | `configure(builder, Option<AppDirs>)` registers commands, the dialog plugin and `AppState`; `run()` uses the OS config/cache dirs. Tests pass temp `AppDirs` so they never touch your real settings (plan note 2). |
| `state.rs` | `AppState { session: Mutex<Option<Arc<VaultSession>>>, settings: SettingsStore, cache_dir }`; `session()` → `noVault` error when closed; `set_session` replaces/drops (dropping stops the watcher). |
| `error.rs` | `CommandError { kind, message }` serialized as `{ kind, message }`; `ErrorKind`: `noVault, notFound, alreadyExists, notEmpty, invalidName, conflict, outsideVault, unsafeRewrite, watch, io`; `From<SessionError/VaultError/io::Error>`. |
| `dto.rs` | Wire types: `VaultInfo`, `IndexReportDto`, `TreeNodeDto`, `PageDto`, `RenameOutcomeDto`, event payloads. |
| `settings.rs` | `SettingsStore`: `settings.json` in the app config dir; atomic save; **field-by-field lenient parsing** (unknown values reset only that field; unknown keys and `version` preserved); corrupt file → defaults + one `settings.json.bad` copy + warning; recent vaults (dedupe by canonical path, cap 10, `missing` flag). |
| `vault_commands.rs` | Vault/explorer commands. Each public command is `async` and runs its `*_impl` on a blocking thread via `blocking()` (final review I2 — sync commands run on the macOS UI thread). |
| `settings_commands.rs` | `settings_get` (sync, in-memory), `settings_set`, `vaults_recent`, `vaults_forget` (async). |
| `capabilities/main.json` | Exactly: `allow-<each command>`, `core:event:allow-listen`, `core:event:allow-unlisten`, `dialog:allow-open`. Nothing else. |
| `build.rs` | AppManifest listing every app command (required for the `allow-*` permissions). |

### 3.1 Commands
| Command | Args → Result | Errors |
|---|---|---|
| `vault_open` | `{ path }` → `VaultInfo { name, root, report }` | `notFound`, `io` |
| `vault_create` | `{ path }` → `VaultInfo` (creates folder; must be empty except `.DS_Store`/`Thumbs.db`/`desktop.ini`) | `notEmpty` |
| `vault_close` | → `()` | — |
| `vault_tree` | → `TreeNodeDto[] { path, kind }` (flat, folders first) | `noVault` |
| `page_get` | `{ path }` → `PageDto { path, title, subtitle, cover, tags, links, backlinks, text (≤ 1 MiB), truncated, binary }` | `notFound`, `outsideVault` |
| `backlink_count` | `{ path }` → `number` (folders: links from outside into it) | |
| `entry_create_page` / `entry_create_folder` | `{ dir/parent, name }` → new path | `invalidName`, `alreadyExists` |
| `entry_rename` | `{ from, to }` → `RenameOutcomeDto { moved, updatedFiles, updatedLinks, failed }` (rewrites links when `rewriteLinks`) | `invalidName`, `alreadyExists`, `notFound` |
| `entry_trash` | `{ path }` → `()` | `notFound` |
| `settings_get` / `settings_set` | → `{ settings, warning? }` / `{ patch }` → `Settings` | `io` |
| `vaults_recent` / `vaults_forget` | → `RecentVaultDto[]` / `{ path }` → `()` | |

Events to `main`: `vault:progress { done, total }`, `vault:changed { created, modified, removed, renamed }` (external only), `vault:warning { message }`.

### 3.2 Settings file (`~/Library/Application Support/app.notesinmyway.desktop/settings.json` on macOS)
```json
{
  "version": 1,
  "language": null,
  "theme": "system",
  "rewriteLinks": true,
  "confirmDelete": true,
  "recentVaults": [{ "path": "/Users/you/Documents/NIMW Test Vault", "name": "NIMW Test Vault", "openedAt": "2026-10-12T20:50:00Z" }]
}
```
`language: null` = follow macOS. Delete the file to reset everything.

### 3.3 Permission checklist for a new command
1. `#[tauri::command] pub async fn foo<R: Runtime>(app: AppHandle<R>, …) -> CmdResult<T>` calling `blocking(app, move |app| foo_impl(&app.state::<AppState>(), …))`.
2. Register in `lib.rs` `generate_handler![…]`.
3. Add `"foo"` to `build.rs` AppManifest.
4. Add `"allow-foo"` to `capabilities/main.json`.
5. Add to `COMMANDS` in `tests/commands.rs` (allowed from `main`, denied elsewhere); the threading guard test checks it is `async`.
6. Typed wrapper in `src/ipc/index.ts`.

---

## 4. Frontend map (`apps/desktop/src/`)

| Path | Responsibility |
|---|---|
| `ipc/index.ts` | Only importer of `@tauri-apps/*`. One typed function per command; `ipcCall` returns `{ ok, value } | { ok: false, error }` (never throws); `onVaultProgress/Changed/Warning`; `pickFolder()`; `safeUnlisten`. |
| `ipc/testing.ts` | Re-exports Tauri `emit`/`mockIPC`/`clearMocks` for tests (keeps the lint ban strict). |
| `stores/settingsStore.ts` | Loads before first render; applies theme + language; `update(patch)`; shows a toast if the backend reports a settings warning. |
| `stores/vaultStore.ts` | `status: closed/opening/open`, progress, info, `nodes`, `children`, `expanded`, `selected`, `renaming`; actions `open/create/close/refreshTree/select/toggle/expand (whole ancestor chain)/createPage/createFolder/rename/trash`; 100 ms coalescing of `vault:changed`; sequence guards; opening never gets stuck (refused subscriptions → opens without live updates + toast; unexpected failure → back to Welcome). |
| `stores/pageStore.ts` | Read-only page state `empty/loading/ready/deleted`; follows renames; reloads on modify or delete+recreate (atomic saves); recovers from `deleted` when the file reappears. |
| `stores/toastStore.ts`, `uiStore.ts`, `messages.ts`, `tree.ts` | Toast queue (5 s; detail toasts persist); open dialog; error-kind → translated text; tree helpers (`childrenByParent`, `visibleRows`, `nextFreeName`, `remap`, `parentOf`, `joinPath`). |
| `app/App.tsx` | Routes on `vaultStore.status`: Welcome / OpeningOverlay / AppShell; Toaster + DialogHost. |
| `features/welcome/` | Enabled actions, `RecentList` (open, ×, missing state), language toggle (applies immediately, saves). |
| `features/opening/OpeningOverlay.tsx` | Progress overlay. |
| `features/shell/` | `AppShell` (Sidebar + TopBar + PageView + explorer DnD), `TopBar` (vault name, `[Edit · Global view]` with Global view disabled, Settings, Close), `Sidebar` (new page/folder buttons, tree, privacy footer), `useGlobalShortcuts`. |
| `features/explorer/` | `ExplorerTree` (ARIA tree, single always-visible Tab stop, roving focus, type-ahead, keys), `TreeRow` (inline rename with live `nameRules` feedback; dims while dragged), `ContextMenu`, `ExplorerDnd` (dnd-kit pointer + keyboard sensors, **drag ghost** via `DragOverlay`, cursor feedback, spring-loaded folders, announcements), `dragFeedback.ts` (`dropFeedback` allowed/forbidden/none, `createSpringLoad` 700 ms, `announcements`), `drop.ts` (`planDrop` rules, `dropEntry`), `deleteFlow.ts`. Drop colours: tokens `--color-drop-bg` / `--color-drop-ring` (readable on the dark sidebar in both themes). |
| `features/page/PageView.tsx` | Header (title, subtitle, tags, path, links/backlinks) + raw Markdown `<pre>`; empty/loading/deleted/truncated/binary states. |
| `features/dialogs/` | `Dialog` (focus trap, Esc), `MoveToDialog`, `ConfirmDeleteDialog` (backlink/item count, "don't ask again"), `SettingsDialog`, `DialogHost`. Dialogs/menus close themselves if their item vanishes. |
| `features/toasts/Toaster.tsx` | Bottom-centre toasts with optional detail list. |

### 4.1 Keyboard model
Tree = one Tab stop: ↑/↓, →/← (expand/collapse, child/parent), Home/End, type-ahead, Enter (open page / toggle folder), F2 rename, Delete trash, Shift+F10 menu; Space picks up / drops for keyboard drag (arrows move the drop target, Esc cancels).
Global (⌘ on macOS, Ctrl elsewhere): ⇧E explorer, O open vault (picker), `,` settings, N new page, ⇧N new folder.

---

## 5. Flows (files involved)
- **Open / create:** `Welcome` → `pickFolder` → `vaultStore.open/create` (`withProgress`) → `vault_open/create` → `refreshTree` → `status = open`. Errors toast and return to Welcome.
- **Rename / move:** inline rename (`TreeRow` → `ExplorerTree.commitRename`), drag (`ExplorerDnd` → `drop.dropEntry`), dialog (`MoveToDialog`) → `vaultStore.rename` → `entry_rename` → expand the destination chain, remap selection, `refreshTree`, `pageStore.follow`, toast (links updated / failures with details).
- **Delete:** `deleteFlow.requestDelete` → `ConfirmDeleteDialog` (if `confirmDelete`) → `vaultStore.trash` → `entry_trash` → selection moves to next sibling/parent → toast.
- **External changes:** `vault:changed` → coalesce 100 ms → `refreshTree` → `pageStore.onExternalChange(change, exists)`.
- **Close / switch:** TopBar Close → `vault_close` → Welcome; ⌘O → picker → opens in place.

---

## 6. Recipes
- **Add a command:** §3.3, then a store action, a component, and tests at each layer (Rust IPC test, `ipc` wrapper test with `mockIPC`, store test, component test with axe).
- **Add a setting:** field in `settings.rs` `Settings` + `SettingsPatch` + the `field!` line in `parse_lenient` + default; TS type in `ipc/index.ts`; control in `SettingsDialog`; en/es strings.
- **Add a dialog:** component in `features/dialogs/` using `Dialog`; a `uiStore` dialog variant; render in `DialogHost`; close itself if its target vanishes.
- **Add a context-menu action:** `ContextMenu.tsx` `actions` list + en/es `menu.*` key + test in `Interactions.test.tsx`.
- **Add a shortcut:** `useGlobalShortcuts.ts` + test; avoid keys macOS reserves.

---

## 7. Tests inventory
- **Rust (159):** M1a crates (as before plus `SessionEvent::Warning`, `trash` lock tests in `nimw-session`); desktop: `tests/commands.rs` (every command allowed from `main`, denied elsewhere; fixture open/tree/page; truncated/binary page; traversal → `outsideVault`; `notEmpty`; rename outcome; trash behind `NIMW_TRASH_TESTS`; progress event; **event listen/unlisten permission**; **threading guard**), `tests/settings.rs` (defaults, atomic round trip, corrupt file, newer keys/version, **unknown values reset only that field**, recents), `tests/errors.rs`, `tests/ipc.rs`.
- **Vitest (140):** `ipc/*.test.ts`, `stores/*.test.ts` (coalescing, stale responses, **refused subscriptions never stick**, settings warning toast, page atomic-save reload/recovery), `features/**/*.test.tsx` (welcome, shell, explorer keys/ARIA/rename, page states, dialogs, context menu, **Tab stop never lost**, **stale menus/dialogs close**, axe), `tests/network-ban.test.ts`.
- Focused runs: `pnpm --filter @nimw/desktop exec vitest run src/features/explorer`; `cargo test -p nimw-desktop --test commands`.
- OS trash: only with `NIMW_TRASH_TESTS=1` (CI sets it).

---

## 8. Rulings made on your behalf

| # | Ruling | Cost if wrong |
|---|---|---|
| 1 | Tasks applied by cherry-picking the planning agent's verified replay; each task re-checked here on its own commit (full frontend + Rust checks) | RED evidence from the replay, not this executor |
| 2 | Plan notes 1–11 (task order; injected `AppDirs`; `backlinks_into`; binary `page_get`; `language:"system"`; inline-rename state in `vaultStore`; `ipc/testing.ts`; Space for keyboard drag; immediate language switch; M0 stubs removed; stale-response guards) — spec amendments 1–10 | See plan notes |
| 3 | Event permissions: only `core:event:allow-listen` + `allow-unlisten` (not `core:event:default`, which also allows emit) | A future UI emit needs one more permission line |
| 4 | Final review: re-graded "stale menu/dialog disables shortcuts" and "atomic save shows deleted" from Minor to Important and fixed them | Small extra changes |
| 5 | All disk/index commands async; only `settings_get` sync; guard test | — |
| 6 | Settings parsed leniently; an unknown value resets only its field (the newer value for that one key is lost on next save) | That key's newer value |
| 7 | Drag feedback added within M1b (before merge) instead of deferring: spring-load delay 700 ms, drop colours as new sidebar tokens | Tweak the delay/colours in `dragFeedback.ts` / `tokens.css` |
| 8 | Merged locally after your "continue" (same as M1a) | Revert the merge commit if unwanted |

---

## 9. Bugs found after implementation, and fixes
1. **Real window, by you: stuck on "Opening vault".** Cause: capability lacked `core:event:allow-listen`; the progress subscription was refused before `vault_open` ran. Fix `76f43d0`: grant listen/unlisten; open without live updates if refused. Tests: `vlt_04_main_window_may_listen_to_vault_events` (Rust, real ACL), two store tests.
2. **Real window, by you: no visual cue while dragging in the explorer.** Cause: the only cue was a 2 px ring in the accent colour (`#4b2f86` on the `#1f1d24` sidebar — invisible in light theme) and no drag ghost. Fix `6b5a746`: ghost following the pointer, dimmed source row, tinted + ringed drop target, greyed ghost and not-allowed cursor for forbidden drops, spring-loaded folders (700 ms), translated keyboard-drag announcements. Tests: `dragFeedback.test.ts` (6). Visuals: rebuilt app handed to you; you replied "Continue" (no explicit visual confirmation).
3. **Final review (most capable model):** 1 Critical (= #1), 3 Important + 2 upgraded, 11 Minor deferred:
   - I1 explorer lost its only Tab stop after delete/move into collapsed folders → `974e6ed`.
   - I2 sync commands froze the window (trash prompt, big renames) → `505fc25`.
   - I3 newer settings could wipe all settings; warning never shown → `4555c2c`.
   - M3↑ stale menu/dialog disabled shortcuts; M7↑ atomic external save showed "deleted" → `d0e082a`.

---

## 10. Known gaps / deferred
| # | Gap | Target |
|---|---|---|
| a | Failed ⌘O switch leaves the backend on the old vault while the UI shows Welcome | M2 polish |
| b | Welcome reachable by keyboard during "opening" (second concurrent open possible) | M2 polish |
| c | Delete dialog: Enter doesn't confirm; first focus is the "don't ask again" checkbox | M2 polish |
| d | No "…" menu button on rows (right-click / Shift+F10 only) | M2 polish |
| e | Inline-rename error `aria-describedby` id built from the path (spaces) | M2 polish |
| f | Recent list not refreshed after a failed open (missing flag stale) | M2 polish |
| g | Backend warning/failure texts are English only | later (i18n of engine messages) |
| h | Each toast mounts a new `role=status` (VoiceOver may skip) | M8 a11y |
| i | Tree rows not memoized (≈100 ms/keypress with 5k rows expanded in jsdom) | M3/M8 perf |
| j | Opening fails if recents can't be saved (read-only config dir) | M2 polish |
| k | ACL test doesn't assert dialog save/message and event emit are denied; test temp dirs not cleaned; no `aria-setsize/posinset` | later |
| l | Page view is raw Markdown; no breadcrumb | **M2** |
| m | No undo for renames/moves; single window; `.nimw/vault.json` not written | later |
| n | M1a deferred minors (M1a hand-off §11 j–m, p–s) | as listed there |

---

## 11. Troubleshooting
| Symptom | Fix |
|---|---|
| Stuck on "Opening vault" | Fixed (§9 #1). If it ever happens again, check `capabilities/main.json` still has `core:event:allow-listen`. |
| Settings reset unexpectedly | Look for `settings.json.bad` next to `settings.json`; a toast names reset fields |
| A command says "not allowed" | Permission checklist §3.3 |
| Tree looks stale | It refetches after every own action and 100 ms after external changes; reopen the vault to force a full rescan |
| `cargo test -p nimw-desktop` fails: `../dist` missing | `pnpm build:ui` first |
| Test kit fixture path not found after using another checkout | `cargo clean -p nimw-testkit` (it bakes `CARGO_MANIFEST_DIR`) |
| pnpm refuses a fresh package version | release-age gate; see M0 hand-off §16.4 |

---

## 12. Next steps
1. **M2 — editor:** design + plan: CodeMirror 6 Live Preview / Source / Split with the remark-rendered pane, autosave via compare-and-swap writes, covers and attachments, the **breadcrumb**, and the M1b polish items (§10 a–f, j).
2. **M3 — Global View**, then **M4 — block moving** in the rendered preview (your request).
3. Push to GitHub for the first CI run.
