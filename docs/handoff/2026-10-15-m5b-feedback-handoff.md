# M5b — Third feedback round (layout overhaul, icons, Trash and Archive, Auto save, fixes): Hand-off

**What this round is:** Jose's feedback of 2026-10-15 after testing the M4c + M5 build, 13 points in all. He answered four questions:
- **Trash:** both an in-app Trash and a 🗑 on every row, plus an **Archived** row above Trash.
- **Row actions:** + new page, ☺ icon, 🗑, and ….
- **Wide tables:** full editor width, centred.
- **Actions:** one round button at the bottom right that opens Search, Global View and Edit.
- **Archive** hides an item and keeps it working.

**Spec:** `docs/superpowers/specs/2026-10-15-m5b-feedback-design.md`.
- **§1–§9:** the design. §1 is the table of Jose's 13 points.
- **§10:** the rulings taken for Jose at design time.
- **§11–§14:** the amendments from each stream (A shell, B icons, C Trash and Archive, D fixes).
- **§15–§16:** the two final reviews, with what was fixed and what was deferred.

**Plans (as run):**
- `docs/superpowers/plans/2026-10-15-m5b-shell.md` (A)
- `docs/superpowers/plans/2026-10-15-m5b-icons.md` (B)
- `docs/superpowers/plans/2026-10-15-m5b-trash-archive.md` (C)
- Stream D (fixes) had no plan; its root causes are in spec §14.

**Branch:** `feat/m5b-feedback`, stacked on `feat/m5-search`. Merge order for the whole stack: M2c → M3a → M3b → M4 → M4b → M4b part 3 → M4c → M5 → **M5b**. Nothing is merged to `main`.

**How it was built:**
1. **Four streams in parallel**, each in its own worktree with its own plan and a full gate. They were cherry-picked into the round branch in the order A → B → C → D. One fix commit was needed after that merge.
2. **Two fresh-context Opus final reviews:**
   - Trash, Archive and icons;
   - the shell, Auto save and the fixes.
3. **Two parallel fix passes**, where every fix has a test that failed first. They were then merged, with one shared flush helper (§4).
4. **The dev-server check** of the merged branch found one more bug: a page clicked in the files didn't leave the Trash or Archived view. It was fixed with a test that failed first.

---

## 1. What changed, by Jose's points

| # | Jose said | What it is now |
|---|---|---|
| 1 | Quick actions on files and folders | Hovering or focusing a sidebar row shows **+** (folders: a new page inside), **☺** (pick an emoji), **🗑** (move to Trash, after the confirmation) and **…** (the row's menu, which right-click still opens). Attachments get 🗑 and … only. Delete / ⌘⌫ / Backspace on a focused row trash it, after the confirmation. The row menu gains **Icon…** and **Archive**. |
| 2 | Optional emoji, as in Notion | Pages, folders and the vault can each have one. It shows in the sidebar, before the page title, in breadcrumbs, on Global View cards, in search results, in the `[[` list and in the recent-vault list. The picker searches in English and Spanish names, keeps recent picks and has **Remove**. Its data is bundled (offline, 1,812 emoji up to Emoji 13.1, no skin tones). |
| 3 | A trash bin with confirmation | Deleting now moves the item into the vault's own **`.trash/`** folder, as Obsidian's "Move to Obsidian trash" does, after the same confirmation dialog. **Trash** sits at the bottom of the sidebar, with a count, and opens a Trash view: **Restore** (with Keep both / Cancel on a name clash), **Delete from vault** and **Empty Trash**. The last two ask first and send the files to the **system Trash** (macOS Trash / Recycle Bin), so the app never destroys anything. An Undo toast follows every delete. |
| 4 | Search filter rows overlap the list | The dialog no longer scrolls as a whole. The result list takes the remaining space and is the only part that scrolls. Each chip row shows two lines, then a dashed **+N more** chip. The filters scroll on their own past 40% of the window height. |
| 5 | Wide tables should use the full width | On a **Wide elements** page, a table wider than the text fills the editor from its left padding to its right padding, centred; narrow tables stay with the text. With line numbers on, the whole number column moves to the editor's left edge on wide pages. Code, maths and diagrams grow evenly on both sides up to the full width, without stretching. |
| 6 | ⌘F doesn't open search | **⌘F** opens Search from everywhere, as ⌘⇧F does. A short one-line selection in the editor becomes the search text. View → Search… shows ⌘F. On macOS, plain Ctrl+F stays "forward one character". |
| 7 | Settings into the app menu | macOS: **Notes In My Way → Settings… ⌘,**. On every platform, clicking the vault name in the sidebar opens a menu with **Settings…**, **Open another vault…** and **Close vault**. The gear button is gone. |
| 8 | Close X into a "Vault" menu | macOS has a new native **Vault** menu with **Open Vault…** and **Close Vault ⌥⌘W**. The same items are in the vault-name menu. The X is gone. Encryption isn't listed until it exists. |
| 9 | One floating button for Edit / Global View / Search; the title back in the page | A round **Actions** button sits at the bottom right. It opens **Search ⌘F**, **Global View ⌘2** and **Edit ⌘1**, and **⌘J** toggles it. Settings → Appearance → **Action button** offers Bottom right (default), Bottom left and Top right. **The top bar is removed.** The page title and subtitle sit at the top of the page, just below the cover band. The native window title shows "Page — Vault". |
| 10 | Drop the app icon by the vault name; vault emoji | The app mark is gone. The vault's ☺ button (**Add an icon to …**) sits before the vault name. |
| 11 | Collapsible sidebar | **⌘\\**, the **Hide sidebar** button in its header, or View → Toggle Sidebar. **Show sidebar** brings it back. The state is kept app-wide (`sidebarCollapsed`). |
| 12 | Auto save on/off; Saved green, Unsaved red | Settings → Editor → **Auto save**, on by default. With it off: **⌘S** (File → Save) saves. Leaving a page, closing the vault or a window, quitting (including Dock Quit and logout on macOS) or "Open in its vault" asks **Save / Don't Save / Cancel**, listing every unsaved page. **Saved** is green; **Unsaved** (with Auto save off), **Retrying** and **Not saved** are red; **Saving…** is neutral. The colours meet 4.5:1 in every palette, light and dark, on the header and on the veiled pill over a cover. |
| 13 | An Archived row above Trash | **Archive** (row menu) moves an item into **`.archive/`** at the same path. It leaves the sidebar, the Global View and normal search, but **links to it keep working** and it stays indexed. Search has an **Archived** chip in the SHOW row (formerly MEDIA). An archived page shows a banner with **Unarchive**. **Archived** sits above Trash in the sidebar, and its view has Unarchive and 🗑. |

### Under the hood

- **Index schema 4**, for page icons (`pages.icon`). The index rebuilds once on first open.
- **New Rust commands**, all main-window only and denied in `file-*` windows (real-ACL tests both ways):
  - `folder_icon_set`, `vault_icon_set`;
  - `bin_list`, `trash_restore`, `trash_delete`, `trash_empty`, `entry_archive`, `archive_restore`;
  - `window_title_set`.
- **Records:**
  - `.nimw/trash.json` and `.nimw/archive.json` hold each item's original path and time. The record is written before the move.
  - `.nimw/vault.json` gains `folderIcons` and `icon`.
  - Page icons are the frontmatter key `icon:`.
- **New settings:** `autoSave`, `sidebarCollapsed`, `actionButton`.
- **macOS quit guard** (`quit_guard.rs`): adds `applicationShouldTerminate:` to tao's app delegate, so Dock Quit, logout and shutdown reach the Save prompt when Auto save is off.
- **Removed:** `TopBar.tsx`, `deleteFlow.ts`, and the old OS-trash delete path from the UI.

## 2. Totals

- **Commits:** 52 on top of `feat/m5-search`, all SSH-signed:
  - the spec;
  - Stream A: 8; B: 8; C: 5; D: 4;
  - 1 merge fix;
  - the bins fixes: 4; the shell fixes: 18;
  - 2 integration fixes;
  - this hand-off.
- **Gate on the merged tip:** vitest **1473** tests (133 files); e2e **324 passed**, 8 skipped (Chromium + WebKit); cargo **494 passed**, 3 ignored. Every stage passed: install, lint, typecheck, i18n, vitest, build, fmt, clippy, cargo test, cargo deny, and e2e (Chromium + WebKit).
- **Windows compile check** (`cargo xwin check --target x86_64-pc-windows-msvc`): clean, with no warnings. `quit_guard` compiles to a no-op off macOS.
- **Dev server** (Vite in Chromium and WebKit, no page errors): Welcome, a vault, the Actions button, collapsing and reopening the sidebar, the icon picker on a row, the Trash and Archived views, ⌘F search, and a page with a wide table.

## 3. Needs the real window

### Jose, on the Mac (the built `.app`, not `pnpm dev`)

The Dock Quit and native-menu checks only mean something in the bundle.

1. **First open:** the index rebuilds once (schema 4). The sidebar has no top bar above the page, and the vault name has no app mark.
2. **Menus:**
   - Notes In My Way → **Settings… ⌘,** opens Settings.
   - The **Vault** menu: Open Vault… opens the folder dialog; **Close Vault ⌥⌘W** returns to Welcome.
   - Clicking the vault name in the sidebar shows the same three items.
   - File → **Save ⌘S**.
   - View → Search… shows **⌘F**.
3. **The Actions button:**
   - **⌘J** opens it; the group shows Search, Global view and Edit; Escape closes it and returns the keyboard to the button.
   - Try all three places (Settings → Appearance → Action button). In the Global View, check that it never covers **New entry** (bottom right), the zoom buttons (bottom left) or the toolbar (top right).
   - In Split mode, the last lines of the preview must stay readable above it.
4. **⌘\\** collapses and reopens the sidebar. Check that **Show sidebar** sits below the traffic lights and doesn't cover the breadcrumb, and that the keyboard lands on it after collapsing from inside the sidebar.
5. **⌘F** opens Search from the editor, from the Global View and from the explorer.
   - Select a few words in the editor first: they become the search text.
   - Plain **Ctrl+F** in the editor still moves the cursor forward.
   - The **filter rows** on your real vault: no overlap with RECENT; **+N more** on long rows; only the list scrolls. This is your original screenshot's case, which never reproduced in Playwright.
6. **Emoji:**
   - Hover a row, click ☺, search "dragon" (or "dragón"), pick one.
   - It shows in the row, before the title, in the breadcrumb, on the Global View card, in search results and in the `[[` list.
   - Give the vault one, and a folder one, then rename that folder: the icon follows.
   - Open the page in Obsidian: frontmatter `icon: "🐉"`.
7. **Trash:**
   - Delete a page with 🗑: the confirmation says "Move … to Trash?", then an Undo toast appears.
   - **Trash** shows it; **Restore** brings it back with its links.
   - Delete a folder, then Restore it.
   - **Empty Trash**: the items appear in the macOS Trash (Finder).
   - An Obsidian vault that already has a `.trash` folder: its items show as "From another app".
8. **Archive:**
   - Row menu → Archive: the item leaves the sidebar and the Global View.
   - A `[[link]]` to it still opens it, with the "This page is archived" banner and Unarchive.
   - Search with the **Archived** chip finds it.
   - Archived pages' images still show.
9. **Wide tables:** your "Military Ranks" page in **Wide elements**, with line numbers on and off. The table fills the editor edge to edge, centred, and the line numbers sit at the far left.
10. **Auto save off** (Settings → Editor):
    - Type in a page: the status reads **Unsaved** in red; **⌘S** turns it **Saved** in green.
    - Click another page: **Save / Don't Save / Cancel**. Cancel leaves everything (page, selection, back trail) as it was; Don't Save reverts the text.
    - With two unsaved pages, the dialog lists both by name.
    - Rename or move *another* page: the unsaved one stays unsaved (nothing written).
    - **Dock → Quit** with unsaved text: the prompt appears.
    - Log out with unsaved text: the logout is cancelled once, and the prompt appears.
    - Turn Auto save back on: the page saves within half a second.
11. **Window title:** "Page — Vault" in the editor; "Global view — Vault"; "Trash — Vault" and "Archived — Vault"; just the app name after Close Vault.
12. **Quick notes still work** (⌘⇧N into the Scratchpad, named from the first line), and **single-file windows** (⌘⇧O) still have their own header styling.

### The friend, on Windows (the `.exe`)

1. There's no menu bar. **Click the vault name** in the sidebar for Settings…, Open another vault… and Close vault. **Ctrl+,** also opens Settings.
2. **Ctrl+F** opens Search. With a dialog open or on the Welcome screen, check that WebView2's own find bar doesn't appear.
3. **Ctrl+\\** collapses the sidebar, **Ctrl+J** opens the Actions button, and **Ctrl+S** saves with Auto save off.
4. **Emoji on Windows 10 or 11:** pick a few from different categories. Newer emoji can draw as boxes on Windows 10; the list stops at Emoji 13.1 for that reason.
5. **Trash:** delete, then Restore, then **Empty Trash**: the files land in the **Recycle Bin**.
6. **Auto save off:** closing the window with unsaved text asks first. Windows shutdown or logout with unsaved text is **not** covered yet (deferred).
7. The wide table and the search filter rows, as on the Mac.

## 4. Reviews, fixes, deferred items and rulings

### Merge and integration fixes

- **After the A → B → C → D merge** (`5f961aa`): pressing ⌘2 then ⌘F at once left the keyboard on a Global View card under the Search dialog. The deferred card focus now lands only if focus hasn't moved.
- **After the fix passes:**
  - The two fix passes each added a "save only the pages that move" helper (`flushUnder` and `flushBefore`). They're now one, `flushBefore`. Archiving with Auto save off writes no other page, pinned by a test that failed against `flushAll`.
  - The dev-server check found that a page clicked in the files didn't leave the Trash or Archived view. Fixed, with a test that failed first.

### Final review: Trash, Archive and icons (spec §15)

No Critical issues. Fixed, each with a test that failed first:

- **I1:** a Trash or Archive record (`.nimw/*.json`, which a cloned or synced vault could carry) can no longer restore into a hidden folder such as `.git/hooks` or `.obsidian`. A rename can't move anything into a hidden folder either, which also closes an older `entry_rename` gap.
- **I2:** a `.trash` or `.archive` that is a symlink is refused. Before, a link back to the vault would have made Empty Trash send the whole vault to the system Trash.
- **M1 (re-graded Important):** an archived page no longer wins `[[links]]` meant for a live page with the same name.
- **M2:** restoring under a folder that's now a file goes to the vault root, with no endless Keep both loop.
- **M3:** a clash on Unarchive from the banner or from Undo asks Keep both / Cancel.
- **M4:** the Archived view's 🗑 asks first.
- **M5:** a trash toast's Undo restores only its own item.
- **M6:** Delete from vault also forgets Global View positions.
- **M8:** folder names keep their dots when numbered.
- **M7:** the cheap parts.

### Final review: shell, Auto save and fixes (spec §16)

No Critical issues. Fixed, each with a test that failed first:

- **I1:** with Auto save off, renaming, moving or trashing one item no longer saves every other unsaved page.
- **I2:** Dock Quit, logout and shutdown now reach the Save prompt on macOS (the quit guard).
- **I3:** file windows' header styling is restored.
- **I4:** the Actions button no longer covers Global View controls or the end of the Split preview.
- **I5:** the keyboard is no longer lost when the sidebar collapses.
- **Minor fixes:**
  - M1: Cancel truly changes nothing.
  - M3: orphaned pages don't nag.
  - M4: the prompt is an alert dialog listing pages by name.
  - M5, M6: focus fixes in the Actions group and after the row picker.
  - M8: Show sidebar no longer covers the breadcrumb.
  - M9: "+N more" accessibility.
  - M10: window titles.
  - M11: bidi characters are stripped from titles.
  - M12: Ctrl+F on macOS and WebView2.
  - M14: green and red contrast on the cover pill.
  - M15: dead code removed.

### Deferred (minor)

- **M2 (shell):** ⌘N, ⌘⇧N and a row's + create the file before any question, so Cancel in the Save prompt leaves a new "Untitled".
- **M7 (shell):** hidden row actions still reserve about 70 px, so long names are cut early. The scratch row's count hides only on hover.
- **M13 (shell):**
  - the Vault menu items aren't disabled while a file window is focused (they bring the main window forward instead);
  - the native ⌘, opens Settings over another dialog.
- **Windows shutdown or logout with Auto save off** isn't guarded. It needs `WM_QUERYENDSESSION`.
- **M7 (bins):**
  - `bin_list` runs on every tree refresh;
  - `archive_list` is O(files × records).
- **Notes, not fixed:**
  - Obsidian doesn't show `.archive`, so links to archived pages look unresolved there.
  - A vault that already has its own `.archive` folder gets it indexed.
  - A `.Archive` folder on a case-insensitive disk takes archived items.
  - A vault at `~` on macOS would list the system `~/.Trash`.

### Rulings to confirm (taken for Jose)

**Layout and menus:**
1. **Actions button:** bottom right as Jose asked, with Bottom left and Top right in Settings (from his first message). ⌘J toggles it. It's a disclosure button, not an ARIA menu.
2. **No menu bar on Windows or Linux.** The vault-name menu is the way to Settings, Open another vault and Close vault there, and on macOS too.
3. **No Open Recent submenu.** Close Vault goes to Welcome, which lists recent vaults.
4. **Accelerators:** Open Vault… has none (the page answers ⌘O; two dialogs would open), and neither does Toggle Sidebar (the page answers ⌘\\; two toggles would cancel out). Close Vault is **⌥⌘W**.
5. **The title sits just below the cover band,** not overlapping it as in Notion.
6. **The Global View's "Global view · level" heading is gone;** its breadcrumb names the level.
7. **The sidebar's collapsed state is app-wide,** not per vault.

**Auto save:**
8. **Red "Unsaved" only with Auto save off.** With it on, only failures are red, so there's no red flash while typing.
9. **Don't Save reverts to the last saved text.** One dialog covers every unsaved page.
10. **Header edits still save with Auto save off,** and so does a trash of the page itself. Settings says so under Auto save. A move or rename writes nothing.
11. **Logout with Auto save off is cancelled once** (macOS), then the prompt shows. There's no recovery copy.

**Search and wide pages:**
12. **⌘F opens search** until in-note find exists. Then ⌘F would become find-in-note, and search keeps ⌘⇧F.
13. **Wide pages move the whole line-number column to the left edge,** not only the wide rows' numbers. **Only tables stretch to the full width;** code, maths and diagrams grow to their own width.

**Icons:**
14. **Page icons live in frontmatter `icon:`;** folder and vault icons live in `.nimw/vault.json`.
15. **Emoji only:** no custom images and no skin tones. The list stops at Emoji 13.1, which Windows 10 can draw.
16. **"Is it an emoji"** uses hand-kept Unicode ranges (a marked shortcut), so a rare real emoji may be refused.

**Trash and Archive:**
17. **Delete goes to the vault's `.trash`,** not the OS trash. Deleting from the Trash sends files to the OS trash.
18. **Archive is a move into `.archive/`** at the same path. Obsidian sees it as a hidden folder.
19. **No schema bump for Archive:** "archived" means the path starts with `.archive/`.
20. **The scratch folder can't be trashed or archived;** its pages can.
21. **Trash keeps names, not paths** (`.trash/Old 1.md` on a clash). Widths, cover sizes and positions follow items in and back.
22. **Restoring under a folder that's now a file goes to the vault root** without saying why.
23. **An Obsidian `.trash` that is a symlink is refused.**
24. **There's no page-header menu yet,** so Archive is in the row menu, and Unarchive is in the banner and the Archived view.

## 5. Builds

- **Mac:** `target/release/bundle/macos/Notes In My Way.app`. Ad-hoc signed only. Finder's Open With and the Dock need the bundle.
- **Windows:** `target/x86_64-pc-windows-msvc/release/bundle/nsis/Notes In My Way_0.1.0_x64-setup.exe`. Unsigned, so SmartScreen asks: More info → Run anyway.
- **Index:** schema 4. Every vault's index rebuilds once on first open.
- **Rebuild:**
  - **Mac:** in `apps/desktop`, `CARGO_TARGET_DIR=<repo>/target pnpm tauri build --bundles app`.
  - **Windows:** cross-compiled on the Mac:

    ```bash
    cd apps/desktop
    export CARGO_HOME=$HOME/.nimw-cross/cargo RUSTUP_HOME=$HOME/.nimw-cross/rustup RUSTUP_TOOLCHAIN=1.99.0 XWIN_ACCEPT_LICENSE=1
    export PATH="/opt/homebrew/opt/rustup/bin:$CARGO_HOME/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
    CARGO_TARGET_DIR=<repo>/target pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
    ```
- **Gate on the merged tip:** ALL-OK: vitest 1473 (133 files), e2e 324 passed and 8 skipped, cargo 494 passed and 3 ignored. The full gate ran on `76c469a`; the last fix (`496d266`, TS only) was re-checked with the JS gate and the dev-server check.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| The vault opens with no icons and a long first open | The schema 4 rebuild; it happens once per vault. |
| Delete says the Trash can't be used | `.trash` (or `.archive`) is a symlink; replace it with a real folder. |
| Restore put an item at the vault root | Its record named a hidden folder, or its old folder is now a file; this is by design (§4 rulings 22 and I1). |
| An archived page's link opens a different page | A live page with the same name now wins (§15 M1). Links that existed at archive time were rewritten to the archived path. |
| Dock Quit with Auto save off quits without asking | `quit_guard::install` must run at `RunEvent::Ready` (macOS only). Check the console for the class `TaoAppDelegateParent`. |
| The emoji picker is empty | Its data chunk (`emoji.json`) is lazy-loaded; check the console for a failed chunk load. Regenerate with `pnpm gen:emoji <folder>` only if the data must change. |
| Ctrl+F shows WebView2's find bar | The page must `preventDefault` Ctrl+F everywhere on Windows and Linux (spec §16 M12). |
| `read fixture dir: NotFound` in cargo tests | A seeded target dir from a removed worktree. Run `cargo clean -p nimw-testkit -p nimw-desktop -p nimw-session -p nimw-vault -p nimw-index -p nimw-markdown`. |
| An e2e spec can't find the Search, Settings or Edit buttons | The top bar is gone. Use `e2e/shell.ts` (`openSearch`, `openSettings`, `showGlobalView`, `showEditor`). |
