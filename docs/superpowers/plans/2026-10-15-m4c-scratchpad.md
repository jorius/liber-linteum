# M4c Stream S — Scratchpad Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a quick note without setting anything up: in the open vault's own scratch folder (pinned at the top of the explorer), or — with no vault open — in a global Scratchpad folder chosen on first use and opened as an ordinary vault labelled "Quick notes". New notes are named after their first line until you rename them yourself.

**Architecture:** Rust owns every path and every name. The Scratchpad's folder reaches `settings.json` only through `scratchpad_set`, which accepts the default location or the folder the user just picked in a dialog Rust opened; `scratchpad_open` takes no path from the page. Quick notes are created (in a folder the command picks: the vault's `scratchpadFolder`, default `Scratchpad/`, or the global Scratchpad's root) and auto-renamed by `liber-session` (`.liber/vault.json` `autoNamed`), which reads the saved file and derives the name itself (`liber-markdown::first_line_text`). The UI adds a Welcome button, File → New Quick Note (⌘⇧N), a first-use dialog, the recent-list entry, the pinned scratch folder in the explorer, two Settings rows, and an idle/blur watcher that asks Rust to rename.

**Tech Stack:** Rust (liber-markdown, liber-vault, liber-session, Tauri 2 desktop crate, tauri-plugin-dialog), React 19 + zustand, Vitest + Testing Library + axe, Playwright (Chromium + WebKit).

**Spec:** `docs/superpowers/specs/2026-10-14-m4c-scratchpad-design.md` §2, §4 "Picked folders", §5 (Scratchpad parts). Amendments from this planning are §7 of the same file, including Jose's 2026-10-15 addition: a scratch folder in every vault.

## Global Constraints

- Every command async via `blocking()`, with real-ACL tests (allowed from `main`, denied elsewhere).
- i18n en + es (key parity is checked by `pnpm check:i18n`).
- axe-clean (light and dark), keyboard parity.
- Safari 15 floor: no regex lookbehind, no `color-mix()`, no `structuredClone`, no `Array.prototype.at`/`findLast`.
- No network. No path from the page is trusted for the Scratchpad.
- Never touch the user's real `~/Documents` or `~/Library/Application Support/app.liberlinteum.desktop` from tests: the default location and the folder dialog are injectable.
- Shared files (`lib.rs`, `menu.rs`, `build.rs`, `capabilities/main.json`, i18n JSON, `ipc/index.ts`, `e2e/ipcMock.ts`, Welcome) get small, additive edits; new code lives in `scratchpad_commands.rs`, `liber-session/src/quick_notes.rs`, `liber-vault/src/auto_named.rs`, `liber-markdown/src/first_line.rs` and `src/features/scratchpad/`.
- Signed commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **⌘⇧N fires twice** (the macOS menu accelerator and the page's own handler, or key repeat): exactly one quick note per press. Test in Task 7 (`newQuickNote` ignores a second trigger within 1 s and `e.repeat`).
2. **Typing resumes while an auto-rename runs:** the note ends up named after its latest first line; no text is lost; a rename never runs twice at once. Test in Task 9 (a settle during an in-flight rename re-runs once afterwards).
3. **Two notes with the same first line, or a note already holding its deduplicated name:** the second becomes `Name 1`; re-deriving `Name` for the note called `Name 1` is a no-op, not a ping-pong. Test in Task 3.
4. **The Scratchpad folder was deleted or its drive is gone:** `scratchpad_open` creates it again; when it can't, the user gets an error and the first-use dialog to choose another folder. Tests in Task 4 (recreate) and Task 7 (failure opens the dialog).
5. **The scratch folder renamed or moved in the explorer, or renamed in Settings:** it stays the pinned scratch folder (the setting follows a top-level rename; Settings renames it on disk with link rewrites); notes already there stay. Tests in Tasks 2 and 4.
6. **A first line with nothing usable** (`# `, `---`, `[[]]`, `![[x.png]]`, only forbidden characters, a Windows device name such as `CON`): the generated name stays. Tests in Tasks 1 and 3.

---

## File structure

**Rust**
- Create `crates/liber-markdown/src/first_line.rs` — `first_line_text(source) -> Option<String>`: the visible text of the body's first non-blank line.
- Create `crates/liber-vault/src/scratch.rs` — in `.liber/vault.json`: the `autoNamed` array (read, set, forget) and `scratchpadFolder` (read, set, follow renames).
- Create `crates/liber-session/src/quick_notes.rs` — `create_quick_note(dir, base)`, `auto_name`, `quick_note_stem`, `set_scratch_folder`.
- Modify `crates/liber-session/src/global_view.rs` (`follow_layout`) and `session.rs` (`forget_page_sizes`): renamed or removed paths lose their flag; a top-level rename of the scratch folder moves the setting.
- Create `apps/desktop/src-tauri/src/scratchpad_commands.rs` — `ScratchpadState` and the eight commands.
- Modify `settings.rs` (`scratchpad_path`, `set_scratchpad_path`, recent `scratchpad` flag), `dto.rs` (`VaultInfo.scratchpad`), `vault_commands.rs` (`open_session` sets the flag; made `pub(crate)`), `menu.rs` (File → New Quick Note), `lib.rs`, `build.rs`, `capabilities/main.json`.
- Create `apps/desktop/src-tauri/tests/scratchpad.rs`; extend `tests/menu.rs`.

**TypeScript**
- Modify `src/ipc/index.ts` (types + commands + event), `src/stores/settingsStore.ts` (default), `src/stores/vaultStore.ts` (`openScratchpad`, the "Quick notes" name, `applyRename` extracted from `rename`), `src/stores/uiStore.ts` (dialog type), `src/features/dialogs/DialogHost.tsx` (renders nothing for it), `src/features/shell/useGlobalShortcuts.ts` (⌘⇧N leaves New folder), `src/app/App.tsx` (mounts the host), `src/features/welcome/Welcome.tsx`, `RecentList.tsx`, `src/features/dialogs/SettingsDialog.tsx` (one row).
- Create `src/features/scratchpad/`: `quickNote.ts` (+ test), `scratchpadStore.ts`, `ScratchpadSetupDialog.tsx` (+ test), `ScratchpadHost.tsx`, `ScratchpadLocation.tsx` (+ test), `ScratchFolderSetting.tsx` (+ test), `autoName.ts` (+ test), `QuickNoteIcon.tsx`, `Scratchpad.module.css`.
- Modify `src/features/explorer/ExplorerTree.tsx`, `TreeRow.tsx`, `Explorer.module.css` (the pinned scratch folder) and `src/features/dialogs/VaultSettingsSection.tsx` (one row).
- Create `e2e/m4c-scratchpad.spec.ts`; extend `e2e/ipcMock.ts`, `playwright.config.ts` (WebKit `testMatch`).

---

### Task 1: The first line's visible text (liber-markdown)

**Files:**
- Create: `crates/liber-markdown/src/first_line.rs`
- Modify: `crates/liber-markdown/src/lib.rs` (module + `pub use first_line::first_line_text;`)

**Interfaces:**
- Produces: `pub fn first_line_text(source: &str) -> Option<String>` — the body after the frontmatter (and a BOM), first line that isn't blank; Markdown flattened (heading marks, list and quote markers, task boxes, emphasis, strike, inline code kept as its text, `[text](url)` → `text`, `![alt](x)` → nothing, `[[target|alias]]` → `alias`, `[[target#h]]` → `target`, `![[embed]]` → nothing, `#tag` → `tag`, raw HTML tags dropped); whitespace collapsed; `None` when nothing is left.

- [ ] **Step 1: Write the failing tests** (in `first_line.rs` `#[cfg(test)] mod tests`)

```rust
#[test]
fn m4c_plain_and_heading_lines() {
    assert_eq!(first_line_text("Shopping list\nmilk").as_deref(), Some("Shopping list"));
    assert_eq!(first_line_text("# Meeting *notes*\n").as_deref(), Some("Meeting notes"));
    assert_eq!(first_line_text("## **Big**   idea").as_deref(), Some("Big idea"));
}

#[test]
fn m4c_after_frontmatter_bom_and_blank_lines() {
    assert_eq!(first_line_text("---\ntags: [a]\n---\n\n  \nIdea").as_deref(), Some("Idea"));
    assert_eq!(first_line_text("\u{FEFF}Hello").as_deref(), Some("Hello"));
}

#[test]
fn m4c_markers_links_and_tags_are_flattened() {
    assert_eq!(first_line_text("- [ ] call [Ana](https://x.y) about #work").as_deref(),
        Some("call Ana about work"));
    assert_eq!(first_line_text("> see [[Projects/Plan#Goals|the plan]] `v2`").as_deref(),
        Some("see the plan v2"));
    assert_eq!(first_line_text("1. [[Recipes]] and <b>bold</b>").as_deref(), Some("Recipes and bold"));
}

#[test]
fn m4c_nothing_usable_is_none() {
    for s in ["", "\n\n", "# ", "---\na: 1\n---\n", "![[x.png]]", "![](a.png)", "```js", "---"] {
        assert_eq!(first_line_text(s), None, "{s:?}");
    }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p liber-markdown first_line`
Expected: FAIL (module/function missing).

- [ ] **Step 3: Implement**

```rust
//! The visible text of a note's first line (M4c §2): quick notes are named
//! after it until the user renames them.
use crate::frontmatter;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

pub fn first_line_text(source: &str) -> Option<String> {
    let body = match frontmatter::split(source) {
        Some((_, start)) => &source[start..],
        None => &source[frontmatter::text_start(source)..],
    };
    let line = body.lines().map(str::trim).find(|l| !l.is_empty())?;
    // A thematic break or a fence opener is no text.
    let flat = flatten_wikilinks(line);
    let mut out = String::new();
    let mut in_image = 0usize;
    for event in Parser::new_ext(&flat, Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH) {
        match event {
            Event::Start(Tag::Image { .. }) => in_image += 1,
            Event::End(TagEnd::Image) => in_image = in_image.saturating_sub(1),
            Event::Text(t) | Event::Code(t) if in_image == 0 => out.push_str(&t),
            Event::SoftBreak | Event::HardBreak => out.push(' '),
            _ => {}
        }
    }
    let text = strip_tags(&out).split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}
```

`flatten_wikilinks(line)`: scans for `![[…]]` (removed) and `[[…]]` (replaced by the alias after `|`, else the target up to `#`/`^`), leaving everything else. `strip_tags(text)`: drops `#` at the start of a word when followed by a letter, digit, `_`, `-` or `/` (tags). (Raw HTML tags are `Event::Html`/`InlineHtml` and never reach `out`.)

- [ ] **Step 4: Run them to see them pass**

Run: `cargo test -p liber-markdown first_line`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit** — `feat(markdown): the visible text of a note's first line (M4c §2)`

---

### Task 2: `autoNamed` and `scratchpadFolder` in `.liber/vault.json` (liber-vault)

**Files:**
- Create: `crates/liber-vault/src/scratch.rs`; test file `crates/liber-vault/tests/scratch.rs`
- Modify: `crates/liber-vault/src/lib.rs` (`mod scratch; pub use scratch::DEFAULT_SCRATCH_FOLDER;`)

**Interfaces:**
- Produces (on `Vault`):
  - `pub fn auto_named(&self) -> BTreeSet<String>` — re-read on every call; non-string entries ignored.
  - `pub fn set_auto_named(&self, path: &str, on: bool) -> Result<()>` — no write when nothing changes; an emptied list removes the key; every other key kept.
  - `pub fn forget_auto_named(&self, paths: &[String]) -> Result<()>` — drops entries equal to or inside any of `paths`; one write, none when nothing dropped.
  - `pub const DEFAULT_SCRATCH_FOLDER: &str = "Scratchpad";`
  - `pub fn scratch_folder(&self) -> String` — `scratchpadFolder`, else the default; a value that isn't a usable top-level name (empty, hidden, a `/`, a refused character) reads as the default.
  - `pub fn set_scratch_folder(&self, name: &str) -> Result<()>` — the default clears the key.
  - `pub fn follow_scratch_folder(&self, renames: &[(String, String)]) -> Result<()>` — a rename of the folder to another top-level name moves the setting; a move into a folder leaves it.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn m4c_auto_named_round_trip_keeps_other_keys() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    std::fs::write(dir.path().join(".liber/vault.json"), r#"{"version":1,"pageWidth":"full"}"#).unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    vault.set_auto_named("Quick note 1.md", true).unwrap();
    vault.set_auto_named("Quick note 2.md", true).unwrap();
    assert_eq!(vault.auto_named().into_iter().collect::<Vec<_>>(), ["Quick note 1.md", "Quick note 2.md"]);
    vault.set_auto_named("Quick note 1.md", false).unwrap();
    vault.forget_auto_named(&["Quick note 2.md".into()]).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.path().join(".liber/vault.json")).unwrap()).unwrap();
    assert_eq!(json, serde_json::json!({"version": 1, "pageWidth": "full"}));
}

#[test]
fn m4c_forgetting_a_folder_drops_the_notes_inside_it_and_nothing_else() { /* "F/a.md","F/b.md","Fx.md" → forget ["F"] → ["Fx.md"] */ }

#[test]
fn m4c_unchanged_lists_are_not_rewritten() { /* set false on a missing entry → no .liber dir created */ }

#[test]
fn m4c_hand_edited_garbage_is_ignored() { /* "autoNamed": ["a.md", 3, null] → {"a.md"}; "scratchpadFolder": "../x" / ".hid" / 3 → "Scratchpad" */ }

#[test]
fn m4c_scratch_folder_defaults_is_set_and_follows_top_level_renames() {
    /* default "Scratchpad"; set "Inbox" → "Inbox"; renames [("Inbox","Drafts")] → "Drafts";
       renames [("Drafts","Archive/Drafts")] → still "Drafts"; set "Scratchpad" → key removed */
}
```

- [ ] **Step 2: Run them to see them fail** — `cargo test -p liber-vault --test scratch` → FAIL (no such methods).

- [ ] **Step 3: Implement** with `read_json(self.root(), LIBER_JSON, …)` for reads and `self.update_json_object(LIBER_JSON, create, |map| …)` for writes (sorted, de-duplicated array; `map.remove("autoNamed")` when empty).

- [ ] **Step 4: Run them to see them pass** — PASS (5 tests).

- [ ] **Step 5: Commit** — `feat(vault): autoNamed quick notes and the scratch folder in .liber/vault.json (M4c §2, §7)`

---

### Task 3: Creating and auto-naming quick notes (liber-session)

**Files:**
- Create: `crates/liber-session/src/quick_notes.rs`
- Modify: `crates/liber-session/src/lib.rs` (`mod quick_notes; pub use quick_notes::{AutoName, MAX_QUICK_NAME, quick_note_stem};`), `global_view.rs` (`follow_layout`: `self.vault.forget_auto_named(&froms)`), `session.rs` (`forget_page_sizes`: `self.vault.forget_auto_named(removed)`)

**Interfaces:**
- Consumes: `first_line_text` (Task 1); `auto_named`, `set_auto_named`, `forget_auto_named` (Task 2).
- Produces:
  - `pub const MAX_QUICK_NAME: usize = 60;`
  - `pub fn quick_note_stem(text: &str) -> Option<String>` — `first_line_text`, refused characters → `-` (`sanitize_file_name` rules, leading dot too), cut to 60 characters, trimmed; `None` when empty, only dashes, or a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`).
  - `impl VaultSession { pub fn create_quick_note(&self, dir: &VaultPath, base: &str) -> Result<VaultPath> }` — in `dir` (created with its parents when missing, and indexed): `base.md`, else `base 1.md`, `base 2.md`… (create-only writes); flags it (a failed flag write is a `Warning` event, the note stays). One path serves the global Scratchpad (`dir` = root) and every vault's scratch folder.
  - `impl VaultSession { pub fn set_scratch_folder(&self, name: &str, rewrite_links: bool) -> Result<Option<RenameOutcome>> }` — validates the name (`validate_name`, top-level, not `.liber`/`.obsidian`); when the current folder exists and `name` is free, renames it on disk (links rewritten as the setting says) and returns the outcome; when `name` is an existing folder, adopts it; a file of that name → `AlreadyExists`; then stores the setting.
  - `pub struct AutoName { pub path: VaultPath, pub renamed: Option<RenameOutcome>, pub auto_named: bool }`
  - `impl VaultSession { pub fn auto_name(&self, path: &VaultPath, rewrite_links: bool) -> Result<AutoName> }` — not flagged → unchanged, `auto_named: false`; reads the saved file; no usable stem → unchanged; target = first free of `stem`, `stem 1`, … in the same folder (case-insensitive, the note itself doesn't count); target equal to the note (ignoring case) → unchanged; else `rename` and flag the new path.
  - Renames (in-app or seen by the watcher) and removals drop the flags of the paths they touch.

- [ ] **Step 1: Write the failing tests** (`quick_notes.rs` tests, with a temp vault opened by `VaultSession::open`)

```rust
#[test] fn m4c_quick_notes_are_deduplicated_and_flagged() { /* create twice with the same base at the root → "Q.md", "Q 1.md"; both in vault.auto_named() */ }
#[test] fn m4c_a_vault_scratch_folder_is_created_on_first_use() { /* no "Scratchpad/" → create_quick_note(Scratchpad, "Q") → "Scratchpad/Q.md", the folder indexed */ }
#[test] fn m4c_renaming_the_scratch_folder_from_settings() { /* folder with a note linked from elsewhere → set_scratch_folder("Inbox") → folder renamed, link rewritten, setting "Inbox"; "Taken" folder exists → adopted, nothing moved; a file named "Taken2" → AlreadyExists; ".liber" → InvalidName */ }
#[test] fn m4c_auto_name_follows_the_first_line() { /* write "# Groceries\nmilk" to Q.md → auto_name → path "Groceries.md", renamed Some, auto_named true; flag moved */ }
#[test] fn m4c_same_first_line_gets_a_number_and_does_not_ping_pong() { /* A.md "Idea", B.md "Idea" → "Idea.md", "Idea 1.md"; auto_name("Idea 1.md") again → unchanged, renamed None */ }
#[test] fn m4c_nothing_usable_keeps_the_generated_name() { /* "", "# ", "CON", "![[x.png]]", "///" → unchanged */ }
#[test] fn m4c_unflagged_notes_are_never_renamed() { /* plain page → auto_named false, file untouched */ }
#[test] fn m4c_a_manual_rename_or_delete_drops_the_flag() { /* rename(Q.md → Mine.md) → auto_named() empty; flagged R.md trashed via the plain-removal hook → empty */ }
#[test] fn m4c_stem_rules() {
    assert_eq!(quick_note_stem("a/b: c?").as_deref(), Some("a-b- c-"));
    assert_eq!(quick_note_stem(".hidden").as_deref(), Some("-hidden"));
    assert_eq!(quick_note_stem(&"x".repeat(80)).map(|s| s.chars().count()), Some(60));
    assert_eq!(quick_note_stem("com3"), None);
    assert_eq!(quick_note_stem("|||"), None);
}
```

- [ ] **Step 2: Run them to see them fail** — `cargo test -p liber-session quick_notes` → FAIL.
- [ ] **Step 3: Implement** as described in Interfaces.
- [ ] **Step 4: Run them to see them pass** — PASS (9 tests); `cargo test -p liber-session` stays green.
- [ ] **Step 5: Commit** — `feat(session): quick notes named after their first line (M4c §2)`

---

### Task 4: Scratchpad commands, settings and the folder grant (desktop crate)

**Files:**
- Create: `apps/desktop/src-tauri/src/scratchpad_commands.rs`, `apps/desktop/src-tauri/tests/scratchpad.rs`
- Modify: `settings.rs`, `dto.rs`, `vault_commands.rs`, `lib.rs`, `build.rs`, `capabilities/main.json`

**Interfaces:**
- Consumes: Task 3's session API.
- Produces (commands, camelCase JSON):
  - `scratchpad_default() -> String` — `<Documents>/Liber Linteum/Scratchpad` (test override via `ScratchpadState::set_default_dir`).
  - `scratchpad_choose() -> Option<String>` — a folder dialog Rust opens (test override `set_folder_picker`); the pick is granted for `scratchpad_set`.
  - `scratchpad_set(path: String) -> Settings` — only the default or the granted pick; creates the folder and its parents; stores the canonical path in `scratchpadPath`; `notPermitted` otherwise.
  - `scratchpad_open() -> VaultInfo` — opens `scratchpadPath` (created again if missing); `notFound` when none is set.
  - `quick_note_create(name: String) -> String` — in the open vault's scratch place, which Rust picks: the global Scratchpad's root when that is the open vault, else the vault's scratch folder (created on first use). No folder comes from the page.
  - `quick_note_autoname(path: String) -> AutoNameDto { path, autoNamed, outcome: RenameOutcomeDto | null }`.
  - `quick_notes_state() -> { folder: string | null, autoNamed: string[] }` — `folder` is `null` in the global Scratchpad (its root is the scratch place).
  - `scratch_folder_set(name: String) -> { folder, from: string | null, outcome: RenameOutcomeDto | null }` — Settings → This vault.
  - `Settings.scratchpad_path: Option<String>` (`scratchpadPath`), not in `SettingsPatch`; `SettingsStore::set_scratchpad_path`.
  - `RecentVaultDto.scratchpad: bool`; `VaultInfo.scratchpad: bool`.

- [ ] **Step 1: Write the failing tests** (`tests/scratchpad.rs`, real context, mock runtime, temp dirs; the default dir and picker are overridden through `app.state::<ScratchpadState>()`)

```rust
#[test] fn m4c_scratchpad_commands_are_allowed_from_main_and_denied_elsewhere() { /* each of the 7 from "main": not a permission error; from "other": error naming the command */ }
#[test] fn m4c_first_use_with_the_default_creates_and_opens_the_scratchpad() { /* settings scratchpadPath null → scratchpad_default → scratchpad_set(default) → folder exists, settings has it → scratchpad_open → info.scratchpad true; vaults_recent marks it scratchpad */ }
#[test] fn m4c_scratchpad_set_refuses_a_path_the_user_did_not_pick() { /* scratchpad_set("/tmp/elsewhere") → notPermitted, nothing created; after scratchpad_choose picks X → scratchpad_set(X) ok */ }
#[test] fn m4c_settings_set_cannot_change_the_scratchpad() { /* settings_set {scratchpadPath: "/x"} → ignored */ }
#[test] fn m4c_a_deleted_scratchpad_folder_is_created_again() { /* set, remove dir, scratchpad_open → ok, dir exists */ }
#[test] fn m4c_quick_notes_go_to_the_open_vaults_scratch_place_and_are_auto_named_over_ipc() { /* ordinary vault → quick_note_create("Quick note X") → "Scratchpad/Quick note X.md"; page_write "# Trip" → quick_note_autoname → "Scratchpad/Trip.md", autoNamed true; quick_notes_state = {folder: "Scratchpad", autoNamed: [..]}; entry_rename → list empty; global scratchpad → note at its root, folder null */ }
#[test] fn m4c_scratch_folder_set_over_ipc() { /* rename "Scratchpad" → "Inbox" with a note inside → outcome moved; state folder "Inbox"; invalid name → invalidName */ }
```

- [ ] **Step 2: Run them to see them fail** — `cargo test -p liber-desktop --test scratchpad` → FAIL (commands not registered).
- [ ] **Step 3: Implement** (`ScratchpadState` managed in `configure`; commands registered in `lib.rs`, listed in `build.rs`, `allow-…` in `capabilities/main.json`; `open_session` made `pub(crate)` and sets `scratchpad` by comparing the canonical root with the stored path).
- [ ] **Step 4: Run them to see them pass** — PASS; `cargo test -p liber-desktop` green (the M1b "every command" list is untouched; this stream's list lives in `tests/scratchpad.rs`).
- [ ] **Step 5: Commit** — `feat(desktop): the Scratchpad folder, its grant and quick-note commands (M4c §2, §4)`

---

### Task 5: File → New Quick Note (menu)

**Files:** Modify `apps/desktop/src-tauri/src/menu.rs`, `apps/desktop/src-tauri/tests/menu.rs`

**Interfaces:**
- Produces: `pub const QUICK_NOTE_ID: &str = "liber-quick-note"; pub const QUICK_NOTE_EVENT: &str = "menu:quickNote";` A File submenu (after the app menu) with **New Quick Note** (`CmdOrCtrl+Shift+N`). The event goes to the `main` window, which is shown and focused first.

- [ ] **Step 1: Failing test** — `quick_note_item_emits_menu_quick_note()` in `tests/menu.rs` (listen, fire `QUICK_NOTE_ID`, expect one event); the macOS outline test expects a "File" menu holding "New Quick Note".
- [ ] **Step 2: Run** — `cargo test -p liber-desktop --test menu` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(menu): File → New Quick Note, ⌘⇧N (M4c §2)`

---

### Task 6: IPC, stores and the "Quick notes" vault (TS)

**Files:** Modify `src/ipc/index.ts`, `src/stores/settingsStore.ts`, `src/stores/vaultStore.ts`; create `src/features/scratchpad/scratchpadStore.ts` (+ tests in `scratchpad.test.ts`)

**Interfaces:**
- Produces:
  - ipc: `scratchpadDefault()`, `scratchpadChoose()`, `scratchpadSet(path)`, `scratchpadOpen()`, `quickNoteCreate(name)`, `quickNoteAutoname(path)`, `quickNotesState()`, `scratchFolderSet(name)`, `onMenuQuickNote(cb)`; `Settings.scratchpadPath: string | null`; `VaultInfo.scratchpad?: boolean`; `RecentVault.scratchpad?: boolean`; `AutoName { path; autoNamed; outcome: RenameOutcome | null }`.
  - vaultStore: `openScratchpad(): Promise<IpcResult<VaultInfo>>`; a Scratchpad's `info.name` is `t('scratchpad.title')`; `applyRename(from, to, outcome)` (what `rename` did after a successful `entry_rename`, now shared).
  - scratchpadStore: `useScratchpadStore` with `folder: string | null` (the open vault's scratch folder; `null` in the global Scratchpad or with no vault), `autoNamed: Set<string>`, `load()`, `add(path)`, `moved(from, to)`, `drop(path)`; loads whenever a vault opens, clears when it closes.
- [ ] Steps: failing tests (openScratchpad flags and names the vault; `applyRename` keeps `rename`'s behaviour — existing vaultStore tests stay green), implement, pass, commit `feat(scratchpad): IPC and stores for the Scratchpad (M4c §2)`.

---

### Task 7: New Quick Note — the action, the first-use dialog, ⌘⇧N and the Welcome button

**Files:** Create `src/features/scratchpad/quickNote.ts`, `ScratchpadSetupDialog.tsx`, `ScratchpadHost.tsx`, `QuickNoteIcon.tsx`, `Scratchpad.module.css` (+ `quickNote.test.tsx`, `ScratchpadSetupDialog.test.tsx`); modify `uiStore.ts`, `DialogHost.tsx`, `App.tsx`, `useGlobalShortcuts.ts`, `Welcome.tsx`, i18n en/es.

**Interfaces:**
- Produces: `newQuickNote(): Promise<void>`; `quickNoteName(date, t)` → `Quick note 2026-10-15 09.05` (es: `Nota rápida …`); uiStore dialog `{ type: 'scratchpadSetup'; then: 'quickNote' | 'none' }`; `useQuickNoteEntry()` (⌘⇧N / Ctrl+Shift+N on every screen + the menu event).
- Behaviour: with a vault open (any, the global Scratchpad included) → `quick_note_create` in its scratch place, no vault switch; with none (Welcome) → no `scratchpadPath` → the setup dialog, then open the global Scratchpad and create the note; then refresh the tree, expand the scratch folder, open the page with the cursor at its start; a failed open → toast + the setup dialog; a second trigger within 1 s, key repeat, or one while a vault is opening → ignored. The Welcome button always uses the global Scratchpad.
- ⌘⇧N no longer creates a folder (ruling in spec §7); New folder stays on the explorer button and context menu.
- [ ] Steps: failing tests (setup dialog: default path shown, Choose folder… replaces it, Create stores it and continues, Cancel does nothing, axe-clean, keyboard; `newQuickNote` paths above; ⌘⇧N in the shell no longer calls `entry_create_folder`), implement, pass, commit `feat(scratchpad): New Quick Note from the Welcome screen, the menu and ⌘⇧N (M4c §2)`.

---

### Task 8: The pinned scratch folder, Quick notes in the recent list, and the Settings rows

**Files:** Modify `ExplorerTree.tsx`, `TreeRow.tsx`, `Explorer.module.css`, `RecentList.tsx`, `SettingsDialog.tsx` (one row), `VaultSettingsSection.tsx` (one row); create `ScratchpadLocation.tsx`, `ScratchFolderSetting.tsx` (+ tests).

- Explorer: the vault's scratch folder, once it exists, is the first row of the tree with a pencil icon, a note count (pages inside it at any depth; `aria-label` "Scratchpad, quick notes, 3 notes"), and a divider under it and its open contents. It behaves as any folder otherwise (expand, rename, menu, drop target). Not shown in the global Scratchpad (its root is the scratch place).
- Settings → This vault: "Quick notes folder" with a text field (the name, validated with `validateName`), saved on Enter or blur through `scratch_folder_set`; a rename on disk is applied like any rename. Hidden in the global Scratchpad.

- Recent entry flagged `scratchpad`: its own icon, the name "Quick notes", opened through `openScratchpad()`.
- Settings → Files: "Quick notes folder" with the path (or "Chosen the first time you take a quick note") and **Change…** / **Choose…** (`scratchpadChoose` → `scratchpadSet`); existing notes stay where they are.
- [ ] Steps: failing tests, implement, pass, commit `feat(scratchpad): Quick notes in the recent list and Settings → Files (M4c §2)`.

---

### Task 9: Naming from the first line while you type

**Files:** Create `src/features/scratchpad/autoName.ts` (+ `autoName.test.ts`); mount from `ScratchpadHost`.

**Interfaces:**
- Produces: `installAutoName(): () => void`; `AUTO_NAME_IDLE_MS = 2000`.
- Behaviour: for the open page while it is in `autoNamed`: every save restarts a timer of `AUTO_NAME_IDLE_MS - AUTOSAVE_MS` (the save itself waits `AUTOSAVE_MS` after the last keystroke); typing (the page turning dirty) cancels it; the editor losing focus, or another page opening, runs it at once. A run flushes, calls `quick_note_autoname`, and applies a rename like `vaultStore.rename` does; runs never overlap, and a trigger during a run re-runs once afterwards. Failures are quiet (the name simply stays).
- [ ] Steps: failing tests with fake timers (2 s after the last save → one call; typing in between → none; blur → immediate; overlapping → one re-run; not flagged → none; rename result moves the editor and the set), implement, pass, commit `feat(scratchpad): quick notes take their first line's name (M4c §2)`.

---

### Task 10: End to end, amendments and the gate

**Files:** Create `e2e/m4c-scratchpad.spec.ts`; modify `e2e/ipcMock.ts` (scratchpad handlers behind a `scratchpad` option), `playwright.config.ts` (WebKit `testMatch`); spec §7.

- E2E (Chromium + WebKit): Welcome → Quick note → the dialog → Create → the editor has focus in an empty note → type `# Groceries` → after the idle delay the explorer and title show "Groceries"; ⌘⇧N in the open Scratchpad makes a second note.
- Full gate `check.sh all` → ALL-OK; dev-server boot check in Chromium and WebKit.
- [ ] Commit `test(e2e): a quick note from the Welcome screen, named after its first line (M4c)`.
