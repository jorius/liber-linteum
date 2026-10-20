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

   The "…" button goes, and right-click keeps the context menu. *My call:* "+" (new page in this folder) also goes from the row because Jose listed only three. It stays in the context menu. Archived rows show no trash, as today.
4. **Context menu label.** "New quick note" becomes "Create new scratchpad in this vault" (es: same meaning, using the existing Spanish terms for scratchpad and vault). The behaviour and the ⌘⇧N shortcut are unchanged.

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

## 4. Testing

- Each item gets a test that fails first: vitest for the logic and components, Playwright e2e for the sidebar drag, the Move dialog keyboard, and Live Preview reveal/hide.
- The full gate (`check.sh all`) must pass on each stream and again after integration.

## 5. Jose's decisions (2026-10-20)

- **Welcome page overhaul.** Three mocks are in the brainstorm companion: A launcher, B start page with vault cards, C vault switcher. We build once he picks.
- **Notion page icons.** The "Markdown & CSV" export carries no page icons. I checked his zip: every page starts with `# Title`, and "📚 Resources" only has an icon because the emoji is part of its title. Notion's HTML export has a `page-header-icon` and a cover image for each page. **Decision:** the importer will accept HTML exports, *after* the round 3 feedback items are done (round 3b).
- **Folder pages.** **Decision: merge.** A folder and its same-name page become one row (§6).

## 6. Folder pages (stream D, after A–C land)

A Notion page with sub-pages becomes a page plus a folder of the same name, so the sidebar listed "Bug Bounty" twice. From now on, a folder can *be* a page, as in Notion.

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
