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
