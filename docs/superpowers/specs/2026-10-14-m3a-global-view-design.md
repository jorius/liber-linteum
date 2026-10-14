# M3a — Global View (browse, layout, edges): Design

**Status:** written on 2026-10-14 without Jose's review. He asked to "carry on with everything that's missing" and review features in bulk later.
- **Grounding:** product spec §6 (all GV items DECIDED), architecture §3.1 and §4.4, and the clickable prototype (`design/prototype/Main.dc.html`, screen `global`). All three are binding.
- **Judgement calls** where none of them settles a question are listed in §12, for review.

**Split:** M3 is split in two.
- **M3a (this document):** the Global View screen, cards, levels, Drill-down / Expand, edges (text links, parent/child, manual read-only, aggregated), layout with persisted positions, pan and zoom, New entry, and keyboard use.
- **M3b:** creating, labelling, directing and deleting manual relationships (GV-22–24) and picking a folder's index note (GV-02's "page the user picked").

---

## 1. Goal and success criteria

See the vault as a map of cards and move through it level by level, without opening files.

All acceptance criteria of product spec §6 pass, except the manual-relationship creation flows (M3b):
1. **Projects at level 0:** a vault with projects A, B and C shows three project cards at level 0.
2. **Drill-down:** a single click on A shows only A's children, and the breadcrumb reads "Vault › A".
3. **Expand:** a single click on A puts A's children beside A, while B and C stay visible.
4. **Persistence:** a card moved by hand stays where it was put after a restart.
5. **Aggregation:** a page in A linking to a page in B gives one A–B edge with count 1 at level 0, when "Links from inside folders" is on.
6. **Index note:** folder `DMC` containing `DMC.md` previews `DMC.md` on its card.

**Non-negotiables:**
- no network;
- every command async via `blocking()`, with a real-ACL test;
- i18n en + es; axe-clean; WCAG AA in light and dark across all palettes; full keyboard operation (NFR-10);
- Safari 15 floor;
- performance: a level of ≤ 200 cards renders in < 300 ms at 10k notes (NFR-03);
- only open levels are mounted (NFR-02);
- opening a vault writes nothing: `.nimw/layout.json` is created on the first card move.

## 2. Screen and switching (`stores/uiStore.ts`, `TopBar.tsx`, `AppShell.tsx`)

- **Screen state:** `uiStore.screen: 'edit' | 'global'`, `'edit'` on vault open. The top bar's Edit · Global view group becomes a real segmented control (`aria-pressed`), and the "arrives in M3" hint is removed.
- **Shortcuts:** ⌘1 shows Edit and ⌘2 shows the Global View (Ctrl on other platforms). The page handles them, as with ⌘[ / ⌘]. View → Editor and View → Global View menu items emit `menu:screen` with no accelerator (the M2b §11.3 rule).
- **Switching:**
  - Edit → Global returns to the last level shown in this session (level 0 the first time).
  - Global → Edit shows the current page, with the editor state kept: the editor stays mounted but hidden, so text, selection and undo survive.
  - Opening a page from the Global View switches to Edit.
- **Layout:** the explorer sidebar stays visible in both screens. The Global View replaces the page area (`main`).

## 3. Levels (`gv_children`, `features/global-view/levels.ts`)

A **level** is what one click opens.

| Level | Cards |
|---|---|
| **Vault (level 0, GV-10)** | top-level folders (kind `project`), then pages in the vault root |
| **Folder or project** | its direct subfolders (`folder`), then its pages (`page`) |
| **Page (GV-16)** | the page itself (centred), plus its neighbourhood: pages it links to, pages linking to it (backlinks) and pages related to it through `related:` in either direction |

- **Order:** within a group, cards are sorted by `name_key`, so the ordering is accent- and case-insensitive, like the explorer.
- **Never cards:**
  - non-page files;
  - attachment folders (VLT-05; see §3.1);
  - excluded or hidden paths, which never reach the index.
- **Neighbourhood links** count only when resolved to a page. They cover wiki and Markdown links and `related` entries. Embeds of pages count as links; cover links do not.
- **Duplicates** collapse to one card: a page that both links to and is linked by the centre page appears once.

### 3.1 Attachment folders

A folder is an attachment folder when the current `AttachmentPolicy` (M2c §5.3) names it:
- `Subfolder(name)`: every folder with that name (case-insensitive) is one;
- `Folder(path)`: only that folder is one;
- `VaultRoot` and `SameAsNote` name no folder.

Attachment folders still show in the explorer.

### 3.2 Index note (GV-02)

A folder's index note is the first match of:
1. `<folder>/<folder name>.md` (case-insensitive name match);
2. `<folder>/index.md`;
3. `vault.json.indexPicks[folder]` (read only in M3a; picked in M3b);
4. the folder's only page, when the folder contains exactly one page and no subfolders.

Without an index note, the card is a **folder summary** (§4).

## 4. Cards (`features/global-view/Card.tsx`)

Values come from the prototype (`.card`, lines 64-79 and 291-312), expressed as theme tokens. New tokens are added where the prototype colour has none (`--color-card-border`, `--color-canvas`), for all palettes and both modes, with contrast checked by the M2b palette tests.

- **Size and frame:** 240 × 300 px, `--radius-md` corners, `--shadow-card`, 1 px border.
  - The card that opened the current level, or an expanded card, gets a 2 px accent ring.
- **Header row:**
  - **Kind label:** 10.5 px uppercase, letter-spacing .07em, muted. It reads "PROJECT", "FOLDER" or "PAGE"; a folder previewing an index note reads "FOLDER · <folder name>" (GV-03).
  - **Move handle:** a 36 × 36 grip, the React Flow drag handle.
  - **Connect handle:** a 36 × 36 button, inert in M3a; it is hidden until M3b.
- **Cover area (96 px):**
  - **With a cover:** the image (`object-fit: cover`, `object-position: 50% <cover-y>%`), alt "".
  - **Remote cover:** a placeholder reading "Remote cover not loaded".
  - **Page without a cover:** "No cover" on `--color-surface-subtle` with a dashed bottom border.
  - **Folder summary:** a folder icon and "N pages · M folders" on `--color-code-bg`, in accent text.
  - For a folder with an index note, the cover is the index note's.
- **Text:**
  - **Title:** Display font, 19 px, 700, accent, at most 2 lines.
  - **Subtitle:** 12 px, muted, 1 line. For a folder summary it is the folder's name.
  - **Excerpt:** 12 px / 1.45, clamped to 3 lines; the index excerpt (≤ 200 chars). For a folder summary it is the first child titles joined with " · ".
- **Footer:** image and audio icons when `has_image` / `has_audio` are set (each with an accessible label), and a **See all** pill button.
  - See all opens the page, or the folder's index note, in the editor.
  - A folder without an index note drills into it instead.
- **Accessibility:**
  - Each card is a `group` named after its title and kind ("Generator Rex, page").
  - Its focusable surface is one button-like element (`role="button"`, `aria-describedby` → subtitle + excerpt).
  - Visible focus: a 2 px accent outline, offset −2 px.

## 5. Navigation (`features/global-view/GlobalView.tsx`, `gvStore.ts`)

- **Clicks:**
  - **Single click** (GV-11) opens the next level for that card.
  - **Double click** (GV-12) opens the page, or the folder's index note, in the editor; a folder without one drills in.
  - A single click waits 240 ms, as in the prototype, so a double click never also drills.
- **Keyboard (GV-18):**
  - the arrow keys move focus to the nearest card in that direction, by card centre and angle (roving tabindex; React Flow's own keyboard node-moving is disabled);
  - Enter = single click, Shift+Enter = double click;
  - Escape goes back one breadcrumb level in Drill-down, or collapses the focused expanded card in Expand.
- **Mode (GV-13):**
  - a segmented control, Drill-down | Expand in place;
  - one global setting, `globalViewMode: 'drill' | 'expand'` in `settings.json`, default `drill`.
- **Drill-down (GV-14):**
  - the canvas shows one level;
  - the **breadcrumb** is the stack of opened levels ("Vault › Character Design › Generator Rex"), and each crumb goes back to its level;
  - page levels show the page title as their crumb.
- **Expand in place (GV-15):**
  - a single click adds the card's next level beside it, in the column to its right;
  - a second single click on an expanded card collapses it, along with everything expanded from it;
  - cards already on the canvas aren't duplicated: edges point to the existing card;
  - the breadcrumb shows only the root level of the expand canvas;
  - switching mode keeps the current root level.
- **New entry (GV-17):**
  - a floating "New entry" button, bottom right, as in the prototype;
  - it creates `Untitled` (or `Untitled 1`, …) in the folder of the current level, with `vaultStore.createPage`:
    - vault root at level 0;
    - the folder itself at a folder level;
    - the page's folder at a page level;
    - in Expand, the focused card's folder, else the root level's;
  - it then switches to Edit with the title field focused and selected, ready to rename (M2b title editing).
- **Empty level:** shows "Empty folder." plus New entry.

## 6. Edges (`gv_edges`, `features/global-view/edges.tsx`)

- **Kinds** (prototype colours become tokens):

| Kind | Style |
|---|---|
| Text link | solid, `--color-edge-link` |
| Parent / child | dashed, `--color-edge-tree` |
| Manual | solid, `--color-edge-manual` |
| Aggregated link | dotted, link colour |
| Aggregated manual | dashed, manual colour |

- **Manual edges:**
  - an arrow appears only when `directed`;
  - the label is drawn at the edge midpoint (≤ 24 chars shown, full text in a `title`).
- **Aggregated edges:** a count badge when the count is greater than 1.
- **Parent/child edges** join an expanded card to the children it opened (Expand mode). In Drill-down they connect a page level's centre card to nothing (the parent is in the breadcrumb).
- **Text-link and manual edges** come from `gv_edges(visible)`, computed in Rust over all resolved `wiki`, `markdown`, `embed` (page targets) and `related` links:
  - both ends of every link are mapped to the **nearest visible ancestor-or-self** (GV-25);
  - a pair whose ends map to two different visible cards becomes one edge per (pair, kind), with a count;
  - an edge is **aggregated** when either end was mapped to an ancestor folder card rather than itself;
  - direction counts for manual `directed` only; links are undirected for drawing.
- **Toggles (GV-21):** four chips, "Text links", "Parent / child", "Manual" and "Links from inside folders", each with a style swatch.
  - They are `aria-pressed` buttons, default on, persisted as `globalViewEdges` in `settings.json`.
  - "Links from inside folders" hides aggregated edges of both kinds.
- **Edge accessibility:** edges are decorative for screen readers. Each card's description lists its connections ("Links to 3 cards, linked from 1"), so the information isn't visual-only.

## 7. Layout (`features/global-view/layout.ts`, `layout_get` / `layout_set`)

- **Deterministic layouts,** matching the prototype:
  - **Grid** (vault and folder levels, Drill-down): cells of 300 × 370 from (48, 48), with as many columns as fit the canvas width (at least 1).
  - **Columns** (Expand): each expansion fills the column to the right of its parent card (x = 48 + depth × 310), with rows allocated in depth-first order (y = 48 + row × 340) and the parent kept level with its first child.
  - **Neighbourhood** (page level, Drill-down): backlinks on the left, the page in the centre and outgoing links on the right, each column vertically centred on the page. Related pages go left or right by direction (undirected ones go right), and a page that is both linked and linking goes right.
- **Pinned positions (GV-31):**
  - dragging a card by its move handle pins it;
  - pinned positions are saved per **level key** in `.nimw/layout.json` (arch §3.1), with an atomic write that preserves unknown keys, debounced 300 ms after a drag ends;
  - level keys: `""` (vault), `<folderPath>`, `page:<path>`, and `expand:<rootKey>` for Expand canvases;
  - unpinned cards follow the deterministic layout.
- **Reset layout (GV-32)** removes the current level key's entries.
- **Renames:** moves and renames remap the layout keys and entries by path prefix, in Rust, at the session's single rename choke point and in the watcher's rename handling. Deleted paths drop out lazily: entries for paths not on the canvas are ignored, then pruned on the next save of that level.
- **Pan and zoom (GV-33):**
  - React Flow handles wheel and pinch zoom (0.25–2×) and dragging the background to pan;
  - zoom-in, zoom-out and fit buttons have accessible names;
  - each level change fits the view, unless the level has pinned positions, in which case it restores them and fits.
- **Canvas background:** `--color-canvas` with the `--color-bg-dots` 18 px dot grid already used by Welcome.

## 8. Backend (`apps/desktop/src-tauri/src/gv_commands.rs`, `crates/nimw-session/src/global_view.rs`)

**Rules for all commands:** async via `blocking()`; registered in `build.rs`, `generate_handler!`, capabilities and the test COMMANDS list; each with a real-ACL test.

- **`gv_children(level: { kind: "vault" } | { kind: "folder", path } | { kind: "page", path }) -> GvLevel { cards: Vec<GvCard>, centre: Option<String>, omitted: u32 }`**
  - A page level shows at most 200 neighbours around the centre (always shown): pages it links to and related pages first, then backlinks, the most recently modified first within each; `omitted` counts the rest (0 for vault and folder levels). This keeps a hub page's level under the `gv_edges` limit (final review m14).
  - `GvCard`:
    - `{ path, kind: "project"|"folder"|"page", title, subtitle, cover: Option<String>, coverRemote: bool, coverY: Option<u8>, excerpt, hasImage, hasAudio }`;
    - for folders also `indexPage: Option<String>`, `pages: u32`, `folders: u32`, `childTitles: Vec<String>` (≤ 5);
    - page levels also `relation: "centre"|"in"|"out"|"both"` per card.
  - `cover` is the resolved vault path (path-style resolution, as the page header does), or `None` when missing or remote.
  - One SQL pass per level: children by `parent`, a left join on `pages`, counts via `GROUP BY parent`.
- **`gv_edges(visible: Vec<String>) -> Vec<GvEdge { from, to, kind: "link"|"manual", count, aggregated, directed, label: Option<String> }>`**
  - `visible` is at most 1,000 paths.
  - It scans the resolved links once (an indexed query on `target_path IS NOT NULL`), maps ends with a prefix lookup over the visible folders (sorted, binary search), and aggregates in a `HashMap`.
  - A manual edge's label is the first label found for that pair; `directed` is true when any entry for that pair is directed in that orientation.
- **`layout_get(level: String) -> HashMap<String, {x, y}>` and `layout_set(level, positions)`**
  - `.nimw/layout.json` holds `{ "version": 1, "levels": { … } }`. It is created lazily and written atomically.
  - An empty map removes the level.
  - It is read per level and per entry: a malformed entry, or one a later version adds, is skipped on its own, and a save keeps the saved level's entries it can't read as positions (final review m8).
  - Updates are serialized in the process (`layout_set` threads and the watcher), a compare-and-swap lost to another program is retried once, and an update that changes nothing is not written (final review I3, m11).
  - Pruning (final review m10): a level save drops that level's positions for paths that no longer exist and doesn't store a level whose own folder or page is gone; a level save, or a remap that moved something, drops the levels of deleted folders and pages (one `lstat` per level key). Reads and no-op remaps never write just to prune.
- **`VaultSession::rename`** and the watcher's rename path call `layout_remap(from, to)` (prefix remap for keys and entries). They do nothing when no `layout.json` exists. The watcher remaps a whole batch at once (`remap_layout_many`: one read, at most one write), before announcing the change. Keys and entries already at a rename's destination are leftovers of a deleted path and are replaced by the moved ones (final review I3, m10).
- **`.nimw/vault.json`** is read field by field: a malformed `indexPicks`, `attachments` or `exclude` item is reported and ignored on its own, and never disables `exclude` (final review m9).
- **Settings:** `globalViewMode` (`"drill"` default) and `globalViewEdges` (`{ links, tree, manual, aggregated }`, all `true`), each lenient per field (M1/M2b pattern).
- **The DTO for `PageDto`** is unchanged. Cards come only from `gv_children`.

## 9. Frontend structure (`apps/desktop/src/features/global-view/`)

- **`GlobalView.tsx`:** the screen; the toolbar (breadcrumb, mode, toggles, Reset layout) plus the canvas.
- **`gvStore.ts`** (zustand) holds:
  - the mode;
  - the drill stack, or the expand tree;
  - loaded levels (`Map<levelKey, GvLevel>`);
  - edges;
  - pinned positions;
  - focus.
- **`Canvas.tsx`:** `@xyflow/react` `ReactFlow` with:
  - `nodeTypes = { card }` and `edgeTypes = { link, tree, manual }`;
  - `nodesDraggable` with `dragHandle=".gv-grip"`;
  - `nodesConnectable={false}` (M3b turns it on);
  - `disableKeyboardA11y`, because §5 handles the keyboard;
  - `proOptions.hideAttribution`. The MIT licence allows this; the attribution is credited in About and README instead.
- **`layout.ts`:** pure functions for the three layouts plus pinned overrides. They are unit-tested.
- **`Card.tsx`, `edges.tsx`, `Breadcrumb.tsx`, `EdgeToggles.tsx`.**
- **Refresh:**
  - the visible levels and edges are re-fetched, debounced 150 ms, when `vaultStore` nodes change (`refreshTree`), when a page save lands (`editorStore` hash) and on settings changes to the attachment policy;
  - cards removed from the vault disappear;
  - a level whose folder was deleted falls back to its nearest existing ancestor, or to the vault.
- **Dependency:** `@xyflow/react` (MIT), the newest version the pnpm 12 release-age gate allows, pinned exactly; its CSS is imported locally. No other new dependency: §7 replaces the architecture's elkjs (§12.1).

## 10. Testing

- **Rust:**
  - `gv_children` for all three levels, including ordering, attachment folders, the index-note rules 1–4, counts and covers (resolved, remote, missing);
  - `gv_edges`: aggregation (the product acceptance A–B count case), aggregated flags, manual label and direction, the visible-set cap;
  - `layout_get` / `set`: lazy creation, unknown-key preservation, remap on rename (in-app and watcher);
  - settings fields: defaults and lenient parsing.
  - A perf test: 10k pages with a 200-child folder, `gv_children` + `gv_edges` < 100 ms in release mode (ignored in debug, like M1's perf test).
- **ACL:** every new command allowed from main, denied elsewhere.
- **TS:**
  - `layout.ts` (grid, columns, neighbourhood, pinned override);
  - `gvStore` (drill stack, expand and collapse, no duplicates, mode switch, refresh fallback);
  - keyboard navigation geometry;
  - Card (kinds, placeholders, a11y, axe in light and dark);
  - toolbar (toggles persisted, axe);
  - TopBar switching; the editor kept mounted (undo survives Edit → Global → Edit).
- **E2E (Chromium + WebKit):**
  - level 0 → drill → breadcrumb back;
  - expand and collapse;
  - double click opens the editor;
  - drag a card, reload, and the position is kept;
  - edge toggles;
  - keyboard only: arrows, Enter, Shift+Enter;
  - zero-network with the Global View open.
- **Real window:** trackpad pan and pinch; dragging; a large vault feel; the WKWebView rendering of React Flow.

## 11. Out of scope (M3b and later)

- creating, labelling and deleting relationships;
- picking a folder's index note;
- a minimap;
- search inside the Global View (M5);
- card context menus;
- dragging cards into folders (moving files);
- multi-select.

## 12. Decisions taken for Jose (to review in bulk)

1. **No elkjs:** deterministic grid, column and neighbourhood layouts matching the prototype replace the architecture's elkjs worker. They avoid a large GWT-compiled dependency under `freezePrototype` and the CSP, and they give predictable, testable layouts. A layered auto-layout could still be added later behind the same `layout.ts` interface.
2. **Edit and Global View share one window:** the editor stays mounted while the Global View shows, so switching never loses undo or selection. Shortcuts are ⌘1 and ⌘2, plus View-menu items.
3. **The breadcrumb is the stack of opened levels** (click history), not the folder path. Page levels need this, because a neighbourhood isn't a folder.
4. **Edge toggles and the view mode are global settings** (`settings.json`). GV-13 asks for that for the mode, and the toggles follow suit.
5. **"See all"** = double click: it opens in the editor, and a folder without an index note drills in. That's the prototype's behaviour, except that the prototype's "no index note" toast became a drill-in.
6. **New entry** creates "Untitled" and jumps to the editor with the title selected for renaming.
7. **A page level includes the page itself** as the centre card, with neighbours placed left (in) and right (out).
8. **The connect handle is hidden** until M3b, rather than shown disabled.
9. **The single-click delay is 240 ms,** taken from the prototype, so a double click never triggers drill-down first.

## 13. Amendments from planning (plan `docs/superpowers/plans/2026-10-14-m3a-global-view.md`, replayed end-to-end)

These override the sections above where they conflict.

1. **Dependency:** `@xyflow/react` **12.12.0** (released 2026-09-24, the newest the pnpm release-age gate accepts), pinned exactly. It brings `@xyflow/system` 0.0.83 and its own `zustand` 4.5.7.
2. **Frozen prototypes:** Tauri's `freezePrototype` stops d3-color (React Flow → d3-zoom) from loading: its `define()` assigns `prototype.constructor` on a plain object. `apps/desktop/scripts/freezeSafe.ts`, a Vite transform matched by file path and exact text, rewrites that one assignment to `Object.defineProperty`, and `tests/freezeSafe.test.ts` proves both the failure and the fix. Without it the whole UI fails to start; the e2e mock freezes the prototype like Tauri does.
3. **Edges** (§6, §8) are computed from the links that **start** inside a shown card, with one indexed range query per visible card (`Index::page_links_from`). A link starting elsewhere can't become an edge. Release timings on 10k notes: a 200-card level plus its edges ~2 ms (a full scan took 83 ms); level 0, which reads every link, ~90 ms.
4. **`related:`:** only the list form (`related:\n  - "[[X]]"`) is indexed, as before M3a; a scalar `related: "[[X]]"` is not. Tests use the list form; parity with the TS reader is left for later.
5. **External folder moves** (another program) arrive from the watcher as per-file renames, so pinned card entries follow but a moved folder's own level key does not. In-app renames remap keys and entries.
6. **Screen switching** (§2):
   - opening a page from anywhere, the explorer included, shows Edit;
   - tooltips show no ⌘ symbols (there is no precedent, and ⌘ is wrong off macOS); the buttons carry `aria-keyshortcuts="Meta+1 Control+1"` / `"Meta+2 Control+2"`;
   - ⌘1 / ⌘2 also accept the physical digit where digits need ⇧ (French);
   - `shell.globalLater` is removed.
7. **Cards** (§4):
   - the folder-summary cover uses `--color-accent-soft` behind accent text, where accent-on-soft ≥ 4.5 is already guaranteed, instead of `--color-code-bg`;
   - cards have a fixed 240 × 300 size passed to React Flow, so a change of card data (e.g. focus) never re-measures and hides them;
   - the group name is "<title>, <kind>" with the kind translated.
8. **Edge colours and strokes** (§6):
   - `--color-canvas`, `--color-card-border`, `--color-edge-link` (accent) and `--color-edge-tree` (muted) are derived per palette, custom accents included;
   - `--color-edge-manual` is fixed per mode (`#b4501a` light, `#e8935a` dark);
   - the kinds also differ by width or dash: link 2 px solid, aggregated link 2.5 px dotted, parent/child 1.5 px dashed, manual 3 px solid, aggregated manual 3 px long-dashed;
   - every edge is ≥ 3:1 on the canvas in every palette and mode (tested).
9. **Card descriptions:** the connections text reads "Linked with N cards. M relationships." Link edges are undirected card pairs, so "links to / linked from" can't be told apart.
10. **Zoom buttons** are the app's own (translated labels), not React Flow's `Controls`. The React Flow attribution badge is hidden (`proOptions.hideAttribution`, MIT); credit belongs in About and README.
11. **Breadcrumb in Expand** is the drill stack, whose last entry is the expand canvas's root level.
12. **Loading:** an edge or layout read that fails, or answers nothing, means no edges or pins; the cards still show. The store records the key of the level the canvas holds (`shownKey`); the canvas fits the view and moves the keyboard to the new level's first card once per loaded level. (Found in e2e: the breadcrumb changes before the level arrives, and a fit per node update moved cards between the two presses of a double click.)
13. **New entry** creates the page with `entry_create_page` directly: `vaultStore.createPage` would start the explorer's inline rename and take the focus. The page opens with a one-shot `pageStore.requestTitleFocus(path)`, which `PageTitle` consumes by focusing and selecting the name.
14. **jsdom:** React Flow tests use `src/test/reactFlow.ts` (`ResizeObserver` entries with `contentRect`, `DOMMatrixReadOnly`, sized nodes). axe runs without colour contrast there (jsdom has no CSS), and contrast is covered by `palettes.test.ts`.
15. **E2E:**
    - the IPC mock answers `gv_children` / `gv_edges` from its pages and keeps layouts in `localStorage`, so a reload keeps them;
    - WebKit moves a dragged card less than the pointer, so the drag test asserts that the card moved and that the position persists, not the distance;
    - the keyboard test waits on focus, not on time.
16. **Safari 15 scan of the built bundle:** React Flow adds one `structuredClone`, in its click-to-connect path, which M3a disables (`connectOnClick={false}`, no connectable handles); M3b must guard it before turning connections on. The bundle's three regex lookbehinds (markdown, built inside `try`) and six `color-mix()` uses (sidebar and backdrop hovers) predate M3a.
17. **Edges are one SVG layer, and aggregated edges are capped** (final review I2; overrides §6's and §9's React Flow `edgeTypes`):
    - **Why:** level 0 of the 10k reference vault (`VaultShape::TEN_K`) has 94 project cards and ~2,200 aggregated pairs, nearly all with a count. As React Flow edges (an `<svg>`, store subscriptions and an HTML count label per edge) they took 1.5–2.5 s to show in WebKit, against NFR-03's 300 ms. Most of what was left after removing the HTML labels was WebKit stroking dotted lines: thousands of sub-pixel dashes per line at fit zoom.
    - **Drawing:** `edges.tsx` `EdgeLayer` draws every edge in one `aria-hidden` `<svg>` in React Flow's viewport (a `ViewportPortal`, `z-index: -1`, so under the cards). One `<g>` per style carries colour, width and dash; each edge is a `<path data-gv-edge>`, directed manual edges add a `data-gv-arrow` path. Counts and manual labels are SVG `<text data-gv-count>` with a surface-coloured halo (`paint-order: stroke`), on top of all lines; a manual label keeps its full text in a `<title>`. Positions come from React Flow's store (`s.nodes`), so edges appear with their cards and follow a drag, and a card that stays put keeps its position object, so only a moved card's edges redraw. React Flow gets no `edges` prop, and cards no hidden handles (M3b adds its connect handles).
    - **Dash patterns** grow when zoomed out (`dashScale`: ×√2 steps, never below the §13.8 patterns at zoom ≥ 1), keeping a dotted line's on-screen rhythm.
    - **Cap:** at most `MAX_AGGREGATED` = 500 aggregated edges per canvas, the highest counts first (ties keep `gv_edges` order). Direct links and parent/child edges are never capped. When edges are left out, the canvas says so: "Showing the 500 strongest of 2,632 links from inside folders." (top left, `gv.edgesCapped`). At 1,000 the 200-card case still fitted on the reference Mac (240 ms in WebKit) but left little room for a slower 2022 laptop.
    - **Measured** (built UI, IPC mock answering `gv_edges` directly, click on "Global view" until cards and edges are in the DOM plus one frame; Apple-silicon Mac; first / later opens):

      | Canvas | Before (Chromium · WebKit) | After (Chromium · WebKit) |
      |---|---|---|
      | 94 cards, 2,632 aggregated edges | 473 / 400 · 1,484 / 1,200 ms | 105 / 77 · 155 / 83 ms |
      | 200 cards, 3,400 aggregated edges | 584 / 560 · 2,622 / 2,200 ms | 133 / 100 · 188 / 125 ms |
      | the same, toggling "Links from inside folders" | 55–210 · 290–860 ms | 40–50 · 30–75 ms |
      | 200 cards, no edges (floor) | 169 / 72 · 210 / 145 ms | 138 / 102 · 159 / 92 ms |

    - **Pinned by:** `GlobalView.edges.test.tsx` (counts are SVG text, 3,160 edges make one layer and no React Flow edge, the cap and its note), `edges.test.ts` (`strongest`, `dashScale`), and the opt-in timing probe `e2e/m3a-perf.spec.ts` (`NIMW_PERF=1`, both engines, asserts < 300 ms; not in CI, where runner speed varies).
18. **Final-review fixes (build, rendering, accessibility):**
    - **Dev pre-bundle** (C1): `pnpm dev` / `tauri dev` serve React Flow from Vite's dependency pre-bundle, which Rolldown builds without the app's plugin `transform` hooks; Tauri freezes the prototype in dev too, so the window stayed blank. `vite.config.ts` also runs `freezeSafe()` in `optimizeDeps.rolldownOptions.plugins`; `tests/devPrebundle.test.ts` runs the real optimizer with the app's config and checks the bundle.
    - **Card button** (m5): a text-free layer (`.press`) over the card body is the `role="button"` element, so its name (the title) matches what it shows; the cover, title, subtitle and excerpt sit beside it, and the subtitle, excerpt and connections stay its description. axe's label-content-name-mismatch only runs in a real engine: `e2e/m3a-a11y.spec.ts` runs axe on the Global View in Chromium and WebKit, light and dark.
    - **Focus ring** (m3): on `.press:focus`, removed by `.press:focus:not(:focus-visible)`, so WebKit < 15.4 still shows it. `cssCompat.test.ts` rejects `outline: none` outside `:not(:focus-visible)`.
    - **React Flow's own strings** (m5): `ariaLabelConfig` gives its hidden descriptions in the language shown (the node text is the canvas's keyboard help); its `role="application"` wrapper is named "Global View cards" and described by that help (React Flow `id="gv-flow"`); the English `aria-roledescription="node"` on node wrappers is removed (`domAttributes`).
    - **Manual labels** (m4): a label with a `<title>` takes the pointer (`pointer-events: all`, `nopan`), so its tooltip shows and pressing on it doesn't pan.
    - **Credit** (m6, §9 / §13.10): README "Third-party software", `THIRD-PARTY-NOTICES.md` (licence text, checked against the installed package), and a line on the welcome screen next to the version. The native macOS About panel (`AboutMetadata.credits` in `menu.rs`) does not credit it yet.
    - **Move handle** (m15): 36 × 36, as §4 says.
