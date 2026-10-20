# M4b part 3, Stream A — Global View: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Windows card-cover crop and draw side covers on cards; tell pages from folders on cards; make edges readable with many connections; add See atoms (read and jump).

**Architecture:**
- Everything is in the frontend's Global View feature (`apps/desktop/src/features/global-view/`).
- There are four small seams outside it:
  - a one-shot editor jump (`pageStore.jump`, `navigate.openPageAt`, `editor/flash.ts`);
  - one View-menu item in Rust (`menu:screen` payload `"atoms"`);
  - `GvCard`'s two side-cover fields in `ipc/index.ts`;
  - the e2e mock.
- The atoms map is built from the preview's own parser (`parsePage`) and drawn by a second React Flow canvas that shares Card, EdgeLayer and focus mode with the level canvas.

**Tech Stack:** React 19, TypeScript, zustand, @xyflow/react 12.12, CodeMirror 6, unified/remark (`parsePage`), Playwright (chromium + webkit), vitest/jsdom, Tauri 2 (one Rust menu item).

**Spec:** `docs/superpowers/specs/2026-10-15-m4b-part3-design.md`. Stream A owns:
- §2 for cards;
- §3's card rendering;
- §4, §5 and §6.

Decisions taken here are in the spec, **§14**.

This plan records what ran: every task was implemented test-first in the Stream A worktree (branch `feat/m4b3-gv`, from 5640fb7).

## Global Constraints

- **Safari 15 floor:** no regex lookbehind, `color-mix`, `structuredClone`, `Array.prototype.at`, `Object.hasOwn`. Checked by `src/jsCompat.test.ts` and `src/theme/cssCompat.test.ts`; tests may use them.
- **No new npm dependencies.**
- **i18n:** en + es, ICU plurals (`{count, plural, one {…} other {…}}`); `pnpm check:i18n` parity.
- **Accessibility:** axe clean in light and dark, in jsdom and in a real engine. New colour pairings are contrast-tested in `theme/palettes.test.ts`.
- **Layering:** the stores layer never imports `features/global-view/` (`src/stores/layering.test.ts`).
- **Edge performance:**
  - edges stay one SVG layer (`EdgeLayer`), with the `dashScale` and per-kind batching;
  - NFR-03's probe stays under 300 ms: `LIBER_PERF=1 … playwright test m3a-perf`.
- **Data contract with Stream B:** `GvCard` gains exactly `coverSide: 'top' | 'left' | 'right';` and `coverX: number | null;`, right after `coverY`. Rust's `GvCard` is Stream B's.
- **Commits:** signed, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Build and test environment:**
  - Rust builds use `CARGO_TARGET_DIR=$SP/m4b3-a-target`.
  - e2e runs on its own port (4417) through a scratch config, so parallel streams don't fight over 4317.

## Review Focus

1. **A cover image that hasn't loaded yet, or is very tall or very wide**, in WebView2. The frame must still crop at the stored focus, never show the image's top or overflow the card (e2e with 120 × 600 and 600 × 120 PNGs, chromium with WebView2's UA).
2. **Thousands of edges with focus mode on.** Hovering must not re-render the edge layer: attributes only, re-applied when the drawn edges change. The perf probe was re-run after the chips (one `<rect>` each) were added.
3. **A page whose text changed between the map's read and the click** (unsaved edits, an external write). The jump's offsets are clamped; the map reads the live text (`editorStore.liveText`) and re-reads on saves and vault changes.
4. **A page with hundreds of blocks**, or a paragraph that is a run of image embeds (the friend's "Line art" section). The map shows at most 400 atom cards and "+N more" per section; a run of embeds is one image card each. The layout never overlaps (pairwise test).
5. **Keyboard-only use of the atoms map:**
   - it arrives on the page's card;
   - arrows move between cards of different sizes (by centre);
   - Enter opens the block;
   - Escape goes back with the keyboard on the card;
   - focus mode never dims a view the keyboard merely arrived in.

---

### Task 1: Card covers crop to their focus in WebView2; side-cover strips on cards (§2, §3)

**Files:**
- Create: `apps/desktop/e2e/m4b3-gv.spec.ts`
- Modify: `apps/desktop/e2e/ipcMock.ts` (`coverSides` option; card `coverY`/`coverX` from frontmatter, `coverSide`); `apps/desktop/playwright.config.ts` (WebKit runs the new spec)
- Modify: `apps/desktop/src/ipc/index.ts` (`GvCard.coverSide`, `GvCard.coverX`)
- Modify: `apps/desktop/src/features/global-view/Card.tsx`, `Card.module.css`, `Card.test.tsx`, and the other `GvCard` fixtures (`Canvas.a11y`, `Connect`, `GlobalView.edges`, `GlobalView`, `gvStore`, `targets` tests)

**Interfaces:**
- Produces: `GvCard.coverSide: 'top' | 'left' | 'right'`, `GvCard.coverX: number | null`; the card's `.hit` carries `data-cover-side` when it shows a side strip.

- [x] **Step 1: Write the failing e2e (chromium with WebView2's user agent).**
  - `bandsPng(w, h)` writes a red/green/blue-banded PNG with `node:zlib`, routed at `http://liber-asset.localhost/**` (the Windows UA makes `assetUrl` use it).
  - A page with `cover: tall.png`, `cover-y: 100`.
  - The test asserts that the card image's box equals its frame (96 px tall), with `object-position: 50% 100%`.
- [x] **Step 2: Run it. Failed as the friend saw it:** `img` 238 × **1190** in a 96 px frame in Chromium (WebKit passed).
  - `pnpm build:ui && playwright test m4b3-gv --project=chromium`
- [x] **Step 3: Fix.**
  - `.cover` is `position: relative`.
  - `.image` is `position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover`.
  - `object-position: ${coverX ?? 50}% ${coverY ?? 50}%`.
- [x] **Step 4: Side strips.**
  - Unit tests first, in `Card.test.tsx`:
    - "a side cover is a strip on that side, focused in both axes";
    - "a side placement without an image keeps the top placeholder".
  - Then `.hit[data-cover-side]`: a two-column grid (`96px minmax(0,1fr)`, mirrored for `right`), the cover spanning every row.
  - An e2e checks that the strip's frame is 96 px wide, sits flush with the card's edge, and has the title beside it.
- [x] **Step 5:** Card tests 10/10; e2e 4/4 (chromium, webkit). Commit `fe945c8`.

### Task 2: Page cards say Edit; folders look like folders (§4)

**Files:**
- Create: `apps/desktop/src/features/global-view/gvIcons.tsx` (feature-local icons, so `app/icons.tsx` stays conflict-free)
- Modify: `Card.tsx`, `Card.module.css`, `Card.test.tsx`, `i18n/locales/{en,es}.json` (`gv.edit`, `gv.editLabel`), `theme/palettes.test.ts`, `e2e/m3a.spec.ts`, `e2e/m4b3-gv.spec.ts`

- [x] **Step 1: Tests first.**
  - A page card has `Edit Generator Rex` (text "Edit") and no See all, `data-kind="page"`, no tab.
  - A project card has `See all: Delta`, `data-kind="project"` and an `aria-hidden` tab.
  - Red: 3 failed.
- [x] **Step 2: Implement.**
  - **Head and footer:**
    - The kind label gets a page, folder or briefcase icon.
    - The footer shows Edit with a pencil, or See all with a stack icon.
  - **Folder and project cards:**
    - a sibling `<span data-gv-tab>` sits on the top-left edge, outside the card's clipped box;
    - a second sheet comes from box-shadows, kept under the open and connecting rings;
    - the head is tinted with `--color-accent-soft`, the kind label in `--color-accent`.
- [x] **Step 3: Pin the folder head's contrast.** `expectReadableGlobalView` also checks accent on accent-soft ≥ 4.5 for every palette and custom accent.
- [x] **Step 4: Fix and extend the e2e.**
  - `m3a.spec.ts`: the screen switch's `Edit` lookups become exact (page cards now hold "Edit X").
  - New: Edit opens the editor, and the tab sits above the folder card.
  - e2e 30/30 (m3a + m4b3-gv), m3a-a11y + m3b 24/24. Commit `051e04a`.

### Task 3: Edges that stay readable (§5)

**Files:**
- Create: `apps/desktop/src/features/global-view/focusMode.ts` (Task 4 moved it here from Canvas)
- Modify: `edges.tsx`, `edges.test.ts`, `Canvas.tsx`, `Toolbar.tsx`, `GlobalView.module.css`, `GlobalView.edges.test.tsx`, i18n (`gv.chip.links`, `gv.chip.relationships`)

**Interfaces:**
- Produces:
  - `elbowPath(a: Box, b: Box, prefer: TreeRoute = 'h'): string`
  - `labelOf(edge, words: (count, kind) => string): string | null`
  - `chipWidth(text): number`
  - `focusEdges(root: HTMLElement, path: string | null): void`
  - `EdgeLayer` prop `tree?: TreeOrientation`
  - `DrawnEdge.route?: TreeRoute`
- Edge pieces carry `data-a` and `data-b` (their two cards).

- [x] **Step 1: Unit tests.**
  - `strokeOf('tree')`: 1.25, solid. `strokeOf('link', true)`: 3, `10 6`.
  - Elbows:
    - `MVHV` for a top-down tree;
    - `MHVH` beside;
    - mirrored left and above;
    - straight when overlapping.
  - Chip text: "12 links", the label · count, a 23-character label plus "…".
  - `focusEdges` lights a card's edges and neighbours, matches paths with quotes and brackets literally, and `null` clears it.
  - Red on missing exports.
- [x] **Step 2: Implement.**
  - The new strokes.
  - Tree edges as elbows, with the orientation a layout asks for.
  - Count chips: a `<rect>` pill plus the existing SVG `<text>` (still `data-gv-count`).
  - Focus mode:
    - The canvas wrapper is `data-gv-canvas`.
    - A hovered card, or one the keyboard moved to (arrows, Tab inside the canvas), lights its edges and neighbours.
    - The CSS dims the rest: `[data-a]:not([data-gv-hot])` to 0.15 and nodes to 0.55, and widens lit lines by 1 px through `--w`.
  - The toolbar samples are drawn as each line looks (an elbow for parent/child).
- [x] **Step 3: Integration test.**
  - Hovering card A lights `A, B, path/rect/text A–B`.
  - Leaving clears it.
  - A card focused for you lights nothing; ArrowRight to B lights B; blur clears it.
- [x] **Step 4: e2e** (expand Alpha, Fit to screen):
  - tree `d`s are `MHVH`;
  - chip "2 links" on `Alpha/One.md`–`Beta`;
  - the legend's elbow;
  - hover Gamma: the aggregated line at 0.15 and Alpha at 0.55;
  - hover Beta: the line at 1, One at 1, Alpha at 0.55, tree lines at 0.15.
- [x] **Step 5: Perf probe.** `LIBER_PERF=1 playwright test m3a-perf --workers=1`:
  - chromium 200 cards: 175/135/108 ms;
  - webkit 94 cards: 176/100/117 ms;
  - webkit 200 cards: 242/182/144 ms (all < 300).
  - Commit `761b7b2`.

### Task 4: See atoms (§6)

**Files:**
- Create in `features/global-view/`:
  - `atoms.ts`, `atoms.test.ts`;
  - `AtomCard.tsx`, `Atoms.module.css`;
  - `AtomsCanvas.tsx`;
  - `GlobalView.atoms.test.tsx`;
  - `seeAtomsMenu.ts`, `seeAtomsMenu.test.ts`.
- Create in `features/editor/`: `flash.ts`, `flash.test.ts`.
- Modify:
  - `gvStore.ts` (`atoms`, `atomsReset`, `seeAtoms`, `closeAtoms`, `atomsPageLevel`);
  - `GlobalView.tsx`, `Toolbar.tsx`, `Canvas.tsx`, `Card.tsx` (`onSeeAtoms`, the Atoms button), `Card.module.css`;
  - `edges.tsx` (trunk route), `GlobalView.module.css`;
  - `editor/Editor.tsx`, `Editor.test.tsx`;
  - `stores/pageStore.ts` (`jump`, `requestJump`, `clearJump`), `stores/navigate.ts` (`openPageAt`);
  - `main.tsx`, `safari15Startup.test.tsx`;
  - `src-tauri/src/menu.rs`, `src-tauri/tests/menu.rs`;
  - i18n (`gv.atoms.*`), `e2e/m4b3-gv.spec.ts`.

**Interfaces:**
- Produces:
  - `buildAtoms(text, max = 400): { sections: Section[]; atoms: Atom[]; more: More[] }`;
  - `atomsLayout(page, model, linked): { boxes: Map<id, {x,y,w,h}>; tree: [parent, child][] }`;
  - `readAtoms(path): Promise<IpcResult<AtomsData>>`;
  - `jumpTo(view, from, to)`;
  - `openPageAt(path, from, to)`;
  - `useGvStore().seeAtoms(path, title)`;
  - Rust `menu::ATOMS_ID = "liber-see-atoms"`, emitting `menu:screen` with `"atoms"`.

- [x] **Step 1: Model and layout tests** (`atoms.test.ts`, 7 tests).
  - **The friend's note:** the sections are the two `#` headings far down. The intro is two paragraphs hanging from the page. A run of `![[…]]` lines is one image atom each, and the offsets slice back to the source.
  - **Links:** a paragraph with text and an embed stays a paragraph and lists its links.
  - **Nesting** by level, with block counts.
  - **Every block kind**, with its preview data: list, tasks, quote, callout, code (4 lines), diagram (Mermaid), formula, table, audio, file, embedded page, markdown image, html.
  - **The budget:** `max` keeps 6, and the rest of B becomes "+3 more" at `p1`.
  - **Layout:**
    - the page on top, columns below, blocks indented, linked pages on the right;
    - no pair of boxes overlaps;
    - tree pairs in order.
  - Green after `atoms.ts`; one test fixed: two lists with the same bullet are one list in Markdown, so the task list uses `*`.
- [x] **Step 2: Jump and flash.**
  - `flash.test.ts`: the cursor is on `from` and the lines of `from`–`to` get `cm-liber-flash` for `FLASH_MS`. Past-the-end offsets are clamped, and a destroyed view is safe.
  - Editor test: a jump for `A.md` waits while `B.md` shows, then lands, once.
  - Red (no jump), then green with the `Editor.tsx` effect.
- [x] **Step 3: Store, canvas, cards, toolbar, menu.**
  - **AtomsCanvas:**
    - reads the live text, the page level (`gv_children` page), `links_resolve` and `gv_edges`;
    - builds nodes (page / section / atom / more) and edges (tree: `v` from the page to its sections, `l` trunk otherwise; links; relationships);
    - fits, focuses the page's card, and handles arrows by centre and Escape.
  - **Toolbar:** with atoms open, every level crumb goes back, then the page crumb, then "Atoms" (current). The mode switch and Connect cards are hidden, and so is New entry.
  - **Menu:**
    - Rust's View → See Atoms of This Page emits `menu:screen` with `"atoms"`.
    - `seeAtomsMenu.ts` (the feature, not `stores/`: `layering.test.ts` failed when `menuToggles.ts` imported the store) opens the open Markdown page's atoms.
- [x] **Step 4: `GlobalView.atoms.test.tsx`** (7 tests):
  - **Entry:** the card's Atoms button shows the sections, blocks, the linked page (Sparda) and the related page (Mentor), but not a backlink alone (Fan). The image thumbnail is `liber-asset://localhost/assets/rex.png`.
  - **Edges:** 6 tree edges; the link edge `atom:0 → Sparda.md`; the manual edge to Mentor.
  - **Breadcrumb:** as above.
  - **Clicks:** a block sets `jump` to the list's offsets; a section to its heading.
  - **Navigation:** Escape goes back with focus on Rex. A linked page's card shows its own atoms, and the page crumb opens its level.
  - **Menu, axe and live:** See atoms from the store; axe; a vault change re-reads.
  - Two fixes on the way:
    - React Flow's visible-only rendering hid every node but one in jsdom, so it now applies past 150 cards only;
    - lists and tables are named by their first items or columns.
- [x] **Step 5: e2e** (chromium + webkit):
  - **The map:** headings, code `js`, list, Sparda's card and the link edge to it; trunk routes `MVH`; the breadcrumb.
  - **A click on the list** opens Rex with `.cm-liber-flash` on "water", and the selection there.
  - **Keyboard:** ArrowDown from a heading reaches its first block. Escape goes back with focus on Rex's card.
  - **axe** light and dark, with the pointer off the cards: hover dimming is a passing state, and Chromium's axe flagged a dimmed card's Edit button while the pointer rested on another card.
  - The mock titles pages by their first `# ` anywhere (Stream B's §1 fixes the app, not the mock), so the e2e page starts with `# Rex`.
- [x] **Step 6: Checks.**
  - vitest 1205/1205; menu tests 5/5; e2e Global View suites 64/64.
  - lint, prettier, typecheck, i18n and `cargo fmt` clean.
  - Commit `d975ba3`.

### Task 5: Gate

- [x] `LOGS=$SP/logs/m4b3-a CARGO_TARGET_DIR=$SP/m4b3-a-target $SP/check.sh all <worktree>` gives ALL-OK. Counts are in the stream's report.
