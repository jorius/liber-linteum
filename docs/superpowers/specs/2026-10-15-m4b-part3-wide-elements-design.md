# M4b, part 3 — Wide elements (tables and friends at full width): Design

**Status:** agreed with Jose on 2026-10-15, one answer.
- Added to the second feedback round (`docs/superpowers/specs/2026-10-15-m4b-part3-design.md`) as **Stream D**.
- Same branch: `feat/m4b3-feedback`.
- Builds on M4b part 2 §1 (page width: app, vault, page).

## 1. The feedback

**What Jose saw:** a worldbuilding table ("Military Ranks", seven columns) squeezed into the 760 px readable measure. Cells break words mid-word ("Typic al", "Bronz e", "Lieutena nt").

**What he asked for:** let tables, and other elements he picks, use the full width while the text stays at the readable measure.

## 2. A third page width: "Wide elements"

**Values:** page width can be `readable`, `wide` or `full`, at the same three levels as today:
- **Page:** `.nimw/vault.json` `pageWidths`.
- **Vault:** `pageWidth`.
- **App:** `settings.json` `pageWidth`.

The most specific level that is set wins, as today.

**Validation:** Rust accepts `wide` in `page_width_set` and in `vault_settings_set`. Unknown values are refused as today. Real-ACL tests cover it.

**Which elements go wide:**
- An app setting, `wideElements`, with Tables, Code blocks, Diagrams (Mermaid), Images and Maths blocks.
- Default: tables and diagrams on, the rest off.
- In `settings.json`: `wideElements: { tables: true, code: false, diagrams: true, images: false, maths: false }`.
- Missing keys take their defaults, and unknown keys are kept.

**UI:**
- **Header band:** the full-width toggle becomes a menu button, with the same place and icon, whose icon reflects the current width. It opens a radio menu:
  - **Readable**;
  - **Wide elements**;
  - **Full width**;
  - a separator, then **Reset to default** (clears the page entry).

  It's keyboard-operable (↑/↓, Enter, Escape returns focus), axe-clean, and edits are undoable with ⌘Z like the other header edits.
- **Settings → Editor:**
  - Page width: Readable / Wide elements / Full.
  - Below it, a **Wide elements** group of five checkboxes. Its note reads "Used when a page's width is Wide elements". The group is always visible and always editable.
- **Settings → This vault:** Page width for this vault: Use the app setting / Readable / Wide elements / Full.

**Rendering:**
- **Live Preview and the Split pane:**
  - Text keeps the readable measure (760 px).
  - In the chosen kinds, an element narrower than the measure stays aligned with the text, as now.
  - A wider one grows evenly on both sides of the text column's centre, up to the editor's width minus its side padding (40 px in Live Preview, 28 px in Split).
  - Tables, code and maths size to their content. Images use their natural size, capped at the editor width. Diagrams use their natural SVG width, capped the same way.
- **Live Preview while editing:** when the cursor is inside a table or code block (raw lines showing), those lines use the same wide box, so the block doesn't jump between widths while editing.
- **Source mode:** unchanged; it has no measure.

## 3. Tables keep their words whole, in every width mode

- **Words aren't split:** cells use `overflow-wrap: normal; word-break: normal`, so words are never split mid-word. Long unbroken tokens such as URLs still wrap, at `/` and `-` only through `overflow-wrap: anywhere` on links.
- **Overflow:** a table wider than its available box scrolls horizontally inside its own wrapper instead of squeezing.
- **Accessibility of the wrapper:**
  - only when it actually overflows, it gets `role="region"`, an `aria-label` ("Table, scrolls sideways") and `tabindex="0"` (axe `scrollable-region-focusable`);
  - its scrollbar is visible;
  - its focus ring follows the theme's `--color-focus`.
- **Applies to:** Live Preview table widgets, the Split pane, embeds and the atoms map's table thumbnails (Stream A only shows column names there).

## 4. Testing

**Unit and component:**
- width resolution with `wide` at every level;
- the menu button's states;
- the checkboxes writing `wideElements`;
- the Rust validation and ACL.

**e2e** (chromium and webkit) on a seven-column table page:
- In Readable, no cell text is split: check that every cell's `scrollWidth` ≤ `clientWidth` or that the wrapper scrolls, with no single-word line breaks.
- In Wide elements, the table's box is wider than the text measure while paragraphs stay at 760 px.
- Turning Tables off in Settings brings the table back to the measure.
- Full is unchanged.

**Quality floors:** axe light and dark, i18n en and es, the Safari 15 rules.

## 5. Out of scope

- Per-element overrides inside one note (e.g. one table wide and another not).
- Resizing columns by dragging.

## 6. Amendments from planning (Stream D)

These override §2–§4 where they conflict.

### Where wide elements apply

1. **The Split pane has no measure** (part 2 §10.1), so Wide elements changes nothing there. The whole-word table fix (§3) applies there too.

### The header menu and settings

2. **Width changes aren't in the note's ⌘Z history.** Widths live in `.nimw/vault.json`, like today's toggle and the cover heights, so they sit outside the editor's undo stack. **Reset to default** is the way back.
3. **Reset to default stays, beside the part 2 rule.** Choosing the default's own width still clears the page's entry (part 2 §10.2). Reset is `aria-disabled` and skipped by the arrow keys while the page has no width of its own.
4. **The header button's icon** has three states: a narrow column, a column crossed by a wide block, and arrows to both edges. Its title names the width ("Page width: Wide elements").
5. **Unknown keys in `wideElements`** (written by a newer version) survive a patch from this one. Rust merges them into the saved object.

### How wide elements are laid out

6. **Superseded by M5b §7.2 and §14:** on a wide page the line numbers now sit at the editor's left edge, so blocks grow evenly on both sides, and a table wider than the text fills the editor. The original ruling follows.

   **Line numbers sit beside the measure, so a block centred on the text would cover them** (found by the e2e). `Editor.tsx` measures how far past the text a wide block may reach:
   - `--nimw-wide-m` on both sides;
   - then `--nimw-wide-r` on the right.

   Blocks grow evenly while both sides have room, then keep the text's left edge and grow to the right. Without line numbers, `m` equals `r`, which gives the centred growth of §2.
7. **How a rendered block is placed:**
   - it is a frame that reaches `m` past the text on both sides;
   - its content is centred in the frame with auto margins, which drop to 0 when the content overflows. That is the "safe centre" behaviour, without the `safe` keyword that Safari 15 lacks.
   - Diagrams take the whole frame, and their SVG is centred in it at its own size. With line numbers they don't use the right-only reach.
8. **Lines (code, and a table, maths block or diagram being edited)** share one box, as wide as the block's widest line:
   - `--nimw-ch`, in characters, with a tab as four;
   - the line is placed by `clamp()`/`min()` arithmetic, with the same reach.

   Raw table lines use the proportional font, so `ch` is an approximation; long lines still wrap.
9. **Which setting a block follows:**
   - a Mermaid block being edited follows **Diagrams**, not Code blocks, so it keeps its box between rendered and edited;
   - a `$$` block being edited follows **Maths**.
10. **Images:** only a lone image embed goes wide (a paragraph holding only `![[x.png]]` or `![](x.png)`). Inline images stay in the text.

### Tables

11. **Cells use `overflow-wrap: break-word`, not `anywhere`.** The pane's `anywhere` had shrunk every column's minimum width to one letter, which is why words were split. The "`anywhere` on links" exception in §3 was dropped: a long URL widens the table, which then scrolls in its box.
12. **The table box** is a named region in the tab order only while it overflows. It is measured on layout, by `ResizeObserver` and on window resize.

### Testing

13. **The e2e axe check is scoped to the menu and its button.** A whole-page run reports two issues from before this stream:
    - colour contrast of the sidebar's side label and foot (light);
    - `scrollable-region-focusable` on CodeMirror's `.cm-scroller`.
14. **`NIMW_E2E_PORT`** (default 4317) in `playwright.config.ts` lets parallel worktrees run their e2e suites side by side.
