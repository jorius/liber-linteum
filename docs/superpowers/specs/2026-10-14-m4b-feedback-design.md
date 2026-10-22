# M4b — Feedback round (the maintainer's real-window check of M2c–M4): Design

**Status:** design agreed with the maintainer on 2026-10-14 (four answers and an approval). **Builds on:** M4 (`feat/m4-block-moves`). **Roadmap:** inserted before M5 (search), as M2b was after M2a.

The maintainer's feedback, item by item. Each item cites the feedback it answers.

---

## 1. Shell and header layout (F3, F4)

**Goal:** the page's text starts about 25% from the top instead of about 50%.

- **Sidebar header:**
  - It shows the **vault name** (ellipsized, with a `title` for the full name) next to the app mark (`BrandMark`), replacing "Liber Linteum".
  - The app name stays in the window title, the About panel and the Welcome screen.
- **Top bar, left area** (replacing the vault name):
  - **Edit screen with a page:** the page **title** (M2b `PageTitle`, editable in place, rendered as the page's `h1`), with the **subtitle** below it (M2c `PageSubtitle`, editable), on one compact line each, ellipsized.
  - **Global View:** "Global view" and the current level's name.
  - **No page open:** empty.
  - The title note "Title in the note: …" moves to the header band (below).
- **Header band:** one compact strip under the top bar, replacing the old header block.
  - **Row 1:** the back arrow and breadcrumb on the left; Saved, Format and the mode switch on the right.
  - **Row 2:** tags, then "N links · M backlinks", then the **Related** chips (§6), then the title note, wrapping when needed.
  - **With a cover,** the band is **132 px tall** and the cover is its background:
    - `object-fit: cover`, `object-position: 50% <cover-y>%`;
    - the rows sit on top;
    - each group (breadcrumb, controls, row 2) sits on a **pill of the surface colour at 88% opacity** (a generated `--color-surface-veil` token per palette and mode, Safari 15 safe), so text meets AA on any image;
    - the cover actions (§2) sit at the bottom right.
  - **Without a cover,** the band has no background and no fixed height (the two rows only). **Add cover** appears in row 1 on band hover or focus, and is always in the Tab order.
  - Remote or missing covers keep their placeholder text (M2c), as a muted band background.
- **Unchanged:** the formatting toolbar, Split and the editor stay below the band as before.

## 2. Cover (F1, F2)

- **Straight to reposition:** after a successful Add cover or Change cover pick, the band enters **reposition mode** at once (M2c §2's mode). Drag or the arrow keys set the position, and **one Save position** writes `cover-y`. Cancel keeps the new image at 50% (no `cover-y`). The picked `cover:` is written first, as today.
- **Icons on the buttons** (16 px, `aria-hidden`; text labels kept):
  - Change: image;
  - Reposition: move-vertical;
  - Remove: trash;
  - Add cover: image-plus;
  - Save position: check;
  - Cancel: x.
- **Mode switch icons:**
  - Live Preview: pen;
  - Source: code `</>`;
  - Split: columns.

## 3. Buttons from the palette (F10)

- **Shared classes** in `theme/buttons.css`:
  - **`.btn-primary`:** `--color-accent` background, `--color-accent-contrast` text, `--color-accent-hover` on hover;
  - **`.btn-secondary`:** surface background, `--color-border-strong` border, `--color-text` text, an accent border on hover;
  - **`.btn-danger`:** `--color-danger` background (a new token per palette and mode), its contrast text.
  - All three have a 2 px `--color-focus` ring on `:focus-visible` (a separate rule, `cssCompat` safe) and a disabled state.
- **Where they apply:** every dialog's and bar's actions use them.
  - **Primary:** Save, Create, Done, Rename, Insert, Start recording, Stop & insert, Save position, Pick.
  - **Secondary:** Cancel, Close, Not now.
  - **Danger:** Delete, Remove, Discard.
- **Tests:** `palettes.test.ts` asserts `accent-contrast` on `accent` ≥ 4.5 and `danger-contrast` on `danger` ≥ 4.5 for every palette, mode and derived custom accent.

## 4. Editor (F7, F8, F5)

- **`[[` / `![[` autocomplete:**
  - The list gets a **search line** at the top, a non-option header: a magnifier, "Search: <query>" (or "Type to filter" when empty) and "N matches".
  - Queries are **debounced by 80 ms**; a newer keystroke aborts the older query, and Rust's cap of 50 stays.
  - The search line updates with each result and is announced politely.
- **⌘K / Link picker:**
  - It **re-anchors** on editor scroll and window resize, follows the selection's coordinates, is **clamped inside the window** (8 px margin), and **flips above** the line when there's no room below.
  - When the selection leaves the editor's visible area, the picker stays clamped to the nearest edge, and the list scrolls inside the picker.
- **Paste:** an image of a type the webview can decode but we don't store (TIFF from Preview or Photos, BMP, HEIC where supported) is converted to PNG in the page (`createImageBitmap` → canvas → `toBlob('image/png')`) before `attachment_paste`. Types that can't be decoded fall back to normal paste.
- **Screenshots:** the hand-off documents macOS screenshot-to-clipboard (⌘⇧⌃4, or ⌘⇧5 → Options → Save to → Clipboard). No code is needed: macOS saves screenshots to files by default.

## 5. Attachments override (F9)

- **`.liber/vault.json` `attachments.overrideObsidian: boolean`** (default false).
- **Precedence:**
  1. Liber Linteum's setting when `overrideObsidian` is true;
  2. else Obsidian's `attachmentFolderPath` when present;
  3. else Liber Linteum's setting;
  4. else the default.
- **Settings → This vault, when Obsidian's setting exists:**
  - the note reads "Obsidian puts new attachments in `./assets` (next to each page)";
  - a switch, **Use a different place in Liber Linteum**, enables the selector, and saving with it on writes `overrideObsidian: true`;
  - turning it off writes false; Liber Linteum's last choice is kept for next time.
- **`.obsidian/app.json` is never written.**
- **`vault_settings_get`** gains `overrideObsidian`, and `vault_settings_set` accepts it. The real-ACL test is extended.

## 6. Manual relationships, made findable (F11)

- **Related chips in the header band (row 2):**
  - one chip per entry in this page's own `related:`, showing its title, plus → when directed and the label as a `title`;
  - clicking a chip opens that page;
  - **×** removes the entry (`relations.removeRelation`; undoable, since the page is open);
  - **+ Related page** opens the Link picker in page-only mode, and choosing a page calls `relations.relate(current, target)` (M3b write path, with its toasts and refusals);
  - a chip for an unresolved target is muted, with "Not found".
  - Incoming relationships aren't listed (M3b §10.2). The Global View shows them.
- **Global View toolbar:** a **Connect cards** button (link icon plus text) enters a source-pick mode.
  - The status bar says "Click the card to connect from".
  - After a card is picked, it continues as M3b connect mode ("Pick the card to connect: <source> → ?").
  - Escape or Cancel leaves the mode.
  - The bar's hint also says "or drag from a card's link handle".

## 7. App icon (F6)

The macOS Dock icon is drawn edge to edge on its 1024 canvas, so it looks bigger than other apps.
- **A new macOS source** `icons/app-icon-macos.svg`: the same artwork inside Apple's grid, an 824 × 824 rounded square (radius 184) centred, with a soft drop shadow, on a transparent 1024 canvas.
- **`icon.icns`** is regenerated from it with `tauri icon` into a temporary folder; only `icon.icns` is copied over. The other platforms' icons are unchanged.
- **A test** checks that `icon.icns`'s 1024 representation (via `sips`, macOS only) has transparent corners and a margin.

## 8. Testing

- **TS:**
  - the new layout: top bar title/subtitle editing, keeping focus rules from M2b/M2c;
  - the band with and without a cover, pills present, axe in light and dark across palettes;
  - reposition straight after a pick, one save;
  - button classes on dialog actions, contrast tests;
  - the autocomplete search line and debounce (fake timers);
  - the picker re-anchoring, clamping and flipping (jsdom geometry stubs);
  - TIFF conversion (stubbed `createImageBitmap`);
  - the attachments override UI;
  - Related chips (open, remove, add, unresolved);
  - Connect cards mode.
- **Rust:** the precedence with `overrideObsidian` and the settings round trip.
- **E2E (Chromium + WebKit):**
  - the editor's text starts in the top 35% of a 900 px window with a cover;
  - title editing in the top bar;
  - Add cover goes straight into reposition (mocked picker);
  - ⌘K picker after scrolling stays in the window;
  - Related chip add and remove;
  - Connect cards;
  - zero-network.
- **Real window (the maintainer):**
  - the overall look with real covers and palettes;
  - the Dock icon size next to other apps;
  - screenshot paste after switching to clipboard;
  - TIFF paste from Preview.

## 9. Out of scope

- Incoming relationships in the header;
- custom button themes;
- a sidebar collapse toggle (the prototype's ⧉ button);
- moving the explorer actions.

## 10. Amendments from planning

The plan (`docs/superpowers/plans/2026-10-14-m4b-feedback.md`) was replayed end to end on a scratch clone. These rulings and deviations came out of it.

### Layout and header

1. **`PageHeader` is a `div`, not a `<header>`.** The top bar is the page's only banner. A second `<header>` in the page area made two banners.
2. **The note's own title** ("Title in the note: …") is a separate `NoteTitle` in the band's second row. `PageTitle` no longer renders it.
3. **Muted text on the cover pills uses the body colour.** On the 88% veil over a black or white cover, `--color-text-muted` fell to about 4.0:1 in several palettes. Inside `.bandCover .pill`, `--color-text-muted` resolves to `--color-text-body` (6.7:1 at worst), and the 88% veil stays. A palette test checks text and body colours over black and white for every palette, mode and derived accent.
4. **A long page or folder name never widens the sidebar** (`.side { min-width: 0 }`). Before, a very long name widened the sidebar to fit its explorer row and pushed Edit · Global view out of the window. This bug dates from M1 and was found by the M4b e2e test.
5. **Buttons:**
   - the Settings dialog's Close is secondary;
   - the cover's Remove is danger, Save position primary, and Add cover, Change, Reposition and Cancel secondary (small);
   - the Global View connect bar's Cancel is secondary (small).

### Cover

6. **The cover state records the `cover:` value it was resolved for** (`of`). Reposition starts only once the picked value itself has an image, never on the previous cover's state.
7. **Focus after a pick goes to the position slider** if focus is in the band or on the body, or if there was no click or keypress while the file dialog was open. Where focus sits after the dialog says little about intent: WebKit doesn't focus clicked buttons, and the explorer's refocus replaces its row element.

### Editor

8. **With 0 matches, CodeMirror shows no `[[` list**, so there is no search line either. The count is still announced.
9. **An undecodable pasted image shows a toast** ("This image can't be pasted. Save it as PNG or JPEG first.") instead of falling back to normal paste. This differs from §4: the paste event has already been taken when decoding fails, so it can't go back to the editor's own paste. Other images in the same paste are still saved, in order.
10. **The ⌘K picker always has an anchor.** CodeMirror keeps the selected line drawn even when it's scrolled far out of view, so `coordsAtPos` stays valid, and `placePopup` clamps the picker to the window's edge.
11. **The Link picker and the "+ Related page" picker share one `PickerPopup`**, which re-anchors on any scroll (captured on `window`) and on resize.

### Attachments

12. **`overrideObsidian` is a top-level field** of `vault_settings_get`'s result and `vault_settings_set`'s patch, not inside `attachments`. In `.liber/vault.json` it stays `attachments.overrideObsidian`, and it is written only once set. A patch with only `overrideObsidian` turns the override on or off and keeps Liber Linteum's place. While Obsidian's setting applies, saving the same place is allowed; a different place is refused, as in M2c.

### Relationships

13. **A Related chip is followed like a link**, so the back arrow returns to the page it was on. The first build used a direct navigation, which reset the trail; the e2e test found it.
14. **Connect cards:**
    - the "(or drag from a card's link handle)" hint shows only while the first card is being picked;
    - picking a folder without an index note shows the M3b toast and keeps the pick waiting;
    - Cancel from the bar returns focus to the Connect cards button while no card was picked yet (or to the first card once one was);
    - a slow double click in pick mode counts as connecting, so it doesn't open the editor;
    - going back a level, changing the view mode or leaving the Global View ends the mode.

### App icon

15. **The drop shadow is seven stacked translucent rounded squares**, not an SVG filter: `sips` (CoreSVG) draws no SVG filters. The 1024 PNG comes from `sips`, so there's no new dependency. The steps to regenerate it are in the SVG's comment.
16. **The icon test is a Vitest test in the Node environment, run on macOS only** (`src/appIcon.test.ts`). It reads the icns's 1024 representation with `sips` and decodes it with `node:zlib`.

### Testing

17. **The fake disk reports `#tags`**, so the band's tags can be tested.
18. **Add cover going straight into reposition is tested end to end in `m2c.spec.ts`** (updated), not repeated in `m4b.spec.ts`.
19. **Every M4b e2e test checks for zero network and no CSP violations**, in Chromium and WebKit. There's no separate zero-network test for M4b.
