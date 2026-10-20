# M4c — Scratchpad, a scratch folder in every vault, and single-file windows: Hand-off

**What M4c is for:** taking a note without setting anything up, and opening any single Markdown or text file with no vault. Persona: quick note-takers (product spec §1.2).

**Spec:** `docs/superpowers/specs/2026-10-14-m4c-scratchpad-design.md`. It holds §1–§6, plus:
- **§7:** amendments from planning, Scratchpad. This includes Jose's 2026-10-15 addition of a scratch folder in every vault, and the rulings taken on his behalf.
- **§8:** amendments from planning, single-file windows.
- **§9:** final review of the single-file windows: what was fixed and what is deferred.
- **§10:** final review of the Scratchpad: what was fixed and what is deferred.

**Plans (as run):**
- `docs/superpowers/plans/2026-10-15-m4c-scratchpad.md` (Stream S)
- `docs/superpowers/plans/2026-10-15-m4c-single-files.md` (Stream F)

**Branch:** `feat/m4c-scratchpad`, stacked on `feat/m4b3-feedback` (ba67c0a). Merge order for the whole stack: M2c → M3a → M3b → M4 → M4b → M4b part 3 → **M4c** → M5.

**How it was built:**
1. **Jose's decisions.** The spec was agreed with Jose on 2026-10-14: the location is chosen on first use, opened files get their own windows, and names come from the first line. On 2026-10-15 he added a scratch place inside every vault and chose **a folder of quick notes**, over a single scratch page or both.
2. **Two streams in parallel**, each with its own plan, worktree and full gate:

   | Stream | Covers | Branch |
   |---|---|---|
   | S | Scratchpad + per-vault scratch folder | `feat/m4c-scratch` |
   | F | Single-file windows | `feat/m4c-files` |

   A laptop restart in the middle killed the agents. Their committed and uncommitted work survived in their worktrees, and they resumed from there.
3. **Integration** by cherry-pick (S, then F), with conflicts resolved by hand. One fix commit followed (2a8bd14): a duplicated `dunce` dependency line, Scratchpad commands denied in file windows, and ⌘⇧N in a file window making no note there.
4. **Two fresh-context Opus final reviews:** single-file windows with a security focus, and the Scratchpad plus the integration. Two parallel fix passes followed, every fix with a test that failed first, and then a second integration.

## 1. What changed, by feature

### The global Scratchpad (quick notes with no vault)

| What | How it behaves |
|---|---|
| Entry points | **Take a quick note** on the Welcome screen. **File → New Quick Note** (⌘⇧N; Ctrl+Shift+N on Windows/Linux), from any window. **Quick notes** in the recent list, with its own icon. |
| First use | A dialog, "Where should quick notes live?", offers the default `~/Documents/Liber Linteum/Scratchpad` or **Choose folder…**, a folder dialog opened by Rust. **Create** makes the folder and its parents. The choice is saved as `scratchpadPath` in `settings.json`. |
| What it is | An ordinary vault (index, explorer, Global View, search) flagged as the Scratchpad. Wherever the vault name shows (sidebar, breadcrumb, explorer), it reads **Quick notes** (**Notas rápidas** in Spanish). |
| A new quick note | `Quick note 2026-10-15 09.05.md` (Spanish: `Nota rápida …`), local time, deduplicated with ` 1`, ` 2`. It opens with the cursor in the text. |
| Moving it | **Settings → Files → Quick notes folder (no vault open) → Change…** points to another folder. Existing notes stay where they are. |
| A missing folder | Created again on open. If that fails (an unplugged drive), the error shows with the first-use dialog so you can choose another folder. |

### A scratch folder in every vault (Jose, 2026-10-15)

| What | How it behaves |
|---|---|
| Where | A `Scratchpad/` folder inside the vault. Its name is set in **Settings → This vault → Quick notes folder** and stored as `.liber/vault.json` `scratchpadFolder`. It's created on first use, never just by opening the vault. |
| Sidebar | Pinned at the top of the explorer, above the other folders and divided from them, with a pencil icon and a note count. Otherwise it's a normal folder: it expands, renames, takes drops and has the context menu. |
| ⌘⇧N with a vault open | The new quick note goes into **that vault's** scratch folder, with no vault switch. With no vault open, it goes to the global Scratchpad. The Welcome button always uses the global Scratchpad. |
| Renaming it in Settings | Renames the folder on disk and rewrites links per "Update links". An existing folder of the new name is adopted. A case-only change (`Scratchpad` → `scratchpad`) renames in place. Windows device names (`CON`, `NUL`…), trailing dots and spaces, hidden names, `..`, nested and absolute values are refused. |

### Names from the first line (both places)

- While a note still has its generated name, it is renamed after its **first line**: the first non-blank line after the frontmatter, with its Markdown flattened. Heading marks, list and quote markers, task boxes and emphasis go; links keep their text, wikilinks their alias, tags their word; images, embeds and HTML go.
- **When it renames:**
  - about 2 s after you stop typing (save at 0.5 s, plus 1.5 s);
  - at once when the editor loses focus;
  - when another page opens, including when you switch before the save landed.
- **Name rules:**
  - refused characters become `-`;
  - the name is cut at 60 graphemes (and 200 bytes), so emoji and accents are never split;
  - bidi controls and zero-width characters are dropped;
  - names are compared in NFC;
  - a name with nothing usable, or a Windows device name, keeps the generated name.
- **Never steals a linked name:** if any page in the vault already has that link name (e.g. `Shopping/Groceries.md`), the quick note becomes `Groceries 1`. So no other note's link changes meaning, and nothing is rewritten.
- **When it stops:** following the first line ends when you rename the note yourself (title or explorer), move it, or delete it. It also ends if the note changed outside the app between sessions (Obsidian, sync, Finder). The flag lives in `.liber/vault.json` `autoNamed`.
- **Never fights you:** no rename runs while a title or explorer rename is open, or while focus moves to the title; the title keeps what you're typing.
- **Not applied:** a derived name differing only in letter case ("meeting" → "Meeting").

### Single-file windows

| What | How it behaves |
|---|---|
| Ways to open a file | **macOS:** Finder → Open With → Liber Linteum (`.md`, `.markdown`, `.txt`; rank Alternate, so it never takes over the default app), or drop the file on the Dock icon. **Everywhere:** **File → Open File…** (**⌘⇧O**; ⌘O still opens a folder as a vault) and **Open a file** on the Welcome screen. **Windows/Linux:** paths on the command line; a second launch hands its paths to the running app. On Windows that's "Open with → Choose another app". |
| Which files | `.md`/`.markdown` as Markdown; everything the text view opens (M4b part 2) as text. Images, PDFs and programs never get a window. |
| The window | One window per file, about 900 × 700. Re-opening a file focuses its window. Contents: <ul><li>a top bar with the renamable file name, plus the subtitle for `.md`;</li><li>a compact header band: Saved, word count, Format, the mode switch, width;</li><li>the editor with all its modes, the toolbar and the outline.</li></ul> No sidebar, no Global View, no vault features, no attachments (paste, drop and Attach are off, and `[[` suggestions are empty). |
| Links | Markdown links resolve relative to the file's folder. `[[wikilinks]]` resolve by name in the folder and its subfolders (depth ≤ 3). A note or text file opens in its own window. A document or media file opens in its default app, only if both the link name and the real target are on the documents-and-media list. A missing page says so. Nothing above the folder (`../`), nothing hidden, no symlinks out, no outside files. |
| Saving | The same autosave, CAS and external-change merge as notes. A non-recursive watcher on the folder, filtered to the file. Closing the window and quitting flush every window. Notes over 16 MB and over-large text files aren't opened. |
| Outside changes | **Deleted with unsaved text:** the text is kept, with **Save again** (if the file came back meanwhile, it merges into it). **Deleted with nothing unsaved:** "This file was deleted or moved" with **Close window**. **Rewritten as something the app can't edit:** **Save a copy** writes `<stem> (conflict).<ext>` next to it. **A rename outside:** reads as a deletion. |
| Open in its vault | When the file is under a vault in the recent list, a bar offers to open it there. It saves, freezes the editor, hands the page to the main window (creating it if needed) and closes the file window, so one file never has two editors. |
| Width, settings | Width is the window's own, for as long as it's open. The window has Settings (no vault section) and writes app settings; every window shows a change made in any of them. |

### Security

- **Per-window grants.** Rust records the path from the open event, dialog or command line as the window's grant.
  - The `file_*` commands take no path from the page.
  - Grants are keyed by the real webview label; labels are never reused.
  - A window being built shares its grant; a closing window's grant is replaced under a fresh label.
- **Capabilities.**
  - `capabilities/file.json` (for `file-*` windows) holds only the file commands, settings, fonts, `url_open`, `app_info`, events and `window_close_self`.
  - Vault, Scratchpad and quick-note commands are denied there; real-ACL tests cover both directions.
  - The window plugin's `destroy` (which takes any label) is gone from both capabilities; a window can only close itself.
- **Asset serving.** `liber-asset:` keys on the requesting webview. A file window gets its folder only, media and documents only, and `/.external/` is 403.
  - `Vault::visible_fs_path` refuses a path whose **real** location is hidden, reached through a symlink or a Windows 8.3 short name such as `SSH~1`.
  - This also hardens the main vault's asset serving.
- **The Scratchpad folder grant.** `scratchpad_set` accepts only the default or the folder just picked in a Rust dialog. `scratchpadPath` can't be written through `settings_set`, and `scratchpad_open` takes no path.
  - **Still open:** ordinary `vault_open`/`vault_create` are unchanged, so the M2c §10 j gap remains for them (hardening milestone).

## 2. Totals

- **Commits:** 35 on top of ba67c0a, all signed:
  - Stream S: 11;
  - Stream F: 8;
  - the integration fix: 1;
  - the single-file fix pass: 10;
  - the Scratchpad fix pass: 5.
- **New Rust modules:** `scratchpad_commands.rs`, `file_windows.rs`, `file_commands.rs`, `opening.rs` (desktop); `quick_notes.rs` (session).
- **New frontend folders:** `features/scratchpad/`, `features/singleFile/`.
- **New dependencies:** `tauri-plugin-single-instance` 2.5 (Windows/Linux only), `dunce`.

Full gate (`check.sh all`) on e9978fa:

| Check | Result |
|---|---|
| vitest | 1342 tests in 123 files |
| e2e | 260 passed in Chromium and WebKit, plus 8 opt-in perf tests skipped |
| cargo | 421 passed, 2 ignored (the trash tests, never run here) |
| lint, typecheck, i18n, build, fmt, clippy, deny | all clean |
| `cargo xwin check --target x86_64-pc-windows-msvc` | clean (covers the Windows-only single-instance code) |

The dev server was also booted in Chromium and WebKit after each stream and after the integration: the main window, the Welcome screen with "Take a quick note", and a file-window route, with no page errors.

## 3. Needs the real window

Finder "Open With", dropping on the Dock and several windows only work in a **built app**, not in `pnpm dev`. Use the `.app` from §5.

### Jose, on the Mac (the built `.app`)

1. **Quick note from Welcome.**
   - With no vault open, click **Take a quick note**. The first-use dialog appears; keep the default and click Create.
   - Type `Buy milk and eggs`, wait 2 s, and check the note is renamed "Buy milk and eggs" in the sidebar and title.
2. **⌘⇧N with a vault open.**
   - Open your vault and press ⌘⇧N **once**. Exactly one note appears, inside a new pinned **Scratchpad** folder at the top of the sidebar, with a pencil icon and a count of 1.
   - Type a first line and switch pages quickly: it's still renamed.
3. **A name another page uses.** In the vault, start a quick note with the name of an existing page (e.g. a page you link to). It becomes `<name> 1`, and no other note's links change.
4. **Stopping and not fighting.**
   - Rename a quick note yourself, then edit its first line: it no longer follows.
   - In another quick note, click the title right after typing its first line and type a name. Your typing isn't reset.
5. **Settings.**
   - **This vault:** rename the quick notes folder (e.g. `Inbox`); the folder renames on disk and stays pinned. Try `inbox` (case only) too.
   - **Files:** "Quick notes folder (no vault open)" shows; Change… opens a folder dialog.
6. **⌘⇧N with Settings open:** nothing happens until Settings closes.
7. **Open With.**
   - In Finder, right-click a `.md` outside any vault → Open With → Liber Linteum. A file window opens with the editor; the main window opens too.
   - Repeat with a `.txt`.
   - Open the same file again: the existing window is focused.
8. **Dock and ⌘⇧O.**
   - Drop a `.md` on the Dock icon.
   - Use File → Open File… (⌘⇧O) and pick two files: two windows.
9. **In a file window.**
   - Edit and wait for Saved.
   - Rename it from the title.
   - Follow a `[[link]]` to a sibling note (it opens another window) and a link to a PDF (it opens in Preview).
   - Images in the folder show.
10. **Outside changes.**
    - With a file window open, edit the file in TextEdit and save: the window merges.
    - Delete it in Finder with unsaved text: **Save again** writes it back.
11. **Closing and quitting.**
    - Type into two file windows, then ⌘Q right away: both are saved.
    - Close a file window with the red button: it closes and saves.
12. **Open in its vault.** Open a note that lives in one of your vaults through Open With. The bar offers **Open in its vault**, and clicking it moves the note into the main window, closing the file window.
13. **Settings in every window.** Change the theme or editor mode from a file window: the main window follows.
14. **Hidden files.** A file window can't show `![](.secret/x.png)` or a symlink into a hidden folder. A missing-image card shows instead.

### The friend, on Windows (the `.exe`)

1. **Quick notes.**
   - **Take a quick note** on Welcome, then Ctrl+Shift+N with a vault open: one note per press, in the pinned Scratchpad folder.
   - Names follow the first line (try accents and an emoji).
   - The scratch folder rename refuses `CON` and `name.`.
2. **Open with.** Right-click a `.md` → Open with → Choose another app → Liber Linteum: a file window opens.
   - With the app already running, do it again with another file: it goes to the running app as a second window, with no second app instance.
   - The app must **not** have become the default for `.txt`: Notepad still opens `.txt` on a double-click.
3. **Ctrl+Shift+O** opens Open File…
4. **Closing.** Closing a file window with × saves it; closing the main window with file windows open keeps them working.
5. **First open.** The index rebuilds once on first open; the vault should open normally.

## 4. Final reviews and fix passes

### Review of single-file windows (security focus)

No Critical findings, 4 Important, 8 Minor. All Important findings and m1–m4 were fixed (spec §9), each with a test that failed first:
- **I1:** two opens of the same file at once, or a re-open while the window is closing, could revoke the live window's grant. Its saves then failed with unsaved text.
- **I2:** a file window could destroy the main window (the window plugin takes any label), skipping save-on-close. Replaced by `window_close_self`.
- **I3:** a link named like a document could open a symlinked `.chm`/`.iso`/`.xlsm` with no confirmation. Now the real target is checked too.
- **I4:** symlinks and Windows 8.3 short names (`SSH~1/id_ed25519`) could reach hidden files through `liber-asset`. Now the real path is checked, which also hardens the main vault.
- **m1:** a non-UTF-8 command-line argument crashed the launch.
- **m2:** huge files were read whole, risking an out-of-memory crash that loses every window's text. Size caps added.
- **m3:** "Save again" could strand the text in a conflict copy the window can't write.
- **m4:** typing during "Open in its vault" could be lost.

### Review of the Scratchpad and the integration

No Critical findings, 4 Important, 11 Minor. I1, I2 and I4 were reproduced by the reviewer with throwaway tests. Everything except M6, M8 and M10 was fixed (spec §10):
- **I1:** auto-naming could quietly rewrite other notes' links, or take them over.
- **I2:** a stale `autoNamed` flag (after a Finder rename while the app was closed) renamed a user's own note.
- **I3:** an auto-rename landing mid-edit reset a title or explorer rename being typed.
- **I4:** a case-only scratch-folder change in Settings split the folder.
- Also fixed:
  - **M1:** naming on a quick page switch;
  - **M2:** flags kept on a folder rename;
  - **M3:** graphemes, invisible characters, NFC;
  - **M4:** Windows-unsafe folder names;
  - **M5:** menu quick note while a dialog is open;
  - **M7:** no Change… in file windows;
  - **M9:** misfiling after Change… while the Scratchpad is open;
  - **M11:** ARIA.

### Deferred minors (for a later pass)

**Single-file windows:**
- **m5:** a file window may listen to events aimed at other windows. It only discloses information.
- **m6:** a watcher batch between a rename and the name update can briefly show the file as deleted.
- **m7:** link resolution in a huge folder (`~`, `C:\`) walks every directory to depth 3; only files are capped.
- **m8:** command-line files that can't open are dropped silently.
- **Settings leak:** `settings_get` and the `settings:changed` broadcast give file windows the recent-vault and Scratchpad paths. A trimmed DTO is a hardening step.
- **Format toggle name:** its accessible name ("Formatting toolbar") doesn't match its visible text ("Format"), here and in the vault page header. The axe rule is off in the new test only.

**Scratchpad:**
- **M6:** on macOS, ⌘⇧N does nothing when only file windows are open (no main window to receive it).
- **M8:** the "Quick notes" recent entry is disabled when its folder is missing, though opening would recreate it.
- **M10:** on Linux, recreating a missing Scratchpad folder can rebuild an unmounted mount point under `$HOME`.

### Rulings to confirm (taken on your behalf; details in spec §7–§10)

**Shortcuts and menus:**
- **⌘⇧N is New Quick Note.** New folder loses it (it keeps its explorer button and menu item, with no shortcut).
- **Open File… is ⌘⇧O,** because ⌘O already opens a folder as a vault.
- **⌘⇧N is handled by both the macOS menu and the page.** A second trigger within 1 s is ignored.
- **Launched by opening a file, the main window opens too.**

**Quick notes:**
- **Names follow the UI language:** "Quick note …" / "Nota rápida …".
- **The global Scratchpad's scratch place is its root:** there's no pinned folder inside it.
- **The scratch folder is one top-level name.** A move into another folder leaves the setting, and the next quick note recreates it.
- **Renaming it in Settings renames it on disk** (links rewritten); an existing folder of that name is adopted.
- **A quick note stops following its first line** when renamed, moved or deleted by you, or when it changed outside the app between sessions.
  - The reviewer suggested a file identity (inode, birth time). That can't work, because safe saves replace the file every time; "unchanged since the index last saw it" is used instead.
  - Cost: a quick note edited in Obsidian between sessions stops renaming itself.
- **Case-only name changes aren't applied.**
- **Names cap at 60 graphemes and 200 bytes.**
- **"Quick notes" uses the language active when it opened.**
- **Change… only repoints the location;** existing notes stay.

**Single-file windows:**
- **Finder associations are macOS-only.** On Windows the installer would make the app the *default* for `.txt`; files reach it through "Open with". Linux waits for M8.
- **A file window only sees its own folder and below:** no `../`, nothing hidden, no outside files.
- **Following a link to a document or media file opens it with no confirmation** (the allow-list guards it). A note opens in another window, without keeping the heading.
- **No attachments in file windows.**
- **Width is per window, for the session.**
- **`settings_set` is allowed from file windows.** The reviewer graded this low risk; the worst is turning off delete confirmation or link rewriting.
- **Over-size files** (notes over 16 MB, text files over the text-view cap) aren't opened.
- **A symlink into a hidden folder is now 404 in the main vault too,** and file windows are served media and documents only.

**Security:**
- **The Scratchpad grant covers the Scratchpad only.** Ordinary `vault_open` keeps the M2c gap until the hardening milestone.

## 5. Builds

Built from the M5 tip, which contains all of M4c. See the M5 hand-off (`docs/handoff/2026-10-15-m5-search-handoff.md`) §5 for paths, sizes and the exact commands.

**Mac:** an unsigned `.app` built with `pnpm tauri build --bundles app` into the repo's `target/release/bundle/macos/`.
- The first launch needs right-click → Open, because it's unsigned.
- Finder's Open With list may take a moment to pick up the new app. If it doesn't, launch the app once from the bundle.

**Windows:** cross-compiled with `cargo-xwin` and NSIS, as before (toolchain in `~/.liber-cross`):

```bash
cd apps/desktop
export CARGO_HOME=$HOME/.liber-cross/cargo RUSTUP_HOME=$HOME/.liber-cross/rustup RUSTUP_TOOLCHAIN=1.99.0 XWIN_ACCEPT_LICENSE=1
export PATH="/opt/homebrew/opt/rustup/bin:$CARGO_HOME/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

The installer is unsigned: SmartScreen asks for More info → Run anyway.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Finder doesn't list the app under Open With | File associations come from `tauri.macos.conf.json` and only exist in a built bundle. Launch the `.app` once; if needed, run `lsregister -f <path to .app>`. |
| ⌘⇧N makes two notes | The menu and the page both fire; the 1 s guard in `ScratchpadHost` should drop the second. Check `useGlobalShortcuts` and `onMenuQuickNote` share the guard. |
| A file window says it has no file of its own | Its grant is missing: the window label isn't in `FileWindows`. Check `file_windows.rs` (`grant`/`opened`) and that `Destroyed` only revokes its own `Arc`. |
| A file window shows a broken image that's in the folder | The asset is hidden (name or real path), not a media/document type, or outside the folder. Check `Vault::visible_fs_path` and `mime_for`. |
| A quick note stopped renaming itself | Its `autoNamed` flag was cleared: it was renamed or moved by you, or changed outside the app since the index last saw it. This is by design (§10.2). |
| `cargo test` fails with `read fixture dir: NotFound` | A test binary was built in a removed worktree. Run `cargo clean -p liber-testkit -p liber-desktop -p liber-session -p liber-vault -p liber-index -p liber-markdown`. |
| The Windows build fails to link single-instance | Check the target-gated dependency in `src-tauri/Cargo.toml`, and run `cargo xwin check --target x86_64-pc-windows-msvc`. |
