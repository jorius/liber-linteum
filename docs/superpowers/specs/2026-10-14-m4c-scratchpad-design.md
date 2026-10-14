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
  - the default `~/Documents/Notes In My Way/Scratchpad`;
  - **Choose folder…**, a folder dialog opened by Rust (the M2c §8 rule);
  - **Create**.

  The choice is saved in `settings.json` (`scratchpadPath`). The folder and its parents are created. Settings → Files shows the location with **Change…**, which points to another folder; existing notes stay where they are.
- **How the Scratchpad opens:** it is an ordinary vault (the same index, explorer, Global View and search later), opened in the main window and flagged as the Scratchpad. The sidebar header reads "Quick notes".
- **A new quick note:**
  - is created as `Quick note YYYY-MM-DD HH.mm.md` (deduplicated) at the Scratchpad's root;
  - opens with the cursor in the text.
- **Naming from the first line:**
  - while a note still has its generated name (tracked in `.nimw/vault.json` `autoNamed: [paths]`), the file is renamed after typing settles (2 s idle, or blur) to its first line;
  - the first line loses `# ` and Markdown, is cut to 60 characters, goes through the vault name rules (`-` for refused characters) and is deduplicated;
  - a manual rename (title or explorer) removes the flag, and auto-renaming stops;
  - an empty first line keeps the generated name.

## 3. Single-file windows

- **Ways to open a file:**
  - **macOS:** Finder "Open With" (`CFBundleDocumentTypes` for `.md`, `.markdown` and `.txt` with role Editor and rank **Alternate**, so NIMW never takes over the default app); dragging onto the Dock icon (`RunEvent::Opened`);
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
