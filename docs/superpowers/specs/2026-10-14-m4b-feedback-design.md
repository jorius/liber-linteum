# M4b — Feedback round (Jose's real-window check of M2c–M4): Design

**Status:** design agreed with Jose on 2026-10-14 (four answers and "Go on"). **Builds on:** M4 (`feat/m4-block-moves`). **Roadmap:** inserted before M5 (search), as M2b was after M2a.

Jose's feedback, item by item. Each item cites the feedback it answers.

---

## 1. Shell and header layout (F3, F4)

**Goal:** the page's text starts about 25% from the top instead of about 50%.

- **Sidebar header:**
  - It shows the **vault name** (ellipsized, with a `title` for the full name) next to the app mark (`BrandMark`), replacing "Notes In My Way".
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

- **`.nimw/vault.json` `attachments.overrideObsidian: boolean`** (default false).
- **Precedence:**
  1. NIMW's setting when `overrideObsidian` is true;
  2. else Obsidian's `attachmentFolderPath` when present;
  3. else NIMW's setting;
  4. else the default.
- **Settings → This vault, when Obsidian's setting exists:**
  - the note reads "Obsidian puts new attachments in `./assets` (next to each page)";
  - a switch, **Use a different place in Notes In My Way**, enables the selector, and saving with it on writes `overrideObsidian: true`;
  - turning it off writes false; NIMW's last choice is kept for next time.
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
- **Real window (Jose):**
  - the overall look with real covers and palettes;
  - the Dock icon size next to other apps;
  - screenshot paste after switching to clipboard;
  - TIFF paste from Preview.

## 9. Out of scope

- Incoming relationships in the header;
- custom button themes;
- a sidebar collapse toggle (the prototype's ⧉ button);
- moving the explorer actions.
