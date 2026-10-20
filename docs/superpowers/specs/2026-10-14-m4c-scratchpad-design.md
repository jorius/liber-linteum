# M4c — Scratchpad and single files: Design

**Status:** agreed with Jose on 2026-10-14:
- **Scratchpad location:** chosen on first use.
- **Opened files:** each in its own lightweight window.
- **Quick-note names:** from the first line.

Persona: quick note-takers (product spec §1.2). It builds on M4b; it is planned after M4b lands and before M5 (search).

---

## 1. Goal

Take a note without setting anything up, and open any single Markdown or text file from Finder, with no vault needed.

## 2. Scratchpad

- **Entry points:**
  - **Quick note** on the Welcome screen;
  - **File → New Quick Note** (⌘⇧N, from any window, including while a vault is open);
  - **Quick notes** in the recent list (with its own icon).
- **First use:** a dialog, "Where should quick notes live?", offers:
  - the default `~/Documents/Liber Linteum/Scratchpad`;
  - **Choose folder…**, a folder dialog opened by Rust (the M2c §8 rule);
  - **Create**.

  The choice is saved in `settings.json` (`scratchpadPath`). The folder and its parents are created. Settings → Files shows the location with **Change…**, which points to another folder; existing notes stay where they are.
- **How the Scratchpad opens:** it is an ordinary vault (the same index, explorer, Global View and search later), opened in the main window and flagged as the Scratchpad. The sidebar header reads "Quick notes".
- **A new quick note:**
  - is created as `Quick note YYYY-MM-DD HH.mm.md` (deduplicated) at the Scratchpad's root;
  - opens with the cursor in the text.
- **Naming from the first line:**
  - while a note still has its generated name (tracked in `.liber/vault.json` `autoNamed: [paths]`), the file is renamed after typing settles (2 s idle, or blur) to its first line;
  - the first line loses `# ` and Markdown, is cut to 60 characters, goes through the vault name rules (`-` for refused characters) and is deduplicated;
  - a manual rename (title or explorer) removes the flag, and auto-renaming stops;
  - an empty first line keeps the generated name.

## 3. Single-file windows

- **Ways to open a file:**
  - **macOS:** Finder "Open With" (`CFBundleDocumentTypes` for `.md`, `.markdown` and `.txt` with role Editor and rank **Alternate**, so Liber Linteum never takes over the default app); dragging onto the Dock icon (`RunEvent::Opened`);
  - **File → Open File…** (⌘O), a dialog opened by Rust;
  - **Windows / Linux:** file paths on the command line, with a second launch forwarded to the running app (`tauri-plugin-single-instance`).
- **The window:** each file opens in its own window (label `file-<n>`, about 900 × 700), loading the same frontend in **single-file mode**:
  - **Top bar:** the file name (renamable on disk) and the subtitle for `.md`;
  - **Header band:** a compact one, with Saved, word count, Format, the mode switch and Full width;
  - the editor with all its modes, the toolbar and the outline (M4b);
  - **No sidebar, Global View or vault features.**
  - `.txt` and code files use the M4b text view.
  - Re-opening a file that's already open focuses its window.
- **Links in a single file:**
  - Markdown links and embeds resolve relative to the file's folder;
  - `[[wikilinks]]` resolve by name within the file's folder and its subfolders (depth ≤ 3);
  - clicking an internal link to an eligible file opens it in another single-file window;
  - images are served through the asset protocol, scoped to the file's folder for that window only.
- **"Open in its vault":** when the file lies under a vault in the recent list, a bar offers to open that vault in the main window at this page.
- **Saving:**
  - the same autosave, CAS and external-change merge as notes;
  - a watcher on the file's folder, filtered to the file;
  - closing the window flushes it, and quitting flushes every window (the M2a quit guard per window).

## 4. Security

- **Path grants:** a single-file window can read and write only the file it was opened for, plus read-only assets in that file's folder.
  - Rust records the path from the open event or dialog as a **window grant**;
  - the window's commands (`file_read()`, `file_write(text, expectedHash)`, `file_rename(newName)`, `file_assets…`) take no path from the page.
- **Capabilities:** a separate capabilities file for `file-*` windows lists only those commands plus settings reads. Vault commands are denied there; real-ACL tests cover both directions.
- **Picked folders:** the Scratchpad folder is chosen through a dialog opened by Rust. `vault_open` for the Scratchpad goes through the same grant, which also starts to close the pre-existing `vault_open(path)` gap noted in the M2c hand-off.

## 5. Testing

- **Rust:**
  - Scratchpad creation and the settings field;
  - auto-rename rules (sanitizing, dedupe, the flag cleared on manual rename);
  - window grants, so a page can't read another path;
  - `file_*` commands with CAS;
  - the capability split (allowed and denied);
  - opened-file event handling (unit level).
- **TS:**
  - the first-use dialog (axe, keyboard);
  - quick-note creation and focus;
  - the auto-rename debounce;
  - single-file mode layout (no sidebar or Global View);
  - the "Open in its vault" bar;
  - link resolution in single-file mode.
- **E2E (Chromium + WebKit, mocked IPC):** a quick note from the Welcome screen, with a name from its first line; single-file mode rendering and saving.
- **Real window:**
  - Finder Open With and dropping on the Dock icon;
  - several file windows plus the vault window;
  - quitting with unsaved files;
  - Windows and Linux command-line opening (M8 packaging).

## 6. Out of scope

- A system-wide capture hotkey (it needs accessibility permission);
- a menu-bar mini window;
- moving notes from the Scratchpad into a vault from inside the app (use Finder or drag between explorers later);
- tabs.

## 7. Amendments from planning — Scratchpad

These override §2, §4 and §5 where they conflict. Plan: `docs/superpowers/plans/2026-10-15-m4c-scratchpad.md`.

### Jose, 2026-10-15: a scratch folder in every vault

1. **Each vault has its own scratch place**, besides the global Scratchpad:
   - a folder inside the vault, `Scratchpad/` by default;
   - its name is a vault setting, `scratchpadFolder` in `.liber/vault.json`, changed in **Settings → This vault**;
   - it is created on first use, never when the vault opens.
2. **The explorer pins it** at the top of the tree, above the other folders and divided from them, with a pencil icon and a note count (the pages inside it, at any depth). Otherwise it is an ordinary folder: it expands, renames, takes drops and has the context menu.
3. **Where ⌘⇧N and File → New Quick Note put the note:**
   - with a vault open, in that vault's scratch folder (no vault switch);
   - with no vault open (the Welcome screen), in the global Scratchpad, as §2 says;
   - the Welcome screen's **Quick note** button always uses the global Scratchpad.
4. **Naming from the first line** works the same in both places: `autoNamed` in that vault's `.liber/vault.json`, with vault-relative paths.
5. **One creation path:** the session creates a quick note in a folder it is given (`create_quick_note(dir, base)`). The command picks the folder; no folder comes from the page.

### Rulings taken on Jose's behalf

6. **The global Scratchpad's scratch place is its root.** It shows no pinned folder and no "Quick notes folder" row in Settings → This vault.
7. **The scratch folder is a single top-level name.** It follows a rename to another top-level name (in the app or in Finder); a move into another folder, or a delete, leaves the setting, and the next quick note creates the folder again.
8. **Renaming it in Settings → This vault renames the folder on disk**, rewriting links as the "Update links" setting says. If a folder of the new name already exists, it is adopted and nothing moves. A file of that name, a hidden name or a refused character is refused.
9. **⌘⇧N was New folder** (M1b §3.5, like Finder). It is now New Quick Note, as §2 says. New folder keeps its explorer button and context-menu item, with no shortcut.
10. **⌘⇧N is handled twice on purpose:** by the macOS menu item (from any window) and by the page (Windows and Linux have no app menu). A second trigger within 1 s and key repeat are ignored, so one press makes one note. The menu event goes to the main window, which is shown and focused first.
11. **Quick-note names are localized:** `Quick note 2026-10-15 09.05` in English and `Nota rápida 2026-10-15 09.05` in Spanish, in local time. Duplicates get ` 1`, ` 2`… like "Untitled".
12. **"The first line"** is the body's first non-blank line, after the frontmatter, as in the title rule (M4b part 3 §1). Its Markdown is flattened:
    - heading marks, list and quote markers, task boxes and emphasis go;
    - links keep their text, wikilinks their alias or target, and tags their word;
    - images, embeds and HTML tags go.

    Refused characters become `-`, the name is cut to 60 characters, and a name with nothing usable, or a Windows device name (`CON`, `NUL`, `COM1`…), keeps the generated name.
13. **The flag survives the app's own renames,** so the note keeps following its first line as you edit it. Any other rename or move, in the app or in Finder, removes the flag, and so does deleting the note.
14. **A derived name that differs only in letter case is not applied** (case-insensitive disks can't rename that way in one step).
15. **When it renames:**
    - after a save, 1.5 s with no typing (the save waits 0.5 s, so about 2 s after the last keystroke);
    - at once when the editor loses focus or another page opens.

    Rust reads the saved file and derives the name itself; the page sends only the note's path. Runs never overlap, and a failure leaves the name as it is.
16. **The folder grant (§4) covers the Scratchpad only:**
    - `scratchpad_set` accepts the default location or the folder just picked in a dialog Rust opened;
    - `scratchpadPath` can't be written through `settings_set`;
    - `scratchpad_open` takes no path.

    Ordinary `vault_open` and `vault_create` are unchanged, so the M2c §10 j gap remains for them (hardening milestone).
17. **Changing the global Scratchpad's location** (Settings → Files → Change…) points to the new folder; existing notes stay. An open Scratchpad keeps its "Quick notes" label until it is closed.
18. **A missing Scratchpad folder** is created again on open. If that fails (an unplugged drive), the error is shown with the first-use dialog, to choose another folder.
19. **The global Scratchpad is named "Quick notes"** wherever the vault name shows (sidebar, breadcrumb, explorer), in the language active when it opened. In the recent list it has its own icon.

## 8. Amendments from planning — Single-file windows

Plan: `docs/superpowers/plans/2026-10-15-m4c-single-files.md`. These override §3–§5 where they conflict.

### Opening

1. **Open File… is ⌘⇧O, not ⌘O.** ⌘O already opens a folder as a vault (product spec §3.5). The macOS menu gets a **File** menu with Open File…; elsewhere the page handles Ctrl+⇧O; the Welcome screen gets **Open a file**.
2. **File associations are macOS-only** (`tauri.macos.conf.json`: `.md`/`.markdown` and `.txt`, role Editor, rank Alternate). The Windows installer's association macro makes the app the default for the extension (it would take `.txt` from Notepad), so on Windows a file reaches the app through "Open with → Choose another app", which passes its path on the command line. Linux file associations wait for M8 packaging.
3. **Which files open on their own:** `.md` and `.markdown` as Markdown; every name the text view opens (M4b part 2 §6) as text. Anything else (images, PDFs, programs) never gets a window; Open File… names the picks it couldn't open.
4. **A second launch on Windows and Linux** hands its paths over through `tauri-plugin-single-instance` 2.5 (target-gated; registered in `run()` only, never in tests). macOS sends them to the running app itself (`RunEvent::Opened`).
5. **Launched by opening a file, the main window still opens** (Welcome or the last screen) beside the file's window.

### The window

6. **The window's world is its folder.** Assets, link resolution and read-only reads of other notes (embeds, heading completion) reach the folder and the folders below it; never above it (`../`), never hidden names, never symlinks out. Markdown links follow the same rule as `[[wikilinks]]` (depth ≤ 3 for name search; a path below the folder resolves at any depth).
7. **Files outside the folder** (absolute paths, `file:` URLs, `../`): not shown in a single-file window (M4b part 3 §9's allow-list lives in a vault's index).
8. **Following a link:** a note or text file in the folder opens in its own window (the heading isn't kept); a document or media file opens in its default app (the M4b part 3 allow-list, no confirmation dialog); a missing page says so (no vault to create it in).
9. **No attachments:** pasting images, dropping files and the Attach button are off; `[[` suggestions are empty.
10. **Width is the window's own**, for as long as it is open (no `.liber/vault.json` to keep it in). Reset to default and the default's own width clear it.
11. **Rename:** the title field edits the name; the extension and the folder stay; names refused in a vault are refused here.
12. **Outside changes:** the watcher is non-recursive (`Vault::watch_folder`). Deleted with unsaved text → the text is kept with **Save again** (writes the file again where it was). Deleted with nothing unsaved → "This file was deleted or moved" with **Close window**. Rewritten outside as something the app can't edit, with unsaved text → **Save a copy** (`<stem> (conflict).<ext>` next to it). A rename outside reads as a deletion.
13. **Conflict copies** are written next to the file, create-only — the one file a window writes besides its own.
14. **"Open in its vault"** saves, hands `{root, page}` to the main window (an event; a main window created for it reads them from its address), and closes the file window, so one file never has two editors.
15. **Settings:** the window has Settings (no vault section) and writes app settings (mode, Format, outline are app settings). Every window shows a change made in any window (`settings:changed`).
16. **Menu items act on the focused window only** (Rust `emit_to` the focused window, the page listens for its own label): sent to every window, a toggle flipped the setting once per window.

### Security

17. **`capabilities/file.json`** (`file-*`): the file commands, `settings_get`/`settings_set`, `fonts_list`, `url_open`, `app_info`, event listen/unlisten and window destroy. Vault commands are denied there and the file commands (but `file_open_dialog`) in `main`; real-ACL tests cover both. A `file-*` window without a grant reaches no file (`notPermitted`).
18. **`settings_set` is allowed in file windows** (beyond §4's "settings reads"): the band's controls are app settings. Cost: a compromised file page could change app settings, as a compromised main window can.

## 9. Final review — single-file windows

A fresh-context Opus review of `ba67c0a..2a8bd14`, focused on security. It found no Critical findings, four Important ones and eight Minor ones. These override §8 where they conflict.

### Fixed (each with a test that failed first)

1. **I1 — one window per file, even while a window opens or closes.**
   - A second open while the first window is still being built now shares its grant and builds nothing.
   - A grant whose window is closing is replaced under a fresh label, so the closing window's `Destroyed` can't revoke the live window's grant.
2. **I2 — a window closes itself and no other.**
   - The window plugin's `destroy` takes any label, so `core:window:allow-destroy` is gone from both capabilities.
   - The new command `window_close_self` closes the calling window only.
   - The UI's close-requested handler closes through it, keeping save-on-close.
   - This replaces §8.17's "window destroy".
3. **I3 — a followed link opens only a real document or media file.** The link is resolved, and both its name and its real target must be on the documents-and-media list; the real path is opened.
4. **I4 — no visible name reaches a hidden file.**
   - `Vault::visible_fs_path` also refuses a path whose real location is hidden, as reached through a symlink or a Windows 8.3 short name such as `SSH~1`.
   - `liber-asset` uses it for file windows and the main vault, and so do the file windows' note reads and link follows.
   - A file window is served media and documents only.
5. **m1:** launch arguments are read with `args_os()`, so a file name that isn't UTF-8 is skipped instead of panicking.
6. **m2 — size caps.**
   - Notes over 16 MB (`PAGE_MAX_BYTES`) and text files over `TEXT_MAX_BYTES` get no grant.
   - `file_read` checks the size again before reading, and answers `tooLarge`.
7. **m3:** in a file window, "Save again" that finds the file back merges into it, instead of moving the text to a conflict copy the window can't write.
8. **m4:** "Open in its vault" makes the view inert from the start of the hand-off, so nothing typed after the save is lost.

### Deferred (minor)

- **m5:** a file window may listen to events aimed at other windows (`vault:changed` paths, `file:open-in-vault`). It only discloses information.
- **m6:** a watcher batch landing between a rename and the name update can briefly show the file as deleted.
- **m7:** link resolution in a huge folder (`~`, `C:\`) walks every directory to depth 3; only files are capped.
- **m8:** files named on the command line that can't open are dropped silently.
- **The review's note on settings:** `settings_get` and the `settings:changed` broadcast give file windows the recent-vault and Scratchpad paths. A trimmed settings DTO for `file-*` windows is a later hardening step.

## 10. Final review — Scratchpad

The fresh-context review of the Scratchpad half (and the integration) found no Critical issues, 4 Important and 11 Minor. Everything below was fixed with a test that failed first, except the three deferred items.

### Fixed

1. **I1, quick-note names never take a linked name.** A first line naming another page ("Groceries" while `Shopping/Groceries.md` exists) used to win link resolution and rewrite other notes' links quietly. The name is now deduped against every file's link name in the vault, so it becomes `Groceries 1`. The links-updated toast is only skipped when no other note was touched.
2. **I2, a flag is trusted only for a note the index saw unchanged.** At open, flags of notes created, modified or removed since the last session are dropped, and a fresh index (another machine) drops them all. Removed files also lose their page widths and cover sizes.
   - **Ruling:** the review suggested recording a file identity (inode, birth time). That can't work here: CAS writes replace the file on every save, so both change each time. "Unchanged since the index last saw it" is the identity instead. Cost if wrong: a quick note edited in Obsidian between sessions stops following its first line.
   - **Ruling:** the old list form of `autoNamed` needs no migration; it is read as before, and the open-time rule above clears what can't be trusted.
3. **I3, a rename being typed is never reset.** No auto-rename runs while a title or explorer rename is open, or when focus moves to the title. The title keeps its draft while focused, and renaming one entry no longer closes another entry's inline rename.
4. **I4, a case-only scratch folder change renames the folder** instead of adopting it on a case-insensitive disk.
5. **M1:** switching pages before the save still names the note left.
6. **M2:** renaming the scratch folder from Settings keeps its notes named after their first line.
7. **M3:** names are cut by grapheme (and at 200 bytes), so a flag or an accent is never halved; bidi controls, zero-width spaces, the soft hyphen and the BOM are dropped; names compare in NFC.
8. **M4:** the scratch folder refuses Windows device names and a trailing dot.
9. **M5:** File → New Quick Note waits, like ⌘⇧N, while a dialog is open.
10. **M7:** a single-file window's Settings has no quick-notes location row.
11. **M9:** a vault opened as the Scratchpad stays the Scratchpad for the session, so Change… doesn't misfile new notes into `<old>/Scratchpad/`.
12. **M11:** the setup dialog's folder is a named group, not a labelled `<code>`.

### Deferred

- **M6:** ⌘⇧N does nothing on macOS when only file windows are open (no main window to receive it).
- **M8:** the "Quick notes" recent entry is disabled when its folder is missing, though opening would recreate it.
- **M10:** recreating a missing Scratchpad folder can rebuild an unmounted mount point under `$HOME` on Linux.
