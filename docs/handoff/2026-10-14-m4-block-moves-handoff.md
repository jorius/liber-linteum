# M4 — Block moves: Hand-off

**Spec:** `docs/superpowers/specs/2026-10-14-m4-block-moves-design.md` (§9: decisions taken for the maintainer without review; §10: amendments from planning; §11: amendments from the final review) · **Plan:** `docs/superpowers/plans/2026-10-14-m4-block-moves.md` (replayed end to end on a scratch clone)
**Branch:** `feat/m4-block-moves`, stacked on `feat/m3b-relationships` ← `feat/m3a-global-view` ← `feat/m2c-page-extras`. Merge in order: M2c → M3a → M3b → M4. Previous hand-off: `docs/handoff/2026-10-14-m3b-relationships-handoff.md`.

**How this milestone was made:**
- **Designed and built in bulk:** the design, the plan and the build all happened after the maintainer asked for the remaining features to be built and reviewed in bulk later. The grounding was the product spec §8 (DND-01–08, all DECIDED), architecture §4.3, and the prototype's Split-pane gutter.
- **Fixes landed late:** 1Password locked partway through the final-review fix pass. The fixes were kept as verified patch series and landed as signed commits once it was unlocked; the landed tree is byte-identical to the combined tree tested beforehand.

## 1. Status at a glance

| Area | State |
|---|---|
| Block model: headings with their sections, paragraphs, lists, single list items (nested), quotes/callouts, code, table body rows, embeds, HTML blocks, columns, rules; drop slots | done, tested |
| Moves: one CodeMirror transaction (one ⌘Z), bytes kept except list indentation/numbering and blank lines; heading sections (Alt = line only); list items across levels and lists; table rows | done, tested (sweep of every unit × every slot, plus the reviewer's fuzz: ~82k moves) |
| The guard: windowed re-parse comparing block texts, containers, list parents, task states, `%%` pairs and the front-matter head; refuses with "This block can't be moved here." | done, tested |
| Split gutter: grip, Move up/down, Indent/Outdent, keyboard pick-up, pointer drag with drop line, auto-scroll, Escape, live-region announcements, one-time hint | done, tested (axe light+dark) |
| Editor: Alt+↑/↓ moves the heading section, list item or table row holding the cursor (elsewhere it's CodeMirror's line move) | done, tested |
| Final review + fix pass (§13) | done |
| Real-window checks (§9) | **need you** |

Totals: **901 vitest tests (87 files)**, **124 Playwright tests** (Chromium + WebKit) + 8 opt-in perf probes (`LIBER_PERF=1`), **261 cargo tests** (256 + 5 menu checks; Rust unchanged in M4); eslint, prettier, tsc, i18n parity, clippy, rustfmt and `cargo deny` clean.

## 2. How to run

| What | Command (repo root) |
|---|---|
| Everything | `pnpm check` |
| UI unit tests | `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2` |
| E2E | `pnpm test:e2e`; perf probes: `LIBER_PERF=1 pnpm test:e2e` |
| App (dev) | `pnpm dev` |

## 3. Map (`apps/desktop/src/`)

| File | What it does |
|---|---|
| `markdown/blockModel.ts` | units, sections, list parents, table rows, `%%` comments, slots; neighbours for Move up/down and indent |
| `markdown/blockMoves.ts` | `planMove` (the source edits) and `moveBlock` (the edits plus the guard); list re-indentation and renumbering; row moves; refusals |
| `markdown/parse.ts`, `markdown/incremental.ts` | `hasFrontmatter` (front matter only when the note opens with a closed `---` block); incremental re-parse fixes (front matter off for slices, fallbacks after indented code and before comment lines) |
| `features/editor/blockCommands.ts` | the model cache, `applyMove`, Alt+↑/↓ |
| `features/editor/blockMatch.ts` | finds a picked block and its slot again in the editor's current text (the wrong block never moves) |
| `features/editor/BlockGutter.tsx` | the gutter: hover/focus, buttons, keyboard pick-up, pointer drag, live region |
| `features/editor/SplitHint.tsx` | the one-time hint (dismissal in `localStorage`) |
| `jsCompat.test.ts` | guard: no API newer than Safari 15.0 in the app's TypeScript |

## 4. Flows

- **Drag:**
  1. Pressing the grip and moving 4 px starts the drag; a drop line follows the nearest slot (for list levels, the pointer's x position picks the level).
  2. On drop, `blockMatch` re-finds the unit and slot in the current text. If either is gone, the drop is cancelled with "That block changed, so it wasn't moved. Try again."
  3. `moveBlock` plans the edits and runs the guard: if the guard accepts, the edits go into one transaction; if not, the "can't be moved here" toast shows.
  4. The pane re-renders at once, the moved block flashes, and the live region says where it went.
- **Keyboard:**
  - **In the pane:** one tab stop moves between blocks with ↑/↓. Enter picks a block up, arrows choose a slot, Enter drops, and Escape or Tab cancels.
  - **In the editor:** Alt+↑/↓.

## 5. Decisions taken for you (review in bulk)

From spec §9:
- **Drag mechanics:** pointer events, not HTML5 drag-and-drop.
- **Keys:** Alt+↑/↓ moves blocks; list indentation stays on Tab/⇧Tab in the editor and Alt+→/← on the gutter.
- **List items** dropped at the top level become one-item lists.
- **Quotes and callouts** move as a whole.
- **Only blank lines, list indents and numbers change.**
- **The hint bar** shows once.
- **Live Preview** gets keyboard moves only, with no drag gutter.

From spec §10:
- **Guard windows:** the guard re-parses windows around each edit, not the whole note.
- **Markers:** items take the marker of the list they join; renumbering happens only for sequential lists.
- **No slots that merge lists.**
- **Hover** shows the deepest block's gutter.
- **Buttons** open on hover or focus.

From spec §11 (final review):
- **Refused moves:**
  - a move that would give the note a front-matter head it didn't have (a leading `---` … `---`/`...`);
  - moves that change which item holds a list item;
  - moves that would re-pair `%%` comments.
- **Table rows:** the header and delimiter rows don't move with Alt+↑/↓.
- **BOM files:** positions stay exact, and overlapping edits are refused.
- **HTML blocks** are no longer wrapped, so `<details>` collapses again.
- **Finding the block again:** drops and buttons re-find their block in the current text; keyboard keys wait while the pane lags.
- **Safari 15:** no API newer than Safari 15.0 anywhere in the app's TypeScript (guard test).

## 6. Needs the real window (you)

1. Split: hover a block, drag a paragraph above another, then ⌘Z once restores it.
2. Drag a heading: its section moves. Hold Alt at the drop to move the heading line only.
3. Drag a list item one level deeper and back; numbered lists renumber.
4. Keyboard only: focus a grip, Enter, arrows, Enter; and Alt+↑/↓ in the editor.
5. Typing in Split on a long note feels instant.
6. Drag feel with a trackpad and with a mouse; auto-scroll speed near the pane's edges.
7. A note starting with `---` used as a horizontal rule: it still shows its lists and quotes, and a move never turns text into front matter.
8. VoiceOver reads the "Moved X after Y" announcements.

## 7. Known gaps / deferred

| # | Gap | Target |
|---|---|---|
| a | The first move in a large note parses it fully on the main thread (~360 ms at 200 KB in Node; later moves 1–8 ms) | later perf |
| b | An edit next to a `%%` comment, or in the first block of a BOM file, makes the next model update a full parse (~350 ms at 200 KB) | later perf |
| c | Drag handles in Live Preview | out of scope (DND-01) |

## 8. Final review and fix pass

**Reviewer:** Opus, fresh context, on `c307c86..3aa7972`.
- **Verdict:** not ready, with 2 Critical, 4 Important and 8 Minor findings; 7 minors joined the fix pass and M6 was deferred.
- **The good news:** about 170k fuzzed moves on ordinary notes lost or duplicated no text.
- **Fixes:** two parallel agents (engine/guard, gutter/render/perf). Every fix has a test that failed first.

| # | Finding | Fix |
|---|---|---|
| C1 | A move could turn note text into front matter (a `---` rule becoming the first line) | refuse a new front-matter head; parse front matter only when the note opens with a closed block |
| C2 | The wrong block could move (pane model vs editor model; text changing mid-drag; an incremental re-parse bug below `---`) | re-find unit and slot in the current text (`blockMatch`); incremental re-parse fixed (chain fuzz: 0 divergences) |
| I1 | `<details>` stopped collapsing (HTML blocks wrapped in a `div`) | no wrapper; positions carried through `raw()` |
| I2 | Typing in Split stalled on large notes (200 KB: 340–400 ms frames) | linear block→element mapping: back to M3b levels (WebKit 34–38 ms) |
| I3 | The guard couldn't see list nesting | list parents in the guard signature |
| I4 | BOM files broke moves | exact positions; overlapping edits refused |
| M1–M8↑ | `%%` re-pairing, drag cancel/capture loss/leaked listeners, table header Alt+↑/↓, whitespace-only code lines, "after Y" announcements, Safari 15.0 APIs (guard test), the hidden gutter grabbable; plus two bugs found by the fix agents (gutter crash after deleting blocks above, grip unreachable across the 4 px gap) | one commit each, RED → GREEN |
