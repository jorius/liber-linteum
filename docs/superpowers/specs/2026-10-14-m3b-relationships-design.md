# M3b — Global View: relationships and index notes: Design

**Status:** written on 2026-10-14 without Jose's review. He asked to "carry on with everything that's missing" and review features in bulk later.
- **Grounding:** product spec GV-02, GV-22–GV-24 and Q-GV-4/5 (all DECIDED); architecture §3.3 and §4.4; the prototype's connect flow (`design/prototype/Main.dc.html` `.relbar`; strings `relBanner`, `relMade`, `directed`, `remove`).
- **Builds on:** M3a (`feat/m3a-global-view`, after its final-review fix pass).
- **Edges are drawn by an `EdgeLayer`:** one SVG under the cards (`features/global-view/edges.tsx`), not by React Flow, and aggregated edges are capped at the 500 strongest. M3b's edge clicks are handled on that layer: manual-edge strokes and labels get `pointer-events` and the `nopan` class.
- **Connect handles have to come back:** the M3a fix pass removed the cards' hidden React Flow handles, and M3b re-adds a source handle on the connect button and a target over the card body.
- **Judgement calls** are listed in §9.

---

## 1. Goal and success criteria

Connect ideas by hand on the map, and choose which page represents a folder.

1. **Create a relationship (GV-22):**
   - drag from a card's connect handle to another card;
   - or, by keyboard and click alone, press **Connect** and then choose the target card;
   - in both cases the source page's frontmatter `related:` gains `"[[Target]]"` and a manual edge appears.
2. **Edit a relationship (GV-23):** give it an optional short label and an optional direction (an arrow from source to target), or delete it.
3. **Storage (GV-24):** relationships are stored in the **source page's** frontmatter. A plain relationship is the string `"[[Page]]"`; a labelled or directed one is a map `{ link: "[[Page]]", label: "…", directed: true }`. The file reads naturally in Obsidian.
4. **Index note pick (GV-02):** a folder without an index note under rules 1–2 (named like the folder, or `index.md`) can have one picked. The pick is stored in `.nimw/vault.json` `indexPicks`, follows renames, and can be cleared.
5. **Safari 15 floor:** the six existing `color-mix()` uses (sidebar hovers, dialog and opening backdrops) are replaced by generated tokens, and React Flow's `structuredClone` path stays unreachable.

The non-negotiables are as in M3a.

## 2. Connecting cards (`features/global-view/Connect.tsx`, `Card.tsx`)

- **The handle:** each card's header gets its **connect** button back (hidden in M3a). It is also a React Flow source handle (`Handle type="source"`), and the whole card body is a target.
  - Dragging from the handle draws a live connection line in the manual colour; dropping it on another card creates the relationship.
  - `connectOnClick={false}`: React Flow's click-to-connect path uses `structuredClone`, which Safari 15.0–15.3 lacks. Our own click flow replaces it.
- **Click and keyboard flow:**
  1. Pressing **Connect** enters connect mode. A status bar under the toolbar (prototype `.relbar`, warn tokens) says "Pick the card to connect: <source title> → ?" and has a Cancel button. The source card gets the manual-colour ring.
  2. The next single click on a card, or Enter on a focused card, completes the connection.
  3. Escape, Cancel or a click on the background leaves connect mode.
  4. Navigation (drill or expand) is suspended while connect mode is on.
- **Source and target resolution:**
  - a page card is itself;
  - a folder card is its index note;
  - a folder without an index note can't take part, and a toast says so: "<Folder> has no index note. Pick one first", with a **Pick index note…** action (§4).
  - Self-relationships are refused silently: connect mode simply stays on.
  - A relationship that already exists (same source → same target) isn't duplicated: its edit popover opens instead (§3).
- **The write:** `"[[<target>]]"` is appended to the source's `related:` list (§5).
  - `<target>` is the shortest unique wiki target (Rust `shortest_unique_target`; the same command family as M2c `link_suggest`), with no alias.
  - The edges refresh, and a polite status message says "Relationship created".

## 3. Editing and deleting (`features/global-view/RelationPopover.tsx`)

- **Clicking a manual edge** (its stroke or label) opens a popover anchored at the edge midpoint. It contains:
  - **Label:** text, ≤ 40 characters, trimmed; empty means no label;
  - **Direction:** "No arrow / Arrow to <target>" (radio);
  - **Delete relationship** (danger button);
  - **Done.**
  - Changes are written when Done is pressed or the popover closes with valid input; Escape cancels.
- **Keyboard access:** edges aren't focusable, so each page card's connect button has a menu (ARIA menu button) with:
  - **Connect to…** (§2);
  - **Relationships…**, a dialog listing this page's own `related:` entries (target title, label, arrow), each with Edit (the same fields as the popover) and Delete.
  - Incoming relationships are listed read-only, with their source page's name, since they live in another page.
- **Aggregated manual edges** (folder ↔ folder) open the Relationships dialog of the first source page, with a note that the edge stands for N relationships inside the folders.
- **Serialization:**
  - a plain relationship is written as the string form;
  - adding a label or direction turns that item into the map form, and removing both turns it back into the string form;
  - deleting removes the item, and removing the last item removes the `related:` key.

## 4. Index note pick (`features/global-view/IndexPickDialog.tsx`)

- **Who can pick:** a folder card whose index note doesn't come from rules 1–2 shows a **Pick index note…** button in its cover area (folder summary) or footer.
  - It opens a dialog listing the folder's direct pages (radio list, with search when there are more than 10), plus **No index note**.
  - Saving writes `.nimw/vault.json` `indexPicks[<folder>] = <page>` (or removes it) through Rust. Unknown keys are kept, and the file is created lazily.
- **When rules 1–2 apply** (a page named like the folder, or `index.md`), the card shows no pick button, because the product spec gives those precedence. A stale pick is ignored and is kept until it's cleared.
- **Renames:** picks follow renames and moves of the folder or the page, through the same Rust choke points as the M3a layout remap (in-app rename and watcher renames). A pick whose page was deleted is dropped lazily, on the next read.

## 5. Writing `related:` (`markdown/frontmatterEdit.ts` + `stores/relations.ts`)

- **New list operations** in `frontmatterEdit`, with the same guarantees as M2c:
  - byte-minimal;
  - re-parsed and read back, or refused;
  - CRLF kept;
  - comments and the order of other keys kept.
  - The operations are `appendRelated(text, target)`, `updateRelated(text, index, {label?, directed?})` and `removeRelated(text, index)`.
  - They work on the `related:` block sequence. A flow sequence (`related: ["[[A]]"]`) or a scalar is rewritten into block form only when the read-back guard confirms nothing else changed; otherwise they're refused with M2c's "Edit it in Source mode" toast.
- **Where the write goes:**
  - **The source page is open in the editor:** through `editorStore.editFrontmatter`'s live-view path, so the change is undoable with ⌘Z in the editor, and flushed.
  - **The source page is not open:** `page_read` → edit → `page_write(expectedHash)`.
    - On a conflict (an external change), it re-reads and retries once, then shows a toast "Couldn't update <page>: it changed on disk. Try again."
    - The page is never left half-written: page_write is atomic.
- **After every write:** the Global View re-fetches edges, and the session reindexes synchronously, so `gv_edges` sees the change at once.
- **Indexing gap:** the Rust indexer accepts the scalar form `related: "[[X]]"` too (M3a §13.4 gap), in parity with the TS reader. Labels and directions keep M1's parsing rules.

## 6. Backend

- **`link_target(source: String, target: String) -> String`:** the shortest unique wiki target from `source` to the vault path `target` (async, real-ACL test). A batch form isn't needed.
- **`index_pick_set(folder: String, page: Option<String>)`:**
  - validates that the folder is a visible folder and the page a visible page directly inside it;
  - writes `vault.json` atomically;
  - returns the folder's new `GvCard`.
  - `gv_children` already reads `indexPicks` (M3a §3.2 rule 3).
- **Renames:** `layout_remap`'s rename hook also remaps `indexPicks` keys and values by path prefix.
- **Indexer:** `crates/nimw-markdown/src/frontmatter.rs` accepts a scalar `related:` (string or map) as a one-item list.

## 7. Safari 15 floor cleanup

- **Generated tokens** for every palette and mode in `palettes.ts` / `palettes.css`, computed to hex or rgba:
  - `--color-sidebar-hover` (the sidebar text at 10–12%);
  - `--color-sidebar-active` (16%);
  - `--color-sidebar-divider` (15%);
  - `--color-backdrop` (the background at 60%);
  - `--color-overlay` (the background at 70%).
- **Replacements:** these tokens replace the six `color-mix()` uses in `Shell.module.css`, `Explorer.module.css`, `Dialogs.module.css` and `OpeningOverlay.module.css`.
- **Guard test:** a test like M2c's `cssCompat.test.ts` fails on any `color-mix(` in `src/**/*.css`.

## 8. Testing

- **TS:**
  - `appendRelated` / `updateRelated` / `removeRelated`: string ↔ map round trips, the last item removing the key, flow and scalar forms rewritten or refused, CRLF, comments, and a sweep like M2c's;
  - `relations.ts`: open page (undoable), closed page (CAS), and conflict retry;
  - Connect: drag via React Flow `onConnect`, the click flow, keyboard (Enter on Connect, then arrows and Enter), Escape, folder without an index note → toast action, an existing relationship → popover;
  - the popover and the Relationships dialog: axe, the focus trap and return;
  - the index pick dialog;
  - the CSS guard.
- **Rust:**
  - `link_target`;
  - `index_pick_set` (validation, lazy file, unknown keys kept, remap on rename, stale pick ignored when rules 1–2 apply);
  - scalar `related:` indexed;
  - real-ACL tests for both commands.
- **E2E (Chromium + WebKit):**
  - connect two cards by click and by drag, and the edge appears;
  - label and arrow edit, and the frontmatter is updated;
  - delete;
  - pick an index note, and the folder card previews it;
  - zero-network.
- **Real window:** a trackpad drag-to-connect in WKWebView; the popover position near window edges; an Obsidian read of the written `related:` maps.

## 9. Decisions taken for Jose (to review in bulk)

1. **Two ways to connect:** dragging from the connect handle (the product spec) and a click/keyboard flow (accessibility, and the prototype's flow). React Flow's own click-connect stays off because of `structuredClone` on Safari 15.
2. **A folder card stands for its index note** in a relationship; a folder without one can't be connected, and the user is offered **Pick index note…**.
3. **Direction is one-way only** (source → target). To point the other way, connect from the other card.
4. **Relationships written to pages that aren't open** have no undo, but delete is one click away in the popover. Pages open in the editor get ⌘Z through CodeMirror.
5. **Index picks only apply where rules 1–2 give nothing,** as the product spec orders them. The pick button is hidden otherwise.
6. **Label limit:** 40 characters.
7. **The scalar `related:` form is now indexed,** and writes always produce the block-list form.
8. **The Safari 15 `color-mix` cleanup rides along** with this milestone.
