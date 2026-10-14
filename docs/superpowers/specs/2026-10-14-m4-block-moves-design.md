# M4 — Block moves (drag-and-drop reordering): Design

**Status:** written on 2026-10-14 without Jose's review. He asked to "carry on with everything that's missing" and review features in bulk later.
- **Grounding:** product spec §8 (DND-01–DND-08, Q-DND-1 and Q-A11Y-1, all DECIDED), architecture §4.3, and the prototype's Split-pane block gutter (`design/prototype/Main.dc.html`: grip plus Move up / Move down, the hint "Drag blocks in the preview to reorder them; the Markdown on the left follows.").
- **Builds on:** M3b (`feat/m3b-relationships`, after its final-review fix pass).
- **Judgement calls** are listed in §9.

---

## 1. Goal and success criteria

Reorganize a page by moving whole blocks, without cutting and pasting Markdown.

1. **Split view (DND-01):** each movable block in the rendered pane shows a gutter on hover or keyboard focus, with a **drag grip**, **Move up** and **Move down**, plus **Indent** and **Outdent** for list items.
2. **Movable blocks (DND-02):** headings, paragraphs, lists, single list items (nested included, which can change level), quotes and callouts, code blocks, table rows, images and embeds (a lone-embed paragraph), audio clips, HTML blocks, columns and horizontal rules.
   - Inline content is never draggable (DND-03).
3. **The move (DND-04/05/06):**
   - a drop rewrites the source as **one** CodeMirror transaction (`userEvent: 'move.block'`), so a single ⌘Z restores the old order;
   - the source pane updates at once;
   - the bytes of each moved block are unchanged, except a list item's indentation prefix when its level changes and the blank lines between blocks.
4. **Headings (DND-07):** a heading moves with its section, up to the next heading of the same or higher level. **Alt-drag** (or **Alt+Move up/down**) moves the heading line alone.
5. **Keyboard (DND-08):** every drag has a keyboard equivalent.
6. **Product acceptance:**
   - P3 dropped above P1 reads P3, P1, P2, byte-identical;
   - undo once restores the order;
   - `## A` with two paragraphs dropped after B's section moves all three together.

Non-negotiables as before: no network; i18n en + es; axe-clean; Safari 15 floor; NFR-10 (focus never lost); typing latency unaffected (NFR-03).

## 2. The block model (`markdown/blocks.ts` additions, pure, no DOM)

- **`movableBlocks(page: ParsedPage, text: string) → MovableBlock[]`** lists the moveable units as source ranges. Each unit has:
  - `kind` (`heading | paragraph | list | listItem | quote | code | tableRow | embed | html | columns | rule | other`);
  - `from` / `to`: whole lines, without the trailing blank lines;
  - `depth` (list nesting);
  - `parent` (the list or table it belongs to);
  - `section` (headings only: where its section ends, by the DND-07 rule).
- **Which units exist:**
  - top-level flow nodes are units;
  - every list item, at any depth, is a unit;
  - a table's body rows are units (the header row and the delimiter row are not);
  - front matter is never a unit, and nothing can be dropped above it.
- **Drop slots:** `slotsFor(unit)` lists where a unit may land.
  - Top-level units land between top-level units, or at the end.
  - List items land before or after any list item, at that item's level or one deeper (as its child). They can also land at the top level, between blocks, where they become a new one-item list in the same marker style.
  - Table rows land only between body rows of their own table.
  - A heading's section can't land inside itself.

## 3. Rewriting the source (`markdown/blockMoves.ts`, pure)

- **`moveBlock(text, page, unit, slot, { lineOnly }) → TextChange[]`** returns two changes (delete plus insert) that CodeMirror applies as one transaction.
- **Blank lines:** the moved text is re-separated so that top-level blocks keep one blank line between them, and the hole it leaves keeps the surrounding blocks separated by one blank line. Nothing else changes.
- **List items:**
  - **Depth:** an item moving from depth d to d′ has every line of its own text and its nested children re-indented by the difference. The indent unit is that of the target list: the parent marker's text column, 2 for `- `, 3 for `1. ` (M2b I2 rule).
  - **Markers:** the item's marker character and checkbox are kept, but an ordered marker is renumbered to fit its new list, and the source list is renumbered. That uses the same renumbering as the M2b list commands.
  - **Becoming a list:** an item dropped at the top level becomes a one-item list at depth 0, keeping its marker.
- **Line endings:** CRLF documents keep CRLF.
- **Inside quotes and callouts:** blocks there are not separate units. A quote or callout moves as a whole.
- **Guard:** every move is re-parsed (`parsePage`). It must yield the same multiset of block texts, normalised only for list indentation and numbering. Otherwise it is refused, with the toast "This block can't be moved here".

## 4. The gutter and dragging (`features/editor/BlockGutter.tsx`, Split pane)

- **The gutter:** a layer positioned over the rendered pane.
  - For the block under the pointer, or the focused block, it shows a 28 px column at the block's top-left with: grip (drag), Move up, Move down, and for list items Indent and Outdent.
  - The block elements are found by `data-source-start` / `data-source-end` (already set by `markSourceRanges`), matched to the model in §2.
- **Dragging** uses pointer events rather than HTML5 drag-and-drop, which Tauri's native drag handling intercepts.
  - Pressing the grip and moving more than 4 px starts the drag.
  - A translucent copy of the block follows the pointer, and an accent **drop line** shows at the nearest valid slot. List slots are indented to the level the item would take, chosen from the pointer's x position.
  - The pane auto-scrolls near its top and bottom edges.
  - Escape cancels the drag.
  - Dropping on the original position does nothing.
  - **Alt held at drop time** moves a heading's line only.
- **After a drop:**
  - the moved block in the pane flashes the accent-soft background for 600 ms;
  - focus moves to its grip;
  - a polite live region announces "Moved <block summary> after <neighbour summary>".
- **Pointer only from the grip:** the gutter's buttons don't steal focus from the source editor unless they are used. Text selection in the pane still works, since only the grip starts a drag.
- **The hint bar:** the first time a vault shows Split, a dismissible hint above the pane reads "Drag blocks in the preview to reorder them; the Markdown on the left follows." Dismissing it is remembered globally.

## 5. Keyboard (`features/editor/BlockGutter.tsx`, `features/editor/format.ts` keymap)

- **In the pane:**
  - Tab reaches the gutter of the first block;
  - ↑ and ↓ move between blocks' grips (roving tabindex);
  - **Alt+↑ / Alt+↓** move the focused block up or down by one slot;
  - **Alt+→ / Alt+←** indent or outdent a list item;
  - **Alt+Shift+↑ / ↓** move a heading's line only;
  - Enter on the grip starts a keyboard drag: arrows choose the slot, Enter drops, Escape cancels.
- **In the source editor:**
  - **Alt+↑ / Alt+↓** with the cursor in a block move that block (CodeMirror's "move line" binding is replaced inside movable blocks only; elsewhere it moves the line as before);
  - **Alt+→ / Alt+←** on a list item indent and outdent it, the same as Tab / ⇧Tab.
  - The same `moveBlock` is used everywhere.
- **Mode:** in Live Preview and Source only these editor shortcuts apply. The gutter exists only in Split (DND-01).

## 6. Edge cases

- **Read-only pages** (binary, truncated, or no editor) have no gutter.
- **Large notes** (M2a `LARGE_NOTE_CHARS`): the gutter still works, but the guard re-parse runs on the full text (measured; the budget is < 100 ms at 200 KB).
- **A move during an external change:** the move is computed and dispatched against the current editor state, then the normal M2a merge applies.
- **Stale models:** if the pane's model is stale after typing (it re-renders after 150 ms), the drop recomputes units from the current text before applying. A unit that no longer exists cancels the drop.

## 7. Testing

- **`blockMoves` (pure):**
  - product acceptance 1–3;
  - every kind of unit, at every slot class;
  - heading sections at each level, plus Alt line-only;
  - list items between levels and lists, and to the top level (markers, renumbering, checkboxes, indent units);
  - table rows;
  - CRLF;
  - the guard refusing a corrupting move;
  - a **sweep**: for generated documents, every unit to every slot keeps the multiset of block texts, and undo restores the original.
- **Components:**
  - the gutter on hover and focus;
  - pointer drag with the drop line, Escape and auto-scroll (jsdom geometry stubs);
  - keyboard drag;
  - live-region text;
  - axe in light and dark.
- **Editor:** Alt+↑/↓ in Source and Live Preview; one undo step.
- **E2E (Chromium + WebKit):**
  - drag P3 above P1 in Split, then ⌘Z;
  - a heading section move;
  - a list item to a deeper level;
  - keyboard-only moves;
  - zero-network.
- **Real window:** drag feel with a trackpad and a mouse; auto-scroll speed; the Alt-drag modifier on a Mac keyboard.

## 8. Out of scope

- Drag handles in Live Preview (DND-01 limits them to the preview pane);
- moving blocks between pages;
- multi-block selection;
- moving blocks inside quotes or callouts individually;
- moving table columns.

## 9. Decisions taken for Jose (to review in bulk)

1. **Pointer events, not HTML5 drag-and-drop,** because Tauri's native drag handling intercepts HTML5 drags (seen in M2c).
2. **Keys:** Alt+↑/↓ moves the block in the pane and in the source editor; Alt+→/← indents and outdents list items; Alt+Shift+↑/↓ moves a heading's line alone. Inside movable blocks, CodeMirror's own Alt+↑/↓ "move line" is replaced with the block move.
3. **List items dropped at the top level** become one-item lists. Their content is never turned into a paragraph.
4. **Quotes and callouts move as a whole.** Their inner blocks aren't separate units.
5. **Only blank lines and a list item's indent and number change in a move.** A re-parse guard refuses anything else.
6. **A one-time, dismissible hint bar,** copied from the prototype.
7. **Live Preview gets the keyboard moves but no drag gutter,** following DND-01's "preview pane only".

## 10. Amendments from planning (plan `docs/superpowers/plans/2026-10-14-m4-block-moves.md`, replayed end to end)

These override the sections above where they conflict.

1. **The guard (§3) parses windows, not the note.**
   - It re-parses the top-level blocks each edit touches, plus one more on each side, before and after the move, and compares their signatures: block texts (indentation, `>` and list markers aside), containers, task states, `%%` comments and top-level kinds.
   - A full parse of 200 KB takes ~450 ms in jsdom, while a move with its guard takes ~2.5 ms.
   - A window that doesn't start the note gets a leading blank line, so a `---` there reads as a rule, not front matter. The sweep found this.
2. **List items (§3):**
   - **Markers:** an item takes the marker of the list it joins (its bullet character, or ordered with that list's delimiter), because a different marker would start a new list. Its checkbox stays.
   - **Numbering:** ordered lists are renumbered only when they were sequential, or all one number; others keep each item's number. When a marker's width changes (9. → 10.), the item's other lines shift with it, so nested items stay nested.
   - **Becoming its own list:** an item dropped among top-level blocks keeps its own marker. A new nested ordered list starts at 1 (the M2b rule).
3. **Slots and refusals:**
   - A list, or an item becoming one, is never offered a slot next to a list with the same marker (the two would merge).
   - Moves the guard refuses are refused with "This block can't be moved here." That covers lists merging after a block between them leaves, and an indented code block or paragraph taken into a list. A refused move changes nothing.
4. **Editor keys (§5):**
   - Alt+↑/↓ moves the heading's section, the list item or the table row holding the selection. Anywhere else it stays CodeMirror's line move. At the edge nothing moves.
   - Alt+←/→ (word moves on macOS) and Alt+Shift+↑/↓ (copy line) are **not** taken in the editor. Those moves live on the gutter's grip; Tab/⇧Tab still indent and outdent list items in the editor.
   - A section's Move up passes the previous heading of its level or higher. Move down passes the next section at its level.
5. **The gutter (§4):**
   - **Hover:** it shows only the deepest block under the pointer. A whole list shows its own gutter from its margin (outside its items) and is always reachable by keyboard.
   - **Buttons:** at rest a gutter is just the grip. Its buttons open while it's hovered or holds the keyboard (React state; WebKit before 15.4 and jsdom ignore `:hover` rules for this).
   - **Keyboard:** one tab stop; ↑/↓ go from block to block; Enter picks a block up (the first place after it is preselected); Tab or Escape cancels.
   - **Anchors:** the first element an HTML block renders carries the block's source range, so it has a gutter. Nothing is wrapped: a `<details>` opened in one block still holds the Markdown blocks after it, as in M3b (final review I1). A block that renders no element (a comment, a closing tag) has no gutter. Blocks of an embedded note never get one, because their offsets are the other note's.
6. **The pane after a move:** it renders at once, without the 150 ms typing delay. A gutter key that arrives while the pane still lags the editor does nothing, and a pick-up made on blocks that have since changed is cancelled. The e2e test found this: keys pressed right after a move acted on the old blocks.
7. **Pointer drag:** the nearest slot is chosen by |dy| + 0.3·|dx| for list slots, so pointing further right picks a deeper level.
8. **The hint bar:** dismissing it is remembered in `localStorage` (try/catch), not in settings. Losing it shows the hint once more.
9. **The block model** is cached per editor document and re-parsed incrementally. The first move in a large note opened in Source pays a full parse (~1.5 s in jsdom at 200 KB). Later moves take ~10 ms. Making the top-level slots linear time (they were O(n²)) brought a list item's move from ~110 ms to well under 100 ms.
10. **Live Preview's "HTML renders nothing" check** (M2c §7.7) is M3b's again: there is no HTML wrapper to look through (final review I1).
11. **Safari 15:** M4 code avoids `Array.prototype.at`.
12. **Tests:** the fake disk now resolves a wiki target to a page it holds, so embeds render in jsdom.

