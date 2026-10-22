# M1b App Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the M1a vault engine to the desktop app: Tauri commands and events over `VaultSession`, a persisted settings store, working welcome actions with recent vaults, an app shell with an Obsidian-style explorer (keyboard tree, inline rename, context menu, drag-and-drop, move/delete dialogs), a read-only page view, toasts and global shortcuts.

**Architecture:** The Rust shell (`apps/desktop/src-tauri`) gains thin commands over `liber-session`, an `AppState` (open session + settings + cache dir) and a JSON settings store; every path from the UI is validated by `VaultPath::new` and every command is allow-listed per window. The React app talks to it only through `src/ipc/` (typed functions returning `IpcResult`, never throwing), keeps state in five small Zustand stores, refetches the whole tree after its own operations and after 100 ms-coalesced external changes (newest response wins), and renders only expanded folders.

**Tech Stack:** Rust 1.99 / Tauri 2.12 (+ tauri-plugin-dialog 2.8), React 19, TypeScript 6.0, Zustand 5, dnd-kit 6, i18next ICU, Vitest 5 + Testing Library + axe-core.

**Spec:** `docs/superpowers/specs/2026-10-12-m1b-app-integration-design.md` (binding; this plan argues from it). Parents: `docs/product-spec.md`, `docs/superpowers/specs/2026-10-12-architecture-design.md`, `docs/superpowers/specs/2026-10-12-m1a-vault-core-design.md`, `docs/handoff/2026-10-12-m1a-vault-core-handoff.md`, `docs/handoff/2026-10-12-m0-scaffold-handoff.md`.

**How this plan was verified:** every code block below is the exact content of a commit in a replay of this plan on a fresh clone of the repository at `869fd32` (`scratchpad/m1b-replay`, commits `062d4ff`…`3ab3a10`, one per task). In that replay every RED step failed for the stated reason and every GREEN step passed; the final commit passes `pnpm check` (124 Vitest + 156 Rust tests, eslint, prettier, tsc, i18n parity, rustfmt, clippy `-D warnings`) and `cargo deny check`. Task 10 (real-window verification + hand-off) is not part of the replay: it needs a GUI and is done by the executor and the maintainer.

## Global Constraints

- License GPL-3.0-or-later; `cargo deny check` stays green; no network code (the dialog plugin is used for the native folder picker only, permission `dialog:allow-open`; `deny.toml` bans HTTP/WebSocket crates and the Tauri http/updater/shell/websocket/upload plugins).
- Only `apps/desktop/src/ipc/` imports `@tauri-apps/*` (ESLint). Tests outside it import Tauri test helpers from `src/ipc/testing.ts`.
- Every command is listed in `apps/desktop/src-tauri/build.rs` (AppManifest) **and** granted as `allow-<kebab-name>` in `capabilities/main.json` for window `main` only; `tests/commands.rs` asserts allowed-from-main / denied-elsewhere for all of them.
- Every path string from the UI goes through `VaultPath::new` (traversal guard); the vault root is `""` for directory arguments.
- Errors cross IPC as `{ kind, message }` with `kind ∈ noVault | notFound | alreadyExists | notEmpty | invalidName | conflict | outsideVault | unsafeRewrite | watch | io`; the UI shows `errors.<kind>`.
- Settings file `<app_config_dir>/settings.json`, atomic writes, `version: 1`, unknown keys and newer versions preserved; recent vaults capped at **10**; page view text capped at **1 MiB**; external changes coalesced over **100 ms**; toasts auto-dismiss after **5 s** unless they carry details.
- New-vault folders must be empty except OS metadata files `.DS_Store`, `Thumbs.db`, `desktop.ini`.
- Names created/renamed in the UI follow the backend rule: no `/ \ # | ^ [ ] : * " < > ?`, no control characters, not starting with `.`, not blank.
- Shortcuts (⌘ on macOS, Ctrl elsewhere): ⇧E explorer, O open vault, `,` settings, N new page, ⇧N new folder.
- Exact versions (verified in `Cargo.lock` / `pnpm-lock.yaml`): `tauri-plugin-dialog` 2.8.2, `@tauri-apps/plugin-dialog` 2.8.2, `zustand` 5.0.15, `@dnd-kit/core` 6.3.1, `@dnd-kit/utilities` 3.2.2 (existing: tauri 2.12.3, @tauri-apps/api 2.12.3, react 19.3, typescript 6.0.3, vitest 5.0.4, axe-core 4.14).
- All UI strings in `en.json` **and** `es.json` (`pnpm check:i18n`); all colours via CSS tokens (light/dark).
- Tests are named after requirements (`vlt_01_…`, `EXP-02 …`, `NFR-10 …`) and `review_focus…` for the pins below. Real-OS-trash tests run only with `LIBER_TRASH_TESTS=1`. Never send synthetic keystrokes to the user's machine (osascript key codes are forbidden); real-window checks use launching + screenshots only.
- Commits are conventional and end with a `Co-Authored-By:` trailer naming the model that actually wrote the commit (M0 ruling).

## Review Focus

1. **A recent vault on a drive that is no longer mounted** — shown as "Folder not found", not openable, removable, and nothing crashes. Pinned by `review_focus recent vaults: open, missing (unmounted) and forget` (Task 6).
2. **Rapid renames/drags while a tree refresh is still in flight** — an older, slower `vault_tree` response must never overwrite a newer one. Pinned by `review_focus stale tree responses are ignored` (Task 5).
3. **The selected item's parent folder is deleted outside the app** — selection falls back to the nearest folder that still exists, expansion of vanished folders is dropped. Pinned by `review_focus selection falls back to the nearest existing ancestor` (Task 5).
4. **A `settings.json` written by a newer app version** (unknown keys, higher `version`) — this build reads what it knows and keeps the rest (and the version) when it saves. Pinned by `review_focus_newer_settings_file_keeps_unknown_keys_and_version` (Task 2).
5. **A vault with thousands of files in one folder** — the tree renders only rows of expanded folders, so refetches stay cheap. Pinned by `review_focus renders only rows of expanded folders` (Task 7).

## File Structure

```
crates/liber-session/src/
  events.rs           + SessionEvent::Warning                                    (Task 1)
  session.rs          trash without the index lock, backlinks_into               (Tasks 1, 3)
  watching.rs         warnings → SessionEvent::Warning                           (Task 1)
apps/desktop/src-tauri/
  Cargo.toml          liber-session/vault, thiserror, serde_json, dialog plugin   (Tasks 2, 3)
  build.rs            COMMANDS list for the AppManifest                          (Task 3)
  capabilities/main.json  allow-<command> ×15 + dialog:allow-open                (Task 3)
  src/lib.rs          AppDirs, configure(builder, Option<AppDirs>), run()        (Tasks 2, 3)
  src/error.rs        ErrorKind, CommandError, CmdResult                         (Task 2)
  src/settings.rs     Settings, SettingsPatch, SettingsStore, rfc3339_utc        (Task 2)
  src/state.rs        AppState { session, settings, cache_dir }                  (Tasks 2, 3)
  src/dto.rs          VaultInfo, IndexReportDto, TreeNodeDto, PageDto, …         (Task 3)
  src/vault_commands.rs   vault_*/page_get/backlink_count/entry_* commands       (Task 3)
  src/settings_commands.rs settings_get/set, vaults_recent/forget                (Task 3)
  tests/settings.rs, tests/errors.rs, tests/commands.rs (+ ipc.rs build_app)     (Tasks 2, 3)
apps/desktop/src/
  ipc/index.ts        typed commands, IpcResult, events, pickFolder              (Task 4)
  ipc/testing.ts      emit/mockIPC/clearMocks re-exports for tests               (Task 5)
  stores/             tree.ts, messages.ts, toastStore, uiStore, settingsStore,
                      pageStore, vaultStore (+ tests)                             (Tasks 5, 8)
  features/welcome/   Welcome (wired), RecentList                                (Task 6)
  features/opening/   OpeningOverlay                                             (Task 6)
  features/toasts/    Toaster                                                    (Task 6)
  features/explorer/  nameRules, TreeRow, ExplorerTree                           (Task 7)
                      drop, deleteFlow, ExplorerDnd, ContextMenu                 (Task 9)
  features/page/      PageView                                                   (Task 8)
  features/shell/     AppShell, Sidebar, TopBar (+ useGlobalShortcuts)           (Tasks 8, 9)
  features/dialogs/   Dialog, ConfirmDeleteDialog, MoveToDialog, SettingsDialog,
                      DialogHost                                                 (Task 9)
  app/App.tsx         routes on vault status                                     (Tasks 6, 8)
  main.tsx            settings load before first render                          (Task 6)
  i18n/locales/en.json, es.json   errors, toasts, welcome, opening, explorer,
                      shell, page, menu, dialogs, settings                        (Tasks 5–9)
docs/handoff/<date>-m1b-app-integration-handoff.md                               (Task 10)
```

Removed in Task 8: `app/ScreenRouter.tsx` (+ test), `features/global-view/GlobalViewScreen.tsx`, `features/editor/EditorScreen.tsx` (M0 stubs).

---

### Task 1: liber-session: `SessionEvent::Warning` and trash without holding the index lock

**Requirements:** M1a hand-off §11 n, o · VLT-04, EXP-03

**Files:**
- Modify: `crates/liber-session/src/events.rs`
- Modify: `crates/liber-session/src/session.rs`
- Modify: `crates/liber-session/src/watching.rs`
- Modify: `crates/liber-session/tests/watching.rs`

**Interfaces:**
- Consumes: M1a `liber-session` (`VaultSession`, `SessionEvent`, `emit`, `index()`, watcher `apply`).
- Produces: `SessionEvent::Warning(String)` (watcher/apply warnings; no more `Indexed(IndexReport{files:0,..})`); `VaultSession::trash` now releases the index lock during the OS call; crate-internal `trash_with_hook(&self, path: &VaultPath, before_os_call: &dyn Fn()) -> Result<()>`.

- [ ] **Step 1: Write the failing tests**

Modify `crates/liber-session/tests/watching.rs` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/crates/liber-session/tests/watching.rs b/crates/liber-session/tests/watching.rs
index 6d8ca53..d36c411 100644
--- a/crates/liber-session/tests/watching.rs
+++ b/crates/liber-session/tests/watching.rs
@@ -260,3 +260,31 @@ fn vlt_04_unreadable_new_folder_does_not_drop_the_batch() {
     result.unwrap();
     assert!(s.page(&vp("b.md")).unwrap().is_some());
 }
+
+/// M1b (M1a hand-off §11 o): warnings found while applying watcher events are
+/// their own event, not an `Indexed` report with zero files.
+#[test]
+fn vlt_04_watcher_warnings_are_warning_events() {
+    let vault = tempfile::tempdir().unwrap();
+    std::fs::write(vault.path().join("a.md"), "# a").unwrap();
+    let cache = tempfile::tempdir().unwrap();
+    let events: Events = Arc::new(Mutex::new(Vec::new()));
+    let sink = events.clone();
+    let (s, _) = VaultSession::open(vault.path(), cache.path(), move |e| {
+        sink.lock().unwrap().push(e)
+    })
+    .unwrap();
+    events.lock().unwrap().clear();
+    std::fs::write(vault.path().join("bad.md"), [0xff, 0xfe, b'x']).unwrap();
+    s.apply(vec![WatchEvent::Changed(vp("bad.md"))]).unwrap();
+    let got = events.lock().unwrap().clone();
+    assert!(
+        got.iter()
+            .any(|e| matches!(e, SessionEvent::Warning(m) if m.contains("bad.md"))),
+        "{got:?}"
+    );
+    assert!(
+        !got.iter().any(|e| matches!(e, SessionEvent::Indexed(_))),
+        "{got:?}"
+    );
+}
````

Append this test module to the end of `crates/liber-session/src/session.rs`:

````rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// M1b (M1a hand-off §11 n): the OS trash call may block on a permission
    /// prompt, so the index must not be locked while it runs.
    #[test]
    fn exp_03_trash_does_not_hold_the_index_lock_during_the_os_call() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join("a.md"), "# a").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(vault.path(), cache.path(), |_| {}).unwrap();
        // Removing the file first makes the OS call fail (NotFound) after the
        // hook ran, so this test never touches the real trash.
        std::fs::remove_file(vault.path().join("a.md")).unwrap();
        let hook_ran = AtomicBool::new(false);
        let result = s.trash_with_hook(&VaultPath::new("a.md").unwrap(), &|| {
            assert!(s.index.try_lock().is_ok(), "index locked during OS trash");
            hook_ran.store(true, Ordering::SeqCst);
        });
        assert!(hook_ran.load(Ordering::SeqCst));
        assert!(result.is_err());
    }
}
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p liber-session`

Expected: FAIL to compile: "no variant, associated function, or constant named `Warning` found for enum `SessionEvent`" and "no method named `trash_with_hook` found for struct `session::VaultSession`".

- [ ] **Step 3: Implement**

Modify `crates/liber-session/src/events.rs` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/crates/liber-session/src/events.rs b/crates/liber-session/src/events.rs
index 70b20ec..9103c5e 100644
--- a/crates/liber-session/src/events.rs
+++ b/crates/liber-session/src/events.rs
@@ -30,6 +30,9 @@ pub enum SessionEvent {
         removed: Vec<String>,
         renamed: Vec<(String, String)>,
     },
+    /// A non-fatal problem found while applying external changes (unreadable
+    /// folder, invalid UTF-8 page, watcher error).
+    Warning(String),
 }
 
 /// Result of [`crate::VaultSession::rename`] (EXP-02, EXP-04).
````

Modify `crates/liber-session/src/watching.rs` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/crates/liber-session/src/watching.rs b/crates/liber-session/src/watching.rs
index 684eaab..0b28286 100644
--- a/crates/liber-session/src/watching.rs
+++ b/crates/liber-session/src/watching.rs
@@ -31,10 +31,7 @@ impl VaultSession {
     }
 
     fn emit_warning(&self, message: String) {
-        self.emit(SessionEvent::Indexed(crate::events::IndexReport {
-            warnings: vec![message],
-            ..Default::default()
-        }));
+        self.emit(SessionEvent::Warning(message));
     }
 
     /// Applies one watcher batch (spec §6.5). Paths are re-checked on disk and
````

Modify `crates/liber-session/src/session.rs` — apply this patch (implementation part):

````diff
--- a/crates/liber-session/src/session.rs
+++ b/crates/liber-session/src/session.rs
@@ -303,14 +303,27 @@
 
     /// Moves a file or folder to the OS trash (EXP-03). Links to it become unresolved.
     pub fn trash(&self, path: &VaultPath) -> Result<()> {
-        let mut index = self.index();
-        let keys: Vec<String> = index
+        self.trash_with_hook(path, &|| {})
+    }
+
+    /// `trash` with a hook that runs just before the OS call. The index lock is
+    /// released during that call: the OS may block on a permission prompt and
+    /// reads/the watcher must not stall meanwhile.
+    pub(crate) fn trash_with_hook(
+        &self,
+        path: &VaultPath,
+        before_os_call: &dyn Fn(),
+    ) -> Result<()> {
+        let keys: Vec<String> = self
+            .index()
             .file_set()?
             .iter()
             .filter(|p| VaultPath::new(p).is_ok_and(|vp| vp.starts_with(path)))
             .map(|p| link_key(p))
             .collect();
+        before_os_call();
         self.vault.trash(path)?;
+        let mut index = self.index();
         index.transaction(|tx| tx.remove(path.as_str()))?;
         let files = index.file_set()?;
         index.resolve_affected(&files, &keys)?;
@@ -389,3 +402,4 @@
     out.sort();
     out
 }
+
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p liber-session`

Expected: PASS: lib 5, open 8, rename 13, rename_props 2, watching 9 (incl. `vlt_04_watcher_warnings_are_warning_events`, `exp_03_trash_does_not_hold_the_index_lock_during_the_os_call`).

- [ ] **Step 5: Format, lint and type checks**

Run: `cargo fmt --all --check && cargo clippy -p liber-session --all-targets -- -D warnings`

Expected: clean (no diff, no warnings)

- [ ] **Step 6: Commit**

````bash
git add crates/liber-session
git commit -m "feat(session): Warning event and trash without holding the index lock (VLT-04, EXP-03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
````

(Implementers: the trailer names the model that actually wrote the commit — M0 ruling.)

---

### Task 2: Desktop backend: `CommandError`, settings store and `AppState`

**Requirements:** M1b spec §2.2, §2.3, §2.6

**Files:**
- Create: `apps/desktop/src-tauri/src/error.rs`
- Create: `apps/desktop/src-tauri/src/settings.rs`
- Create: `apps/desktop/src-tauri/src/state.rs`
- Create: `apps/desktop/src-tauri/tests/errors.rs`
- Create: `apps/desktop/src-tauri/tests/settings.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Updated by cargo: `Cargo.lock`

**Interfaces:**
- Consumes: `liber_session::{SessionError, VaultSession}`, `liber_vault::{VaultError, Hash}`.
- Produces: `liber_desktop::error::{ErrorKind, CommandError, CmdResult<T>}` (serialized `{ kind: camelCase, message }`, `CommandError::new(kind, msg)`, `CommandError::no_vault()`, `From<SessionError|VaultError|io::Error>`); `liber_desktop::settings::{Settings, SettingsPatch, Theme, RecentVault, RecentVaultDto, SettingsDto, SettingsStore, MAX_RECENT = 10, SETTINGS_VERSION = 1, rfc3339_utc(u64) -> String}` with `SettingsStore::load(dir) / get() -> (Settings, Option<String>) / dto() / update(SettingsPatch) -> io::Result<Settings> / push_recent(&Path, &str) / recent() -> Vec<RecentVaultDto> / forget(&str)`; `liber_desktop::state::AppState { settings }` with `new(SettingsStore)`, `session() -> Result<Arc<VaultSession>, CommandError>`, `set_session(Option<Arc<VaultSession>>)` (Task 3 adds `cache_dir`).

- [ ] **Step 1: Write the failing tests**

The crate needs its new dependencies before the tests can compile, so the `Cargo.toml` patch is part of this step.

Modify `apps/desktop/src-tauri/Cargo.toml` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src-tauri/Cargo.toml b/apps/desktop/src-tauri/Cargo.toml
index b437793..7b33995 100644
--- a/apps/desktop/src-tauri/Cargo.toml
+++ b/apps/desktop/src-tauri/Cargo.toml
@@ -15,10 +15,15 @@ tauri-build.workspace = true
 [dependencies]
 tauri.workspace = true
 serde.workspace = true
+serde_json.workspace = true
+thiserror.workspace = true
+liber-session = { path = "../../../crates/liber-session" }
+liber-vault = { path = "../../../crates/liber-vault" }
 
 [dev-dependencies]
-serde_json.workspace = true
 tauri = { workspace = true, features = ["test"] }
+tempfile.workspace = true
+liber-testkit = { path = "../../../crates/liber-testkit" }
 
 [lints.clippy]
 all = { level = "warn", priority = -1 }
````

Create `apps/desktop/src-tauri/tests/settings.rs`:

````rust
//! Settings store (M1b spec §2.3).

use liber_desktop::settings::{
    MAX_RECENT, Settings, SettingsPatch, SettingsStore, Theme, rfc3339_utc,
};
use std::path::Path;

fn store(dir: &Path) -> SettingsStore {
    SettingsStore::load(dir)
}

#[test]
fn missing_file_gives_defaults_and_no_warning() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let (settings, warning) = s.get();
    assert_eq!(settings, Settings::default());
    assert_eq!(settings.version, 1);
    assert_eq!(settings.language, None);
    assert_eq!(settings.theme, Theme::System);
    assert!(settings.rewrite_links && settings.confirm_delete);
    assert!(settings.recent_vaults.is_empty());
    assert!(warning.is_none());
    assert!(
        !dir.path().join("settings.json").exists(),
        "loading writes nothing"
    );
}

#[test]
fn patch_merges_saves_atomically_and_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let saved = s
        .update(SettingsPatch {
            language: Some("es".into()),
            theme: Some(Theme::Dark),
            rewrite_links: Some(false),
            confirm_delete: None,
        })
        .unwrap();
    assert_eq!(saved.language.as_deref(), Some("es"));
    assert_eq!(saved.theme, Theme::Dark);
    assert!(!saved.rewrite_links && saved.confirm_delete);
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(json["language"], "es");
    assert_eq!(json["theme"], "dark");
    assert_eq!(json["rewriteLinks"], false);
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n != "settings.json")
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    assert_eq!(store(dir.path()).get().0, saved);
    // "system" means follow the OS again.
    let back = s
        .update(SettingsPatch {
            language: Some("system".into()),
            ..SettingsPatch::default()
        })
        .unwrap();
    assert_eq!(back.language, None);
}

#[test]
fn corrupt_file_gives_defaults_a_warning_and_a_bad_copy() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("settings.json"), "{ not json").unwrap();
    let s = store(dir.path());
    let (settings, warning) = s.get();
    assert_eq!(settings, Settings::default());
    assert!(warning.unwrap().contains("settings.json"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("settings.json.bad")).unwrap(),
        "{ not json"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("settings.json")).unwrap(),
        "{ not json",
        "the corrupt file is not overwritten until the next save"
    );
}

/// Review Focus: a settings file written by a newer app version keeps the
/// keys and version this build doesn't know about when it saves.
#[test]
fn review_focus_newer_settings_file_keeps_unknown_keys_and_version() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":3,"theme":"light","futureThing":{"a":1},"language":"en"}"#,
    )
    .unwrap();
    let s = store(dir.path());
    let (settings, warning) = s.get();
    assert!(warning.is_none());
    assert_eq!(settings.theme, Theme::Light);
    s.update(SettingsPatch {
        rewrite_links: Some(false),
        ..SettingsPatch::default()
    })
    .unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(json["version"], 3);
    assert_eq!(json["futureThing"]["a"], 1);
    assert_eq!(json["rewriteLinks"], false);
}

#[test]
fn recent_vaults_are_deduplicated_capped_and_flag_missing_folders() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let vaults = tempfile::tempdir().unwrap();
    for i in 0..12 {
        let v = vaults.path().join(format!("v{i}"));
        std::fs::create_dir(&v).unwrap();
        s.push_recent(&v, &format!("v{i}")).unwrap();
    }
    // Re-opening v5 moves it to the front without duplicating it.
    s.push_recent(&vaults.path().join("v5"), "v5").unwrap();
    let recent = s.recent();
    assert_eq!(recent.len(), MAX_RECENT);
    assert_eq!(recent[0].name, "v5");
    assert_eq!(recent.iter().filter(|r| r.name == "v5").count(), 1);
    assert!(recent.iter().all(|r| !r.missing));
    std::fs::remove_dir(vaults.path().join("v11")).unwrap();
    let recent = s.recent();
    assert!(recent.iter().any(|r| r.name == "v11" && r.missing));
    s.forget(&recent.iter().find(|r| r.name == "v11").unwrap().path)
        .unwrap();
    assert!(!s.recent().iter().any(|r| r.name == "v11"));
    assert_eq!(store(dir.path()).recent().len(), MAX_RECENT - 1);
}

#[test]
fn rfc3339_formats_utc_seconds() {
    assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(rfc3339_utc(1_791_820_800), "2026-10-12T16:00:00Z");
}
````

Create `apps/desktop/src-tauri/tests/errors.rs`:

````rust
//! IPC error mapping (M1b spec §2.6).

use liber_desktop::error::{CommandError, ErrorKind};
use liber_session::SessionError;
use liber_vault::{Hash, VaultError};

#[test]
fn errors_serialize_as_kind_and_message() {
    let e = CommandError::new(ErrorKind::NotEmpty, "folder is not empty");
    assert_eq!(
        serde_json::to_value(&e).unwrap(),
        serde_json::json!({ "kind": "notEmpty", "message": "folder is not empty" })
    );
    assert_eq!(
        serde_json::to_value(CommandError::no_vault()).unwrap()["kind"],
        "noVault"
    );
}

#[test]
fn session_and_vault_errors_map_to_kinds() {
    let kind = |e: SessionError| CommandError::from(e).kind;
    assert_eq!(
        kind(SessionError::Vault(VaultError::NotFound("a".into()))),
        ErrorKind::NotFound
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::AlreadyExists("a".into()))),
        ErrorKind::AlreadyExists
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::Conflict {
            path: "a".into(),
            current: Hash::of(b"x")
        })),
        ErrorKind::Conflict
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::OutsideVault("../x".into()))),
        ErrorKind::OutsideVault
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::Watch("w".into()))),
        ErrorKind::Watch
    );
    assert_eq!(
        kind(SessionError::NotIndexed("a".into())),
        ErrorKind::NotFound
    );
    assert_eq!(
        kind(SessionError::InvalidName("a#b".into())),
        ErrorKind::InvalidName
    );
    assert_eq!(
        kind(SessionError::UnsafeRewrite("x".into())),
        ErrorKind::UnsafeRewrite
    );
    let io = std::io::Error::other("disk");
    assert_eq!(
        kind(SessionError::Vault(VaultError::Io {
            path: "a".into(),
            source: io
        })),
        ErrorKind::Io
    );
    assert!(
        CommandError::from(SessionError::InvalidName("a#b".into()))
            .message
            .contains("a#b")
    );
}
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p liber-desktop --test settings --test errors`

Expected: FAIL to compile: "unresolved import `liber_desktop::settings`" and "unresolved import `liber_desktop::error`".

- [ ] **Step 3: Implement**

Create `apps/desktop/src-tauri/src/error.rs`:

````rust
//! The single error type every command returns (M1b spec §2.6), serialized as
//! `{ "kind": "...", "message": "..." }` for the UI to translate.

use liber_session::SessionError;
use liber_vault::VaultError;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    NoVault,
    NotFound,
    AlreadyExists,
    NotEmpty,
    InvalidName,
    Conflict,
    OutsideVault,
    UnsafeRewrite,
    Watch,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub kind: ErrorKind,
    pub message: String,
}

impl CommandError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> CommandError {
        CommandError {
            kind,
            message: message.into(),
        }
    }

    pub fn no_vault() -> CommandError {
        CommandError::new(ErrorKind::NoVault, "no vault is open")
    }
}

impl From<VaultError> for CommandError {
    fn from(e: VaultError) -> CommandError {
        let kind = match &e {
            VaultError::NotFound(_) => ErrorKind::NotFound,
            VaultError::AlreadyExists(_) => ErrorKind::AlreadyExists,
            VaultError::Conflict { .. } => ErrorKind::Conflict,
            VaultError::OutsideVault(_) => ErrorKind::OutsideVault,
            VaultError::Watch(_) => ErrorKind::Watch,
            VaultError::NotUtf8(_) | VaultError::InvalidConfig { .. } | VaultError::Io { .. } => {
                ErrorKind::Io
            }
        };
        CommandError::new(kind, e.to_string())
    }
}

impl From<SessionError> for CommandError {
    fn from(e: SessionError) -> CommandError {
        match e {
            SessionError::Vault(v) => v.into(),
            SessionError::Index(i) => CommandError::new(ErrorKind::Io, i.to_string()),
            SessionError::NotIndexed(p) => {
                CommandError::new(ErrorKind::NotFound, format!("not in the vault: {p}"))
            }
            SessionError::InvalidName(n) => {
                CommandError::new(ErrorKind::InvalidName, format!("invalid name: {n}"))
            }
            SessionError::UnsafeRewrite(m) => CommandError::new(ErrorKind::UnsafeRewrite, m),
        }
    }
}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> CommandError {
        CommandError::new(ErrorKind::Io, e.to_string())
    }
}

pub type CmdResult<T> = Result<T, CommandError>;
````

Create `apps/desktop/src-tauri/src/settings.rs`:

````rust
//! App settings persisted in `<app_config_dir>/settings.json` (M1b spec §2.3).
//! Loading never writes; saving is atomic. Keys written by a newer app version
//! are kept on save.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const SETTINGS_VERSION: u32 = 1;
pub const MAX_RECENT: usize = 10;
const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVault {
    pub path: String,
    pub name: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    /// `None` = follow the OS (Q-I18N-1).
    pub language: Option<String>,
    pub theme: Theme,
    pub rewrite_links: bool,
    pub confirm_delete: bool,
    pub recent_vaults: Vec<RecentVault>,
    /// Keys this build does not know (written by a newer version); kept on save.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            version: SETTINGS_VERSION,
            language: None,
            theme: Theme::System,
            rewrite_links: true,
            confirm_delete: true,
            recent_vaults: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

/// Partial update from the UI. `language: "system"` means follow the OS.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub language: Option<String>,
    pub theme: Option<Theme>,
    pub rewrite_links: Option<bool>,
    pub confirm_delete: Option<bool>,
}

/// A recent vault as shown on the welcome screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVaultDto {
    pub path: String,
    pub name: String,
    pub opened_at: String,
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingsDto {
    pub settings: Settings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

pub struct SettingsStore {
    path: PathBuf,
    inner: Mutex<Settings>,
    warning: Mutex<Option<String>>,
}

impl SettingsStore {
    /// Reads `dir/settings.json`. Missing → defaults. Unreadable or invalid →
    /// defaults, a warning, and a one-time copy at `settings.json.bad`; the bad
    /// file itself is left until the next successful save.
    pub fn load(dir: &Path) -> SettingsStore {
        let path = dir.join(FILE_NAME);
        let (settings, warning) = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Settings>(&text) {
                Ok(s) => (s, None),
                Err(e) => {
                    let bad = dir.join(format!("{FILE_NAME}.bad"));
                    if !bad.exists() {
                        let _ = std::fs::write(&bad, &text);
                    }
                    (
                        Settings::default(),
                        Some(format!(
                            "{FILE_NAME} could not be read ({e}); using defaults"
                        )),
                    )
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Settings::default(), None),
            Err(e) => (
                Settings::default(),
                Some(format!(
                    "{FILE_NAME} could not be read ({e}); using defaults"
                )),
            ),
        };
        SettingsStore {
            path,
            inner: Mutex::new(settings),
            warning: Mutex::new(warning),
        }
    }

    pub fn get(&self) -> (Settings, Option<String>) {
        (
            self.lock().clone(),
            self.warning
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        )
    }

    pub fn dto(&self) -> SettingsDto {
        let (settings, warning) = self.get();
        SettingsDto { settings, warning }
    }

    pub fn update(&self, patch: SettingsPatch) -> std::io::Result<Settings> {
        let mut s = self.lock();
        let mut next = s.clone();
        if let Some(lang) = patch.language {
            next.language = (lang != "system").then_some(lang);
        }
        if let Some(theme) = patch.theme {
            next.theme = theme;
        }
        if let Some(v) = patch.rewrite_links {
            next.rewrite_links = v;
        }
        if let Some(v) = patch.confirm_delete {
            next.confirm_delete = v;
        }
        self.save(&next)?;
        *s = next.clone();
        Ok(next)
    }

    /// Records `root` (canonical) as most recently opened.
    pub fn push_recent(&self, root: &Path, name: &str) -> std::io::Result<()> {
        let mut s = self.lock();
        let mut next = s.clone();
        let path = root.to_string_lossy().into_owned();
        next.recent_vaults.retain(|r| r.path != path);
        next.recent_vaults.insert(
            0,
            RecentVault {
                path,
                name: name.to_string(),
                opened_at: rfc3339_utc(now_secs()),
            },
        );
        next.recent_vaults.truncate(MAX_RECENT);
        self.save(&next)?;
        *s = next;
        Ok(())
    }

    pub fn recent(&self) -> Vec<RecentVaultDto> {
        self.lock()
            .recent_vaults
            .iter()
            .map(|r| RecentVaultDto {
                path: r.path.clone(),
                name: r.name.clone(),
                opened_at: r.opened_at.clone(),
                missing: !Path::new(&r.path).is_dir(),
            })
            .collect()
    }

    pub fn forget(&self, path: &str) -> std::io::Result<()> {
        let mut s = self.lock();
        let mut next = s.clone();
        next.recent_vaults.retain(|r| r.path != path);
        self.save(&next)?;
        *s = next;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Settings> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Atomic write: temp file in the same folder → fsync → rename.
    fn save(&self, settings: &Settings) -> std::io::Result<()> {
        let dir = self.path.parent().expect("settings path has a parent");
        std::fs::create_dir_all(dir)?;
        let mut out = settings.clone();
        out.version = out.version.max(SETTINGS_VERSION);
        let json = serde_json::to_vec_pretty(&out).map_err(std::io::Error::other)?;
        let tmp = dir.join(format!(".{FILE_NAME}.tmp-{}", std::process::id()));
        let result = (|| {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(&json)?;
            f.sync_all()?;
            std::fs::rename(&tmp, &self.path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        } else {
            *self.warning.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        result
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `secs` since the Unix epoch as RFC 3339 UTC (`2026-10-12T16:00:00Z`).
pub fn rfc3339_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}
````

Create `apps/desktop/src-tauri/src/state.rs`:

````rust
//! Per-window app state (M1b spec §2.2).

use crate::error::CommandError;
use crate::settings::SettingsStore;
use liber_session::VaultSession;
use std::sync::{Arc, Mutex};

pub struct AppState {
    session: Mutex<Option<Arc<VaultSession>>>,
    pub settings: SettingsStore,
}

impl AppState {
    pub fn new(settings: SettingsStore) -> AppState {
        AppState {
            session: Mutex::new(None),
            settings,
        }
    }

    /// The open vault, or `noVault`.
    pub fn session(&self) -> Result<Arc<VaultSession>, CommandError> {
        self.slot().clone().ok_or_else(CommandError::no_vault)
    }

    /// Replaces the open vault (dropping the previous session stops its watcher).
    pub fn set_session(&self, session: Option<Arc<VaultSession>>) {
        let old = std::mem::replace(&mut *self.slot(), session);
        if let Some(old) = old {
            old.stop_watching();
        }
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Arc<VaultSession>>> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }
}
````

Modify `apps/desktop/src-tauri/src/lib.rs` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src-tauri/src/lib.rs b/apps/desktop/src-tauri/src/lib.rs
index d3a59f6..a01fd1c 100644
--- a/apps/desktop/src-tauri/src/lib.rs
+++ b/apps/desktop/src-tauri/src/lib.rs
@@ -1,4 +1,7 @@
 pub mod commands;
+pub mod error;
+pub mod settings;
+pub mod state;
 
 /// Registers everything the app exposes to the webview. Shared by `run()` and the
 /// IPC integration tests so the tests exercise the real command registration.
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p liber-desktop --test settings --test errors`

Expected: PASS: errors 2, settings 6 (incl. `review_focus_newer_settings_file_keeps_unknown_keys_and_version`).

- [ ] **Step 5: Format, lint and type checks**

Run: `cargo fmt --all --check && cargo clippy -p liber-desktop --all-targets -- -D warnings`

Expected: clean (no diff, no warnings)

- [ ] **Step 6: Commit**

````bash
git add Cargo.lock apps/desktop/src-tauri
git commit -m "feat(desktop): command error type, settings store and app state (M1b §2.2–2.6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
````

(Implementers: the trailer names the model that actually wrote the commit — M0 ruling.)

---

### Task 3: Desktop commands, events, dialog plugin and permissions

**Requirements:** M1b spec §2.1, §2.4, §2.5, §2.7 · VLT-01, VLT-02, VLT-04, EXP-01..05

**Files:**
- Create: `apps/desktop/src-tauri/src/dto.rs`
- Create: `apps/desktop/src-tauri/src/settings_commands.rs`
- Create: `apps/desktop/src-tauri/src/vault_commands.rs`
- Create: `apps/desktop/src-tauri/tests/commands.rs`
- Modify: `Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/build.rs`
- Modify: `apps/desktop/src-tauri/capabilities/main.json`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/state.rs`
- Modify: `apps/desktop/src-tauri/tests/ipc.rs`
- Modify: `crates/liber-session/src/session.rs`
- Generated by the build (commit them): `apps/desktop/src-tauri/permissions/autogenerated/<command>.toml` for each new command
- Updated by cargo: `Cargo.lock`

**Interfaces:**
- Consumes: Task 2 (`AppState`, `SettingsStore`, `CommandError`, `CmdResult`), Task 1 (`SessionEvent::Warning`), `liber_session::VaultSession` (`open`, `start_watching`, `tree`, `page`, `backlinks`, `create_page`, `create_folder`, `rename`, `trash`, `vault().read/root`).
- Produces: `liber_desktop::AppDirs { config: PathBuf, cache: PathBuf }`; `configure<R>(builder, dirs: Option<AppDirs>)` (tests pass temp dirs; `None` = OS dirs via `setup`); `AppState::new(SettingsStore, cache_dir: PathBuf)` + `pub cache_dir`; `VaultSession::backlinks_into(&VaultPath) -> Result<Vec<LinkRow>>` (links from outside a file/folder into it); commands `vault_open {path}`, `vault_create {path}`, `vault_close`, `vault_tree`, `page_get {path}`, `backlink_count {path}`, `entry_create_page {dir,name}`, `entry_create_folder {parent,name}`, `entry_rename {from,to}`, `entry_trash {path}`, `settings_get`, `settings_set {patch}`, `vaults_recent`, `vaults_forget {path}` with DTOs in `dto.rs` (`VaultInfo`, `IndexReportDto`, `TreeNodeDto {path, kind}`, `PageDto`, `RenameOutcomeDto`); events `vault:progress {done,total}`, `vault:changed {created,modified,removed,renamed}`, `vault:warning {message}` emitted to window `main`; `vault_commands::MAX_PAGE_BYTES = 1 MiB`.

- [ ] **Step 1: Write the failing tests**

`tests/ipc.rs` changes only its `build_app()` to the new `configure(builder, Some(dirs))` signature (temp dirs, so tests never touch your real settings).

Create `apps/desktop/src-tauri/tests/commands.rs`:

````rust
//! M1b commands through the real IPC path: real `generate_context!()` (config +
//! capabilities), real command registration, mock runtime, temp config/cache dirs.

use liber_desktop::AppDirs;
use liber_testkit::{copy_fixture, real_trash_tests_enabled, trashable_fixture};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::test::MockRuntime;
use tauri::{
    App, Listener, WebviewWindow, WebviewWindowBuilder,
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

/// Every command M1b adds (spec §2.4).
const COMMANDS: &[&str] = &[
    "vault_open",
    "vault_create",
    "vault_close",
    "vault_tree",
    "page_get",
    "backlink_count",
    "entry_create_page",
    "entry_create_folder",
    "entry_rename",
    "entry_trash",
    "settings_get",
    "settings_set",
    "vaults_recent",
    "vaults_forget",
];

struct Harness {
    app: App<MockRuntime>,
    main: WebviewWindow<MockRuntime>,
    _config: tempfile::TempDir,
    _cache: tempfile::TempDir,
}

fn harness() -> Harness {
    let config = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let dirs = AppDirs {
        config: config.path().to_path_buf(),
        cache: cache.path().to_path_buf(),
    };
    let app = liber_desktop::configure(mock_builder(), Some(dirs))
        .build(tauri::generate_context!())
        .expect("app builds with the real context");
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    Harness {
        app,
        main,
        _config: config,
        _cache: cache,
    }
}

fn request(cmd: &str, body: Value) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn call(w: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(w, request(cmd, body)).map(|r| r.deserialize::<Value>().unwrap())
}

fn kind(err: Value) -> String {
    err["kind"].as_str().unwrap_or_default().to_string()
}

#[test]
fn m1b_every_command_is_allowed_from_main_and_denied_elsewhere() {
    let h = harness();
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    for cmd in COMMANDS {
        if let Err(e) = call(&h.main, cmd, json!({})) {
            assert!(
                !e.to_string().contains("not allowed"),
                "{cmd} must be allowed from main: {e}"
            );
        }
        let err = call(&other, cmd, json!({})).expect_err(cmd);
        assert!(err.to_string().contains("not allowed"), "{cmd}: {err}");
    }
}

#[test]
fn vlt_01_open_fixture_then_tree_and_page() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    let info = call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    assert_eq!(info["report"]["pages"], 5);
    let name = info["name"].as_str().unwrap();
    assert!(!name.is_empty() && info["root"].as_str().unwrap().ends_with(name));
    let tree = call(&h.main, "vault_tree", json!({})).unwrap();
    let paths: Vec<&str> = tree
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"Welcome.md"));
    assert!(!paths.iter().any(|p| p.starts_with(".obsidian")));
    assert_eq!(
        tree.as_array().unwrap()[0]["kind"],
        "folder",
        "folders come first"
    );
    let page = call(
        &h.main,
        "page_get",
        json!({ "path": "Character Design/rex-draft.md" }),
    )
    .unwrap();
    assert_eq!(page["title"], "Generator Rex");
    assert_eq!(page["subtitle"], "Hero redesign · v3");
    assert_eq!(page["tags"], json!(["character", "redesign"]));
    assert_eq!(page["truncated"], false);
    assert_eq!(page["binary"], false);
    assert!(page["text"].as_str().unwrap().contains("# Generator Rex"));
    assert!(page["links"].as_u64().unwrap() >= 5);
    let sparda = call(
        &h.main,
        "backlink_count",
        json!({ "path": "Character Design/DMC/Sparda.md" }),
    )
    .unwrap();
    assert_eq!(sparda, 4);
    let folder = call(
        &h.main,
        "backlink_count",
        json!({ "path": "Character Design/DMC" }),
    )
    .unwrap();
    assert_eq!(folder, 4, "links from outside the folder into it");
    let recent = call(&h.main, "vaults_recent", json!({})).unwrap();
    assert_eq!(recent.as_array().unwrap().len(), 1);
    assert_eq!(recent[0]["missing"], false);
}

#[test]
fn page_get_truncates_large_pages_and_flags_binary_ones() {
    let h = harness();
    let vault = tempfile::tempdir().unwrap();
    let big = format!("# Big\n\n{}", "é".repeat(600_000)); // 1.2 MB of 2-byte chars
    std::fs::write(vault.path().join("big.md"), &big).unwrap();
    std::fs::write(vault.path().join("latin1.md"), [b'#', b' ', 0xe9, b'\n']).unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let page = call(&h.main, "page_get", json!({ "path": "big.md" })).unwrap();
    assert_eq!(page["truncated"], true);
    let text = page["text"].as_str().unwrap();
    assert!(text.len() <= 1024 * 1024 && text.len() > 1_000_000);
    let bin = call(&h.main, "page_get", json!({ "path": "latin1.md" })).unwrap();
    assert_eq!(bin["binary"], true);
    assert_eq!(bin["text"], "");
    assert_eq!(bin["title"], "latin1");
}

#[test]
fn no_vault_and_traversal_and_missing_are_typed_errors() {
    let h = harness();
    assert_eq!(
        kind(call(&h.main, "vault_tree", json!({})).unwrap_err()),
        "noVault"
    );
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    for bad in ["../outside.md", "/etc/passwd", "a/../../b.md"] {
        assert_eq!(
            kind(call(&h.main, "page_get", json!({ "path": bad })).unwrap_err()),
            "outsideVault",
            "{bad}"
        );
    }
    assert_eq!(
        kind(call(&h.main, "page_get", json!({ "path": "nope.md" })).unwrap_err()),
        "notFound"
    );
    let gone = tempfile::tempdir().unwrap();
    let missing = gone.path().join("not-here");
    assert_eq!(
        kind(call(&h.main, "vault_open", json!({ "path": missing })).unwrap_err()),
        "notFound"
    );
}

#[test]
fn vlt_01_create_requires_an_empty_or_new_folder() {
    let h = harness();
    let parent = tempfile::tempdir().unwrap();
    std::fs::write(parent.path().join("x.md"), "x").unwrap();
    assert_eq!(
        kind(call(&h.main, "vault_create", json!({ "path": parent.path() })).unwrap_err()),
        "notEmpty"
    );
    let only_metadata = parent.path().join("meta");
    std::fs::create_dir(&only_metadata).unwrap();
    std::fs::write(only_metadata.join(".DS_Store"), "x").unwrap();
    call(&h.main, "vault_create", json!({ "path": only_metadata })).unwrap();
    let fresh = parent.path().join("brand new");
    let info = call(&h.main, "vault_create", json!({ "path": fresh })).unwrap();
    assert_eq!(info["name"], "brand new");
    assert!(fresh.is_dir());
    assert!(
        !fresh.join(".liber").exists(),
        "creating writes nothing inside"
    );
}

#[test]
fn exp_02_04_create_rename_and_close() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let page = call(
        &h.main,
        "entry_create_page",
        json!({ "dir": "Game Design", "name": "Untitled" }),
    )
    .unwrap();
    assert_eq!(page, "Game Design/Untitled.md");
    let folder = call(
        &h.main,
        "entry_create_folder",
        json!({ "parent": "", "name": "Inbox" }),
    )
    .unwrap();
    assert_eq!(folder, "Inbox");
    assert_eq!(
        kind(
            call(
                &h.main,
                "entry_create_page",
                json!({ "dir": "", "name": "a#b" })
            )
            .unwrap_err()
        ),
        "invalidName"
    );
    let out = call(
        &h.main,
        "entry_rename",
        json!({ "from": "Character Design/DMC/Sparda.md", "to": "Character Design/DMC/Dante.md" }),
    )
    .unwrap();
    assert_eq!(out["updatedLinks"], 4);
    assert_eq!(out["updatedFiles"].as_array().unwrap().len(), 2);
    assert_eq!(out["failed"], json!([]));
    assert!(
        std::fs::read_to_string(vault.path().join("Character Design/rex-draft.md"))
            .unwrap()
            .contains("[[Dante]]")
    );
    // With rewriting turned off, only the file moves.
    call(
        &h.main,
        "settings_set",
        json!({ "patch": { "rewriteLinks": false } }),
    )
    .unwrap();
    let out = call(
        &h.main,
        "entry_rename",
        json!({ "from": "Character Design/DMC/Dante.md", "to": "Character Design/DMC/Vergil.md" }),
    )
    .unwrap();
    assert_eq!(out["updatedLinks"], 0);
    call(&h.main, "vault_close", json!({})).unwrap();
    assert_eq!(
        kind(call(&h.main, "vault_tree", json!({})).unwrap_err()),
        "noVault"
    );
}

#[test]
fn exp_03_trash_through_ipc() {
    if !real_trash_tests_enabled() {
        return;
    }
    let h = harness();
    let vault = trashable_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    call(&h.main, "entry_trash", json!({ "path": "Welcome.md" })).unwrap();
    assert!(!vault.path().join("Welcome.md").exists());
}

#[test]
fn settings_round_trip_and_recent_vaults_through_ipc() {
    let h = harness();
    let got = call(&h.main, "settings_get", json!({})).unwrap();
    assert_eq!(got["settings"]["theme"], "system");
    assert_eq!(got["settings"]["language"], Value::Null);
    let saved = call(
        &h.main,
        "settings_set",
        json!({ "patch": { "theme": "dark", "language": "es" } }),
    )
    .unwrap();
    assert_eq!(saved["theme"], "dark");
    assert_eq!(saved["language"], "es");
    let vault = copy_fixture("ambiguous-names");
    let info = call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let root = info["root"].as_str().unwrap().to_string();
    call(&h.main, "vaults_forget", json!({ "path": root })).unwrap();
    assert_eq!(
        call(&h.main, "vaults_recent", json!({})).unwrap(),
        json!([])
    );
}

#[test]
fn vlt_04_opening_emits_progress_events() {
    let h = harness();
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    h.app.listen_any("vault:progress", move |e| {
        sink.lock().unwrap().push(e.payload().to_string())
    });
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let got = seen.lock().unwrap().clone();
    assert!(!got.is_empty());
    let last: Value = serde_json::from_str(got.last().unwrap()).unwrap();
    assert_eq!(last["done"], last["total"]);
}
````

Modify `apps/desktop/src-tauri/tests/ipc.rs` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src-tauri/tests/ipc.rs b/apps/desktop/src-tauri/tests/ipc.rs
index a1db095..eb9764b 100644
--- a/apps/desktop/src-tauri/tests/ipc.rs
+++ b/apps/desktop/src-tauri/tests/ipc.rs
@@ -11,7 +11,12 @@ use tauri::{
 };
 
 fn build_app() -> App<MockRuntime> {
-    liber_desktop::configure(mock_builder())
+    // Temp config/cache dirs so tests never read or write the user's settings.
+    let dirs = liber_desktop::AppDirs {
+        config: std::env::temp_dir().join(format!("liber-ipc-cfg-{}", std::process::id())),
+        cache: std::env::temp_dir().join(format!("liber-ipc-cache-{}", std::process::id())),
+    };
+    liber_desktop::configure(mock_builder(), Some(dirs))
         .build(tauri::generate_context!())
         .expect("failed to build app with the real context")
 }
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm build:ui && cargo test -p liber-desktop --test commands --test ipc`

Expected: FAIL to compile: "unresolved import `liber_desktop::AppDirs`" and "this function takes 1 argument but 2 arguments were supplied".

- [ ] **Step 3: Implement**

Building regenerates `apps/desktop/src-tauri/permissions/autogenerated/*.toml` for every new command (commit them, as in M0) and updates `Cargo.lock` (tauri-plugin-dialog 2.8.2). Why `configure` manages the state directly when `dirs` is given: the mock runtime used by the tests does not run `setup` during `build()`.

Modify `Cargo.toml` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/Cargo.toml b/Cargo.toml
index 7a1f911..f3efd2c 100644
--- a/Cargo.toml
+++ b/Cargo.toml
@@ -31,6 +31,7 @@ proptest = "1.12.0"
 tempfile = "3.27.0"
 tauri = "2.12.3"
 tauri-build = "2.7.2"
+tauri-plugin-dialog = "2.8.2"
 
 [workspace.lints.rust]
 unsafe_code = "forbid"
````

Modify `apps/desktop/src-tauri/Cargo.toml` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src-tauri/Cargo.toml b/apps/desktop/src-tauri/Cargo.toml
index 7b33995..0200ade 100644
--- a/apps/desktop/src-tauri/Cargo.toml
+++ b/apps/desktop/src-tauri/Cargo.toml
@@ -14,6 +14,7 @@ tauri-build.workspace = true
 
 [dependencies]
 tauri.workspace = true
+tauri-plugin-dialog.workspace = true
 serde.workspace = true
 serde_json.workspace = true
 thiserror.workspace = true
````

Modify `crates/liber-session/src/session.rs` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/crates/liber-session/src/session.rs b/crates/liber-session/src/session.rs
index da2cd6f..725aec5 100644
--- a/crates/liber-session/src/session.rs
+++ b/crates/liber-session/src/session.rs
@@ -270,6 +270,18 @@ impl VaultSession {
         Ok(self.index().backlinks(path.as_str())?)
     }
 
+    /// Links from outside `path` into it: the file itself, or anything inside
+    /// the folder (delete confirmation, M1b).
+    pub fn backlinks_into(&self, path: &VaultPath) -> Result<Vec<liber_index::LinkRow>> {
+        let prefix = format!("{}/", path.as_str());
+        Ok(self
+            .index()
+            .links_into(path.as_str())?
+            .into_iter()
+            .filter(|l| l.src != path.as_str() && !l.src.starts_with(&prefix))
+            .collect())
+    }
+
     // ---- operations ----
 
     /// Creates an empty page `name` (`.md` appended if missing) in `dir`.
````

Create `apps/desktop/src-tauri/src/dto.rs`:

````rust
//! Serializable shapes returned to the UI (M1b spec §2.4), all camelCase.

use liber_session::{IndexReport, RenameOutcome};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexReportDto {
    pub files: usize,
    pub pages: usize,
    pub parsed: usize,
    pub skipped_unchanged: usize,
    pub removed: usize,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

impl From<&IndexReport> for IndexReportDto {
    fn from(r: &IndexReport) -> IndexReportDto {
        IndexReportDto {
            files: r.files,
            pages: r.pages,
            parsed: r.parsed,
            skipped_unchanged: r.skipped_unchanged,
            removed: r.removed,
            warnings: r.warnings.clone(),
            duration_ms: r.duration.as_millis() as u64,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub name: String,
    pub root: String,
    pub report: IndexReportDto,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeNodeDto {
    pub path: String,
    /// `"page" | "folder" | "attachment"`.
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageDto {
    pub path: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub cover: Option<String>,
    pub tags: Vec<String>,
    pub links: usize,
    pub backlinks: usize,
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcomeDto {
    pub moved: Vec<(String, String)>,
    pub updated_files: Vec<String>,
    pub updated_links: usize,
    pub failed: Vec<(String, String)>,
}

impl From<RenameOutcome> for RenameOutcomeDto {
    fn from(o: RenameOutcome) -> RenameOutcomeDto {
        RenameOutcomeDto {
            moved: o.moved,
            updated_files: o.updated_files,
            updated_links: o.updated_links,
            failed: o.failed,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressPayload {
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangedPayload {
    pub created: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
    pub renamed: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WarningPayload {
    pub message: String,
}
````

Create `apps/desktop/src-tauri/src/vault_commands.rs`:

````rust
//! Vault and explorer commands (M1b spec §2.4). Thin wrappers over
//! `liber-session`; every path from the UI goes through `VaultPath::new`.

use crate::dto::{
    ChangedPayload, PageDto, ProgressPayload, RenameOutcomeDto, TreeNodeDto, VaultInfo,
    WarningPayload,
};
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use liber_session::{SessionEvent, VaultSession};
use liber_vault::VaultPath;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Largest page text sent to the read-only view.
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;

/// Files that may sit in a folder chosen for a new vault (OS metadata).
const OS_METADATA: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// `""` is the vault root; anything else must be a valid vault path.
fn dir_path(s: &str) -> CmdResult<VaultPath> {
    if s.is_empty() {
        Ok(VaultPath::root())
    } else {
        Ok(VaultPath::new(s)?)
    }
}

fn open_session<R: Runtime>(app: &AppHandle<R>, root: &Path) -> CmdResult<VaultInfo> {
    let state = app.state::<AppState>();
    let emitter = app.clone();
    let (session, report) = VaultSession::open(root, &state.cache_dir, move |event| match event {
        SessionEvent::Progress { done, total } => {
            let _ = emitter.emit_to("main", "vault:progress", ProgressPayload { done, total });
        }
        SessionEvent::Changed {
            created,
            modified,
            removed,
            renamed,
        } => {
            let _ = emitter.emit_to(
                "main",
                "vault:changed",
                ChangedPayload {
                    created,
                    modified,
                    removed,
                    renamed,
                },
            );
        }
        SessionEvent::Warning(message) => {
            let _ = emitter.emit_to("main", "vault:warning", WarningPayload { message });
        }
        SessionEvent::Indexed(_) => {}
    })?;
    let session = Arc::new(session);
    session.start_watching()?;
    let root = session.vault().root().to_path_buf();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    state.settings.push_recent(&root, &name)?;
    state.set_session(Some(session));
    Ok(VaultInfo {
        name,
        root: root.to_string_lossy().into_owned(),
        report: (&report).into(),
    })
}

async fn blocking<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    f: impl FnOnce(AppHandle<R>) -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || f(app))
        .await
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))?
}

#[tauri::command]
pub async fn vault_open<R: Runtime>(app: AppHandle<R>, path: PathBuf) -> CmdResult<VaultInfo> {
    blocking(app, move |app| open_session(&app, &path)).await
}

#[tauri::command]
pub async fn vault_create<R: Runtime>(app: AppHandle<R>, path: PathBuf) -> CmdResult<VaultInfo> {
    blocking(app, move |app| {
        if path.exists() {
            let occupied = std::fs::read_dir(&path)?
                .filter_map(|e| e.ok())
                .any(|e| !OS_METADATA.contains(&e.file_name().to_string_lossy().as_ref()));
            if occupied {
                return Err(CommandError::new(
                    ErrorKind::NotEmpty,
                    format!("{} is not empty", path.display()),
                ));
            }
        } else {
            std::fs::create_dir_all(&path)?;
        }
        open_session(&app, &path)
    })
    .await
}

#[tauri::command]
pub fn vault_close(state: State<'_, AppState>) {
    state.set_session(None);
}

#[tauri::command]
pub fn vault_tree(state: State<'_, AppState>) -> CmdResult<Vec<TreeNodeDto>> {
    Ok(state
        .session()?
        .tree()?
        .into_iter()
        .map(|n| TreeNodeDto {
            path: n.path,
            kind: n.kind.as_str(),
        })
        .collect())
}

#[tauri::command]
pub fn page_get(state: State<'_, AppState>, path: String) -> CmdResult<PageDto> {
    let session = state.session()?;
    let vp = VaultPath::new(&path)?;
    let (bytes, _) = session.vault().read(&vp)?;
    let truncated = bytes.len() > MAX_PAGE_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_PAGE_BYTES)];
    let text = match std::str::from_utf8(slice) {
        Ok(t) => Some(t),
        // Cut in the middle of a character at the 1 MiB mark: keep the valid prefix.
        Err(e) if truncated && e.error_len().is_none() => {
            Some(std::str::from_utf8(&slice[..e.valid_up_to()]).expect("valid prefix"))
        }
        Err(_) => None,
    };
    let backlinks = session.backlinks(&vp)?.len();
    match (session.page(&vp)?, text) {
        (Some(page), Some(text)) => Ok(PageDto {
            path: page.path,
            title: page.title,
            subtitle: page.subtitle,
            cover: page.cover,
            tags: page.tags.into_iter().map(|t| t.text).collect(),
            links: page.links.len(),
            backlinks,
            text: text.to_string(),
            truncated,
            binary: false,
        }),
        // Not valid UTF-8: indexed as an attachment; show it as unreadable.
        (_, None) => Ok(PageDto {
            path: vp.to_string(),
            title: vp.stem().to_string(),
            subtitle: None,
            cover: None,
            tags: Vec::new(),
            links: 0,
            backlinks,
            text: String::new(),
            truncated: false,
            binary: true,
        }),
        (None, Some(_)) => Err(CommandError::new(
            ErrorKind::NotFound,
            format!("not a page: {path}"),
        )),
    }
}

#[tauri::command]
pub fn backlink_count(state: State<'_, AppState>, path: String) -> CmdResult<usize> {
    Ok(state
        .session()?
        .backlinks_into(&VaultPath::new(&path)?)?
        .len())
}

#[tauri::command]
pub fn entry_create_page(
    state: State<'_, AppState>,
    dir: String,
    name: String,
) -> CmdResult<String> {
    Ok(state
        .session()?
        .create_page(&dir_path(&dir)?, &name)?
        .to_string())
}

#[tauri::command]
pub fn entry_create_folder(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> CmdResult<String> {
    Ok(state
        .session()?
        .create_folder(&dir_path(&parent)?, &name)?
        .to_string())
}

#[tauri::command]
pub fn entry_rename(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> CmdResult<RenameOutcomeDto> {
    let rewrite = state.settings.get().0.rewrite_links;
    Ok(state
        .session()?
        .rename(&VaultPath::new(&from)?, &VaultPath::new(&to)?, rewrite)?
        .into())
}

#[tauri::command]
pub fn entry_trash(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    Ok(state.session()?.trash(&VaultPath::new(&path)?)?)
}
````

Create `apps/desktop/src-tauri/src/settings_commands.rs`:

````rust
//! Settings and recent-vault commands (M1b spec §2.3–2.4).

use crate::error::CmdResult;
use crate::settings::{RecentVaultDto, Settings, SettingsDto, SettingsPatch};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> SettingsDto {
    state.settings.dto()
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, patch: SettingsPatch) -> CmdResult<Settings> {
    Ok(state.settings.update(patch)?)
}

#[tauri::command]
pub fn vaults_recent(state: State<'_, AppState>) -> Vec<RecentVaultDto> {
    state.settings.recent()
}

#[tauri::command]
pub fn vaults_forget(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    Ok(state.settings.forget(&path)?)
}
````

Modify `apps/desktop/src-tauri/src/state.rs` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src-tauri/src/state.rs b/apps/desktop/src-tauri/src/state.rs
index cc2dfe2..2fbccab 100644
--- a/apps/desktop/src-tauri/src/state.rs
+++ b/apps/desktop/src-tauri/src/state.rs
@@ -3,18 +3,22 @@
 use crate::error::CommandError;
 use crate::settings::SettingsStore;
 use liber_session::VaultSession;
+use std::path::PathBuf;
 use std::sync::{Arc, Mutex};
 
 pub struct AppState {
     session: Mutex<Option<Arc<VaultSession>>>,
     pub settings: SettingsStore,
+    /// OS cache dir; index databases live under `<cache_dir>/liber/…`.
+    pub cache_dir: PathBuf,
 }
 
 impl AppState {
-    pub fn new(settings: SettingsStore) -> AppState {
+    pub fn new(settings: SettingsStore, cache_dir: PathBuf) -> AppState {
         AppState {
             session: Mutex::new(None),
             settings,
+            cache_dir,
         }
     }
````

Modify `apps/desktop/src-tauri/src/lib.rs` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src-tauri/src/lib.rs b/apps/desktop/src-tauri/src/lib.rs
index a01fd1c..d6022e3 100644
--- a/apps/desktop/src-tauri/src/lib.rs
+++ b/apps/desktop/src-tauri/src/lib.rs
@@ -1,16 +1,63 @@
 pub mod commands;
+pub mod dto;
 pub mod error;
 pub mod settings;
+pub mod settings_commands;
 pub mod state;
+pub mod vault_commands;
+
+use settings::SettingsStore;
+use state::AppState;
+use std::path::PathBuf;
+use tauri::Manager;
+
+/// Where settings and the index cache live. `None` in `configure` means the
+/// OS app config/cache dirs for `app.liberlinteum.desktop`; tests pass temp dirs.
+#[derive(Debug, Clone)]
+pub struct AppDirs {
+    pub config: PathBuf,
+    pub cache: PathBuf,
+}
 
 /// Registers everything the app exposes to the webview. Shared by `run()` and the
 /// IPC integration tests so the tests exercise the real command registration.
-pub fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
-    builder.invoke_handler(tauri::generate_handler![commands::app_info])
+pub fn configure<R: tauri::Runtime>(
+    builder: tauri::Builder<R>,
+    dirs: Option<AppDirs>,
+) -> tauri::Builder<R> {
+    let builder = builder.plugin(tauri_plugin_dialog::init());
+    // Known dirs (tests): manage the state up front. Otherwise resolve the OS
+    // dirs once the app exists.
+    let builder = match dirs {
+        Some(dirs) => builder.manage(AppState::new(SettingsStore::load(&dirs.config), dirs.cache)),
+        None => builder.setup(|app| {
+            let config = app.path().app_config_dir()?;
+            let cache = app.path().app_cache_dir()?;
+            app.manage(AppState::new(SettingsStore::load(&config), cache));
+            Ok(())
+        }),
+    };
+    builder.invoke_handler(tauri::generate_handler![
+        commands::app_info,
+        vault_commands::vault_open,
+        vault_commands::vault_create,
+        vault_commands::vault_close,
+        vault_commands::vault_tree,
+        vault_commands::page_get,
+        vault_commands::backlink_count,
+        vault_commands::entry_create_page,
+        vault_commands::entry_create_folder,
+        vault_commands::entry_rename,
+        vault_commands::entry_trash,
+        settings_commands::settings_get,
+        settings_commands::settings_set,
+        settings_commands::vaults_recent,
+        settings_commands::vaults_forget,
+    ])
 }
 
 pub fn run() {
-    configure(tauri::Builder::default())
+    configure(tauri::Builder::default(), None)
         .run(tauri::generate_context!())
         .expect("error while running Liber Linteum");
 }
````

Modify `apps/desktop/src-tauri/build.rs` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src-tauri/build.rs b/apps/desktop/src-tauri/build.rs
index 2425469..6ad5a4b 100644
--- a/apps/desktop/src-tauri/build.rs
+++ b/apps/desktop/src-tauri/build.rs
@@ -1,7 +1,27 @@
+/// Every command the webview may call. Each also needs an `allow-<name>`
+/// permission in `capabilities/main.json` (kebab-case).
+const COMMANDS: &[&str] = &[
+    "app_info",
+    "vault_open",
+    "vault_create",
+    "vault_close",
+    "vault_tree",
+    "page_get",
+    "backlink_count",
+    "entry_create_page",
+    "entry_create_folder",
+    "entry_rename",
+    "entry_trash",
+    "settings_get",
+    "settings_set",
+    "vaults_recent",
+    "vaults_forget",
+];
+
 fn main() {
     tauri_build::try_build(
         tauri_build::Attributes::new()
-            .app_manifest(tauri_build::AppManifest::new().commands(&["app_info"])),
+            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
     )
     .expect("failed to run tauri-build");
 }
````

Modify `apps/desktop/src-tauri/capabilities/main.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src-tauri/capabilities/main.json b/apps/desktop/src-tauri/capabilities/main.json
index 824293e..9a83a5a 100644
--- a/apps/desktop/src-tauri/capabilities/main.json
+++ b/apps/desktop/src-tauri/capabilities/main.json
@@ -1,7 +1,24 @@
 {
   "$schema": "../gen/schemas/desktop-schema.json",
   "identifier": "main",
-  "description": "Main window. Only explicitly listed commands are callable; each milestone adds its own.",
+  "description": "Main window. Only explicitly listed commands are callable; each milestone adds its own. The dialog plugin is limited to the folder picker.",
   "windows": ["main"],
-  "permissions": ["allow-app-info"]
+  "permissions": [
+    "allow-app-info",
+    "allow-vault-open",
+    "allow-vault-create",
+    "allow-vault-close",
+    "allow-vault-tree",
+    "allow-page-get",
+    "allow-backlink-count",
+    "allow-entry-create-page",
+    "allow-entry-create-folder",
+    "allow-entry-rename",
+    "allow-entry-trash",
+    "allow-settings-get",
+    "allow-settings-set",
+    "allow-vaults-recent",
+    "allow-vaults-forget",
+    "dialog:allow-open"
+  ]
 }
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p liber-desktop`

Expected: PASS: unit 2, commands 9, errors 2, ipc 3, settings 6. (`exp_03_trash_through_ipc` prints `skipped: set LIBER_TRASH_TESTS=1 …` and passes locally.)

- [ ] **Step 5: Format, lint and type checks**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo deny check`

Expected: clean; cargo-deny `advisories ok, bans ok, licenses ok, sources ok`

- [ ] **Step 6: Commit**

````bash
git add Cargo.toml Cargo.lock crates/liber-session apps/desktop/src-tauri
git commit -m "feat(desktop): vault, explorer and settings commands with events and permissions (VLT-01, VLT-04, EXP-01..05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
````

(Implementers: the trailer names the model that actually wrote the commit — M0 ruling.)

---

### Task 4: Frontend IPC layer: typed commands, results, events and folder picker

**Requirements:** M1b spec §3.1, §3.2

**Files:**
- Create: `apps/desktop/src/ipc/commands.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/ipc/index.ts`
- Updated by pnpm: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 3 command names, argument names (camelCase) and DTO shapes; events `vault:*`; dialog plugin `plugin:dialog|open`.
- Produces: In `src/ipc/index.ts`: types `ErrorKind`, `CommandError`, `IpcResult<T> = {ok:true,value:T} | {ok:false,error:CommandError}`, `IndexReport`, `VaultInfo`, `NodeKind`, `TreeNode {path, kind}`, `Page`, `RenameOutcome`, `Theme`, `RecentVault`, `Settings`, `SettingsPatch`, `SettingsResponse`, `ProgressPayload`, `ChangedPayload`, `WarningPayload`; `toCommandError(e)`, `ipcCall(fn)`; commands `vaultOpen(path)`, `vaultCreate(path)`, `vaultClose()`, `vaultTree()`, `pageGet(path)`, `backlinkCount(path)`, `entryCreatePage(dir,name)`, `entryCreateFolder(parent,name)`, `entryRename(from,to)`, `entryTrash(path)`, `settingsGet()`, `settingsSet(patch)`, `vaultsRecent()`, `vaultsForget(path)` — all `Promise<IpcResult<…>>`, never throwing; events `onVaultProgress/onVaultChanged/onVaultWarning(cb) -> Promise<UnlistenFn>`; `pickFolder(): Promise<string | null>`; existing `appInfo`, `isTauri` unchanged.

- [ ] **Step 1: Add the frontend dependencies (exact versions verified):**

Run: `pnpm --filter @liber/desktop add zustand@^5.0.15 @dnd-kit/core@^6.3.1 @dnd-kit/utilities@^3.2.2 @tauri-apps/plugin-dialog@^2.8.2`

Expected: `Lockfile passes supply-chain policies`; +6 packages. If pnpm's release-age gate refuses one, add a narrow exact-version entry to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` with a dated comment (M0 convention).

- [ ] **Step 2: Write the failing tests**

Create `apps/desktop/src/ipc/commands.test.ts`:

````ts
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  entryRename,
  ipcCall,
  onVaultChanged,
  onVaultProgress,
  pageGet,
  pickFolder,
  settingsSet,
  toCommandError,
  vaultOpen,
  vaultTree,
} from './index';

afterEach(() => clearMocks());

describe('M1b ipc commands', () => {
  it('passes camelCase arguments and returns ok results', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'vault_open') return { name: 'V', root: '/v', report: { pages: 1 } };
      if (cmd === 'entry_rename')
        return { moved: [], updatedFiles: ['a.md'], updatedLinks: 2, failed: [] };
      if (cmd === 'settings_set') return { theme: 'dark' };
    });
    expect(await vaultOpen('/v')).toEqual({
      ok: true,
      value: { name: 'V', root: '/v', report: { pages: 1 } },
    });
    const renamed = await entryRename('a.md', 'b/a.md');
    expect(renamed.ok && renamed.value.updatedLinks).toBe(2);
    await settingsSet({ theme: 'dark' });
    expect(calls).toEqual([
      ['vault_open', { path: '/v' }],
      ['entry_rename', { from: 'a.md', to: 'b/a.md' }],
      ['settings_set', { patch: { theme: 'dark' } }],
    ]);
  });

  it('turns thrown backend errors into typed results, never exceptions', async () => {
    mockIPC((cmd) => {
      if (cmd === 'vault_tree') throw { kind: 'noVault', message: 'no vault is open' };
      if (cmd === 'page_get') throw 'plain string failure';
    });
    expect(await vaultTree()).toEqual({
      ok: false,
      error: { kind: 'noVault', message: 'no vault is open' },
    });
    expect(await pageGet('x.md')).toEqual({
      ok: false,
      error: { kind: 'io', message: 'plain string failure' },
    });
    expect(await ipcCall(() => Promise.reject(new Error('boom')))).toEqual({
      ok: false,
      error: { kind: 'io', message: 'boom' },
    });
    expect(toCommandError({ kind: 42 })).toEqual({ kind: 'io', message: '[object Object]' });
  });

  it('subscribes to vault events', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true });
    const progress: unknown[] = [];
    const changed: unknown[] = [];
    const un1 = await onVaultProgress((p) => progress.push(p));
    const un2 = await onVaultChanged((c) => changed.push(c));
    await emit('vault:progress', { done: 1, total: 2 });
    await emit('vault:changed', { created: ['a.md'], modified: [], removed: [], renamed: [] });
    expect(progress).toEqual([{ done: 1, total: 2 }]);
    expect(changed).toEqual([{ created: ['a.md'], modified: [], removed: [], renamed: [] }]);
    un1();
    un2();
    await emit('vault:progress', { done: 2, total: 2 });
    expect(progress).toHaveLength(1);
  });

  it('picks a folder through the dialog plugin', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'plugin:dialog|open') return '/Users/ana/Notes';
    });
    expect(await pickFolder()).toBe('/Users/ana/Notes');
    expect(calls[0][0]).toBe('plugin:dialog|open');
    expect((calls[0][1] as { options: { directory: boolean } }).options.directory).toBe(true);
    mockIPC(() => null);
    expect(await pickFolder()).toBeNull();
  });
});
````

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @liber/desktop exec vitest run src/ipc`

Expected: FAIL: `TypeError: vaultOpen is not a function` (and the same for `vaultTree`, `onVaultProgress`, `pickFolder`).

- [ ] **Step 4: Implement**

Modify `apps/desktop/src/ipc/index.ts` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/ipc/index.ts b/apps/desktop/src/ipc/index.ts
index 8837df3..908f87a 100644
--- a/apps/desktop/src/ipc/index.ts
+++ b/apps/desktop/src/ipc/index.ts
@@ -1,6 +1,8 @@
 // The only module allowed to talk to the Rust backend. Every backend
-// capability the UI uses is a typed function here.
+// capability the UI uses is a typed function here (M1b spec §3.2).
 import { invoke, isTauri } from '@tauri-apps/api/core';
+import { listen, type UnlistenFn } from '@tauri-apps/api/event';
+import { open } from '@tauri-apps/plugin-dialog';
 
 export interface AppInfo {
   name: string;
@@ -13,3 +15,179 @@ export function appInfo(): Promise<AppInfo> {
 
 // True when running inside the Tauri webview (false in a plain browser).
 export { isTauri };
+
+// ---- errors ----
+
+export type ErrorKind =
+  | 'noVault'
+  | 'notFound'
+  | 'alreadyExists'
+  | 'notEmpty'
+  | 'invalidName'
+  | 'conflict'
+  | 'outsideVault'
+  | 'unsafeRewrite'
+  | 'watch'
+  | 'io';
+
+export interface CommandError {
+  kind: ErrorKind;
+  message: string;
+}
+
+export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: CommandError };
+
+/** Normalizes anything a rejected IPC call can produce. */
+export function toCommandError(e: unknown): CommandError {
+  if (
+    typeof e === 'object' &&
+    e !== null &&
+    typeof (e as CommandError).kind === 'string' &&
+    typeof (e as CommandError).message === 'string'
+  ) {
+    return { kind: (e as CommandError).kind, message: (e as CommandError).message };
+  }
+  if (typeof e === 'string') return { kind: 'io', message: e };
+  if (e instanceof Error) return { kind: 'io', message: e.message };
+  return { kind: 'io', message: String(e) };
+}
+
+/** Runs an IPC call; callers never see a thrown error. */
+export async function ipcCall<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
+  try {
+    return { ok: true, value: await fn() };
+  } catch (e) {
+    return { ok: false, error: toCommandError(e) };
+  }
+}
+
+// ---- payloads (mirror src-tauri/src/dto.rs and settings.rs) ----
+
+export interface IndexReport {
+  files: number;
+  pages: number;
+  parsed: number;
+  skippedUnchanged: number;
+  removed: number;
+  warnings: string[];
+  durationMs: number;
+}
+
+export interface VaultInfo {
+  name: string;
+  root: string;
+  report: IndexReport;
+}
+
+export type NodeKind = 'page' | 'folder' | 'attachment';
+
+export interface TreeNode {
+  path: string;
+  kind: NodeKind;
+}
+
+export interface Page {
+  path: string;
+  title: string;
+  subtitle: string | null;
+  cover: string | null;
+  tags: string[];
+  links: number;
+  backlinks: number;
+  text: string;
+  truncated: boolean;
+  binary: boolean;
+}
+
+export interface RenameOutcome {
+  moved: [string, string][];
+  updatedFiles: string[];
+  updatedLinks: number;
+  failed: [string, string][];
+}
+
+export type Theme = 'system' | 'light' | 'dark';
+
+export interface RecentVault {
+  path: string;
+  name: string;
+  openedAt: string;
+  missing: boolean;
+}
+
+export interface Settings {
+  version: number;
+  /** `null` = follow the OS. */
+  language: string | null;
+  theme: Theme;
+  rewriteLinks: boolean;
+  confirmDelete: boolean;
+}
+
+/** `language: 'system'` means follow the OS again. */
+export interface SettingsPatch {
+  language?: string;
+  theme?: Theme;
+  rewriteLinks?: boolean;
+  confirmDelete?: boolean;
+}
+
+export interface SettingsResponse {
+  settings: Settings;
+  warning?: string;
+}
+
+export interface ProgressPayload {
+  done: number;
+  total: number;
+}
+
+export interface ChangedPayload {
+  created: string[];
+  modified: string[];
+  removed: string[];
+  renamed: [string, string][];
+}
+
+export interface WarningPayload {
+  message: string;
+}
+
+// ---- commands ----
+
+const call = <T>(cmd: string, args?: Record<string, unknown>) =>
+  ipcCall(() => invoke<T>(cmd, args));
+
+export const vaultOpen = (path: string) => call<VaultInfo>('vault_open', { path });
+export const vaultCreate = (path: string) => call<VaultInfo>('vault_create', { path });
+export const vaultClose = () => call<void>('vault_close');
+export const vaultTree = () => call<TreeNode[]>('vault_tree');
+export const pageGet = (path: string) => call<Page>('page_get', { path });
+export const backlinkCount = (path: string) => call<number>('backlink_count', { path });
+export const entryCreatePage = (dir: string, name: string) =>
+  call<string>('entry_create_page', { dir, name });
+export const entryCreateFolder = (parent: string, name: string) =>
+  call<string>('entry_create_folder', { parent, name });
+export const entryRename = (from: string, to: string) =>
+  call<RenameOutcome>('entry_rename', { from, to });
+export const entryTrash = (path: string) => call<void>('entry_trash', { path });
+export const settingsGet = () => call<SettingsResponse>('settings_get');
+export const settingsSet = (patch: SettingsPatch) => call<Settings>('settings_set', { patch });
+export const vaultsRecent = () => call<RecentVault[]>('vaults_recent');
+export const vaultsForget = (path: string) => call<void>('vaults_forget', { path });
+
+// ---- events ----
+
+export const onVaultProgress = (cb: (p: ProgressPayload) => void): Promise<UnlistenFn> =>
+  listen<ProgressPayload>('vault:progress', (e) => cb(e.payload));
+export const onVaultChanged = (cb: (p: ChangedPayload) => void): Promise<UnlistenFn> =>
+  listen<ChangedPayload>('vault:changed', (e) => cb(e.payload));
+export const onVaultWarning = (cb: (p: WarningPayload) => void): Promise<UnlistenFn> =>
+  listen<WarningPayload>('vault:warning', (e) => cb(e.payload));
+
+// ---- native folder picker (dialog plugin, folder selection only) ----
+
+export async function pickFolder(): Promise<string | null> {
+  const picked = await open({ directory: true, multiple: false });
+  return typeof picked === 'string' ? picked : null;
+}
````

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @liber/desktop exec vitest run src/ipc`

Expected: PASS: 5 tests.

- [ ] **Step 6: Format, lint and type checks**

Run: `pnpm lint && pnpm typecheck && pnpm test`

Expected: clean; 61 tests

- [ ] **Step 7: Commit**

````bash
git add pnpm-lock.yaml apps/desktop/package.json apps/desktop/src/ipc
git commit -m "feat(ui): typed IPC layer for vault, explorer, settings, events and folder picker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
````

(Implementers: the trailer names the model that actually wrote the commit — M0 ruling.)

---

### Task 5: Stores: settings, vault, page, toasts, ui (+ tree helpers)

**Requirements:** M1b spec §3.3, §4 · VLT-01, VLT-04, EXP-02..05

**Files:**
- Create: `apps/desktop/src/ipc/testing.ts`
- Create: `apps/desktop/src/stores/messages.ts`
- Create: `apps/desktop/src/stores/pageStore.ts`
- Create: `apps/desktop/src/stores/settingsStore.ts`
- Create: `apps/desktop/src/stores/stores.test.ts`
- Create: `apps/desktop/src/stores/toastStore.ts`
- Create: `apps/desktop/src/stores/tree.test.ts`
- Create: `apps/desktop/src/stores/tree.ts`
- Create: `apps/desktop/src/stores/uiStore.ts`
- Create: `apps/desktop/src/stores/vaultStore.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`

**Interfaces:**
- Consumes: Task 4 IPC functions and types; `applyTheme` (M0), `detectLanguage` (M0), i18next.
- Produces: `src/stores/tree.ts`: `parentOf`, `nameOf`, `joinPath`, `childrenByParent(nodes) -> Map<string, TreeNode[]>`, `nextFreeName(nodes, dir, base, ext)`, `remap(path, from, to) -> string | null`; `messages.ts`: `errorMessage(e)`; `toastStore`: `useToastStore {toasts, push({message, detail?, tone?}) -> id, dismiss(id), clear()}`, `TOAST_MS = 5000` (detail toasts persist); `uiStore`: `DialogState = {type:'move'|'delete', path} | {type:'settings'} | null`, `useUiStore {dialog, openDialog, closeDialog}`; `settingsStore`: `DEFAULT_SETTINGS`, `useSettingsStore {settings, warning, loaded, load(), update(patch)}`; `pageStore`: `usePageStore {path, page, state:'empty'|'loading'|'ready'|'deleted', load(path), clear(), follow(from,to), onExternalChange(c)}`; `vaultStore`: `COALESCE_MS = 100`, `useVaultStore {status:'closed'|'opening'|'open', progress, info, nodes, children, expanded:Set, selected, renaming, open(path), create(path), close(), refreshTree(), select(path|null), toggle(path), expand(path), startRename(path|null), createPage(dir), createFolder(dir), rename(from,to), trash(path)}`, `resetVaultStore()` (tests); `src/ipc/testing.ts` re-exports `emit`, `mockIPC`, `clearMocks` for tests outside `src/ipc/` (lint ban).

- [ ] **Step 1: Write the failing tests**

`src/ipc/testing.ts` is a two-line test helper module; it lives in `src/ipc/` because only that folder may import `@tauri-apps/*`.

Create `apps/desktop/src/stores/tree.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../ipc';
import { childrenByParent, joinPath, nameOf, nextFreeName, parentOf, remap } from './tree';

const nodes: TreeNode[] = [
  { path: 'Projects', kind: 'folder' },
  { path: 'Untitled.md', kind: 'page' },
  { path: 'untitled 1.md', kind: 'page' },
  { path: 'Projects/Untitled', kind: 'folder' },
  { path: 'Projects/a.md', kind: 'page' },
];

describe('tree helpers', () => {
  it('splits and joins vault paths', () => {
    expect(parentOf('a/b/c.md')).toBe('a/b');
    expect(parentOf('c.md')).toBe('');
    expect(nameOf('a/b/c.md')).toBe('c.md');
    expect(joinPath('', 'x.md')).toBe('x.md');
    expect(joinPath('a', 'x.md')).toBe('a/x.md');
  });

  it('groups children by parent, keeping backend order', () => {
    const map = childrenByParent(nodes);
    expect(map.get('')?.map((n) => n.path)).toEqual(['Projects', 'Untitled.md', 'untitled 1.md']);
    expect(map.get('Projects')?.map((n) => n.path)).toEqual(['Projects/Untitled', 'Projects/a.md']);
  });

  it('EXP-02 proposes the first free Untitled name (case-insensitive)', () => {
    expect(nextFreeName(nodes, '', 'Untitled', '.md')).toBe('Untitled 2');
    expect(nextFreeName(nodes, 'Projects', 'Untitled', '.md')).toBe('Untitled');
    expect(nextFreeName(nodes, 'Projects', 'Untitled', '')).toBe('Untitled 1');
    expect(nextFreeName(nodes, 'Empty', 'Untitled', '')).toBe('Untitled');
  });

  it('remaps paths through a rename of a file or folder', () => {
    expect(remap('a/b.md', 'a/b.md', 'c/b.md')).toBe('c/b.md');
    expect(remap('a/b/c.md', 'a/b', 'x')).toBe('x/c.md');
    expect(remap('a/bc.md', 'a/b', 'x')).toBeNull();
    expect(remap('z.md', 'a', 'b')).toBeNull();
  });
});
````

Create `apps/desktop/src/stores/stores.test.ts`:

````ts
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../ipc';
import { clearMocks, emit, mockIPC } from '../ipc/testing';
import { usePageStore } from './pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';
import { useToastStore } from './toastStore';
import { resetVaultStore, useVaultStore } from './vaultStore';

type Handler = (args: Record<string, unknown>) => unknown;

/** A scriptable fake backend for mockIPC. */
function backend(handlers: Record<string, Handler>) {
  const calls: string[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push(cmd);
      const h = handlers[cmd];
      if (!h) return undefined;
      return h((args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

const info = { name: 'V', root: '/v', report: { pages: 2, warnings: [] } };
const tree: TreeNode[] = [
  { path: 'A', kind: 'folder' },
  { path: 'A/one.md', kind: 'page' },
  { path: 'A/two.md', kind: 'page' },
  { path: 'b.md', kind: 'page' },
];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  usePageStore.getState().clear();
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, warning: null, loaded: false });
});

afterEach(async () => {
  await resetVaultStore();
  vi.useRealTimers();
  clearMocks();
});

describe('settingsStore', () => {
  it('loads before first render and applies theme and language', async () => {
    backend({
      settings_get: () => ({
        settings: { ...DEFAULT_SETTINGS, theme: 'dark', language: 'es' },
      }),
    });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().loaded).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(i18next.language).toBe('es');
  });

  it('falls back to defaults outside Tauri / on error', async () => {
    backend({
      settings_get: () => {
        throw { kind: 'io', message: 'x' };
      },
    });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('update saves and re-applies', async () => {
    backend({ settings_set: (a) => ({ ...DEFAULT_SETTINGS, ...(a.patch as object) }) });
    await useSettingsStore.getState().update({ theme: 'light' });
    expect(useSettingsStore.getState().settings.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('vaultStore', () => {
  it('VLT-01 open: closed → opening → open, with tree loaded', async () => {
    const gate = deferred<typeof info>();
    backend({ vault_open: () => gate.promise, vault_tree: () => tree });
    const opening = useVaultStore.getState().open('/v');
    expect(useVaultStore.getState().status).toBe('opening');
    gate.resolve(info);
    await opening;
    const s = useVaultStore.getState();
    expect(s.status).toBe('open');
    expect(s.info?.name).toBe('V');
    expect(s.nodes).toEqual(tree);
  });

  it('open failure returns to closed with a translated toast', async () => {
    backend({
      vault_open: () => {
        throw { kind: 'notFound', message: 'gone' };
      },
    });
    const res = await useVaultStore.getState().open('/gone');
    expect(res.ok).toBe(false);
    expect(useVaultStore.getState().status).toBe('closed');
    expect(useToastStore.getState().toasts[0].message).toBe('Not found.');
  });

  it('open with index warnings shows one toast with details', async () => {
    backend({
      vault_open: () => ({ ...info, report: { pages: 1, warnings: ['bad.md: x', 'locked: y'] } }),
      vault_tree: () => tree,
    });
    await useVaultStore.getState().open('/v');
    const t = useToastStore.getState().toasts[0];
    expect(t.message).toBe('Opened with 2 warnings');
    expect(t.detail).toEqual(['bad.md: x', 'locked: y']);
  });

  /** Review Focus: a slow, older tree response must not overwrite a newer one. */
  it('review_focus stale tree responses are ignored', async () => {
    const first = deferred<TreeNode[]>();
    let n = 0;
    backend({
      vault_open: () => info,
      vault_tree: () => (++n === 2 ? first.promise : n === 3 ? [tree[3]] : tree),
    });
    await useVaultStore.getState().open('/v');
    const slow = useVaultStore.getState().refreshTree();
    await useVaultStore.getState().refreshTree();
    first.resolve(tree);
    await slow;
    expect(useVaultStore.getState().nodes).toEqual([tree[3]]);
  });

  it('EXP-04 rename refreshes, follows selection and reports link updates', async () => {
    let renamed = false;
    backend({
      vault_open: () => info,
      vault_tree: () =>
        renamed ? [tree[0], { path: 'A/uno.md', kind: 'page' }, tree[2], tree[3]] : tree,
      entry_rename: () => {
        renamed = true;
        return {
          moved: [['A/one.md', 'A/uno.md']],
          updatedFiles: ['b.md', 'A/two.md'],
          updatedLinks: 3,
          failed: [],
        };
      },
      page_get: (a) => ({ path: a.path, title: 'T', tags: [], text: '', links: 0, backlinks: 0 }),
    });
    await useVaultStore.getState().open('/v');
    useVaultStore.getState().select('A/one.md');
    await usePageStore.getState().load('A/one.md');
    await useVaultStore.getState().rename('A/one.md', 'A/uno.md');
    expect(useVaultStore.getState().selected).toBe('A/uno.md');
    expect(usePageStore.getState().path).toBe('A/uno.md');
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Updated links in 2 files');
  });

  it('rename with failures shows a persistent detail toast', async () => {
    backend({
      vault_open: () => info,
      vault_tree: () => tree,
      entry_rename: () => ({
        moved: [],
        updatedFiles: [],
        updatedLinks: 0,
        failed: [['b.md', 'symlinked note']],
      }),
    });
    await useVaultStore.getState().open('/v');
    await useVaultStore.getState().rename('A/one.md', 'A/x.md');
    const t = useToastStore.getState().toasts.at(-1)!;
    expect(t.message).toBe("Renamed. 1 file couldn't be updated");
    expect(t.detail).toEqual(['b.md — symlinked note']);
  });

  it('EXP-03 trash moves selection to the next sibling, then the parent', async () => {
    let current = tree;
    backend({
      vault_open: () => info,
      vault_tree: () => current,
      entry_trash: (a) => {
        current = current.filter((n) => n.path !== a.path);
      },
    });
    await useVaultStore.getState().open('/v');
    useVaultStore.getState().select('A/one.md');
    await useVaultStore.getState().trash('A/one.md');
    expect(useVaultStore.getState().selected).toBe('A/two.md');
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Moved to Trash');
    await useVaultStore.getState().trash('A/two.md');
    expect(useVaultStore.getState().selected).toBe('A');
  });

  it('EXP-02 create page picks a free name, selects it and starts inline rename', async () => {
    let current = tree;
    backend({
      vault_open: () => info,
      vault_tree: () => current,
      entry_create_page: (a) => {
        const path = `${a.dir}/${a.name}.md`;
        current = [...current, { path, kind: 'page' }];
        return path;
      },
    });
    await useVaultStore.getState().open('/v');
    const res = await useVaultStore.getState().createPage('A');
    expect(res.ok && res.value).toBe('A/Untitled.md');
    const s = useVaultStore.getState();
    expect(s.selected).toBe('A/Untitled.md');
    expect(s.expanded.has('A')).toBe(true);
    expect(s.renaming).toBe('A/Untitled.md');
  });

  it('VLT-04 external changes are coalesced into one tree refresh', async () => {
    vi.useFakeTimers();
    const calls = backend({ vault_open: () => info, vault_tree: () => tree });
    await useVaultStore.getState().open('/v');
    const before = calls.filter((c) => c === 'vault_tree').length;
    for (let i = 0; i < 3; i++) {
      await emit('vault:changed', {
        created: [`n${i}.md`],
        modified: [],
        removed: [],
        renamed: [],
      });
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(calls.filter((c) => c === 'vault_tree').length).toBe(before);
    await vi.advanceTimersByTimeAsync(5);
    expect(calls.filter((c) => c === 'vault_tree').length).toBe(before + 1);
  });

  it('VLT-04 an external rename of the selected page moves the selection', async () => {
    vi.useFakeTimers();
    let current = tree;
    backend({ vault_open: () => info, vault_tree: () => current });
    await useVaultStore.getState().open('/v');
    useVaultStore.getState().select('A/one.md');
    current = [tree[0], { path: 'A/1.md', kind: 'page' }, tree[2], tree[3]];
    await emit('vault:changed', {
      created: [],
      modified: [],
      removed: [],
      renamed: [['A/one.md', 'A/1.md']],
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(useVaultStore.getState().selected).toBe('A/1.md');
  });

  /** Review Focus: the selected item's parent folder is deleted outside the app. */
  it('review_focus selection falls back to the nearest existing ancestor', async () => {
    vi.useFakeTimers();
    let current: TreeNode[] = [
      { path: 'X', kind: 'folder' },
      { path: 'X/Y', kind: 'folder' },
      { path: 'X/Y/z.md', kind: 'page' },
    ];
    backend({ vault_open: () => info, vault_tree: () => current });
    await useVaultStore.getState().open('/v');
    useVaultStore.getState().select('X/Y/z.md');
    useVaultStore.getState().toggle('X/Y');
    current = [{ path: 'X', kind: 'folder' }];
    await emit('vault:changed', { created: [], modified: [], removed: ['X/Y'], renamed: [] });
    await vi.advanceTimersByTimeAsync(150);
    const s = useVaultStore.getState();
    expect(s.selected).toBe('X');
    expect(s.expanded.has('X/Y')).toBe(false);
  });

  it('vault warnings become toasts; close resets everything', async () => {
    backend({ vault_open: () => info, vault_tree: () => tree, vault_close: () => undefined });
    await useVaultStore.getState().open('/v');
    await emit('vault:warning', { message: 'locked: not readable' });
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('locked: not readable');
    await useVaultStore.getState().close();
    const s = useVaultStore.getState();
    expect(s.status).toBe('closed');
    expect(s.nodes).toEqual([]);
    expect(s.selected).toBeNull();
  });
});

describe('pageStore', () => {
  it('EXP-05 loads a page and reacts to external modify, rename and delete', async () => {
    let title = 'One';
    backend({
      page_get: (a) => ({ path: a.path, title, tags: [], text: 'x', links: 0, backlinks: 0 }),
    });
    await usePageStore.getState().load('A/one.md');
    expect(usePageStore.getState().state).toBe('ready');
    title = 'Changed';
    await usePageStore
      .getState()
      .onExternalChange({ created: [], modified: ['A/one.md'], removed: [], renamed: [] });
    expect(usePageStore.getState().page?.title).toBe('Changed');
    await usePageStore.getState().onExternalChange({
      created: [],
      modified: [],
      removed: [],
      renamed: [['A/one.md', 'A/1.md']],
    });
    expect(usePageStore.getState().path).toBe('A/1.md');
    await usePageStore
      .getState()
      .onExternalChange({ created: [], modified: [], removed: ['A'], renamed: [] });
    expect(usePageStore.getState().state).toBe('deleted');
  });
});

describe('toastStore', () => {
  it('auto-dismisses after 5 s unless the toast has details', async () => {
    vi.useFakeTimers();
    useToastStore.getState().push({ message: 'short' });
    useToastStore.getState().push({ message: 'long', detail: ['a'] });
    await vi.advanceTimersByTimeAsync(5001);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['long']);
  });
});
````

Create `apps/desktop/src/ipc/testing.ts`:

````ts
// Test-only helpers. Tests outside src/ipc/ import Tauri's event/mock helpers
// from here, so the "backend only through src/ipc/" lint rule stays strict.
export { emit } from '@tauri-apps/api/event';
export { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @liber/desktop exec vitest run src/stores`

Expected: FAIL: `Failed to resolve import "./pageStore"` and `Failed to resolve import "./tree"`.

- [ ] **Step 3: Implement**

`safeUnlisten` exists because an unsubscribe can reject after the event runtime is gone (plain browser, test teardown); unsubscribing must never throw.

Create `apps/desktop/src/stores/tree.ts`:

````ts
// Pure helpers over the flat explorer node list (vault-relative `/` paths).
import type { TreeNode } from '../ipc';

export const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** Children per parent path (`''` = vault root), in backend order. */
export function childrenByParent(nodes: TreeNode[]): Map<string, TreeNode[]> {
  const map = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    const parent = parentOf(node.path);
    const list = map.get(parent);
    if (list) list.push(node);
    else map.set(parent, [node]);
  }
  return map;
}

/** First of `base`, `base 1`, `base 2`, … not taken in `dir` (case-insensitive). */
export function nextFreeName(nodes: TreeNode[], dir: string, base: string, ext: string): string {
  const taken = new Set(
    nodes.filter((n) => parentOf(n.path) === dir).map((n) => nameOf(n.path).toLowerCase()),
  );
  for (let i = 0; ; i++) {
    const name = i === 0 ? base : `${base} ${i}`;
    if (!taken.has(`${name}${ext}`.toLowerCase())) return name;
  }
}

/** `path` after `from` was renamed to `to` (file or folder), or `null` if unaffected. */
export function remap(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}
````

Create `apps/desktop/src/stores/messages.ts`:

````ts
import i18next from 'i18next';
import type { CommandError } from '../ipc';

/** Translated message for a backend error (`errors.<kind>`). */
export const errorMessage = (e: CommandError): string =>
  i18next.t(`errors.${e.kind}`, { message: e.message });
````

Create `apps/desktop/src/stores/toastStore.ts`:

````ts
import { create } from 'zustand';

export const TOAST_MS = 5000;

export interface Toast {
  id: number;
  message: string;
  /** Extra lines (e.g. files that couldn't be updated); such toasts stay until dismissed. */
  detail?: string[];
  tone: 'info' | 'error';
}

interface ToastState {
  toasts: Toast[];
  push: (t: { message: string; detail?: string[]; tone?: Toast['tone'] }) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ message, detail, tone = 'info' }) => {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, message, detail, tone }] });
    if (!detail?.length) setTimeout(() => get().dismiss(id), TOAST_MS);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  clear: () => set({ toasts: [] }),
}));
````

Create `apps/desktop/src/stores/uiStore.ts`:

````ts
import { create } from 'zustand';

export type DialogState =
  { type: 'move'; path: string } | { type: 'delete'; path: string } | { type: 'settings' } | null;

interface UiState {
  dialog: DialogState;
  openDialog: (d: Exclude<DialogState, null>) => void;
  closeDialog: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
}));
````

Create `apps/desktop/src/stores/settingsStore.ts`:

````ts
import i18next from 'i18next';
import { create } from 'zustand';
import { detectLanguage } from '../i18n';
import {
  settingsGet,
  settingsSet,
  type IpcResult,
  type Settings,
  type SettingsPatch,
} from '../ipc';
import { applyTheme } from '../theme/theme';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  language: null,
  theme: 'system',
  rewriteLinks: true,
  confirmDelete: true,
};

interface SettingsState {
  settings: Settings;
  warning: string | null;
  loaded: boolean;
  /** Called before the first render (main.tsx). */
  load: () => Promise<void>;
  update: (patch: SettingsPatch) => Promise<IpcResult<Settings>>;
}

async function apply(s: Settings) {
  applyTheme(s.theme);
  const lang = s.language ?? detectLanguage(navigator.languages);
  if (i18next.language !== lang) await i18next.changeLanguage(lang);
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  warning: null,
  loaded: false,
  load: async () => {
    const res = await settingsGet();
    // Outside Tauri (plain browser) or on error: defaults.
    const settings = res.ok ? { ...DEFAULT_SETTINGS, ...res.value.settings } : DEFAULT_SETTINGS;
    await apply(settings);
    set({ settings, warning: res.ok ? (res.value.warning ?? null) : null, loaded: true });
  },
  update: async (patch) => {
    const res = await settingsSet(patch);
    if (res.ok) {
      const settings = { ...DEFAULT_SETTINGS, ...res.value };
      await apply(settings);
      set({ settings });
    }
    return res;
  },
}));
````

Create `apps/desktop/src/stores/pageStore.ts`:

````ts
import { create } from 'zustand';
import { pageGet, type ChangedPayload, type Page } from '../ipc';
import { errorMessage } from './messages';
import { useToastStore } from './toastStore';
import { remap } from './tree';

export type PageViewState = 'empty' | 'loading' | 'ready' | 'deleted';

interface PageState {
  path: string | null;
  page: Page | null;
  state: PageViewState;
  load: (path: string) => Promise<void>;
  clear: () => void;
  /** Follows renames of the open page (own or external). */
  follow: (from: string, to: string) => Promise<void>;
  onExternalChange: (c: ChangedPayload) => Promise<void>;
}

let seq = 0;

export const usePageStore = create<PageState>((set, get) => ({
  path: null,
  page: null,
  state: 'empty',
  load: async (path) => {
    const mine = ++seq;
    set({ path, state: get().path === path && get().page ? get().state : 'loading' });
    const res = await pageGet(path);
    if (mine !== seq) return; // a newer load won
    if (res.ok) set({ page: res.value, state: 'ready' });
    else if (res.error.kind === 'notFound') set({ page: null, state: 'deleted' });
    else {
      set({ page: null, path: null, state: 'empty' });
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    }
  },
  clear: () => {
    seq++;
    set({ path: null, page: null, state: 'empty' });
  },
  follow: async (from, to) => {
    const path = get().path;
    const next = path ? remap(path, from, to) : null;
    if (next) await get().load(next);
  },
  onExternalChange: async (c) => {
    const path = get().path;
    if (!path) return;
    for (const [from, to] of c.renamed) {
      if (remap(path, from, to)) return get().follow(from, to);
    }
    if (c.removed.some((r) => remap(path, r, r) !== null)) {
      seq++;
      set({ state: 'deleted' });
      return;
    }
    if (c.modified.includes(path)) await get().load(path);
  },
}));
````

Create `apps/desktop/src/stores/vaultStore.ts`:

````ts
import i18next from 'i18next';
import { create } from 'zustand';
import {
  entryCreateFolder,
  entryCreatePage,
  entryRename,
  entryTrash,
  onVaultChanged,
  onVaultProgress,
  onVaultWarning,
  vaultClose,
  vaultCreate,
  vaultOpen,
  vaultTree,
  type ChangedPayload,
  type IpcResult,
  type ProgressPayload,
  type RenameOutcome,
  type TreeNode,
  type VaultInfo,
} from '../ipc';
import { errorMessage } from './messages';
import { usePageStore } from './pageStore';
import { useToastStore } from './toastStore';
import { childrenByParent, joinPath, nextFreeName, parentOf, remap } from './tree';

/** External changes arriving within this window trigger one tree refresh. */
export const COALESCE_MS = 100;

export type VaultStatus = 'closed' | 'opening' | 'open';

interface VaultState {
  status: VaultStatus;
  progress: ProgressPayload | null;
  info: VaultInfo | null;
  nodes: TreeNode[];
  children: Map<string, TreeNode[]>;
  expanded: Set<string>;
  selected: string | null;
  /** Path currently in inline-rename mode. */
  renaming: string | null;
  open: (path: string) => Promise<IpcResult<VaultInfo>>;
  create: (path: string) => Promise<IpcResult<VaultInfo>>;
  close: () => Promise<void>;
  refreshTree: () => Promise<void>;
  select: (path: string | null) => void;
  toggle: (path: string) => void;
  expand: (path: string) => void;
  startRename: (path: string | null) => void;
  createPage: (dir: string) => Promise<IpcResult<string>>;
  createFolder: (dir: string) => Promise<IpcResult<string>>;
  rename: (from: string, to: string) => Promise<IpcResult<RenameOutcome>>;
  trash: (path: string) => Promise<IpcResult<void>>;
}

const toast = () => useToastStore.getState();
let treeSeq = 0;
let unlisten: (() => void)[] = [];
let pending: ChangedPayload | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const EMPTY = {
  status: 'closed' as VaultStatus,
  progress: null,
  info: null,
  nodes: [] as TreeNode[],
  children: new Map<string, TreeNode[]>(),
  expanded: new Set<string>(),
  selected: null,
  renaming: null,
};

/** Unsubscribes without ever throwing (the event runtime may already be gone). */
function safeUnlisten(u: () => unknown) {
  try {
    void Promise.resolve(u()).catch(() => undefined);
  } catch {
    // already unsubscribed / no Tauri runtime
  }
}

function stopListening() {
  unlisten.forEach(safeUnlisten);
  unlisten = [];
  if (timer) clearTimeout(timer);
  timer = null;
  pending = null;
}

/** Test helper: back to a closed vault with no listeners. */
export async function resetVaultStore() {
  stopListening();
  treeSeq++;
  useVaultStore.setState({ ...EMPTY, children: new Map(), expanded: new Set() });
}

export const useVaultStore = create<VaultState>((set, get) => {
  async function flushChanges() {
    timer = null;
    const change = pending;
    pending = null;
    if (!change) return;
    let { selected, expanded } = get();
    for (const [from, to] of change.renamed) {
      selected = selected ? (remap(selected, from, to) ?? selected) : selected;
      expanded = new Set([...expanded].map((p) => remap(p, from, to) ?? p));
    }
    set({ selected, expanded });
    await get().refreshTree();
    await usePageStore.getState().onExternalChange(change);
  }

  async function startListening() {
    stopListening();
    unlisten = await Promise.all([
      onVaultChanged((c) => {
        pending = pending
          ? {
              created: [...pending.created, ...c.created],
              modified: [...pending.modified, ...c.modified],
              removed: [...pending.removed, ...c.removed],
              renamed: [...pending.renamed, ...c.renamed],
            }
          : c;
        if (!timer) timer = setTimeout(() => void flushChanges(), COALESCE_MS);
      }),
      onVaultWarning((w) => toast().push({ message: w.message, tone: 'error' })),
    ]);
  }

  async function opened(res: IpcResult<VaultInfo>): Promise<IpcResult<VaultInfo>> {
    if (!res.ok) {
      set({ status: 'closed', progress: null });
      toast().push({ message: errorMessage(res.error), tone: 'error' });
      return res;
    }
    set({ info: res.value, selected: null, expanded: new Set(), renaming: null });
    usePageStore.getState().clear();
    await get().refreshTree();
    await startListening();
    set({ status: 'open', progress: null });
    const warnings = res.value.report.warnings ?? [];
    if (warnings.length) {
      toast().push({
        message: i18next.t('toasts.openedWithWarnings', { count: warnings.length }),
        detail: warnings,
      });
    }
    return res;
  }

  async function withProgress(run: () => Promise<IpcResult<VaultInfo>>) {
    set({ status: 'opening', progress: null });
    const stop = await onVaultProgress((p) => set({ progress: p }));
    try {
      return await opened(await run());
    } finally {
      safeUnlisten(stop);
    }
  }

  return {
    ...EMPTY,
    open: (path) => withProgress(() => vaultOpen(path)),
    create: (path) => withProgress(() => vaultCreate(path)),
    close: async () => {
      stopListening();
      await vaultClose();
      usePageStore.getState().clear();
      treeSeq++;
      set({ ...EMPTY, children: new Map(), expanded: new Set() });
    },
    refreshTree: async () => {
      const mine = ++treeSeq;
      const res = await vaultTree();
      if (mine !== treeSeq || !res.ok) return; // a newer refresh won, or no vault
      const nodes = res.value;
      const exists = new Set(nodes.map((n) => n.path));
      let { selected } = get();
      // Selection falls back to the nearest ancestor that still exists.
      while (selected && !exists.has(selected)) {
        const parent = parentOf(selected);
        selected = parent || null;
      }
      const expanded = new Set([...get().expanded].filter((p) => exists.has(p)));
      set({ nodes, children: childrenByParent(nodes), selected, expanded });
    },
    select: (selected) => set({ selected }),
    toggle: (path) => {
      const expanded = new Set(get().expanded);
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      set({ expanded });
    },
    expand: (path) => {
      if (!path || get().expanded.has(path)) return;
      set({ expanded: new Set(get().expanded).add(path) });
    },
    startRename: (renaming) => set({ renaming }),
    createPage: async (dir) => {
      const name = nextFreeName(get().nodes, dir, i18next.t('explorer.untitled'), '.md');
      const res = await entryCreatePage(dir, name);
      if (!res.ok) {
        toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      await get().refreshTree();
      get().expand(dir);
      set({ selected: res.value, renaming: res.value });
      return res;
    },
    createFolder: async (dir) => {
      const name = nextFreeName(get().nodes, dir, i18next.t('explorer.untitled'), '');
      const res = await entryCreateFolder(dir, name);
      if (!res.ok) {
        toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      await get().refreshTree();
      get().expand(dir);
      set({ selected: res.value, renaming: res.value });
      return res;
    },
    rename: async (from, to) => {
      const res = await entryRename(from, to);
      if (!res.ok) {
        toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      const { selected, expanded } = get();
      set({
        selected: selected ? (remap(selected, from, to) ?? selected) : selected,
        expanded: new Set([...expanded].map((p) => remap(p, from, to) ?? p)),
        renaming: null,
      });
      get().expand(parentOf(to));
      await get().refreshTree();
      await usePageStore.getState().follow(from, to);
      const out = res.value;
      if (out.failed.length) {
        toast().push({
          message: i18next.t('toasts.renameFailed', { count: out.failed.length }),
          detail: out.failed.map(([p, why]) => `${p} — ${why}`),
          tone: 'error',
        });
      } else if (out.updatedFiles.length) {
        toast().push({
          message: i18next.t('toasts.linksUpdated', { count: out.updatedFiles.length }),
        });
      }
      return res;
    },
    trash: async (path) => {
      const siblings = get().children.get(parentOf(path)) ?? [];
      const i = siblings.findIndex((n) => n.path === path);
      const next = siblings[i + 1]?.path ?? (parentOf(path) || null);
      const res = await entryTrash(path);
      if (!res.ok) {
        toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      const page = usePageStore.getState();
      if (page.path && remap(page.path, path, path)) page.clear();
      const selected = get().selected;
      if (selected && remap(selected, path, path)) set({ selected: next });
      await get().refreshTree();
      toast().push({ message: i18next.t('toasts.trashed') });
      return res;
    },
  };
});

export { joinPath };
````

Modify `apps/desktop/src/i18n/locales/en.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/i18n/locales/en.json b/apps/desktop/src/i18n/locales/en.json
index efbe4b9..a854f58 100644
--- a/apps/desktop/src/i18n/locales/en.json
+++ b/apps/desktop/src/i18n/locales/en.json
@@ -14,7 +14,38 @@
     "noRecent": "No recent vaults yet.",
     "comingSoon": "Vault actions arrive in the next milestone."
   },
-  "languages": { "en": "English", "es": "Español" },
-  "screens": { "global": "Global view", "edit": "Edit" },
-  "privacy": { "localOnly": "Local only · zero network requests" }
+  "languages": {
+    "en": "English",
+    "es": "Español"
+  },
+  "screens": {
+    "global": "Global view",
+    "edit": "Edit"
+  },
+  "privacy": {
+    "localOnly": "Local only · zero network requests"
+  },
+  "errors": {
+    "noVault": "No vault is open.",
+    "notFound": "Not found.",
+    "alreadyExists": "Something with that name already exists.",
+    "notEmpty": "Pick an empty or new folder.",
+    "invalidName": "That name can't be used.",
+    "conflict": "The file changed on disk. Try again.",
+    "outsideVault": "That path is outside the vault.",
+    "unsafeRewrite": "Some links couldn't be updated safely.",
+    "watch": "Watching the vault for changes failed.",
+    "io": "Something went wrong: {message}"
+  },
+  "toasts": {
+    "linksUpdated": "{count, plural, one {Updated links in # file} other {Updated links in # files}}",
+    "renameFailed": "{count, plural, one {Renamed. # file couldn't be updated} other {Renamed. # files couldn't be updated}}",
+    "trashed": "Moved to Trash",
+    "openedWithWarnings": "{count, plural, one {Opened with # warning} other {Opened with # warnings}}",
+    "dismiss": "Dismiss",
+    "details": "Details"
+  },
+  "explorer": {
+    "untitled": "Untitled"
+  }
 }
````

Modify `apps/desktop/src/i18n/locales/es.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/i18n/locales/es.json b/apps/desktop/src/i18n/locales/es.json
index d4f54e2..1efecc1 100644
--- a/apps/desktop/src/i18n/locales/es.json
+++ b/apps/desktop/src/i18n/locales/es.json
@@ -14,7 +14,38 @@
     "noRecent": "Aún no hay bóvedas recientes.",
     "comingSoon": "Las acciones de bóveda llegan en el próximo hito."
   },
-  "languages": { "en": "English", "es": "Español" },
-  "screens": { "global": "Vista global", "edit": "Editar" },
-  "privacy": { "localOnly": "Solo local · cero peticiones de red" }
+  "languages": {
+    "en": "English",
+    "es": "Español"
+  },
+  "screens": {
+    "global": "Vista global",
+    "edit": "Editar"
+  },
+  "privacy": {
+    "localOnly": "Solo local · cero peticiones de red"
+  },
+  "errors": {
+    "noVault": "No hay ninguna bóveda abierta.",
+    "notFound": "No se encontró.",
+    "alreadyExists": "Ya existe algo con ese nombre.",
+    "notEmpty": "Elige una carpeta vacía o nueva.",
+    "invalidName": "Ese nombre no se puede usar.",
+    "conflict": "El archivo cambió en el disco. Inténtalo de nuevo.",
+    "outsideVault": "Esa ruta está fuera de la bóveda.",
+    "unsafeRewrite": "Algunos enlaces no se pudieron actualizar de forma segura.",
+    "watch": "Falló la vigilancia de cambios en la bóveda.",
+    "io": "Algo salió mal: {message}"
+  },
+  "toasts": {
+    "linksUpdated": "{count, plural, one {Enlaces actualizados en # archivo} other {Enlaces actualizados en # archivos}}",
+    "renameFailed": "{count, plural, one {Renombrado. No se pudo actualizar # archivo} other {Renombrado. No se pudieron actualizar # archivos}}",
+    "trashed": "Movido a la papelera",
+    "openedWithWarnings": "{count, plural, one {Abierta con # advertencia} other {Abierta con # advertencias}}",
+    "dismiss": "Cerrar",
+    "details": "Detalles"
+  },
+  "explorer": {
+    "untitled": "Sin título"
+  }
 }
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @liber/desktop exec vitest run src/stores`

Expected: PASS: 21 tests, no unhandled errors (incl. `review_focus stale tree responses are ignored`, `review_focus selection falls back to the nearest existing ancestor`).

- [ ] **Step 5: Format, lint and type checks**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm check:i18n`

Expected: clean; 82 tests; `i18n OK: 2 locales in parity.`

- [ ] **Step 6: Commit**

````bash
git add apps/desktop/src
git commit -m "feat(ui): settings, vault, page, toast and ui stores with coalesced refresh (VLT-01, VLT-04, EXP-02..05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
````

(Implementers: the trailer names the model that actually wrote the commit — M0 ruling.)

---

### Task 6: Welcome actions, recent vaults, opening overlay, toasts and status routing

**Requirements:** M1b spec §3.4, §4.1 · VLT-01, Q-I18N-1

**Files:**
- Create: `apps/desktop/src/app/App.test.tsx`
- Create: `apps/desktop/src/features/opening/OpeningOverlay.module.css`
- Create: `apps/desktop/src/features/opening/OpeningOverlay.tsx`
- Create: `apps/desktop/src/features/toasts/Toaster.module.css`
- Create: `apps/desktop/src/features/toasts/Toaster.tsx`
- Create: `apps/desktop/src/features/welcome/RecentList.tsx`
- Modify: `apps/desktop/src/app/App.tsx`
- Modify: `apps/desktop/src/features/welcome/Welcome.module.css`
- Modify: `apps/desktop/src/features/welcome/Welcome.test.tsx`
- Modify: `apps/desktop/src/features/welcome/Welcome.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/main.tsx`

**Interfaces:**
- Consumes: Task 4 `pickFolder`, `vaultsRecent`, `vaultsForget`; Task 5 `useVaultStore.open/create/status/progress`, `useSettingsStore.load/update`, `useToastStore`.
- Produces: `Welcome` (enabled Create / Open folder / Open Obsidian; Notion disabled with `welcome.notionLater`; language toggle switches immediately and persists), `RecentList`, `OpeningOverlay` (`role=status`, `<progress>`), `Toaster` (status/alert, expandable details, Dismiss); `App` routes on `useVaultStore.status` (`open` still shows the M0 stub here; Task 8 swaps in `AppShell`); `main.tsx` loads settings before the first render. i18n keys `welcome.notionLater/forget/missing`, `opening.*`; `welcome.comingSoon` removed.

- [ ] **Step 1: Write the failing tests**

Modify `apps/desktop/src/features/welcome/Welcome.test.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/features/welcome/Welcome.test.tsx b/apps/desktop/src/features/welcome/Welcome.test.tsx
index 46d0b44..9a334fb 100644
--- a/apps/desktop/src/features/welcome/Welcome.test.tsx
+++ b/apps/desktop/src/features/welcome/Welcome.test.tsx
@@ -1,56 +1,141 @@
-import { render, screen } from '@testing-library/react';
+import { render, screen, waitFor, within } from '@testing-library/react';
 import userEvent from '@testing-library/user-event';
 import axe from 'axe-core';
-import { describe, expect, it } from 'vitest';
+import { afterEach, describe, expect, it } from 'vitest';
+import { clearMocks, mockIPC } from '../../ipc/testing';
+import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
 import { Welcome } from './Welcome';
 
+const info = { name: 'Notes', root: '/v/Notes', report: { pages: 0, warnings: [] } };
+
+function backend(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
+  const calls: [string, Record<string, unknown>][] = [];
+  mockIPC((cmd, args) => {
+    const a = (args ?? {}) as Record<string, unknown>;
+    calls.push([cmd, a]);
+    return handlers[cmd]?.(a);
+  });
+  return calls;
+}
+
+afterEach(async () => {
+  await resetVaultStore();
+  clearMocks();
+});
+
 describe('Welcome screen', () => {
-  it('shows the app name, tagline and the four vault actions', () => {
+  it('shows the app name, tagline, the vault actions and Notion as later', () => {
+    backend({ vaults_recent: () => [] });
     render(<Welcome version="0.1.0" />);
     expect(screen.getByRole('heading', { level: 1, name: 'Liber Linteum' })).toBeInTheDocument();
     expect(screen.getByText(/Private notes that live on your disk/)).toBeInTheDocument();
-    for (const name of [
-      'Create a new vault',
-      'Open a folder as vault',
-      'Open an Obsidian vault',
-      'Import a Notion export',
-    ]) {
-      expect(screen.getByRole('button', { name })).toBeDisabled();
+    for (const name of ['Create a new vault', 'Open a folder as vault', 'Open an Obsidian vault']) {
+      expect(screen.getByRole('button', { name })).toBeEnabled();
     }
+    const notion = screen.getByRole('button', { name: 'Import a Notion export' });
+    expect(notion).toBeDisabled();
+    expect(notion).toHaveAccessibleDescription('Notion import arrives in a later milestone.');
     expect(screen.getByText('v0.1.0')).toBeInTheDocument();
   });
 
-  it('describes each disabled vault action with the coming-soon note', () => {
+  it('VLT-01 create picks a folder and creates the vault', async () => {
+    const calls = backend({
+      vaults_recent: () => [],
+      'plugin:dialog|open': () => '/v/Notes',
+      vault_create: () => info,
+      vault_tree: () => [],
+    });
     render(<Welcome version={null} />);
-    for (const name of [
-      'Create a new vault',
-      'Open a folder as vault',
-      'Open an Obsidian vault',
-      'Import a Notion export',
-    ]) {
-      expect(screen.getByRole('button', { name })).toHaveAccessibleDescription(
-        'Vault actions arrive in the next milestone.',
-      );
-    }
+    await userEvent.click(screen.getByRole('button', { name: 'Create a new vault' }));
+    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
+    expect(calls.find(([c]) => c === 'vault_create')?.[1]).toEqual({ path: '/v/Notes' });
+  });
+
+  it.each(['Open a folder as vault', 'Open an Obsidian vault'])(
+    'VLT-01 "%s" picks a folder and opens it',
+    async (name) => {
+      const calls = backend({
+        vaults_recent: () => [],
+        'plugin:dialog|open': () => '/v/Notes',
+        vault_open: () => info,
+        vault_tree: () => [],
+      });
+      render(<Welcome version={null} />);
+      await userEvent.click(screen.getByRole('button', { name }));
+      await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
+      expect(calls.find(([c]) => c === 'vault_open')?.[1]).toEqual({ path: '/v/Notes' });
+    },
+  );
+
+  it('a cancelled folder picker does nothing', async () => {
+    const calls = backend({ vaults_recent: () => [], 'plugin:dialog|open': () => null });
+    render(<Welcome version={null} />);
+    await userEvent.click(screen.getByRole('button', { name: 'Open a folder as vault' }));
+    expect(calls.map(([c]) => c)).not.toContain('vault_open');
+    expect(useVaultStore.getState().status).toBe('closed');
+  });
+
+  /** Review Focus: a recent vault whose drive is unmounted is shown as missing,
+   * can't be opened, and can be removed from the list. */
+  it('review_focus recent vaults: open, missing (unmounted) and forget', async () => {
+    let recent = [
+      { path: '/v/Notes', name: 'Notes', openedAt: '2026-10-12T16:00:00Z', missing: false },
+      { path: '/Volumes/USB/Old', name: 'Old', openedAt: '2026-10-01T09:00:00Z', missing: true },
+    ];
+    const calls = backend({
+      vaults_recent: () => recent,
+      vaults_forget: (a) => {
+        recent = recent.filter((r) => r.path !== a.path);
+      },
+      vault_open: () => info,
+      vault_tree: () => [],
+    });
+    render(<Welcome version={null} />);
+    const list = await screen.findByRole('list', { name: 'Recent' });
+    const old = within(list).getByRole('button', { name: /^Old/ });
+    expect(old).toBeDisabled();
+    expect(within(list).getByText('Folder not found')).toBeInTheDocument();
+    await userEvent.click(within(list).getByRole('button', { name: 'Remove Old from recent' }));
+    await waitFor(() => expect(within(list).queryByText('Old')).not.toBeInTheDocument());
+    await userEvent.click(within(list).getByRole('button', { name: /^Notes/ }));
+    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
+    expect(calls.find(([c]) => c === 'vault_open')?.[1]).toEqual({ path: '/v/Notes' });
   });
 
-  it('Q-I18N-1 language toggle switches the UI to Spanish', async () => {
+  it('Q-I18N-1 language toggle switches to Spanish and saves the choice', async () => {
+    const calls = backend({
+      vaults_recent: () => [],
+      settings_set: (a) => ({
+        version: 1,
+        theme: 'system',
+        rewriteLinks: true,
+        confirmDelete: true,
+        ...(a.patch as object),
+      }),
+    });
     render(<Welcome version={null} />);
-    const es = screen.getByRole('button', { name: 'Español' });
-    expect(es).toHaveAttribute('aria-pressed', 'false');
-    await userEvent.click(es);
+    await userEvent.click(screen.getByRole('button', { name: 'Español' }));
     expect(await screen.findByText(/Notas privadas que viven en tu disco/)).toBeInTheDocument();
     expect(screen.getByRole('button', { name: 'Español' })).toHaveAttribute('aria-pressed', 'true');
-    expect(screen.getByRole('button', { name: 'Crear una bóveda nueva' })).toBeInTheDocument();
+    await waitFor(() =>
+      expect(calls.find(([c]) => c === 'settings_set')?.[1]).toEqual({ patch: { language: 'es' } }),
+    );
   });
 
   it('hides the version when it is unknown', () => {
+    backend({ vaults_recent: () => [] });
     render(<Welcome version={null} />);
     expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
   });
 
-  it('NFR-10 has no axe violations', async () => {
+  it('NFR-10 has no axe violations (with recent vaults)', async () => {
+    backend({
+      vaults_recent: () => [
+        { path: '/v/Notes', name: 'Notes', openedAt: '2026-10-12T16:00:00Z', missing: false },
+      ],
+    });
     const { container } = render(<Welcome version="0.1.0" />);
+    await screen.findByRole('list', { name: 'Recent' });
     const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
     expect(results.violations).toEqual([]);
   });
````

Create `apps/desktop/src/app/App.test.tsx`:

````tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../ipc/testing';
import { useToastStore } from '../stores/toastStore';
import { resetVaultStore, useVaultStore } from '../stores/vaultStore';
import { App } from './App';

afterEach(async () => {
  await resetVaultStore();
  useToastStore.getState().clear();
  clearMocks();
});

describe('App routing', () => {
  it('shows the welcome screen while no vault is open', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Liber Linteum' })).toBeInTheDocument();
  });

  it('shows indexing progress while opening', () => {
    render(<App />);
    act(() =>
      useVaultStore.setState({ status: 'opening', progress: { done: 1240, total: 10000 } }),
    );
    const status = screen.getByRole('status', { name: 'Opening vault…' });
    expect(status).toHaveTextContent('Indexing 1,240 / 10,000');
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1240');
  });

  it('leaves the welcome screen once the vault is open', () => {
    render(<App />);
    act(() => useVaultStore.setState({ status: 'open' }));
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Liber Linteum' }),
    ).not.toBeInTheDocument();
  });

  it('shows toasts with expandable details and lets you dismiss them', async () => {
    render(<App />);
    act(() => {
      useToastStore.getState().push({ message: 'Opened with 1 warning', detail: ['bad.md: x'] });
    });
    const toast = screen.getByRole('status', { name: '' });
    expect(toast).toHaveTextContent('Opened with 1 warning');
    await userEvent.click(screen.getByText('Details'));
    expect(screen.getByText('bad.md: x')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Opened with 1 warning')).not.toBeInTheDocument();
  });

  it('shows the backend version from app_info', async () => {
    mockIPC((cmd) => (cmd === 'app_info' ? { name: 'Liber Linteum', version: '0.1.0' } : []));
    render(<App />);
    await waitFor(() => expect(screen.getByText('v0.1.0')).toBeInTheDocument());
  });
});
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @liber/desktop exec vitest run src/features/welcome src/app/App.test.tsx`

Expected: FAIL: 10 failed | 4 passed (buttons still disabled, no `Opening vault…` status, no toasts, no recent list).

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/welcome/Welcome.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/features/welcome/Welcome.tsx b/apps/desktop/src/features/welcome/Welcome.tsx
index 1c65c13..7ecd03c 100644
--- a/apps/desktop/src/features/welcome/Welcome.tsx
+++ b/apps/desktop/src/features/welcome/Welcome.tsx
@@ -1,8 +1,18 @@
 import { useTranslation } from 'react-i18next';
 import { BrandMark, FolderIcon, ImportIcon, LockIcon, PlusIcon, VaultIcon } from '../../app/icons';
-import { SUPPORTED_LANGUAGES } from '../../i18n';
+import { SUPPORTED_LANGUAGES, type Language } from '../../i18n';
+import { pickFolder } from '../../ipc';
+import { useSettingsStore } from '../../stores/settingsStore';
+import { useVaultStore } from '../../stores/vaultStore';
+import { RecentList } from './RecentList';
 import styles from './Welcome.module.css';
 
+/** Native folder picker → open or create (VLT-01). A cancelled picker does nothing. */
+async function pickThen(action: (path: string) => Promise<unknown>) {
+  const path = await pickFolder().catch(() => null);
+  if (path) await action(path);
+}
+
 export interface WelcomeProps {
   version: string | null;
 }
@@ -10,6 +20,15 @@ export interface WelcomeProps {
 export function Welcome({ version }: WelcomeProps) {
   const { t, i18n } = useTranslation();
   const current = i18n.resolvedLanguage;
+  const open = useVaultStore((s) => s.open);
+  const create = useVaultStore((s) => s.create);
+  const updateSettings = useSettingsStore((s) => s.update);
+
+  const chooseLanguage = async (lng: Language) => {
+    // Switch immediately; persist when running inside the app.
+    await i18n.changeLanguage(lng);
+    void updateSettings({ language: lng });
+  };
 
   return (
     <main className={styles.page}>
@@ -32,7 +51,7 @@ export function Welcome({ version }: WelcomeProps) {
                 type="button"
                 lang={lng}
                 aria-pressed={current === lng}
-                onClick={() => void i18n.changeLanguage(lng)}
+                onClick={() => void chooseLanguage(lng)}
               >
                 {t(`languages.${lng}`)}
               </button>
@@ -44,27 +63,16 @@ export function Welcome({ version }: WelcomeProps) {
           <button
             type="button"
             className={`${styles.button} ${styles.primary}`}
-            disabled
-            aria-describedby="welcome-coming-soon"
+            onClick={() => void pickThen(create)}
           >
             <PlusIcon />
             {t('welcome.create')}
           </button>
-          <button
-            type="button"
-            className={styles.button}
-            disabled
-            aria-describedby="welcome-coming-soon"
-          >
+          <button type="button" className={styles.button} onClick={() => void pickThen(open)}>
             <FolderIcon />
             {t('welcome.open')}
           </button>
-          <button
-            type="button"
-            className={styles.button}
-            disabled
-            aria-describedby="welcome-coming-soon"
-          >
+          <button type="button" className={styles.button} onClick={() => void pickThen(open)}>
             <VaultIcon />
             {t('welcome.openObsidian')}
           </button>
@@ -72,22 +80,17 @@ export function Welcome({ version }: WelcomeProps) {
             type="button"
             className={styles.button}
             disabled
-            aria-describedby="welcome-coming-soon"
+            aria-describedby="welcome-notion-later"
           >
             <ImportIcon />
             {t('welcome.importNotion')}
           </button>
-          <p className={styles.note} id="welcome-coming-soon">
-            {t('welcome.comingSoon')}
+          <p className={styles.note} id="welcome-notion-later">
+            {t('welcome.notionLater')}
           </p>
         </div>
 
-        <section className={styles.recent} aria-labelledby="welcome-recent">
-          <h2 className={styles.label} id="welcome-recent">
-            {t('welcome.recent')}
-          </h2>
-          <p className={styles.empty}>{t('welcome.noRecent')}</p>
-        </section>
+        <RecentList />
 
         <p className={styles.footer}>
           <LockIcon />
````

Create `apps/desktop/src/features/welcome/RecentList.tsx`:

````tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderIcon } from '../../app/icons';
import { vaultsForget, vaultsRecent, type RecentVault } from '../../ipc';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './Welcome.module.css';

/** Recently opened vaults (most recent first). Missing folders (e.g. an
 * unmounted drive) are shown but can't be opened; any entry can be removed. */
export function RecentList() {
  const { t } = useTranslation();
  const open = useVaultStore((s) => s.open);
  const [items, setItems] = useState<RecentVault[] | null>(null);

  const reload = useCallback(async () => {
    const res = await vaultsRecent();
    setItems(res.ok ? res.value : []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const forget = async (path: string) => {
    await vaultsForget(path);
    await reload();
  };

  return (
    <section className={styles.recent} aria-labelledby="welcome-recent">
      <h2 className={styles.label} id="welcome-recent">
        {t('welcome.recent')}
      </h2>
      {items && items.length > 0 ? (
        <ul className={styles.recentList} aria-labelledby="welcome-recent">
          {items.map((item) => (
            <li key={item.path} className={styles.recentItem}>
              <button
                type="button"
                className={styles.recentOpen}
                disabled={item.missing}
                onClick={() => void open(item.path)}
              >
                <FolderIcon />
                <span className={styles.recentText}>
                  <span className={styles.recentName}>{item.name}</span>
                  <span className={styles.recentPath}>{item.path}</span>
                  {item.missing && <span className={styles.missing}>{t('welcome.missing')}</span>}
                </span>
              </button>
              <button
                type="button"
                className={styles.forget}
                aria-label={t('welcome.forget', { name: item.name })}
                onClick={() => void forget(item.path)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>{t('welcome.noRecent')}</p>
      )}
    </section>
  );
}
````

Modify `apps/desktop/src/features/welcome/Welcome.module.css` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/features/welcome/Welcome.module.css b/apps/desktop/src/features/welcome/Welcome.module.css
index da11787..8dfc128 100644
--- a/apps/desktop/src/features/welcome/Welcome.module.css
+++ b/apps/desktop/src/features/welcome/Welcome.module.css
@@ -161,3 +161,83 @@
   color: var(--color-text-muted);
   margin: 0;
 }
+
+.recentList {
+  list-style: none;
+  margin: 0;
+  padding: 0;
+  display: flex;
+  flex-direction: column;
+  gap: 8px;
+}
+
+.recentItem {
+  display: flex;
+  align-items: stretch;
+  gap: 6px;
+}
+
+.recentOpen {
+  flex: 1;
+  min-width: 0;
+  display: flex;
+  align-items: center;
+  gap: 12px;
+  border: 1px solid var(--color-border);
+  background: var(--color-surface-subtle);
+  color: var(--color-text);
+  border-radius: var(--radius-lg);
+  padding: 12px 14px;
+  text-align: left;
+  font: inherit;
+  min-height: 56px;
+  cursor: pointer;
+}
+
+.recentOpen:hover:not(:disabled) {
+  border-color: var(--color-accent);
+}
+
+.recentOpen:disabled {
+  cursor: default;
+  opacity: 0.6;
+}
+
+.recentText {
+  display: flex;
+  flex-direction: column;
+  gap: 2px;
+  min-width: 0;
+}
+
+.recentName {
+  font-weight: 700;
+}
+
+.recentPath {
+  font: 400 12px var(--font-mono);
+  color: var(--color-text-faint);
+  overflow: hidden;
+  text-overflow: ellipsis;
+  white-space: nowrap;
+}
+
+.missing {
+  font: 600 12px var(--font-body);
+  color: var(--color-warn-text);
+}
+
+.forget {
+  border: 1px solid var(--color-border);
+  background: var(--color-surface);
+  color: var(--color-text-muted);
+  border-radius: var(--radius-lg);
+  width: 44px;
+  font: 600 18px var(--font-body);
+  cursor: pointer;
+}
+
+.forget:hover {
+  color: var(--color-text);
+  border-color: var(--color-accent);
+}
````

Create `apps/desktop/src/features/opening/OpeningOverlay.tsx`:

````tsx
import { useTranslation } from 'react-i18next';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './OpeningOverlay.module.css';

/** Shown while a vault is being opened and indexed (spec §4.1). */
export function OpeningOverlay() {
  const { t } = useTranslation();
  const progress = useVaultStore((s) => s.progress);
  return (
    <div className={styles.backdrop}>
      <div className={styles.panel} role="status" aria-labelledby="opening-title">
        <h2 id="opening-title" className={styles.title}>
          {t('opening.title')}
        </h2>
        <progress
          className={styles.bar}
          max={progress?.total || 1}
          value={progress?.done ?? 0}
          aria-labelledby="opening-title"
        />
        <p className={styles.detail}>
          {progress
            ? t('opening.progress', { done: progress.done, total: progress.total })
            : t('opening.preparing')}
        </p>
      </div>
    </div>
  );
}
````

Create `apps/desktop/src/features/opening/OpeningOverlay.module.css`:

````css
.backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-bg) 70%, transparent);
  z-index: 20;
}

.panel {
  width: min(420px, calc(100% - 32px));
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-panel);
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.title {
  font: 700 22px var(--font-display);
  color: var(--color-text-strong);
  margin: 0;
}

.bar {
  width: 100%;
  height: 8px;
  accent-color: var(--color-accent);
}

.detail {
  margin: 0;
  font: 400 13px var(--font-mono);
  color: var(--color-text-muted);
}
````

Create `apps/desktop/src/features/toasts/Toaster.tsx`:

````tsx
import { useTranslation } from 'react-i18next';
import { useToastStore } from '../../stores/toastStore';
import styles from './Toaster.module.css';

/** Bottom-centre notifications. Errors are alerts; the rest are polite status. */
export function Toaster() {
  const { t } = useTranslation();
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div className={styles.stack}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={styles.toast}
          role={toast.tone === 'error' ? 'alert' : 'status'}
        >
          <div className={styles.body}>
            <span>{toast.message}</span>
            {toast.detail && toast.detail.length > 0 && (
              <details className={styles.details}>
                <summary>{t('toasts.details')}</summary>
                <ul>
                  {toast.detail.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <button
            type="button"
            className={styles.dismiss}
            aria-label={t('toasts.dismiss')}
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
````

Create `apps/desktop/src/features/toasts/Toaster.module.css`:

````css
.stack {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 30;
  width: max-content;
  max-width: calc(100% - 32px);
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: var(--color-sidebar-bg);
  color: var(--color-sidebar-text);
  border-radius: var(--radius-lg);
  padding: 10px 10px 10px 18px;
  font-size: 14px;
  line-height: 1.45;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.25);
  max-width: 560px;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.details summary {
  cursor: pointer;
  font-weight: 600;
}

.details ul {
  margin: 6px 0 0;
  padding-left: 18px;
  font: 400 12px var(--font-mono);
}

.dismiss {
  border: 1px solid currentColor;
  background: none;
  color: inherit;
  border-radius: var(--radius-md);
  min-width: 34px;
  min-height: 34px;
  font: 600 16px var(--font-body);
  cursor: pointer;
  flex: none;
}
````

Modify `apps/desktop/src/app/App.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/app/App.tsx b/apps/desktop/src/app/App.tsx
index 906f2b6..fb7f56e 100644
--- a/apps/desktop/src/app/App.tsx
+++ b/apps/desktop/src/app/App.tsx
@@ -1,10 +1,23 @@
-import { useState } from 'react';
-import { ScreenRouter, type Screen } from './ScreenRouter';
+import { OpeningOverlay } from '../features/opening/OpeningOverlay';
+import { Toaster } from '../features/toasts/Toaster';
+import { Welcome } from '../features/welcome/Welcome';
+import { useVaultStore } from '../stores/vaultStore';
+import { ScreenRouter } from './ScreenRouter';
 import { useAppVersion } from './useAppVersion';
 
+/** Routes on the vault status (spec §3.4): welcome, opening overlay, app shell. */
 export function App() {
-  // M1 drives this from the open-vault state.
-  const [screen] = useState<Screen>('welcome');
   const version = useAppVersion();
-  return <ScreenRouter screen={screen} version={version} />;
+  const status = useVaultStore((s) => s.status);
+  return (
+    <>
+      {status === 'open' ? (
+        <ScreenRouter screen="editor" version={version} />
+      ) : (
+        <Welcome version={version} />
+      )}
+      {status === 'opening' && <OpeningOverlay />}
+      <Toaster />
+    </>
+  );
 }
````

Modify `apps/desktop/src/main.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/main.tsx b/apps/desktop/src/main.tsx
index 183aa0e..2e7b28c 100644
--- a/apps/desktop/src/main.tsx
+++ b/apps/desktop/src/main.tsx
@@ -4,14 +4,18 @@ import { StrictMode } from 'react';
 import { createRoot } from 'react-dom/client';
 import { App } from './app/App';
 import { detectLanguage, initI18n } from './i18n';
+import { useSettingsStore } from './stores/settingsStore';
 import { applyTheme } from './theme/theme';
 
 applyTheme('system');
 
-void initI18n(detectLanguage(navigator.languages)).then(() => {
-  createRoot(document.getElementById('root')!).render(
-    <StrictMode>
-      <App />
-    </StrictMode>,
-  );
-});
+// Saved settings (theme, language) apply before the first render.
+void initI18n(detectLanguage(navigator.languages))
+  .then(() => useSettingsStore.getState().load())
+  .then(() => {
+    createRoot(document.getElementById('root')!).render(
+      <StrictMode>
+        <App />
+      </StrictMode>,
+    );
+  });
````

Modify `apps/desktop/src/i18n/locales/en.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/i18n/locales/en.json b/apps/desktop/src/i18n/locales/en.json
index a854f58..8734b00 100644
--- a/apps/desktop/src/i18n/locales/en.json
+++ b/apps/desktop/src/i18n/locales/en.json
@@ -12,7 +12,9 @@
     "importNotion": "Import a Notion export",
     "recent": "Recent",
     "noRecent": "No recent vaults yet.",
-    "comingSoon": "Vault actions arrive in the next milestone."
+    "notionLater": "Notion import arrives in a later milestone.",
+    "forget": "Remove {name} from recent",
+    "missing": "Folder not found"
   },
   "languages": {
     "en": "English",
@@ -47,5 +49,10 @@
   },
   "explorer": {
     "untitled": "Untitled"
+  },
+  "opening": {
+    "title": "Opening vault…",
+    "preparing": "Reading the folder…",
+    "progress": "Indexing {done, number} / {total, number}"
   }
 }
````

Modify `apps/desktop/src/i18n/locales/es.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/i18n/locales/es.json b/apps/desktop/src/i18n/locales/es.json
index 1efecc1..119dbab 100644
--- a/apps/desktop/src/i18n/locales/es.json
+++ b/apps/desktop/src/i18n/locales/es.json
@@ -12,7 +12,9 @@
     "importNotion": "Importar una exportación de Notion",
     "recent": "Recientes",
     "noRecent": "Aún no hay bóvedas recientes.",
-    "comingSoon": "Las acciones de bóveda llegan en el próximo hito."
+    "notionLater": "La importación de Notion llega en un hito posterior.",
+    "forget": "Quitar {name} de recientes",
+    "missing": "Carpeta no encontrada"
   },
   "languages": {
     "en": "English",
@@ -47,5 +49,10 @@
   },
   "explorer": {
     "untitled": "Sin título"
+  },
+  "opening": {
+    "title": "Abriendo bóveda…",
+    "preparing": "Leyendo la carpeta…",
+    "progress": "Indexando {done, number} / {total, number}"
   }
 }
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @liber/desktop exec vitest run src/features/welcome src/app`

Expected: PASS: 22 tests (incl. `review_focus recent vaults: open, missing (unmounted) and forget`).

- [ ] **Step 5: Format, lint and type checks**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm check:i18n`

Expected: clean; 91 tests; parity OK

- [ ] **Step 6: Commit**

````bash
git add apps/desktop/src
git commit -m "feat(ui): working welcome actions, recent vaults, opening overlay, toasts and status routing (VLT-01, Q-I18N-1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
````

(Implementers: the trailer names the model that actually wrote the commit — M0 ruling.)

---

### Task 7: Explorer tree (part 1): ARIA tree, keyboard model, type-ahead, inline rename

**Requirements:** M1b spec §3.4, §3.5, §4.2 · EXP-01, EXP-02, EXP-05, NFR-10

**Files:**
- Create: `apps/desktop/src/features/explorer/Explorer.module.css`
- Create: `apps/desktop/src/features/explorer/ExplorerTree.test.tsx`
- Create: `apps/desktop/src/features/explorer/ExplorerTree.tsx`
- Create: `apps/desktop/src/features/explorer/TreeRow.tsx`
- Create: `apps/desktop/src/features/explorer/nameRules.test.ts`
- Create: `apps/desktop/src/features/explorer/nameRules.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`

**Interfaces:**
- Consumes: Task 5 `useVaultStore` (`children`, `expanded`, `selected`, `renaming`, `select`, `toggle`, `startRename`, `rename`), `usePageStore.load`, tree helpers.
- Produces: `nameRules.validateName(name) -> {key:'empty'} | {key:'hidden'} | {key:'forbidden', char} | null`; `TreeRow` (+ `displayName(node)`, `keptExtension(node)`); `ExplorerTree({onRequestDelete?, onRequestMenu?, dropTarget?})` and `visibleRows(children, expanded) -> Row[]`; i18n `explorer.tree/rename/nameErrors.*`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/features/explorer/nameRules.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import { validateName } from './nameRules';

describe('nameRules (mirror of the backend rule, M1a amendment 9)', () => {
  it.each(['Notes', 'Café ñandú', 'v1.2 draft', 'Untitled 3'])('accepts %s', (n) => {
    expect(validateName(n)).toBeNull();
  });

  it('rejects empty, hidden and forbidden names with the reason', () => {
    expect(validateName('   ')).toEqual({ key: 'empty' });
    expect(validateName('.secret')).toEqual({ key: 'hidden' });
    expect(validateName('C# notes')).toEqual({ key: 'forbidden', char: '#' });
    for (const c of ['/', '\\', '|', '^', '[', ']', ':', '*', '"', '<', '>', '?']) {
      expect(validateName(`a${c}b`)).toEqual({ key: 'forbidden', char: c });
    }
    expect(validateName('tab\there')).toEqual({ key: 'forbidden', char: '\t' });
  });
});
````

Create `apps/desktop/src/features/explorer/ExplorerTree.test.tsx`:

````tsx
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { childrenByParent } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { ExplorerTree } from './ExplorerTree';

const nodes: TreeNode[] = [
  { path: 'Art', kind: 'folder' },
  { path: 'Art/DMC', kind: 'folder' },
  { path: 'Art/DMC/Sparda.md', kind: 'page' },
  { path: 'Art/rex.md', kind: 'page' },
  { path: 'Art/cover.png', kind: 'attachment' },
  { path: 'Games', kind: 'folder' },
  { path: 'Welcome.md', kind: 'page' },
];

function seed(
  list: TreeNode[] = nodes,
  extra: Partial<ReturnType<typeof useVaultStore.getState>> = {},
) {
  useVaultStore.setState({
    status: 'open',
    nodes: list,
    children: childrenByParent(list),
    expanded: new Set(),
    selected: null,
    renaming: null,
    ...extra,
  });
}

function backend(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    return handlers[cmd]?.(a);
  });
  return calls;
}

const items = () => screen.getAllByRole('treeitem');
const names = () => items().map((i) => i.getAttribute('data-name'));

afterEach(async () => {
  await resetVaultStore();
  usePageStore.getState().clear();
  clearMocks();
});

describe('ExplorerTree (EXP-01, NFR-10)', () => {
  it('is an ARIA tree with levels, expansion, selection and a single Tab stop', () => {
    seed(nodes, { expanded: new Set(['Art']), selected: 'Art/rex.md' });
    render(<ExplorerTree />);
    const tree = screen.getByRole('tree', { name: 'Files' });
    expect(names()).toEqual(['Art', 'DMC', 'rex', 'cover.png', 'Games', 'Welcome']);
    const art = within(tree).getByRole('treeitem', { name: 'Art' });
    expect(art).toHaveAttribute('aria-level', '1');
    expect(art).toHaveAttribute('aria-expanded', 'true');
    const rex = within(tree).getByRole('treeitem', { name: 'rex' });
    expect(rex).toHaveAttribute('aria-level', '2');
    expect(rex).toHaveAttribute('aria-selected', 'true');
    expect(rex).not.toHaveAttribute('aria-expanded');
    expect(items().filter((i) => i.tabIndex === 0)).toEqual([rex]);
  });

  it('arrow keys move, expand and collapse; Home/End jump', async () => {
    seed();
    render(<ExplorerTree />);
    items()[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(useVaultStore.getState().expanded.has('Art')).toBe(true);
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAttribute('data-name', 'DMC');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toHaveAttribute('data-name', 'cover.png');
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toHaveAttribute('data-name', 'Art');
    await userEvent.keyboard('{ArrowLeft}');
    expect(useVaultStore.getState().expanded.has('Art')).toBe(false);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toHaveAttribute('data-name', 'Welcome');
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toHaveAttribute('data-name', 'Art');
  });

  it('type-ahead focuses the next item starting with the typed letter', async () => {
    seed();
    render(<ExplorerTree />);
    items()[0].focus();
    await userEvent.keyboard('w');
    expect(document.activeElement).toHaveAttribute('data-name', 'Welcome');
    await userEvent.keyboard('g');
    expect(document.activeElement).toHaveAttribute('data-name', 'Games');
  });

  it('EXP-05 Enter or click on a page selects it and opens the page view', async () => {
    backend({
      page_get: (a) => ({
        path: a.path,
        title: 'Welcome',
        tags: [],
        text: '',
        links: 0,
        backlinks: 0,
      }),
    });
    seed();
    render(<ExplorerTree />);
    screen.getByRole('treeitem', { name: 'Welcome' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(useVaultStore.getState().selected).toBe('Welcome.md');
    await waitFor(() => expect(usePageStore.getState().state).toBe('ready'));
    await userEvent.click(screen.getByRole('treeitem', { name: 'Games' }));
    expect(useVaultStore.getState().expanded.has('Games')).toBe(true);
    expect(useVaultStore.getState().selected).toBe('Games');
  });

  it('EXP-02 F2 renames inline, validating the name as you type', async () => {
    const calls = backend({
      entry_rename: () => ({ moved: [], updatedFiles: [], updatedLinks: 0, failed: [] }),
      vault_tree: () => nodes,
    });
    seed();
    render(<ExplorerTree />);
    screen.getByRole('treeitem', { name: 'Welcome' }).focus();
    await userEvent.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveValue('Welcome');
    await userEvent.clear(input);
    await userEvent.type(input, 'C# notes');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Names can\'t contain "#".');
    await userEvent.keyboard('{Enter}');
    expect(calls.map(([c]) => c)).not.toContain('entry_rename');
    await userEvent.clear(input);
    await userEvent.type(input, 'Start here{Enter}');
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_rename')?.[1]).toEqual({
        from: 'Welcome.md',
        to: 'Start here.md',
      }),
    );
  });

  it('Escape cancels an inline rename without calling the backend', async () => {
    const calls = backend({});
    seed(nodes, { renaming: 'Art/rex.md', expanded: new Set(['Art']) });
    render(<ExplorerTree />);
    const input = screen.getByRole('textbox', { name: 'Rename' });
    await userEvent.type(input, 'x{Escape}');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(calls).toEqual([]);
    expect(useVaultStore.getState().renaming).toBeNull();
  });

  it('EXP-02 a new page appears in inline rename with its name selected', async () => {
    let current = nodes;
    backend({
      vault_tree: () => current,
      entry_create_page: (a) => {
        const path = `${a.dir}/${a.name}.md`;
        current = [...current, { path, kind: 'page' }];
        return path;
      },
    });
    seed();
    render(<ExplorerTree />);
    await act(async () => {
      await useVaultStore.getState().createPage('Games');
    });
    const input = await screen.findByRole('textbox', { name: 'Rename' });
    expect(input).toHaveValue('Untitled');
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe('Untitled'.length);
  });

  it('Delete asks the owner to delete the focused item', async () => {
    const onRequestDelete = vi.fn();
    seed();
    render(<ExplorerTree onRequestDelete={onRequestDelete} />);
    screen.getByRole('treeitem', { name: 'Games' }).focus();
    await userEvent.keyboard('{Delete}');
    expect(onRequestDelete).toHaveBeenCalledWith('Games');
  });

  /** Review Focus: a vault with thousands of files in a collapsed folder renders
   * only what is visible, so refreshing the tree stays cheap. */
  it('review_focus renders only rows of expanded folders', () => {
    const many: TreeNode[] = [
      { path: 'Big', kind: 'folder' },
      ...Array.from({ length: 5000 }, (_, i) => ({ path: `Big/n${i}.md`, kind: 'page' as const })),
      { path: 'a.md', kind: 'page' },
    ];
    seed(many);
    render(<ExplorerTree />);
    expect(items()).toHaveLength(2);
  });

  it('NFR-10 has no axe violations', async () => {
    seed(nodes, { expanded: new Set(['Art']), selected: 'Art/rex.md' });
    const { container } = render(<ExplorerTree />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @liber/desktop exec vitest run src/features/explorer`

Expected: FAIL: `Failed to resolve import "./ExplorerTree"` and `Failed to resolve import "./nameRules"`.

- [ ] **Step 3: Implement**

The `finished` ref in `RenameInput` matters: removing the input after Enter/Escape fires a blur, which would otherwise commit a cancelled rename (the Escape test catches it).

Create `apps/desktop/src/features/explorer/nameRules.ts`:

````ts
// Client-side mirror of the backend's name rule (liber-session `validate_name`,
// M1a spec amendment 9) for instant feedback. The backend stays authoritative.

const FORBIDDEN = ['/', '\\', '#', '|', '^', '[', ']', ':', '*', '"', '<', '>', '?'];

export type NameError = { key: 'empty' } | { key: 'hidden' } | { key: 'forbidden'; char: string };

export function validateName(name: string): NameError | null {
  const trimmed = name.trim();
  if (!trimmed) return { key: 'empty' };
  if (trimmed.startsWith('.')) return { key: 'hidden' };
  for (const ch of trimmed) {
    // eslint-disable-next-line no-control-regex
    if (FORBIDDEN.includes(ch) || /[\u0000-\u001f\u007f]/.test(ch)) {
      return { key: 'forbidden', char: ch };
    }
  }
  return null;
}
````

Create `apps/desktop/src/features/explorer/TreeRow.tsx`:

````tsx
import { forwardRef, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TreeNode } from '../../ipc';
import styles from './Explorer.module.css';
import { validateName } from './nameRules';

/** Name shown in the tree: pages without their `.md`. */
export function displayName(node: TreeNode): string {
  const name = node.path.slice(node.path.lastIndexOf('/') + 1);
  return node.kind === 'page' ? name.replace(/\.md$/i, '') : name;
}

/** The extension kept when renaming (`.md` as written, or '' for folders). */
export function keptExtension(node: TreeNode): string {
  if (node.kind !== 'page') return '';
  const m = /\.md$/i.exec(node.path);
  return m ? m[0] : '';
}

interface TreeRowProps {
  node: TreeNode;
  level: number;
  expanded: boolean;
  selected: boolean;
  focused: boolean;
  renaming: boolean;
  dropTarget?: boolean;
  onActivate: (node: TreeNode) => void;
  onFocusRow: (path: string) => void;
  onCommitRename: (node: TreeNode, name: string) => void;
  onCancelRename: () => void;
}

function Icon({ node, expanded }: { node: TreeNode; expanded: boolean }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    'aria-hidden': true,
  } as const;
  if (node.kind === 'folder') {
    return (
      <svg
        {...common}
        strokeWidth={2.4}
        strokeLinecap="round"
        className={expanded ? styles.open : styles.chevron}
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    );
  }
  if (node.kind === 'page') {
    return (
      <svg {...common} strokeLinejoin="round">
        <path d="M6 3h8l4 4v14H6z" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 16l5-5 4 4 3-3 4 4" />
    </svg>
  );
}

function RenameInput({
  node,
  onCommit,
  onCancel,
}: {
  node: TreeNode;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(displayName(node));
  const input = useRef<HTMLInputElement>(null);
  // Set once Enter/Escape decided; the blur that follows unmounting is ignored.
  const finished = useRef(false);
  const error = validateName(value);
  const errorId = `rename-error-${node.path}`;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!error) {
        finished.current = true;
        onCommit(value.trim());
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finished.current = true;
      onCancel();
    }
  };

  return (
    <span className={styles.renameBox}>
      <input
        ref={input}
        className={styles.renameInput}
        aria-label={t('explorer.rename')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => {
          if (finished.current) return;
          finished.current = true;
          if (error) onCancel();
          else onCommit(value.trim());
        }}
      />
      {error && (
        <span id={errorId} className={styles.renameError}>
          {t(
            `explorer.nameErrors.${error.key}`,
            error.key === 'forbidden' ? { char: error.char } : {},
          )}
        </span>
      )}
    </span>
  );
}

export const TreeRow = forwardRef<HTMLLIElement, TreeRowProps>(function TreeRow(
  {
    node,
    level,
    expanded,
    selected,
    focused,
    renaming,
    dropTarget,
    onActivate,
    onFocusRow,
    onCommitRename,
    onCancelRename,
  },
  ref,
) {
  const name = displayName(node);
  const classes = [styles.row, selected ? styles.selected : '', dropTarget ? styles.drop : '']
    .filter(Boolean)
    .join(' ');
  return (
    <li
      ref={ref}
      role="treeitem"
      aria-label={name}
      aria-level={level}
      aria-selected={selected}
      aria-expanded={node.kind === 'folder' ? expanded : undefined}
      tabIndex={focused ? 0 : -1}
      data-path={node.path}
      data-name={name}
      className={classes}
      style={{ paddingLeft: 8 + (level - 1) * 16 }}
      onClick={() => onActivate(node)}
      onFocus={() => onFocusRow(node.path)}
    >
      <Icon node={node} expanded={expanded} />
      {renaming ? (
        <RenameInput
          node={node}
          onCommit={(n) => onCommitRename(node, n)}
          onCancel={onCancelRename}
        />
      ) : (
        <span
          className={node.kind === 'folder' ? `${styles.label} ${styles.folder}` : styles.label}
        >
          {name}
        </span>
      )}
    </li>
  );
});
````

Create `apps/desktop/src/features/explorer/ExplorerTree.tsx`:

````tsx
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TreeNode } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { joinPath, parentOf, remap } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './Explorer.module.css';
import { displayName, keptExtension, TreeRow } from './TreeRow';

export interface Row {
  node: TreeNode;
  level: number;
}

/** Rows of the root and of expanded folders only (others are not rendered). */
export function visibleRows(children: Map<string, TreeNode[]>, expanded: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (parent: string, level: number) => {
    for (const node of children.get(parent) ?? []) {
      out.push({ node, level });
      if (node.kind === 'folder' && expanded.has(node.path)) walk(node.path, level + 1);
    }
  };
  walk('', 1);
  return out;
}

export interface ExplorerTreeProps {
  onRequestDelete?: (path: string) => void;
  onRequestMenu?: (path: string, anchor: { x: number; y: number }) => void;
  /** Highlighted drop target while dragging (Task 9). */
  dropTarget?: string | null;
}

/** ARIA tree (one Tab stop, roving focus, arrow keys, type-ahead, inline rename). */
export function ExplorerTree({ onRequestDelete, onRequestMenu, dropTarget }: ExplorerTreeProps) {
  const { t } = useTranslation();
  const children = useVaultStore((s) => s.children);
  const expanded = useVaultStore((s) => s.expanded);
  const selected = useVaultStore((s) => s.selected);
  const renaming = useVaultStore((s) => s.renaming);
  const rows = useMemo(() => visibleRows(children, expanded), [children, expanded]);
  const [focused, setFocused] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());

  const focusPath = focused ?? selected ?? rows[0]?.node.path ?? null;
  const index = rows.findIndex((r) => r.node.path === focusPath);

  const moveFocus = (path: string | undefined) => {
    if (!path) return;
    setFocused(path);
    refs.current.get(path)?.focus();
  };

  // Keep focus on the renamed item after an inline rename.
  useEffect(() => {
    if (focused && !rows.some((r) => r.node.path === focused) && selected) setFocused(selected);
  }, [rows, focused, selected]);

  const activate = (node: TreeNode) => {
    const vault = useVaultStore.getState();
    vault.select(node.path);
    setFocused(node.path);
    if (node.kind === 'folder') vault.toggle(node.path);
    else if (node.kind === 'page') void usePageStore.getState().load(node.path);
  };

  const commitRename = (node: TreeNode, name: string) => {
    const vault = useVaultStore.getState();
    const newName = `${name}${keptExtension(node)}`;
    const oldName = node.path.slice(node.path.lastIndexOf('/') + 1);
    if (newName === oldName) {
      vault.startRename(null);
      return;
    }
    const to = joinPath(parentOf(node.path), newName);
    void vault.rename(node.path, to).then((res) => {
      if (res.ok) setFocused((f) => (f ? (remap(f, node.path, to) ?? f) : f));
    });
  };

  const cancelRename = () => {
    const path = useVaultStore.getState().renaming;
    useVaultStore.getState().startRename(null);
    if (path) refs.current.get(path)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (index < 0) return;
    const row = rows[index];
    const vault = useVaultStore.getState();
    const isFolder = row.node.kind === 'folder';
    const isOpen = isFolder && expanded.has(row.node.path);
    switch (e.key) {
      case 'ArrowDown':
        moveFocus(rows[index + 1]?.node.path);
        break;
      case 'ArrowUp':
        moveFocus(rows[index - 1]?.node.path);
        break;
      case 'ArrowRight':
        if (isFolder && !isOpen) vault.toggle(row.node.path);
        else if (isOpen) moveFocus(rows[index + 1]?.node.path);
        break;
      case 'ArrowLeft':
        if (isOpen) vault.toggle(row.node.path);
        else moveFocus(parentOf(row.node.path) || undefined);
        break;
      case 'Home':
        moveFocus(rows[0]?.node.path);
        break;
      case 'End':
        moveFocus(rows.at(-1)?.node.path);
        break;
      case 'Enter':
        activate(row.node);
        break;
      case 'F2':
        vault.startRename(row.node.path);
        break;
      case 'Delete':
      case 'Backspace':
        onRequestDelete?.(row.node.path);
        break;
      case 'ContextMenu': {
        const rect = refs.current.get(row.node.path)?.getBoundingClientRect();
        onRequestMenu?.(row.node.path, { x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        break;
      }
      default:
        if (e.key === 'F10' && e.shiftKey) {
          const rect = refs.current.get(row.node.path)?.getBoundingClientRect();
          onRequestMenu?.(row.node.path, { x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
          break;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const order = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
          const hit = order.find((r) => displayName(r.node).toLowerCase().startsWith(ch));
          moveFocus(hit?.node.path);
          break;
        }
        return;
    }
    e.preventDefault();
  };

  return (
    <ul
      role="tree"
      aria-label={t('explorer.tree')}
      className={styles.tree}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        const li = (e.target as HTMLElement).closest('li[data-path]');
        const path = li?.getAttribute('data-path');
        if (path && onRequestMenu) {
          e.preventDefault();
          setFocused(path);
          onRequestMenu(path, { x: e.clientX, y: e.clientY });
        }
      }}
    >
      {rows.map(({ node, level }) => (
        <TreeRow
          key={node.path}
          ref={(el) => {
            if (el) refs.current.set(node.path, el);
            else refs.current.delete(node.path);
          }}
          node={node}
          level={level}
          expanded={expanded.has(node.path)}
          selected={selected === node.path}
          focused={focusPath === node.path}
          renaming={renaming === node.path}
          dropTarget={dropTarget === node.path}
          onActivate={activate}
          onFocusRow={setFocused}
          onCommitRename={commitRename}
          onCancelRename={cancelRename}
        />
      ))}
    </ul>
  );
}
````

Create `apps/desktop/src/features/explorer/Explorer.module.css`:

````css
/* Values from the prototype's sidebar (.trow) on the shared tokens. */
.tree {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  color: var(--color-sidebar-text);
  font: 500 13.5px var(--font-body);
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  min-height: 32px;
  user-select: none;
}

.row:hover {
  background: color-mix(in srgb, var(--color-sidebar-text) 10%, transparent);
}

.row:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: -2px;
}

.selected {
  background: color-mix(in srgb, var(--color-accent) 35%, var(--color-sidebar-bg));
  color: #fff;
}

.drop {
  box-shadow: inset 0 0 0 2px var(--color-accent);
}

.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.folder {
  font-weight: 600;
}

.chevron {
  flex: none;
  transition: transform 0.12s;
}

.open {
  flex: none;
  transform: rotate(90deg);
  transition: transform 0.12s;
}

.renameBox {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.renameInput {
  font: inherit;
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  padding: 2px 6px;
  min-width: 0;
}

.renameInput[aria-invalid='true'] {
  border-color: var(--color-warn-border);
}

.renameError {
  font-size: 12px;
  color: var(--color-warn-border);
}
````

Modify `apps/desktop/src/i18n/locales/en.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/i18n/locales/en.json b/apps/desktop/src/i18n/locales/en.json
index 8734b00..fde1a93 100644
--- a/apps/desktop/src/i18n/locales/en.json
+++ b/apps/desktop/src/i18n/locales/en.json
@@ -48,7 +48,14 @@
     "details": "Details"
   },
   "explorer": {
-    "untitled": "Untitled"
+    "untitled": "Untitled",
+    "tree": "Files",
+    "rename": "Rename",
+    "nameErrors": {
+      "empty": "Enter a name.",
+      "hidden": "Names can't start with a dot.",
+      "forbidden": "Names can't contain \"{char}\"."
+    }
   },
   "opening": {
     "title": "Opening vault…",
````

Modify `apps/desktop/src/i18n/locales/es.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/i18n/locales/es.json b/apps/desktop/src/i18n/locales/es.json
index 119dbab..72b16d3 100644
--- a/apps/desktop/src/i18n/locales/es.json
+++ b/apps/desktop/src/i18n/locales/es.json
@@ -48,7 +48,14 @@
     "details": "Detalles"
   },
   "explorer": {
-    "untitled": "Sin título"
+    "untitled": "Sin título",
+    "tree": "Archivos",
+    "rename": "Renombrar",
+    "nameErrors": {
+      "empty": "Escribe un nombre.",
+      "hidden": "Los nombres no pueden empezar con un punto.",
+      "forbidden": "Los nombres no pueden contener «{char}»."
+    }
   },
   "opening": {
     "title": "Abriendo bóveda…",
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @liber/desktop exec vitest run src/features/explorer`

Expected: PASS: 15 tests (incl. `review_focus renders only rows of expanded folders`).

- [ ] **Step 5: Format, lint and type checks**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm check:i18n`

Expected: clean; 106 tests; parity OK

- [ ] **Step 6: Commit**

````bash
git add apps/desktop/src
git commit -m "feat(ui): explorer tree with ARIA keyboard model, type-ahead and inline rename (EXP-01, EXP-02, EXP-05, NFR-10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
````

(Implementers: the trailer names the model that actually wrote the commit — M0 ruling.)

---

### Task 8: App shell (sidebar, top bar) and read-only page view

**Requirements:** M1b spec §3.4, §4.2, §4.4 · EXP-01, EXP-05, NFR-10

**Files:**
- Create: `apps/desktop/src/features/page/PageView.module.css`
- Create: `apps/desktop/src/features/page/PageView.test.tsx`
- Create: `apps/desktop/src/features/page/PageView.tsx`
- Create: `apps/desktop/src/features/shell/AppShell.test.tsx`
- Create: `apps/desktop/src/features/shell/AppShell.tsx`
- Create: `apps/desktop/src/features/shell/Shell.module.css`
- Create: `apps/desktop/src/features/shell/Sidebar.tsx`
- Create: `apps/desktop/src/features/shell/TopBar.tsx`
- Create: `apps/desktop/src/stores/dirFor.test.ts`
- Modify: `apps/desktop/src/app/App.test.tsx`
- Modify: `apps/desktop/src/app/App.tsx`
- Modify: `apps/desktop/src/app/icons.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/stores/tree.ts`
- Delete: `apps/desktop/src/app/ScreenRouter.test.tsx`
- Delete: `apps/desktop/src/app/ScreenRouter.tsx`
- Delete: `apps/desktop/src/features/editor/EditorScreen.tsx`
- Delete: `apps/desktop/src/features/global-view/GlobalViewScreen.tsx`

**Interfaces:**
- Consumes: Task 7 `ExplorerTree`; Task 5 stores (`info`, `close`, `createPage/createFolder`, `usePageStore`, `useUiStore.openDialog`).
- Produces: `dirFor(nodes, selected) -> string` (tree.ts); `PageView` (empty/loading/deleted/ready, truncated, binary); `Sidebar(treeProps)` (brand, `Files · <vault>`, New page / New folder, tree, privacy footer); `TopBar` (vault name, `[Edit · Global view]` with Global view `aria-disabled` + description, Settings, Close vault); `AppShell(treeProps)`; `App` routes `open` → `AppShell`; new icons `GearIcon`, `PencilIcon`, `GraphIcon`, `CloseIcon`, `NewFolderIcon`, `NewPageIcon`; M0 `ScreenRouter`, `GlobalViewScreen`, `EditorScreen` and `screens.*` keys removed.

- [ ] **Step 1: Write the failing tests**

`App.test.tsx` gains the shell-routing assertion and the M0 "still renders outside Tauri" test (moved from the deleted `ScreenRouter.test.tsx`).

Create `apps/desktop/src/features/page/PageView.test.tsx`:

````tsx
import { act, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { PageView } from './PageView';

const page: Page = {
  path: 'Character Design/rex-draft.md',
  title: 'Generator Rex',
  subtitle: 'Hero redesign · v3',
  cover: 'assets/rex-cover.png',
  tags: ['character', 'redesign'],
  links: 8,
  backlinks: 1,
  text: '---\nsubtitle: Hero redesign · v3\n---\n# Generator Rex\n\nBody [[Sparda]]\n',
  truncated: false,
  binary: false,
};

const show = (state: Partial<ReturnType<typeof usePageStore.getState>>) =>
  act(() => usePageStore.setState({ path: null, page: null, state: 'empty', ...state }));

afterEach(() => usePageStore.getState().clear());

describe('PageView (EXP-05)', () => {
  it('shows the empty state when nothing is selected', () => {
    render(<PageView />);
    expect(screen.getByText('Pick a page in the explorer')).toBeInTheDocument();
  });

  it('shows title, subtitle, tags, path, link counts and the raw Markdown', () => {
    render(<PageView />);
    show({ path: page.path, page, state: 'ready' });
    expect(screen.getByRole('heading', { level: 1, name: 'Generator Rex' })).toBeInTheDocument();
    expect(screen.getByText('Hero redesign · v3')).toBeInTheDocument();
    const tags = screen.getByRole('list', { name: 'Tags' });
    expect(tags).toHaveTextContent('#character');
    expect(tags).toHaveTextContent('#redesign');
    expect(screen.getByText('Character Design/rex-draft.md')).toBeInTheDocument();
    expect(screen.getByText('8 links · 1 backlink')).toBeInTheDocument();
    expect(screen.getByText(/Body \[\[Sparda\]\]/).tagName).toBe('PRE');
  });

  it('shows loading, deleted, truncated and binary states', () => {
    render(<PageView />);
    show({ path: 'a.md', state: 'loading' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    show({ path: 'a.md', state: 'deleted' });
    expect(screen.getByText('This page was deleted outside the app.')).toBeInTheDocument();
    show({ path: page.path, page: { ...page, truncated: true }, state: 'ready' });
    expect(screen.getByText('Showing the first 1 MB of this page.')).toBeInTheDocument();
    show({
      path: 'latin1.md',
      page: { ...page, title: 'latin1', binary: true, text: '' },
      state: 'ready',
    });
    expect(
      screen.getByText("This file isn't valid UTF-8 text, so it can't be shown."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Body/)).not.toBeInTheDocument();
  });

  it('NFR-10 has no axe violations', async () => {
    const { container } = render(<PageView />);
    show({ path: page.path, page, state: 'ready' });
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
````

Create `apps/desktop/src/features/shell/AppShell.test.tsx`:

````tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { childrenByParent } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { AppShell } from './AppShell';

const nodes: TreeNode[] = [
  { path: 'Art', kind: 'folder' },
  { path: 'Art/rex.md', kind: 'page' },
  { path: 'Welcome.md', kind: 'page' },
];

function seed(selected: string | null = null) {
  act(() =>
    useVaultStore.setState({
      status: 'open',
      info: { name: 'Digital Brain', root: '/v/Digital Brain', report: {} as never },
      nodes,
      children: childrenByParent(nodes),
      expanded: new Set(),
      selected,
    }),
  );
}

function backend(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    return handlers[cmd]?.(a);
  });
  return calls;
}

afterEach(async () => {
  await resetVaultStore();
  usePageStore.getState().clear();
  useUiStore.getState().closeDialog();
  clearMocks();
});

describe('AppShell', () => {
  it('shows the sidebar explorer, the vault name and the empty page state', () => {
    seed();
    render(<AppShell />);
    expect(
      screen.getByRole('complementary', { name: 'Files · Digital Brain' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tree', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Digital Brain');
    expect(screen.getByText('Pick a page in the explorer')).toBeInTheDocument();
  });

  it('has Edit active and Global view disabled with an explanation', () => {
    seed();
    render(<AppShell />);
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
    const global = screen.getByRole('button', { name: 'Global view' });
    expect(global).toHaveAttribute('aria-disabled', 'true');
    expect(global).toHaveAccessibleDescription('Global view arrives in a later milestone.');
  });

  it("new page goes into the selected folder (or the selected file's folder)", async () => {
    let current = nodes;
    const calls = backend({
      vault_tree: () => current,
      entry_create_page: (a) => {
        const path = `${a.dir}/${a.name}.md`;
        current = [...current, { path, kind: 'page' }];
        return path;
      },
      entry_create_folder: (a) => {
        const path = `${a.parent}/${a.name}`;
        current = [...current, { path, kind: 'folder' }];
        return path;
      },
    });
    seed('Art/rex.md');
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: 'New page' }));
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_create_page')?.[1]).toEqual({
        dir: 'Art',
        name: 'Untitled',
      }),
    );
    act(() => useVaultStore.setState({ selected: 'Art', renaming: null }));
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }));
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_create_folder')?.[1]).toEqual({
        parent: 'Art',
        name: 'Untitled',
      }),
    );
  });

  it('settings opens the settings dialog; close vault returns to welcome', async () => {
    const calls = backend({ vault_close: () => undefined });
    seed();
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'settings' });
    await userEvent.click(screen.getByRole('button', { name: 'Close vault' }));
    await waitFor(() => expect(useVaultStore.getState().status).toBe('closed'));
    expect(calls.map(([c]) => c)).toContain('vault_close');
  });

  it('NFR-10 has no axe violations', async () => {
    seed('Art/rex.md');
    const { container } = render(<AppShell />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
````

Create `apps/desktop/src/stores/dirFor.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../ipc';
import { dirFor } from './tree';

const nodes: TreeNode[] = [
  { path: 'Art', kind: 'folder' },
  { path: 'Art/rex.md', kind: 'page' },
];

describe('dirFor', () => {
  it('is the folder itself, the parent of a file, or the root', () => {
    expect(dirFor(nodes, 'Art')).toBe('Art');
    expect(dirFor(nodes, 'Art/rex.md')).toBe('Art');
    expect(dirFor(nodes, null)).toBe('');
    expect(dirFor(nodes, 'gone.md')).toBe('');
  });
});
````

Modify `apps/desktop/src/app/App.test.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/app/App.test.tsx b/apps/desktop/src/app/App.test.tsx
index 93b1644..d655853 100644
--- a/apps/desktop/src/app/App.test.tsx
+++ b/apps/desktop/src/app/App.test.tsx
@@ -28,12 +28,20 @@ describe('App routing', () => {
     expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1240');
   });
 
-  it('leaves the welcome screen once the vault is open', () => {
+  it('shows the app shell once the vault is open', () => {
     render(<App />);
     act(() => useVaultStore.setState({ status: 'open' }));
     expect(
       screen.queryByRole('heading', { level: 1, name: 'Liber Linteum' }),
     ).not.toBeInTheDocument();
+    expect(screen.getByRole('tree', { name: 'Files' })).toBeInTheDocument();
+  });
+
+  it('still renders when not running inside Tauri (IPC unavailable)', async () => {
+    render(<App />);
+    expect(screen.getByRole('heading', { level: 1, name: 'Liber Linteum' })).toBeInTheDocument();
+    await new Promise((resolve) => setTimeout(resolve, 0));
+    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
   });
 
   it('shows toasts with expandable details and lets you dismiss them', async () => {
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @liber/desktop exec vitest run src/features/page src/features/shell src/stores/dirFor.test.ts`

Expected: FAIL: `Failed to resolve import "./PageView"`, `Failed to resolve import "./AppShell"`, `TypeError: dirFor is not a function`.

- [ ] **Step 3: Implement**

Remove the M0 stubs:

````bash
git rm apps/desktop/src/app/ScreenRouter.tsx apps/desktop/src/app/ScreenRouter.test.tsx apps/desktop/src/features/global-view/GlobalViewScreen.tsx apps/desktop/src/features/editor/EditorScreen.tsx
````

Modify `apps/desktop/src/stores/tree.ts` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/stores/tree.ts b/apps/desktop/src/stores/tree.ts
index b683a38..f90ee45 100644
--- a/apps/desktop/src/stores/tree.ts
+++ b/apps/desktop/src/stores/tree.ts
@@ -37,3 +37,12 @@ export function remap(path: string, from: string, to: string): string | null {
   if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
   return null;
 }
+
+/** Folder where "New page/folder" creates things: the selected folder, the
+ * selected file's folder, or the vault root. */
+export function dirFor(nodes: TreeNode[], selected: string | null): string {
+  if (!selected) return '';
+  const node = nodes.find((n) => n.path === selected);
+  if (!node) return '';
+  return node.kind === 'folder' ? node.path : parentOf(node.path);
+}
````

Modify `apps/desktop/src/app/icons.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/app/icons.tsx b/apps/desktop/src/app/icons.tsx
index cf995f8..95ebb7f 100644
--- a/apps/desktop/src/app/icons.tsx
+++ b/apps/desktop/src/app/icons.tsx
@@ -70,3 +70,57 @@ export function LockIcon() {
     </svg>
   );
 }
+
+export function GearIcon() {
+  return (
+    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
+      <circle cx="12" cy="12" r="3" />
+      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
+    </svg>
+  );
+}
+
+export function PencilIcon() {
+  return (
+    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
+      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
+    </svg>
+  );
+}
+
+export function GraphIcon() {
+  return (
+    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
+      <circle cx="6" cy="6" r="3" />
+      <circle cx="18" cy="8" r="3" />
+      <circle cx="10" cy="18" r="3" />
+      <path d="M8.5 7.5l7 0.5M7.5 8.5l1.5 7M16.5 10.5l-4.5 5.5" />
+    </svg>
+  );
+}
+
+export function CloseIcon() {
+  return (
+    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
+      <path d="M6 6l12 12M18 6L6 18" />
+    </svg>
+  );
+}
+
+export function NewFolderIcon() {
+  return (
+    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
+      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
+      <path d="M12 10v6M9 13h6" />
+    </svg>
+  );
+}
+
+export function NewPageIcon() {
+  return (
+    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
+      <path d="M6 3h8l4 4v14H6z" />
+      <path d="M12 10v6M9 13h6" />
+    </svg>
+  );
+}
````

Create `apps/desktop/src/features/page/PageView.tsx`:

````tsx
import { useTranslation } from 'react-i18next';
import { usePageStore } from '../../stores/pageStore';
import styles from './PageView.module.css';

/** Read-only page view (EXP-05): header + raw Markdown. CodeMirror arrives in M2. */
export function PageView() {
  const { t } = useTranslation();
  const state = usePageStore((s) => s.state);
  const page = usePageStore((s) => s.page);

  if (state === 'empty') {
    return (
      <section className={styles.center} aria-label={t('page.region')}>
        <p className={styles.muted}>{t('page.empty')}</p>
      </section>
    );
  }
  if (state === 'loading') {
    return (
      <section className={styles.center} aria-label={t('page.region')}>
        <p className={styles.muted} role="status">
          {t('page.loading')}
        </p>
      </section>
    );
  }
  if (state === 'deleted' || !page) {
    return (
      <section className={styles.center} aria-label={t('page.region')}>
        <p className={styles.notice}>{t('page.deleted')}</p>
      </section>
    );
  }
  return (
    <section className={styles.page} aria-label={t('page.region')}>
      <header className={styles.header}>
        <h1 className={styles.title}>{page.title}</h1>
        {page.subtitle && <p className={styles.subtitle}>{page.subtitle}</p>}
        {page.tags.length > 0 && (
          <ul className={styles.tags} aria-label={t('page.tags')}>
            {page.tags.map((tag) => (
              <li key={tag} className={styles.tag}>
                #{tag}
              </li>
            ))}
          </ul>
        )}
        <p className={styles.meta}>
          <span className={styles.path}>{page.path}</span>
          <span>{t('page.meta', { links: page.links, backlinks: page.backlinks })}</span>
        </p>
      </header>
      {page.binary ? (
        <p className={styles.notice}>{t('page.binary')}</p>
      ) : (
        <>
          {page.truncated && <p className={styles.notice}>{t('page.truncated')}</p>}
          <pre className={styles.source} tabIndex={0} aria-label={page.title}>
            {page.text}
          </pre>
        </>
      )}
    </section>
  );
}
````

Create `apps/desktop/src/features/page/PageView.module.css`:

````css
.center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.muted {
  color: var(--color-text-muted);
  margin: 0;
}

.page {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 32px 40px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.header {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.title {
  font: 700 32px/1.1 var(--font-display);
  color: var(--color-text-strong);
  margin: 0;
  overflow-wrap: anywhere;
}

.subtitle {
  margin: 0;
  font-size: 16px;
  color: var(--color-text-body);
}

.tags {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 0 0;
  padding: 0;
}

.tag {
  font: 600 12px var(--font-body);
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border-radius: var(--radius-pill);
  padding: 3px 10px;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
  font-size: 13px;
  color: var(--color-text-muted);
}

.path {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}

.notice {
  margin: 0;
  background: var(--color-warn-bg);
  border: 1px solid var(--color-warn-border);
  color: var(--color-warn-text);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  font-size: 13.5px;
}

.source {
  margin: 0;
  font: 400 13px/1.6 var(--font-mono);
  color: var(--color-text-body);
  background: var(--color-surface-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 16px 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
````

Create `apps/desktop/src/features/shell/Sidebar.tsx`:

````tsx
import { useTranslation } from 'react-i18next';
import { BrandMark, LockIcon, NewFolderIcon, NewPageIcon } from '../../app/icons';
import { dirFor } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { ExplorerTree, type ExplorerTreeProps } from '../explorer/ExplorerTree';
import styles from './Shell.module.css';

/** Left column: brand, explorer actions, the tree and the privacy footer. */
export function Sidebar(treeProps: ExplorerTreeProps) {
  const { t } = useTranslation();
  const name = useVaultStore((s) => s.info?.name ?? '');
  const create = (kind: 'page' | 'folder') => {
    const { nodes, selected, createPage, createFolder } = useVaultStore.getState();
    const dir = dirFor(nodes, selected);
    void (kind === 'page' ? createPage(dir) : createFolder(dir));
  };
  return (
    <aside className={styles.side} aria-label={t('shell.files', { name })}>
      <div className={styles.brand}>
        <BrandMark size={26} />
        {t('app.name')}
      </div>
      <div className={styles.sideHeader}>
        <span className={styles.sideLabel}>{t('shell.files', { name })}</span>
        <span className={styles.sideActions}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('shell.newPage')}
            title={t('shell.newPage')}
            onClick={() => create('page')}
          >
            <NewPageIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('shell.newFolder')}
            title={t('shell.newFolder')}
            onClick={() => create('folder')}
          >
            <NewFolderIcon />
          </button>
        </span>
      </div>
      <nav className={styles.treeScroll}>
        <ExplorerTree {...treeProps} />
      </nav>
      <p className={styles.sideFoot}>
        <LockIcon />
        {t('privacy.localOnly')}
      </p>
    </aside>
  );
}
````

Create `apps/desktop/src/features/shell/TopBar.tsx`:

````tsx
import { useTranslation } from 'react-i18next';
import { CloseIcon, GearIcon, GraphIcon, PencilIcon } from '../../app/icons';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './Shell.module.css';

/** Vault name, the [Edit · Global view] toggle (Global view arrives in M3),
 * settings and close. */
export function TopBar() {
  const { t } = useTranslation();
  const name = useVaultStore((s) => s.info?.name ?? '');
  const close = useVaultStore((s) => s.close);
  const openDialog = useUiStore((s) => s.openDialog);
  return (
    <header className={styles.topbar}>
      <span className={styles.vaultName}>{name}</span>
      <div className={styles.toggle} role="group" aria-label={t('shell.view')}>
        <button type="button" className={`${styles.tg} ${styles.on}`} aria-pressed="true">
          <PencilIcon />
          {t('shell.edit')}
        </button>
        <button
          type="button"
          className={styles.tg}
          aria-pressed="false"
          aria-disabled="true"
          aria-describedby="global-later"
          title={t('shell.globalLater')}
        >
          <GraphIcon />
          {t('shell.globalView')}
        </button>
        <span id="global-later" className={styles.srOnly}>
          {t('shell.globalLater')}
        </span>
      </div>
      <div className={styles.tright}>
        <button
          type="button"
          className={styles.iconButtonLight}
          aria-label={t('shell.settings')}
          title={t('shell.settings')}
          onClick={() => openDialog({ type: 'settings' })}
        >
          <GearIcon />
        </button>
        <button
          type="button"
          className={styles.iconButtonLight}
          aria-label={t('shell.closeVault')}
          title={t('shell.closeVault')}
          onClick={() => void close()}
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  );
}
````

Create `apps/desktop/src/features/shell/AppShell.tsx`:

````tsx
import { PageView } from '../page/PageView';
import type { ExplorerTreeProps } from '../explorer/ExplorerTree';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import styles from './Shell.module.css';

/** The open-vault layout (spec §3.4): sidebar explorer + top bar + page view. */
export function AppShell(treeProps: ExplorerTreeProps) {
  return (
    <div className={styles.shell}>
      <Sidebar {...treeProps} />
      <div className={styles.main}>
        <TopBar />
        <main className={styles.content}>
          <PageView />
        </main>
      </div>
    </div>
  );
}
````

Create `apps/desktop/src/features/shell/Shell.module.css`:

````css
/* Layout values from the prototype (.shell, .side, .topbar, .toggle, .tg). */
.shell {
  display: flex;
  height: 100%;
  min-height: 0;
}

.side {
  flex: 0 0 270px;
  background: var(--color-sidebar-bg);
  color: var(--color-sidebar-text);
  padding: 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 12px;
  font: 700 16px var(--font-display);
  color: #fff;
}

.sideHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
}

.sideLabel {
  font: 600 11px var(--font-body);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.sideActions {
  display: flex;
  gap: 2px;
  flex: none;
}

.iconButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-sidebar-text);
  cursor: pointer;
}

.iconButton:hover {
  background: color-mix(in srgb, var(--color-sidebar-text) 12%, transparent);
}

.treeScroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.sideFoot {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-faint);
  padding: 12px 8px 4px;
  margin: 0;
  border-top: 1px solid color-mix(in srgb, var(--color-sidebar-text) 15%, transparent);
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  flex-wrap: wrap;
  background: var(--color-surface-subtle);
  border-bottom: 1px solid var(--color-border);
}

.vaultName {
  font: 600 14px var(--font-body);
  color: var(--color-text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 30%;
}

.toggle {
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1.5px solid var(--color-text-strong);
  border-radius: var(--radius-pill);
  background: var(--color-surface);
  margin: 0 auto;
}

.tg {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 20px;
  border-radius: var(--radius-pill);
  border: 0;
  background: transparent;
  font: 600 15px var(--font-body);
  color: var(--color-text-body);
  cursor: pointer;
  min-height: 44px;
}

.tg[aria-disabled='true'] {
  opacity: 0.5;
  cursor: not-allowed;
}

.on {
  background: var(--color-accent-soft);
  color: var(--color-text-strong);
}

.tright {
  display: flex;
  align-items: center;
  gap: 8px;
}

.iconButtonLight {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  cursor: pointer;
}

.iconButtonLight:hover {
  border-color: var(--color-accent);
}

.content {
  flex: 1;
  min-height: 0;
  display: flex;
}

.srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
````

Modify `apps/desktop/src/app/App.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/app/App.tsx b/apps/desktop/src/app/App.tsx
index fb7f56e..b0ca690 100644
--- a/apps/desktop/src/app/App.tsx
+++ b/apps/desktop/src/app/App.tsx
@@ -1,8 +1,8 @@
 import { OpeningOverlay } from '../features/opening/OpeningOverlay';
+import { AppShell } from '../features/shell/AppShell';
 import { Toaster } from '../features/toasts/Toaster';
 import { Welcome } from '../features/welcome/Welcome';
 import { useVaultStore } from '../stores/vaultStore';
-import { ScreenRouter } from './ScreenRouter';
 import { useAppVersion } from './useAppVersion';
 
 /** Routes on the vault status (spec §3.4): welcome, opening overlay, app shell. */
@@ -11,11 +11,7 @@ export function App() {
   const status = useVaultStore((s) => s.status);
   return (
     <>
-      {status === 'open' ? (
-        <ScreenRouter screen="editor" version={version} />
-      ) : (
-        <Welcome version={version} />
-      )}
+      {status === 'open' ? <AppShell /> : <Welcome version={version} />}
       {status === 'opening' && <OpeningOverlay />}
       <Toaster />
     </>
````

Modify `apps/desktop/src/i18n/locales/en.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/i18n/locales/en.json b/apps/desktop/src/i18n/locales/en.json
index fde1a93..8e26162 100644
--- a/apps/desktop/src/i18n/locales/en.json
+++ b/apps/desktop/src/i18n/locales/en.json
@@ -20,10 +20,6 @@
     "en": "English",
     "es": "Español"
   },
-  "screens": {
-    "global": "Global view",
-    "edit": "Edit"
-  },
   "privacy": {
     "localOnly": "Local only · zero network requests"
   },
@@ -61,5 +57,26 @@
     "title": "Opening vault…",
     "preparing": "Reading the folder…",
     "progress": "Indexing {done, number} / {total, number}"
+  },
+  "shell": {
+    "files": "Files · {name}",
+    "newPage": "New page",
+    "newFolder": "New folder",
+    "view": "View",
+    "edit": "Edit",
+    "globalView": "Global view",
+    "globalLater": "Global view arrives in a later milestone.",
+    "settings": "Settings",
+    "closeVault": "Close vault"
+  },
+  "page": {
+    "region": "Page",
+    "empty": "Pick a page in the explorer",
+    "loading": "Loading…",
+    "deleted": "This page was deleted outside the app.",
+    "binary": "This file isn't valid UTF-8 text, so it can't be shown.",
+    "truncated": "Showing the first 1 MB of this page.",
+    "tags": "Tags",
+    "meta": "{links, plural, one {# link} other {# links}} · {backlinks, plural, one {# backlink} other {# backlinks}}"
   }
 }
````

Modify `apps/desktop/src/i18n/locales/es.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/i18n/locales/es.json b/apps/desktop/src/i18n/locales/es.json
index 72b16d3..46e3226 100644
--- a/apps/desktop/src/i18n/locales/es.json
+++ b/apps/desktop/src/i18n/locales/es.json
@@ -20,10 +20,6 @@
     "en": "English",
     "es": "Español"
   },
-  "screens": {
-    "global": "Vista global",
-    "edit": "Editar"
-  },
   "privacy": {
     "localOnly": "Solo local · cero peticiones de red"
   },
@@ -61,5 +57,26 @@
     "title": "Abriendo bóveda…",
     "preparing": "Leyendo la carpeta…",
     "progress": "Indexando {done, number} / {total, number}"
+  },
+  "shell": {
+    "files": "Archivos · {name}",
+    "newPage": "Nueva página",
+    "newFolder": "Nueva carpeta",
+    "view": "Vista",
+    "edit": "Editar",
+    "globalView": "Vista global",
+    "globalLater": "La vista global llega en un hito posterior.",
+    "settings": "Ajustes",
+    "closeVault": "Cerrar bóveda"
+  },
+  "page": {
+    "region": "Página",
+    "empty": "Elige una página en el explorador",
+    "loading": "Cargando…",
+    "deleted": "Esta página se eliminó fuera de la app.",
+    "binary": "Este archivo no es texto UTF-8 válido, así que no se puede mostrar.",
+    "truncated": "Se muestra el primer 1 MB de esta página.",
+    "tags": "Etiquetas",
+    "meta": "{links, plural, one {# enlace} other {# enlaces}} · {backlinks, plural, one {# retroenlace} other {# retroenlaces}}"
   }
 }
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @liber/desktop exec vitest run`

Expected: PASS: 112 tests.

- [ ] **Step 5: Format, lint and type checks**

Run: `pnpm lint && pnpm typecheck && pnpm check:i18n`

Expected: clean; parity OK

- [ ] **Step 6: Commit**

````bash
git add apps/desktop/src
git commit -m "feat(ui): app shell with sidebar, top bar and read-only page view (EXP-01, EXP-05, NFR-10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
````

(Implementers: the trailer names the model that actually wrote the commit — M0 ruling.)

---

### Task 9: Explorer (part 2): context menu, drag-and-drop, dialogs, global shortcuts

**Requirements:** M1b spec §3.4, §3.5, §4.2 · EXP-02, EXP-03, EXP-04, NFR-10

**Files:**
- Create: `apps/desktop/src/features/dialogs/ConfirmDeleteDialog.tsx`
- Create: `apps/desktop/src/features/dialogs/Dialog.tsx`
- Create: `apps/desktop/src/features/dialogs/DialogHost.tsx`
- Create: `apps/desktop/src/features/dialogs/Dialogs.module.css`
- Create: `apps/desktop/src/features/dialogs/MoveToDialog.tsx`
- Create: `apps/desktop/src/features/dialogs/SettingsDialog.tsx`
- Create: `apps/desktop/src/features/explorer/ContextMenu.tsx`
- Create: `apps/desktop/src/features/explorer/ExplorerDnd.tsx`
- Create: `apps/desktop/src/features/explorer/deleteFlow.ts`
- Create: `apps/desktop/src/features/explorer/drop.test.ts`
- Create: `apps/desktop/src/features/explorer/drop.ts`
- Create: `apps/desktop/src/features/shell/Interactions.test.tsx`
- Create: `apps/desktop/src/features/shell/useGlobalShortcuts.ts`
- Modify: `apps/desktop/src/features/explorer/Explorer.module.css`
- Modify: `apps/desktop/src/features/explorer/ExplorerTree.tsx`
- Modify: `apps/desktop/src/features/explorer/TreeRow.tsx`
- Modify: `apps/desktop/src/features/shell/AppShell.tsx`
- Modify: `apps/desktop/src/features/shell/Sidebar.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/theme/base.css`

**Interfaces:**
- Consumes: Tasks 5–8 (stores, `ExplorerTree`, `TreeRow`, `AppShell`, `Sidebar`), Task 4 `backlinkCount`, `pickFolder`.
- Produces: `drop.ts`: `ROOT_DROP_ID`, `planDrop(from, target) -> string | null`, `dropEntry(from, target) -> Promise<boolean>`; `deleteFlow.requestDelete(path)`; `ExplorerDnd` (dnd-kit `DndContext`, pointer sensor distance 5, keyboard sensor Space/Space/Escape, root drop zone); `TreeRow` is draggable (all) and droppable (folders) — only dnd-kit *listeners* are spread; `ExplorerTree` gains `dragging?`; `ContextMenu({menu, onClose})` + `MenuState`; dialogs `Dialog` (focus trap, Escape, restore focus), `ConfirmDeleteDialog`, `MoveToDialog`, `SettingsDialog`, `DialogHost`; `useGlobalShortcuts(menuOpen)`; `AppShell` wires menu, dialogs, shortcuts; i18n `menu.*`, `dialogs.*`, `settings.*`; `.liber-menu` styles in `base.css`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/features/explorer/drop.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import { planDrop } from './drop';

describe('planDrop (EXP-02 drag-and-drop rules)', () => {
  it('moves into another folder or the root, keeping the name', () => {
    expect(planDrop('Art/rex.md', 'Games')).toBe('Games/rex.md');
    expect(planDrop('Art/rex.md', '')).toBe('rex.md');
    expect(planDrop('Art/DMC', 'Games')).toBe('Games/DMC');
  });

  it('refuses drops onto itself, its current folder or its own descendant', () => {
    expect(planDrop('Art/rex.md', 'Art')).toBeNull();
    expect(planDrop('rex.md', '')).toBeNull();
    expect(planDrop('Art', 'Art')).toBeNull();
    expect(planDrop('Art', 'Art/DMC')).toBeNull();
    expect(planDrop('Art', 'Art/DMC/Deep')).toBeNull();
  });

  it('does not confuse sibling prefixes with descendants', () => {
    expect(planDrop('Art', 'Artwork')).toBe('Artwork/Art');
  });
});
````

Create `apps/desktop/src/features/shell/Interactions.test.tsx`:

````tsx
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { childrenByParent } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { dropEntry } from '../explorer/drop';
import { AppShell } from './AppShell';

const nodes: TreeNode[] = [
  { path: 'Art', kind: 'folder' },
  { path: 'Art/DMC', kind: 'folder' },
  { path: 'Art/DMC/Sparda.md', kind: 'page' },
  { path: 'Art/rex.md', kind: 'page' },
  { path: 'Games', kind: 'folder' },
  { path: 'Welcome.md', kind: 'page' },
];

function seed(selected: string | null = null, expanded: string[] = []) {
  act(() =>
    useVaultStore.setState({
      status: 'open',
      info: { name: 'Vault', root: '/v', report: {} as never },
      nodes,
      children: childrenByParent(nodes),
      expanded: new Set(expanded),
      selected,
    }),
  );
}

function backend(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    return handlers[cmd]?.(a);
  });
  return calls;
}

const outcome = { moved: [], updatedFiles: [], updatedLinks: 0, failed: [] };
const axeRun = (el: Element) =>
  axe.run(el, { rules: { 'color-contrast': { enabled: false } } }).then((r) => r.violations);

afterEach(async () => {
  await resetVaultStore();
  usePageStore.getState().clear();
  useUiStore.getState().closeDialog();
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  clearMocks();
});

describe('context menu', () => {
  it('opens with Shift+F10, navigates with arrows and closes with Escape', async () => {
    backend({});
    seed();
    render(<AppShell />);
    screen.getByRole('treeitem', { name: 'Welcome' }).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu', { name: 'Actions for Welcome' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'New page',
      'New folder',
      'Rename',
      'Move to…',
      'Delete',
    ]);
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(items[2]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(await axeRun(document.body)).toEqual([]);
  });

  it('right-click opens the menu; Rename starts inline rename', async () => {
    backend({});
    seed();
    render(<AppShell />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'Welcome' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(useVaultStore.getState().renaming).toBe('Welcome.md');
    expect(screen.getByRole('textbox', { name: 'Rename' })).toBeInTheDocument();
  });
});

describe('delete (EXP-03)', () => {
  it('asks first, with the backlink count, then moves to Trash', async () => {
    let current = nodes;
    const calls = backend({
      backlink_count: () => 3,
      entry_trash: (a) => {
        current = current.filter((n) => n.path !== a.path);
      },
      vault_tree: () => current,
    });
    seed();
    render(<AppShell />);
    screen.getByRole('treeitem', { name: 'Welcome' }).focus();
    await userEvent.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog', { name: 'Move “Welcome” to Trash?' });
    expect(
      await within(dialog).findByText('3 links point to it and will break.'),
    ).toBeInTheDocument();
    expect(await axeRun(dialog)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(calls.map(([c]) => c)).toContain('entry_trash'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a folder shows how many items it contains; Cancel keeps everything', async () => {
    const calls = backend({ backlink_count: () => 0 });
    seed();
    render(<AppShell />);
    act(() => useUiStore.getState().openDialog({ type: 'delete', path: 'Art' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('It contains 3 items.')).toBeInTheDocument();
    expect(await within(dialog).findByText('Nothing links to it.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.map(([c]) => c)).not.toContain('entry_trash');
  });

  it('"Don\'t ask again" turns confirmation off; then Delete trashes immediately', async () => {
    let current = nodes;
    const calls = backend({
      backlink_count: () => 0,
      settings_set: (a) => ({ ...DEFAULT_SETTINGS, ...(a.patch as object) }),
      entry_trash: (a) => {
        current = current.filter((n) => n.path !== a.path);
      },
      vault_tree: () => current,
    });
    seed();
    render(<AppShell />);
    act(() => useUiStore.getState().openDialog({ type: 'delete', path: 'Welcome.md' }));
    await userEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }));
    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(useSettingsStore.getState().settings.confirmDelete).toBe(false));
    expect(calls.find(([c]) => c === 'settings_set')?.[1]).toEqual({
      patch: { confirmDelete: false },
    });
    screen.getByRole('treeitem', { name: 'Games' }).focus();
    await userEvent.keyboard('{Delete}');
    await waitFor(() =>
      expect(calls.filter(([c]) => c === 'entry_trash').map(([, a]) => a.path)).toEqual([
        'Welcome.md',
        'Games',
      ]),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('move (EXP-02)', () => {
  it('"Move to…" lists valid folders and moves the item', async () => {
    const calls = backend({ entry_rename: () => outcome, vault_tree: () => nodes });
    seed();
    render(<AppShell />);
    act(() => useUiStore.getState().openDialog({ type: 'move', path: 'Art/DMC' }));
    const dialog = screen.getByRole('dialog', { name: 'Move “DMC”' });
    const select = within(dialog).getByRole('listbox', { name: 'Destination folder' });
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Vault root', 'Games']); // not itself, its folder or descendants
    expect(await axeRun(dialog)).toEqual([]);
    await userEvent.selectOptions(select, 'Games');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_rename')?.[1]).toEqual({
        from: 'Art/DMC',
        to: 'Games/DMC',
      }),
    );
  });

  it('a drop onto a folder moves the item; forbidden drops do nothing', async () => {
    const calls = backend({ entry_rename: () => outcome, vault_tree: () => nodes });
    seed();
    expect(await dropEntry('Art', 'Art/DMC')).toBe(false);
    expect(await dropEntry('Welcome.md', 'Games')).toBe(true);
    expect(calls.filter(([c]) => c === 'entry_rename').map(([, a]) => a)).toEqual([
      { from: 'Welcome.md', to: 'Games/Welcome.md' },
    ]);
  });
});

describe('settings dialog', () => {
  it('changes are saved immediately; Escape closes; focus stays inside', async () => {
    const calls = backend({
      settings_set: (a) => ({ ...useSettingsStore.getState().settings, ...(a.patch as object) }),
    });
    seed();
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(await axeRun(dialog)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Dark' }));
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Language' }), 'es');
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: /Actualizar enlaces|Update links/ }),
    );
    await waitFor(() =>
      expect(calls.filter(([c]) => c === 'settings_set').map(([, a]) => a.patch)).toEqual([
        { theme: 'dark' },
        { language: 'es' },
        { rewriteLinks: false },
      ]),
    );
    // Tab from the last control wraps to the first (focus trap).
    const focusables = within(dialog).getAllByRole('button');
    focusables.at(-1)!.focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('global shortcuts (spec §3.5)', () => {
  it('⌘, opens settings; ⌘N creates a page; ⌘⇧E focuses the explorer', async () => {
    let current = nodes;
    const calls = backend({
      vault_tree: () => current,
      entry_create_page: (a) => {
        const path = a.dir ? `${a.dir}/${a.name}.md` : `${a.name}.md`;
        current = [...current, { path, kind: 'page' }];
        return path;
      },
    });
    seed('Games');
    render(<AppShell />);
    await userEvent.keyboard('{Meta>},{/Meta}');
    expect(useUiStore.getState().dialog).toEqual({ type: 'settings' });
    act(() => useUiStore.getState().closeDialog());
    await userEvent.keyboard('{Control>}n{/Control}');
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_create_page')?.[1]).toEqual({
        dir: 'Games',
        name: 'Untitled',
      }),
    );
    act(() => useVaultStore.getState().startRename(null));
    document.body.focus();
    await userEvent.keyboard('{Meta>}{Shift>}e{/Shift}{/Meta}');
    expect(document.activeElement).toHaveAttribute('role', 'treeitem');
  });
});
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @liber/desktop exec vitest run src/features/explorer/drop.test.ts src/features/shell/Interactions.test.tsx`

Expected: FAIL: `Failed to resolve import "./drop"` and `Failed to resolve import "../explorer/drop"`.

- [ ] **Step 3: Implement**

jsdom has no layout, so dnd-kit's keyboard sensor cannot be exercised in Vitest (every rect is 0×0). The drop *rules* (`planDrop`) and the drop *handler* (`dropEntry`) are unit-tested; the pointer and keyboard drag gestures are on the human real-window checklist (Task 10).

Create `apps/desktop/src/features/explorer/drop.ts`:

````ts
import { joinPath, nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';

/** Drop-target id for the vault root (dnd-kit ids can't be empty). */
export const ROOT_DROP_ID = '__vault_root__';

/** Destination path for dropping `from` into folder `target` (`''` = root), or
 * `null` when the drop is not allowed: onto itself, into its current folder,
 * or into its own descendant. */
export function planDrop(from: string, target: string): string | null {
  if (target === from || target.startsWith(`${from}/`)) return null;
  if (parentOf(from) === target) return null;
  return joinPath(target, nameOf(from));
}

/** Performs a drop through the store (rename = move). Returns whether it ran. */
export async function dropEntry(from: string, target: string): Promise<boolean> {
  const to = planDrop(from, target);
  if (!to) return false;
  const res = await useVaultStore.getState().rename(from, to);
  return res.ok;
}
````

Create `apps/desktop/src/features/explorer/deleteFlow.ts`:

````ts
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

/** Delete with confirmation (spec §4.2), or straight to Trash when the
 * `confirmDelete` setting is off. */
export function requestDelete(path: string) {
  if (useSettingsStore.getState().settings.confirmDelete) {
    useUiStore.getState().openDialog({ type: 'delete', path });
  } else {
    void useVaultStore.getState().trash(path);
  }
}
````

Create `apps/desktop/src/features/explorer/ExplorerDnd.tsx`:

````tsx
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { useState } from 'react';
import { dropEntry, planDrop, ROOT_DROP_ID } from './drop';
import { ExplorerTree, type ExplorerTreeProps } from './ExplorerTree';
import styles from './Explorer.module.css';

const targetOf = (id: string | number | undefined) =>
  id === undefined ? null : id === ROOT_DROP_ID ? '' : String(id);

/** Drag-and-drop moves in the explorer (pointer and keyboard sensors). Keyboard
 * drag: Space to pick up, arrows to move, Space to drop, Escape to cancel. */
export function ExplorerDnd(props: ExplorerTreeProps) {
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );
  const root = useDroppable({ id: ROOT_DROP_ID });

  const onDragOver = ({ active, over: o }: DragOverEvent) => {
    const target = targetOf(o?.id);
    setOver(target !== null && planDrop(String(active.id), target) ? target : null);
  };
  const onDragEnd = ({ active, over: o }: DragEndEvent) => {
    setDragging(false);
    setOver(null);
    const target = targetOf(o?.id);
    if (target !== null) void dropEntry(String(active.id), target);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={() => setDragging(true)}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragging(false);
        setOver(null);
      }}
    >
      <div
        ref={root.setNodeRef}
        className={over === '' ? `${styles.rootDrop} ${styles.drop}` : styles.rootDrop}
      >
        <ExplorerTree {...props} dragging={dragging} dropTarget={over} />
      </div>
    </DndContext>
  );
}
````

Modify `apps/desktop/src/features/explorer/TreeRow.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/features/explorer/TreeRow.tsx b/apps/desktop/src/features/explorer/TreeRow.tsx
index 6304536..59526a5 100644
--- a/apps/desktop/src/features/explorer/TreeRow.tsx
+++ b/apps/desktop/src/features/explorer/TreeRow.tsx
@@ -1,3 +1,4 @@
+import { useDraggable, useDroppable } from '@dnd-kit/core';
 import { forwardRef, useEffect, useRef, useState, type KeyboardEvent } from 'react';
 import { useTranslation } from 'react-i18next';
 import type { TreeNode } from '../../ipc';
@@ -153,12 +154,23 @@ export const TreeRow = forwardRef<HTMLLIElement, TreeRowProps>(function TreeRow(
   ref,
 ) {
   const name = displayName(node);
+  // Drag source (any item) and drop target (folders). Only the listeners are
+  // spread: dnd-kit's attributes would replace the treeitem role and tabindex.
+  const drag = useDraggable({ id: node.path, disabled: renaming });
+  const drop = useDroppable({ id: node.path, disabled: node.kind !== 'folder' });
+  const setRefs = (el: HTMLLIElement | null) => {
+    drag.setNodeRef(el);
+    drop.setNodeRef(el);
+    if (typeof ref === 'function') ref(el);
+    else if (ref) ref.current = el;
+  };
   const classes = [styles.row, selected ? styles.selected : '', dropTarget ? styles.drop : '']
     .filter(Boolean)
     .join(' ');
   return (
     <li
-      ref={ref}
+      ref={setRefs}
+      {...drag.listeners}
       role="treeitem"
       aria-label={name}
       aria-level={level}
````

Modify `apps/desktop/src/features/explorer/ExplorerTree.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/features/explorer/ExplorerTree.tsx b/apps/desktop/src/features/explorer/ExplorerTree.tsx
index 8bd7aa6..5698838 100644
--- a/apps/desktop/src/features/explorer/ExplorerTree.tsx
+++ b/apps/desktop/src/features/explorer/ExplorerTree.tsx
@@ -28,12 +28,19 @@ export function visibleRows(children: Map<string, TreeNode[]>, expanded: Set<str
 export interface ExplorerTreeProps {
   onRequestDelete?: (path: string) => void;
   onRequestMenu?: (path: string, anchor: { x: number; y: number }) => void;
-  /** Highlighted drop target while dragging (Task 9). */
+  /** Highlighted drop target while dragging. */
   dropTarget?: string | null;
+  /** A drag is in progress: arrow keys belong to the drag, not the tree. */
+  dragging?: boolean;
 }
 
 /** ARIA tree (one Tab stop, roving focus, arrow keys, type-ahead, inline rename). */
-export function ExplorerTree({ onRequestDelete, onRequestMenu, dropTarget }: ExplorerTreeProps) {
+export function ExplorerTree({
+  onRequestDelete,
+  onRequestMenu,
+  dropTarget,
+  dragging,
+}: ExplorerTreeProps) {
   const { t } = useTranslation();
   const children = useVaultStore((s) => s.children);
   const expanded = useVaultStore((s) => s.expanded);
@@ -86,7 +93,7 @@ export function ExplorerTree({ onRequestDelete, onRequestMenu, dropTarget }: Exp
   };
 
   const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
-    if (index < 0) return;
+    if (index < 0 || dragging) return;
     const row = rows[index];
     const vault = useVaultStore.getState();
     const isFolder = row.node.kind === 'folder';
````

Modify `apps/desktop/src/features/explorer/Explorer.module.css` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/features/explorer/Explorer.module.css b/apps/desktop/src/features/explorer/Explorer.module.css
index 9324d30..96b5569 100644
--- a/apps/desktop/src/features/explorer/Explorer.module.css
+++ b/apps/desktop/src/features/explorer/Explorer.module.css
@@ -88,3 +88,8 @@
   font-size: 12px;
   color: var(--color-warn-border);
 }
+
+.rootDrop {
+  min-height: 100%;
+  border-radius: var(--radius-sm);
+}
````

Create `apps/desktop/src/features/explorer/ContextMenu.tsx`:

````tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { parentOf } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { requestDelete } from './deleteFlow';
import { displayName } from './TreeRow';

export interface MenuState {
  path: string;
  anchor: { x: number; y: number };
}

/** Explorer actions for one item (right-click, "…" or Shift+F10). */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const { t } = useTranslation();
  const node = useVaultStore((s) => s.nodes.find((n) => n.path === menu.path));
  const [active, setActive] = useState(0);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    items.current[active]?.focus();
  }, [active]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  if (!node) return null;
  const dir = node.kind === 'folder' ? node.path : parentOf(node.path);
  const vault = useVaultStore.getState;
  const actions: [string, () => void][] = [
    [t('menu.newPage'), () => void vault().createPage(dir)],
    [t('menu.newFolder'), () => void vault().createFolder(dir)],
    [t('menu.rename'), () => vault().startRename(node.path)],
    [t('menu.move'), () => useUiStore.getState().openDialog({ type: 'move', path: node.path })],
    [t('menu.delete'), () => requestDelete(node.path)],
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % actions.length);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + actions.length) % actions.length);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(actions.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={box}
      role="menu"
      aria-label={t('menu.label', { name: displayName(node) })}
      className="liber-menu"
      style={{ position: 'fixed', left: menu.anchor.x, top: menu.anchor.y }}
      onKeyDown={onKeyDown}
    >
      {actions.map(([label, run], i) => (
        <button
          key={label}
          ref={(el) => {
            items.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          onClick={() => {
            onClose();
            run();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
````

Create `apps/desktop/src/features/dialogs/Dialog.tsx`:

````tsx
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './Dialogs.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: labelled, focus trapped, Escape closes, focus restored on close. */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !box.current) return;
    const nodes = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.backdrop}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={styles.dialog}
        onKeyDown={onKeyDown}
      >
        <h2 id="dialog-title" className={styles.title}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
````

Create `apps/desktop/src/features/dialogs/ConfirmDeleteDialog.tsx`:

````tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backlinkCount } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVaultStore } from '../../stores/vaultStore';
import { displayName } from '../explorer/TreeRow';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';

/** "Move X to Trash?" with the links that will break (spec §4.2). */
export function ConfirmDeleteDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useTranslation();
  const node = useVaultStore((s) => s.nodes.find((n) => n.path === path));
  const items = useVaultStore((s) => s.nodes.filter((n) => n.path.startsWith(`${path}/`)).length);
  const [links, setLinks] = useState<number | null>(null);
  const [dontAsk, setDontAsk] = useState(false);

  useEffect(() => {
    void backlinkCount(path).then((res) => setLinks(res.ok ? res.value : 0));
  }, [path]);

  if (!node) return null;
  const confirm = async () => {
    if (dontAsk) await useSettingsStore.getState().update({ confirmDelete: false });
    onClose();
    await useVaultStore.getState().trash(path);
  };

  return (
    <Dialog title={t('dialogs.delete.title', { name: displayName(node) })} onClose={onClose}>
      {node.kind === 'folder' && (
        <p className={styles.text}>{t('dialogs.delete.items', { count: items })}</p>
      )}
      <p className={styles.text}>
        {links === null ? '…' : t('dialogs.delete.links', { count: links })}
      </p>
      <label className={styles.check}>
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        {t('dialogs.delete.dontAsk')}
      </label>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.danger}`}
          onClick={() => void confirm()}
        >
          {t('dialogs.delete.confirm')}
        </button>
      </div>
    </Dialog>
  );
}
````

Create `apps/desktop/src/features/dialogs/MoveToDialog.tsx`:

````tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVaultStore } from '../../stores/vaultStore';
import { dropEntry, planDrop } from '../explorer/drop';
import { displayName } from '../explorer/TreeRow';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';

/** Keyboard-friendly alternative to drag-and-drop (spec §3.4). */
export function MoveToDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useTranslation();
  const nodes = useVaultStore((s) => s.nodes);
  const node = nodes.find((n) => n.path === path);
  const targets = ['', ...nodes.filter((n) => n.kind === 'folder').map((n) => n.path)].filter(
    (target) => planDrop(path, target) !== null,
  );
  const [target, setTarget] = useState(targets[0] ?? '');

  if (!node) return null;
  const move = async () => {
    onClose();
    await dropEntry(path, target);
  };

  return (
    <Dialog title={t('dialogs.move.title', { name: displayName(node) })} onClose={onClose}>
      <label className={styles.field}>
        <span>{t('dialogs.move.to')}</span>
        <select
          className={styles.select}
          size={Math.min(10, Math.max(2, targets.length))}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void move();
          }}
        >
          {targets.map((p) => (
            <option key={p || 'root'} value={p}>
              {p || t('dialogs.move.root')}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={targets.length === 0}
          onClick={() => void move()}
        >
          {t('dialogs.move.confirm')}
        </button>
      </div>
    </Dialog>
  );
}
````

Create `apps/desktop/src/features/dialogs/SettingsDialog.tsx`:

````tsx
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import type { Theme } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';

const THEMES: Theme[] = ['system', 'light', 'dark'];
const themeKey = { system: 'themeSystem', light: 'themeLight', dark: 'themeDark' } as const;

/** Language, theme and file-operation settings; every change is saved at once. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  return (
    <Dialog title={t('settings.title')} onClose={onClose}>
      <label className={styles.field}>
        <span>{t('settings.language')}</span>
        <select
          className={styles.select}
          value={settings.language ?? 'system'}
          onChange={(e) => void update({ language: e.target.value })}
        >
          <option value="system">{t('settings.languageSystem')}</option>
          {SUPPORTED_LANGUAGES.map((lng) => (
            <option key={lng} value={lng} lang={lng}>
              {t(`languages.${lng}`)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className={styles.fieldset}>
        <legend>{t('settings.theme')}</legend>
        {THEMES.map((theme) => (
          <label key={theme} className={styles.check}>
            <input
              type="radio"
              name="theme"
              value={theme}
              checked={settings.theme === theme}
              onChange={() => void update({ theme })}
            />
            {t(`settings.${themeKey[theme]}`)}
          </label>
        ))}
      </fieldset>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={settings.rewriteLinks}
          onChange={(e) => void update({ rewriteLinks: e.target.checked })}
        />
        {t('settings.rewriteLinks')}
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={settings.confirmDelete}
          onChange={(e) => void update({ confirmDelete: e.target.checked })}
        />
        {t('settings.confirmDelete')}
      </label>
      <div className={styles.buttons}>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onClose}>
          {t('dialogs.close')}
        </button>
      </div>
    </Dialog>
  );
}
````

Create `apps/desktop/src/features/dialogs/DialogHost.tsx`:

````tsx
import { useUiStore } from '../../stores/uiStore';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { MoveToDialog } from './MoveToDialog';
import { SettingsDialog } from './SettingsDialog';

/** Renders the one open dialog (uiStore). */
export function DialogHost() {
  const dialog = useUiStore((s) => s.dialog);
  const close = useUiStore((s) => s.closeDialog);
  if (!dialog) return null;
  switch (dialog.type) {
    case 'delete':
      return <ConfirmDeleteDialog path={dialog.path} onClose={close} />;
    case 'move':
      return <MoveToDialog path={dialog.path} onClose={close} />;
    case 'settings':
      return <SettingsDialog onClose={close} />;
  }
}
````

Create `apps/desktop/src/features/dialogs/Dialogs.module.css`:

````css
.backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-bg) 60%, transparent);
  z-index: 40;
}

.dialog {
  width: min(480px, calc(100% - 32px));
  max-height: calc(100% - 64px);
  overflow: auto;
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-panel);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.title {
  font: 700 20px var(--font-display);
  color: var(--color-text-strong);
  margin: 0;
  overflow-wrap: anywhere;
}

.text {
  margin: 0;
  color: var(--color-text-body);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font: 600 13px var(--font-body);
  color: var(--color-text-body);
}

.select {
  font: 400 14px var(--font-body);
  color: var(--color-text);
  background: var(--color-surface-subtle);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  padding: 6px 8px;
}

.fieldset {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 12px 12px;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.fieldset legend {
  font: 600 13px var(--font-body);
  color: var(--color-text-body);
  padding: 0 4px;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--color-text-body);
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.button {
  border: 1px solid var(--color-border-strong);
  background: var(--color-surface);
  color: var(--color-text);
  border-radius: var(--radius-md);
  padding: 9px 16px;
  font: 600 14px var(--font-body);
  min-height: 40px;
  cursor: pointer;
}

.button:hover:not(:disabled) {
  border-color: var(--color-accent);
}

.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-contrast);
}

.danger {
  background: var(--color-warn-text);
  border-color: var(--color-warn-text);
  color: var(--color-surface);
}
````

Create `apps/desktop/src/features/shell/useGlobalShortcuts.ts`:

````ts
import { useEffect } from 'react';
import { pickFolder } from '../../ipc';
import { dirFor } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

/** ⌘ (macOS) / Ctrl shortcuts (spec §3.5): ⇧E explorer, O open vault,
 * , settings, N new page, ⇧N new folder. Ignored while a dialog is open. */
export function useGlobalShortcuts(menuOpen: boolean) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (menuOpen || useUiStore.getState().dialog) return;
      const vault = useVaultStore.getState();
      const key = e.key.toLowerCase();
      if (key === ',') {
        useUiStore.getState().openDialog({ type: 'settings' });
      } else if (key === 'o' && !e.shiftKey) {
        void pickFolder()
          .catch(() => null)
          .then((path) => (path ? vault.open(path) : undefined));
      } else if (key === 'n') {
        const dir = dirFor(vault.nodes, vault.selected);
        void (e.shiftKey ? vault.createFolder(dir) : vault.createPage(dir));
      } else if (key === 'e' && e.shiftKey) {
        document
          .querySelector<HTMLElement>('[role="tree"] [role="treeitem"][tabindex="0"]')
          ?.focus();
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);
}
````

Modify `apps/desktop/src/features/shell/AppShell.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/features/shell/AppShell.tsx b/apps/desktop/src/features/shell/AppShell.tsx
index cf9fac1..89ccb9a 100644
--- a/apps/desktop/src/features/shell/AppShell.tsx
+++ b/apps/desktop/src/features/shell/AppShell.tsx
@@ -1,20 +1,37 @@
+import { useCallback, useState } from 'react';
+import { DialogHost } from '../dialogs/DialogHost';
+import { ContextMenu, type MenuState } from '../explorer/ContextMenu';
+import { requestDelete } from '../explorer/deleteFlow';
 import { PageView } from '../page/PageView';
-import type { ExplorerTreeProps } from '../explorer/ExplorerTree';
 import { Sidebar } from './Sidebar';
 import { TopBar } from './TopBar';
+import { useGlobalShortcuts } from './useGlobalShortcuts';
 import styles from './Shell.module.css';
 
-/** The open-vault layout (spec §3.4): sidebar explorer + top bar + page view. */
-export function AppShell(treeProps: ExplorerTreeProps) {
+/** The open-vault layout (spec §3.4): sidebar explorer + top bar + page view,
+ * plus the context menu, dialogs and global shortcuts. */
+export function AppShell() {
+  const [menu, setMenu] = useState<MenuState | null>(null);
+  const closeMenu = useCallback(() => {
+    const path = menu?.path;
+    setMenu(null);
+    if (path) document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
+  }, [menu]);
+  useGlobalShortcuts(menu !== null);
   return (
     <div className={styles.shell}>
-      <Sidebar {...treeProps} />
+      <Sidebar
+        onRequestDelete={requestDelete}
+        onRequestMenu={(path, anchor) => setMenu({ path, anchor })}
+      />
       <div className={styles.main}>
         <TopBar />
         <main className={styles.content}>
           <PageView />
         </main>
       </div>
+      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
+      <DialogHost />
     </div>
   );
 }
````

Modify `apps/desktop/src/features/shell/Sidebar.tsx` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/features/shell/Sidebar.tsx b/apps/desktop/src/features/shell/Sidebar.tsx
index 9e6295b..3179a12 100644
--- a/apps/desktop/src/features/shell/Sidebar.tsx
+++ b/apps/desktop/src/features/shell/Sidebar.tsx
@@ -2,7 +2,8 @@ import { useTranslation } from 'react-i18next';
 import { BrandMark, LockIcon, NewFolderIcon, NewPageIcon } from '../../app/icons';
 import { dirFor } from '../../stores/tree';
 import { useVaultStore } from '../../stores/vaultStore';
-import { ExplorerTree, type ExplorerTreeProps } from '../explorer/ExplorerTree';
+import { ExplorerDnd } from '../explorer/ExplorerDnd';
+import type { ExplorerTreeProps } from '../explorer/ExplorerTree';
 import styles from './Shell.module.css';
 
 /** Left column: brand, explorer actions, the tree and the privacy footer. */
@@ -44,7 +45,7 @@ export function Sidebar(treeProps: ExplorerTreeProps) {
         </span>
       </div>
       <nav className={styles.treeScroll}>
-        <ExplorerTree {...treeProps} />
+        <ExplorerDnd {...treeProps} />
       </nav>
       <p className={styles.sideFoot}>
         <LockIcon />
````

Modify `apps/desktop/src/theme/base.css` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/theme/base.css b/apps/desktop/src/theme/base.css
index 4693ffc..61cdf63 100644
--- a/apps/desktop/src/theme/base.css
+++ b/apps/desktop/src/theme/base.css
@@ -31,3 +31,32 @@ body {
   outline: 2px solid var(--color-focus);
   outline-offset: 2px;
 }
+
+/* Explorer context menu (rendered at the pointer / focused row). */
+.liber-menu {
+  z-index: 35;
+  min-width: 180px;
+  display: flex;
+  flex-direction: column;
+  padding: 6px;
+  background: var(--color-surface);
+  border: 1px solid var(--color-border-strong);
+  border-radius: var(--radius-md);
+  box-shadow: var(--shadow-panel);
+}
+
+.liber-menu [role='menuitem'] {
+  text-align: left;
+  border: 0;
+  background: none;
+  color: var(--color-text);
+  font: 500 14px var(--font-body);
+  padding: 8px 10px;
+  border-radius: var(--radius-sm);
+  cursor: pointer;
+}
+
+.liber-menu [role='menuitem']:hover,
+.liber-menu [role='menuitem']:focus-visible {
+  background: var(--color-accent-soft);
+}
````

Modify `apps/desktop/src/i18n/locales/en.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/i18n/locales/en.json b/apps/desktop/src/i18n/locales/en.json
index 8e26162..f2bfbae 100644
--- a/apps/desktop/src/i18n/locales/en.json
+++ b/apps/desktop/src/i18n/locales/en.json
@@ -78,5 +78,41 @@
     "truncated": "Showing the first 1 MB of this page.",
     "tags": "Tags",
     "meta": "{links, plural, one {# link} other {# links}} · {backlinks, plural, one {# backlink} other {# backlinks}}"
+  },
+  "menu": {
+    "label": "Actions for {name}",
+    "newPage": "New page",
+    "newFolder": "New folder",
+    "rename": "Rename",
+    "move": "Move to…",
+    "delete": "Delete"
+  },
+  "dialogs": {
+    "cancel": "Cancel",
+    "close": "Close",
+    "delete": {
+      "title": "Move “{name}” to Trash?",
+      "links": "{count, plural, =0 {Nothing links to it.} one {# link points to it and will break.} other {# links point to it and will break.}}",
+      "items": "{count, plural, one {It contains # item.} other {It contains # items.}}",
+      "dontAsk": "Don't ask again",
+      "confirm": "Move to Trash"
+    },
+    "move": {
+      "title": "Move “{name}”",
+      "to": "Destination folder",
+      "root": "Vault root",
+      "confirm": "Move"
+    }
+  },
+  "settings": {
+    "title": "Settings",
+    "language": "Language",
+    "languageSystem": "Same as the system",
+    "theme": "Theme",
+    "themeSystem": "Same as the system",
+    "themeLight": "Light",
+    "themeDark": "Dark",
+    "rewriteLinks": "Update links when renaming or moving",
+    "confirmDelete": "Ask before moving to Trash"
   }
 }
````

Modify `apps/desktop/src/i18n/locales/es.json` — apply this patch (`git apply`, or edit by hand):

````diff
diff --git a/apps/desktop/src/i18n/locales/es.json b/apps/desktop/src/i18n/locales/es.json
index 46e3226..a5e8b66 100644
--- a/apps/desktop/src/i18n/locales/es.json
+++ b/apps/desktop/src/i18n/locales/es.json
@@ -78,5 +78,41 @@
     "truncated": "Se muestra el primer 1 MB de esta página.",
     "tags": "Etiquetas",
     "meta": "{links, plural, one {# enlace} other {# enlaces}} · {backlinks, plural, one {# retroenlace} other {# retroenlaces}}"
+  },
+  "menu": {
+    "label": "Acciones para {name}",
+    "newPage": "Nueva página",
+    "newFolder": "Nueva carpeta",
+    "rename": "Renombrar",
+    "move": "Mover a…",
+    "delete": "Eliminar"
+  },
+  "dialogs": {
+    "cancel": "Cancelar",
+    "close": "Cerrar",
+    "delete": {
+      "title": "¿Mover «{name}» a la papelera?",
+      "links": "{count, plural, =0 {Nada enlaza a este elemento.} one {# enlace apunta aquí y se romperá.} other {# enlaces apuntan aquí y se romperán.}}",
+      "items": "{count, plural, one {Contiene # elemento.} other {Contiene # elementos.}}",
+      "dontAsk": "No volver a preguntar",
+      "confirm": "Mover a la papelera"
+    },
+    "move": {
+      "title": "Mover «{name}»",
+      "to": "Carpeta de destino",
+      "root": "Raíz de la bóveda",
+      "confirm": "Mover"
+    }
+  },
+  "settings": {
+    "title": "Ajustes",
+    "language": "Idioma",
+    "languageSystem": "Igual que el sistema",
+    "theme": "Tema",
+    "themeSystem": "Igual que el sistema",
+    "themeLight": "Claro",
+    "themeDark": "Oscuro",
+    "rewriteLinks": "Actualizar enlaces al renombrar o mover",
+    "confirmDelete": "Preguntar antes de mover a la papelera"
   }
 }
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @liber/desktop exec vitest run`

Expected: PASS: 124 tests, no warnings.

- [ ] **Step 5: Format, lint and type checks**

Run: `pnpm lint && pnpm typecheck && pnpm check:i18n`

Expected: clean; parity OK

- [ ] **Step 6: Commit**

````bash
git add apps/desktop/src
git commit -m "feat(ui): context menu, drag-and-drop moves, move/delete/settings dialogs and global shortcuts (EXP-02, EXP-03, EXP-04, NFR-10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
````

(Implementers: the trailer names the model that actually wrote the commit — M0 ruling.)

---

### Task 10: Full verification, real-window checks and the verbose M1b hand-off

**Requirements:** spec §5.3 · all M1b success criteria (§1)

**Files:**
- Create: `docs/handoff/2026-10-12-m1b-app-integration-handoff.md`

**Interfaces:**
- Consumes: everything above.
- Produces: verified build + the hand-off document (user preference: verbose, detailed enough to continue by hand).

- [ ] **Step 1: Full repository check and dependency policy**

Run: `pnpm check && cargo deny check`

Expected: PASS — Vitest 124, Rust 156 (`exp_03_trash_through_ipc` and the two M1a trash tests print `skipped: …` locally), eslint/prettier/tsc clean, `i18n OK: 2 locales in parity.`, rustfmt/clippy clean; cargo-deny `advisories ok, bans ok, licenses ok, sources ok`.

- [ ] **Step 2: Build the bundled app**

Run: `pnpm --filter @liber/desktop tauri build --debug --bundles app`

Expected: `target/debug/bundle/macos/Liber Linteum.app`.

- [ ] **Step 3: Real-window screenshots (agent: launch + screenshot only — no synthetic keystrokes or clicks)**

Run:
```bash
open -n "target/debug/bundle/macos/Liber Linteum.app"
sleep 4
screencapture -x <scratchpad>/m1b-welcome.png
pkill -f "Liber Linteum.app/Contents/MacOS"
```
Expected (view the PNG): the welcome card with **enabled** Create / Open buttons, the Notion button disabled with "Notion import arrives in a later milestone.", the version label, and a "Recent" section (empty on a fresh config dir). Opening a vault needs the native folder picker, i.e. a human — Step 4.

- [ ] **Step 4: Human checklist (the maintainer) in the real window** — copy into the hand-off with results

Prepare a disposable vault first: `cp -R fixtures/vaults/obsidian-basic /tmp/m1b-vault`.

1. Welcome → **Open a folder as vault** → pick `/tmp/m1b-vault` → the opening overlay flashes, the app shell appears: sidebar "Files · m1b-vault", tree with `Character Design`, `Game Design`, `Welcome` (no `.obsidian`, no `.trash`), top bar with `[Edit · Global view]` (Global view greyed out), Settings, Close.
2. Click `Character Design` → expands; click `rex-draft` → page view shows "Generator Rex", subtitle, `#character #redesign`, the path, an "N links · M backlinks" line and the raw Markdown.
3. Right-click `Sparda` (inside `DMC`) → menu → **Rename** → type `Dante` → Enter → toast "Updated links in 2 files"; `rex-draft` text now shows `[[Dante]]`.
4. Drag `Welcome` onto `Game Design` → it moves; drag `Game Design` onto its own child → no drop indicator.
5. Select `Game 1` → press Delete (or menu → Delete) → dialog "Move “Game 1” to Trash?" with the link count → Move to Trash → toast "Moved to Trash"; the file is in the macOS Trash.
6. In Finder, rename `/tmp/m1b-vault/Character Design/My characters.md` → the tree updates within a second; the open page follows if it was the renamed one.
7. ⌘, → Settings: switch theme Dark/Light (applies immediately), language Español (UI switches), close; quit and relaunch → settings kept; the vault is first in **Recent**.
8. Keyboard (with macOS *Keyboard navigation* OFF, then ON): ⌘⇧E focuses the tree; ↑/↓/→/← navigate; Enter opens; F2 renames; Shift+F10 opens the menu; ⌘N creates "Untitled" in inline rename; in the tree, Space picks up the focused item, arrows move, Space drops (dnd-kit keyboard drag). Record what Tab reaches in each mode.
9. Close vault → welcome; **Recent** lists the vault; remove it with ×.

- [ ] **Step 5: Write the verbose M1b hand-off**

Create `docs/handoff/2026-10-12-m1b-app-integration-handoff.md` in the style of the M0 and M1a hand-offs (read them first). Required sections, in this order:

1. **Status at a glance** — what M1b delivers; test counts per crate/suite from Step 1; what was verified in the real window (Steps 3–4 with results) and what was not; what is not done (M2 editor, M3 Global View, M5 search, …).
2. **Document map** — product spec, architecture, M1a/M1b specs, this plan, M0/M1a hand-offs.
3. **Backend map** — every command (args → result, errors), events, `AppState`, `AppDirs`/`configure`, settings file format (with an example), the permission checklist for adding a command.
4. **Frontend map** — `src/ipc` (incl. `ipcCall`, `testing.ts`), each store's state and actions, each component and what it renders, the keyboard model and shortcuts, i18n keys added.
5. **Flows** — open/create, explorer operations (create, rename, move by drag and dialog, delete with confirmation), external changes (coalescing, page follow/deleted), close/switch — with the exact files involved.
6. **Recipes** — add a command end-to-end (Rust fn → `configure` → `build.rs` → capability → `src/ipc` → store → component → tests), add a setting, add a dialog, add a context-menu action, add a shortcut.
7. **Tests inventory** — every test file and what it pins (requirement IDs and Review Focus), how to run focused tests, which tests touch the OS trash.
8. **Rulings made on your behalf** — every "Plan note" below plus any ruling the executing controller recorded, each with what it costs if wrong.
9. **Known gaps / deferred** — at least: dnd-kit keyboard drag and pointer DnD verified only by hand; no undo; no multi-window; `.liber/vault.json` still not written; page view is raw Markdown until M2; remaining M1a minors (M1a hand-off §11 j–m, p–s).
10. **Troubleshooting** — settings reset (`settings.json.bad`), stale tree, a command "not allowed" (permission checklist), pnpm release-age gate, `pnpm build:ui` before cargo, tests that need `LIBER_TRASH_TESTS=1`.

- [ ] **Step 6: Commit**

````bash
git add docs/handoff/2026-10-12-m1b-app-integration-handoff.md
git commit -m "docs: verbose M1b hand-off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
````

---

## Plan notes (rulings and deviations from the spec)

Each note was forced by something found while building and testing the replay; the spec remains binding elsewhere.

1. **Task order:** the explorer tree (Task 7) comes before the app shell (Task 8), so the shell renders the real tree instead of a placeholder. Cost if wrong: none (same deliverables).
2. **`configure(builder, Option<AppDirs>)`** (spec §2.2 said only "one app state per window"). Tests pass temp config/cache dirs so they never read or write the user's settings; with known dirs the state is managed on the builder directly because the mock runtime does not run `setup` during `build()`. `AppState` gains `cache_dir` (needed by `vault_open`).
3. **`VaultSession::backlinks_into`** was added to `liber-session` so `backlink_count` on a folder counts links from *outside* the folder into it (links between files inside the folder don't break when the folder is trashed).
4. **`page_get` for a non-UTF-8 `.md`**: such files are indexed as attachments, so the command reads the bytes first and returns `binary: true` (title = file stem) instead of `notFound`; other non-page paths return `notFound`.
5. **Settings:** `SettingsPatch.language = "system"` means "follow the OS" (JSON can't express "set to null" in an optional patch field without a custom deserializer); unknown keys are kept via `#[serde(flatten)] extra` and `version` is never downgraded (Review Focus 4); `openedAt` is RFC 3339 UTC from a small built-in formatter (no date crate).
6. **Inline-rename state lives in `vaultStore.renaming`** rather than `uiStore` (spec §3.3 listed it under `uiStore`): creating a page and starting its rename must happen atomically with the tree refresh and selection. Cost if wrong: one field in a different store.
7. **`src/ipc/testing.ts`** re-exports Tauri's `emit`/`mockIPC`/`clearMocks` so tests outside `src/ipc/` keep the strict "backend only through `src/ipc/`" lint rule.
8. **Drag-and-drop:** dnd-kit's keyboard sensor uses Space to pick up and drop (Enter stays "open" in the tree); only dnd-kit's *listeners* are spread on tree rows (its attributes would replace `role="treeitem"` and the roving tabindex). jsdom has no layout, so gestures are verified by hand (Task 10 Step 4); the rules (`planDrop`) and the handler (`dropEntry`) are unit-tested.
9. **Welcome language toggle** switches the UI immediately and then persists via `settings_set` (works in a plain browser too, where saving fails silently).
10. **M0 leftovers removed:** `ScreenRouter`, `GlobalViewScreen`, `EditorScreen` and the `screens.*` / `welcome.comingSoon` keys; the "renders outside Tauri" test moved to `App.test.tsx`.
11. **Store robustness:** `safeUnlisten` swallows unsubscribe failures (the event runtime may be gone in a browser or at test teardown); `pageStore.load` and `vaultStore.refreshTree` discard stale responses with sequence numbers.

## Self-review

- **Spec coverage:** §1 criteria → 1: Tasks 3, 6 (+ VLT-02 via `vault_create` test and M1a); 2: Tasks 3, 5, 7, 9; 3: Tasks 3, 8; 4: Tasks 1, 3, 5; 5: Tasks 2, 3, 5, 6, 9; 6: Tasks 7, 8, 9 (+ Task 10 human checklist); 7: Task 3 (ACL test, `dialog:allow-open` only, cargo deny). §2.1–2.8 → Tasks 1–3; §3.1–3.6 → Tasks 4–9; §4.1–4.4 → Tasks 5, 6, 8, 9; §5.1 → Tasks 1–3; §5.2 → Tasks 4–9; §5.3 → Task 10. §6 respected (no editor, Global View, search, multi-window, undo).
- **Placeholders:** none — every code step is the exact file or patch from the replay commit; Task 10's hand-off is an outline by design because it records results only the executor and the maintainer can observe.
- **Type consistency:** checked mechanically — each task's code compiled and ran against the previous tasks' real code in the replay.
- **Review Focus:** five items, each pinned by a named test in its owning task.
