# M1b — App Integration: Design

> **Status:** Approved in design review · **Date:** 2026-10-12
> **Roles:** Jose — tech lead (decisions below are DECIDED)
> **Parent docs:** product spec `docs/product-spec.md` · architecture `docs/superpowers/specs/2026-10-12-architecture-design.md` · M1a design `docs/superpowers/specs/2026-10-12-m1a-vault-core-design.md` · hand-offs `docs/handoff/2026-10-12-m0-scaffold-handoff.md`, `docs/handoff/2026-10-12-m1a-vault-core-handoff.md`
> **Scope:** connect the M1a engine (`nimw-session`) to the desktop app: Tauri commands/events, a settings store, working welcome actions, the app shell with an explorer, a read-only page view, dialogs and toasts.

---

## 1. Goal and success criteria

After M1b a person can open (or create) a vault from the welcome screen, browse it in an Obsidian-style explorer, create / rename / move / delete pages and folders with links kept correct, read any page, and have their language, theme and recent vaults remembered.

Success means:
1. Welcome → **Create a new vault** (empty or new folder), **Open a folder as vault**, **Open an Obsidian vault**, and **Recent** all work (VLT-01); opening writes nothing inside the vault (VLT-02).
2. The explorer shows the vault tree with hidden/excluded entries omitted (EXP-01, VLT-05), and supports create, rename (inline), move (drag-and-drop and "Move to…"), delete to OS trash with confirmation (EXP-02, EXP-03), rewriting links on rename/move when the setting is on (EXP-04) with a summary toast.
3. Clicking a page opens a read-only page view (EXP-05) with title (from H1), subtitle, tags, path, link/backlink counts and the raw Markdown.
4. External changes appear without restart (VLT-04); the open page reloads, follows renames, or shows that it was deleted.
5. Settings persist across restarts: language, theme, rewrite links on rename, confirm before delete, recent vaults.
6. Everything is operable by keyboard without relying on macOS "Keyboard navigation" (Q-A11Y-1, NFR-10), screen-reader semantics are correct, and axe reports no violations.
7. Privacy guarantees hold: only allow-listed commands and the dialog plugin's folder picker are callable; no network.

### 1.1 Decisions taken in the M1b design review

| Topic | Decision |
|---|---|
| Main area with no page selected | App shell (sidebar + top bar with vault name, `[Edit · Global view]` toggle with Global view disabled, settings, close) and an empty state "Pick a page in the explorer" |
| Explorer operations | Context menu (right-click / "…" / Shift+F10) + drag-and-drop + keys (arrows, Enter, F2, Delete) + "Move to…" dialog |
| Delete | Confirmation dialog with backlink count (item count for folders); "don't ask again" turns the `confirmDelete` setting off |
| Keyboard | App-level model: the tree is one focus stop with arrow keys (ARIA tree pattern); global shortcuts for regions; no dependence on Tab reaching buttons |
| Sync model | **Snapshot + coalesced refetch**: fetch the whole tree; refetch after own operations and 100 ms-coalesced external changes; render only expanded folders |
| Drag-and-drop | `@dnd-kit/core` (pointer + keyboard sensors), not native HTML5 DnD |
| Settings | Rust-owned `settings.json` in the OS app config dir, atomic writes |
| Page view | Read-only raw Markdown (CodeMirror arrives in M2) |
| Notion import button | Stays disabled (M7) |

---

## 2. Backend (`apps/desktop/src-tauri`)

### 2.1 New dependencies
| Crate / package | Version | License | Purpose |
|---|---|---|---|
| `nimw-session`, `nimw-vault` (workspace path deps) | — | GPL-3.0-or-later | engine |
| `tauri-plugin-dialog` | 2.8.x | MIT/Apache-2.0 | native folder picker only |
| `@tauri-apps/plugin-dialog` | ^2.8.2 | MIT/Apache-2.0 | JS side of the picker (imported only in `src/ipc/`) |
| `serde_json` (existing) | | | settings file |

The dialog plugin opens no network connections; `cargo deny check` must stay green.

### 2.2 State
```rust
pub struct AppState {
    pub session: Mutex<Option<Arc<VaultSession>>>,
    pub settings: SettingsStore,
}
```
One app state per window (M1b has one window). Opening a vault replaces the session (dropping the old one stops its watcher).

### 2.3 Settings store (`src-tauri/src/settings.rs`)
File: `<app_config_dir>/settings.json` (Tauri `app.path().app_config_dir()`, i.e. per bundle identifier `app.notesinmyway.desktop`). Written atomically (temp file in the same directory, fsync, rename).

```json
{
  "version": 1,
  "language": null,
  "theme": "system",
  "rewriteLinks": true,
  "confirmDelete": true,
  "recentVaults": [{ "path": "/abs/path", "name": "Digital Brain", "openedAt": "2026-10-12T16:00:00Z" }]
}
```
- `language`: `null` = follow the OS (Q-I18N-1), else `"en"`/`"es"`. `theme`: `"system" | "light" | "dark"`.
- `recentVaults`: most recent first, deduplicated by canonical path, capped at 10. Entries are never silently dropped; `vaults_recent` marks `missing: true` when the folder no longer exists.
- Missing file → defaults. Unreadable/corrupt file → defaults + a warning returned with `settings_get` (the corrupt file is kept as `settings.json.bad` once, not overwritten until the next successful save).
- `settings_set(patch)` merges a partial object and saves.

### 2.4 Commands
All path arguments from the UI are vault-relative strings validated with `VaultPath::new` (traversal guard). Long-running commands (`vault_open`, `vault_create`) run on a blocking thread (`tauri::async_runtime::spawn_blocking`).

| Command | Args → Result | Notes |
|---|---|---|
| `vault_open` | `{ path: string }` → `VaultInfo { name, root, report: IndexReportDto }` | `VaultSession::open(path, app_cache_dir, sink)`; emits `vault:progress`; `start_watching()`; pushes to recent vaults |
| `vault_create` | `{ path }` → `VaultInfo` | Creates the folder if missing; fails `notEmpty` if it contains any entry other than OS metadata files (`.DS_Store`, `Thumbs.db`, `desktop.ini`); then as `vault_open` |
| `vault_close` | `()` → `()` | Drops the session |
| `vault_tree` | `()` → `TreeNodeDto[] { path, kind: "page"|"folder"|"attachment" }` | Flat, ordered (folders first, case-insensitive name) |
| `page_get` | `{ path }` → `PageDto { path, title, subtitle, cover, tags: string[], links: number, backlinks: number, text: string, truncated: bool, binary: bool }` | `text` capped at 1 MiB (`truncated`); invalid UTF-8 → `binary: true`, empty text |
| `backlink_count` | `{ path }` → `number` | For folders: links into anything inside |
| `entry_create_page` | `{ dir, name }` → `string` (new path) | `name` without `.md` |
| `entry_create_folder` | `{ parent, name }` → `string` | |
| `entry_rename` | `{ from, to }` → `RenameOutcomeDto { moved, updatedFiles, updatedLinks, failed: [path, reason][] }` | Uses settings `rewriteLinks` |
| `entry_trash` | `{ path }` → `()` | |
| `settings_get` | `()` → `{ settings, warning?: string }` | |
| `settings_set` | `{ patch }` → `Settings` | |
| `vaults_recent` | `()` → `RecentVaultDto[] { path, name, openedAt, missing }` | |
| `vaults_forget` | `{ path }` → `()` | |

### 2.5 Events (emitted to the `main` window)
- `vault:progress { done, total }`
- `vault:changed { created, modified, removed, renamed: [from, to][] }` — external changes only
- `vault:warning { message }`

### 2.6 Errors
Every command returns `Result<T, CommandError>` serialized as `{ kind, message }`:
`noVault`, `notFound`, `alreadyExists`, `notEmpty`, `invalidName`, `conflict`, `outsideVault`, `unsafeRewrite`, `watch`, `io`. Mapping from `SessionError`/`VaultError` is a single `From` impl, unit-tested.

### 2.7 Permissions
- `build.rs` AppManifest lists every command above; `capabilities/main.json` grants each `allow-<command>` to window `main` only, plus `dialog:allow-open` (folder picker). Nothing else (no `core:default`).
- `tests/ipc.rs` asserts each command is callable from `main` and denied from another window label.

### 2.8 Engine additions (`nimw-session`, from the M1a hand-off)
- `SessionEvent::Warning(String)` replaces the `Indexed(IndexReport { files: 0, … })` workaround for watcher warnings (M1a §11 o).
- `trash()` releases the index lock before the OS trash call and re-acquires it afterwards (M1a §11 n).

---

## 3. Frontend (`apps/desktop/src`)

### 3.1 New dependencies
`zustand` ^5.0.15 (MIT), `@dnd-kit/core` ^6.3.1 (MIT), `@dnd-kit/utilities` ^3.2.2 (MIT), `@tauri-apps/plugin-dialog` ^2.8.2.

### 3.2 IPC layer (`src/ipc/`)
- One typed function per command (`vaultOpen`, `vaultTree`, `pageGet`, …), event subscriptions (`onVaultProgress`, `onVaultChanged`, `onVaultWarning`), and `pickFolder()` (dialog plugin). Remains the only module importing `@tauri-apps/*` (ESLint ban).
- `ipcCall<T>(fn): Promise<{ ok: true, value: T } | { ok: false, error: { kind, message } }>` — callers never see a thrown IPC error.

### 3.3 Stores (Zustand)
| Store | State / actions |
|---|---|
| `settingsStore` | `settings`, `load()` (before first render; applies theme + language), `update(patch)` |
| `vaultStore` | `status: 'closed' | 'opening' | 'open'`, `progress`, `info`, `nodes`, derived `childrenByParent`, `expanded: Set`, `selected`, actions `open(path)`, `create(path)`, `close()`, `refreshTree()`, `select(path)`, `toggle(path)`, `createPage(dir)`, `createFolder(dir)`, `rename(from, to)`, `trash(path)`; subscribes to `vault:changed` (100 ms coalescing) and `vault:warning` |
| `pageStore` | `page`, `state: 'empty' | 'loading' | 'ready' | 'deleted'`, `load(path)`, reacts to `vault:changed` (reload if modified, follow if renamed, `deleted` if removed) |
| `toastStore` | queue of `{ id, message, detail?: string[], tone }`, auto-dismiss 5 s (detail toasts stay until dismissed) |
| `uiStore` | open dialog (`rename | move | delete | settings | null` + target), inline-rename path, focused region |

### 3.4 Screens and components
- `app/App.tsx` routes on `vaultStore.status`: Welcome / `OpeningOverlay` (progress) / `AppShell`.
- `features/welcome/Welcome.tsx`: buttons enabled (Create, Open folder, Open Obsidian vault → `pickFolder` → `vaultStore.create/open`); Notion import disabled with "Arrives in a later milestone"; `RecentList` (click to open, × to forget, "Folder not found" state).
- `features/shell/AppShell.tsx` + `TopBar.tsx` + `Sidebar.tsx`: prototype layout and tokens (`.side`, `.trow`, `.topbar`, `.toggle`); top bar shows vault name, `[Edit · Global view]` (Global view `aria-disabled` + tooltip), Settings, Close vault.
- `features/explorer/`: `ExplorerTree.tsx` (ARIA tree, roving focus, keyboard handlers, dnd-kit context), `TreeRow.tsx` (icon by kind, inline rename input, drop target highlight), `ContextMenu.tsx`, `nameRules.ts` (client-side mirror of the forbidden-name rule for instant feedback; the backend stays authoritative).
- `features/page/PageView.tsx`: header (title, subtitle, tags, path, "N links · M backlinks"), raw Markdown `<pre>` (monospace, wraps, scrolls), empty / loading / deleted / truncated / binary states.
- `features/dialogs/`: `MoveToDialog.tsx`, `ConfirmDeleteDialog.tsx`, `SettingsDialog.tsx`, shared `Dialog.tsx` (focus trap, Esc, labelled).
- `features/toasts/Toaster.tsx`: bottom-centre, `role="status"` (polite) / `role="alert"` for errors.

### 3.5 Keyboard model (NFR-10)
- Explorer tree: single Tab stop; ↑/↓ move, →/← expand/collapse or go to child/parent, Home/End, Enter opens page / toggles folder, F2 rename, Delete trash, Shift+F10 or ContextMenu key opens the menu, type-ahead by first letter.
- Global shortcuts (⌘ on macOS, Ctrl elsewhere): **⇧E** focus explorer, **O** open vault (folder picker; picking a folder switches vaults), **,** settings, **N** new page in selected folder, **⇧N** new folder.
- Dialogs: focus first field, trap focus, Esc cancels, Enter confirms.
- dnd-kit keyboard sensor: Space to pick up, arrows to move between folders, Space to drop, Esc to cancel (a second keyboard path to "Move to…").

### 3.6 i18n and theming
All new strings in `en.json` and `es.json` (parity check). All styles via CSS Modules + tokens (light/dark).

---

## 4. Flows

### 4.1 Open / create
Picker (or recent entry) → `status = opening` → `vault_open`/`vault_create` with progress overlay → `refreshTree()` → `status = open`, root expanded one level, nothing selected (empty state). Errors: `notFound` → toast + recent entry marked missing; `notEmpty` → toast "Pick an empty or new folder"; report warnings → toast "Opened with N warnings" with a detail list.

### 4.2 Explorer operations
- **New page/folder:** `Untitled`, `Untitled 1`, … (first free name) in the selected folder (or the root) → inline rename with the name selected; Enter confirms (rename), Esc keeps the default.
- **Rename / move:** inline rename, drag-and-drop or "Move to…" → `entry_rename` → `refreshTree()`, selection follows; toast "Updated links in N files" when `updatedFiles > 0`; when `failed` is non-empty, toast "Renamed. N files couldn't be updated" with details. Invalid names are flagged while typing (`nameRules.ts`) and rejected by the backend (`invalidName`).
- **Delete:** if `confirmDelete`, dialog with `backlink_count` (or item count); then `entry_trash` → `refreshTree()`, selection moves to the next sibling or parent; toast "Moved to Trash".
- **Drag-and-drop rules:** drop targets are folders and the root; dropping onto itself, its current parent or its own descendant is not allowed (no drop indicator).

### 4.3 External changes
`vault:changed` → coalesce 100 ms → `refreshTree()`; `pageStore` reloads the open page if modified, follows if renamed, shows "This page was deleted outside the app" if removed. `vault:warning` → toast.

### 4.4 Close / switch
Top bar "Close vault" → `vault_close` → Welcome (the closed vault first in Recent). ⌘O opens the folder picker directly; picking a folder opens it in place of the current vault (cancel keeps the current one).

---

## 5. Testing and verification

### 5.1 Rust
- `settings.rs` unit tests: defaults, round-trip, patch merge, corrupt file → defaults + warning + `.bad` copy, recent list dedupe/cap/missing flag, atomic write leaves no temp files.
- Error mapping unit tests (`From<SessionError>`).
- `tests/ipc.rs` (real context + ACL, mock runtime): every new command allowed from `main`, denied from another window; `vault_open` on a fixture copy; `vault_tree`; `page_get` (incl. truncated/binary); `entry_rename` returns `RenameOutcomeDto`; `entry_trash` (behind `NIMW_TRASH_TESTS=1`); traversal strings (`../x`) → `outsideVault`; `vault_create` on a non-empty folder → `notEmpty`.
- `nimw-session`: `SessionEvent::Warning` emitted for watcher warnings; trash no longer holds the index lock during the OS call.

### 5.2 Frontend (Vitest + Testing Library + axe, mocked IPC)
- Stores: status transitions, tree refresh after ops, 100 ms coalescing (fake timers), settings applied before first render, toast on rename with failures.
- Welcome: actions call picker → open/create; recent open/forget/missing; Spanish.
- Explorer: ARIA attributes, single Tab stop, every key binding, inline rename validation, context menu actions, dnd-kit keyboard-sensor move, forbidden drops.
- PageView: header, raw text, empty/loading/deleted/truncated/binary states.
- Dialogs: focus trap, Esc, delete backlink count, "don't ask again".
- axe (no violations) on Welcome, AppShell with tree + page, each dialog. i18n parity and network-ban lint stay green.

### 5.3 Real-window verification
- Agent: build the app, open a copy of `fixtures/vaults/obsidian-basic`, screenshot welcome → opening → explorer → page view → rename with toast, in light and dark (no synthetic keystrokes; launching and screenshots only).
- Human (Jose): keyboard checklist in the real window with macOS Keyboard navigation off and on — what Tab reaches, tree arrows, shortcuts, dialogs, dnd keyboard move. Results recorded in the M1b hand-off.

---

## 6. Out of scope (→ later)
- Editing (M2), Global View (M3), search (M5), audio (M6), Notion import (M7), signing/installers (M8).
- Multiple windows / vaults at once; undo of renames; writing `.nimw/vault.json` (exclude globs editable by hand only).
- Remaining M1a deferred minors (hand-off §11 j–m, p–s) unless a M1b task touches the same code.

## 7. Spec self-review notes
- Each success criterion in §1 maps to tests in §5.
- Ambiguities settled: recent-vault cap (10), truncation (1 MiB), coalescing (100 ms), toast lifetime (5 s; detail toasts persist), `vault_create` emptiness (any entry except OS metadata files), default names (`Untitled`, `Untitled 1`, …), shortcut set (§3.5), ⌘O vs Close vault (§4.4).

---

## 8. Amendments (2026-10-12, from compile-checking the M1b plan)

Recorded with evidence in the plan's notes (`docs/superpowers/plans/2026-10-12-m1b-app-integration.md`); they supersede the sections named.

1. **Task order:** the explorer tree (part 1) is built before the app shell so the shell renders the real tree.
2. **`configure(builder, Option<AppDirs>)`** (§2.2): the mock IPC runtime does not run `setup`, and tests must never touch the user's real settings, so directories are injected; `AppState` also holds `cache_dir`.
3. **`VaultSession::backlinks_into(path)`** is added so a folder's backlink count only counts links from outside the folder (§2.4 `backlink_count`).
4. **`page_get`** returns `binary: true` for `.md` files that are not valid UTF-8 (§2.4).
5. **Settings (§2.3):** in a patch, `language: "system"` means follow the OS (stored as `null`); unknown keys and the file `version` are preserved when saving (a newer app's file is not clobbered).
6. **Stores (§3.3):** the inline-rename state lives in `vaultStore` (not `uiStore`); stores guard against stale responses with sequence numbers and unsubscribe safely.
7. **IPC tests:** a `src/ipc/testing.ts` helper keeps the ESLint `@tauri-apps/*` ban strict in test files.
8. **Drag-and-drop (§3.5):** Space picks up and drops; only dnd-kit listeners are attached to tree rows.
9. **Welcome language toggle** switches immediately and then saves the setting.
10. **M0 stub screens** (`GlobalViewScreen`, `EditorScreen`) and their unused strings are removed (replaced by the shell).
