# M4b, part 3 — Stream B: Covers and titles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A page's title is an H1 on its first line, else its file name (§1).
- The editor's cover crops where it was placed in WebView2 as in WebKit (§2, the editor side).
- A cover can sit on top, or as a tall strip on the left or right that you resize and reposition in both axes; Global View cards learn where it sits (§3).

**Architecture:**
- **Rust:**
  - `nimw-markdown::title` takes an H1 only when it is the body's first block;
  - the frontmatter gains `cover-x` (beside `cover-y`), indexed in `pages.cover_x` (index schema v2, so titles re-extract);
  - `.nimw/vault.json` gains `coverSides` / `coverWidths` (`nimw-vault::cover_side`), remapped and forgotten through the cover-height choke points;
  - `cover_side_set` / `cover_width_set` commands;
  - `GvCard` carries `cover_x` and `cover_side`.
- **Frontend:**
  - `coverLayoutStore` (placements and widths, optimistic, race-guarded);
  - `Cover` lays the page out as a row: an optional strip beside a main column (band, notices, editor) that never moves in the tree;
  - `useCoverWidthResize` is the strip edge, the twin of `useCoverResize`;
  - placement changes join the editor's undo history through an effect-only CodeMirror entry (`coverSideHistory`).

**Tech Stack:**
- React 19 + TS, zustand, CodeMirror 6 (`invertedEffects`, `isolateHistory`);
- Rust (`nimw-markdown`, `nimw-index`, `nimw-vault`, `nimw-session`, Tauri commands);
- Vitest (jsdom), Playwright (Chromium + WebKit).
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-m4b-part3-design.md`, §1, §2 (editor side) and §3. Its §13 records this stream's amendments.

**How this plan was made:**
- **Run as written.** It ran task by task, TDD, in a worktree branched from `feat/m4b3-feedback` at `5640fb7`, on the branch `feat/m4b3-covers`. Every step below ran; each task names its signed commit.
- **Code shown.** The steps show the key code; the rest is in the commit.

## Global Constraints

- **Notes are never written** for placement or width: `.nimw/vault.json` only. Notes carry only the focus point (`cover`, `cover-y`, `cover-x`).
- **Every new Tauri command** needs:
  - `build.rs` COMMANDS, `generate_handler!`, `capabilities/main.json` `allow-…` and the `tests/commands.rs` COMMANDS list;
  - a real-ACL test (main window only);
  - async through `blocking()`.
- **Safari 15 floor** (`jsCompat`/`cssCompat`):
  - no `.at()` / `Object.hasOwn` / `structuredClone` in app TS;
  - focus rings keep a `:focus` fallback beside `:focus-visible`;
  - `ResizeObserver` is guarded.
- **Accessibility:**
  - keyboard parity (the placement radio group, the width separator, the 2-axis slider);
  - focus never lost when the controls move between the band and the strip;
  - axe-clean in light and dark.
- **i18n:** en + es under the existing `cover.*` namespace; `pnpm check:i18n`.
- **Zero network:** every e2e checks requests and CSP violations.
- **Scratch builds:** `CARGO_TARGET_DIR` per worktree (fixture paths are baked into test binaries).

## Review Focus

- **A note whose only H1 is a section halfway down** (the friend's "Tipos de comisiones"): the title is the file name everywhere. *Rust unit + e2e.*
- **Switching placement while focus is on a placement radio:** the group moves between the band and the strip, and focus follows. *Vitest.*
- **A window narrowed below strip + 520 px:** the cover goes on top without saving anything, and the strip comes back on widening. *Vitest with a fake ResizeObserver, plus e2e.*
- **⌘Z right after choosing a placement:** it puts the previous one back, and redo restores it. The entry never merges with typing (`isolateHistory`). *Vitest.*
- **The WebView2 asset path (`http://nimw-asset.localhost`):** the band and strip images fill their frames exactly, so `object-position` crops. *e2e with a Windows UA and a routed SVG.*

---

### Task 1: Titles follow a first-line H1 (§1) — `dffd1ed`

**Files:**
- Modify: `crates/nimw-markdown/src/title.rs`, `crates/nimw-index/src/schema.rs` (v2), `crates/nimw-index/tests/index.rs`.
- Modify (fakes): `apps/desktop/src/test/fakeDisk.ts`, `apps/desktop/e2e/ipcMock.ts`.

- [x] **Step 1: Failing tests** in `title.rs`:
  - `pg_01_first_h1_anywhere_in_the_page` is replaced by `pg_01_an_h1_after_other_blocks_is_not_the_title` (a paragraph, an embed or an HTML comment first gives the stem);
  - `pg_01_an_h1_after_frontmatter_and_blank_lines_is_the_title`;
  - `pg_01_a_section_heading_halfway_down_is_not_the_title` (the friend's note gives "Tipos de comisiones");
  - `pg_01_a_setext_h1_at_the_top_is_the_title`.
- [x] **Step 2:** `cargo test -p nimw-markdown --lib title`. Expected and seen: 3 FAIL (`left: "Real Title"`, `left: "WIP (Work In Progress):"`).
- [x] **Step 3: Implement.** Skip the metadata block. The first H1 may open; an empty H1 is skipped. Any other block start (`Start(_)`, `Rule`, `Html`) breaks to the stem:

```rust
Event::Start(Tag::MetadataBlock(_)) => in_meta = true,
Event::End(TagEnd::MetadataBlock(_)) => in_meta = false,
_ if in_meta => {}
Event::Start(Tag::Heading { level: HeadingLevel::H1, .. }) if !in_h1 => { in_h1 = true; text.clear(); }
Event::End(TagEnd::Heading(HeadingLevel::H1)) => { /* non-empty → return */ }
// …text, code, breaks collected while in_h1…
Event::Start(_) | Event::Rule | Event::Html(_) if !in_h1 => break,
```

- [x] **Step 4:** `cargo test -p nimw-markdown`. Expected and seen: 41 pass, including the existing `pg_01_empty_h1_is_skipped`.
- [x] **Step 5: Migration.** Test `an_index_from_before_the_title_rule_is_rebuilt`: an index whose meta says `schema_version = 1` opens empty. It failed against v1. Then `SCHEMA_VERSION = 2`, and it passes.
- [x] **Step 6:** The fakes read titles the same way: `/^(?:---\n[\s\S]*?\n---\n)?\s*# ([^\n]+)/`. `cargo test --workspace` and the full vitest run stay green (1174).
- [x] **Step 7:** Commit.

### Task 2: `cover-x`, indexed, on pages and cards (§3) — `7002e2f`

**Files:**
- `nimw-markdown`:
  - `frontmatter.rs` (`cover_x`, and a shared `percent()` for `cover-y` and `cover-x`);
  - `types.rs`, `page.rs`;
  - test `frontmatter_api.rs`.
- `nimw-index`:
  - `schema.rs` (`pages.cover_x`);
  - `rows.rs`;
  - `index.rs`: `CARD_SELECT` and the page query append `cover_x` last, and `upsert_page` writes `?10`.
- `nimw-vault`: `cover_side.rs` (the `CoverSide` enum).
- `nimw-session`:
  - `global_view.rs`: `GvCard.cover_x`, and `cover_side: CoverSide` defaulting to `Top`;
  - tests `global_view.rs`, `open.rs`.
- Tauri:
  - `dto.rs`: `PageDto.coverX`; `GvCardDto.cover_x` and `cover_side: &'static str`;
  - `vault_commands.rs`;
  - test `commands.rs` (`coverX`, `coverSide`).
- TS:
  - `ipc/index.ts`: `CoverSide`, `Page.coverX`, `GvCard.coverX` and `GvCard.coverSide`, required as the spec names them;
  - the seven Global View card fixtures;
  - `fakeDisk.ts`, `ipcMock.ts`.

- [x] **Step 1: Failing tests:**
  - `cover_x_is_read_like_cover_y`: 30, 12.6 → 13, −5 → 0, 140 → 100, `left` → none;
  - `parse_page` gives `cover_x == Some(25)`;
  - the session's Welcome card has `cover_x == Some(70)`;
  - `rex.cover_x == None`;
  - over IPC, `page["coverX"]` is null and the card has `coverSide: "top"`.

  They failed to compile at first: the field didn't exist.
- [x] **Step 2:** Implement down the stack, as listed in Files.
- [x] **Step 3:** `cargo test --workspace` is green (43 suites). `pnpm typecheck` listed exactly the seven card fixtures, which gained `coverX: null, coverSide: 'top'`. Lint and typecheck are clean.
- [x] **Step 4:** Commit.

### Task 3: `coverSides` / `coverWidths`, the commands, the cards, the store (§3) — `be9b3ea`

**Files:**
- `nimw-vault`:
  - `cover_side.rs`: `cover_sides`, `cover_widths`, `set_cover_side` (Top clears), `set_cover_width` (clamped 160–2000), `forget_*` and `remap_*_many`;
  - `MIN_COVER_WIDTH` / `MAX_COVER_WIDTH` exported;
  - `tests/cover_side.rs`.
- `nimw-session`:
  - `follow_layout` and `forget_page_sizes` call the four new methods;
  - `gv_children` is now `level_cards`, followed by `place_cover` on every card (a folder card takes its index note's placement);
  - `index_pick_set` places its card too;
  - tests in `rename.rs`, `watching.rs` and `global_view.rs`.
- Tauri:
  - `attachment_commands.rs`: `cover_side_set_impl` (refuses unknown sides as `invalidName`), `cover_width_set_impl` (refuses non-finite widths);
  - `VaultSettingsDto` gains `cover_sides` and `cover_widths`;
  - registration in `build.rs`, `lib.rs`, `capabilities/main.json` and `permissions/autogenerated/*.toml`;
  - `tests/commands.rs`: `cover_side_and_width_over_ipc`, `cover_side_and_width_set_are_allowed_from_main_only`, and the M2c settings snapshot gains the two keys.
- TS:
  - `ipc/index.ts`: `coverSideSet`, `coverWidthSet`; `VaultSettings.coverSides` and `coverWidths`;
  - `stores/coverLayoutStore.ts` with its test;
  - i18n `cover.*`;
  - the e2e mock gets `cover_side_set` and `cover_width_set`, kept in sessionStorage and logged in `__nimwCoverSides`.

- [x] **Step 1: Vault tests.**
  - Nothing set writes nothing.
  - Values round-trip and keep other keys.
  - Clamps: 20 → 160, 90000 → 2000.
  - Malformed entries hide only themselves, and a hand-written `"top"` is dropped.
  - Entries follow renames and folder moves, and are forgotten with deleted pages and folders.

  Seen: they failed to compile. After implementing, 6 pass. One fix along the way: the update closure borrows `&value`, since it is `FnMut` and retried once.
- [x] **Step 2: Session tests.** The in-app rename test failed (`left: [("Game Design/Game 1.md", Right), ("Welcome.md", Left)]`). After wiring the choke points, both it and the watcher test pass.
- [x] **Step 3: Card test.** `cards_carry_the_cover_side_of_their_page` failed (`left: Top, right: Left`). After `place_cover`, 23 pass.
- [x] **Step 4: IPC tests.** Implement and register. `cargo test -p nimw-desktop --test commands cover_` passes 7. The full workspace run then showed the M2c exact settings snapshot needed the two new keys; after that, 40 pass.
- [x] **Step 5: Store test** (6 cases):
  - defaults;
  - an optimistic save, then `top` clears;
  - widths are rounded, and `null` clears them;
  - a failed save puts the previous value back and toasts;
  - a slow earlier reply never undoes a later choice;
  - 45% max.

  Pass.
- [x] **Step 6:** Clippy (`-D warnings`) flagged a constant `assert!(SCHEMA_VERSION >= 2)`. It was dropped: the v1 rebuild test already fails if the version is 1. `cargo fmt` applied. Commit.

### Task 4: The strip, its edge, 2-axis reposition, narrow fallback, undo (§3) — `1d2a8b5`

**Files:**
- Create:
  - `features/page/CoverWidth.tsx` (`useCoverWidthResize`);
  - `features/editor/coverSideHistory.ts`;
  - `features/page/CoverSide.test.tsx`.
- Modify:
  - `features/page/Cover.tsx`;
  - `PageHeader.tsx` (`children` → `Cover body`);
  - `PageView.tsx` (the notices and editor are passed as the header's children);
  - `PageView.module.css`;
  - `features/editor/Editor.tsx` (`coverSideHistory` in page states);
  - `app/icons.tsx` (`CoverTopIcon`, `CoverLeftIcon`, `CoverRightIcon`, `MoveIcon`).

- [x] **Step 1: Failing tests** in `CoverSide.test.tsx`:
  - the radio group, and Left makes a strip first in the layout with the band plain;
  - Right goes last, and Top restores the band;
  - one Tab stop, and the arrows move the choice;
  - the width edge: separator vertical, 160–460 in jsdom's 1024 px window, → on a left strip, Shift/End/Escape, pointer drag, double-click reset;
  - ← widens a right strip;
  - 2-axis reposition writes `cover-y: 35` and `cover-x: 30`;
  - a top cover shows a stored `cover-x` and ignores ←/→;
  - the narrow fallback with a fake ResizeObserver: 1200 → strip, 700 → top, 900 → strip, with no saves;
  - Ctrl+Z / Ctrl+Y undo and redo the placement;
  - axe.

  Seen: 9 of 10 fail. axe passes on the unchanged top layout.
- [x] **Step 2: Implement.**
  - `Cover` always renders the same tree:

```tsx
<div ref={layout} data-cover-layout className={styles.coverLayout}>
  {side === 'left' && stripNode}
  <div className={styles.coverMain}>{header}{body}</div>
  {side === 'right' && stripNode}
</div>
```

  - The main column keeps its child index, so the editor is never remounted.
  - Measuring and the fallback: `side = chosen !== 'top' && cover && (unmeasured || width − strip ≥ 520)`. A ResizeObserver reading of 0 is ignored.
  - The controls render in the band when the cover is on top, or at the strip's foot when it is on a side.
  - The placement group is a roving-tabindex radiogroup. A keyboard choice, or a click while the radio has focus, refocuses the chosen radio after the move.
  - Reposition holds a `{x, y}` draft:
    - ↑/↓ PageUp/PageDown change y; ←/→ change x on a side cover only;
    - the drag uses `object-fit: cover` overflow on both axes;
    - Save patches only the keys that changed.
  - Pick and Remove clear `cover-x` too.
  - Undo:

```ts
invertedEffects.of((tr) => tr.effects.filter((e) => e.is(sideChange))
  .map((e) => sideChange.of({ ...e.value, from: e.value.to, to: e.value.from })));
// undo/redo transactions re-save `to`; choosing dispatches the effect with
// annotations: isolateHistory.of('full'), userEvent: 'cover.side'
```

- [x] **Step 3:** First run: 9 pass. The undo test needed `.cm-content` (two textboxes exist) and Ctrl+Y for redo; CodeMirror's Mod-Shift-z is Mac/Linux only, and jsdom is neither. Then 10 pass. A focus assertion on the moved radio was added and passes.
- [x] **Step 4:** Prettier, typecheck, then full vitest: 106 files, 1190 tests green. Commit.

### Task 5: e2e in Chromium and WebKit — `a9d5b92`

**Files:** Create `e2e/m4b3-covers.spec.ts`. Modify `playwright.config.ts`: the WebKit project matches `m4b3-covers`.

- [x] **Step 1: Tests:**
  - Left gives a full-height strip at the area's left, 280 px, with the header and text to its right. Dragging the edge +60 makes it 340. Both survive a reload, and the note is not written.
  - A right strip is outermost (right of the outline).
  - 2-axis reposition: ← ↑ give `45% 55%`, and Save writes `cover-y: 55\ncover-x: 45`.
  - An 860 px window drops the strip; 1280 brings it back.
  - **The WebView2 crop path:** `test.use({ userAgent: WINDOWS_UA })`. Assets go to `http://nimw-asset.localhost/…`, and the test routes them to a 400 × 1200 SVG. The image box must equal its frame (the band, then the strip), with `object-position: 0% 100%` from `cover-x: 0` / `cover-y: 100`.
  - §1: no "Title in the note" on the friend's note.
  - axe light and dark on the strip and the band.
- [x] **Step 2: Run** (with `pnpm --filter @nimw/desktop build` first) on a private port copy of the config, so parallel streams don't collide on 4317.
  - Two fixes:
    - the text's left edge equals the strip's right edge (≥, not >);
    - axe is scoped to the strip and the band, because `.cm-scroller` is the editor's own, pre-existing issue. axe also waits until the strip's controls have finished fading in: WebKit measured mid-fade contrast.
  - Then the new spec passes 16 of 16, and 32 of 32 with `--repeat-each=2`. The whole suite: 196 passed, 8 skipped (opt-in perf).
- [x] **Step 3:** Commit.

### Task 6: Docs and the gate

- [x] This plan, and spec §13 (Stream B's amendments).
- [x] `LOGS=$SP/logs/m4b3-b CARGO_TARGET_DIR=$SP/m4b3-b-target $SP/check.sh all <worktree>` gives ALL-OK.
