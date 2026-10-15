# M4b, part 3 — Second feedback round (Windows test, Obsidian vault): Design

**Status:** agreed with Jose on 2026-10-15.
- **Where the feedback came from:** Jose's Mac check and a friend's test on Windows with a real Obsidian vault ("Mind_PC").
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

**The problem.** PG-01 took the first H1 *anywhere* in a note as its title. In the friend's note "Tipos de comisiones":
- The first H1 is a section heading halfway down: `# WIP (Work In Progress):`.
- The card, the lists and the "Title in the note" label therefore showed "WIP (Work In Progress):".
- Obsidian shows the file name.

**The rule, from Jose:**
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
  - the friend's shape: paragraphs, a link, then `# WIP (Work In Progress):` (gives "Tipos de comisiones");
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
- Stored in `.nimw/vault.json`:
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
| Absolute path on disk | `![](file:///D:/Mind_PC/Assets/x.png)` |

- **Storage:** `.nimw/vault.json` `attachmentLinkFormat: "shortest" | "vault" | "relative" | "absolute"`.
- **When it's unset:**
  - Obsidian's `newLinkFormat` in `.obsidian/app.json` decides: `shortest` → shortest, `absolute` → full path in the vault, `relative` → relative.
  - Otherwise, shortest.
  - The settings row says "Following Obsidian's setting" when that applies. Choosing an option sets NIMW's own value; Obsidian's file is never written.
- **What it applies to:** everything the app inserts as an attachment: paste, drop, and Attach → Copy. The `cover:` frontmatter keeps its own relative form.

**Settings → Editor → Show where attachments are on disk** (app setting `showAttachmentPaths`, default off):
- **What it adds:** a caption under each embedded image, audio player and file card, in the preview pane and in Live Preview widgets.
- **What the caption shows:**
  - the file's absolute location with the OS's separators (`D:\Mind_PC\Assets\x.png` on Windows, `/Users/…` on macOS);
  - the text is selectable;
  - a **Copy** button announces "Copied".
- **Which files:** vault files and external files (§9) alike.
- **Data needed:** the vault's absolute root, from Rust (added to the vault info if it isn't there yet).

## 9. Absolute and relative paths in links and embeds

**Targets recognised** in `![[…]]`, `[[…]]`, `![](…)` and `[](…)`:
- Windows absolute paths: `D:\Docs\my-file.pdf`, `D:/Docs/x.pdf` and UNC `\\server\share\x.pdf`.
- `file:` URLs: `file:///D:/Docs/x.pdf` and `file:///Users/jose/x.png`, percent-decoded.
- A leading `/`:
  - Obsidian treats it as vault-root-relative, so that is tried first;
  - if no vault file matches and an absolute file exists on disk at that path, the disk file is used.
- Relative paths `./x.png` and `../Assets/x.png`, resolved against the note's folder:
  - inside the vault, a normal vault file;
  - above the vault root, an external file on disk.
- **URL schemes:** a single drive letter is not a scheme. `has_scheme` (in `nimw-markdown` and `nimw-session`) needs at least two characters, so `D:\…` is a path and `mailto:`/`https:` are still URLs.

**Resolution:**
- It runs in Rust (indexer and `links_resolve`). Each link resolves to one of: a vault file (as today), an **external file** (an absolute path that exists), or missing.
- The index records external targets separately from vault targets. Backlinks, the Global View and the page graph ignore them; they aren't pages.

**Rendering:**
- **How external media is served:** through `nimw-asset:` under a reserved prefix that `VaultPath` validation can never produce, so it can't collide with a vault path.
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
  - the Windows installer for the friend and the Mac app for Jose.
