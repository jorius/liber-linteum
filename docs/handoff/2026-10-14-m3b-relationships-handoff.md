# M3b — Global View: relationships and index notes: Hand-off

**Spec:** `docs/superpowers/specs/2026-10-14-m3b-relationships-design.md` (§9: decisions taken for the maintainer without review; §10: amendments from planning; §11: amendments from the final review) · **Plan:** `docs/superpowers/plans/2026-10-14-m3b-relationships.md` (replayed end to end on a scratch clone)
**Branch:** `feat/m3b-relationships`, **stacked on `feat/m3a-global-view`**, which is stacked on `feat/m2c-page-extras`. Merge in order: M2c → M3a → M3b. Previous hand-off: `docs/handoff/2026-10-14-m3a-global-view-handoff.md`.

**How this milestone was made:**
- It was designed, planned and built after the maintainer asked for the remaining features to be built and reviewed in bulk later.
- **Grounding:**
  - the product spec GV-02 and GV-22–24 (all DECIDED);
  - architecture §3.3 and §4.4;
  - the prototype's connect flow.
- **Every judgement call** is in spec §9–§11 and summarised in §8 below.

## 1. Status at a glance

| Area | State |
|---|---|
| Connect two cards: drag from the connect handle, or the card menu → Connect to… → a card (click or keyboard); folders stand for their index note | done, tested |
| Relationships dialog: label (≤ 40), arrow, delete; opened from a card's menu or by clicking a direct relationship edge | done, tested |
| Writing `related:` in the source page: string or one-line flow map, byte-minimal, read back or refused; open pages undoable through the editor, closed pages written against their hash with one retry | done, tested |
| Index note pick for folders without a named/`index.md` note (`.liber/vault.json` `indexPicks`, follows renames) | done, tested |
| Scalar `related: "[[X]]"` indexed by Rust (TS parity) | done, tested |
| Safari 15: no `color-mix()` (generated sidebar shades and backdrops), React Flow click-to-connect `structuredClone` path off | done, tested (CSS guard) |
| Final review (opus) + fix pass (§13): 4 Important, 17 upgraded minors fixed test-first | done |
| Real-window checks (§9) | **need you** |

Totals after the fix pass: **766 vitest tests (77 files)**, **97 Playwright tests** (Chromium + WebKit) + 4 opt-in perf probes, **261 cargo tests** (256 + 5 main-thread menu checks; 2 release-only perf tests ignored in debug); eslint, prettier, tsc, i18n parity, clippy `-D warnings`, rustfmt and `cargo deny` clean.

## 2. How to run

| What | Command (repo root) |
|---|---|
| Everything (CI gate) | `pnpm check` |
| UI unit tests | `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2` |
| E2E | `pnpm test:e2e` |
| Regenerate palette CSS | `pnpm --filter @liber/desktop gen:palettes` |
| App (dev) | `pnpm dev` (Rust changed: restart) |

## 3. Backend map

| File | What it does |
|---|---|
| `crates/liber-markdown/src/frontmatter.rs` | scalar `related:` indexed (string or map) |
| `crates/liber-vault/src/{vault,layout}.rs` | `set_index_pick`, `remap_index_picks_many` (picks follow renames) |
| `crates/liber-session/src/global_view.rs` | `IndexFrom` (`named`/`index`/`picked`/`only`), `index_pick_set`, `link_target` |
| `apps/desktop/src-tauri/src/gv_commands.rs` | commands `link_target(source, target)`, `index_pick_set(folder, page?)` |

## 4. Frontend map (`apps/desktop/src/`)

| File | What it does |
|---|---|
| `markdown/related.ts` | read, append, edit and delete `related:` items (byte-minimal, read-back guard), on top of `frontmatterEdit.ts` helpers |
| `stores/relations.ts` | the write path: `editorStore.editPage` for pages with a live document, CAS for others, one retry, toasts |
| `features/global-view/CardMenu.tsx` | the connect button's menu: Connect to…, Relationships…, Pick index note… |
| `features/global-view/Canvas.tsx`, `gvStore.ts`, `GlobalView.tsx` | connect mode (status bar, Escape), drag-connect (`onConnect` + the card under the pointer) |
| `features/global-view/edges.tsx` | clickable direct relationship edges (invisible 14 px `nopan` hit stroke) |
| `features/global-view/RelationsDialog.tsx`, `IndexPickDialog.tsx` | the dialogs |
| `theme/color.ts`, `paletteCss.ts` | `alpha()`; sidebar and backdrop tokens |

## 5. Flows

- **Connect:**
  1. A drag from the handle, or connect mode then a click/Enter, gives `pageOf(source)` and `pageOf(target)`; a folder resolves to its index note.
  2. `link_target(source, target)` returns the shortest unique wiki target.
  3. `relations.relate` appends `"[[target]]"` through `editPage` (open page: undoable) or CAS (closed page).
  4. The session reindexes, the Global View re-fetches edges, and a toast confirms.
- **Edit/delete:**
  1. The dialog lists the page's own items.
  2. Save calls `updateRelated(index, {label, directed})` and Delete calls `removeRelated(index)`.
  3. A list that changed under the dialog is refused, and the dialog re-reads.
- **Pick:** Pick index note… opens the dialog; choosing a page calls `index_pick_set(folder, page)`; `vault.json` is written atomically and the card re-reads.

## 6. Recipes

- **Add a field to relationship items** (e.g. a colour): extend `related.ts` (the read, update and read-back guard), the Rust `related_link` parser, the dialog, and the edge rendering.

## 7. Tests inventory

| Layer | Files |
|---|---|
| Rust | `crates/liber-markdown` frontmatter unit tests (scalar `related:`, single-quoted links), `crates/liber-session/tests/global_view.rs` (index picks: set/validate/follow renames/leave the folder; folder relationships are direct edges; `link_target`), `apps/desktop/src-tauri/tests/commands.rs` (`link_target`, `index_pick_set` real ACL) |
| TS | `markdown/related.test.ts` (forms, comments, null, quoting, a sweep of shapes × edits: exact read-back or refusal), `stores/relations.test.tsx` (open page undoable, background page live text, CAS retry, duplicates, pending saves, unlinkable names), `features/global-view/{Connect,RelationsDialog,IndexPickDialog,GlobalView.edges}.test.tsx` (connect by drag/click/keyboard, Escape everywhere, focus return, corner cases, dialogs, memoised hits, `connectOnClick` pin), `theme/cssCompat.test.ts` (no `color-mix(`) |
| E2E | `e2e/m3b.spec.ts`: connect by click, keyboard and drag (incl. drops on header/footer), edit/delete from the edge, folder↔folder edge, pick an index note, focus after menu dialogs, menu inside the landmark + axe, zero-network |

## 8. Decisions taken for you (review in bulk)

From spec §9:
- Two ways to connect: drag and click/keyboard.
- A folder stands for its index note; without one, you're offered Pick index note….
- The arrow goes from source to target only.
- No undo for relationships written to pages that aren't open; delete is one click away.
- Picks only apply where rules 1–2 give nothing.
- Labels are capped at 40 characters.
- Writes always use the block-list form.
- The Safari 15 cleanup rides along.

From spec §10:
- Clicking an edge opens a modal dialog, not a popover; aggregated edges aren't clickable.
- A page's dialog lists only its own entries.
- The menu lives on the connect button.
- Map items are written as one-line flow maps.
- A list that changed under an edit is refused and re-read.
- `editPage` handles open documents; CAS handles the rest.
- Sidebar rows use the same 12% hover shade as the icon buttons.

From spec §11 (final review):
- **Map items are edited in place.** Other keys, comments and block style are kept; non-string labels keep their type.
- **Comments:**
  - one comment on a rewritten `related:` line moves to that line;
  - comments inside a multi-line flow list refuse the edit;
  - `related: ~` / `null` count as empty.
- **Names a link can't hold** (`# | ^ [ ]`, or both kinds of quote) are refused with a toast. Links holding `"` are single-quoted.
- **Duplicates** are re-checked inside the edit. Background pages are read from their live documents.
- **Toasts:** "Relationship created." only once it's on disk; "Relationship added; saving…" while the save retries.
- **Index picks** hold only while the page sits directly in the folder.
- **Folder relationships:** page↔folder and folder↔folder relationships are direct, clickable edges.
- **Focus:**
  - the card's connect button gets focus back after the menu's dialogs;
  - Escape leaves connect mode from anywhere;
  - a drop anywhere on a card counts.
- **Connect mode:**
  - it ends when the view goes, and when its source card leaves the canvas;
  - a click on an edge leaves connect mode, then opens the edge;
  - a slow double click in connect mode only connects.
- **Menu:** it lives inside the Global View landmark and closes on pan, zoom or level change.
- **Relationships dialog:** Close saves pending edits; Escape discards them, and the dialog says so.
- **A single-page folder's pick dialog** preselects that page.

## 9. Needs the real window (you)

1. Drag from a card's connect handle to another card (trackpad and mouse); the connection line and the new edge.
2. Card menu → Connect to… → arrows → Enter; Escape anywhere leaves connect mode.
3. Click a relationship edge → set a label and an arrow → Done; the frontmatter shows the flow map; Obsidian reads it.
4. Connect two project cards (via their index notes): the edge is direct and clickable.
5. Pick an index note for a folder without one; rename or move that page out of the folder.
6. Sidebar hover and dialog backdrop shades in a few palettes, light and dark (they're now generated tokens).
7. A page open in the editor with unsaved typing: connect it from the Global View, go back, and ⌘Z undoes only the relationship.

## 10. Known gaps / deferred

| # | Gap | Target |
|---|---|---|
| a | M2c's `[[` autocomplete still inserts `[[C# notes]]` for pages whose names hold `# \| ^` (the relationship path refuses them) | later (editor) |
| b | The card menu is placed once; it closes on pan/zoom rather than following the card | later |
| c | Relationships written to pages not open in the editor have no undo (by design, §9.4) | — |
| d | Pages whose names hold `# \| ^ [ ]` can't be related from the Global View until renamed | by design |

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| "Edit it in Source mode" toast when connecting | the page's `related:` uses a form the guard refuses (block scalar, comments inside a flow list): edit it in Source |
| A relationship didn't appear | check the toast: the page changed on disk twice in a row, or its name contains `#`, `\|` or `^` |
| `read fixture dir: NotFound` in cargo tests | a test binary was built in a removed worktree: `cargo clean -p liber-testkit -p liber-desktop -p liber-session -p liber-vault -p liber-index -p liber-markdown` |

## 12. Next steps

1. Your real-window checks of M2c → M3a → M3b, then the local merges in that order.
2. **M4, block moves (drag-and-drop reordering),** is being prepared on a branch stacked on this one. Spec: `docs/superpowers/specs/2026-10-14-m4-block-moves-design.md`.

## 13. Final review and fix pass

**Reviewer:** Opus, fresh context, on `1ee7294..05d2174`. Report: `.superpowers/sdd/2026-10-14-m3b-relationships/final-review.md`, git-ignored and deleted when the branch merges, so the table below is the record.
- **Verdict:** ready after fixes, with 0 Critical, 4 Important and 17 Minor findings.
- **The plan's five Review Focus items held**, apart from I1/I2 and m1/m3.
- **Re-grading:** re-graded by effect, all 17 minors joined the fix pass. Fixes ran in two parallel worktrees (data/backend and UI/focus), were cherry-picked with no conflicts, and every fix has a test that failed first.

| # | Finding | Fix | Test(s) |
|---|---|---|---|
| I1 | Editing a label/arrow silently dropped the item's other keys and non-string labels | edit `label`/`directed` in place; keep everything else | `related.test.ts` (+ sweep shapes), `relations.test.tsx` |
| I2 | Focus fell to `<body>` after the menu's dialogs and the toast action | return focus to the connect button first; `Dialog.returnFocus` | `Connect.test.tsx` ×3, e2e |
| I3 | Relationships between folder cards drew as non-clickable "inside folders" edges | page/index-note ends make a direct edge | Rust `m3b_relationships_of_folder_cards_index_notes_are_direct_edges`, `GlobalView.edges.test.tsx`, e2e |
| I4 | An index pick followed its page out of the folder | picks valid only for direct pages; dropped on remap | 3 session tests (in-app, external, hand-written) |
| m1–m17↑ | comments, drops on header/footer, Escape, unlinkable names, stale re-read, pending toast, duplicates, connect corner cases, menu landmark, live region, `related: ~`, label field, Close/Escape semantics, single-page pick, `connectOnClick` pin, memoised hits, nits | one commit each | listed in the ledger; all RED → GREEN |
