# M4b, part 3 — Second feedback round (Windows test, Obsidian vault): Design

**Status:** agreed with the maintainer on 2026-10-15.
- **Where the feedback came from:** the maintainer's Mac check and a tester's check on Windows with a real Obsidian vault.
- **Decisions:** six answers settled the open questions (titles, side covers, link formats, picked files, atoms, the Windows cover).
- **Base:** builds on M4b parts 1 and 2. Branch `feat/m4b3-feedback`, stacked on `feat/m4b-feedback`.

| # | Feedback | Section |
|---|---|---|
| 1 | Some Obsidian titles aren't shown | §1 |
| 2 | On Windows, Global View cards ignore the cover's repositioned part | §2 |
| 3 | Covers can also sit vertically on the left or right; the Global View shows them that way too | §3 |
| 4 | Pages and folders look almost the same on cards; pages say "Edit", not "See all" | §4 |
| 5 | With many connections, parent/child lines and "links from inside folder" lines are hard to tell apart | §5 |
| 6 | "See atoms": break a page into its components and show them as a graph | §6 |
| 7 | The Format bar can pick files and images through the OS file dialog | §7 |
| 8 | Optional: show attachments' whole local path | §8 |
| 9 | Attach with absolute or relative paths, e.g. `![[D:\Docs\my-file.pdf]]` | §9 |

---

## 1. Titles: a first-line H1, else the file name

**The problem.** PG-01 took the first H1 *anywhere* in a note as its title. In the tester's note "Tipos de comisiones":
- The first H1 is a section heading halfway down: `# WIP (Work In Progress):`.
- The card, the lists and the "Title in the note" label therefore showed "WIP (Work In Progress):".
- Obsidian shows the file name.

**The rule, from the maintainer:**
- A page's title is the text of an H1 only when that H1 is the **first block of the body**:
  - after the frontmatter;
  - leading blank lines don't count;
  - ATX `# ` or setext `===` both qualify.
- Otherwise the title is the **file name** (stem).
- An H1 further down is a heading, never the title.

**Where it applies:**
- It applies wherever the indexed title is used: Global View cards, link lists, `[[` labels and the "Title in the note" label.
- The label still shows only when a first-line H1 differs from the file name.
- The top bar keeps showing and renaming the file name, as today.

**Migration:** existing indexes are rebuilt once on upgrade (the index schema version is bumped), so every vault's titles refresh without user action.

**Product spec:** PG-01 now reads "Title = an H1 that is the first block of the body; fallback to file name".

**Tests (Rust `title.rs`):**
- `pg_01_first_h1_anywhere_in_the_page` is replaced by its opposite.
- New cases:
  - frontmatter followed by an H1;
  - blank lines followed by an H1;
  - a paragraph followed by an H1 (gives the stem);
  - the tester's shape: paragraphs, a link, then `# WIP (Work In Progress):` (gives "Tipos de comisiones");
  - a setext H1 at the top.

## 2. Global View card covers on Windows (WebView2)

**Report.** On Windows, card covers show the top of the image, not the part chosen with Reposition (`cover-y`). On macOS they're right.

**Cause, to be confirmed in Chromium by a failing test first:**
- Each card's `.cover` box is a grid with `place-items: center` and an `auto` row.
- In Chromium (WebView2 is Chromium), the image's `height: 100%` doesn't resolve against the 96 px box. The image keeps its natural height, so `object-fit: cover` has nothing to crop and `object-position` does nothing.
- The box clips at its top edge.
- WebKit resolves the percentage, which is why macOS looked right.

**Fix:** the cover frame gets a definite size. The image fills it absolutely (`position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover`) with `object-position: <cover-x>% <cover-y>%` (§3 adds cover-x).

**Audit:**
- Every place that crops with `object-fit` is checked in Chromium: the header band, Reposition mode, cards, atom thumbnails (§6) and the side strip (§3).
- An e2e in the **chromium** project asserts that the image's rendered box equals its frame and that the visible part follows the stored focus.
- It must fail before the fix.

## 3. Side covers: a tall strip on the left or right

**Placement**, per page:
- **Top** (default, today's header band), **Left** or **Right**.
- Stored in `.liber/vault.json`:
  - `coverSides: { "<page path>": "left" | "right" }` (absent = top);
  - `coverWidths: { "<page path>": <px> }` (absent = 280).
- Both follow renames and moves and are forgotten on delete, through the same choke points as `coverHeights`.
- Notes are only written for the focus point: frontmatter `cover-x` (0–100, beside the existing `cover-y`), written only when a side cover is repositioned. Obsidian ignores it.

**Commands** (validate a visible indexed page, write atomically, keep unknown keys, real-ACL tests):
- `cover_side_set(path, side: "top" | "left" | "right")`. `top` clears the entry.
- `cover_width_set(path, width: number | null)`. Rust clamps to 160–2000; `null` clears.
- `vault_settings_get/set` report `coverSides` and `coverWidths`, as they do `coverHeights`.

**UI:**
- **Placement control:** the cover actions gain a three-button radio group, **Top / Left / Right**, each with an icon:
  - `role="radiogroup"`, each button `role="radio"` with `aria-checked`;
  - shown beside Change, Reposition and Remove whenever the page has a cover;
  - choosing a placement takes effect at once and is undoable with ⌘Z, like the cover edits in M4b.
- **Strip layout (left or right):**
  - The page area becomes two columns: the strip and the content column. The content column holds the header band (in its plain, no-cover style), the editor and the outline.
  - The strip runs from below the top bar to the bottom of the window and is the outermost column: a right strip sits to the right of the outline panel.
  - The image uses `object-fit: cover`, `object-position: <cover-x>% <cover-y>%`.
- **Resize:**
  - Drag the strip's inner edge (`role="separator"`, `aria-orientation="vertical"`, `aria-valuenow`/`min`/`max`). The range is 160 px to 45% of the window width.
  - The keyboard works like the cover-height handle:
    - ← and → widen or narrow toward the content;
    - Shift for larger steps; Home and End;
    - Enter saves, Escape cancels;
    - double-click or Delete resets to 280.
- **Reposition:** a side cover drags in both axes. **Save position** writes `cover-x` and `cover-y`. A top cover keeps today's vertical-only reposition.
- **Narrow windows:** when the content column would fall below 520 px, the cover shows as a top band instead. Nothing is saved; widening the window brings the strip back.
- **Text views** (non-Markdown files) have no covers; nothing changes there.

**Global View cards:**
- A page card with a side cover (or a folder card backed by such an index page) shows the image as a 96 px wide strip on that side, below the head row and full card height. The title, subtitle and excerpt sit beside it.
- The card stays 240 × 300, so layouts don't move. The strip uses the same `cover-x`/`cover-y` focus.
- **The data:** `GvCard` gains exactly these two fields, so both sides of the work agree:
  - Rust `cover_side: CoverSide` (serde `"top" | "left" | "right"`, default `top`) and `cover_x: Option<u8>`;
  - TypeScript `coverSide: 'top' | 'left' | 'right'` and `coverX: number | null`.

## 4. Telling pages from folders on cards

**Page cards:**
- The footer button reads **Edit**, with a pencil icon (`aria-label` "Edit {title}").
- The kind label gets a page icon.

**Folder and project cards:**
- They keep **See all**, with a stack icon.
- The kind label gets a folder icon (projects: a briefcase).
- They look like folders:
  - a tab on the card's top-left edge;
  - a second sheet offset behind the card (border plus shadow, no extra DOM in the tab order);
  - a head row tinted with `--color-accent-soft`.
- Page cards stay a single plain sheet.

**Checks:** axe is clean in light and dark; the folder tint passes AA for the kind label on every palette (contrast test).

## 5. Edges that stay readable with many connections

**Each kind now differs in shape, not only in dash pattern:**

| Kind | Before | Now |
|---|---|---|
| Parent/child (`tree`) | muted, 1.5 px, dashed `6 5`, curved | muted, **1.25 px solid, orthogonal elbow routing** (down from the parent, across, down into the child), drawn first at 70% opacity |
| Direct link | accent, 2 px solid curve | accent, 2 px solid curve, **small arrowhead** at the target |
| Links from inside a folder (aggregated) | accent, 2.5 px dotted `1 6` | accent, 3 px **long dashes `10 6`**, curve, arrowhead and a **count chip** at the midpoint ("12 links") |
| Manual relationship | orange, 3 px solid | unchanged |
| Manual, aggregated | orange, dashed `12 6` | unchanged, plus the count chip |

**Focus mode:**
- Hovering a card, or focusing it from the keyboard, highlights its edges: full opacity, +1 px width.
- All other edges dim to 15% and unrelated cards to 55%.
- Leaving or blurring restores everything. It's driven by one CSS class on the canvas and a data attribute per edge, so no layout pass runs.

**Legend:** the toolbar's edge toggles show a small sample of each line style beside its label.

**Kept:**
- the dash scaling when zoomed out (`dashScale`);
- the per-kind batching that keeps WebKit fast.

The elbow paths are plain `M/L` commands.

## 6. See atoms

A page broken into its components and shown with the same graph tools.

**Entry points:**
- An **Atoms** icon button in the footer of page cards (before Edit; `aria-label` "See atoms of {title}").
- A **See atoms** item in the card menu.
- View → **See Atoms of This Page** in the app menu while a page is open in the editor.

**The level:**
- The Global View shows an atoms level for that page. The breadcrumb reads "… / Folder / Page title / Atoms".
- Back works as at other levels: the breadcrumb or Escape.

**The model**, built in the frontend from the page source with the same parser as the preview (`parsePage`):
- **Page root:** the page's card, as at other levels.
- **Sections:**
  - Each heading starts a section that runs to the next heading of the same or a higher level; sections nest by level.
  - A section card shows the heading text, its level ("H2") and its block count.
  - Content before the first heading hangs from the page root.
- **Atoms:** one card per block, in reading order. Each is 200 px wide and at most 140 px tall, with a kind label and icon on top:
  - paragraph: its first three lines;
  - list or task list: the first three items, plus "N items" or "done/total";
  - quote or callout: its first lines;
  - code: the language and the first four lines in mono;
  - table: the column names and the row count;
  - image: a thumbnail (an embed alone in its paragraph counts);
  - audio, a file embed, a note embed: the name or title;
  - a maths block: rendered with KaTeX;
  - Mermaid: the rendered diagram, lazily, falling back to "Diagram" and its first line.
  - Frontmatter and horizontal rules are skipped.
- **Edges:**
  - Structure (page → sections → sub-sections → atoms) uses the parent/child style from §5.
  - Each atom that links to or embeds another page draws a link edge to that page's card, in a "Linked pages" column on the right (one card per page).
  - The page's `related:` entries draw manual edges from the page root.
- **Layout:**
  - Automatic and deterministic: top-level sections are columns under the root, atoms are stacked in order, and sub-sections are nested inside their parent's column.
  - Positions aren't saved. Cards can be dragged during the visit, and **Reset layout** restores the automatic layout.
- **Interaction (read and jump):**
  - Click or Enter on an atom opens the page in the editor with the cursor at the atom's first line, scrolled into view, and the block flashes for 1 s. A section card does the same at its heading.
  - Linked page cards behave like page cards elsewhere (Edit, Atoms).
  - The arrow keys move between cards; Escape goes back.
  - Read-only: there's no connecting or reordering at this level.
- **Live:** the map follows edits to the page, from the editor or the disk.
- **Large pages:**
  - At most 400 atom cards. Beyond that, each section ends in a "+N more" card that opens the editor at the first hidden block.
  - React Flow renders only the visible cards (`onlyRenderVisibleElements`).

## 7. Insert a file from the system dialog

**The Attach button:**
- A Format bar button with a paperclip icon: **Attach** (tooltip "Insert a file or image…").
- It opens the OS file dialog (multiple selection) through a Rust command, following the `cover_pick` pattern: `file_pick() -> string[]`, absolute paths, with an injected picker in tests.
- The filters are Images, Audio, Documents (pdf) and All files.

**Copy or link (asked each time):**
- After picking, a popup anchored at the cursor (the `PickerPopup` placement) offers:
  - **Copy into the vault** (primary): uses the existing `attachment_import`, as drag and drop does;
  - **Link to where it is** (secondary);
  - **Cancel**.
- One line explains the choice: "Copies travel with the vault and open in Obsidian. Links keep the file where it is."
- Enter copies; Escape cancels.
- Files already inside the vault aren't asked about; they're linked directly.

**Insertion:**
- One embed per file, each on its own line, at the cursor, in one undoable transaction.
- Copies use the link format from §8.
- Links use the absolute form from §8: `![](file:///D:/Docs/my%20file.pdf)` (RFC 8089 file URLs, percent-encoded), because Obsidian opens that form and not `![[D:\…]]`.

## 8. How attachment links are written, and showing where files are

**Settings → This vault → Attachments → Link format for new attachments:**

| Option | Example |
|---|---|
| Shortest name (default) | `![[x.png]]` |
| Full path in the vault | `![[Assets/Comisiones/x.png]]` |
| Relative to the note | `![[../Assets/x.png]]` |
| Absolute path on disk | `![](file:///D:/Notes/Assets/x.png)` |

- **Storage:** `.liber/vault.json` `attachmentLinkFormat: "shortest" | "vault" | "relative" | "absolute"`.
- **When it's unset:**
  - Obsidian's `newLinkFormat` in `.obsidian/app.json` decides: `shortest` → shortest, `absolute` → full path in the vault, `relative` → relative.
  - Otherwise, shortest.
  - The settings row says "Following Obsidian's setting" when that applies. Choosing an option sets Liber Linteum's own value; Obsidian's file is never written.
- **What it applies to:** everything the app inserts as an attachment: paste, drop, and Attach → Copy. The `cover:` frontmatter keeps its own relative form.

**Settings → Editor → Show where attachments are on disk** (app setting `showAttachmentPaths`, default off):
- **What it adds:** a caption under each embedded image, audio player and file card, in the preview pane and in Live Preview widgets.
- **What the caption shows:**
  - the file's absolute location with the OS's separators (`D:\Notes\Assets\x.png` on Windows, `/Users/…` on macOS);
  - the text is selectable;
  - a **Copy** button announces "Copied".
- **Which files:** vault files and external files (§9) alike.
- **Data needed:** the vault's absolute root, from Rust (added to the vault info if it isn't there yet).

## 9. Absolute and relative paths in links and embeds

**Targets recognised** in `![[…]]`, `[[…]]`, `![](…)` and `[](…)`:
- Windows absolute paths: `D:\Docs\my-file.pdf`, `D:/Docs/x.pdf` and UNC `\\server\share\x.pdf`.
- `file:` URLs: `file:///D:/Docs/x.pdf` and `file:///Users/me/x.png`, percent-decoded.
- A leading `/`:
  - Obsidian treats it as vault-root-relative, so that is tried first;
  - if no vault file matches and an absolute file exists on disk at that path, the disk file is used.
- Relative paths `./x.png` and `../Assets/x.png`, resolved against the note's folder:
  - inside the vault, a normal vault file;
  - above the vault root, an external file on disk.
- **URL schemes:** a single drive letter is not a scheme. `has_scheme` (in `liber-markdown` and `liber-session`) needs at least two characters, so `D:\…` is a path and `mailto:`/`https:` are still URLs.

**Resolution:**
- It runs in Rust (indexer and `links_resolve`). Each link resolves to one of: a vault file (as today), an **external file** (an absolute path that exists), or missing.
- The index records external targets separately from vault targets. Backlinks, the Global View and the page graph ignore them; they aren't pages.

**Rendering:**
- **How external media is served:** through `liber-asset:` under a reserved prefix that `VaultPath` validation can never produce, so it can't collide with a vault path.
- **The allow-list:**
  - the protocol serves an external path only if it is the resolved target of a link in an indexed note of the open vault;
  - only regular files, never hidden files;
  - the same `CSP: default-src 'none'; sandbox` and the same MIME handling as vault assets;
  - the webview can't use it to read arbitrary disk files.
- **Images and audio** render as they do for vault files.
- **Other files (PDF, DOCX…):** a file card with **Open** (the system's default app, through the opener, behind the same allow-list) and **Show in Finder/Explorer**.
- **A missing external file:** the card reads "Not found: D:\Docs\my-file.pdf" and has no Create page button.
- **Plain links:** `[[D:\Docs\x.pdf]]` and `[x](file:///…)` open the file with the system app when clicked. Nothing opens on its own.
- **Watching:** external files aren't watched. Cards check that the file exists each time they render.

## 10. Testing

**Unit and component:**
- every section's own tests, TDD;
- Rust tests for the title rule, path recognition, the allow-list and the new vault keys;
- real-ACL tests for `cover_side_set`, `cover_width_set` and `file_pick`.

**e2e** (chromium and webkit, mock IPC):
- card cover crop (the chromium project catches §2);
- side cover layout and resize;
- the atoms level: entry, jump to a block, back;
- Attach → Copy and Attach → Link with a mocked dialog;
- link format settings;
- disk path captions;
- an external image through the mock.

**Quality floors:**
- axe clean in light and dark for every new UI;
- i18n in en and es;
- the Safari 15 rules (`jsCompat`, `cssCompat`).

**Gate and builds:**
- `check.sh all`.
- The Windows installer via cargo-xwin; the Mac via `pnpm dev`.
- Check `pnpm dev` itself, not just the build (lesson of the M4b blank window).

## 11. Out of scope

- Editing or reordering in the atoms map.
- Watching external files for changes.
- An inline PDF viewer; PDFs show as file cards with Open.
- A default placement setting for covers.
- Signing the Windows installer.

## 12. Delivery

Built in three streams in parallel, each with its own plan, worktree and signed commits:

| Stream | Sections | Plan |
|---|---|---|
| **A — Global View** | §2 (cards), §4, §5, §6 | `docs/superpowers/plans/2026-10-15-m4b3-global-view.md` |
| **B — Covers and titles** | §1, §2 (editor audit), §3 | `docs/superpowers/plans/2026-10-15-m4b3-covers-titles.md` |
| **C — Files and links** | §7, §8, §9 | `docs/superpowers/plans/2026-10-15-m4b3-files.md` |

**How they come together:**
- **Shared seams:** Stream A renders the side-cover cards from the `GvCard` fields that Stream B fills (§3). Streams B and C both bump the index schema version; one bump covers both on integration.
- **Integration order:** B, then A, then C.
- **After integration:**
  - one final review, then one fix pass;
  - the hand-off `docs/handoff/2026-10-15-m4b-part3-handoff.md`;
  - the Windows installer for the tester and the Mac app for the maintainer.

## 13. Amendments from planning (Stream B: §1, §2 editor side, §3)

### Titles (§1)
- **Empty headings:** an empty first H1 (`#` alone) is skipped like a blank line, so `#\n\n# Next` is titled "Next".
- **Other first blocks:** any other first block (a paragraph, an embed, a list, an HTML comment, a rule) means the file name.
- **One rebuild:** the index schema goes to v2 once for both §1 and §3's new `pages.cover_x` column.

### The editor's cover crop (§2)
- **Audit result:** the header band's image already sat in an absolutely positioned, definite layer, and the new strip uses the same layer.
- **How it was checked:** an e2e with a Windows (WebView2) user agent serves the asset host `http://liber-asset.localhost` a 400 × 1200 SVG. It confirms in both engines that each image fills its frame exactly and carries the stored focus.
- **Result:** no editor-side change was needed. The card fix is Stream A's.

### Side covers (§3)
- **Controls on a side cover:** the placement group, Change, Reposition and Remove (and Save/Cancel while repositioning) sit at the **foot of the strip**, shown on hover and keyboard focus. The band beside the strip is the plain band.
- **Placement group:**
  - It is a roving-tabindex radio group (one Tab stop; the arrow keys move and choose).
  - Choosing by keyboard, or clicking a radio that has focus, keeps focus on the chosen radio as the group moves between the band and the strip.
- **Undo:** the "undoable with ⌘Z" placement is an effect-only CodeMirror history entry, isolated from typing. Undo and redo re-save the placement they restore. It is recorded only while the page has an editor view; read-only pages can't undo it.
- **Reposition keys on a side cover** follow the ARIA slider convention: → and ↑ increase x and y.
  - The element stays `role="slider"`, since ARIA has no 2-D slider. `aria-valuenow` is y, and `aria-valuetext` names both: "45% from the left, 55% from the top".
  - A top cover keeps vertical-only reposition.
- **One focus point across placements:** the top band also uses a stored `cover-x` for `object-position`. Picking a new cover or removing it clears `cover-x` as well as `cover-y`.
- **Narrow fallback:** the page area is measured with a `ResizeObserver`.
  - A reading of 0 (a hidden page) changes nothing.
  - Where there is no `ResizeObserver`, the strip shows.
- **Strip edge keys:** the arrow keys move the edge the way they point: → widens a left strip and ← widens a right one. The step is 16 px (64 with Shift), as for the cover height.
- **Cards:**
  - A folder card takes its index note's placement; a folder without one is `top`.
  - TS `coverSide`/`coverX` are required on `GvCard`, so Global View card fixtures carry them.
- **Vault settings:** `vault_settings_get` and every reply built from it carry `coverSides` (`{ path: "left" | "right" }`) and `coverWidths`. A hand-written `"top"` entry is ignored.
- **i18n:** the strings live in the existing `cover.*` namespace (`cover.placement`, `cover.placeTop|Left|Right`, `cover.width`, `cover.positionBoth`, `cover.sideNotSaved`, `cover.widthNotSaved`).

## 14. Amendments from planning (Stream A — Global View)

### Card covers (§2) and side strips on cards (§3)

**Cause, confirmed:**
- A Chromium e2e with WebView2's user agent (vault files over `http://liber-asset.localhost`, served by the test) failed with the card image at 238 × 1190 inside its 96 px frame. WebKit passed.
- With the fix, the frame is a definite box and the image fills it absolutely, so `object-position` crops it.
- The editor's header band is Stream B's to audit.

**Side covers on cards:**
- The card's body becomes a two-column grid with the 96 px strip spanning its rows; `object-position` is `cover-x% cover-y%`.
- A side placement without an image keeps the top placeholder ("No cover").

### Pages and folders (§4)

- The icons live in the feature (`global-view/gvIcons.tsx`), so `app/icons.tsx` isn't touched by three streams at once.
- The folder tab is a sibling of the card, because the card clips its own box.
- The second sheet is drawn with box-shadows, kept under the open and connecting rings.
- The folder head's kind label is accent on accent-soft, a pairing already guaranteed ≥ 4.5:1 and now pinned in the Global View token test.

### Edges (§5)

**Lines:**
- **Links stay straight lines.** The table's "curve" described nothing that was there. The shape difference comes from parent/child lines becoming orthogonal elbows; straight links are also cheaper to draw and to label.
- **No arrowheads on links.** `GvEdge` carries no direction for links: Rust aggregates them as undirected pairs. Arrowheads stay on directed relationships. Giving links a direction would change Rust's edge aggregation (not Stream A's).
- **Elbows follow the layout:**
  - right–down–right where a tree grows sideways (Expand in place);
  - down–across–down where it grows down (the atoms map's sections);
  - a **trunk** down the parent's left side for blocks stacked and indented under it (`route: 'l'`).
  - Dragged cards get whichever elbow their places allow, and overlapping cards a straight line.

**Chips:**
- The text reads "N links" or "N relationships" (ICU plural). A relationship's label and its count are joined with " · ".
- Each chip is a `<rect>` pill under the existing SVG text. The NFR-03 probe still passes: WebKit, 200 cards and 3,400 aggregated edges, 144–242 ms.

**Focus mode:**
- Keyboard focus lights a card only when the keyboard moved there inside the canvas (arrow keys, Tab). A card focused for you, such as a level that just loaded, doesn't light: the view would arrive dimmed.
- The dimmed cards (55%) are a passing state the pointer or keyboard asked for. axe runs with the pointer off the cards.

**Legend:** the edge toggles already showed a sample per kind; they now draw each line as it looks, an elbow for parent/child.

### See atoms (§6)

**Entry points:**
- The Atoms button is on page cards only.
- **See atoms** in the card menu works for any card that stands for a page, folders included through their index note.
- View → See Atoms of This Page:
  - is `menu:screen` with the payload `"atoms"`;
  - is answered by `global-view/seeAtomsMenu.ts`, because the stores layer must not import the feature;
  - does nothing without an open Markdown page.

**Atoms:**
- A paragraph made only of embeds or images gives one image atom per embed (the tester's runs of `![[Pasted image …]]`).
- `::::columns` containers are flattened. HTML blocks get an atom. Frontmatter, rules and definitions are skipped. Audio also covers `ogg` and `flac`.
- Lists and tables are named by their first items or column names.

**Sizes:**
- an atom is 200 × 120, a section 220 × 64, and "+N more" 200 × 56;
- the page's own card and linked or related cards stay 240 × 300.

**Linked pages:**
- They come from the page level (`gv_children` of the page), so only pages that level holds appear (its 200-neighbour cap).
- A page that only links *to* this one isn't shown.
- Relationships come from `gv_edges`.

**Clicks:**
- A single click on a linked page's card shows *its* atoms (the map navigates). Edit or a double click opens it.
- The page's own card does nothing on a click (it is already here); its Edit opens it.

**Breadcrumb:**
- While atoms show, every level crumb is a way back.
- The page crumb opens the page's own level in Drill-down; in Expand it just goes back.
- Escape goes back with the keyboard on the page's card.

**Jump:**
- `pageStore.jump` is consumed once by the editor showing that path.
- The cursor goes to the block's start, scrolled to the middle.
- Offsets past a text that changed since are clamped.
- The flash is a line decoration (`cm-liber-flash`, accent-soft) that lasts 1 s.

**Rendering:**
- React Flow's visible-only rendering applies past 150 cards. Smaller maps render every card, which jsdom tests also rely on (it can't measure).
- Formulas and diagrams use the preview's `MathView` and `MermaidView`, scaled into the card.
- The atoms map reads the live text (unsaved edits included) and re-reads on saves and vault changes.

### Tests and data

- **`GvCard`:** `coverSide` and `coverX` are required in TypeScript, as specified. Card fixtures set `top` / `null`.
- **The e2e mock:**
  - takes a `coverSides` option;
  - reads `cover-y` and `cover-x` from frontmatter.
  - It still titles pages by their first `# ` anywhere (Stream B's §1 fixes the app, not the mock).
- **M3a's e2e:** the screen switch's "Edit" lookups are now exact, because page cards hold "Edit {title}" buttons.

## 15. Amendments from planning (Stream C: §7, §8, §9)

### Paths outside the vault (§9)

- **Absolute paths are always outside files**, even when they point inside the vault (`![](file:///…/Vault/Assets/x.png)`, which the "absolute" link format writes):
  - they are served through the allow-list;
  - they don't count as backlinks or Global View links;
  - renames don't rewrite them, which matches how Obsidian treats `file:` links.
  - Resolving them as vault files would have meant root-aware resolution and rename rewriting in a fourth syntax. Cost if wrong: an absolute link to a vault image doesn't show in its page's link counts.
- **What "hidden" means:**
  - any path component starting with `.`, lexically or after symlinks; requests spelled with `.`/`..` are refused too;
  - a vault kept under a hidden folder can't be linked by absolute path (relative and wiki links are unaffected).
- **The other OS's paths:** a Windows path is never read on macOS (and a POSIX path never on Windows). It shows "Not found: <path>", never a file relative to the working directory.
- **Only body links name outside files** (wiki, embed, Markdown, Markdown image): a `cover:` or `related:` can't.
- **Raw HTML can't reach outside files:**
  - the sanitizer marks Markdown links and images (`data-external`) before raw HTML is parsed;
  - the index doesn't see raw HTML's links, so they could never be shown.
- **The allow-list lookup:**
  - goes through `target_key`, now split on `\` too;
  - a wiki `file:` URL is keyed %-decoded;
  - index schema 2 (the same bump as Stream B's).
- **The reserved prefix is `/.external/<one %-encoded segment>`.**
  - A vault path with a hidden component is never served, so it can't collide with a vault file.
  - A raw `/` after the prefix is malformed (403).
- **UNC paths in Markdown destinations** lose a backslash to CommonMark's `\\` escape. UNC is recognised in wiki links and `file://server/share/…` URLs.
- **"Loading…" until saved.**
  - A link becomes showable only once a saved page holds it.
  - The preview asks again when the page's saved hash or the vault's files change, so an image typed into a note shows "Loading…" until the autosave, never a broken image.
- **Plain links:**
  - a link to an outside file opens after the same confirmation as vault files (with the full path shown);
  - "Show in Finder/Explorer" needs no confirmation;
  - programs and scripts are refused (`check_openable`).

### The Attach button (§7)

- **`file_pick(page)` takes the page.** The command can't run with empty arguments (the real-ACL test calls every command with `{}`).
- **It returns `path`, `name`, `url` and `inVault`.** The picks are granted to `attachment_import` like drops (two minutes, once).
- **Filters on macOS:** the dialog shows no filters there, because rfd 0.16 joins every filter into one list of allowed types, which would hide "All files".
- **What a link writes:** "Link to where it is" writes `![](url)` for media and PDFs and `[name](url)` for other files (as drop does with `![[…]]`/`[[…]]`).
- **The button's place:** after Link in the Format bar's inline group.

### Link format (§8)

- **"Full path in the vault" and "Relative to the note"** are kept only when they find the file again; otherwise the shortest name is used. A relative link gets `./` when an exact vault path would win.
- **"Absolute path on disk"** writes the shortest wiki link as a fallback in `link`, plus `url`. The UI writes `![](url)` (or `[name](url)`).
- **Obsidian's setting:**
  - the select offers "Use Obsidian's setting" while Obsidian has one;
  - the hint names it;
  - an example line shows what new links look like.
- **Captions:**
  - they show on embedded images, audio and file cards, and on Markdown images;
  - Copy path uses the code block's Copy feedback (label and live region);
  - Windows separators follow the Windows UA (WebView2).

## 16. Amendments from the final review (Stream C: §7, §8, §9)

The final review of the files-and-links work found one Critical, three Important and ten Minor issues. These decisions change §9 and §15 where they differ.

### Network files are never touched until the user loads them (C1, Critical)

- **The problem:** rendering a note that links `\\host\share\x.png` or `file://host/…` looked the path up on disk at once. On Windows that is an SMB connection to that host with the user's credentials (NTLM), with no click (the class of Outlook's CVE-2023-23397). §9's "cards check that the file exists each time they render" demanded it.
- **What changes in §9:**
  - **Network paths:** a UNC path or `file://host/` URL, and on macOS a `/net/host/…` path (the automounter), whose server isn't the vault's own, is a **network file**. `links_external` reports it `network: true`, `askFirst: true`, `exists: false` and makes no filesystem call at all: no existence check, no `canonicalize`, no serving, no opening.
  - **The card:** an embed shows "Network file: \\server\share\x.pdf", "Loading it connects to “server”." and a **Load from network** button.
  - **A link:** clicking one opens the usual open-file confirmation, with "Opening it connects to “server”." added. Confirming loads it, then opens it.
  - **Loading:** `external_network_allow(path)` (new command, real-ACL tested) accepts only a path a saved page links. It marks it loaded for the session (`VaultSession`, so a vault switch forgets it), then checks it as usual. Serving, opening and revealing refuse a network path until it is loaded.
  - **The vault's own server:** a share on the server the vault itself lives on (a vault on `\\nas\notes`) isn't "another computer", so links there work without asking.
- **Device namespaces:** `\\.\…` (pipes, devices), `\\?\…` other than `\\?\X:\…` and `\\?\UNC\…` (e.g. `\\?\GLOBALROOT`, volume GUIDs), and the reserved device names in any folder (`CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM1–9`, `LPT1–9`, with any extension) are never link targets. `\\?\X:\…` and `\\?\UNC\server\…` are read as their short forms.
- **No existence oracle:** `exists` is looked up only for a path a saved page links (and, on the network, only once loaded). An unlinked target reports `exists: false`.
- **Raw HTML (m2, re-graded as part of C1):** raw HTML can't carry its own `data-external`. The pipeline seals the values it sets with a per-render secret before raw HTML is parsed; after sanitizing, only sealed values are kept.
- **Tests:**
  - the session's own unit tests count filesystem look-ups and prove that none happen for network, device or unlisted targets;
  - the classification tests run on every host;
  - the preview's card and link flows, and an e2e for the card in Chromium and WebKit.

### A leading `/` with nothing there is the vault's own link (I1)

`[[/Projects/New idea]]`, `[x](/Notes/Missing.md)` and `![[/Assets/gone.png]]` with no vault file showed "Not found: /…" and lost Create page. On Windows this happened always, since a POSIX path never exists there.

A leading `/` (not a `file:` URL) now names the disk only when a saved page links a file that is there. Otherwise `links_external` answers `null`, and the preview, Live Preview and embeds take the vault's missing-link path (Create page, "Not found") as before §9. `file:` URLs, drive paths and UNC paths always name the disk.

### Only documents and media open from a note (I2)

`external_open` relied on M3's list of program types, which misses many Windows types that run code or leak credentials when opened. It now opens an outside file only when both the name asked for and the file it really is (symlinks, short names and trailing dots resolved) have one of these types (the last extension decides, case-insensitively):

| Kind | Types |
|---|---|
| Documents | pdf, txt, md, markdown, csv, tsv, json, rtf, odt, ods, odp, odg, doc, docx, xls, xlsx, ppt, pptx, pages, numbers, key, epub |
| Images | png, jpg, jpeg, gif, webp, avif, bmp, tif, tiff, heic, heif |
| Audio | mp3, m4a, wav, ogg, oga, flac, aac, aif, aiff, opus |
| Video | mp4, m4v, mov, webm, mkv, avi |

Everything else is only shown in Finder/Explorer, including web pages, SVG, macro-enabled Office files, disk images, help files and consoles.

- **Links report `openable`.**
- **The file card:** shows **Open** only for an openable file; otherwise it says "Not opened from notes: this kind of file can run programs." beside Show in Finder/Explorer.
- **A click on a link** to a file that isn't openable shows it in its folder with a toast saying so.
- **Checks kept:** M3's `check_openable` still runs (regular file, no program by name, no extensionless executable).
- **Vault files:** unchanged (`file_open_external`).

### The file dialog starts on All files (m7)

Windows and GTK select the first filter, so "All files" now comes first (then Images, Audio, Documents). macOS still gets no filters.

### Ruling: no index schema bump for §9 (I3)

The reviewer asked for schema 3 in case a schema-2 build had reached the tester. None has: the tester's Windows build and the maintainer's dev runs used schema 1, so the next build rebuilds every index once anyway. Schema 2 covers §1, §3 and §9 together. Cost if wrong: one stale index on a machine that ran an unreleased build, fixed by editing the affected notes or deleting the index cache.

### Deferred (Minor)

- **m1:** a file name containing a literal `%XX`, linked through a Markdown `file:` URL, is decoded twice and never loads.
- **m3:** "hidden" means a name starting with `.`. Windows' hidden attribute (`AppData`) and macOS's hidden flag (`~/Library`) aren't checked; the content security policy still keeps the bytes from the page.
- **m4:** outside files (and audio range requests) are read whole.
- **m5:** a gap between checking a file and reading it (a local attacker swapping in a FIFO).
- **m6:** the Attach popup:
  - doesn't close on an outside click and has no focus trap;
  - the import grant expires after two minutes;
  - mixed in-vault and outside picks are two undo steps.
- **m8:** a `\\?\D:\` long-path vault root makes a `file://?/…` URL.
- **m9:** the comment on `URL_PATH` says other UTF-8 stays as written; it is percent-encoded.
- **m10:** the tooltip reads "Attach a file or image…", not the spec's "Insert a file or image…".
