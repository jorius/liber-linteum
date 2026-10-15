# M4b part 3, Stream D — Wide elements: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third page width, **Wide elements**, keeps text at the 760 px measure while the element kinds the user picks (tables, code, diagrams, images, maths) use the editor's width. Table cells keep their words whole in every mode.

**Architecture:**
- **Width value:** `wide` joins `readable | full` at all three levels (page/vault in `.nimw/vault.json`, app in `settings.json`), validated in Rust.
- **Which kinds go wide:** the app setting `wideElements` (five booleans).
- **Header control:** the full-width toggle becomes a radio menu button.
- **Live Preview:** the host carries `data-wide-<kind>` attributes and a measured `--nimw-wide-max`.
  - Block widgets carry `data-wide-kind`.
  - Code and raw-table lines carry `--nimw-ch` (their longest line in characters).
  - CSS lets the chosen ones escape the measure, centred on the text column.
- **Tables:** they render inside a wrapper that scrolls sideways (a labelled, focusable region only while it overflows). Cells use `overflow-wrap: break-word` instead of the pane's `anywhere`, so their min-content counts whole words.

**Tech Stack:** Rust (nimw-vault, Tauri commands, settings), React 19 + TS + zustand, CodeMirror 6, Vitest, Playwright (Chromium + WebKit).

**Spec:** `docs/superpowers/specs/2026-10-15-m4b-part3-wide-elements-design.md`. It extends `docs/superpowers/specs/2026-10-14-m4b-part2-design.md` §1, §10 and §11.

## Global Constraints

- **Width values:** page width is `readable | wide | full`. Rust refuses unknown values. `"default"` in the vault patch clears the vault level.
- **`wideElements` defaults:** `{ tables: true, code: false, diagrams: true, images: false, maths: false }`. Missing keys take their defaults; unknown keys are kept on save.
- **Measure:** 760 px (Live Preview `.cm-content`), side padding 40 px (Live Preview) and 28 px (Split pane).
- **Notes are never written.** Widths live in `.nimw/vault.json` and settings.
- **Safari 15 floor:** no regex lookbehind, `color-mix`, `structuredClone`, `Array.at`, `Object.hasOwn`, container units or `:has()` (see `jsCompat.test.ts`, `cssCompat.test.ts`).
- **i18n:** en and es, ICU plurals; axe clean in light and dark.
- **Commits and tooling:**
  - every commit is signed and ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - `CARGO_TARGET_DIR=$SP/m4b3-d-target`;
  - Node 24 (`$HOME/.nvm/versions/node/v24.21.0/bin`);
  - vitest `--maxWorkers=2`.

## Review Focus

1. **A wide table while the cursor enters it** (raw lines showing). The raw lines use the same wide box, so the caret lands where clicked and nothing jumps sideways. This is checked in e2e by clicking into the table and typing.
2. **A narrow editor** (outline open, small window) where the wide box would be narrower than the measure. Wide elements must never be narrower than the text or overflow the scroller. `--nimw-wide-max` is clamped to the content box, and unit-tested through `wideMax()`.
3. **Line numbers on** (the gutter beside the measure). The wide box is centred on the text column and stays clear of the gutter. Covered by the `wideMax()` maths (gutter subtracted) and by the e2e geometry check with line numbers on.
4. **A table with a long URL in a cell.** No mid-word split; the wrapper scrolls and becomes a focusable region. Covered by a component test with mocked overflow, and an e2e in Readable.
5. **Full and Source unchanged; Split pane with no measure.** Wide must not change Full or Source. Covered by e2e assertions on Full and by an Editor test that no `data-wide-*` is set unless the width is `wide`.

---

### Task 1: `wide` page width in Rust (vault, commands, app settings)

**Files:**
- Modify: `crates/nimw-vault/src/page_width.rs`
- Modify: `apps/desktop/src-tauri/src/attachment_commands.rs` (`width_of`)
- Test: `crates/nimw-vault/tests/page_width.rs`, `apps/desktop/src-tauri/tests/commands.rs` (`m4b2_page_width_over_ipc`), `apps/desktop/src-tauri/tests/settings.rs` (`m4b2_page_width_setting_default_persist_and_reset` used `"wide"` as its unreadable example; it becomes `"huge"`)

**Interfaces:** Produces `nimw_vault::PageWidth::Wide`, serialised `"wide"`. `page_width_set` and `vault_settings_set` accept `"wide"`.

- [ ] **Step 1: Write the failing tests**
  - In `page_width.rs`: `m4b3_wide_round_trips_at_page_and_vault_level` sets `PageWidth::Wide` for a page and for the vault, then reads it back and checks `json["pageWidths"]["A.md"] == "wide"`.
  - In `commands.rs`: `page_width_set` with `"wide"` gives `pageWidths: { "Welcome.md": "wide" }`; `vault_settings_set` with `{ pageWidth: "wide" }` gives `pageWidth: "wide"`.
  - In `settings.rs`: an update to `PageWidth::Wide` persists as `"wide"`; the unreadable example becomes `"huge"`.
- [ ] **Step 2: Run them to verify they fail.** Run `cargo test -p nimw-vault --test page_width` and `cargo test -p nimw-desktop --test commands m4b2_page_width --test settings m4b2_page_width`. Expected: they don't compile (no `PageWidth::Wide`).
- [ ] **Step 3: Implement**
  - Add `Wide` to the enum (doc: "Text at the readable measure; chosen elements span the editor") and `"wide"` to `as_str`.
  - Add `Some("wide") => Ok(Some(PageWidth::Wide))` to `width_of`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(vault): a third page width, wide (M4b part 3 wide elements §2)`.

### Task 2: `wideElements` app setting (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/settings.rs` (struct `WideElements` with `#[serde(default)]` and a flattened `extra` map; `Settings.wide_elements`; `SettingsPatch.wide_elements`; `field!("wideElements", wide_elements)`; applied in `update`)
- Test: `apps/desktop/src-tauri/tests/settings.rs`

**Interfaces:** Produces `settings.wideElements` in `settings_get` / `settings_set` with the camelCase keys `tables`, `code`, `diagrams`, `images`, `maths`.

- [ ] **Step 1: Write the failing test** `m4b3_wide_elements_defaults_missing_keys_and_unknown_keys`:
  - the defaults are `tables` and `diagrams` on;
  - a file holding `{"wideElements":{"code":true,"future":1}}` reads as code on, tables and diagrams on (defaults), and keeps `future` after an update;
  - a patch replaces the five booleans.
- [ ] **Step 2: Run it to verify it fails** (`cargo test -p nimw-desktop --test settings m4b3`). Expected: it doesn't compile.
- [ ] **Step 3: Implement** `WideElements` (Default as above, `extra: serde_json::Map` flattened), the field, the patch and the lenient parse.
- [ ] **Step 4: Run it to verify it passes.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(settings): wideElements, the kinds that go wide (M4b part 3 wide elements §2)`.

### Task 3: Types and stores (TS)

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts` (`PageWidth = 'readable' | 'wide' | 'full'`; `WideElements`; `Settings.wideElements`; `SettingsPatch.wideElements`)
- Modify: `apps/desktop/src/stores/settingsStore.ts` (default `wideElements`)
- Modify: `apps/desktop/src/stores/pageWidthStore.ts` (`set(path, width)`, `fallbackFor()`; `toggle` removed)
- Test: `apps/desktop/src/stores/pageWidthStore.test.ts`

**Interfaces:** Produces:
- `usePageWidthStore.getState().set(path: string, width: PageWidth | null): Promise<void>`. Choosing the fallback width clears the entry, as the toggle did (part 2 §10.2).
- `useWideElements(): WideElements`.
- `fallbackWidth(): PageWidth` (vault, else app).

- [ ] **Step 1: Write the failing tests:**
  - `set('A.md', 'wide')` stores `wide`;
  - `set('A.md', 'readable')` when the fallback is readable sends `null`;
  - `set('A.md', null)` sends `null`;
  - `widthFor` resolves `wide` at the vault and app levels.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** with `feat(page): page width store sets any of readable/wide/full`.

### Task 4: The header's width menu

**Files:**
- Create: `apps/desktop/src/features/page/WidthMenu.tsx`
- Modify: `apps/desktop/src/features/page/PageHeader.tsx` (replaces the toggle)
- Modify: `apps/desktop/src/app/icons.tsx` (if the icon needs states)
- Modify: `apps/desktop/src/theme/base.css` (`.nimw-menu [role='menuitemradio']` styles, separator)
- Modify: `apps/desktop/src/i18n/locales/en.json` and `es.json` (`page.width.*`)
- Test: `apps/desktop/src/features/page/WidthMenu.test.tsx`; the existing `PageView.test.tsx` toggle tests are updated to the menu.

**Interfaces:** Consumes `usePageWidth`, `usePageWidthStore.set`.

The menu button is `aria-haspopup="menu"`, `aria-expanded`, named "Page width", with a title naming the current width. The menu holds:
- three `menuitemradio` items with `aria-checked`;
- a separator;
- **Reset to default**, disabled (`aria-disabled`) when the page has no entry.

↑/↓/Home/End move, Enter or Space choose, Escape and Tab close and refocus the button, and a click outside closes it.

- [ ] **Step 1: Write the failing tests:**
  - the button opens the menu with the current width checked;
  - choosing Wide calls `page_width_set` with `wide`;
  - Reset clears the entry (`null`) and is disabled without one;
  - Escape refocuses the button;
  - ArrowDown moves the focus.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** (portal into `document.body`, fixed under the button and right-aligned to it, on the `.nimw-menu` styles).
- [ ] **Step 4: Run them to verify they pass**, together with the updated `PageView.test.tsx`.
- [ ] **Step 5: Commit** with `feat(page): the page width menu — Readable, Wide elements, Full width, Reset`.

### Task 5: Settings: the width choices and the Wide elements checkboxes

**Files:**
- Modify: `apps/desktop/src/features/dialogs/SettingsDialog.tsx`, `VaultSettingsSection.tsx`, the i18n files
- Test: `apps/desktop/src/features/dialogs/SettingsDialog.test.tsx`

**What changes:**
- Settings → Editor → Page width gains the **Wide elements** option.
- Below it, a fieldset titled **Wide elements** holds five checkboxes and a hint, "Used when a page's width is Wide elements".
- Settings → This vault's select gains **Wide elements**.

- [ ] **Step 1: Write the failing tests:**
  - the app select offers `wide` and writes it;
  - ticking **Code blocks** sends `wideElements` with `code: true` and the others unchanged;
  - the vault select offers `wide`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** with `feat(settings): Wide elements width and the kinds that go wide`.

### Task 6: Tables keep their words whole and scroll sideways

**Files:**
- Create: `apps/desktop/src/features/preview/TableScroll.tsx`
- Modify: `apps/desktop/src/features/preview/renderHast.tsx` (`table` → `<TableScroll>`), `Preview.module.css`, i18n (`preview.tableScroll`)
- Test: `apps/desktop/src/features/preview/TableScroll.test.tsx`

**How it works:**
- A `ResizeObserver` (and the first layout) compares `scrollWidth > clientWidth`.
- Only while the table overflows, the wrapper gets `role="region"`, `aria-label` and `tabIndex=0`.
- Cells use `overflow-wrap: break-word; word-break: normal`.

- [ ] **Step 1: Write the failing tests:**
  - a table renders inside a `[data-table-scroll]` wrapper;
  - with mocked `scrollWidth` 900 and `clientWidth` 400, the wrapper is a region named "Table, scrolls sideways" with `tabIndex` 0;
  - without overflow, it has no role and no tabindex.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass**, together with `Preview` and `renderHast` tests.
- [ ] **Step 5: Commit** with `fix(preview): table cells keep whole words; wide tables scroll in their own box`.

### Task 7: Live Preview: chosen elements escape the measure

**Files:**
- Modify: `apps/desktop/src/features/editor/widgets.tsx` (`PreviewWidget` gets a `kind`, set as `data-wide-kind` on its DOM)
- Modify: `apps/desktop/src/features/editor/livePreview.ts`:
  - `blockWidget(node, kind)`;
  - kinds: table → `table`, math → `maths`, a Mermaid code block → `diagrams`, a lone image embed → `images`;
  - code lines and the raw lines of a table being edited get `--nimw-ch` (their block's longest line, tabs as 4);
  - raw table lines get the line class `cm-nimw-tablesrc`.
- Create: `apps/desktop/src/features/editor/wideBox.ts` (`wideMax(scrollerWidth, gutterWidth, padding)`, `wideAttrs(width, kinds)`)
- Modify: `apps/desktop/src/features/editor/Editor.tsx` (host attributes; a `ResizeObserver` sets `--nimw-wide-max`)
- Modify: `apps/desktop/src/features/editor/Editor.module.css`
- Test: `apps/desktop/src/features/editor/wideBox.test.ts`, `livePreview.test.ts`, `Editor.test.tsx`

**CSS** (only under `.live[data-width='wide']`):
- **Widgets:** `width: max-content; min-width: 100%; max-width: var(--nimw-wide-max); position: relative; left: 50%; transform: translateX(-50%)`.
- **Lines:** `--nimw-w: clamp(100%, calc(var(--nimw-ch) * 1ch + 16px), var(--nimw-wide-max)); width: var(--nimw-w); margin-left: calc((100% - var(--nimw-w)) / 2)`.

- [ ] **Step 1: Write the failing tests:**
  - `wideMax(1200, 0, 40)` is 1120;
  - `wideMax(1200, 48, 40)` is 1072;
  - it is never below the content width;
  - `wideAttrs('wide', { tables: true, code: false… })` gives `{ 'data-wide-tables': '' }`, and is empty for readable and full;
  - Live Preview decorations: a table widget's DOM has `data-wide-kind="table"`, a Mermaid widget `diagrams`, a lone `![[x.png]]` `images`, a `$$` block `maths`, and a callout none;
  - a code block's lines carry `--nimw-ch: <longest>`;
  - the Editor host has `data-wide-tables` only when the width is `wide` and tables are on.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass**, together with the whole editor folder.
- [ ] **Step 5: Commit** with `feat(editor): wide elements escape the readable measure in Live Preview`.

### Task 8: e2e in Chromium and WebKit

**Files:**
- Create: `apps/desktop/e2e/m4b3-wide.spec.ts` (the seven-column "Military Ranks" table)
- Modify: `apps/desktop/e2e/ipcMock.ts` (`vault_settings_set` records `pageWidth`, if needed)

**Tests:**
- **Readable:** no table cell breaks a word (each cell's words are each on one line: `Range.getClientRects()` per word yields one rect). The wrapper scrolls when the window is narrow.
- **Wide elements** through the header menu:
  - the table widget's box is wider than 760 px and centred on the text column;
  - a paragraph's `.cm-line` stays ≤ 680 px (the 760 measure minus padding);
  - clicking into the table and typing works.
- **Tables unticked** in Settings: the table returns to the measure.
- **Full:** unchanged (`.cm-content` > 760).
- **With line numbers on:** the widget's left edge is right of the gutter.
- **axe** with the menu open, light and dark.

- [ ] **Step 1: Write the tests;** run them against the built UI to see what fails before the CSS is right.
- [ ] **Step 2: Make them pass** in both browsers.
- [ ] **Step 3: Commit** with `test(e2e): wide elements and whole-word tables in Chromium and WebKit`.

### Task 9: Spec amendments, then the gate

- [ ] Append §6, "Amendments from planning", to the wide-elements spec.
- [ ] Run `LOGS=$SP/logs/m4b3-d CARGO_TARGET_DIR=$SP/m4b3-d-target $SP/check.sh all <worktree>`. Expected: ALL-OK.
- [ ] Commit with `docs: wide elements — plan as run and spec amendments`.

---

## Execution record

FILL as tasks complete.
