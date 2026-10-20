# Round 3 feedback (2026-10-20)

Jose's first real-window pass over batch 6 (the Cybersecurity and Hacking Notion import). This spec covers the items that are already clear. Two items wait on Jose and are listed at the end: the welcome page (mocks shown) and Notion page icons (needs a decision about the export format).

Base: `main` at e0763b3 (batch 6, fast-forwarded by Jose). Branch: `feat/r3`.

## 1. Live Preview renders the whole page (stream A, editor)

**Problem.** In Live Preview, code blocks show their ``` fences, with the language and Shell/Copy pills placed inline on the fence line. List items show a raw `- `. The page reads as half-source.

**Wanted (Jose).** "Live preview should show the page totally rendered. Only when you click on the elements should they change to source, so they're editable." This is Obsidian's Live Preview behaviour.

**Rule.** A construct's Markdown syntax is shown only while the selection (any cursor or range) touches that construct. Otherwise the construct renders. For a block construct, "touches" means any selection head or anchor falls on one of the block's lines. For an inline construct, the cursor is inside the marked range or at its edges.

Constructs, each with a test:

1. **Fenced code blocks.** Hide both fence lines. Render the body as a block with the code background and the full width of the text column. A small header row sits at the top right with:
   - the language label (the existing language picker, keeping its Shell/… label);
   - the Copy button.

   Clicking into the block reveals the fences and the source. The header must not shift the text when it reveals. Syntax highlighting stays in both states. Indented code and ~~~ fences follow the same rule.

2. **Bullet and ordered lists.** Replace `-`, `*` or `+` with a bullet glyph, and keep ordered numbers styled. Nested levels indent correctly. Task items already render checkboxes; keep them.
3. **Blockquotes.** Replace `>` with a left bar, including multi-line quotes and the Notion `> ` + `> ` pattern seen in imports.
4. **Horizontal rules.** `---`, `***` and `___` render as a line.
5. **Headings, emphasis, strong, strike, inline code, highlights, links, wikilinks.** Keep the existing behaviour. Where a mark still shows when the cursor is away, hide it.
6. **Tables, math, Mermaid, callouts, images and embeds.** Keep the existing widgets. They already follow the rule.

The Source and Split modes are unchanged. Large-note limits (`LARGE_NOTE_CHARS`) still apply. Decorations must come from the syntax tree and only cover visible ranges, so typing on a 10k-line note stays smooth (existing perf tests).

### 1a. As built (stream A rulings)

1. **Fence lines stay as lines.** Off the cursor, the opening fence's text becomes the header row: the language badge and Copy, floated right. The closing fence becomes an empty line, which acts as the block's bottom padding. Revealing the source swaps text inside the same lines, so nothing below the block moves (tested in e2e). An unclosed fence keeps its last line. _Cost if wrong:_ if Jose wants the block tighter, about one line of height per block.
2. **A list marker reveals only on its own line.** Editing a nested child doesn't flip its parent's bullet. A task hides its `- ` too, leaving only the checkbox. _Cost if wrong:_ if he expects the whole item to reveal, a one-line change.
3. **Inline marks keep the existing line-based reveal** (§1.5 says keep it). This is not the "inside or at the edges" rule. _Cost if wrong:_ a cursor-range check in `wrapped` and the link click.
4. **Decorations are still built for the whole document**, as before, and large notes still get the reduced set. The perf tests stay green. _Cost if wrong:_ a visible-ranges rewrite if 10k-line notes lag.
5. **Not done:** setext heading underlines (`===` and `---` under a line) still show. Notion exports don't use them.

## 2. Sidebar (stream B)

1. **Resizable.** A drag handle on the sidebar's right edge:
   - limits 200–560 px;
   - double-click resets to the default;
   - the arrow keys move it when the handle is focused (role `separator`, `aria-valuenow`);
   - the width persists in the app settings (`sidebarWidth`).

   The collapsed state is unchanged. Labels use the space they have and only truncate when they actually overflow.

2. **Icons never shrink.** In the screenshot, the page icons on "Hardware & E…" and "Web Applicati…" render smaller because flex shrinks them. Item and emoji icons get `flex: none`.
3. **Row hover actions.** These are exactly, in this order:
   - favourite (a star, filled when the item is a favourite; toggles);
   - icon (a new, full-contrast "add emoji" glyph; the current faded smiley goes);
   - trash (unchanged, with its confirmation).

   The "…" button goes, and right-click keeps the context menu. _My call:_ "+" (new page in this folder) also goes from the row because Jose listed only three. It stays in the context menu. Archived rows show no trash, as today.

4. **Context menu label.** "New quick note" becomes "Create new scratchpad in this vault" (es: same meaning, using the existing Spanish terms for scratchpad and vault). The behaviour and the ⌘⇧N shortcut are unchanged.

### §2 amendments (stream B, as built)

- **The "New quick note" label is in the File menu.** The context menu never had a quick-note item; Jose's "file context menu" is the macOS **File** menu. It now reads **Create New Scratchpad in This Vault** (Title Case, like the other menu items; the native menu is English-only). The Settings → Shortcuts row for ⌘⇧N reads "Create new scratchpad in this vault" (es: "Crear una nota rápida nueva en esta bóveda"). The behaviour is unchanged: on the Welcome screen it still goes to the global Scratchpad. _Cost if wrong:_ if he meant another menu, it's a one-string move.
- **Width.** `sidebarWidth` is app-wide in `settings.json`, 270 px by default, and clamped to 200–560. An out-of-range number is clamped; a non-number resets on its own with the usual warning.
  - Keys save on each press: ←/→ by 16 px, Shift ×4, Home/End to the limits.
  - A drag saves once, on release. A double-click resets.
  - _Cost if wrong:_ a per-vault width would need a `.liber/vault.json` key instead.
- **Hidden actions take no room.** Before, the invisible actions (opacity 0) still took ~100 px, which is why "Bug Bou…" was cut short with space to spare. Now they are `max-width: 0` until hover, focus or selection. While the pointer is on a row, its name gives way to the three buttons; Notion does the same.
- **★ on rows.** Pages and folders get it, but attachments and Archived items don't, matching what the context menu allows. It is labelled "Add {name} to Favorites" / "Remove {name} from Favorites" and has `aria-pressed`.
- **Favorites section rows.** They lose their "…" as well (right-click and Shift+F10 still open the menu) and keep their filled ★ only. _Cost if wrong:_ he may want ☺ and 🗑 there too, which is a small addition.
- **"+" removed.** New page inside a folder is in its context menu ("New page"). The m5b-icons e2e now uses the menu.

## 3. Dialogs and fields (stream C)

1. **Notion import dialog bug.** The dialog renders with no padding:
   - the title is clipped at the left ("ımport");
   - the fields and buttons touch the edges;
   - the empty vault-name input has no placeholder.

   Find the root cause; the dialog probably doesn't use the shared dialog shell or its class. Make it match the other dialogs: the padding, a header with a close button, labels above fields, and a footer.

2. **Move dialog shows a folder tree.** It replaces the flat `<select>`-style list of full paths and works as follows:
   - folders expand and collapse;
   - the item's current folder is marked and disabled;
   - the vault root appears as the top row;
   - type-to-filter narrows the tree and keeps the ancestors of matches;
   - the keyboard follows the tree pattern (up and down move, right expands, left collapses, Enter moves).

   Show folder icons and emoji. Archived and Trash are not targets.

3. **One field size across the app.** Text inputs, selects, number inputs, and the read-only "path" fields in dialogs all share one style: the same height, border, radius, padding and font. The style lives in one shared stylesheet, and the per-component overrides that differ go away.

   Settings shows the mismatch today: selects are 44 px with a small radius, while text inputs are 62 px and fully rounded. Pick the select's size, about 40–44 px with `--radius-md`, and apply it everywhere, including search fields, the import dialog, and the Move dialog filter.

### 3.4 Amendments (stream C, as built)

1. **Root cause of the Notion dialog bug.** It passed `wide` to `Dialog` to get Search's 780 px width. `wide` also carried Search's frameless layout (`padding: 0; gap: 0`). Now `wide` is only the width, and Search's layout is a new `bare` prop (`<Dialog wide bare>`). The vault name field gets a placeholder ("Named after the export").
   - _Ruling:_ no close button in its header. The other single-pane dialogs have none either; they use Cancel and Escape. Only Settings, with its panes, has one. _Cost if wrong:_ one button.
2. **Field size.** It is **36 px**, not the 40–44 px §3.3 guessed.
   - The screenshot was at 2×. What it showed was a 22 px native WebKit select beside a 31 px input, and 36 px is the height of `.btn`, so a field lines up with the button beside it (the Notion dialog's "Choose export…").
   - The shared class is `.field-control` in `theme/fields.css`. Selects draw their own arrow (`appearance: none`), since WebKit's native select ignores height and radius. `.field-sm` (28 px) goes beside `.btn-sm`, which is the recorder bar's microphone select.
   - _Cost if wrong:_ one number in `fields.css`.
3. **Fields that keep their own look.** These are inline editors or bars with their own control size, listed in `theme/fields.test.ts`:
   - the page title and subtitle;
   - the tree row's rename field;
   - the Search dialog's query bar;
   - Settings' menu search, in the dark menu;
   - the formatting toolbar's select, 30 px like its buttons.

   _Cost if wrong:_ moving a file out of the exempt list.

4. **Move dialog.**
   - Hidden folders (any path segment starting with `.`) are not targets. That covers the Archive and the Trash.
   - The item's own subtree is left out, not shown as disabled.
   - The root and the ancestors of the current folder start open.
   - Enter on the current folder does nothing. Double-click moves.
   - Folders without an emoji show the folder glyph.

## 4. Testing

- Each item gets a test that fails first: vitest for the logic and components, Playwright e2e for the sidebar drag, the Move dialog keyboard, and Live Preview reveal/hide.
- The full gate (`check.sh all`) must pass on each stream and again after integration.

## 5. Jose's decisions (2026-10-20)

- **Welcome page overhaul.** Three mocks are in the brainstorm companion: A launcher, B start page with vault cards, C vault switcher. We build once he picks.
- **Notion page icons.** The "Markdown & CSV" export carries no page icons. I checked his zip: every page starts with `# Title`, and "📚 Resources" only has an icon because the emoji is part of its title. Notion's HTML export has a `page-header-icon` and a cover image for each page. **Decision:** the importer will accept HTML exports, _after_ the round 3 feedback items are done (round 3b).
- **Folder pages.** **Decision: merge.** A folder and its same-name page become one row (§6).

## 6. Folder pages (stream D, after A–C land)

A Notion page with sub-pages becomes a page plus a folder of the same name, so the sidebar listed "Bug Bounty" twice. From now on, a folder can _be_ a page, as in Notion.

1. **Convention.** A folder `X/` has a page when `X/X.md` exists (the "inside" convention). This is the default of Obsidian's Folder Notes plugins, so vaults stay compatible. Only the inside form is recognised. A sibling `X.md` next to `X/` stays an ordinary page.
2. **Sidebar.** The folder row works like this:
   - clicking its label opens `X/X.md`, and the chevron alone expands or collapses it;
   - it is highlighted while that page is open;
   - it shows the page's icon, or the folder's icon when the page has none;
   - `X/X.md` is not listed again among the folder's children.

   The row's context menu has the folder actions plus the page ones that make sense: favourite, icon, open in Global View.

3. **Keeping the pair together.** Renaming the row, or renaming the page by its title, renames both, `X/X.md` → `Y/Y.md`, through the existing rename path so links are rewritten. Moving or trashing the row moves or trashes the whole folder; the trash confirmation names the page.
4. **Creating one.**
   - A folder without a page gets "Add a page to this folder", which creates `X/X.md` and opens it.
   - A folder with a same-name sibling `X.md` gets "Use X.md as this folder's page", which moves it inside through the existing move path, so links are fixed.
5. **Breadcrumb.** `X/X.md` reads `… / X`, not `… / X / X`.
6. **Notion importer.** A page with children is written as `X/X.md` and rewritten links point there. The import report is unchanged otherwise.
7. **Elsewhere.** Search, Global View, favourites and backlinks treat `X/X.md` as the ordinary page it is.

## 7. Welcome page, option A "Launcher" (stream E)

Jose picked mock A: "clean, pretty, perfect". The mock is `.superpowers/brainstorm/12538-1792502930/content/welcome.html`, first card, and is not committed. The page has two columns that fill the window.

- **Left: start (≈330 px, surface background, right border), top to bottom:**
  1. The brand mark, the app name and the version under it.
  2. The tagline.
  3. Three stacked full-width buttons:
     - New vault, primary, which picks a folder and creates the vault;
     - Open folder as vault;
     - Quick note.

     Each button shows its keyboard hint only if that shortcut works on the Welcome screen.

  4. "More ways to start", as accent links:
     - Open an Obsidian vault;
     - Open a single file…;
     - Import from Notion….
  5. At the bottom, the language toggle (English / Español) and "🔒 Local only".
- **Right: recent vaults (dotted background):**
  - The "Recent vaults" label, with a filter field on the right. The filter matches name or path and only shows when there are more than 5 vaults.
  - One card holds the rows. Each row has the vault emoji (or the quick-notes icon for the global Scratchpad), the name, and the path with a middle ellipsis. The right side shows meta: when it was last opened (relative), plus the page count if it's cheap to get. _Builder's call, record a ruling._
  - On hover or focus, a row shows "Show in Finder" (Explorer on Windows) and "Remove from list". A missing vault is dimmed and reads "Can't open".
  - The first row is highlighted as the most recent.
  - The empty state keeps today's dashed box.
  - The credits line sits at the bottom of this column.
- **Narrow windows.** Below ~720 px wide, the two columns stack, start first.
- **Unchanged.** All existing behaviour is kept: opening overlay `inert`, missing vaults, forgetting, quick notes, single file, Notion import. Only the layout and the new filter, meta and reveal change.
- **Fields.** Use the shared field style from stream C.

### §7 amendment (stream E rulings)

1. **No page count.** Counting pages means walking each vault folder, or opening its index database, every time the Welcome screen loads. That is slow for iCloud vaults and for unmounted drives. The meta shows only when the vault was last opened, e.g. "5 minutes ago" or "yesterday", through `Intl.RelativeTimeFormat` in the UI language. _If wrong:_ the count gets added later through a cheap source, such as the index's row count.
2. **⌘N and ⌘O work on the Welcome screen.** Its own key handler makes them work, because the shell's shortcuts aren't mounted there and the menu has no accelerator for either. ⌘⇧N was already global, through `ScratchpadHost`. All three buttons carry `aria-keyshortcuts` and show the key in the platform's spelling. _If wrong:_ the hints are drawn from one table, so removing them is a small change.
3. **Reveal goes through a new `vaults_reveal` command.** It refuses any path that isn't on the recent list, so the webview can't reveal arbitrary paths. A missing vault has nothing to reveal and shows only "Remove". The existing `external_reveal` needs an open vault, so it can't serve here.
4. **The filter appears from 6 vaults.** That is "more than 5", per the spec. It matches the shown name, so the global Scratchpad matches "Quick notes", and it matches the path.
5. **The middle ellipsis on paths is character-based (52 characters).** The full path is in the row's tooltip. It is marked `shortcut:` in the code.
6. **Labels follow the mock:**
   - "New vault"
   - "Open folder as vault"
   - "Quick note"
   - "Import from Notion…"
   - "Open a single file…"
   - "Recent vaults"

   The old `welcome.*` strings change in both languages. The language toggle keeps its accessible name, "Language", but loses its visible label, as in the mock.

## 8. Round 3b: Jose's notes after testing the round 3 build (2026-10-20)

1. **Double-click on a sidebar page.**
   - **When the editor isn't showing that page** (another page, the Global View, the Trash page, or the search dialog over it): open the page in the editor in the user's current editor mode, and focus the text.
   - **When the editor is already showing that same page:** start the inline rename on the row, using the existing rename UI.
   - **Single click** is unchanged.
   - **Folder pages (§6)** follow the page rule. Plain folders keep their current double-click behaviour.
2. **Search results show the page's icon in their icon box.** Today the box shows the generic file glyph, and the page's emoji sits inline before the title (screenshot: "🐜Información General"). The fix:
   - the leading box shows the page's icon (emoji or custom), or the file-type glyph when there is none;
   - the title no longer repeats the icon inline.

   The same rule applies to every list that shows pages: the ⌘K picker, the `[[` link picker, Favorites and the recent lists. The plan checks each one.

3. **Folder pages (§6)** are part of round 3b.

### §8 amendment: round 3b rulings as built (2026-10-20)

1. **The pairing lives in `VaultSession::rename` (Rust).** Every rename path gets it: tree, title and drag. The second step comes back as `RenameOutcome.pair`. The UI then composes both moves and reloads the open page once, straight to `Y/Y.md`. Only an in-place rename pairs; a move to another folder never does. _If wrong:_ the pairing moves to the UI.
2. **A taken pair name refuses the whole rename before anything moves.** A case-only pair is left to the vault's case-only rename. _If wrong:_ the user sees "already exists" and nothing moved.
3. **"Add a page to this folder" is hidden when a namesake `X.md` sits beside the folder.** Only "Use X.md as this folder's page" shows, because creating `X/X.md` next to `X.md` would make two pages answer `[[X]]`. _If wrong:_ one condition.
4. **On a folder-page row, ★, ☺ and the menu's Favorites and Icon… act on the page.** The folder's own icon shows only when the page has none. The §6.2 "open in Global View" action isn't added: pages have no such menu action today. _If wrong:_ the folder icon is settable only on folders without a page.
5. **Importer:**
   - **Folder pages are named before their folder's children,** so a child with the folder's own name can't take `X/X.md`.
   - **A database index moves inside its rows folder** (`Tasks/Tasks.md`) when the table has rows.
   - **Existing m7 test expectations changed accordingly.** _If wrong:_ the numbering of such a child, or one condition.
6. **Double-click decides from the state before its first click** (Review Focus 3). Text and code files double-click like pages. A Favorites row only gets the "open for editing" half. _If wrong:_ one condition.
7. **Page lists.**
   - **Search:** the page's icon wins over the cover in the result's box.
   - **The `[[` list:** an attachment without an icon shows the explorer's image glyph, a page the page glyph, and headings get no box.
   - **+ Related page's picker** shows the same box.
   - **The Favorites rows** already showed the icon in place of the glyph.
   - _If wrong:_ one glyph.

### §8 final review fixes (2026-10-20)

A fresh-context review of round 3b plus spell checking found 4 Important and 8 Minor issues. All were fixed test-first on `fix/r3-final`. The round 3b ones:

- **Paired rename (#1).** The second step is now checked _before_ the first move, in the coordinates it has now:
  - the new folder name must pass `validate_name` and the hidden-path rule;
  - a clash at `from/<to>.md` (folder rename) or at the sibling folder (page rename) refuses the whole rename;
  - case-only pairs use the vault's same-entry check (`Vault::same_entry`).

  As a backstop, if the second step still fails (an I/O error), the first move is undone and a warning is emitted.

- **Reported paths (#5).** Files the first step rewrote are reported at their paths after the second step.
- **Unicode case (#6).** Case-only pair renames work with accented letters, e.g. `árbol` → `Árbol`.
- **Database index (#9).** It claims its rows folder's page (`Tasks/Tasks.md`) before row pages are named, so a row titled like its database becomes `Tasks/Tasks 1.md`.
- **Folder pages (#10).** Only sub-pages (a `.md` page or a database) make a page a folder page. A page whose folder holds only attachments stays `X.md`, with its attachments where Notion put them. _Ruling:_ the earlier `b6_review_i5` test expected `Home/Home.md` for a page with one attached CSV and now expects `Home.md`.
- **Flaky sidebar drag (found in the gate).** A pointer release saved the width from the last _rendered_ state. On a busy machine the release can arrive before the last move renders, so the edge snapped back to 270. The release now computes the width from its own position, and the e2e waits for the edge and checks `aria-valuenow`.

## 9. Sub-pages and case-insensitive folder pages (2026-10-20)

Jose, after testing his vault: a folder `SmartJob/` holding `Smartjob.md` didn't merge into one row, and he wants sub-pages: "I don't see how to attach a current page to another page."

### 9.1 Case-insensitive folder pages

- **One shared rule.** A folder `X/` has its own page when it contains `X.md`, or else a page whose name differs from `X.md` only in letter case or Unicode form (NFC, lower-cased). An exact name wins over a case variant. A folder named `X.md` never counts.
- **Where the rule lives.**
  - Rust: `Vault::folder_page_of` and `Vault::child_named` (`liber-vault/src/fsops.rs`).
  - UI: `folderPageOf` (`stores/tree.ts`), used by the tree, the breadcrumb, the delete dialog and the menus.
  - `isFolderPage` (name-only) is gone. The breadcrumb now asks the tree.
- **Paired renames** (`paired_rename`) find the page through `folder_page_of`, so `SmartJob → Work` takes `Smartjob.md` along as `Work/Work.md`.
- **"Match the page name to the folder"** (es: "Igualar el nombre de la página al de la carpeta") appears on a folder whose page differs only in case. It renames `X/x.md` to `X/X.md` through the ordinary rename. That rename leaves the folder where it is: the pair's second step is skipped when it would rename the folder to its own name.

### 9.2 Add sub-page

- **Where:** page rows only (not folder rows, not Archived rows) get "Add sub-page" (es: "Añadir subpágina").
- **On a plain page `P.md`,** one Rust command, `entry_make_folder_page`, does three things:
  1. creates `P/`, or reuses an existing sibling folder of that name in any letter case that has no page;
  2. moves `P.md` to `P/P.md` through the ordinary rename, so links are rewritten;
  3. the UI then creates "Untitled" inside, with the inline rename started, exactly like New page.
- **On a page that is already a folder page,** it just creates the new page in that folder.
- **Refused, with nothing moved,** when:
  - a file holds the name `P`;
  - the folder `P/` already has its own page;
  - the page already is a folder page (for the command itself);
  - the page is archived;
  - the write fails, e.g. on a read-only vault. A folder the command had just created is removed again.
- **Undo:** the app has no undo for moves or renames, so "Add sub-page" isn't undoable either. A user reverses it by dragging the page back out and deleting the new page.

### 9.3 Moving under a page

- **Sidebar drag and drop.** A page row is a drop target, ringed like a folder target, with pointer or keyboard drag.
  - Dropping item I onto page P first makes P a folder page if it isn't one, then moves I into `P/`. Both go through the existing move paths, so links follow.
  - Forbidden drops (greyed):
    - onto itself;
    - into its own descendant;
    - where it already is;
    - a folder onto its own folder page;
    - onto an archived page, or an archived item onto a page.
  - Spring-loading only opens folders.
- **Move to… dialog.** Pages are targets too, with their icons and without `.md`. A folder page appears once, as its folder's row. The filter matches page names. Choosing a page does the same conversion, then the move.
- **Context menu:** "Move to…" already exists on page rows. No separate "Move under a page…" item.

### 9.4 Reveal in the file manager, and the File menu names the vault

- **Reveal item.**
  - Every row's context menu (pages, folders, folder pages, attachments, text files, archived items) gets it.
  - Labels: "Reveal in Finder" on macOS, "Show in File Explorer" on Windows, "Show in file manager" on Linux. es: "Mostrar en Finder", "Mostrar en el Explorador de archivos", "Mostrar en el gestor de archivos".
  - It goes through the new `entry_reveal(path)` command, which takes a vault path, resolves it inside the open vault and refuses anything outside it or missing.
  - TODO(E4): hide it in encrypted vaults, where it would show ciphertext names.
- **File menu.**
  - The item reads "Create New Scratchpad for <vault name>" while a vault is open, "Create New Scratchpad for Quick notes" for the global Scratchpad, and the generic "Create New Scratchpad in This Vault" otherwise.
  - Names longer than 40 characters are cut with "…".
  - It updates on vault open, create and close. A vault has no in-app rename; renaming its folder means reopening it.
  - The native menu stays English-only, as before.
  - The Settings → Shortcuts row says "Create new scratchpad for this vault" (es: "Crear una nota rápida nueva para esta bóveda").

### 9.5 Rulings (builder)

1. **The conversion is one Rust command** (`entry_make_folder_page`), not a create-folder plus a rename from the UI. That way the refusals and the cleanup of a just-made folder sit in one place. *Cost if wrong:* none; it reuses the rename.
2. **A sibling folder `P/` that already has its own page refuses** Add sub-page and moving under `P.md`, rather than merging two pages. *Cost if wrong:* the user moves things by hand.
3. **A page target's folder is predicted by exact name** in the drop rules (`P.md` → `P/`). The case-insensitive reuse of an existing sibling folder happens in Rust. *Cost if wrong:* a drop could look allowed onto a page whose case-variant sibling folder already holds the item; Rust then refuses it with a toast.
4. **"Open folder in Finder" is not a separate item.** Reveal on a folder already shows it selected in its parent.
5. **The menu label updates from Rust** where a session opens or closes (`open_session`, `vault_close`). Notion import and the Scratchpad go through the same `open_session`.
