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
   - Close Vault ⌥⌘W and File → Save ⌘S are handled through the menu on macOS; the page answers ⌘S too, and repeats are harmless.
   - View → Toggle Sidebar has **no** accelerator: the page handles ⌘\, since two toggles would cancel out (corrected in §16).
4. **The floating button is a disclosure,** not an ARIA menu. A button with `aria-expanded` opens a group of three ordinary buttons (Edit and Global view pressed as before, then Search). ↑ and ↓ move between them, and Escape closes and returns focus. Cost: none; the names stay what they were.
5. **Red "Unsaved" only with auto save off.** With auto save on, the status stays as today (Saving… is neutral), and only failure states (Retrying, Not saved) turn red. This meets "no red flash while typing" without a timer, and replaces §6's 600 ms rule. Cost: low.
6. **Don't Save drops the text.** The page's unsaved edits are reverted to the last saved text, and nothing is written. Cancel keeps the page open with its text. One dialog lists every unsaved page, with Save all / Don't Save / Cancel. Cost: low.
7. **Turning auto save back on** saves every unsaved page within the autosave delay.
8. **The window title is set through a new `window_title_set` command,** acting on the calling window. There is no window plugin (M4c review I2). It shows "Page — Vault" in the editor, "Global View — Vault" in Global View, and "Vault" otherwise. File windows keep their own title.
9. **The Global View's heading** ("Global view · level") lived in the top bar. Its own breadcrumb already names the level, so the heading goes.
10. **The sidebar collapse** keeps the reopen button at the top left of the main area. On macOS that sits below the traffic lights, because the native title bar stays.
11. **The title and subtitle sit just below the cover band,** at the top of the text's column. They don't overlap the cover as in Notion: any cover image would sit behind the text. Cost: low; this is a styling change.
12. **With auto save off, some file operations still write the page's text first:**
    - header edits (cover, subtitle, related) save at once, as before;
    - moving or trashing a page writes its text before the file moves.

    They are file operations the user started. Cost: an edit the user meant to discard is kept if they then do one of these.

    Re-graded in §16 (final review I1): a move or rename writes nothing (the page follows its file, still unsaved), and a trash writes only the pages it takes. Header edits still save; Settings says so under Auto save.
13. **The floating button shows ⌘F for Search.** Stream D makes ⌘F the search shortcut. Until D lands, ⌘⇧F still opens search, and the label is ahead by one stream.
14. **Leaving the editor (blur) no longer saves when auto save is off.** The e2e test found this: blur called `flush`.
## 12. Amendments — Stream B (row actions and icons)

These override §3 and §4 where they conflict.

### Where icons come from

1. **One source.** Every explorer `TreeNode` carries its icon.
   - **Pages:** frontmatter `icon:`, indexed as `pages.icon`. **Index schema 4**, with the usual rebuild on open. Stream C uses 5 if it needs a bump.
   - **Folders:** `.nimw/vault.json` `folderIcons`.
   - **The vault:** `VaultInfo.icon` and `RecentVault.icon`, read from `.nimw/vault.json` `icon`.

   Breadcrumbs, Global View cards, search hits, the `[[` list and the page header look icons up by path in the tree. `GvCard`, `SearchHit` and `Page` are unchanged.
2. **Validation.** Rust's `nimw_markdown::is_icon` decides: one grapheme, at most 32 bytes, and a pictographic character, a keycap or a flag. Symbols that render as text (© with no VS16) are refused. An invalid `icon:` or `folderIcons` value is ignored on read and refused on write (`invalidName`).
   - shortcut: the pictographic ranges are kept by hand, not the UCD property.
3. **Commands:** `folder_icon_set(path, icon|null)` and `vault_icon_set(icon|null)`, in the main window only and refused in `file-*` windows. Page icons need no command: they are written like `related:`, through the open document or a compare-and-swap write. A new icon shows on its row immediately, before the save is indexed.
4. **Placement:**
   - a page's emoji replaces its glyph in the tree;
   - a folder's follows its chevron;
   - attachments take no icon.

### The picker

5. **Data:**
   - Unicode `emoji-test.txt` plus CLDR annotations in en and es, generated once by `scripts/gen-emoji.ts` (`pnpm gen:emoji <folder>`).
   - Contents: 1,812 emoji, fully qualified, up to **Emoji 13.1** (Windows 10 draws later ones as boxes), with no skin tones. Each has its name and up to 4 keywords per language.
   - Size: 178 KB, 52 KB gzipped, in its own chunk loaded when the picker first opens.
   - Licence: Unicode License v3, recorded in `THIRD-PARTY-NOTICES.md`.
6. **Search:**
   - it ignores case and accents and matches English and Spanish;
   - exact names come first, then name matches, then keyword matches ("dragon" gives 🐉 before 🐲).
7. **Recent picks** are kept in `localStorage`. It is a per-viewer convenience, and the picker works without it.
8. **Rendering:** the picker is portalled to `<body>`, never inside a tree row or a heading.

### Names and keyboard

9. **Button names are unique:** "Add an icon to Lore" or "Change the icon of Lore". A row's ☺ is "Icon for Lore". A generic "Add icon" would repeat for the vault, the page and every row.
10. **Keyboard parity for icons:** the row's … menu gains **Icon…**, which replaces the menu with the picker at the same place. The row actions themselves aren't tab stops, as §3 says.
11. **Narrow sidebars:** the "below 220 px only …" rule is dropped. The sidebar is a fixed 270 px, and Stream A's collapse hides it rather than narrowing it.
12. **Trash:** 🗑, the menu's Delete, and Delete / ⌘⌫ / Backspace all call `requestTrash(path)` (`features/explorer/trashAction.ts`). For now that is the existing confirmation, then the OS trash; Stream C reroutes it.

### Merging with Stream A

13. **The vault's ☺** replaces the app mark beside the vault name (`Sidebar`), which §2.4 drops anyway.
14. **The page's icon button** sits in `PageHeading`, before the title. When Stream A moves the title into the page header, the button moves with it.
## 13. Amendments — Stream C (Trash and Archive)

These override §5 where they conflict.

### Where things live

1. **`.archive` is the one hidden folder the vault reads.**
   - `nimw_vault::is_hidden_path` treats a path as hidden when any component is hidden, except a leading `.archive`. Scan, stat, the watcher, `visible_fs_path` and the `nimw-asset` check all use it, so archived pages are indexed and their images are served.
   - `.trash`, `.nimw`, `.obsidian` and `.archive/.x` stay hidden.
   - `is_archived(path)` names the Archive and everything in it.
2. **No schema bump.** "Archived" is the path prefix `.archive/`, read at query time:
   - `VaultSession::tree` drops archived paths;
   - the Global View leaves them out of the root and of a page's neighbours;
   - search excludes them unless `archived: true`.
3. **Records** (`.nimw/trash.json`, `.nimw/archive.json`) are `{"items": {"<path now>": {"from", "at"}}}`. Each is written *before* the move and dropped if the move fails.
   - The lists ignore records whose item is gone (deleted outside the app, or a crash before the move); they're filtered in memory, not rewritten.
   - Trash entries with no record (Obsidian's own `.trash`, or a crash after the move) show "From another app" and restore to the vault root.
   - Pages put into `.archive` by hand are listed one by one, and come back to their path minus `.archive/`.

### Behaviour

4. **Trash keeps the item's name, not its path:** `.trash/Old.md`, then `.trash/Old 1.md`. A folder goes as one item. Widths, cover sizes and Global View positions *follow* the item into `.trash` and back (the rename remap), and are forgotten only on Delete from vault.
   - Ruling: a trashed quick note stops being auto-named, as with any rename.
5. **Refused for both bins:** the vault root, hidden paths, `.archive` itself, and **the vault's scratch folder**. Its setting would otherwise follow it into `.trash`. Pages inside the scratch folder can be trashed and archived.
   - Ruling: the scratch folder can't be trashed. The cost: someone who wants it gone must rename it in Settings first, or delete it in Finder.
6. **Archive is a move into `.archive/<its path>`**, done by the rename machinery with links rewritten when `rewriteLinks` is on.
   - In practice almost nothing is rewritten: `[[Old]]` and `[[P/Old]]` both still resolve to `.archive/P/Old.md`, because a path link matches a path's end, as Obsidian reads it.
   - **Amended by §15 (M1):** a live page now wins a name over an archived one. Where a live page shares the name, the rewrite at archive time keeps old links on the archived page; a link written later means the live page.
   - A clash in the Archive takes the next free name.
   - Unarchive moves the item back, removes the Archive folders it leaves empty, and gives `AlreadyExists` (or, with "Keep both", a numbered name) when something new took its place.
7. **Restore from the Trash** recreates missing folders and re-indexes through the watcher's own `apply([Changed])`, so links resolve again at once. An item that was archived before it was trashed is restored into the Archive and recorded there again.
8. **Delete from vault and Empty Trash** send the item to the OS trash through the existing `trash_via`. Tests inject a plain removal and never touch the real trash.
9. **Undo:** the trash toast's Undo restores; the archive toast's Undo unarchives.
10. **Entry points:**
    - Archive is in the row menu, before Delete.
    - The archived banner sits at the top of an archived page (in the page header's children), with Unarchive.
    - Ruling: there is no page-header menu yet, so the spec's "the page's header menu" entry waits for Stream A's header. The cost: one extra click path missing.
11. **Search:** the MEDIA row is now **SHOW**, with Has image, Has audio and **Archived**. Its count is the archived matches with the exclusion lifted. `.archive` is never a project chip. An archived-included search without text isn't "Recent".
12. **Commands**, all main-window only and denied in `file-*` windows: `bin_list`, `trash_restore(path, keepBoth)`, `trash_delete(paths)`, `trash_empty`, `entry_archive(path)` and `archive_restore(path, keepBoth)`. `entry_trash` now returns the item's path in `.trash`.
13. **The sidebar foot** (`features/bin/SidebarFoot.tsx`) replaces the old privacy foot. It holds Archived, then Trash, each with a count and `aria-current` on its open view, then the privacy line. The views are the screens `trash` and `archive` (`uiStore.Screen`), shown by `BinView` in place of the editor.

### Deferred

- On a case-insensitive disk with a vault at the home folder, `.trash` is the macOS user Trash (`~/.Trash`). The Trash view would list the whole system Trash. This is not handled.
- Huge Trash folders are listed whole on every tree refresh.
## 14. Amendments — Stream D

### 7.1 Search filter rows
1. **Root cause.** The search box was a scrolling flex column (`overflow: auto`, `max-height`). Everything in it shrinks toward its automatic minimum height, and the filter rows (a column of row flexboxes whose chips wrap) depend on the engine's intrinsic sizing to keep their height. Jose's WKWebView shrank the filters under the result list.
   - Playwright's WebKit and Chromium computed the minimum correctly, so the overlap itself doesn't reproduce in the e2e. An e2e pins it anyway, at 1000 and 700 px.
2. **Fix.** The box no longer scrolls:
   - every region keeps its height (`flex: none`);
   - the result list is the one region that takes the rest of the height and scrolls;
   - the filters scroll on their own past 40% of the window height, so a short window still shows results.

   An e2e checks that only the list scrolls.
3. **Two lines per row.** A row measures its chips (on layout and on resize) and shows what fits in two lines, plus a dashed **+N more** chip that shows the rest.
   - A row holding a pressed chip past the cut shows everything.
   - The words: "+N more" / "+N más".

### 7.2 Wide tables
4. **Root cause.** With line numbers on, the number column sat beside the measure, so there was no room on the left (`m` was 0). Wide blocks only grew to the right (wide spec §6.6), and the table in Jose's screenshot kept the text's left edge.
5. **Fix, whole column.** On a Wide-elements page, the text's auto margins take all the free room, so the line-number column moves to the editor's left edge and the room beside the text is even on both sides.
   - This moves the whole column, not only the wide rows' numbers as §7.2 said. Per-row numbers would need a CodeMirror gutter-class extension, and a column that jumps between rows reads worse.
   - Cost: on wide pages the numbers sit further from the text.
6. **Fix, full width.** A table whose natural width is wider than the text fills the frame, padding to padding; its columns share the room. `TableScroll` measures this and marks the widget frame `data-wide-full`.
   - Narrow tables stay with the text.
   - Code, maths and diagrams grow evenly on both sides to their own width (up to the full width). They don't stretch to fill it. Cost: a code block a little wider than the text isn't full width.
7. **Tests.** The m4b3-wide test "with line numbers" now expects the table centred on the text, clear of the numbers.

### 7.3 ⌘F
8. **Why ⌘F did nothing:** only ⌘⇧F was bound. CodeMirror binds no Mod-f, since the app has no `@codemirror/search` and no find-in-note.
9. **Fix:** ⌘F and ⌘⇧F both open Search.
   - View → Search… shows ⌘F (`CmdOrCtrl+F`). The page answers it too, and `openSearch` does nothing while any dialog is open, so the menu and the page never open it twice or replace Settings.
   - From the editor, a selection of up to 80 characters on one line becomes the search text.
   - The top-bar hint shows ⌘F.
10. **Not covered by a test:** the menu accelerator itself; the native menu can't be driven in e2e.
    - On Windows, WebView2's own Ctrl+F (find bar) may show while a dialog is open, since the page then doesn't take the key. This needs the real window.

## 15. Final review — Trash, Archive and icons

The Opus review of `855c6ea..5f961aa` found 2 Important and 8 Minor issues; M1 was re-graded Important by effect. Fixed with a test that failed first (`crates/nimw-session/src/bin.rs` `m5b_review_*`, `features/bin/Bin.test.tsx` "M5b final review", `stores/editorStore.test.tsx` `flushBefore`):

1. **I1, records trusted as restore places.**
   - A Trash or Archive record naming a hidden place (`.git/hooks/…`, `.obsidian/…`) or an unusable name is treated as unrecorded: the root for the Trash, the path under `.archive` for the Archive.
   - A rename never moves anything into a hidden folder (`session.rename`), which closes the older `entry_rename` gap too.
2. **I2, a bin that is a symlink.** `.trash` and `.archive` must be real folders. Listing, trashing, deleting, emptying and archiving refuse a symlinked bin.
3. **M1, archived pages winning a name.** The resolver ranks an archived page last unless the link is itself in the Archive.
4. **M2, restoring under a file.** A recorded place whose folder is now a file sends the restore to the vault root, with no endless Keep both loop.
5. **M3, clashes from the banner and Undo.** A clash on restore or unarchive opens one Keep both / Cancel dialog from any entry point.
6. **M4, the Archived view's trash button.** It asks first, through `requestTrash`.
7. **M5, Undo on a trash toast.** It restores only the item it trashed, and otherwise says "That item is no longer in the Trash."
8. **M6, delete from vault.** It forgets Global View positions and index-note picks too.
9. **M7, cheap parts.**
   - Deleting several items writes `trash.json` once, and what is left after a failure keeps its record.
   - `[[` suggestions use the cached icon map.
10. **M8, numbering.** A folder's dots stay in its name (`v1.2 1`).
11. **Auto save off.** Archiving and unarchiving save only the pages that move (`flushBefore`, shared with the shell fixes since integration), not every unsaved page.

**Rulings:**
- **M2 falls back to the root** rather than adding an error kind. Cost if wrong: the user finds the item at the root instead of being told why.
- **An existing Obsidian `.trash` that is a symlink is refused too.** Cost if wrong: such a vault can't use the Trash until the link is replaced.

**Deferred:**
- **M7, the rest:** `bin_list` on every tree refresh; `archive_list`'s O(files × records) pass.
- **Notes from the review's "declined to judge":**
  - Obsidian doesn't show `.archive`, so links to archived pages look unresolved there.
  - A vault that already has its own `.archive` folder gets it indexed.
  - A `.Archive` folder on a case-insensitive disk takes archived items.
  - A vault at `~` on macOS would list `~/.Trash` (from §13).


## 16. Final review — shell, Auto save and fixes

The fresh review of `855c6ea..5f961aa` found no Critical issues. Each fix below has a test that failed first.

**Fixed:**
- **I1, Auto save off, other pages written by a move:** a rename, move or new-item rename no longer flushes every page. Moves write nothing; a trash writes only the pages under the trashed path (`flushBefore`). Settings → Editor → Auto save has a hint naming what still saves (header edits, a trash).
- **I2, Dock Quit / logout / shutdown:** tao's app delegate had no `applicationShouldTerminate:`, so those quits skipped every close request. `quit_guard.rs` adds it at launch (macOS). With Auto save off it answers "cancel" and quits through each window's close request, which runs the Save / Don't Save / Cancel prompt; with Auto save on nothing changes (the M2a ≤ 500 ms limit).
  - Ruling: no recovery copy. A logout with Auto save off is cancelled once by the app (macOS names it), which then asks and quits; the user logs out again. Cost: one extra logout attempt.
  - Windows and Linux: closing reaches the windows' close requests already; Windows shutdown with Auto save off is not covered (deferred, needs `WM_QUERYENDSESSION`).
- **I3:** the file window's header keeps its layout (its rules moved to `SingleFile.module.css`).
- **I4:** in the Global View the floating button moves clear of New entry (bottom right), the zoom group (bottom left) and the toolbar (top right); the Split preview pane has 88 px under its last line. An e2e at 1280 × 800 checks that no control meets the button at each place.
- **I5:** collapsing the sidebar from inside it puts the keyboard on "Show sidebar"; reopening puts it on "Hide sidebar".
- **M1:** Cancel in the prompt leaves the screen, selection and link trail as they were (the question comes first in `openPage`, `goBack`, `goForward`).
- **M3:** a page deleted outside the app while unsaved no longer makes every page switch ask; its orphan banner covers it.
- **M4:** the prompt is an `alertdialog` described by its text, and lists the unsaved pages by name.
- **M5:** the floating button's group: ⌘J from inside it gives the keyboard to the button, Tab out closes it, and an action puts the keyboard on the editor (or back on the button), never on nothing.
- **M6:** after a row's emoji picker the keyboard is back on the tree row.
- **M8:** with the sidebar collapsed, the page area leaves room for "Show sidebar", which covers no breadcrumb.
- **M9:** "+N more" carries `aria-expanded="false"`; from the keyboard it hands focus to the first chip it shows.
- **M10:** the window title names Trash and Archived, and the app again once the vault closes.
- **M11:** window titles drop bidi and zero-width characters.
- **M12:** on macOS only ⌘F opens search (plain Ctrl+F stays "forward one character"); elsewhere Ctrl+F is kept from the webview's find bar everywhere, dialogs and Welcome included.
- **M14:** "Saved" green is chosen to meet 4.5:1 on the header and on its veiled pill over black and white covers; the palette test checks green and red there.
- **M15:** the unused `deleteFlow.ts` is gone, "top bar" comments are updated, and §11.3 is corrected (⌘\ has no menu accelerator).

**Deferred:**
- **M2:** ⌘N, ⌘⇧N and a row's + create the file before any question, so Cancel leaves a new "Untitled".
- **M7:** hidden row actions still reserve about 70 px, so long names cut early; the scratch row's count hides only on hover.
- **M13 (rest):** the Vault menu items aren't disabled while a file window is focused (they bring the main window forward); the native ⌘, opens Settings over another dialog.
- Windows shutdown/logout with Auto save off (see I2).

## 17. Round 2 (Jose, 2026-10-15 evening)

Jose's second look at the M5b build produced six items:
- items 1–5 below;
- item 6, the Trash redesign, built from his approved mock (`Trash.dc.html`).

Settings categories are being mocked separately and aren't part of this round.

### 17.1 `{{save}}` in the Auto save hint
- **Cause:** messages are ICU (`i18next-icu`), whose placeholders take one brace. The hint used i18next's own `{{save}}`, which ICU leaves as it is.
- **Fix:** `{save}` in en and es.
- **Guard:** a test refuses `{{` anywhere in either locale file.

### 17.2 Settings text fields
- **Change:** the Subfolder name and Quick notes folder fields take the dialog's full-width text field. They had borrowed the accent's 10-character hex box.
- **Refused names:** these fields are red-bordered when a name is refused, like the hex field.
- **Ruling:** these fields use the body font, not the hex field's monospace.

### 17.3 Toasts
- **How long they stay:**
  - with an action (Undo, Open): 8 s;
  - plain: 5 s;
  - listing details: stay until dismissed, as before.
- **Pausing:** the timer pauses while the pointer is over a toast or focus is inside it.
- **Limit:** at most three show; the oldest goes first.
- **Ruling:** plain errors keep the existing 5 s rule rather than becoming sticky. Errors that list details were already sticky.
  - Cost if wrong: a short error can be missed. Changing it is one condition in `toastStore.push`.

### 17.4 Sort by
- **The orders:** Name A→Z (the default, never stored), Name Z→A, Modified newest or oldest first, Created newest first.
- **Storage:** per folder in `.nimw/vault.json` `folderSorts`, with `""` for the vault root. It follows renames and is forgotten on delete, like `folderIcons`.
- **Commands:** `folder_sort_get` and `folder_sort_set`, main window only.
- **Where the order is applied:** the session orders the tree (`order_folders`); the UI keeps the order it's given.
- **Rulings:**
  1. Folders stay first in every order. Under the date orders they keep their names' order; under Z→A they reverse too.
  2. "Created" is the file system's birth time, read only for folders sorted that way. Where it's missing (some Linux file systems), ties fall back to the name.
  3. In a row's menu, **Sort by** replaces the menu with the orders (→ or Enter opens them, ← goes back), as Icon… does.
     - On a page it orders the page's folder.
     - A sort button beside New page / New folder orders the vault root.

### 17.5 The Archive is a read-only folder
- **The tree:** `vault_tree` now includes `.archive` and what's in it. The UI keeps it out of `nodes` (the vault everywhere else) and lists it under the **Archived** row, which expands like a folder.
- **The old view is gone:** the Archived list view and the `archive` screen are removed.
- **Opening reveals:** archiving an item opens Archived, like a folder something moved into.
- **Row actions:** Open, Unarchive, Sort by, Move to Trash (🗑).
  - No +, ☺, rename (F2 does nothing) or move.
  - The Archive's tree sits outside the explorer's drag-and-drop, so nothing drags in or out.
- **A read-only page:**
  - the editor takes no edits, except changes from the disk;
  - the formatting toolbar and the width menu are hidden;
  - the title field is read-only;
  - the subtitle shows as text;
  - the icon is shown but can't be picked;
  - cover controls and relationships are off;
  - the banner reads "This page is archived. Unarchive it to edit it."
- **Rust:** refuses, with `notPermitted`:
  - `page_write`, `text_write`, `page_create_conflict_copy`;
  - `entry_rename` from or into `.archive`;
  - `entry_create_page`, `entry_create_folder`, `entry_create_text` in it;
  - `attachment_paste`, `attachment_import`, `cover_pick`;
  - `page_width_set`, `cover_height_set`, `cover_side_set`, `cover_width_set`.
- **Still allowed:** Unarchive (`archive_restore`), Move to Trash (`entry_trash`) and `folder_sort_set`.
- **Ruling:** the toolbar is hidden on archived pages rather than shown disabled. A disabled toolbar would still say "edit me".

### 17.6 The Trash, redesigned (Jose's approved mock)
- **Rust:** Trash items carry:
  - `size` (a file's bytes, or a folder's whole contents);
  - `pages` (a folder's pages, however deep);
  - `icon` (a page's frontmatter emoji, or a folder's).

  `nimw-asset` serves images directly in a real `.trash` folder for thumbnails: nothing else in it, and never through a link.
- **Rulings:**
  1. **Groups:** "Earlier this week" means the last seven days, after Today and Yesterday. Older items group by date; items with no recorded time go under "Date unknown".
  2. **Sorting:**
     - **Name** shows a single "All items" group.
     - **Original folder** groups by that folder.
     - The sort is remembered for the session, not saved.
  3. **Sizes** are 1024-based: `512 byte`, `840 kB`, `1.2 MB`.
     - The time of day shows for the last 48 hours, the date before that.
     - Pages show no size, as in the mock.
  4. **Thumbnails:** only images directly in `.trash` get one. A folder's images don't; a failed load falls back to the image glyph.
  5. **Selection:**
     - Restore runs over the ticked items one after another; each clash asks Keep both / Cancel.
     - Delete confirms once with the count.
     - Escape clears the selection unless a dialog is open.
  6. **Accessibility:**
     - each row is a list item named after its item;
     - group headings are hidden from assistive tech, and each list is named after its group;
     - the selection bar is a region named "Selection", with its count in a polite live region.

## 18. Settings with categories

Jose, on the evening of 2026-10-15: the single long Settings page becomes a menu of categories, styled like the file explorer. He approved the mock: the "Settings with categories" artboard on the M5b mocks canvas.

**Layout**
- The dialog is 960 × 680 px. It shrinks with the window, down to 720 × 520 px.
- **Left: a dark menu**, using the sidebar's tokens:
  - a "Settings" heading and a search field;
  - **App**: General, Appearance, Editor, Files and quick notes, Keyboard shortcuts;
  - **the open vault's name** (with its icon): This vault;
  - "Saved as you change" at the foot.
- **Right:** the category's title and a one-line description, a close button, then that category's controls. Only this pane scrolls.

**Rulings**
1. **Every category stays mounted; the others are `hidden`.**
   - Search reads every row, and This vault loads its settings once, as before.
   - The dialog's Tab trap skips controls inside hidden parts. Before this change, Tab could leave the dialog: the shell test caught it.
2. **Search filters rows by their visible text.** That is the label plus the choices, in the current language, ignoring case and accents.
   - A hint stays with the row above it.
   - The categories that match show under their own names; with none, the pane says "No settings match."
   - Clearing the search returns to the chosen category, and so does picking a category.
   - The filter is a DOM pass, marked `shortcut:` in the code. A row that appears later, such as a vault setting still loading, is checked on the next keystroke.
3. **Keyboard in the menu:**
   - ↑ and ↓ move through the categories and show each one as they go.
   - A click, Enter or Space moves focus to the pane's heading.
   - Arrows keep focus in the menu, so you can keep moving.
4. **The last category is remembered for the session.** It is a module variable, not a setting. This vault falls back to General when no vault is open.
5. **No entry points jump straight to This vault.** None exist today: Settings opens from the vault-name menu, ⌘, and the app menu.
6. **Keyboard shortcuts is a static table** (`features/dialogs/shortcuts.ts`), written with the platform's names (⌘ ⇧ ⌥, or Ctrl, Shift, Alt).
   - A unit test checks that every accelerator in `menu.rs` is listed.
   - The page-only keys handled in `useGlobalShortcuts` and the editor keymap were listed by hand. One shared table for code, menu and list would mean rewriting the shortcut handlers, so that wasn't done.
7. **This vault's own section heading is hidden** inside the pane, which already names it. Each category is a named `group`, not a region, so two "This vault" landmarks can't clash (axe `landmark-unique`).
8. **The old "Close" button at the bottom becomes the pane's ✕ button,** with the same accessible name, "Close". Escape and a click outside still save and close (§ M4b part 3).
9. **Theme is three preview cards,** still radios; the chosen card has an accent border. **Palettes are a 3-column grid.**
10. **The unused `settings.sections.appearance/editor/files` keys are removed.** The vault section still uses `settings.sections.vault`.
