# M5b — Third feedback round (UI overhaul, icons, Trash and Archive): Design

**Status:** Jose gave the feedback on 2026-10-15 after testing the M4c + M5 build. He answered four questions; the remaining choices are rulings, listed in §10 for him to confirm.
- **Branch:** `feat/m5b-feedback`, stacked on `feat/m5-search` (5a0cc35).
- **Index:** no schema bump is planned. If a stream needs one, it is 4.

---

## 1. The feedback, item by item

| # | Jose said | Section |
|---|---|---|
| 1 | Quick actions on files and folders in the sidebar | §3 |
| 2 | An optional emoji at the start of pages, as in Notion | §4 |
| 3 | A trash bin for folders, files and attachments, with confirmation | §5 |
| 4 | The search filter rows overlap the result list | §7.1 |
| 5 | A wide table should take the page's full width | §7.2 |
| 6 | ⌘F doesn't open search | §7.3 |
| 7 | Move the Settings icon to the app (window) menu | §2.1 |
| 8 | Move the close X to a new **Vault** menu: close vault, open another; encryption later | §2.1 |
| 9 | One floating button (bottom right, as in Notion) that opens Edit / Global View / Search, with keyboard shortcuts; the title moves back into the cover area | §2.2, §2.3 |
| 10 | Drop the app icon beside the vault name; optional vault emoji | §2.4, §4 |
| 11 | The left sidebar toggles collapsed | §2.5 |
| 12 | An Auto save on/off setting; "Saved" green, "Unsaved" red | §6 |
| 13 | (Answer) An **Archived** row above Trash | §5.3 |

## 2. Shell overhaul (Stream A)

### 2.1 Menus replace the top-bar buttons
- **Settings:**
  - macOS: **Notes In My Way → Settings… ⌘,**.
  - Windows and Linux: **File → Settings… Ctrl+,**, since the app menu doesn't exist there.
  - ⌘, keeps working from the page.
- **New Vault menu**, between File and Edit:
  - **Open Vault… ⌘O**, the existing folder dialog;
  - **Open Recent ▸**, the recent vaults;
  - **Close Vault ⌥⌘W**, which returns to the Welcome screen.
  - Encryption isn't built yet, so the menu shows no entry for it; it is noted here as future work.
- **What goes away:** the gear and the close X leave the screen. Both actions stay keyboard-reachable through their accelerators.
- **Routing:**
  - menu events go to the main window, as with New Quick Note;
  - Settings opens in the focused window, since file windows have Settings too;
  - the Vault menu's items are disabled while a file window is focused.

### 2.2 The floating action button
- **The button:** one round button, 48 px, fixed at the bottom right of the main area, above the editor's scroll content, with a shadow.
  - Pressing it opens a small vertical stack of three labelled buttons above it: **Search ⌘F**, **Global View ⌘2**, **Edit ⌘1**. The current screen's button is marked as pressed.
  - The stack closes on Escape, on a click outside, or once an action has run.
  - Keyboard: Tab reaches the button; Enter or Space opens the stack; ↑ and ↓ move through it; Escape returns focus to the button. Its ARIA is a menu button with `aria-expanded`.
- **Shortcuts:** the actions keep their shortcuts whether or not the stack is open. ⌘1 is Edit, ⌘2 is Global View, and ⌘F / ⌘⇧F is Search (§7.3). **⌘J** toggles the stack itself, as Notion uses ⌘J for its floating button.
- **Position:** a Settings → Appearance row, **Action button**, offers Bottom right (default), Bottom left (beside the sidebar) and Top right. This keeps Jose's first idea, that the user chooses the place, as an option.
- **Overlap:** the button must never cover the last line of text.
  - The editor and Global View get bottom padding equal to the button's height plus a gap.
  - In Global View, the button sits above React Flow's controls, which move left if they would collide.

### 2.3 The top bar goes; the title returns to the page header
- **The top bar is removed** (its title, Edit/Global view switch, Search, gear and X).
- **In the editor**, the page header (cover band) carries:
  - the breadcrumb;
  - the optional emoji (§4);
  - the title, editable inline as today;
  - the subtitle;
  - the related chips;
  - the existing header controls: Saved state, word count, Format, width, outline and mode switch.

  With a top cover, the emoji and title overlap the cover's bottom edge as in Notion. With a side cover, they stay in the text column.
- **In Global View**, the breadcrumb and toolbar it already has stay; it loses only the top-bar strip above them.
- **On the Welcome screen** nothing changes.
- **Window title:** the native window title shows "Page — Vault" (macOS and Windows), so the title is still visible outside the page.

### 2.4 The sidebar header
- **The app icon beside the vault name is dropped.**
- **Vault emoji:** the vault name is preceded by its emoji when it has one (§4). Clicking the empty slot before the name, when hovered, offers **Add icon**.
- The header keeps the New page / New folder buttons and gains the collapse button (§2.5).

### 2.5 The sidebar collapses
- **Toggle:** a button in the sidebar header (a sidebar-panel icon), **⌘\\** and **View → Toggle Sidebar**.
- **Collapsed:**
  - the sidebar slides out; transitions are disabled when `prefers-reduced-motion` is set;
  - a small reopen button stays at the top left of the main area;
  - the editor's measure stays centred in the wider space.
- **Persistence:** the state is kept per app in `settings.json` as `sidebarCollapsed`.
- **The explorer's drag targets** (moving to a folder) aren't available while collapsed.

## 3. Sidebar row quick actions (Stream B)

- **On hover or keyboard focus of a row**, these appear at the row's right end, in this order:
  - **+**: folders only; a new page inside that folder, as **New page** does at the root;
  - **☺**: pick an icon (§4);
  - **🗑**: move to Trash, after the existing confirmation dialog (§5);
  - **…**: the row's existing menu, now also reachable by click; right-click still opens it.
- **The note count** of the pinned Scratchpad row hides while its actions show.
- **Keyboard:**
  - the actions aren't extra tab stops in the tree (it keeps one tab stop and roving focus);
  - **Delete** or **⌘⌫** on a focused row trashes it (after the confirmation); the existing context-menu key (Shift+F10 or the Menu key) opens the menu;
  - each action has a shortcut listed in the menu.
- **Attachments are rows too:** where the explorer already lists attachments (images, PDFs and so on), they get 🗑 and …. They can't take an icon or +.
- **Touch and narrow sidebars:** below 220 px of sidebar width, only … shows.

## 4. Optional emoji icons (Stream B)

- **What can have one:** pages, folders and the vault itself. It is always optional, and nothing shows without one, so there is no placeholder in the tree.
- **Where it shows:**
  - before the name in the explorer (replacing the file or folder glyph);
  - in the page header before the title (large);
  - in breadcrumbs;
  - on Global View cards and their titles;
  - in search results (before the title, beside the thumbnail);
  - in the `[[` autocomplete list;
  - in the recent-vault list for vaults.
- **Storage (Obsidian-compatible):**
  - **Pages:** frontmatter `icon: "🚀"`. It travels with the note and is readable by Obsidian plugins that use the same key. Writing it uses the existing frontmatter edit path (CAS, undoable while the page is open).
  - **Folders:** `.nimw/vault.json` `folderIcons: { "path": "🚀" }`. It follows renames and moves, and is forgotten on delete, like `coverHeights`.
  - **The vault:** `.nimw/vault.json` `icon`.
- **The picker:**
  - a popover with a search field, recent picks and categories, plus **Remove**;
  - it is keyboard-operable as an ARIA grid, axe-clean, and searchable in en and es names;
  - **Data:** a bundled, offline emoji list (Unicode emoji with English and Spanish names), generated once into a static file. No network; no runtime CDN.
  - Skin tones are out of scope (default tone only).
- **Validation (Rust):** an icon value must be a single extended grapheme cluster, and an emoji (`Extended_Pictographic` or a keycap or flag sequence) of at most 32 bytes. Anything else is refused. Unknown values read from frontmatter are ignored, not shown.

## 5. Trash and Archive (Stream C)

### 5.1 The vault's own Trash
- **Deleting moves to `<vault>/.trash/`**, as Obsidian's "Move to Obsidian trash" option does, instead of the OS trash. This applies to everything: the trash icon, the menu, Delete and ⌘⌫. It covers pages, folders and attachments.
  - The confirmation dialog stays as it is, saying "Move … to Trash?".
  - A name clash inside `.trash` gets a suffix: ` 1`, ` 2`.
- **Record:** `.nimw/trash.json` keeps each item's original path, the time it was trashed and its path inside `.trash`. A `.trash` folder written by Obsidian shows its items too, with no original path known; they restore to the vault root.
- **Links:** when a page goes to the Trash, links to it become unresolved, as for a delete today; they are not rewritten.
- **Undo:** the existing undo toast for delete restores from `.trash`.

### 5.2 The Trash view
- **Entry:** a **Trash** row with a count, pinned at the bottom of the sidebar below Archived. It opens a Trash view in the main area, in place of the editor.
- **The list:**
  - each item shows its name and icon, its original folder, and when it was trashed;
  - the actions are **Restore** and **Delete permanently**, plus **Empty Trash** at the top.
- **Restore:**
  - returns the item to its original path, recreating missing folders;
  - on a clash, it asks: Keep both (suffix) or Cancel;
  - cover heights, widths and icons are restored too, because their entries are kept with the trash record.
- **Delete permanently and Empty Trash:**
  - each asks for confirmation that names the count;
  - the files then go to the **OS trash** (system Trash / Recycle Bin), so nothing is ever unrecoverable from the app.

  The labels say "Delete from vault" and "Empty Trash", and the dialog notes the files go to the system Trash.
- **Not shown elsewhere:** items in the Trash are excluded from the explorer, the index (so search, links and Global View don't see them) and the watcher's page events, since `.trash` is already a hidden name.

### 5.3 Archive
- **Archive moves an item** (page or folder) into `<vault>/.archive/`, mirroring its original path (`Projects/Old.md` → `.archive/Projects/Old.md`). It is recorded in `.nimw/archive.json` with its original path and the time.
- **Entry points:** **Archive** in the row's … menu and the page's header menu. **Unarchive** in the Archived view moves the item back, with the same clash handling as Restore.
- **Archived items stay working:**
  - they remain in the index, flagged `archived`;
  - links to them resolve, and backlinks count;
  - they are hidden from the explorer and Global View, and from search by default;
  - search gets an **Archived** chip in the MEDIA row (renamed **SHOW**) to include them;
  - an archived page opened through a link shows a banner, "This page is archived", with **Unarchive**.
- **The Archived view:** an **Archived** row with a count sits above Trash at the bottom of the sidebar. It opens a list like the Trash's, with **Unarchive** and **🗑** (move to Trash).
- **Index:**
  - `.archive` is indexed even though it's hidden, as the one hidden folder the index reads;
  - pages under it get `archived = 1`;
  - this needs no schema bump if the flag is derived from the path at query time. Otherwise it is schema 4, with the rebuild on open.
- **Links stay true across moves:** an archive or unarchive is a move, so links to the item are rewritten like any move (`rewrite_links`), keeping them resolved.

## 6. Auto save (Stream A)

- **The setting:** Settings → Editor → **Auto save**, on by default. It is stored as `autoSave: bool` in `settings.json`.
- **On:** behaviour is as today.
- **Off:**
  - nothing is written until **⌘S** (also **File → Save**);
  - leaving a page with unsaved text, closing the vault, closing a window or quitting asks **Save / Don't Save / Cancel**, one dialog per page, with "Save all" when several are unsaved;
  - external-change merging still applies to the unsaved buffer;
  - the scratch note's auto-naming waits for the save.
- **The status label** in the page header:
  - **Saved** in green (`--color-success`);
  - **Unsaved** in red (`--color-danger`);
  - **Saving…** stays neutral.

  The colour is never the only signal: the word is always shown, and the tokens meet 4.5:1 contrast in every palette, light and dark. A palette that fails gets a darker or lighter shade.
- **With auto save on,** "Unsaved" shows only after 600 ms without a save, so typing doesn't flash red.

## 7. Fixes (Stream D)

### 7.1 Search filter rows overlap the results
- **The bug:** the filter rows have a fixed height, so wrapped chip rows (LINKS TO in Jose's screenshot) spill over the RECENT heading and the list.
- **The fix:**
  - the filter area grows with its content, and the result list takes the rest of the dialog's height;
  - every chip row is limited to two lines, with a **+N more** chip that expands the row;
  - test this with a long-chip fixture in Chromium and WebKit at 1000 px and 700 px window heights.
- The orange ⇪ badge in the screenshot is the macOS Caps Lock indicator, not the app.

### 7.2 Wide tables take the editor's full width
Jose chose full editor width, centred.
- **Which tables:** in a page whose width is **Wide elements**, a table wider than the text measure spans the editor from its left padding to its right padding. Narrow tables stay with the text.
- **Text:** keeps the readable measure, centred.
- **Line numbers:** with line numbers on, the line numbers of those rows sit at the far left edge of the editor, outside the table. This replaces part 3's "keep the text's left edge, grow to the right" ruling (wide spec §6.6) for tables. Code, maths and diagrams follow the same full-width rule.
- **Overflow:** a table still wider than the full width scrolls inside its box, as today.
- **Tests:** an e2e check on the seven-column fixture, with and without line numbers, in Chromium and WebKit. The table's left edge sits at the editor's left padding (±2 px) and its right edge at the right padding.

### 7.3 ⌘F opens search
- **Shortcuts:** **⌘F** (Ctrl+F) opens the search dialog from every view, as ⌘⇧F does. There's no find-in-note today, so nothing is displaced.
- **When the editor has focus:** ⌘F opens the search dialog prefilled with the current selection, if the selection is short and on one line.
- **Hints:** the button and menu hints show ⌘F. View → Search… gets ⌘F as its accelerator, now that the top-bar button is gone.
- **In-note find (⌘F inside the note, as Obsidian does)** is a later item; when it lands, ⌘F becomes find-in-note and search keeps ⌘⇧F. Jose to confirm.

## 8. Streams and shared files

| Stream | Scope | Owns |
|---|---|---|
| A | §2, §6: menus, floating button, top bar removed, title in header, sidebar collapse, auto save | `menu.rs`, `AppShell`, `TopBar` (removed), `PageHeader`/`PageHeading`, `Sidebar` layout, the `settings` fields `autoSave`, `sidebarCollapsed`, `actionButton` |
| B | §3, §4: row quick actions, emoji icons and picker | `features/explorer/*` rows, `features/icons/*` (new), the frontmatter `icon` read/write, `folderIcons`/`icon` in vault.json, the emoji data |
| C | §5: Trash and Archive | `nimw-vault` trash/archive ops, `nimw-index` archived flag, the Trash and Archived views, the delete path |
| D | §7: fixes | `SearchDialog` layout, wide-table layout, ⌘F |

- **Conflicts:**
  - A and B both touch the sidebar header and the page header. B provides `<ItemIcon>` and `<IconButton>`; A places the title block and leaves a slot before the title for B's icon.
  - B and C both touch the row actions: B renders 🗑 and calls `requestTrash(path)`, which C implements over the existing delete path.
- **Integration:** cherry-pick A → B → C → D into `feat/m5b-feedback`.

## 9. Testing (every stream)

- **Rust:** real-ACL tests for every new command; for C, trash/restore/archive/unarchive round trips with clashes, links, the index flag and Obsidian's `.trash`.
- **TS:** unit and component tests; axe in light and dark; keyboard; i18n en + es.
- **E2E** in Chromium and WebKit, with mocked IPC:
  - the floating button;
  - the sidebar collapse;
  - auto save off;
  - an icon set and shown;
  - trash → restore;
  - archive → link still opens;
  - the search overlap;
  - the wide table;
  - ⌘F.
- **Floors:** the Safari 15 floor and `freezePrototype`-safe; no network.
- **`NIMW_TRASH_TESTS` stays off:** tests that would empty to the real OS trash use the existing gated path.

## 10. Rulings to confirm (taken for Jose)

1. **Floating button:** Jose asked for one button at the bottom right. Settings also offers bottom left and top right, from his first message. ⌘J toggles it.
2. **Vault menu:** Open Vault… ⌘O, Open Recent, Close Vault ⌥⌘W. Encryption isn't listed until it exists.
3. **Settings on Windows and Linux:** under File, since there is no app menu.
4. **Deleting now goes to the vault's `.trash`**, not the OS trash. Deleting from the Trash sends files to the OS trash, never destroying them.
5. **Archive is a move into `.archive/`** with links rewritten, so Obsidian sees archived notes in `.archive` (a hidden folder there too).
6. **Page icons live in frontmatter `icon:`;** folder and vault icons live in `.nimw/vault.json`.
7. **Emoji only** for icons: no custom images, no skin tones, for now.
8. **Auto save off asks before leaving unsaved text,** per page. "Unsaved" turns red only after 600 ms with auto save on.
9. **⌘F opens search** until in-note find exists.
10. **Wide tables span the full editor width;** line numbers move to the far left for those rows.
11. **The sidebar's collapsed state is app-wide,** not per vault.

## 11. Amendments — Stream A

These rulings come from planning the shell. Each lists its cost if wrong.

1. **No app menu on Windows or Linux.** The native menu is installed on macOS only (`with_app_menu`). §2.1's "File → Settings…" therefore can't be the Windows path.
   - On every platform, clicking the vault name in the sidebar opens a **vault menu** popover: **Settings…**, **Open another vault…**, **Close vault**.
   - On macOS the same actions are also in the native menus: Notes In My Way → Settings… ⌘, and the Vault menu.
   - Cost: none. Adding a Windows menu bar later remains possible.
2. **Open Recent ▸ is left out of the native Vault menu.** It would need the menu rebuilt whenever the recent list changes. Close Vault returns to the Welcome screen, which lists recent vaults. Cost: one extra click.
3. **Accelerators that would fire twice.** The page already handles ⌘, and ⌘O.
   - Settings… keeps its ⌘, accelerator, because opening it twice is harmless.
   - Open Vault… has none, because two folder dialogs would open.
   - Close Vault ⌥⌘W, File → Save ⌘S and View → Toggle Sidebar ⌘\ are handled through the menu on macOS. The page answers ⌘S and ⌘\ too, and repeats are harmless.
4. **The floating button is a disclosure,** not an ARIA menu. A button with `aria-expanded` opens a group of three ordinary buttons (Edit and Global view pressed as before, then Search). ↑ and ↓ move between them, and Escape closes and returns focus. Cost: none; the names stay what they were.
5. **Red "Unsaved" only with auto save off.** With auto save on, the status stays as today (Saving… is neutral), and only failure states (Retrying, Not saved) turn red. This meets "no red flash while typing" without a timer, and replaces §6's 600 ms rule. Cost: low.
6. **Don't Save drops the text.** The page's unsaved edits are reverted to the last saved text, and nothing is written. Cancel keeps the page open with its text. One dialog lists every unsaved page, with Save all / Don't Save / Cancel. Cost: low.
7. **Turning auto save back on** saves every unsaved page within the autosave delay.
8. **The window title is set through a new `window_title_set` command,** acting on the calling window. There is no window plugin (M4c review I2). It shows "Page — Vault" in the editor, "Global View — Vault" in Global View, and "Vault" otherwise. File windows keep their own title.
9. **The Global View's heading** ("Global view · level") lived in the top bar. Its own breadcrumb already names the level, so the heading goes.
10. **The sidebar collapse** keeps the reopen button at the top left of the main area. On macOS that sits below the traffic lights, because the native title bar stays.
