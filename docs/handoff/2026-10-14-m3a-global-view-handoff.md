# M3a — Global View (browse, layout, edges): Hand-off

**Spec:** `docs/superpowers/specs/2026-10-14-m3a-global-view-design.md` (§12: decisions taken for Jose without review; §13: amendments from planning; §14: amendments from the final review) · **Plan:** `docs/superpowers/plans/2026-10-14-m3a-global-view.md` (replayed end to end on a scratch clone before execution)
**Branch:** `feat/m3a-global-view`, **stacked on `feat/m2c-page-extras`**. Merge M2c first, then this. Previous hand-off: `docs/handoff/2026-10-14-m2c-page-extras-handoff.md`.

**How this milestone was made.**
- The whole of M3a was designed after Jose asked to "carry on with everything that's missing" and review in bulk later.
- **The design rests on:**
  - the product spec §6 (every GV item was already DECIDED);
  - the architecture §4.4;
  - the clickable prototype (`design/prototype/Main.dc.html`, screen `global`), which was rendered and screenshotted to copy its values.
- **Every judgement call** is in spec §12–§14 and summarised in §8 below.
- **M3 is split:**
  - **M3a (this branch):** browsing, layout and edges;
  - **M3b (next):** creating and editing relationships, and picking a folder's index note.

## 1. Status at a glance

| Area | State |
|---|---|
| Edit / Global View switch (top bar, ⌘1 / ⌘2, View menu); the editor stays mounted, so undo and scroll survive | done, tested |
| Levels: vault (projects + root pages), folder (subfolders + pages), page neighbourhood (links, backlinks, relationships); attachment folders hidden; index-note rules GV-02 1–4 | done, tested |
| Cards matching the prototype (kind label, cover/placeholder/folder summary, title, subtitle, excerpt, image/audio icons, See all); new tokens for every palette and mode | done, tested (axe, contrast) |
| Drill-down with breadcrumb; Expand in place with collapse; single/double click (240 ms); keyboard (arrows, Enter, Shift+Enter, Escape) | done, tested |
| Edges: text links, parent/child, manual (read-only), aggregated to the nearest visible card with counts; four toggles saved in settings | done, tested (GV-25 acceptance) |
| Layout: deterministic grid / columns / neighbourhood (prototype values); dragged cards pinned per level in `.liber/layout.json` (lazy, atomic, follows renames); Reset layout; pan/zoom | done, tested |
| New entry → "Untitled" page in the current level's folder, opened with the title selected | done, tested |
| React Flow 12.12.0 under Tauri's frozen prototypes (d3-color fix as a Vite transform) | done, tested |
| Final review (opus) + fix pass (§13): 1 Critical, 6 Important, 14 upgraded minors fixed test-first | done |
| Real-window checks (§9) | **need you** |

Totals after the fix pass: **643 vitest tests (72 files)**, **76 Playwright tests** (Chromium + WebKit) + 4 opt-in perf probes, **248 cargo tests** (243 + 5 main-thread menu checks; 2 release-only perf tests ignored in debug); eslint, prettier, tsc, i18n parity, clippy `-D warnings`, rustfmt and `cargo deny` clean.

## 2. How to run

| What | Command (repo root) |
|---|---|
| Everything (CI gate) | `pnpm check` |
| UI unit tests | `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2` |
| E2E | `pnpm test:e2e` (browsers: `pnpm --filter @liber/desktop exec playwright install chromium webkit`) |
| Perf test (release, ignored in debug) | `cargo test --release -p liber-session --test global_view -- --ignored` |
| App (dev) | `pnpm dev` (Rust changed: restart) |

## 3. Backend map

| File | What it does |
|---|---|
| `crates/liber-index/src/{rows,index}.rs` | `CardRow`, `PageLink`; `card_children`, `card`, `page_links_of`, `page_links_from` (one indexed range per visible card) |
| `crates/liber-session/src/global_view.rs` | `gv_children` (levels, cards, index notes, attachment folders, neighbourhoods), `gv_edges` (lift to the nearest visible ancestor, aggregate, count), `follow_layout` on renames |
| `crates/liber-vault/src/layout.rs` | `.liber/layout.json`: `layout_level`, `set_layout_level`, `remap_layout` |
| `crates/liber-vault/src/{config,vault}.rs` | `indexPicks` (read in M3a, written in M3b); shared `.liber` JSON read-modify-write |
| `apps/desktop/src-tauri/src/gv_commands.rs` | `gv_children(level)`, `gv_edges(visible)`, `layout_get(level)`, `layout_set(level, positions)` |
| `apps/desktop/src-tauri/src/settings.rs` | `globalViewMode` (`drill`), `globalViewEdges` (all on) |
| `apps/desktop/src-tauri/src/menu.rs` | View → Editor / Global View (`menu:screen`, no accelerators) |

## 4. Frontend map (`apps/desktop/src/`)

| File | What it does |
|---|---|
| `features/global-view/layout.ts` | pure layouts (grid, columns, neighbourhood), pins, arrow-key geometry |
| `features/global-view/gvStore.ts` | drill stack, expansions, loaded levels, canvas, edges, pins (debounced saves), focus, `shownKey` |
| `features/global-view/Card.tsx` | a card; click timing; a11y description |
| `features/global-view/edges.tsx` | border-to-border edges, one stroke per kind, counts |
| `features/global-view/Canvas.tsx`, `Toolbar.tsx`, `GlobalView.tsx` | React Flow canvas, keyboard, zoom; breadcrumb, mode, toggles, Reset; New entry; refresh |
| `stores/uiStore.ts`, `navigate.ts`, `pageStore.ts` | `screen`; opening a page shows Edit; the title-focus request |
| `theme/paletteCss.ts`, `tokens.css` | `--color-canvas`, `--color-card-border`, `--color-edge-*` per palette |
| `scripts/freezeSafe.ts` | Vite transform: d3-color loadable under a frozen `Object.prototype` (build and dev pre-bundle) |

## 5. Flows

- **Open:**
  1. ⌘2 or the top bar sets `uiStore.screen = 'global'`, and `GlobalView` mounts (the editor stays mounted, hidden).
  2. `gvStore.load(level)` calls `gv_children` and `layout_get`, then `gv_edges(visible paths)`.
  3. `layout.ts` places the unpinned cards, and React Flow renders.
- **Drill:**
  1. A single click (after 240 ms) pushes the level onto the stack.
  2. The breadcrumb updates, the level loads, and the view fits once per loaded level (`shownKey`).
  3. Focus moves to the first card.
- **Expand:** a click adds the card's next level in the column to its right. A second click collapses it, with its descendants.
- **Pin:**
  1. Dragging by the grip saves the positions for the level key (debounced).
  2. `layout.json` is written atomically.
  3. Renames remap keys and entries in Rust: in-app at the rename choke point, external from the watcher.
- **Refresh:** a tree change, a page save or a vault event re-fetches the visible levels (debounced). A deleted level falls back to its nearest existing ancestor.

## 6. Recipes

- **Add an edge kind:** a Rust `GvEdge.kind`, `edges.tsx` stroke, a palette token with contrast ≥ 3:1 on the canvas (`palettes.test.ts`), a toolbar toggle and its i18n strings, plus a settings field.
- **Upgrade @xyflow/react:** re-run `tests/freezeSafe.test.ts` (it matches d3-color's text exactly) and the Safari 15 bundle scan (`structuredClone`, lookbehinds, `color-mix`).

## 7. Tests inventory (new in M3a)

| Layer | Files |
|---|---|
| Rust | `crates/liber-session/tests/global_view.rs` (levels, index notes, attachment folders, neighbourhood cap, edges + GV-25, layout follows renames, perf `--ignored`), `crates/liber-vault/tests/layout.rs` (lazy/atomic, lenient per entry, remap batches, collisions, pruning, concurrent writers), `crates/liber-vault/tests/open_scan.rs` (a malformed `vault.json` field never disables excludes) |
| Commands (real ACL) | `apps/desktop/src-tauri/tests/commands.rs` (`gv_children`, `gv_edges`, `layout_get/set`), `tests/menu.rs` (View → Editor / Global View), `tests/settings.rs` |
| Build | `apps/desktop/tests/freezeSafe.test.ts` (d3-color under a frozen prototype), `devPrebundle.test.ts` (dev pre-bundle patched), `credits.test.ts` |
| TS | `features/global-view/{layout,gvStore,Card,GlobalView,GlobalView.edges,edges,Canvas.a11y,targets}.test.*`, `ipc/globalView.test.ts`, `stores/layering.test.ts`, plus additions in `AppShell`, `Editor`, `PageTitle`, `navigate`, `stores`, `palettes`, `cssCompat`, `Welcome` tests |
| E2E | `e2e/m3a.spec.ts` (drill/breadcrumb, expand/collapse, double click incl. a slow one, drag + reload + Reset, aggregated edge + toggle, keyboard only, focus after leaving), `e2e/m3a-a11y.spec.ts` (axe, both engines, light + dark), `e2e/m3a-perf.spec.ts` (opt-in `LIBER_PERF=1`), zero-network with the Global View open |

## 8. Decisions taken for you (review in bulk)

From spec §12:
- **No elkjs:** the prototype's own layouts are used instead.
- **The editor stays mounted** behind the Global View. Shortcuts are ⌘1 / ⌘2, plus View-menu items.
- **The breadcrumb is the history of opened levels,** not the folder path.
- **The mode and edge toggles are global settings.**
- **"See all" is the same as a double click.** A folder without an index note drills in.
- **New entry** opens the editor with the title selected.
- **A page level includes the page itself** in the centre.
- **The connect handle is hidden** until M3b.
- **The single-click delay is 240 ms.**

From spec §13:
- **Edges come from links that start inside shown cards.**
- **Only the list form of `related:` is indexed** (M3b adds the scalar form).
- **External folder moves:** pins follow, but the folder's own level key doesn't.
- **Opening a page from anywhere shows Edit.**
- **Shortcuts:** no ⌘ glyphs in tooltips; `aria-keyshortcuts` instead.
- **Folder-summary covers** sit on accent-soft.
- **The manual edge colour** is fixed per mode, and each edge kind also differs in width or dash.
- **Card description:** "Linked with N cards. M relationships."
- **Zoom buttons** are the app's own, and React Flow's attribution badge is hidden; the credit is in the README.
- **A failed edge or layout read leaves the cards showing.**
- **New entry** uses `entry_create_page` directly.

From the final review (spec §13.17–18 and §8 notes):
- **Edges are one SVG layer under the cards** rather than React Flow edges. At most the **500 strongest aggregated edges** are drawn, with a note "Showing the 500 strongest of N links from inside folders". Direct links and parent/child edges are never capped.
- **Dash patterns lengthen when zoomed out,** to keep WebKit fast.
- **A page's neighbourhood is capped at 200 cards:** outgoing links and relationships first, then the newest backlinks. A note says how many were left out.
- **A slow double click** uses the platform's click count (`e.detail`), so it opens the card you double-clicked.
- **Focus:**
  - leaving the Global View with focus inside asks the editor to take it;
  - an empty level's note takes focus, and Escape there goes up;
  - Escape returns to the card that opened the level.
- **Card positions:**
  - a level save keeps positions for paths still in the vault, even off the canvas;
  - deleted paths and levels are pruned on writes;
  - one unreadable entry hides only itself, and a failed save shows one toast.
- **`.liber/vault.json` is read field by field:** a bad `indexPicks` or `exclude` item never disables the rest. JSON updates are serialized, with one retry.
- **React Flow is credited** in the README, `THIRD-PARTY-NOTICES.md` and on the welcome screen. Its screen-reader strings are translated, and its wrapper is named "Global View cards".

## 9. Needs the real window (you)

1. **`pnpm dev`** opens normally: the freeze-safe fix now also covers Vite's dependency pre-bundle.
2. **Trackpad:** two-finger scroll pans or zooms (the reviewer saw zoom instead of pan); pinch zooms; dragging the background pans.
3. **Double click** on a card with your real double-click speed opens the editor, and never the wrong page.
4. **Keyboard only:** ⌘2, arrows, Enter, Shift+Enter, Escape, ⌘1; focus is always visible and never lost.
5. **Drag cards,** restart, and they're where you left them; rename the folder in Finder and they still are; Reset layout.
6. **Expand mode** on your test vault: expand, collapse, expand again, and the positions are kept.
7. **Level 0 of a large vault** feels fast; toggle the edge chips.
8. **Edge colours and cards** in every palette, light and dark.
9. **VoiceOver** on the canvas (React Flow uses `role="application"`).
10. **View menu** → Editor / Global View.

## 10. Known gaps / deferred

| # | Gap | Target |
|---|---|---|
| a | The Global View doesn't refresh after an attachment-policy change until the next navigation | later |
| b | In Expand, the "+N more not shown" note reflects only the root level's cap | later |
| c | Native macOS About panel lacks the React Flow credit; the bundle carries no licence comments for any dependency (pre-existing) | packaging (M8) |
| d | External folder moves: pinned cards follow, the folder's own level key doesn't (watcher reports file renames only) | later |
| e | Only the list form of `related:` is indexed | M3b |
| f | Trackpad two-finger scroll zooms instead of panning (reviewer's observation; React Flow default) | your real-window check (§9.2) |
| g | Safari 15: the six existing `color-mix()` uses blank the dialog backdrop and sidebar hovers | M3b |
| h | M3b must re-add connect handles (removed with the SVG edge layer) and keep React Flow's `structuredClone` click-connect path off | M3b |

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Blank window, console says `Cannot assign to read only property 'constructor'` | the freeze-safe transform didn't run on d3-color: check `vite.config.ts` `plugins` **and** `optimizeDeps.rolldownOptions.plugins`; `tests/freezeSafe.test.ts` |
| Cards jump or hide on focus | React Flow re-measured: nodes must keep fixed `width`/`height` and stable object identity |
| Pinned positions gone | check `.liber/layout.json`; parsing is lenient per entry (§14) |
| Global View empty after a vault switch | `gvStore` resets on vault change |

## 12. Next steps

1. Your real-window check of M2c, then M3a (§9), then the local merges, in order.
2. **M3b:** relationships (connect, label, direction, delete) and index-note picks, plus the Safari 15 `color-mix` cleanup. Spec: `docs/superpowers/specs/2026-10-14-m3b-relationships-design.md`.

## 13. Final review and fix pass

**Reviewer:** Opus, fresh context, on `216b474..8fc593a`. Report: `.superpowers/sdd/2026-10-14-m3a-global-view/final-review.md`, git-ignored and deleted when the branch merges, so the table below is the record.
- **Verdict:** not ready, with 1 Critical, 6 Important and 15 Minor findings.
- **The good news:** the backend held up: layout atomicity, GV-25 aggregation, the index-note rules, ACL, i18n and undo surviving the switch.
- **Re-grading:** re-graded by effect, 14 minors joined the fix pass, and 1 was deferred. Fixes ran in three parallel worktrees (backend, store and navigation, canvas/a11y/build), were cherry-picked with two small conflicts resolved, and every fix has a test that failed first.

| # | Finding | Fix | Test(s) |
|---|---|---|---|
| C1 | `pnpm dev` opened a blank window (dev pre-bundle not freeze-safe) | `optimizeDeps.rolldownOptions.plugins: [freezeSafe()]` | `tests/devPrebundle.test.ts` |
| I1 | A drag could be lost, or saved under another level, within the 300 ms save window | saves carry their canvas key; loads flush first; reloads merge unsaved pins | `gvStore.test.ts` ×5, e2e |
| I2 | Level 0 of a 10k vault took 1.5–2.6 s in WebKit (NFR-03: 300 ms) | one SVG edge layer, SVG counts, dash scaling, ≤ 500 aggregated edges | `GlobalView.edges.test.tsx`, `edges.test.ts`, opt-in perf e2e: 140–192 ms |
| I3 | The watcher rewrote `layout.json` per renamed file (1,000 moves ≈ 9 s) | one remap per batch, no write when nothing changes | `global_view.rs`, `layout.rs` (≈ 97 ms) |
| I4 | Focus fell to `<body>` after an empty level, Shift+Enter, double click or ⌘1 | empty note takes focus; editor focus request; ⌘2 refocuses the last card | `GlobalView.test.tsx` ×3, e2e |
| I5 | A double click slower than 240 ms opened the wrong page | route the second click by `e.detail` to the first card | `GlobalView.test.tsx` ×2, e2e |
| I6 | Expand: dragging any card deleted collapsed cards' saved positions | saves keep positions of paths still in the vault | `gvStore.test.ts` |
| m1–m15↑ | Crumb titles; centre-card click; focus ring on WebKit < 15.4; label tooltip; React Flow a11y strings; credit; lenient layout + failed-save toast; lenient `vault.json`; remap collisions + pruning; writer race; transient errors trimming the breadcrumb; Escape focus to the opener; hub neighbourhoods; handle size; store layering | one commit each | listed in the ledger; all RED → GREEN |

**Merge notes:**
- Two conflicts, both in `Canvas.tsx` imports and wrapper: the store agent's capture handlers combined with the canvas agent's SVG edge layer.
- Rust test binaries built inside agent worktrees kept the worktrees' fixture paths, so `cargo clean -p` for the workspace crates was needed once after removing them. If `read fixture dir: NotFound` appears, do the same.
