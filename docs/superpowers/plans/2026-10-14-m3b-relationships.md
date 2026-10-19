# M3b — Global View: relationships and index notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect cards on the Global View (drag, or Connect to… by click and keyboard), label / direct / delete relationships stored in the source page's `related:`, pick a folder's index note, and remove the app's `color-mix()` for Safari 15.

**Architecture:** Rust gains index-note picks (`.nimw/vault.json` `indexPicks`, following renames), a `link_target` command and `GvCard.indexFrom`; the indexer reads a scalar `related:`. TS gains byte-minimal `related:` edits (read back or refused, as M2c's frontmatter edits), a write path through the source page (the live editor when open, else CAS on disk with one retry), a card connections menu, a Relationships dialog (from the menu or a click on a relationship edge), connect mode and a drag-to-connect handle on React Flow, and an index-note pick dialog.

**Tech Stack:** Rust (nimw-markdown, nimw-vault, nimw-session, Tauri commands), React 19 + TS + zustand, `@xyflow/react` 12.12.0, `yaml` 2 Document API, Vitest (jsdom), Playwright (Chromium + WebKit).

**Spec:** `docs/superpowers/specs/2026-10-14-m3b-relationships-design.md` (§10 records this plan's amendments).

**How this plan was made:** every step below was run, in order, on a scratch clone of `feat/m3b-relationships` (`bd14bbd`); each task's code blocks are the code that ran, taken from that task's commit, and every `Expected:` is the output observed.

## Global Constraints

- No network from the app (P1, NFR-04); the zero-network e2e covers the new flows.
- Every new Tauri command: in `build.rs` `COMMANDS`, `generate_handler!`, `capabilities/main.json`, the `COMMANDS` list of `tests/commands.rs`, with a real-ACL test; async through `blocking()`; path arguments validated (`VaultPath`, visible and indexed).
- i18n en + es parity (`pnpm check:i18n`), ICU syntax (`{name}`, `{count, plural, …}`) like the existing strings.
- axe-clean in jsdom and in the real engines (light and dark); keyboard parity for every pointer action; focus never lands on `<body>`.
- Safari 15 floor: no regex lookbehind, no `color-mix()` (guard test), no `structuredClone` on reachable paths (`connectOnClick={false}`).
- Frontmatter edits keep M2c's guarantees: byte-minimal, CRLF kept, read back exactly or refused with "NIMW can’t safely change this note’s frontmatter. Edit it in Source mode."
- Opening a vault writes nothing (VLT-02): `.nimw/vault.json` appears only for a pick.
- Vitest with `--maxWorkers=2`; Node 24 first on PATH (`pnpm check:i18n` needs ≥ 22.18); Playwright browsers via `PLAYWRIGHT_BROWSERS_PATH`.
- Test builds use their own `CARGO_TARGET_DIR` in worktrees/clones (test binaries bake fixture paths in).

## Review Focus

1. **A relationship made while its source page is open in the editor with unsaved typing** — it must go through the editor (undoable, typing kept), never a disk write over it. Pinned in Task 4: `relations.test.tsx` › "the page open in the editor: an undoable change, saved at once".
2. **The source page changes on disk between read and write** (another program, sync) — retried once on the new text; never written over; then a toast. Pinned in Task 4: "a change on disk meanwhile is retried once on the new text" and "a page that keeps changing: one toast, the page left as it is".
3. **Odd existing `related:` forms** (flow list, a single value, an empty key from a template, block-map items, comments, CRLF, anchors) — edited exactly or refused, never corrupted. Pinned in Task 3: `related.test.ts` sweep and the form tests; CRLF in Task 4: "a CRLF page keeps its line endings".
4. **Safari 15.0–15.3** — React Flow's click-to-connect `structuredClone`, and backdrops drawn with `color-mix()` that vanish. Pinned in Task 1: `cssCompat.test.ts` › "no color-mix()"; Task 6 keeps `connectOnClick={false}` (bundle scan in Task 8).
5. **Keyboard-only connecting** — menu → Connect to… → the source card keeps focus → arrows → Enter, Escape leaves. Pinned in Task 6: `Connect.test.tsx` › "by keyboard…" and "Escape or Cancel…"; Task 8: e2e "by keyboard…".

## File Structure

| Path | Responsibility |
|---|---|
| `apps/desktop/src/theme/{color,paletteCss}.ts`, `tokens.css`, `palettes.css` (generated) | `alpha()`; sidebar shades and backdrops as tokens |
| `crates/nimw-markdown/src/frontmatter.rs` | scalar `related:` indexed |
| `crates/nimw-vault/src/{vault,layout}.rs` | `set_index_pick`, `remap_index_picks_many` |
| `crates/nimw-session/src/global_view.rs` | `IndexFrom`, `index_pick_set`, `link_target`; picks follow renames |
| `apps/desktop/src-tauri/src/{gv_commands,dto,lib}.rs`, `build.rs`, `capabilities/main.json` | `link_target`, `index_pick_set` |
| `apps/desktop/src/markdown/{frontmatterEdit,related,frontmatter}.ts` | shared guard helpers; `related:` operations; TS reader parity |
| `apps/desktop/src/stores/{relations,editorStore,uiStore}.ts` | write path; `editPage`; dialog states |
| `apps/desktop/src/features/global-view/{CardMenu,Card,Canvas,edges,gvStore,GlobalView,RelationsDialog,IndexPickDialog}.tsx/ts` | menu, connect mode, handle, edge hits, dialogs |
| `apps/desktop/e2e/{ipcMock,m3b.spec,zero-network.spec}.ts`, `playwright.config.ts` | end to end |

**Commands used throughout (repo root):** `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`; Vitest `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 <paths>`; Cargo `cargo test -p <crate> [--test <file>]`; E2E `pnpm --filter @nimw/desktop exec vite build` then `PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @nimw/desktop exec playwright test <spec>`.

---

### Task 1: Safari 15: generated sidebar shades and backdrops instead of color-mix()

Spec §7.

**Files:**
- Modify: `apps/desktop/src/features/dialogs/Dialogs.module.css`
- Modify: `apps/desktop/src/features/explorer/Explorer.module.css`
- Modify: `apps/desktop/src/features/opening/OpeningOverlay.module.css`
- Modify: `apps/desktop/src/features/shell/Shell.module.css`
- Modify: `apps/desktop/src/theme/color.ts`
- Modify: `apps/desktop/src/theme/cssCompat.test.ts`
- Modify: `apps/desktop/src/theme/paletteCss.ts`
- Modify: `apps/desktop/src/theme/palettes.test.ts`
- Modify: `apps/desktop/src/theme/tokens.css`

**Interfaces:**
- Consumes: nothing new.
- Produces: `alpha(hex, a): string` in `theme/color.ts`; CSS tokens `--color-sidebar-hover`, `--color-sidebar-active`, `--color-sidebar-divider`, `--color-backdrop`, `--color-overlay` (every palette and mode, and `tokens.css` defaults).

- [ ] **Step 1: Write the failing test(s)**

Modify `apps/desktop/src/theme/cssCompat.test.ts` (apply this change):

```diff
@@ -42,6 +42,20 @@ describe('CSS on the Safari 15 floor', () => {
     expect(offenders).toEqual([]);
   });
 
+  it('no color-mix(): Safari before 16.2 drops the whole declaration (M3b §7)', () => {
+    // A backdrop declared with color-mix() had no background at all there,
+    // and the sidebar lost its hover colours. Mixed shades are generated
+    // tokens (paletteCss.ts) instead.
+    const offenders = cssFiles(src).flatMap((file) =>
+      readFileSync(file, 'utf8')
+        .replace(/\/\*[\s\S]*?\*\//g, '')
+        .split('\n')
+        .filter((line) => line.includes('color-mix('))
+        .map((line) => `${file.slice(src.length)}: ${line.trim()}`),
+    );
+    expect(offenders).toEqual([]);
+  });
+
   it('a focus ring is only removed where :focus-visible can bring it back', () => {
     // `.x { outline: none }` + `.x:focus-visible { outline: … }` leaves no ring
     // at all where :focus-visible is unknown (M3a final review m3). The ring
```

Modify `apps/desktop/src/theme/palettes.test.ts` (apply this change):

```diff
@@ -85,6 +85,43 @@ describe('Global View tokens (M3a §4, §6)', () => {
   });
 });
 
+/** Shades that used to be color-mix() (M3b §7, Safari 15): the sidebar's
+ *  hover, pressed and divider shades as plain hex, the backdrops as rgba. */
+const SIDEBAR_SHADES = [
+  '--color-sidebar-hover',
+  '--color-sidebar-active',
+  '--color-sidebar-divider',
+] as const;
+const BACKDROPS = ['--color-backdrop', '--color-overlay'] as const;
+
+describe('Safari 15 shades (M3b §7)', () => {
+  it.each(PALETTES.flatMap((p) => (['light', 'dark'] as const).map((m) => [p.id, m] as const)))(
+    '%s %s: sidebar shades and backdrops',
+    (id, mode) => {
+      const p = PALETTES.find((x) => x.id === id)!;
+      const vars = paletteVars(p, mode);
+      for (const key of SIDEBAR_SHADES) {
+        expect(vars[key], key).toMatch(/^#[0-9a-f]{6}$/);
+        expect(vars[key], `${key} differs from the sidebar`).not.toBe(p[mode].side);
+        expect(
+          contrast(p[mode].sideText, vars[key]),
+          `sidebar text on ${key}`,
+        ).toBeGreaterThanOrEqual(4.5);
+      }
+      for (const key of BACKDROPS)
+        expect(vars[key], key).toMatch(/^rgba\(\d+, \d+, \d+, 0\.\d+\)$/);
+      expect(vars['--color-backdrop']).toMatch(/, 0\.6\)$/);
+      expect(vars['--color-overlay']).toMatch(/, 0\.7\)$/);
+    },
+  );
+
+  it('the default tokens define them too, in both modes', () => {
+    for (const key of [...SIDEBAR_SHADES, ...BACKDROPS]) {
+      expect(tokensCss.split(`${key}:`).length - 1, key).toBe(3);
+    }
+  });
+});
+
 describe('palette CSS', () => {
   it('maps every token and derives the in-between shades as plain hex (Safari 15)', () => {
     const vars = paletteVars(PALETTES[1], 'light');
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/theme/cssCompat.test.ts src/theme/palettes.test.ts`
Expected: FAIL — `× no color-mix(): Safari before 16.2 drops the whole declaration (M3b §7)` (six offenders listed) and `× lavender light: sidebar shades and backdrops` (and every other palette × mode: the tokens are undefined).

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/dialogs/Dialogs.module.css` (apply this change):

```diff
@@ -4,7 +4,7 @@
   display: flex;
   align-items: center;
   justify-content: center;
-  background: color-mix(in srgb, var(--color-bg) 60%, transparent);
+  background: var(--color-backdrop);
   z-index: 40;
 }
```

Modify `apps/desktop/src/features/explorer/Explorer.module.css` (apply this change):

```diff
@@ -23,7 +23,7 @@
 }
 
 .row:hover {
-  background: color-mix(in srgb, var(--color-sidebar-text) 10%, transparent);
+  background: var(--color-sidebar-hover);
 }
 
 .row:focus-visible {
@@ -145,5 +145,5 @@
 }
 
 .more:hover {
-  background: color-mix(in srgb, var(--color-sidebar-text) 16%, transparent);
+  background: var(--color-sidebar-active);
 }
```

Modify `apps/desktop/src/features/opening/OpeningOverlay.module.css` (apply this change):

```diff
@@ -4,7 +4,7 @@
   display: flex;
   align-items: center;
   justify-content: center;
-  background: color-mix(in srgb, var(--color-bg) 70%, transparent);
+  background: var(--color-overlay);
   z-index: 20;
 }
```

Modify `apps/desktop/src/features/shell/Shell.module.css` (apply this change):

```diff
@@ -64,7 +64,7 @@
 }
 
 .iconButton:hover {
-  background: color-mix(in srgb, var(--color-sidebar-text) 12%, transparent);
+  background: var(--color-sidebar-hover);
 }
 
 .treeScroll {
@@ -81,7 +81,7 @@
   color: var(--color-text-faint);
   padding: 12px 8px 4px;
   margin: 0;
-  border-top: 1px solid color-mix(in srgb, var(--color-sidebar-text) 15%, transparent);
+  border-top: 1px solid var(--color-sidebar-divider);
 }
 
 .main {
```

Modify `apps/desktop/src/theme/color.ts` (apply this change):

```diff
@@ -30,6 +30,13 @@ export function mix(a: string, b: string, amount: number): string {
   return rgbToHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * amount) as Rgb);
 }
 
+/** `#rrggbb` at `alpha` (0–1) as `rgba()`: a translucent shade without
+ *  `color-mix()`, which Safari before 16.2 lacks (M3b §7). */
+export function alpha(hex: string, a: number): string {
+  const [r, g, b] = hexToRgb(hex).map((c) => Math.round(c * 255));
+  return `rgba(${r}, ${g}, ${b}, ${a})`;
+}
+
 function luminance(hex: string): number {
   const [r, g, b] = hexToRgb(hex).map(toLinear);
   return 0.2126 * r + 0.7152 * g + 0.0722 * b;
```

Modify `apps/desktop/src/theme/paletteCss.ts` (apply this change):

```diff
@@ -1,5 +1,5 @@
 // `.ts` extension: scripts/gen-palettes.ts runs this file directly in Node.
-import { mix } from './color.ts';
+import { alpha, mix } from './color.ts';
 import type { Palette, PaletteTokens } from './palettes';
 
 /** A palette's mode as app CSS custom properties (M2b §4 mapping table). The
@@ -27,6 +27,14 @@ export function paletteVars(p: Palette, mode: 'light' | 'dark'): Record<string,
     '--color-sidebar-bg': t.side,
     '--color-sidebar-text': t.sideText,
     '--color-sidebar-selected': t.sideSel,
+    // Hover, pressed and divider shades on the (always dark) sidebar, and the
+    // backdrops behind dialogs and the opening overlay: generated here, not
+    // with color-mix(), which Safari before 16.2 drops (M3b §7).
+    '--color-sidebar-hover': mix(t.side, t.sideText, 0.12),
+    '--color-sidebar-active': mix(t.side, t.sideText, 0.16),
+    '--color-sidebar-divider': mix(t.side, t.sideText, 0.15),
+    '--color-backdrop': alpha(t.bg, 0.6),
+    '--color-overlay': alpha(t.bg, 0.7),
     // The sidebar is dark in both modes: its drop feedback uses the dark accent.
     '--color-drop-bg': t.sideSel,
     '--color-drop-ring': p.dark.accent,
```

Modify `apps/desktop/src/theme/tokens.css` (apply this change):

```diff
@@ -17,6 +17,12 @@
   --color-accent-soft: #e9e1f4;
   --color-sidebar-bg: #1f1d24;
   --color-sidebar-text: #d9d4e2;
+  /* M3b §7: shades that used color-mix() (Safari before 16.2 drops it). */
+  --color-sidebar-hover: #35333b;
+  --color-sidebar-active: #3d3a42;
+  --color-sidebar-divider: #3b3841;
+  --color-backdrop: rgba(244, 239, 248, 0.6);
+  --color-overlay: rgba(244, 239, 248, 0.7);
   /* Drag-and-drop on the (always dark) sidebar: visible in both themes. */
   --color-drop-bg: rgba(185, 162, 230, 0.22);
   --color-drop-ring: #b9a2e6;
@@ -85,6 +91,11 @@
     --color-accent-soft: #2f2742;
     --color-sidebar-bg: #121016;
     --color-sidebar-text: #d9d4e2;
+    --color-sidebar-hover: #2a282e;
+    --color-sidebar-active: #322f37;
+    --color-sidebar-divider: #302d35;
+    --color-backdrop: rgba(23, 21, 28, 0.6);
+    --color-overlay: rgba(23, 21, 28, 0.7);
     --color-warn-bg: #3a2618;
     --color-warn-border: #7a4a26;
     --color-warn-text: #f3c79f;
@@ -134,6 +145,11 @@
   --color-accent-soft: #2f2742;
   --color-sidebar-bg: #121016;
   --color-sidebar-text: #d9d4e2;
+  --color-sidebar-hover: #2a282e;
+  --color-sidebar-active: #322f37;
+  --color-sidebar-divider: #302d35;
+  --color-backdrop: rgba(23, 21, 28, 0.6);
+  --color-overlay: rgba(23, 21, 28, 0.7);
   --color-warn-bg: #3a2618;
   --color-warn-border: #7a4a26;
   --color-warn-text: #f3c79f;
```

Note: `tokens.css` gets the lavender values (light `#35333b #3d3a42 #3b3841 rgba(244, 239, 248, 0.6) rgba(244, 239, 248, 0.7)`, dark `#2a282e #322f37 #302d35 rgba(23, 21, 28, 0.6) rgba(23, 21, 28, 0.7)`), computed with `mix(side, sideText, 0.12 / 0.16 / 0.15)` and `alpha(bg, 0.6 / 0.7)`. Never edit `palettes.css` by hand: run `pnpm --filter @nimw/desktop gen:palettes`.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @nimw/desktop gen:palettes && pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/theme`
Expected: PASS — `Tests  120 passed (120)`; `git status` shows `src/theme/palettes.css` regenerated.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/dialogs/Dialogs.module.css apps/desktop/src/features/explorer/Explorer.module.css apps/desktop/src/features/opening/OpeningOverlay.module.css apps/desktop/src/features/shell/Shell.module.css apps/desktop/src/theme/color.ts apps/desktop/src/theme/cssCompat.test.ts apps/desktop/src/theme/paletteCss.ts apps/desktop/src/theme/palettes.test.ts apps/desktop/src/theme/tokens.css
git commit -F - <<'MSG'
fix(theme): no color-mix() — generated sidebar shades and backdrops for Safari 15 (M3b §7)

Safari before 16.2 drops a declaration using color-mix(): the dialog and
opening backdrops had no background and the sidebar lost its hover
shades. paletteCss.ts derives --color-sidebar-{hover,active,divider} as
hex and --color-backdrop / --color-overlay as rgba for every palette;
a guard test fails on any color-mix( in the app's CSS.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 2: Backend: scalar related:, index-note picks, link targets (session, vault, commands)

Spec §4, §5, §6.

**Files:**
- Modify: `apps/desktop/src-tauri/build.rs`
- Modify: `apps/desktop/src-tauri/capabilities/main.json`
- Modify: `apps/desktop/src-tauri/src/dto.rs`
- Modify: `apps/desktop/src-tauri/src/gv_commands.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tests/commands.rs`
- Modify: `apps/desktop/src/ipc/globalView.test.ts`
- Modify: `apps/desktop/src/ipc/index.ts`
- Modify: `crates/nimw-markdown/src/frontmatter.rs`
- Modify: `crates/nimw-session/Cargo.toml`
- Modify: `crates/nimw-session/src/global_view.rs`
- Modify: `crates/nimw-session/src/lib.rs`
- Modify: `crates/nimw-session/tests/global_view.rs`
- Modify: `crates/nimw-vault/src/layout.rs`
- Modify: `crates/nimw-vault/src/vault.rs`

**Interfaces:**
- Consumes: `Vault::update_json_object`, `remap` (layout.rs), `Ctx::folder_card`, `shortest_unique_target`.
- Produces: `IndexFrom { Named, Index, Picked, Only }` and `GvCard.index_from`; `Vault::set_index_pick(folder, Option<page>)`, `Vault::remap_index_picks_many(renames)`; `VaultSession::index_pick_set(&VaultPath, Option<&VaultPath>) -> Result<GvCard>`, `VaultSession::link_target(&VaultPath, &VaultPath) -> Result<String>`; commands `link_target(source, target) -> String`, `index_pick_set(folder, page: Option<String>) -> GvCardDto` (`indexFrom: "named"|"index"|"picked"|"only"|null`); TS `linkTarget(source, target)`, `indexPickSet(folder, page | null)`, `GvCard.indexFrom?`.

- [ ] **Step 1: Write the failing test(s)**

Modify `apps/desktop/src-tauri/tests/commands.rs` (apply this change):

```diff
@@ -46,6 +46,8 @@ const COMMANDS: &[&str] = &[
     "gv_edges",
     "layout_get",
     "layout_set",
+    "link_target",
+    "index_pick_set",
 ];
 
 struct Harness {
@@ -1181,3 +1183,74 @@ fn m3a_layout_get_set_over_ipc() {
         json!({})
     );
 }
+
+/// M3b §6: the wiki target a relationship writes, and index-note picks, over
+/// IPC; a pick answers the folder's card, and only visible paths are taken.
+#[test]
+fn m3b_link_target_and_index_pick_set_over_ipc() {
+    let h = harness();
+    let vault = open_fixture(&h, "obsidian-basic");
+    assert_eq!(
+        call(
+            &h.main,
+            "link_target",
+            json!({ "source": "Welcome.md", "target": "Character Design/DMC/Sparda.md" })
+        )
+        .unwrap(),
+        json!("Sparda")
+    );
+    assert_eq!(
+        kind(
+            call(
+                &h.main,
+                "link_target",
+                json!({ "source": "Welcome.md", "target": "nope.md" })
+            )
+            .unwrap_err()
+        ),
+        "notFound"
+    );
+
+    assert!(!vault.path().join(".nimw").exists(), "VLT-02");
+    let card = call(
+        &h.main,
+        "index_pick_set",
+        json!({ "folder": "Character Design", "page": "Character Design/My characters.md" }),
+    )
+    .unwrap();
+    assert_eq!(card["path"], "Character Design");
+    assert_eq!(card["indexPage"], "Character Design/My characters.md");
+    assert_eq!(card["indexFrom"], "picked");
+    let json: Value = serde_json::from_str(
+        &std::fs::read_to_string(vault.path().join(".nimw/vault.json")).unwrap(),
+    )
+    .unwrap();
+    assert_eq!(
+        json["indexPicks"]["Character Design"],
+        "Character Design/My characters.md"
+    );
+    let cleared = call(
+        &h.main,
+        "index_pick_set",
+        json!({ "folder": "Character Design", "page": null }),
+    )
+    .unwrap();
+    assert_eq!(cleared["indexPage"], Value::Null);
+
+    for (folder, page) in [
+        (".obsidian", ".obsidian/app.json"),
+        ("Character Design", "Welcome.md"),
+        ("Character Design", "Character Design/DMC/Sparda.md"),
+        ("Character Design", "../x.md"),
+    ] {
+        assert!(
+            call(
+                &h.main,
+                "index_pick_set",
+                json!({ "folder": folder, "page": page })
+            )
+            .is_err(),
+            "{folder} ← {page}"
+        );
+    }
+}
```

Modify `apps/desktop/src/ipc/globalView.test.ts` (apply this change):

```diff
@@ -1,6 +1,6 @@
 import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
 import { afterEach, describe, expect, it } from 'vitest';
-import { gvChildren, gvEdges, layoutGet, layoutSet } from './index';
+import { gvChildren, gvEdges, indexPickSet, layoutGet, layoutSet, linkTarget } from './index';
 
 afterEach(() => clearMocks());
 
@@ -30,4 +30,23 @@ describe('M3a ipc commands', () => {
       ['layout_set', { level: 'page:b.md', positions: { A: { x: 3, y: 4 } } }],
     ]);
   });
+
+  it('M3b: link targets and index-note picks', async () => {
+    const calls: [string, unknown][] = [];
+    mockIPC((cmd, args) => {
+      calls.push([cmd, args]);
+      if (cmd === 'link_target') return 'Sparda';
+      if (cmd === 'index_pick_set') return { path: 'A', indexPage: 'A/b.md', indexFrom: 'picked' };
+      return null;
+    });
+    expect(await linkTarget('Welcome.md', 'C/Sparda.md')).toEqual({ ok: true, value: 'Sparda' });
+    const card = await indexPickSet('A', 'A/b.md');
+    expect(card.ok && card.value.indexFrom).toBe('picked');
+    await indexPickSet('A', null);
+    expect(calls).toEqual([
+      ['link_target', { source: 'Welcome.md', target: 'C/Sparda.md' }],
+      ['index_pick_set', { folder: 'A', page: 'A/b.md' }],
+      ['index_pick_set', { folder: 'A', page: null }],
+    ]);
+  });
 });
```

Modify `crates/nimw-session/tests/global_view.rs` (apply this change):

```diff
@@ -2,7 +2,8 @@
 //! cards (index notes, folder summaries, covers), edges and layouts.
 
 use nimw_session::{
-    CardKind, EdgeKind, GvCard, GvEdge, GvLevel, Relation, SessionEvent, VaultSession,
+    CardKind, EdgeKind, GvCard, GvEdge, GvLevel, IndexFrom, Relation, SessionError, SessionEvent,
+    VaultSession,
 };
 use nimw_vault::VaultPath;
 use std::path::Path;
@@ -527,3 +528,145 @@ fn m3a_an_external_move_of_1000_pinned_notes_writes_the_layout_once() {
     eprintln!("external move of {N} pinned notes, watcher batch: {took:?}");
     assert!(took < std::time::Duration::from_secs(1), "{took:?}");
 }
+
+/// M3b §4: which GV-02 rule chose a folder's index note — a pick is offered
+/// only where rules 1–2 (named like the folder, `index.md`) give nothing.
+#[test]
+fn m3b_index_from_tells_which_rule_chose_the_index_note() {
+    let dir = vault();
+    let (_c, s) = open(dir.path());
+    let level = s.gv_children(&GvLevel::Vault).unwrap();
+    assert_eq!(
+        card(&level.cards, "Alpha").index_from,
+        Some(IndexFrom::Named)
+    );
+    assert_eq!(card(&level.cards, "Beta").index_from, Some(IndexFrom::Only));
+    assert_eq!(
+        card(&level.cards, "Gamma").index_from,
+        Some(IndexFrom::Picked)
+    );
+    assert_eq!(card(&level.cards, "Delta").index_from, None);
+    assert_eq!(card(&level.cards, "Welcome.md").index_from, None);
+    let alpha = s.gv_children(&GvLevel::Folder(vp("Alpha"))).unwrap();
+    assert_eq!(
+        card(&alpha.cards, "Alpha/Sub").index_from,
+        Some(IndexFrom::Index)
+    );
+}
+
+/// M3b §4, §6: picking a folder's index note writes `.nimw/vault.json`
+/// (other keys kept) and answers the folder's new card; clearing removes it.
+#[test]
+fn m3b_index_pick_set_writes_the_pick_and_answers_the_card() {
+    let dir = vault();
+    std::fs::write(
+        dir.path().join(".nimw/vault.json"),
+        r#"{"version":1,"exclude":["Private/**"],"indexPicks":{"Gamma":"Gamma/b.md"},"future":{"x":1}}"#,
+    )
+    .unwrap();
+    let (_c, s) = open(dir.path());
+    let card = s
+        .index_pick_set(&vp("Delta"), Some(&vp("Delta/x.md")))
+        .unwrap();
+    assert_eq!(card.path, "Delta");
+    assert_eq!(card.kind, CardKind::Project);
+    assert_eq!(card.index_page.as_deref(), Some("Delta/x.md"));
+    assert_eq!(card.index_from, Some(IndexFrom::Picked));
+    let json: serde_json::Value = serde_json::from_str(
+        &std::fs::read_to_string(dir.path().join(".nimw/vault.json")).unwrap(),
+    )
+    .unwrap();
+    assert_eq!(json["indexPicks"]["Delta"], "Delta/x.md");
+    assert_eq!(json["indexPicks"]["Gamma"], "Gamma/b.md");
+    assert_eq!(json["exclude"][0], "Private/**");
+    assert_eq!(json["future"]["x"], 1);
+
+    let cleared = s.index_pick_set(&vp("Delta"), None).unwrap();
+    assert_eq!(cleared.index_page, None);
+    let json: serde_json::Value = serde_json::from_str(
+        &std::fs::read_to_string(dir.path().join(".nimw/vault.json")).unwrap(),
+    )
+    .unwrap();
+    assert!(json["indexPicks"].get("Delta").is_none());
+
+    // Only a visible folder, and a page directly inside it.
+    for (folder, page) in [
+        ("Delta", "Delta/Inner/i.md"),
+        ("Delta", "Alpha/note.md"),
+        ("Delta", "Delta/attachments/pic.png"),
+        ("Nope", "Nope/a.md"),
+        ("Welcome.md", "Welcome.md"),
+    ] {
+        assert!(
+            s.index_pick_set(&vp(folder), Some(&vp(page))).is_err(),
+            "{folder} ← {page}"
+        );
+    }
+}
+
+/// A vault with no `.nimw/` gets one only when something is picked (VLT-02).
+#[test]
+fn m3b_a_pick_creates_vault_json_lazily() {
+    let dir = vault();
+    std::fs::remove_dir_all(dir.path().join(".nimw")).unwrap();
+    let (_c, s) = open(dir.path());
+    s.index_pick_set(&vp("Delta"), None).unwrap();
+    assert!(
+        !dir.path().join(".nimw").exists(),
+        "clearing nothing writes nothing"
+    );
+    s.index_pick_set(&vp("Delta"), Some(&vp("Delta/y.md")))
+        .unwrap();
+    assert!(dir.path().join(".nimw/vault.json").exists());
+}
+
+/// M3b §4: picks follow renames of the folder and of the page.
+#[test]
+fn m3b_index_picks_follow_renames() {
+    let dir = vault();
+    let (_c, s) = open(dir.path());
+    s.rename(&vp("Gamma"), &vp("Gamma 2"), false).unwrap();
+    assert_eq!(
+        s.vault().index_picks().get("Gamma 2").map(String::as_str),
+        Some("Gamma 2/b.md")
+    );
+    s.rename(&vp("Gamma 2/b.md"), &vp("Gamma 2/home.md"), false)
+        .unwrap();
+    assert_eq!(
+        s.vault().index_picks().get("Gamma 2").map(String::as_str),
+        Some("Gamma 2/home.md")
+    );
+    let level = s.gv_children(&GvLevel::Vault).unwrap();
+    assert_eq!(
+        card(&level.cards, "Gamma 2").index_page.as_deref(),
+        Some("Gamma 2/home.md")
+    );
+}
+
+/// M3b §6: the wiki target a relationship writes — the shortest unique one.
+#[test]
+fn m3b_link_target_is_the_shortest_unique_wiki_target() {
+    let dir = vault();
+    write(dir.path(), "Beta/note.md", "# Another note\n");
+    let (_c, s) = open(dir.path());
+    assert_eq!(
+        s.link_target(&vp("Welcome.md"), &vp("zeta.md")).unwrap(),
+        "zeta"
+    );
+    // Two `note` pages: `[[note]]` resolves to the first by path order, so
+    // the other one needs its folder (as `link_suggest` writes it).
+    assert_eq!(
+        s.link_target(&vp("Welcome.md"), &vp("Alpha/note.md"))
+            .unwrap(),
+        "note"
+    );
+    assert_eq!(
+        s.link_target(&vp("Welcome.md"), &vp("Beta/note.md"))
+            .unwrap(),
+        "Beta/note"
+    );
+    assert!(matches!(
+        s.link_target(&vp("Welcome.md"), &vp("missing.md")),
+        Err(SessionError::NotIndexed(_))
+    ));
+}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p nimw-markdown m3b && cargo test -p nimw-session --test global_view && cargo test -p nimw-desktop --test commands`
Expected: FAIL — `frontmatter::tests::m3b_a_scalar_related_counts_as_a_one_item_list` panics (no link for `related: "[[Beta]]"`); `global_view` and `commands` do not compile / fail (`IndexFrom`, `index_pick_set`, `link_target` unknown; the commands list names two unregistered commands).

- [ ] **Step 3: Implement**

Modify `apps/desktop/src-tauri/build.rs` (apply this change):

```diff
@@ -33,6 +33,8 @@ const COMMANDS: &[&str] = &[
     "gv_edges",
     "layout_get",
     "layout_set",
+    "link_target",
+    "index_pick_set",
 ];
 
 fn main() {
```

Modify `apps/desktop/src-tauri/capabilities/main.json` (apply this change):

```diff
@@ -36,6 +36,8 @@
     "allow-gv-edges",
     "allow-layout-get",
     "allow-layout-set",
+    "allow-link-target",
+    "allow-index-pick-set",
     "core:event:allow-listen",
     "core:event:allow-unlisten",
     "core:window:allow-destroy",
```

Modify `apps/desktop/src-tauri/src/dto.rs` (apply this change):

```diff
@@ -190,6 +190,8 @@ pub struct GvCardDto {
     pub has_image: bool,
     pub has_audio: bool,
     pub index_page: Option<String>,
+    /// Folders: `"named" | "index" | "picked" | "only"` (M3b §4).
+    pub index_from: Option<&'static str>,
     pub pages: u32,
     pub folders: u32,
     pub child_titles: Vec<String>,
@@ -199,7 +201,7 @@ pub struct GvCardDto {
 
 impl From<nimw_session::GvCard> for GvCardDto {
     fn from(c: nimw_session::GvCard) -> GvCardDto {
-        use nimw_session::{CardKind, Relation};
+        use nimw_session::{CardKind, IndexFrom, Relation};
         GvCardDto {
             path: c.path,
             kind: match c.kind {
@@ -216,6 +218,12 @@ impl From<nimw_session::GvCard> for GvCardDto {
             has_image: c.has_image,
             has_audio: c.has_audio,
             index_page: c.index_page,
+            index_from: c.index_from.map(|f| match f {
+                IndexFrom::Named => "named",
+                IndexFrom::Index => "index",
+                IndexFrom::Picked => "picked",
+                IndexFrom::Only => "only",
+            }),
             pages: c.pages,
             folders: c.folders,
             child_titles: c.child_titles,
```

Modify `apps/desktop/src-tauri/src/gv_commands.rs` (apply this change):

```diff
@@ -1,7 +1,7 @@
 //! M3a §8: the Global View — levels and their cards, edges between visible
 //! cards, pinned card positions. Thin wrappers over `nimw-session`.
 
-use crate::dto::{GvEdgeDto, GvLevelDto, GvLevelResultDto};
+use crate::dto::{GvCardDto, GvEdgeDto, GvLevelDto, GvLevelResultDto};
 use crate::error::{CmdResult, CommandError, ErrorKind};
 use crate::state::AppState;
 use crate::vault_commands::blocking;
@@ -103,3 +103,51 @@ pub async fn layout_set<R: Runtime>(
     })
     .await
 }
+
+pub(crate) fn link_target_impl(
+    state: &AppState,
+    source: String,
+    target: String,
+) -> CmdResult<String> {
+    Ok(state
+        .session()?
+        .link_target(&VaultPath::new(&source)?, &VaultPath::new(&target)?)?)
+}
+
+pub(crate) fn index_pick_set_impl(
+    state: &AppState,
+    folder: String,
+    page: Option<String>,
+) -> CmdResult<GvCardDto> {
+    let page = page.as_deref().map(VaultPath::new).transpose()?;
+    Ok(state
+        .session()?
+        .index_pick_set(&VaultPath::new(&folder)?, page.as_ref())?
+        .into())
+}
+
+/// M3b §6: the shortest wiki target from `source` to the vault path `target`.
+#[tauri::command]
+pub async fn link_target<R: Runtime>(
+    app: AppHandle<R>,
+    source: String,
+    target: String,
+) -> CmdResult<String> {
+    blocking(app, move |app| {
+        link_target_impl(&app.state::<AppState>(), source, target)
+    })
+    .await
+}
+
+/// M3b §4: picks (or clears, `page: null`) a folder's index note.
+#[tauri::command]
+pub async fn index_pick_set<R: Runtime>(
+    app: AppHandle<R>,
+    folder: String,
+    page: Option<String>,
+) -> CmdResult<GvCardDto> {
+    blocking(app, move |app| {
+        index_pick_set_impl(&app.state::<AppState>(), folder, page)
+    })
+    .await
+}
```

Modify `apps/desktop/src-tauri/src/lib.rs` (apply this change):

```diff
@@ -112,6 +112,8 @@ pub fn configure<R: tauri::Runtime>(
         gv_commands::gv_edges,
         gv_commands::layout_get,
         gv_commands::layout_set,
+        gv_commands::link_target,
+        gv_commands::index_pick_set,
     ])
 }
```

Modify `apps/desktop/src/ipc/index.ts` (apply this change):

```diff
@@ -305,6 +305,10 @@ export interface GvCard {
   hasAudio: boolean;
   /** Folders: the page previewed on the card. */
   indexPage: string | null;
+  /** Folders: which GV-02 rule chose `indexPage` (M3b §4); a pick is offered
+   *  unless it is `named` or `index`. The backend always sends it; optional
+   *  only so card fixtures written before it needn't list it. */
+  indexFrom?: 'named' | 'index' | 'picked' | 'only' | null;
   pages: number;
   folders: number;
   childTitles: string[];
@@ -398,6 +402,12 @@ export const layoutGet = (level: string) =>
   call<Record<string, CardPosition>>('layout_get', { level });
 export const layoutSet = (level: string, positions: Record<string, CardPosition>) =>
   call<void>('layout_set', { level, positions });
+/** M3b §6: the shortest wiki target from `source` to the vault path `target`. */
+export const linkTarget = (source: string, target: string) =>
+  call<string>('link_target', { source, target });
+/** M3b §4: picks (or clears, `null`) a folder's index note; answers its card. */
+export const indexPickSet = (folder: string, page: string | null) =>
+  call<GvCard>('index_pick_set', { folder, page });
 export const vaultSettingsGet = () => call<VaultSettings>('vault_settings_get');
 export const vaultSettingsSet = (patch: VaultSettingsPatch) =>
   call<VaultSettings>('vault_settings_set', { patch });
```

Modify `crates/nimw-markdown/src/frontmatter.rs` (apply this change):

```diff
@@ -194,11 +194,15 @@ pub(crate) fn parse(src: &str, yaml: Range<usize>) -> Frontmatter {
                 }
             }
             Some("related") => {
-                if let Node::Seq(items) = value {
-                    for item in items {
-                        if let Some(link) = related_link(item, &locate) {
-                            fm.links.push(link);
-                        }
+                // A list of relationships, or one written without the list
+                // (M3b §5: parity with the TS reader).
+                let items: &[Node] = match value {
+                    Node::Seq(items) => items,
+                    single => std::slice::from_ref(single),
+                };
+                for item in items {
+                    if let Some(link) = related_link(item, &locate) {
+                        fm.links.push(link);
                     }
                 }
             }
@@ -318,6 +322,20 @@ mod tests {
         assert!(!f.links[0].directed);
     }
 
+    #[test]
+    fn m3b_a_scalar_related_counts_as_a_one_item_list() {
+        let one = fm("---\nrelated: \"[[Beta]]\"\n---\n");
+        assert_eq!(one.links.len(), 1);
+        assert_eq!(one.links[0].target, "Beta");
+        assert!(!one.links[0].directed);
+        let map = fm("---\nrelated: { link: \"[[Gamma]]\", label: why, directed: true }\n---\n");
+        assert_eq!(map.links.len(), 1);
+        assert_eq!(map.links[0].target, "Gamma");
+        assert_eq!(map.links[0].label.as_deref(), Some("why"));
+        assert!(map.links[0].directed);
+        assert!(fm("---\nrelated: not a link\n---\n").links.is_empty());
+    }
+
     #[test]
     fn malformed_yaml_sets_error_and_no_values() {
         let f = fm("---\ntags: [unclosed\nsubtitle: x\n---\n");
```

Modify `crates/nimw-session/Cargo.toml` (apply this change):

```diff
@@ -19,6 +19,7 @@ thiserror.workspace = true
 criterion.workspace = true
 nimw-testkit = { path = "../nimw-testkit" }
 proptest.workspace = true
+serde_json.workspace = true
 tempfile.workspace = true
 
 [[bench]]
```

Modify `crates/nimw-session/src/global_view.rs` (apply this change):

```diff
@@ -28,6 +28,20 @@ pub enum CardKind {
     Page,
 }
 
+/// Which GV-02 rule chose a folder's index note (M3b §4): a pick is offered
+/// only where rules 1–2 give nothing.
+#[derive(Debug, Clone, Copy, PartialEq, Eq)]
+pub enum IndexFrom {
+    /// Rule 1: a page named like the folder.
+    Named,
+    /// Rule 2: `index.md`.
+    Index,
+    /// Rule 3: `.nimw/vault.json` `indexPicks`.
+    Picked,
+    /// Rule 4: the folder's only page.
+    Only,
+}
+
 /// Where a page sits in another page's neighbourhood (layout side, §7).
 #[derive(Debug, Clone, Copy, PartialEq, Eq)]
 pub enum Relation {
@@ -55,6 +69,8 @@ pub struct GvCard {
     pub has_audio: bool,
     /// Folders: the page previewed on the card (GV-02).
     pub index_page: Option<String>,
+    /// Folders: the rule that chose `index_page`.
+    pub index_from: Option<IndexFrom>,
     /// Folders: direct pages and (visible) subfolders.
     pub pages: u32,
     pub folders: u32,
@@ -179,11 +195,18 @@ impl Ctx<'_> {
             Some(p) => self.index.card(p)?.filter(|r| r.kind == FileKind::Page),
             None => None,
         };
-        let index_row: Option<CardRow> = named_like
-            .or(index_md)
-            .map(|r| (*r).clone())
-            .or(picked)
-            .or_else(|| (pages.len() == 1 && subfolders.is_empty()).then(|| pages[0].clone()));
+        let only = (pages.len() == 1 && subfolders.is_empty()).then(|| pages[0].clone());
+        let (index_row, index_from) = if let Some(r) = named_like {
+            (Some((*r).clone()), Some(IndexFrom::Named))
+        } else if let Some(r) = index_md {
+            (Some((*r).clone()), Some(IndexFrom::Index))
+        } else if let Some(r) = picked {
+            (Some(r), Some(IndexFrom::Picked))
+        } else if let Some(r) = only {
+            (Some(r), Some(IndexFrom::Only))
+        } else {
+            (None, None)
+        };
         let mut card = match &index_row {
             Some(row) => page_card(row, None),
             None => GvCard {
@@ -198,6 +221,7 @@ impl Ctx<'_> {
                 has_image: false,
                 has_audio: false,
                 index_page: None,
+                index_from: None,
                 pages: 0,
                 folders: 0,
                 child_titles: Vec::new(),
@@ -207,6 +231,7 @@ impl Ctx<'_> {
         card.path = folder.path.clone();
         card.kind = kind;
         card.index_page = index_row.map(|r| r.path);
+        card.index_from = index_from;
         card.pages = pages.len() as u32;
         card.folders = subfolders.len() as u32;
         card.child_titles = child_titles;
@@ -214,6 +239,64 @@ impl Ctx<'_> {
     }
 }
 
+impl VaultSession {
+    /// Picks (`Some`) or clears (`None`) the index note of `folder`, a
+    /// visible folder; the page must be a page directly inside it (M3b §4,
+    /// §6). Answers the folder's card as the Global View now shows it.
+    pub fn index_pick_set(&self, folder: &VaultPath, page: Option<&VaultPath>) -> Result<GvCard> {
+        let row = {
+            let index = self.index();
+            let row = index
+                .card(folder.as_str())?
+                .filter(|r| r.kind == FileKind::Folder)
+                .ok_or_else(|| SessionError::NotIndexed(folder.to_string()))?;
+            if let Some(page) = page {
+                let inside = page.parent().is_some_and(|p| p.as_str() == folder.as_str());
+                let is_page = index
+                    .card(page.as_str())?
+                    .is_some_and(|r| r.kind == FileKind::Page);
+                if !inside || !is_page {
+                    return Err(SessionError::NotIndexed(page.to_string()));
+                }
+            }
+            row
+        };
+        self.vault
+            .set_index_pick(folder.as_str(), page.map(VaultPath::as_str))?;
+        let policy = self.vault.attachment_policy();
+        let picks = self.vault.index_picks();
+        let index = self.index();
+        let ctx = Ctx {
+            index: &index,
+            policy: &policy,
+            picks: &picks,
+        };
+        let kind = if folder.as_str().contains('/') {
+            CardKind::Folder
+        } else {
+            CardKind::Project
+        };
+        ctx.folder_card(&row, kind)
+    }
+
+    /// The wiki target a relationship from `source` to `target` writes: the
+    /// shortest one that resolves back to `target` (M3b §2, §6).
+    pub fn link_target(&self, source: &VaultPath, target: &VaultPath) -> Result<String> {
+        let index = self.index();
+        if index.card(target.as_str())?.is_none() {
+            return Err(SessionError::NotIndexed(target.to_string()));
+        }
+        let files = index.file_set()?;
+        Ok(nimw_markdown::shortest_unique_target(
+            target.as_str(),
+            source.as_str(),
+            &files,
+            LinkKind::FrontmatterRelated,
+            false,
+        ))
+    }
+}
+
 /// A page's card data from its index row.
 fn page_card(row: &CardRow, relation: Option<Relation>) -> GvCard {
     let remote = row.cover.as_deref().is_some_and(has_scheme);
@@ -229,6 +312,7 @@ fn page_card(row: &CardRow, relation: Option<Relation>) -> GvCard {
         has_image: row.has_image,
         has_audio: row.has_audio,
         index_page: None,
+        index_from: None,
         pages: 0,
         folders: 0,
         child_titles: Vec::new(),
@@ -358,7 +442,9 @@ impl VaultSession {
     /// one layout update (final review I3). The layout is a convenience: a
     /// failure is reported, never fails the rename.
     pub(crate) fn follow_layout(&self, renames: &[(String, String)]) {
-        if let Err(e) = self.vault.remap_layout_many(renames) {
+        // Index-note picks follow too (M3b §4).
+        let picks = self.vault.remap_index_picks_many(renames);
+        if let Err(e) = self.vault.remap_layout_many(renames).and(picks) {
             let what = match renames {
                 [(from, to)] => format!("{from} → {to}"),
                 _ => format!("{} renamed entries", renames.len()),
```

Modify `crates/nimw-session/src/lib.rs` (apply this change):

```diff
@@ -14,7 +14,7 @@ pub use attachments::{Attached, LinkSuggestion, cover_reference, sanitize_file_n
 pub use error::{Result, SessionError};
 pub use events::{IndexReport, RenameOutcome, SessionEvent};
 pub use global_view::{
-    CardKind, EdgeKind, GvCard, GvChildren, GvEdge, GvLevel, MAX_NEIGHBOURS, MAX_VISIBLE, Relation,
-    SUMMARY_TITLES,
+    CardKind, EdgeKind, GvCard, GvChildren, GvEdge, GvLevel, IndexFrom, MAX_NEIGHBOURS,
+    MAX_VISIBLE, Relation, SUMMARY_TITLES,
 };
 pub use session::{VaultSession, index_db_path};
```

Modify `crates/nimw-vault/src/layout.rs` (apply this change):

```diff
@@ -169,6 +169,37 @@ impl Vault {
         })
     }
 
+    /// Index-note picks (`.nimw/vault.json` `indexPicks`) follow a batch of
+    /// renames, folder keys and page values alike (M3b §4); one write, and
+    /// none when nothing moved.
+    pub fn remap_index_picks_many(&self, renames: &[(String, String)]) -> Result<()> {
+        if renames.is_empty() {
+            return Ok(());
+        }
+        let moves: HashMap<&str, &str> = renames
+            .iter()
+            .map(|(from, to)| (from.as_str(), to.as_str()))
+            .collect();
+        self.update_json_object(crate::vault::NIMW_JSON, false, |map| {
+            let Some(picks) = map
+                .get_mut("indexPicks")
+                .and_then(serde_json::Value::as_object_mut)
+            else {
+                return;
+            };
+            for (folder, page) in std::mem::take(picks) {
+                let page = match page {
+                    serde_json::Value::String(p) => {
+                        serde_json::Value::String(remap(&p, &moves).unwrap_or(p))
+                    }
+                    other => other,
+                };
+                let folder = remap(&folder, &moves).unwrap_or(folder);
+                picks.insert(folder, page);
+            }
+        })
+    }
+
     /// True when `path` names something on disk (`""`: the vault).
     fn path_exists(&self, path: &str) -> bool {
         path.is_empty()
```

Modify `crates/nimw-vault/src/vault.rs` (apply this change):

```diff
@@ -205,6 +205,33 @@ impl Vault {
         nimw.index_picks
     }
 
+    /// Picks (`Some`) or clears (`None`) `folder`'s index note in
+    /// `.nimw/vault.json` (M3b §4), keeping every other key. Clearing a pick
+    /// that isn't there writes nothing, and a vault without the file gets one
+    /// only for a pick (VLT-02).
+    pub fn set_index_pick(&self, folder: &str, page: Option<&str>) -> Result<()> {
+        self.update_json_object(NIMW_JSON, page.is_some(), |map| {
+            let picks = map
+                .entry("indexPicks")
+                .or_insert_with(|| serde_json::Value::Object(Default::default()));
+            if !picks.is_object() {
+                *picks = serde_json::Value::Object(Default::default());
+            }
+            let picks = picks.as_object_mut().expect("an object");
+            match page {
+                Some(page) => {
+                    picks.insert(folder.to_string(), page.into());
+                }
+                None => {
+                    picks.remove(folder);
+                }
+            }
+            if picks.is_empty() {
+                map.remove("indexPicks");
+            }
+        })
+    }
+
     /// Non-fatal configuration problems found while opening.
     pub fn warnings(&self) -> &[String] {
         &self.warnings
```

Note: `[[note]]` with two `note.md` pages resolves to the first by path order, so `link_target` answers `note` for that one and `Beta/note` for the other (the existing `shortest_unique_target` rule, as `link_suggest` writes it). `nimw-session` gains `serde_json` as a dev-dependency for the tests. `build.rs` regenerates `permissions/autogenerated/{link_target,index_pick_set}.toml` — commit them.

- [ ] **Step 4: Run them to see them pass**

Run: `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check && pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/ipc/globalView.test.ts`
Expected: PASS — every crate green (`global_view`: 17 passed, 2 ignored; `commands`: 31 passed); clippy and fmt clean; `Tests  2 passed (2)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/build.rs apps/desktop/src-tauri/capabilities/main.json apps/desktop/src-tauri/src/dto.rs apps/desktop/src-tauri/src/gv_commands.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tests/commands.rs apps/desktop/src/ipc/globalView.test.ts apps/desktop/src/ipc/index.ts crates/nimw-markdown/src/frontmatter.rs crates/nimw-session/Cargo.toml crates/nimw-session/src/global_view.rs crates/nimw-session/src/lib.rs crates/nimw-session/tests/global_view.rs crates/nimw-vault/src/layout.rs crates/nimw-vault/src/vault.rs
git commit -F - <<'MSG'
feat(global-view): index-note picks and relationship link targets over IPC; scalar related: indexed (M3b §4–§6)

- nimw-markdown: a scalar `related:` (string or map) counts as a
  one-item list, in parity with the TS reader.
- nimw-vault: set_index_pick (lazy .nimw/vault.json, other keys kept,
  no write when nothing changes) and remap_index_picks_many.
- nimw-session: GvCard.index_from (which GV-02 rule chose the index
  note), index_pick_set (a visible folder, a page directly inside it;
  answers the folder's card), link_target (shortest unique wiki
  target); picks follow in-app and watcher renames with the layout.
- Commands link_target and index_pick_set with real-ACL tests; TS
  wrappers and GvCard.indexFrom.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 3: related: operations — read, append, edit, delete; read back or refused

Spec §5.

**Files:**
- Modify: `apps/desktop/src/markdown/frontmatter.ts`
- Modify: `apps/desktop/src/markdown/frontmatterEdit.ts`
- Create: `apps/desktop/src/markdown/related.test.ts`
- Create: `apps/desktop/src/markdown/related.ts`

**Interfaces:**
- Consumes: `frontmatterEdit.ts` (now exporting `confirmedBlock`, `readsBackAs`, `data`, `lineStart`, `lineEnd`, `unconfirmedBlock`).
- Produces: `markdown/related.ts`: `readRelated(text): RelatedEntry[]` (`{ index, link, target, label, directed }`), `appendRelated(text, target)`, `updateRelated(text, index, { label, directed })`, `removeRelated(text, index)` → `FrontmatterEdit`.

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/src/markdown/related.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { frontmatterLinks, readFrontmatter } from './frontmatter';
import { parsePage } from './parse';
import { appendRelated, readRelated, removeRelated, updateRelated } from './related';
import type { FrontmatterEdit } from './frontmatterEdit';

const apply = (text: string, edit: FrontmatterEdit): string => {
  if (!edit.ok) throw new Error('refused');
  const c = edit.change;
  return c ? text.slice(0, c.from) + c.insert + text.slice(c.to) : text;
};

/** The note's frontmatter as data. */
const data = (text: string) => {
  const m = /^---\n([\s\S]*?\n)?---(?:\n|$)/.exec(text);
  return m ? (parseYaml(m[1] ?? '') ?? {}) : {};
};

describe('reading related: (M3b §5)', () => {
  it('lists string and map entries with their targets, labels and arrows', () => {
    const text =
      '---\nrelated:\n  - "[[Sparda]]"\n  - { link: "[[Game 1#Plan|the game]]", label: playable, directed: true }\n  - link: "[[Z]]"\n    label: zed\n  - not a link\n---\nBody\n';
    expect(readRelated(text)).toEqual([
      { index: 0, link: '[[Sparda]]', target: 'Sparda', label: null, directed: false },
      {
        index: 1,
        link: '[[Game 1#Plan|the game]]',
        target: 'Game 1',
        label: 'playable',
        directed: true,
      },
      { index: 2, link: '[[Z]]', target: 'Z', label: 'zed', directed: false },
    ]);
  });

  it('reads a single relationship written without a list, and a flow list', () => {
    expect(readRelated('---\nrelated: "[[A]]"\n---\n').map((e) => e.target)).toEqual(['A']);
    expect(readRelated('---\nrelated: ["[[A]]", "[[B]]"]\n---\n').map((e) => e.target)).toEqual([
      'A',
      'B',
    ]);
    expect(readRelated('# No frontmatter\n')).toEqual([]);
    expect(readRelated('---\nrelated: [oops\n---\n')).toEqual([]);
  });

  it('the link reader counts a scalar related: too (parity with nimw-markdown)', () => {
    const fm = readFrontmatter(parsePage('---\nrelated: "[[A]]"\n---\n# x\n').tree);
    expect(frontmatterLinks(fm).map((l) => [l.kind, l.target])).toEqual([['related', 'A']]);
  });
});

describe('appending a relationship (M3b §2, §5)', () => {
  it('starts a frontmatter block when the note has none', () => {
    expect(apply('# Title\n', appendRelated('# Title\n', 'Sparda'))).toBe(
      '---\nrelated:\n  - "[[Sparda]]"\n---\n# Title\n',
    );
  });

  it('adds the key after the others, leaving them byte for byte', () => {
    const text = "---\ntitle: 'Rex'   # kept\ntags: [a, b]\n---\nBody\n";
    expect(apply(text, appendRelated(text, 'Sparda'))).toBe(
      '---\ntitle: \'Rex\'   # kept\ntags: [a, b]\nrelated:\n  - "[[Sparda]]"\n---\nBody\n',
    );
  });

  it('adds an item after the last one, with the list’s own indentation', () => {
    const text = '---\nrelated:\n    - "[[A]]"\n    - link: "[[B]]"\n      label: x\nz: 1\n---\n';
    expect(apply(text, appendRelated(text, 'C'))).toBe(
      '---\nrelated:\n    - "[[A]]"\n    - link: "[[B]]"\n      label: x\n    - "[[C]]"\nz: 1\n---\n',
    );
  });

  it('turns a flow list or a single value into a block list', () => {
    const flow = '---\nrelated: ["[[A]]", { link: "[[B]]", label: x }]\nz: 1\n---\n';
    expect(apply(flow, appendRelated(flow, 'C'))).toBe(
      '---\nrelated:\n  - "[[A]]"\n  - { link: "[[B]]", label: x }\n  - "[[C]]"\nz: 1\n---\n',
    );
    const one = '---\nrelated: "[[A]]"\n---\n';
    expect(apply(one, appendRelated(one, 'C'))).toBe(
      '---\nrelated:\n  - "[[A]]"\n  - "[[C]]"\n---\n',
    );
    // An empty key (as templates leave it) gets its first item.
    const empty = '---\nrelated:\nz: 1\n---\n';
    expect(apply(empty, appendRelated(empty, 'C'))).toBe('---\nrelated:\n  - "[[C]]"\nz: 1\n---\n');
  });

  it('refuses frontmatter it can’t edit safely, and never doubles a block', () => {
    expect(appendRelated('---\nrelated: [oops\n---\n', 'A')).toEqual({ ok: false });
    expect(appendRelated('---\nx: &a [1]\nrelated: *a\n---\n', 'A')).toEqual({ ok: false });
    expect(appendRelated('---\r\nrelated: []\r\n---\r\n', 'A')).toEqual({ ok: false });
  });
});

describe('editing and deleting a relationship (M3b §3, §5)', () => {
  const text =
    '---\nrelated:\n  - "[[A]]"   # first\n  - { link: "[[B]]", label: old, directed: true }\n  - link: "[[C]]"\n    label: multi\nz: 1\n---\nBody\n';

  it('a label or an arrow turns a string into a map; removing both turns it back', () => {
    const labelled = apply(text, updateRelated(text, 0, { label: 'inspired by', directed: false }));
    expect(labelled).toContain('  - { link: "[[A]]", label: inspired by }   # first\n');
    const plain = apply(text, updateRelated(text, 1, { label: null, directed: false }));
    expect(plain).toContain('  - "[[B]]"\n');
    const arrow = apply(text, updateRelated(text, 2, { label: 'multi', directed: true }));
    expect(arrow).toContain('  - { link: "[[C]]", label: multi, directed: true }\nz: 1\n');
    expect(data(arrow).z).toBe(1);
  });

  it('labels with commas, colons or line breaks stay one valid item', () => {
    const out = apply(text, updateRelated(text, 0, { label: 'a, b: c\n d', directed: false }));
    expect(data(out).related[0]).toEqual({ link: '[[A]]', label: 'a, b: c d' });
  });

  it('deleting removes the item’s lines; the last one removes the key', () => {
    const one = apply(text, removeRelated(text, 1));
    expect(one).toBe(
      '---\nrelated:\n  - "[[A]]"   # first\n  - link: "[[C]]"\n    label: multi\nz: 1\n---\nBody\n',
    );
    const multi = apply(text, removeRelated(text, 2));
    expect(multi).toBe(
      '---\nrelated:\n  - "[[A]]"   # first\n  - { link: "[[B]]", label: old, directed: true }\nz: 1\n---\nBody\n',
    );
    const last = '---\ntitle: x\nrelated:\n  - "[[A]]"\n---\nBody\n';
    expect(apply(last, removeRelated(last, 0))).toBe('---\ntitle: x\n---\nBody\n');
    const only = '---\nrelated: "[[A]]"\n---\nBody\n';
    expect(apply(only, removeRelated(only, 0))).toBe('Body\n');
    const flow = '---\nrelated: ["[[A]]", "[[B]]"]\n---\n';
    expect(data(apply(flow, removeRelated(flow, 0))).related).toEqual(['[[B]]']);
  });

  it('an index that isn’t there is refused', () => {
    expect(removeRelated(text, 7)).toEqual({ ok: false });
    expect(updateRelated(text, -1, { label: null, directed: false })).toEqual({ ok: false });
  });
});

describe('sweep: every relationship edit reads back exactly or is refused', () => {
  const texts = [
    '# none\n',
    '---\n---\nBody\n',
    '---\ntitle: x\n---\n',
    '---\nrelated:\n  - "[[A]]"\n---\n',
    '---\nrelated:\n- "[[A]]"\n- "[[B]]"\n---\n',
    '---\nrelated: ["[[A]]"]\n---\n',
    '---\nrelated: "[[A]]"\n---\n',
    '---\nrelated: { link: "[[A]]", label: x }\n---\n',
    '---\nrelated:\n  - link: "[[A]]"\n    directed: true\n  # a comment\n  - "[[B]]"\nz: [1, 2]\n---\n',
    '---\nrelated:\n---\n',
    '---\nrelated: []\n---\n',
    '---\n  related:\n    - "[[A]]"\n  y: 1\n---\n',
    '---\nrelated: |\n  [[A]]\n---\n',
    '---\nrelated: [oops\n---\n',
  ];
  it.each(texts)('%j', (text) => {
    const ops: [string, (t: string) => FrontmatterEdit][] = [
      ['append', (t) => appendRelated(t, 'New')],
      ['label 0', (t) => updateRelated(t, 0, { label: 'why, not', directed: true })],
      ['plain 0', (t) => updateRelated(t, 0, { label: null, directed: false })],
      ['remove 0', (t) => removeRelated(t, 0)],
      ['remove 1', (t) => removeRelated(t, 1)],
    ];
    for (const [name, op] of ops) {
      const edit = op(text);
      if (!edit.ok) continue;
      const out = apply(text, edit);
      // The result parses, and the body after the block is untouched.
      expect(() => data(out), name).not.toThrow();
      expect(parsePage(out).frontmatter?.error, name).toBeUndefined();
      const body = (t: string) => t.replace(/^---\n[\s\S]*?\n?---(?:\n|$)/, '');
      expect(body(out), name).toBe(body(text));
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/markdown/related.test.ts`
Expected: FAIL — `Failed to resolve import "./related"`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/markdown/frontmatter.ts` (apply this change):

```diff
@@ -35,7 +35,12 @@ export function frontmatterLinks(fm: Frontmatter | null): LinkRef[] {
       range: fm.range,
     });
   }
-  const related = Array.isArray(data.related) ? data.related : [];
+  // A list, or one relationship written without it (M3b §5, as nimw-markdown).
+  const related = Array.isArray(data.related)
+    ? data.related
+    : data.related !== undefined && data.related !== null
+      ? [data.related]
+      : [];
   for (const item of related) {
     const raw =
       typeof item === 'string'
```

Modify `apps/desktop/src/markdown/frontmatterEdit.ts` (apply this change):

```diff
@@ -25,7 +25,7 @@ const BLOCK = /^---\n(?:[\s\S]*?\n)?---(?:\n|$)/;
  *  or a `---` line (trailing spaces allowed) with a later `---` / `...` line
  *  that some reader (remark, nimw-markdown, Obsidian) could take as its end.
  *  A new block in front of it would hide it from one reader or another. */
-function unconfirmedBlock(text: string): boolean {
+export function unconfirmedBlock(text: string): boolean {
   const open = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
   if (!open) return false;
   return text.startsWith('\uFEFF') || /^(?:---|\.\.\.)[ \t]*\r?$/m.test(text.slice(open[0].length));
@@ -42,7 +42,7 @@ function scalar(value: string | number): string {
 }
 
 /** End of the line `end` falls in (after its `\n`). */
-function lineEnd(src: string, end: number): number {
+export function lineEnd(src: string, end: number): number {
   if (end > 0 && src[end - 1] === '\n') return end;
   const nl = src.indexOf('\n', end);
   return nl === -1 ? src.length : nl + 1;
@@ -50,7 +50,7 @@ function lineEnd(src: string, end: number): number {
 
 /** Start of the line `pos` falls in when only spaces precede it there
  *  (a key's indentation), else `pos`. */
-function lineStart(src: string, pos: number): number {
+export function lineStart(src: string, pos: number): number {
   const start = pos === 0 ? 0 : src.lastIndexOf('\n', pos - 1) + 1;
   return /^ *$/.test(src.slice(start, pos)) ? start : pos;
 }
@@ -64,7 +64,7 @@ const own = (o: Record<string, unknown>, key: string): unknown =>
   Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
 
 /** Frontmatter source as data, or `null` when it isn't a valid mapping. */
-function data(src: string): Record<string, unknown> | null {
+export function data(src: string): Record<string, unknown> | null {
   const doc = parseDocument(src);
   if (doc.errors.length) return null;
   const json: unknown = doc.toJSON() ?? {};
@@ -73,20 +73,25 @@ function data(src: string): Record<string, unknown> | null {
     : null;
 }
 
-/** Whether the edited frontmatter `next` reads back as `src` with `patch`
- *  applied (no other key changes, nothing is added), both as remark reads it
- *  (without the block's last line break) and as nimw-markdown and Obsidian do. */
-function readsBack(src: string, next: string, patch: FrontmatterPatch): boolean {
+/** Whether the edited frontmatter `next` reads back as `want(before)` — the
+ *  data `src` held with the edit applied: no other key changes, nothing is
+ *  added — both as remark reads it (without the block's last line break) and
+ *  as nimw-markdown and Obsidian do. `want` answering `null` refuses. */
+export function readsBackAs(
+  src: string,
+  next: string,
+  want: (before: Record<string, unknown>) => Record<string, unknown> | null,
+): boolean {
   try {
     for (const view of [(s: string) => s, (s: string) => s.replace(/\n$/, '')]) {
       const before = data(view(src));
       const after = data(view(next));
       if (!before || !after) return false;
-      const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(patch)]);
+      const wanted = want(before);
+      if (!wanted) return false;
+      const keys = new Set([...Object.keys(after), ...Object.keys(wanted)]);
       for (const key of keys) {
-        const p = own(patch, key) as string | number | null | undefined;
-        const want = p === undefined ? own(before, key) : p === null ? undefined : oneLine(p);
-        if (JSON.stringify(own(after, key)) !== JSON.stringify(want)) return false;
+        if (JSON.stringify(own(after, key)) !== JSON.stringify(own(wanted, key))) return false;
       }
     }
     return true;
@@ -95,13 +100,42 @@ function readsBack(src: string, next: string, patch: FrontmatterPatch): boolean
   }
 }
 
+/** `src`'s data with `patch` applied (`null` deletes a key). */
+function patched(
+  before: Record<string, unknown>,
+  patch: FrontmatterPatch,
+): Record<string, unknown> {
+  const out: Record<string, unknown> = { ...before };
+  for (const [key, value] of Object.entries(patch)) {
+    if (value === null) delete out[key];
+    else out[key] = oneLine(value);
+  }
+  return out;
+}
+
+function readsBack(src: string, next: string, patch: FrontmatterPatch): boolean {
+  return readsBackAs(src, next, (before) => patched(before, patch));
+}
+
+/** The note's confirmed frontmatter block: its text, where its inside lies
+ *  and that inside (`src`); `null` without one. */
+export function confirmedBlock(
+  text: string,
+): { block: string; innerFrom: number; innerTo: number; src: string } | null {
+  const m = BLOCK.exec(text);
+  const block = m && parsePage(m[0]).frontmatter ? m[0] : null;
+  if (!block) return null;
+  const innerFrom = 4;
+  const innerTo = block.length - (block.endsWith('\n') ? 4 : 3);
+  return { block, innerFrom, innerTo, src: text.slice(innerFrom, innerTo) };
+}
+
 /** Applies `patch` to the note's frontmatter; `change` is `null` when nothing
  *  changes. A note without frontmatter gets a new block at the top; a block
  *  left without any content is removed. */
 export function setFrontmatter(text: string, patch: FrontmatterPatch): FrontmatterEdit {
-  const m = BLOCK.exec(text);
-  const block = m && parsePage(m[0]).frontmatter ? m[0] : null;
-  if (!block) {
+  const found = confirmedBlock(text);
+  if (!found) {
     if (unconfirmedBlock(text)) return { ok: false };
     const lines = Object.entries(patch)
       .filter((e): e is [string, string | number] => e[1] !== null)
@@ -109,9 +143,7 @@ export function setFrontmatter(text: string, patch: FrontmatterPatch): Frontmatt
     if (!lines.length) return { ok: true, change: null };
     return { ok: true, change: { from: 0, to: 0, insert: `---\n${lines.join('')}---\n` } };
   }
-  const innerFrom = 4;
-  const innerTo = block.length - (block.endsWith('\n') ? 4 : 3);
-  const src = text.slice(innerFrom, innerTo);
+  const { block, innerFrom, innerTo, src } = found;
   const doc = parseDocument(src);
   if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) return { ok: false };
   const pairs = (isMap(doc.contents) ? doc.contents.items : []) as Pair[];
```

Create `apps/desktop/src/markdown/related.ts`:

```ts
// Relationships (M3b §5, GV-22–24): the `related:` list of a page's
// frontmatter. A plain relationship is the string "[[Page]]"; a labelled or
// directed one is a map { link: "[[Page]]", label: …, directed: true }.
// Edits keep M2c's guarantees: only the touched item's text changes (or the
// `related:` pair when its form must change), and every edit is read back and
// refused unless the data is exactly what was asked for.
import { isMap, isScalar, isSeq, parseDocument, stringify, type Pair } from 'yaml';
import {
  confirmedBlock,
  data,
  lineEnd,
  lineStart,
  readsBackAs,
  unconfirmedBlock,
  type FrontmatterEdit,
} from './frontmatterEdit';

/** One relationship as written in `related:`. */
export interface RelatedEntry {
  /** Position in the list (a single value written without a list: 0). */
  index: number;
  /** The link as written, `[[Target#Heading|alias]]`. */
  link: string;
  /** Its target, as `[[Target]]` names it. */
  target: string;
  label: string | null;
  directed: boolean;
}

/** What a relationship's label and arrow become. */
export interface RelatedChange {
  label: string | null;
  directed: boolean;
}

const WIKI = /^\s*\[\[([^\]]+)\]\]\s*$/;

/** The `related:` value as a list (a single value is a one-item list). */
const asList = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const linkOf = (item: unknown): string | null =>
  typeof item === 'string'
    ? item
    : item && typeof item === 'object' && typeof (item as { link?: unknown }).link === 'string'
      ? (item as { link: string }).link
      : null;

/** The relationships a note's frontmatter holds, in order. */
export function readRelated(text: string): RelatedEntry[] {
  const found = confirmedBlock(text);
  const fm = found ? data(found.src) : null;
  if (!fm) return [];
  return asList(fm.related).flatMap((item, index) => {
    const link = linkOf(item);
    const m = link ? WIKI.exec(link) : null;
    if (!link || !m) return [];
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (!target) return [];
    const map = typeof item === 'object' && item ? (item as Record<string, unknown>) : {};
    const label = typeof map.label === 'string' && map.label.trim() ? map.label : null;
    const directed = map.directed === true || map.directed === 'true';
    return [{ index, link: link.trim(), target, label, directed }];
  });
}

/** One list item: the string form, or the map form when it has a label or an
 *  arrow (flow style, so the item stays one line). */
function itemYaml(link: string, change: RelatedChange): string {
  const label = change.label?.replace(/\s*\n\s*/g, ' ').trim() || null;
  if (!label && !change.directed) return stringify(link, { lineWidth: 0 }).replace(/\n$/, '');
  const map: Record<string, unknown> = { link };
  if (label) map.label = label;
  if (change.directed) map.directed = true;
  return stringify(map, { collectionStyle: 'flow', lineWidth: 0 }).replace(/\n$/, '');
}

/** The data `related:` should hold after the edit, given what it held. */
type Want = (items: unknown[]) => unknown[] | null;

type Range = [number, number, number];

/** Edits `related:` in `text`: `edit` gets the frontmatter inside (`src`),
 *  the related pair (if any) and the map's key indentation, and answers the
 *  new inside; `want` says what the list must read back as. */
function editRelated(
  text: string,
  want: Want,
  edit: (src: string, pair: Pair | null, indent: string) => string | null,
): FrontmatterEdit {
  const found = confirmedBlock(text);
  if (!found) {
    if (unconfirmedBlock(text)) return { ok: false };
    const items = want([]);
    if (!items || !items.length) return items ? { ok: true, change: null } : { ok: false };
    const next = edit('', null, '');
    if (next === null) return { ok: false };
    return { ok: true, change: { from: 0, to: 0, insert: `---\n${next}---\n` } };
  }
  const { block, innerFrom, innerTo, src } = found;
  const doc = parseDocument(src);
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) return { ok: false };
  const pairs = (isMap(doc.contents) ? doc.contents.items : []) as Pair[];
  const pair = pairs.find((p) => isScalar(p.key) && p.key.value === 'related') ?? null;
  const first = pairs[0]?.key as { range?: Range } | undefined;
  const indent = first?.range ? src.slice(lineStart(src, first.range[0]), first.range[0]) : '';
  const next = edit(src, pair, indent);
  if (next === null) return { ok: false };
  if (next === src) return { ok: true, change: null };
  const ok = readsBackAs(src, next, (before) => {
    const items = want(asList(before.related));
    if (!items) return null;
    const out = { ...before };
    if (items.length) out.related = items;
    else delete out.related;
    return out;
  });
  if (!ok) return { ok: false };
  if (!next.trim()) return { ok: true, change: { from: 0, to: block.length, insert: '' } };
  return { ok: true, change: { from: innerFrom, to: innerTo, insert: next } };
}

/** The `related:` pair as a block list of `items` (source text each), from
 *  the key to the end of its value's line. */
function rewritePair(src: string, pair: Pair, indent: string, items: string[]): string {
  const k = pair.key as { range: Range };
  const v = pair.value as { range?: Range } | null;
  const end = lineEnd(src, v?.range?.[1] ?? k.range[1]);
  const from = lineStart(src, k.range[0]);
  const body = items.length
    ? `${indent}related:\n${items.map((i) => `${indent}  - ${i}\n`).join('')}`
    : '';
  return src.slice(0, from) + body + src.slice(end);
}

/** Source text of each item of the `related:` value (a single value: one). */
function itemSources(src: string, pair: Pair): string[] | null {
  const v = pair.value as { range?: Range } | null;
  if (!v || !v.range) return [];
  if (isSeq(pair.value)) {
    const out: string[] = [];
    for (const item of pair.value.items as { range?: Range }[]) {
      if (!item?.range) return null;
      const text = src.slice(item.range[0], item.range[1]).trimEnd();
      if (text.includes('\n')) return null; // a block map item: no one-line form
      out.push(text);
    }
    return out;
  }
  const text = src.slice(v.range[0], v.range[1]).trimEnd();
  // An empty value (`related:` as templates leave it) holds no item.
  if (!text && isScalar(pair.value) && pair.value.value === null) return [];
  return text && !text.includes('\n') ? [text] : null;
}

/** Appends a relationship to `[[target]]` (M3b §2). */
export function appendRelated(text: string, target: string): FrontmatterEdit {
  const link = `[[${target}]]`;
  const yaml = itemYaml(link, { label: null, directed: false });
  return editRelated(
    text,
    (items) => [...items, link],
    (src, pair, indent) => {
      if (!pair) {
        const base = src && !src.endsWith('\n') ? `${src}\n` : src;
        return `${base}${indent}related:\n${indent}  - ${yaml}\n`;
      }
      if (isSeq(pair.value) && !pair.value.flow && pair.value.items.length) {
        const items = pair.value.items as { range: Range }[];
        const firstItem = items[0].range[0];
        const prefix = src.slice(src.lastIndexOf('\n', firstItem - 1) + 1, firstItem);
        if (!/^ *- +$/.test(prefix)) return null;
        const at = lineEnd(src, items[items.length - 1].range[1]);
        const nl = at > 0 && src[at - 1] !== '\n' ? '\n' : '';
        return `${src.slice(0, at)}${nl}${prefix}${yaml}\n${src.slice(at)}`;
      }
      const sources = itemSources(src, pair);
      return sources ? rewritePair(src, pair, indent, [...sources, yaml]) : null;
    },
  );
}

/** Changes the label and arrow of relationship `index` (M3b §3). */
export function updateRelated(text: string, index: number, change: RelatedChange): FrontmatterEdit {
  const entry = readRelated(text).find((e) => e.index === index);
  if (!entry) return { ok: false };
  const yaml = itemYaml(entry.link, change);
  const label = change.label?.replace(/\s*\n\s*/g, ' ').trim() || null;
  const value: unknown =
    !label && !change.directed
      ? entry.link
      : { link: entry.link, ...(label && { label }), ...(change.directed && { directed: true }) };
  return editRelated(
    text,
    (items) => (index < items.length ? items.map((it, i) => (i === index ? value : it)) : null),
    (src, pair, indent) => {
      if (!pair) return null;
      if (isSeq(pair.value) && !pair.value.flow) {
        const item = pair.value.items[index] as { range?: Range } | undefined;
        if (!item?.range) return null;
        let end = item.range[1];
        while (end > item.range[0] && /\s/.test(src[end - 1])) end--;
        return src.slice(0, item.range[0]) + yaml + src.slice(end);
      }
      const sources = itemSources(src, pair);
      if (!sources || index >= sources.length) return null;
      return rewritePair(
        src,
        pair,
        indent,
        sources.map((s, i) => (i === index ? yaml : s)),
      );
    },
  );
}

/** Deletes relationship `index`; the last one removes the key (M3b §3). */
export function removeRelated(text: string, index: number): FrontmatterEdit {
  if (!readRelated(text).some((e) => e.index === index)) return { ok: false };
  return editRelated(
    text,
    (items) => (index < items.length ? items.filter((_, i) => i !== index) : null),
    (src, pair, indent) => {
      if (!pair) return null;
      if (isSeq(pair.value) && !pair.value.flow && pair.value.items.length > 1) {
        const item = pair.value.items[index] as { range?: Range } | undefined;
        if (!item?.range) return null;
        const from = src.lastIndexOf('\n', item.range[0] - 1) + 1;
        if (!/^ *- +$/.test(src.slice(from, item.range[0]))) return null;
        let end = item.range[1];
        while (end > item.range[0] && /\s/.test(src[end - 1])) end--;
        return src.slice(0, from) + src.slice(lineEnd(src, end));
      }
      const sources = itemSources(src, pair);
      if (sources && index < sources.length && sources.length > 1) {
        return rewritePair(
          src,
          pair,
          indent,
          sources.filter((_, i) => i !== index),
        );
      }
      // The only relationship: the whole pair goes.
      const k = pair.key as { range: Range };
      const v = pair.value as { range?: Range } | null;
      let end = v?.range?.[1] ?? k.range[1];
      while (end > k.range[0] && /\s/.test(src[end - 1])) end--;
      return src.slice(0, lineStart(src, k.range[0])) + src.slice(lineEnd(src, end));
    },
  );
}
```

Note: The sweep only checks edits that are not refused; a probe over its 14 texts × 5 edits showed every expected edit succeeds (refused: the empty-key and block-scalar forms only where the guard can't keep the data exact — the empty key was then fixed with its own test).

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/markdown`
Expected: PASS — `Tests  103 passed (103)` (the existing 21 frontmatterEdit tests unchanged by the refactor).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/markdown/frontmatter.ts apps/desktop/src/markdown/frontmatterEdit.ts apps/desktop/src/markdown/related.test.ts apps/desktop/src/markdown/related.ts
git commit -F - <<'MSG'
feat(markdown): read, append, edit and delete related: relationships, byte-minimal and read back (M3b §5)

related.ts: readRelated lists a note's relationships (block list, flow
list or a single value; string or map items). appendRelated adds
"[[Target]]" after the last item with the list's own indentation (or
starts the key or the block); updateRelated turns an item into the map
form { link, label, directed } and back; removeRelated drops an item's
lines, the last one the key. A flow list or a single value is rewritten
as a block list. Every edit is read back through frontmatterEdit's guard
(now readsBackAs) and refused unless the data is exactly what was asked;
a sweep pins it. The TS link reader counts a scalar related: (parity).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 4: Writing relationships through the source page (relations.ts, editorStore.editPage)

Spec §5.

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/stores/editorStore.ts`
- Create: `apps/desktop/src/stores/relations.test.tsx`
- Create: `apps/desktop/src/stores/relations.ts`

**Interfaces:**
- Consumes: Task 3 (`readRelated`, `appendRelated`, `updateRelated`, `removeRelated`), Task 2 (`linkTarget`), `pageRead`, `pageWrite`, `linksResolve`, `eol.ts`.
- Produces: `stores/relations.ts`: `Relation` (`RelatedEntry` + `source`, `path`), `relationsOf(page)`, `relate(source, target): { status: "created" } | { status: "exists", index } | { status: "failed" }`, `updateRelation(relation, change)`, `removeRelation(relation)`; `editorStore.editPage(path, edit) → Promise<boolean | null>`; i18n `gv.relations.changedOnDisk`.

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/src/stores/relations.test.tsx`:

```tsx
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../features/editor/Editor';
import { clearMocks } from '../ipc/testing';
import { fakeDisk, hashOf } from '../test/fakeDisk';
import { resetEditorStore, useEditorStore } from './editorStore';
import { relate, relationsOf, removeRelation, updateRelation } from './relations';
import { useToastStore } from './toastStore';

const editor = () => useEditorStore.getState();
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);

/** Link targets and resolution as the backend answers them in these tests. */
const extra = {
  link_target: (a: Record<string, unknown>) => String(a.target).replace(/\.md$/, ''),
  links_resolve: (a: Record<string, unknown>) =>
    (a.targets as { target: string }[]).map((t) => `${t.target}.md`),
};

beforeEach(() => useToastStore.getState().clear());
afterEach(() => {
  resetEditorStore();
  clearMocks();
});

describe('relationships written to pages (M3b §5)', () => {
  it('a page not open in the editor: read, edit, written back with its hash', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n', 'B.md': '# B\n' }, extra);
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'created' });
    expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n');
    const write = disk.calls.find(([c]) => c === 'page_write')![1];
    expect(write.expectedHash).toBe(hashOf('# A\n'));
    // The same target again: nothing written, its entry is answered.
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'exists', index: 0 });
    expect(disk.writes()).toHaveLength(1);
    expect(await relationsOf('A.md')).toEqual([
      {
        source: 'A.md',
        path: 'B.md',
        index: 0,
        link: '[[B]]',
        target: 'B',
        label: null,
        directed: false,
      },
    ]);
  });

  it('the page open in the editor: an undoable change, saved at once', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n', 'B.md': '# B\n' }, extra);
    await act(() => editor().open('A.md'));
    render(<Editor doc={editor().doc!} mode="source" label="A" />);
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
    await act(async () => {
      expect(await relate('A.md', 'B.md')).toEqual({ status: 'created' });
    });
    expect(view.state.doc.toString()).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n');
    expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n');
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe('# A\n');
  });

  it('a change on disk meanwhile is retried once on the new text', async () => {
    let raced = false;
    const disk = fakeDisk(
      { 'A.md': '# A\n' },
      {
        ...extra,
        page_read: (a: Record<string, unknown>) => {
          const text = disk.files.get(String(a.path))!;
          // Another program writes right after the first read.
          if (!raced) {
            raced = true;
            disk.files.set('A.md', '# A changed\n');
          }
          return { text, hash: hashOf(text) };
        },
      },
    );
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'created' });
    expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A changed\n');
  });

  it('a page that keeps changing: one toast, the page left as it is', async () => {
    const disk = fakeDisk(
      { 'A.md': '# A\n' },
      {
        ...extra,
        page_write: () => {
          throw { kind: 'conflict', message: 'changed', currentText: 'x', currentHash: 'h:x' };
        },
      },
    );
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'failed' });
    expect(disk.files.get('A.md')).toBe('# A\n');
    expect(toasts()).toEqual(['Couldn’t update A: it changed on disk. Try again.']);
  });

  it('frontmatter it can’t edit safely: refused with the Source-mode toast', async () => {
    const disk = fakeDisk({ 'A.md': '---\nrelated: [oops\n---\n' }, extra);
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'failed' });
    expect(disk.writes()).toEqual([]);
    expect(toasts()).toEqual([
      'NIMW can’t safely change this note’s frontmatter. Edit it in Source mode.',
    ]);
  });

  it('a CRLF page keeps its line endings', async () => {
    const disk = fakeDisk({ 'A.md': '---\r\ntitle: x\r\n---\r\n# A\r\n' }, extra);
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'created' });
    expect(disk.files.get('A.md')).toBe(
      '---\r\ntitle: x\r\nrelated:\r\n  - "[[B]]"\r\n---\r\n# A\r\n',
    );
  });

  it('edits and deletes name the entry they read, and refuse a list that moved', async () => {
    const disk = fakeDisk({ 'A.md': '---\nrelated:\n  - "[[B]]"\n  - "[[C]]"\n---\n' }, extra);
    const [b, c] = await relationsOf('A.md');
    expect(await updateRelation(c, { label: 'why', directed: true })).toBe(true);
    expect(disk.files.get('A.md')).toBe(
      '---\nrelated:\n  - "[[B]]"\n  - { link: "[[C]]", label: why, directed: true }\n---\n',
    );
    expect(await removeRelation(b)).toBe(true);
    expect(disk.files.get('A.md')).toBe(
      '---\nrelated:\n  - { link: "[[C]]", label: why, directed: true }\n---\n',
    );
    // `b` named index 0, which is now C: refused, nothing written.
    const writes = disk.writes().length;
    expect(await removeRelation(b)).toBe(false);
    expect(disk.writes()).toHaveLength(writes);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/stores/relations.test.tsx`
Expected: FAIL — `Failed to resolve import "./relations"`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/i18n/locales/en.json` (apply this change):

```diff
@@ -279,6 +279,9 @@
     "obsidianFolder": "the “{name}” folder"
   },
   "gv": {
+    "relations": {
+      "changedOnDisk": "Couldn’t update {name}: it changed on disk. Try again."
+    },
     "region": "Global View",
     "canvas": "Global View cards",
     "a11y": {
```

Modify `apps/desktop/src/i18n/locales/es.json` (apply this change):

```diff
@@ -279,6 +279,9 @@
     "obsidianFolder": "la carpeta «{name}»"
   },
   "gv": {
+    "relations": {
+      "changedOnDisk": "No se pudo actualizar {name}: cambió en el disco. Inténtalo de nuevo."
+    },
     "region": "Vista global",
     "canvas": "Tarjetas de la vista global",
     "a11y": {
```

Modify `apps/desktop/src/stores/editorStore.ts` (apply this change):

```diff
@@ -4,7 +4,11 @@ import { LARGE_NOTE_CHARS } from '../features/editor/limits';
 import { PageDoc, type PageDocHooks, type SaveStatus } from '../features/editor/pageDoc';
 import { viewOf } from '../features/editor/views';
 import { isTauri, onCloseRequested, type ChangedPayload, type CommandError } from '../ipc';
-import { setFrontmatter, type FrontmatterPatch } from '../markdown/frontmatterEdit';
+import {
+  setFrontmatter,
+  type FrontmatterEdit,
+  type FrontmatterPatch,
+} from '../markdown/frontmatterEdit';
 import { errorMessage } from './messages';
 import { openNewPage, openPage } from './navigate';
 import { useToastStore } from './toastStore';
@@ -48,6 +52,11 @@ interface EditorState {
    *  there is no editable page or its frontmatter can't be edited safely (invalid
    *  YAML, or a form the byte-minimal edit refuses; toast). */
   editFrontmatter: (patch: FrontmatterPatch) => Promise<boolean>;
+  /** A frontmatter edit of `path` while it has a live document (M3b §5):
+   *  the current page as an undoable editor change, a background page as a
+   *  text change; saved at once. `null` when the page has no live document
+   *  (the caller writes the file). `false` (with the toast) when refused. */
+  editPage: (path: string, edit: (text: string) => FrontmatterEdit) => Promise<boolean | null>;
 }
 
 /** Every page with a live document: the current one plus pages switched away
@@ -91,6 +100,25 @@ const hooks: PageDocHooks = {
   },
 };
 
+/** A frontmatter edit of a live document: through its view when it has one
+ *  (undoable), else its text; saved at once. Refused: toast, `false`. */
+async function applyEdit(doc: PageDoc, edit: (text: string) => FrontmatterEdit): Promise<boolean> {
+  const view = viewOf(doc);
+  const text = view ? view.state.doc.toString() : doc.text;
+  const res = edit(text);
+  if (!res.ok) {
+    useToastStore.getState().push({ message: i18next.t('page.frontmatterInvalid'), tone: 'error' });
+    return false;
+  }
+  const c = res.change;
+  if (c) {
+    if (view) view.dispatch({ changes: c, userEvent: 'input.frontmatter' });
+    else doc.edit(text.slice(0, c.from) + c.insert + text.slice(c.to));
+  }
+  await doc.flush();
+  return true;
+}
+
 /** A background page is dropped once it's saved. An orphaned one (deleted
  *  outside with unsaved text) is kept: its text must not be dropped silently,
  *  so it still blocks closing the vault or the window (M2a §3.3). */
@@ -118,22 +146,11 @@ export const useEditorStore = create<EditorState>((set, get) => ({
   editFrontmatter: async (patch) => {
     const doc = get().doc;
     if (!doc) return false;
-    const view = viewOf(doc);
-    const text = view ? view.state.doc.toString() : doc.text;
-    const res = setFrontmatter(text, patch);
-    if (!res.ok) {
-      useToastStore
-        .getState()
-        .push({ message: i18next.t('page.frontmatterInvalid'), tone: 'error' });
-      return false;
-    }
-    const c = res.change;
-    if (c) {
-      if (view) view.dispatch({ changes: c, userEvent: 'input.frontmatter' });
-      else doc.edit(text.slice(0, c.from) + c.insert + text.slice(c.to));
-    }
-    await doc.flush();
-    return true;
+    return applyEdit(doc, (text) => setFrontmatter(text, patch));
+  },
+  editPage: async (path, edit) => {
+    const doc = get().doc?.path === path ? get().doc : docs.get(path);
+    return doc ? applyEdit(doc, edit) : null;
   },
   open: async (path) => {
     const prev = get().doc;
```

Create `apps/desktop/src/stores/relations.ts`:

```ts
// Relationships between pages (M3b §2, §3, §5): read from and written to the
// source page's `related:`. A page with a live editor document gets the edit
// there (undoable when it's on screen); any other page is read, edited and
// written back against its hash, retried once when it changed meanwhile.
import i18next from 'i18next';
import { detectEol, fromLf, toLf } from '../features/editor/eol';
import { linksResolve, linkTarget, pageRead, pageWrite } from '../ipc';
import type { FrontmatterEdit } from '../markdown/frontmatterEdit';
import {
  appendRelated,
  readRelated,
  removeRelated,
  updateRelated,
  type RelatedChange,
  type RelatedEntry,
} from '../markdown/related';
import { useEditorStore } from './editorStore';
import { errorMessage } from './messages';
import { useToastStore } from './toastStore';
import { nameOf } from './tree';

/** A relationship of `source`, with the page its link resolves to. */
export interface Relation extends RelatedEntry {
  source: string;
  /** The target page's vault path; `null` when the link resolves to nothing. */
  path: string | null;
}

export type RelateResult =
  { status: 'created' } | { status: 'exists'; index: number } | { status: 'failed' };

/** An edit that found the list changed under it: refused without a toast
 *  (the caller re-reads). */
const STALE = 'stale' as const;
type Edit = (text: string) => FrontmatterEdit | typeof STALE;

const toast = (message: string) => useToastStore.getState().push({ message, tone: 'error' });
const pageName = (path: string) => nameOf(path).replace(/\.md$/i, '');

/** The page's text: its live editor document's, else the file's (LF). */
async function textOf(page: string): Promise<string | null> {
  const { doc } = useEditorStore.getState();
  if (doc?.path === page) return doc.text;
  const res = await pageRead(page);
  return res.ok ? toLf(res.value.text) : null;
}

/** `page`'s relationships, each with the page it points to. */
export async function relationsOf(page: string): Promise<Relation[]> {
  const text = await textOf(page);
  if (text === null) return [];
  const entries = readRelated(text);
  if (!entries.length) return [];
  const res = await linksResolve(
    page,
    entries.map((e) => ({ kind: 'related' as const, target: e.target })),
  );
  return entries.map((e, i) => ({
    ...e,
    source: page,
    path: res.ok ? (res.value[i] ?? null) : null,
  }));
}

/** Applies `edit` to `page`'s frontmatter. `false` when refused or failed
 *  (with a toast, except for a stale list). */
async function editRelations(page: string, edit: Edit): Promise<boolean> {
  let stale = false;
  const guarded = (text: string): FrontmatterEdit => {
    const res = edit(text);
    if (res === STALE) {
      stale = true;
      return { ok: true, change: null };
    }
    return res;
  };
  const live = await useEditorStore.getState().editPage(page, guarded);
  if (live !== null) return live && !stale;
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await pageRead(page);
    if (!read.ok) {
      toast(errorMessage(read.error));
      return false;
    }
    const eol = detectEol(read.value.text);
    const text = toLf(read.value.text);
    const res = guarded(text);
    if (stale) return false;
    if (!res.ok) {
      toast(i18next.t('page.frontmatterInvalid'));
      return false;
    }
    if (!res.change) return true;
    const c = res.change;
    const next = fromLf(text.slice(0, c.from) + c.insert + text.slice(c.to), eol);
    const written = await pageWrite(page, next, read.value.hash);
    if (written.ok) return true;
    if (written.error.kind !== 'conflict') {
      toast(errorMessage(written.error));
      return false;
    }
  }
  toast(i18next.t('gv.relations.changedOnDisk', { name: pageName(page) }));
  return false;
}

/** Relates `source` to the page `target` (M3b §2): a new `related:` item,
 *  unless one already points there. */
export async function relate(source: string, target: string): Promise<RelateResult> {
  const existing = (await relationsOf(source)).find((r) => r.path === target);
  if (existing) return { status: 'exists', index: existing.index };
  const link = await linkTarget(source, target);
  if (!link.ok) {
    toast(errorMessage(link.error));
    return { status: 'failed' };
  }
  const ok = await editRelations(source, (text) => appendRelated(text, link.value));
  return ok ? { status: 'created' } : { status: 'failed' };
}

/** The entry the caller read, if the list still has it there. */
const still = (text: string, r: Relation) =>
  readRelated(text).find((e) => e.index === r.index && e.link === r.link);

/** Changes a relationship's label and arrow (M3b §3). */
export const updateRelation = (r: Relation, change: RelatedChange): Promise<boolean> =>
  editRelations(r.source, (text) =>
    still(text, r) ? updateRelated(text, r.index, change) : STALE,
  );

/** Deletes a relationship (M3b §3). */
export const removeRelation = (r: Relation): Promise<boolean> =>
  editRelations(r.source, (text) => (still(text, r) ? removeRelated(text, r.index) : STALE));
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/stores/relations.test.tsx src/stores/editorStore.test.tsx && pnpm check:i18n`
Expected: PASS — `Tests  25 passed (25)`; `i18n OK: 2 locales in parity.`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json apps/desktop/src/stores/editorStore.ts apps/desktop/src/stores/relations.test.tsx apps/desktop/src/stores/relations.ts
git commit -F - <<'MSG'
feat(global-view): relationships are read and written through the source page (M3b §5)

stores/relations.ts: relationsOf (entries with the page each resolves
to), relate (a new item unless one already points there), updateRelation
and removeRelation (refused when the list moved under the caller). A page
with a live editor document is edited through editorStore.editPage —
undoable when on screen, saved at once; any other page is read, edited
on LF text and written back against its hash in its own line endings,
retried once when it changed meanwhile, then a toast.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 5: The card’s connections menu and the Relationships dialog; edges open it

Spec §3.

**Files:**
- Modify: `apps/desktop/src/app/icons.tsx`
- Modify: `apps/desktop/src/features/dialogs/DialogHost.tsx`
- Modify: `apps/desktop/src/features/global-view/Canvas.tsx`
- Modify: `apps/desktop/src/features/global-view/Card.module.css`
- Modify: `apps/desktop/src/features/global-view/Card.test.tsx`
- Modify: `apps/desktop/src/features/global-view/Card.tsx`
- Create: `apps/desktop/src/features/global-view/CardMenu.tsx`
- Modify: `apps/desktop/src/features/global-view/GlobalView.edges.test.tsx`
- Modify: `apps/desktop/src/features/global-view/GlobalView.module.css`
- Create: `apps/desktop/src/features/global-view/RelationsDialog.test.tsx`
- Create: `apps/desktop/src/features/global-view/RelationsDialog.tsx`
- Modify: `apps/desktop/src/features/global-view/edges.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/stores/uiStore.ts`

**Interfaces:**
- Consumes: Task 4 (`relationsOf`, `updateRelation`, `removeRelation`).
- Produces: `LinkIcon`; `CardMenu` (`{ label, items: CardMenuItem[], anchor, onClose(refocus) }`); `Card` props `menu?: CardMenuItem[]`; `RelationsDialog({ page, other?, onClose })`, `LABEL_MAX = 40`; dialog state `{ type: "relations"; page; other? }`; `EdgeLayer` prop `onRelations?(a, b)` and `[data-gv-hit]` paths; i18n `gv.relations.*`.

- [ ] **Step 1: Write the failing test(s)**

Modify `apps/desktop/src/features/global-view/Card.test.tsx` (apply this change):

```diff
@@ -140,4 +140,37 @@ describe('Global View card (M3a §4)', () => {
     const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
     expect(results.violations).toEqual([]);
   });
+
+  it('M3b: the connect button opens the card’s menu; Escape gives the keyboard back', async () => {
+    const run = vi.fn();
+    render(
+      <Card
+        card={card()}
+        open={false}
+        focusable
+        connections=""
+        menu={[{ label: 'Relationships…', run }]}
+        onOpen={vi.fn()}
+        onOpenEditor={vi.fn()}
+        onFocus={() => undefined}
+      />,
+    );
+    const button = screen.getByRole('button', { name: 'Connections of Generator Rex' });
+    expect(button).toHaveAttribute('aria-haspopup', 'menu');
+    await userEvent.click(button);
+    const menu = screen.getByRole('menu', { name: 'Connections of Generator Rex' });
+    expect(screen.getByRole('menuitem', { name: 'Relationships…' })).toHaveFocus();
+    await userEvent.keyboard('{Escape}');
+    expect(menu).not.toBeInTheDocument();
+    expect(button).toHaveFocus();
+    await userEvent.click(button);
+    await userEvent.click(screen.getByRole('menuitem', { name: 'Relationships…' }));
+    expect(run).toHaveBeenCalledOnce();
+    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
+  });
+
+  it('M3b: without menu items there is no connect button', () => {
+    show(card());
+    expect(screen.queryByRole('button', { name: /^Connections of/ })).not.toBeInTheDocument();
+  });
 });
```

Modify `apps/desktop/src/features/global-view/GlobalView.edges.test.tsx` (apply this change):

```diff
@@ -2,7 +2,7 @@
 // reference vault has ~2,600 aggregated edges, nearly all with a count:
 // drawn as React Flow edges with HTML count labels they took 1.5–2.5 s in
 // WebKit against NFR-03's 300 ms (final review I2).
-import { render, screen, waitFor } from '@testing-library/react';
+import { fireEvent, render, screen, waitFor } from '@testing-library/react';
 import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
 import type { GvCard, GvEdge, GvLevel, GvLevelRef } from '../../ipc';
 import { clearMocks, mockIPC } from '../../ipc/testing';
@@ -161,4 +161,21 @@ describe('Global View edges (M3a §6, final review I2)', () => {
     await waitFor(() => expect(drawn()).toHaveLength(1));
     expect(screen.queryByText(/strongest/)).toBeNull();
   });
+
+  it('M3b: a manual edge opens the relationships between its two cards', async () => {
+    level0 = { cards: [card('A'), card('B'), card('C')], centre: null };
+    edges = [
+      edge('A', 'B', { kind: 'manual', aggregated: false, label: 'why' }),
+      edge('A', 'C', { kind: 'manual', aggregated: true }),
+    ];
+    render(<GlobalView />);
+    await waitFor(() => expect(drawn()).toHaveLength(2));
+    // Only the direct relationship takes the pointer: an aggregated one stands
+    // for many inside folders.
+    const hits = document.querySelectorAll<SVGPathElement>('[data-gv-hit]');
+    expect(hits).toHaveLength(1);
+    expect(hits[0].classList).toContain('nopan');
+    fireEvent.click(hits[0]);
+    expect(useUiStore.getState().dialog).toEqual({ type: 'relations', page: 'A', other: 'B' });
+  });
 });
```

Create `apps/desktop/src/features/global-view/RelationsDialog.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { fakeDisk } from '../../test/fakeDisk';
import { RelationsDialog } from './RelationsDialog';

/** `[[X]]` resolves to `X.md`; the shortest target is the stem. */
const extra = {
  link_target: (a: Record<string, unknown>) => String(a.target).replace(/\.md$/, ''),
  links_resolve: (a: Record<string, unknown>) =>
    (a.targets as { target: string }[]).map((t) => `${t.target}.md`),
};

afterEach(() => {
  resetEditorStore();
  clearMocks();
});

describe('relationships dialog (M3b §3)', () => {
  it('lists a page’s relationships; a label and an arrow are saved to its frontmatter', async () => {
    const disk = fakeDisk(
      {
        'A.md': '---\nrelated:\n  - "[[B]]"\n  - { link: "[[C]]", label: old }\n---\n# A\n',
        'B.md': '# B\n',
        'C.md': '# C\n',
      },
      extra,
    );
    render(<RelationsDialog page="A.md" onClose={vi.fn()} />);
    const b = await screen.findByRole('group', { name: 'A → B' });
    expect(within(screen.getByRole('group', { name: 'A → C' })).getByRole('textbox')).toHaveValue(
      'old',
    );
    const save = within(b).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.type(within(b).getByRole('textbox', { name: 'Label' }), 'inspired by');
    await userEvent.click(within(b).getByRole('checkbox', { name: 'Arrow to B' }));
    await userEvent.click(save);
    await waitFor(() =>
      expect(disk.files.get('A.md')).toBe(
        '---\nrelated:\n  - { link: "[[B]]", label: inspired by, directed: true }\n  - { link: "[[C]]", label: old }\n---\n# A\n',
      ),
    );
  });

  it('deleting removes it from the page and from the list', async () => {
    const disk = fakeDisk(
      { 'A.md': '---\nrelated:\n  - "[[B]]"\n  - "[[C]]"\n---\n', 'B.md': '', 'C.md': '' },
      extra,
    );
    render(<RelationsDialog page="A.md" onClose={vi.fn()} />);
    const c = await screen.findByRole('group', { name: 'A → C' });
    await userEvent.click(within(c).getByRole('button', { name: 'Delete relationship' }));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'A → C' })).not.toBeInTheDocument(),
    );
    expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n');
    // The keyboard stays in the dialog.
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
  });

  it('between two cards: both pages’ relationships to each other, nothing else', async () => {
    fakeDisk(
      {
        'A.md': '---\nrelated:\n  - "[[B]]"\n  - "[[C]]"\n---\n',
        'B.md': '---\nrelated:\n  - { link: "[[A]]", directed: true }\n---\n',
        'C.md': '',
      },
      extra,
    );
    render(<RelationsDialog page="A.md" other="B.md" onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Relationships between A and B' })).toBeVisible();
    await screen.findByRole('group', { name: 'A → B' });
    expect(screen.getByRole('group', { name: 'B → A' })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'A → C' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'B → A' })).getByRole('checkbox', {
        name: 'Arrow to A',
      }),
    ).toBeChecked();
  });

  it('a page without any says how to add one; no axe violations', async () => {
    fakeDisk({ 'A.md': '# A\n' }, extra);
    render(<RelationsDialog page="A.md" onClose={vi.fn()} />);
    expect(
      await screen.findByText('No relationships yet. Use “Connect to…” on a card to add one.'),
    ).toBeVisible();
    const violations = await axe
      .run(screen.getByRole('dialog'), { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/features/global-view/RelationsDialog.test.tsx src/features/global-view/Card.test.tsx src/features/global-view/GlobalView.edges.test.tsx`
Expected: FAIL — `Failed to resolve import "./RelationsDialog"`; `Unable to find an accessible element with the role "button" and name "Connections of Generator Rex"`; `expected  to have a length of 1 but got +0` (no hit path).

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/app/icons.tsx` (apply this change):

```diff
@@ -135,6 +135,15 @@ export function NewPageIcon() {
 }
 
 /** Global View card handle (drag to move). */
+/** Connect / relationships (the prototype's chain link). */
+export function LinkIcon() {
+  return (
+    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
+      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
+    </svg>
+  );
+}
+
 export function GripIcon() {
   return (
     <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
```

Modify `apps/desktop/src/features/dialogs/DialogHost.tsx` (apply this change):

```diff
@@ -1,4 +1,5 @@
 import { useUiStore } from '../../stores/uiStore';
+import { RelationsDialog } from '../global-view/RelationsDialog';
 import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
 import { CreatePageDialog, OpenExternalDialog, OpenFileDialog } from './LinkDialogs';
 import { MoveToDialog } from './MoveToDialog';
@@ -22,5 +23,7 @@ export function DialogHost() {
       return <OpenExternalDialog url={dialog.url} onClose={close} />;
     case 'openFile':
       return <OpenFileDialog path={dialog.path} onClose={close} />;
+    case 'relations':
+      return <RelationsDialog page={dialog.page} other={dialog.other} onClose={close} />;
   }
 }
```

Modify `apps/desktop/src/features/global-view/Canvas.tsx` (apply this change):

```diff
@@ -10,7 +10,9 @@ import {
 } from 'react';
 import { useTranslation } from 'react-i18next';
 import type { GlobalViewEdges, GvCard } from '../../ipc';
+import { useUiStore } from '../../stores/uiStore';
 import { Card } from './Card';
+import type { CardMenuItem } from './CardMenu';
 import { EdgeLayer, MAX_AGGREGATED, strongest, type DrawnEdge } from './edges';
 import { useGvStore } from './gvStore';
 import {
@@ -31,6 +33,7 @@ interface CardData extends Record<string, unknown> {
   open: boolean;
   focusable: boolean;
   connections: string;
+  menu: CardMenuItem[];
   onOpen: (card: GvCard) => void;
   onOpenEditor: (card: GvCard) => void;
 }
@@ -48,6 +51,7 @@ function CardNodeView({ data }: NodeProps<CardNode>) {
         open={data.open}
         focusable={data.focusable}
         connections={data.connections}
+        menu={data.menu}
         onOpen={() => data.onOpen(data.card)}
         onOpenEditor={() => data.onOpenEditor(data.card)}
         onFocus={() => setFocus(data.card.path)}
@@ -176,6 +180,27 @@ export function Canvas({ mode, toggles, width, onOpen, onOpenEditor }: CanvasPro
       t('gv.connections', { links: links.get(path) ?? 0, manual: manual.get(path) ?? 0 });
   }, [edges, t]);
 
+  /** The page a card stands for in a relationship (M3b §2): itself, or a
+   *  folder's index note. */
+  const menuOf = useCallback(
+    (card: GvCard): CardMenuItem[] => {
+      const page = card.kind === 'page' ? card.path : card.indexPage;
+      if (!page) return [];
+      return [
+        {
+          label: t('gv.relations.open'),
+          run: () => useUiStore.getState().openDialog({ type: 'relations', page }),
+        },
+      ];
+    },
+    [t],
+  );
+  const openRelations = useCallback(
+    (page: string, other: string) =>
+      useUiStore.getState().openDialog({ type: 'relations', page, other }),
+    [],
+  );
+
   const tabStop = focus ?? canvas.centre ?? canvas.cards[0]?.path ?? null;
   const computed = useMemo<CardNode[]>(
     () =>
@@ -201,11 +226,12 @@ export function Canvas({ mode, toggles, width, onOpen, onOpenEditor }: CanvasPro
           open: canvas.centre === card.path || expandedPaths.has(card.path),
           focusable: card.path === tabStop,
           connections: connections(card.path),
+          menu: menuOf(card),
           onOpen: open,
           onOpenEditor,
         },
       })),
-    [canvas, positions, expandedPaths, tabStop, connections, open, onOpenEditor],
+    [canvas, positions, expandedPaths, tabStop, connections, menuOf, open, onOpenEditor],
   );
   const ariaLabelConfig = useMemo(
     () => ({
@@ -304,7 +330,7 @@ export function Canvas({ mode, toggles, width, onOpen, onOpenEditor }: CanvasPro
         maxZoom={2}
         proOptions={{ hideAttribution: true }}
       >
-        <EdgeLayer edges={drawn.edges} />
+        <EdgeLayer edges={drawn.edges} onRelations={openRelations} />
       </ReactFlow>
       {drawn.hidden > 0 && (
         <p className={styles.capNote}>
```

Modify `apps/desktop/src/features/global-view/Card.module.css` (apply this change):

```diff
@@ -53,6 +53,35 @@
   background: var(--color-accent-soft);
 }
 
+/* The connect / relationships button (M3b §2, prototype `.ib` link). */
+.connect {
+  display: inline-grid;
+  place-items: center;
+  width: 36px;
+  height: 36px;
+  padding: 0;
+  border: 0;
+  border-radius: var(--radius-sm);
+  background: transparent;
+  color: var(--color-text-muted);
+  cursor: pointer;
+}
+
+.connect:hover,
+.connect[aria-expanded='true'] {
+  background: var(--color-accent-soft);
+  color: var(--color-accent);
+}
+
+.connect:focus {
+  outline: 2px solid var(--color-focus);
+  outline-offset: -2px;
+}
+
+.connect:focus:not(:focus-visible) {
+  outline: none;
+}
+
 .hit {
   position: relative;
   flex: 1;
```

Modify `apps/desktop/src/features/global-view/Card.tsx` (apply this change):

```diff
@@ -1,8 +1,9 @@
-import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
+import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
 import { useTranslation } from 'react-i18next';
-import { AudioIcon, FolderIcon, GripIcon, ImageIcon } from '../../app/icons';
+import { AudioIcon, FolderIcon, GripIcon, ImageIcon, LinkIcon } from '../../app/icons';
 import { assetUrl, type GvCard } from '../../ipc';
 import { nameOf } from '../../stores/tree';
+import { CardMenu, type CardMenuItem } from './CardMenu';
 import styles from './Card.module.css';
 
 /** A single click waits this long for a second one (prototype; M3a §5), so
@@ -17,6 +18,8 @@ export interface CardProps {
   focusable: boolean;
   /** Its edges in plain words, for screen readers (M3a §6). */
   connections: string;
+  /** The connect button's menu (M3b §3); none: no button. */
+  menu?: CardMenuItem[];
   /** Single click / Enter: the next level (GV-11). */
   onOpen: () => void;
   /** Double click / Shift+Enter / See all: the editor (GV-12). */
@@ -30,12 +33,15 @@ export function Card({
   open,
   focusable,
   connections,
+  menu = [],
   onOpen,
   onOpenEditor,
   onFocus,
 }: CardProps) {
   const { t } = useTranslation();
   const descId = useId();
+  const menuButton = useRef<HTMLButtonElement>(null);
+  const [menuOpen, setMenuOpen] = useState(false);
   const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
   useEffect(
     () => () => {
@@ -108,6 +114,32 @@ export function Card({
         <span className={`${styles.grip} gv-grip`} title={t('gv.move')} aria-hidden="true">
           <GripIcon />
         </span>
+        {menu.length > 0 && (
+          <button
+            ref={menuButton}
+            type="button"
+            className={`${styles.connect} nodrag`}
+            tabIndex={focusable ? 0 : -1}
+            aria-haspopup="menu"
+            aria-expanded={menuOpen}
+            aria-label={t('gv.relations.menu', { title: card.title })}
+            title={t('gv.relations.menu', { title: card.title })}
+            onClick={() => setMenuOpen((o) => !o)}
+          >
+            <LinkIcon />
+          </button>
+        )}
+        {menuOpen && menuButton.current && (
+          <CardMenu
+            label={t('gv.relations.menu', { title: card.title })}
+            items={menu}
+            anchor={menuButton.current}
+            onClose={(refocus) => {
+              setMenuOpen(false);
+              if (refocus) menuButton.current?.focus();
+            }}
+          />
+        )}
       </div>
       <div className={styles.hit}>
         <div
```

Create `apps/desktop/src/features/global-view/CardMenu.tsx`:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export interface CardMenuItem {
  label: string;
  run: () => void;
}

/** A card's connections menu (M3b §3; ARIA menu button pattern): under its
 *  button, in a portal (React Flow's viewport is transformed, which would
 *  move a fixed-position menu with the canvas). Arrow keys, Home and End
 *  move, Escape and Tab close it and give the keyboard back to the button;
 *  a click elsewhere closes it. */
export function CardMenu({
  label,
  items,
  anchor,
  onClose,
}: {
  label: string;
  items: CardMenuItem[];
  anchor: HTMLElement;
  onClose: (refocus: boolean) => void;
}) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();

  useEffect(() => {
    refs.current[active]?.focus();
  }, [active]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !anchor.contains(target)) onClose(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor, onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % items.length);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + items.length) % items.length);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(items.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={label}
      className="nimw-menu"
      style={{ position: 'fixed', left: rect.left, top: rect.bottom + 4 }}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          onClick={() => {
            onClose(false);
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
```

Modify `apps/desktop/src/features/global-view/GlobalView.module.css` (apply this change):

```diff
@@ -172,6 +172,15 @@
   stroke-linecap: round;
 }
 
+/* A direct relationship takes the pointer (M3b §3): an invisible, wide
+   stroke over it. */
+.edges .edgeHit {
+  stroke: transparent;
+  stroke-width: 14px;
+  pointer-events: stroke;
+  cursor: pointer;
+}
+
 .edges .edgeArrow {
   fill: currentColor;
   stroke: none;
```

Create `apps/desktop/src/features/global-view/RelationsDialog.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { relationsOf, removeRelation, updateRelation, type Relation } from '../../stores/relations';
import { nameOf } from '../../stores/tree';
import { Dialog } from '../dialogs/Dialog';
import styles from '../dialogs/Dialogs.module.css';
import { useGvStore } from './gvStore';

/** The label limit (M3b §9.6). */
export const LABEL_MAX = 40;

const pageName = (path: string) => nameOf(path).replace(/\.md$/i, '');

/** A page's relationships, or those between two pages (`other`), each with
 *  its label, arrow, Save and Delete (M3b §3). Changes are written to the
 *  relationship's own page; the Global View re-reads its edges. */
export function RelationsDialog({
  page,
  other,
  onClose,
}: {
  page: string;
  other?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Relation[] | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const lists = await Promise.all((other ? [page, other] : [page]).map(relationsOf));
    const all = lists.flat();
    setRows(
      other
        ? all.filter(
            (r) =>
              (r.source === page && r.path === other) || (r.source === other && r.path === page),
          )
        : all,
    );
  }, [page, other]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const changed = async () => {
    await reload();
    if (useGvStore.getState().loaded) void useGvStore.getState().load();
  };

  const title = other
    ? t('gv.relations.between', { a: pageName(page), b: pageName(other) })
    : t('gv.relations.of', { name: pageName(page) });

  return (
    <Dialog title={title} onClose={onClose}>
      <div ref={list}>
        {rows === null ? (
          <p className={styles.text}>{t('gv.relations.loading')}</p>
        ) : rows.length === 0 ? (
          <p className={styles.text}>{t('gv.relations.none')}</p>
        ) : (
          rows.map((r) => (
            <RelationRow
              key={`${r.source}:${r.index}:${r.link}`}
              relation={r}
              onChanged={changed}
              onDeleted={async () => {
                await changed();
                // The row's buttons are gone: keep the keyboard in the dialog.
                list.current
                  ?.closest<HTMLElement>('[role="dialog"]')
                  ?.querySelector<HTMLElement>('input, button')
                  ?.focus();
              }}
            />
          ))
        )}
      </div>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} onClick={onClose}>
          {t('dialogs.close')}
        </button>
      </div>
    </Dialog>
  );
}

function RelationRow({
  relation,
  onChanged,
  onDeleted,
}: {
  relation: Relation;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(relation.label ?? '');
  const [directed, setDirected] = useState(relation.directed);
  const [busy, setBusy] = useState(false);
  const target = relation.path ? pageName(relation.path) : relation.target;
  const dirty = label.trim() !== (relation.label ?? '') || directed !== relation.directed;

  const save = async () => {
    setBusy(true);
    if (await updateRelation(relation, { label: label.trim() || null, directed })) {
      await onChanged();
    }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    if (await removeRelation(relation)) await onDeleted();
    else setBusy(false);
  };

  return (
    <fieldset className={styles.fieldset}>
      <legend>{t('gv.relations.edge', { from: pageName(relation.source), to: target })}</legend>
      <label className={styles.field}>
        <span>{t('gv.relations.label')}</span>
        <input
          className={styles.hexInput}
          type="text"
          maxLength={LABEL_MAX}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) void save();
          }}
        />
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={directed} onChange={(e) => setDirected(e.target.checked)} />
        {t('gv.relations.arrow', { to: target })}
      </label>
      <div className={styles.buttons}>
        <button
          type="button"
          className={`${styles.button} ${styles.danger}`}
          disabled={busy}
          onClick={() => void remove()}
        >
          {t('gv.relations.delete')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          {t('gv.relations.save')}
        </button>
      </div>
    </fieldset>
  );
}
```

Modify `apps/desktop/src/features/global-view/edges.tsx` (apply this change):

```diff
@@ -191,14 +191,31 @@ export function strongest(edges: DrawnEdge[], max = MAX_AGGREGATED) {
 
 export interface EdgeLayerProps {
   edges: DrawnEdge[];
+  /** A direct relationship edge was clicked (M3b §3): its two cards. */
+  onRelations?: (a: string, b: string) => void;
 }
 
+/** A wide, invisible stroke over a direct relationship that takes the
+ *  pointer (the layer itself ignores it); `nopan`, so pressing on it doesn't
+ *  pan the canvas. */
+const EdgeHit = memo(function EdgeHit({ from, to, onClick }: EndsProps & { onClick: () => void }) {
+  const { s, t } = line(from, to);
+  return (
+    <path
+      className={`${styles.edgeHit} nopan`}
+      d={`M${s.x},${s.y}L${t.x},${t.y}`}
+      data-gv-hit=""
+      onClick={onClick}
+    />
+  );
+});
+
 /** Every edge of the canvas, in the viewport under the cards: one group per
  *  style (strokes inherit), counts and labels on top. Card positions come
  *  from React Flow's store, so edges appear with their cards and follow a
  *  drag; a card that stays put keeps its position object, so only a moved
  *  card's edges redraw. */
-export const EdgeLayer = memo(function EdgeLayer({ edges }: EdgeLayerProps) {
+export const EdgeLayer = memo(function EdgeLayer({ edges, onRelations }: EdgeLayerProps) {
   const nodes = useStore(nodesOf);
   const positions = useMemo(
     () => new Map<string, XY>(nodes.map((n) => [n.id, n.position])),
@@ -239,6 +256,24 @@ export const EdgeLayer = memo(function EdgeLayer({ edges }: EdgeLayerProps) {
             </g>
           );
         })}
+        {onRelations && (
+          <g>
+            {edges.map((e) => {
+              if (e.kind !== 'manual' || e.aggregated) return null;
+              const from = positions.get(e.source);
+              const to = positions.get(e.target);
+              if (!from || !to) return null;
+              return (
+                <EdgeHit
+                  key={e.id}
+                  from={from}
+                  to={to}
+                  onClick={() => onRelations(e.source, e.target)}
+                />
+              );
+            })}
+          </g>
+        )}
         <g className={styles.edgeLabels}>
           {labelled.map(({ e, text }) => {
             const from = positions.get(e.source);
```

Modify `apps/desktop/src/i18n/locales/en.json` (apply this change):

```diff
@@ -280,7 +280,18 @@
   },
   "gv": {
     "relations": {
-      "changedOnDisk": "Couldn’t update {name}: it changed on disk. Try again."
+      "changedOnDisk": "Couldn’t update {name}: it changed on disk. Try again.",
+      "of": "Relationships of {name}",
+      "between": "Relationships between {a} and {b}",
+      "loading": "Loading…",
+      "none": "No relationships yet. Use “Connect to…” on a card to add one.",
+      "edge": "{from} → {to}",
+      "label": "Label",
+      "arrow": "Arrow to {to}",
+      "save": "Save",
+      "delete": "Delete relationship",
+      "menu": "Connections of {title}",
+      "open": "Relationships…"
     },
     "region": "Global View",
     "canvas": "Global View cards",
```

Modify `apps/desktop/src/i18n/locales/es.json` (apply this change):

```diff
@@ -280,7 +280,18 @@
   },
   "gv": {
     "relations": {
-      "changedOnDisk": "No se pudo actualizar {name}: cambió en el disco. Inténtalo de nuevo."
+      "changedOnDisk": "No se pudo actualizar {name}: cambió en el disco. Inténtalo de nuevo.",
+      "of": "Relaciones de {name}",
+      "between": "Relaciones entre {a} y {b}",
+      "loading": "Cargando…",
+      "none": "Aún no hay relaciones. Usa «Conectar con…» en una tarjeta para añadir una.",
+      "edge": "{from} → {to}",
+      "label": "Etiqueta",
+      "arrow": "Flecha hacia {to}",
+      "save": "Guardar",
+      "delete": "Eliminar relación",
+      "menu": "Conexiones de {title}",
+      "open": "Relaciones…"
     },
     "region": "Vista global",
     "canvas": "Tarjetas de la vista global",
```

Modify `apps/desktop/src/stores/uiStore.ts` (apply this change):

```diff
@@ -8,6 +8,9 @@ export type DialogState =
   | { type: 'createPage'; source: string; target: string }
   | { type: 'openExternal'; url: string }
   | { type: 'openFile'; path: string }
+  /** A page's relationships, or (with `other`) those between two cards'
+   *  pages (M3b §3). */
+  | { type: 'relations'; page: string; other?: string }
   | null;
 
 /** Which screen the open vault shows (M3a §2). */
```

Note: The menu renders in a portal: React Flow's viewport is transformed, which would carry a `position: fixed` menu along with the canvas.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 && pnpm lint && pnpm check:i18n`
Expected: PASS — `Test Files  75 passed (75)`, `Tests  702 passed (702)`; lint clean; i18n in parity.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/app/icons.tsx apps/desktop/src/features/dialogs/DialogHost.tsx apps/desktop/src/features/global-view/Canvas.tsx apps/desktop/src/features/global-view/Card.module.css apps/desktop/src/features/global-view/Card.test.tsx apps/desktop/src/features/global-view/Card.tsx apps/desktop/src/features/global-view/CardMenu.tsx apps/desktop/src/features/global-view/GlobalView.edges.test.tsx apps/desktop/src/features/global-view/GlobalView.module.css apps/desktop/src/features/global-view/RelationsDialog.test.tsx apps/desktop/src/features/global-view/RelationsDialog.tsx apps/desktop/src/features/global-view/edges.tsx apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json apps/desktop/src/stores/uiStore.ts
git commit -F - <<'MSG'
feat(global-view): a card's connections menu and the Relationships dialog; direct relationship edges open it (M3b §3)

Each page card (and a folder card with an index note) gets its connect
button back as a menu button (ARIA menu, in a portal; arrow keys,
Escape returns focus). "Relationships…" opens a dialog listing the
page's related: entries — label (≤ 40 chars), arrow, Save, Delete —
written through stores/relations.ts; clicking a direct relationship
edge opens the dialog for the two cards (both pages' entries to each
other). Edges take the pointer through an invisible wide nopan stroke;
aggregated ones don't.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 6: Connecting cards: the connect handle (drag), Connect to… (click, keyboard)

Spec §2.

**Files:**
- Modify: `apps/desktop/src/features/global-view/Canvas.tsx`
- Modify: `apps/desktop/src/features/global-view/Card.module.css`
- Modify: `apps/desktop/src/features/global-view/Card.tsx`
- Create: `apps/desktop/src/features/global-view/Connect.test.tsx`
- Modify: `apps/desktop/src/features/global-view/GlobalView.module.css`
- Modify: `apps/desktop/src/features/global-view/GlobalView.tsx`
- Modify: `apps/desktop/src/features/global-view/gvStore.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`

**Interfaces:**
- Consumes: Task 4 (`relate`), Task 5 (menu, dialog).
- Produces: `gvStore`: `connectFrom`, `startConnect(card)`, `cancelConnect()`, `completeConnect(target)`, `connectByDrag(from, to | null)`, `pageOf(card)`; `Card` props `connecting?`, `wrapConnect?`; the connect bar (`role="status"`, "Connecting"); i18n `gv.relations.{connect,connecting,pick,noIndex,created}`.

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/src/features/global-view/Connect.test.tsx`:

```tsx
// Connecting cards (M3b §2): Connect to… then a card (click or keyboard), or
// a drag from the connect handle; the relationship goes into the source
// page's related: and the canvas re-reads its edges.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GvCard, GvLevel, GvLevelRef } from '../../ipc';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { fakeDisk, type FakeDisk } from '../../test/fakeDisk';
import { installReactFlowStubs } from '../../test/reactFlow';
import { SINGLE_CLICK_MS } from './Card';
import { GlobalView } from './GlobalView';
import { levelKey, useGvStore } from './gvStore';

beforeAll(installReactFlowStubs);

function card(path: string, extra: Partial<GvCard> = {}): GvCard {
  return {
    path,
    kind: 'page',
    title: path.replace(/\.md$/, ''),
    subtitle: null,
    cover: null,
    coverRemote: false,
    coverY: null,
    excerpt: '',
    hasImage: false,
    hasAudio: false,
    indexPage: null,
    pages: 0,
    folders: 0,
    childTitles: [],
    relation: null,
    ...extra,
  };
}

const LEVELS: Record<string, GvLevel> = {
  '': {
    cards: [
      card('Delta', { kind: 'project', title: 'Delta', pages: 2 }),
      card('Gamma', {
        kind: 'project',
        title: 'Gamma',
        indexPage: 'Gamma/b.md',
        indexFrom: 'picked',
      }),
      card('A.md'),
      card('B.md'),
    ],
    centre: null,
  },
};

let disk: FakeDisk;
let edgeReads = 0;

beforeEach(() => {
  edgeReads = 0;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useGvStore.getState().reset();
  useUiStore.setState({ screen: 'global', dialog: null });
  useToastStore.getState().clear();
  disk = fakeDisk(
    { 'A.md': '# A\n', 'B.md': '# B\n', 'Gamma/b.md': '# Gamma B\n' },
    {
      gv_children: (a) => {
        const level = LEVELS[levelKey(a.level as unknown as GvLevelRef)];
        if (!level) throw { kind: 'notFound', message: 'x' };
        return level;
      },
      gv_edges: () => {
        edgeReads++;
        return [];
      },
      layout_get: () => ({}),
      link_target: (a) => String(a.target).replace(/\.md$/, ''),
      links_resolve: (a) =>
        (a.targets as unknown as { target: string }[]).map((t) => `${t.target}.md`),
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  resetEditorStore();
  clearMocks();
});

const press = async (path: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-gv-card="${CSS.escape(path)}"]`);
    if (!el) throw new Error(`no card ${path}`);
    return el;
  });

async function startConnect(title: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Connections of ${title}` }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Connect to…' }));
}

describe('connecting two cards (M3b §2)', () => {
  it('Connect to…, then a click on another card: the source page gains the relationship', async () => {
    render(<GlobalView />);
    await startConnect('A');
    const bar = screen.getByRole('status', { name: 'Connecting' });
    expect(bar).toHaveTextContent('Pick the card to connect: A → ?');
    const reads = edgeReads;
    // A single click on B completes it (no drill-down).
    fireEvent.click(await press('B.md'));
    await waitFor(() =>
      expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n'),
    );
    expect(screen.queryByRole('status', { name: 'Connecting' })).not.toBeInTheDocument();
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }]);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'Relationship created.',
    );
    await waitFor(() => expect(edgeReads).toBeGreaterThan(reads));
  });

  it('by keyboard: Enter on Connect to…, arrows to the target, Enter', async () => {
    render(<GlobalView />);
    const button = await screen.findByRole('button', { name: 'Connections of A' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('menuitem', { name: 'Connect to…' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    // The keyboard goes back to the source card, and moves on from there.
    await waitFor(async () => expect(await press('A.md')).toHaveFocus());
    await userEvent.keyboard('{ArrowRight}{Enter}');
    await waitFor(() => expect(disk.files.get('A.md')).toContain('"[[B]]"'));
  });

  it('Escape or Cancel leaves connect mode; a click on the source card keeps it', async () => {
    render(<GlobalView />);
    await startConnect('A');
    fireEvent.click(await press('A.md'));
    await act(() => new Promise((r) => setTimeout(r, SINGLE_CLICK_MS + 20)));
    expect(screen.getByRole('status', { name: 'Connecting' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('status', { name: 'Connecting' })).not.toBeInTheDocument();
    await startConnect('A');
    (await press('B.md')).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('status', { name: 'Connecting' })).not.toBeInTheDocument();
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }]);
    expect(disk.writes()).toEqual([]);
  });

  it('a folder stands for its index note; one without can’t take part', async () => {
    render(<GlobalView />);
    await startConnect('A');
    fireEvent.click(await press('Gamma'));
    await waitFor(() => expect(disk.files.get('A.md')).toContain('"[[Gamma/b]]"'));
    await startConnect('A');
    fireEvent.click(await press('Delta'));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        'Delta has no index note. Pick one first.',
      ),
    );
    expect(screen.queryByRole('status', { name: 'Connecting' })).not.toBeInTheDocument();
  });

  it('a relationship that already exists opens its dialog instead of a duplicate', async () => {
    disk.files.set('A.md', '---\nrelated:\n  - "[[B]]"\n---\n# A\n');
    render(<GlobalView />);
    await startConnect('A');
    fireEvent.click(await press('B.md'));
    await waitFor(() =>
      expect(useUiStore.getState().dialog).toEqual({
        type: 'relations',
        page: 'A.md',
        other: 'B.md',
      }),
    );
    expect(disk.writes()).toEqual([]);
  });

  it('a drag from the connect handle onto a card relates them (connectByDrag)', async () => {
    render(<GlobalView />);
    await press('A.md');
    await act(() => useGvStore.getState().connectByDrag('A.md', 'B.md'));
    await waitFor(() => expect(disk.files.get('A.md')).toContain('"[[B]]"'));
    // Dropped on itself or on nothing: no relationship.
    await act(() => useGvStore.getState().connectByDrag('B.md', 'B.md'));
    await act(() => useGvStore.getState().connectByDrag('B.md', null));
    expect(disk.writes().filter((w) => w.path === 'B.md')).toEqual([]);
  });

  it('the source card is marked while connecting', async () => {
    render(<GlobalView />);
    await startConnect('A');
    const group = screen.getByRole('group', { name: 'A, page' });
    expect(group).toHaveAttribute('data-connecting');
    expect(within(group).getByRole('button', { name: 'A' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/features/global-view/Connect.test.tsx`
Expected: FAIL — 7 tests: `Unable to find an accessible element with the role "menuitem" and name "Connect to…"` (and `connectByDrag is not a function`).

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/global-view/Canvas.tsx` (apply this change):

```diff
@@ -1,5 +1,14 @@
 import '@xyflow/react/dist/base.css';
-import { ReactFlow, useNodesState, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
+import {
+  Handle,
+  Position,
+  ReactFlow,
+  useNodesState,
+  useReactFlow,
+  type Node,
+  type NodeProps,
+  type OnConnectEnd,
+} from '@xyflow/react';
 import {
   useCallback,
   useEffect,
@@ -7,6 +16,7 @@ import {
   useRef,
   type KeyboardEvent,
   type MouseEvent,
+  type ReactElement,
 } from 'react';
 import { useTranslation } from 'react-i18next';
 import type { GlobalViewEdges, GvCard } from '../../ipc';
@@ -14,7 +24,7 @@ import { useUiStore } from '../../stores/uiStore';
 import { Card } from './Card';
 import type { CardMenuItem } from './CardMenu';
 import { EdgeLayer, MAX_AGGREGATED, strongest, type DrawnEdge } from './edges';
-import { useGvStore } from './gvStore';
+import { pageOf, useGvStore } from './gvStore';
 import {
   CARD_H,
   CARD_W,
@@ -34,14 +44,23 @@ interface CardData extends Record<string, unknown> {
   focusable: boolean;
   connections: string;
   menu: CardMenuItem[];
+  connecting: boolean;
   onOpen: (card: GvCard) => void;
   onOpenEditor: (card: GvCard) => void;
 }
 
 type CardNode = Node<CardData, 'card'>;
 
-/** A card as a React Flow node. Edges need no handles: EdgeLayer draws
- *  them border to border (edges.tsx). */
+/** The connect button as React Flow's drag-to-connect source handle (M3b
+ *  §2): a press that moves draws the connection line; a click opens the
+ *  menu. Edges need no handles: EdgeLayer draws them border to border. */
+const connectHandle = (button: ReactElement) => (
+  <Handle type="source" position={Position.Right} className={styles.connectHandle}>
+    {button}
+  </Handle>
+);
+
+/** A card as a React Flow node. */
 function CardNodeView({ data }: NodeProps<CardNode>) {
   const setFocus = useGvStore((s) => s.setFocus);
   return (
@@ -52,6 +71,8 @@ function CardNodeView({ data }: NodeProps<CardNode>) {
         focusable={data.focusable}
         connections={data.connections}
         menu={data.menu}
+        connecting={data.connecting}
+        wrapConnect={connectHandle}
         onOpen={() => data.onOpen(data.card)}
         onOpenEditor={() => data.onOpenEditor(data.card)}
         onFocus={() => setFocus(data.card.path)}
@@ -87,6 +108,7 @@ export function Canvas({ mode, toggles, width, onOpen, onOpenEditor }: CanvasPro
   const pinned = useGvStore((s) => s.pinned);
   const expanded = useGvStore((s) => s.expanded);
   const focus = useGvStore((s) => s.focus);
+  const connectFrom = useGvStore((s) => s.connectFrom);
   const flow = useReactFlow();
   const wrapper = useRef<HTMLDivElement>(null);
 
@@ -184,9 +206,14 @@ export function Canvas({ mode, toggles, width, onOpen, onOpenEditor }: CanvasPro
    *  folder's index note. */
   const menuOf = useCallback(
     (card: GvCard): CardMenuItem[] => {
-      const page = card.kind === 'page' ? card.path : card.indexPage;
-      if (!page) return [];
+      const connect = {
+        label: t('gv.relations.connect'),
+        run: () => useGvStore.getState().startConnect(card),
+      };
+      const page = pageOf(card);
+      if (!page) return [connect];
       return [
+        connect,
         {
           label: t('gv.relations.open'),
           run: () => useUiStore.getState().openDialog({ type: 'relations', page }),
@@ -227,11 +254,22 @@ export function Canvas({ mode, toggles, width, onOpen, onOpenEditor }: CanvasPro
           focusable: card.path === tabStop,
           connections: connections(card.path),
           menu: menuOf(card),
+          connecting: connectFrom?.path === card.path,
           onOpen: open,
           onOpenEditor,
         },
       })),
-    [canvas, positions, expandedPaths, tabStop, connections, menuOf, open, onOpenEditor],
+    [
+      canvas,
+      positions,
+      expandedPaths,
+      tabStop,
+      connections,
+      menuOf,
+      connectFrom,
+      open,
+      onOpenEditor,
+    ],
   );
   const ariaLabelConfig = useMemo(
     () => ({
@@ -267,6 +305,23 @@ export function Canvas({ mode, toggles, width, onOpen, onOpenEditor }: CanvasPro
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [shownKey, nodes, canvas]);
 
+  // Connect mode started from a card's menu: the keyboard goes back to that
+  // card, to move on to the target from there (M3b §2).
+  useEffect(() => {
+    if (connectFrom) focusCard(connectFrom.path);
+  }, [connectFrom]);
+
+  /** A drag from a connect handle ended: the card under the pointer, if any,
+   *  is the other end (M3b §2). */
+  const onConnectEnd: OnConnectEnd = (event, state) => {
+    const from = state.fromNode?.id;
+    if (!from) return;
+    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
+    const under = point ? document.elementFromPoint(point.clientX, point.clientY) : null;
+    const to = under?.closest<HTMLElement>('[data-gv-card]')?.dataset.gvCard ?? null;
+    void useGvStore.getState().connectByDrag(from, to);
+  };
+
   /** Moves the keyboard to a card: at once when it is on screen, else after
    *  the next render (a level that just loaded). */
   function focusCard(path: string) {
@@ -319,8 +374,14 @@ export function Canvas({ mode, toggles, width, onOpen, onOpenEditor }: CanvasPro
         nodeTypes={nodeTypes}
         onNodesChange={onNodesChange}
         onNodeDragStop={(_, node) => useGvStore.getState().pin(node.id, node.position)}
-        nodesConnectable={false}
+        // Connections only start from the connect handles (M3b §2); React
+        // Flow's click-to-connect stays off: it uses structuredClone, which
+        // Safari 15.0–15.3 lacks — the menu's "Connect to…" replaces it.
+        nodesConnectable
         connectOnClick={false}
+        onConnectEnd={onConnectEnd}
+        connectionLineStyle={{ stroke: 'var(--color-edge-manual)', strokeWidth: 3 }}
+        onPaneClick={() => useGvStore.getState().cancelConnect()}
         elementsSelectable={false}
         nodesFocusable={false}
         edgesFocusable={false}
```

Modify `apps/desktop/src/features/global-view/Card.module.css` (apply this change):

```diff
@@ -18,6 +18,12 @@
   box-shadow: 0 0 0 2px var(--color-accent);
 }
 
+/* Connect mode starts here (M3b §2, prototype `.card.from`). */
+.card[data-connecting] {
+  border-color: var(--color-edge-manual);
+  box-shadow: 0 0 0 2px var(--color-edge-manual);
+}
+
 .head {
   display: flex;
   align-items: center;
```

Modify `apps/desktop/src/features/global-view/Card.tsx` (apply this change):

```diff
@@ -1,4 +1,12 @@
-import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
+import {
+  useEffect,
+  useId,
+  useRef,
+  useState,
+  type KeyboardEvent,
+  type ReactElement,
+  type ReactNode,
+} from 'react';
 import { useTranslation } from 'react-i18next';
 import { AudioIcon, FolderIcon, GripIcon, ImageIcon, LinkIcon } from '../../app/icons';
 import { assetUrl, type GvCard } from '../../ipc';
@@ -20,6 +28,11 @@ export interface CardProps {
   connections: string;
   /** The connect button's menu (M3b §3); none: no button. */
   menu?: CardMenuItem[];
+  /** Connect mode starts from this card (M3b §2): manual-colour ring. */
+  connecting?: boolean;
+  /** Wraps the connect button (the canvas makes it a drag-to-connect
+   *  handle, M3b §2). */
+  wrapConnect?: (button: ReactElement) => ReactNode;
   /** Single click / Enter: the next level (GV-11). */
   onOpen: () => void;
   /** Double click / Shift+Enter / See all: the editor (GV-12). */
@@ -34,6 +47,8 @@ export function Card({
   focusable,
   connections,
   menu = [],
+  connecting = false,
+  wrapConnect = (button) => button,
   onOpen,
   onOpenEditor,
   onFocus,
@@ -106,6 +121,7 @@ export function Card({
     <div
       className={styles.card}
       data-open={open || undefined}
+      data-connecting={connecting || undefined}
       role="group"
       aria-label={t('gv.cardName', { title: card.title, kind: kind.toLocaleLowerCase() })}
     >
@@ -114,21 +130,22 @@ export function Card({
         <span className={`${styles.grip} gv-grip`} title={t('gv.move')} aria-hidden="true">
           <GripIcon />
         </span>
-        {menu.length > 0 && (
-          <button
-            ref={menuButton}
-            type="button"
-            className={`${styles.connect} nodrag`}
-            tabIndex={focusable ? 0 : -1}
-            aria-haspopup="menu"
-            aria-expanded={menuOpen}
-            aria-label={t('gv.relations.menu', { title: card.title })}
-            title={t('gv.relations.menu', { title: card.title })}
-            onClick={() => setMenuOpen((o) => !o)}
-          >
-            <LinkIcon />
-          </button>
-        )}
+        {menu.length > 0 &&
+          wrapConnect(
+            <button
+              ref={menuButton}
+              type="button"
+              className={`${styles.connect} nodrag`}
+              tabIndex={focusable ? 0 : -1}
+              aria-haspopup="menu"
+              aria-expanded={menuOpen}
+              aria-label={t('gv.relations.menu', { title: card.title })}
+              title={t('gv.relations.menu', { title: card.title })}
+              onClick={() => setMenuOpen((o) => !o)}
+            >
+              <LinkIcon />
+            </button>,
+          )}
         {menuOpen && menuButton.current && (
           <CardMenu
             label={t('gv.relations.menu', { title: card.title })}
```

Modify `apps/desktop/src/features/global-view/GlobalView.module.css` (apply this change):

```diff
@@ -303,3 +303,45 @@
   outline: 2px solid var(--color-focus);
   outline-offset: 3px;
 }
+
+/* The connect button is React Flow's source handle (M3b §2): laid out as
+   the button it wraps, not as React Flow's small dot. */
+.connectHandle:global(.react-flow__handle) {
+  position: static;
+  width: auto;
+  height: auto;
+  min-width: 0;
+  min-height: 0;
+  transform: none;
+  border: 0;
+  border-radius: 0;
+  background: none;
+}
+
+/* Connect mode (M3b §2, prototype `.relbar`): what to do, and Cancel. */
+.connectBar {
+  display: flex;
+  align-items: center;
+  gap: 12px;
+  flex-wrap: wrap;
+  padding: 10px 20px;
+  background: var(--color-warn-bg);
+  color: var(--color-warn-text);
+  border-bottom: 1px solid var(--color-warn-border);
+  font: 600 14px var(--font-body);
+}
+
+.connectBar button {
+  min-height: 34px;
+  padding: 6px 12px;
+  border: 1px solid var(--color-border-strong);
+  border-radius: var(--radius-md);
+  background: var(--color-surface);
+  color: var(--color-text);
+  font: 600 13px var(--font-body);
+  cursor: pointer;
+}
+
+.connectText {
+  margin: 0;
+}
```

Modify `apps/desktop/src/features/global-view/GlobalView.tsx` (apply this change):

```diff
@@ -1,7 +1,7 @@
 import { ReactFlowProvider } from '@xyflow/react';
 import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
 import { useTranslation } from 'react-i18next';
-import { PlusIcon } from '../../app/icons';
+import { LinkIcon, PlusIcon } from '../../app/icons';
 import { entryCreatePage, type GvCard } from '../../ipc';
 import { useEditorStore } from '../../stores/editorStore';
 import { errorMessage } from '../../stores/messages';
@@ -27,6 +27,7 @@ export function GlobalView() {
   const loaded = useGvStore((s) => s.loaded);
   const empty = useGvStore((s) => s.canvas.cards.length === 0);
   const shownKey = useGvStore((s) => s.shownKey);
+  const connectFrom = useGvStore((s) => s.connectFrom);
   // A hub page's neighbourhood is capped (final review m14): say how many
   // linked pages the level leaves out.
   const omitted = useGvStore((s) => (s.shownKey ? (s.levels[s.shownKey]?.omitted ?? 0) : 0));
@@ -97,8 +98,13 @@ export function GlobalView() {
 
   const onOpen = useCallback((card: GvCard) => void useGvStore.getState().open(card), []);
   /** Double click / See all (GV-12): the page, or a folder's index note; a
-   *  folder without one opens as the next level. */
+   *  folder without one opens as the next level. In connect mode it picks
+   *  the card (M3b §2). */
   const onOpenEditor = useCallback((card: GvCard) => {
+    if (useGvStore.getState().connectFrom) {
+      void useGvStore.getState().completeConnect(card);
+      return;
+    }
     const page = card.kind === 'page' ? card.path : card.indexPage;
     if (page) void openPage(page);
     else void useGvStore.getState().open(card);
@@ -120,6 +126,17 @@ export function GlobalView() {
   return (
     <section ref={region} className={styles.view} aria-label={t('gv.region')}>
       <Toolbar />
+      {connectFrom && (
+        <div className={styles.connectBar}>
+          <LinkIcon />
+          <p role="status" aria-label={t('gv.relations.connecting')} className={styles.connectText}>
+            {t('gv.relations.pick', { name: connectFrom.title })}
+          </p>
+          <button type="button" onClick={() => useGvStore.getState().cancelConnect()}>
+            {t('dialogs.cancel')}
+          </button>
+        </div>
+      )}
       <div ref={area} className={styles.area}>
         <ReactFlowProvider>
           <Canvas
```

Modify `apps/desktop/src/features/global-view/gvStore.ts` (apply this change):

```diff
@@ -17,8 +17,10 @@ import {
   type IpcResult,
 } from '../../ipc';
 import { errorMessage } from '../../stores/messages';
+import { relate } from '../../stores/relations';
 import { useSettingsStore } from '../../stores/settingsStore';
 import { useToastStore } from '../../stores/toastStore';
+import { useUiStore } from '../../stores/uiStore';
 import { onBeforeVaultSwitch, useVaultStore } from '../../stores/vaultStore';
 
 /** Saving a dragged card waits this long for the next drag (M3a §7). */
@@ -36,6 +38,11 @@ export const nextLevel = (card: GvCard): GvLevelRef =>
 export const canvasKey = (mode: GlobalViewMode, root: GvLevelRef): string =>
   mode === 'expand' ? `expand:${levelKey(root)}` : levelKey(root);
 
+/** The page a card stands for in a relationship (M3b §2): itself, or a
+ *  folder's index note; `null` for a folder without one. */
+export const pageOf = (card: GvCard): string | null =>
+  card.kind === 'page' ? card.path : card.indexPage;
+
 /** What the canvas shows, derived from the loaded levels. */
 export interface Canvas {
   /** Every card on the canvas, once. */
@@ -97,6 +104,8 @@ interface GvState {
   pinned: Record<string, CardPosition>;
   /** The card with keyboard focus (roving tabindex). */
   focus: string | null;
+  /** Connect mode (M3b §2): the card a relationship starts from. */
+  connectFrom: GvCard | null;
   loaded: boolean;
   /** Reads what the canvas shows: levels (falling back from deleted ones;
    *  any other failure keeps what is shown), edges and pinned positions. */
@@ -116,6 +125,13 @@ interface GvState {
   pin: (path: string, at: CardPosition) => void;
   resetLayout: () => Promise<void>;
   setFocus: (path: string | null) => void;
+  /** "Connect to…": the next card picked completes the relationship. */
+  startConnect: (card: GvCard) => void;
+  cancelConnect: () => void;
+  /** A card picked in connect mode (click, Enter). */
+  completeConnect: (target: GvCard) => Promise<void>;
+  /** A drag from `from`'s connect handle dropped on `to` (or on nothing). */
+  connectByDrag: (from: string, to: string | null) => Promise<void>;
   reset: () => void;
 }
 
@@ -203,7 +219,34 @@ export const useGvStore = create<GvState>((set, get) => {
     }
   }
 
+  /** A folder without an index note can't take part (M3b §2). */
+  function needsIndex(card: GvCard): boolean {
+    if (pageOf(card)) return false;
+    useToastStore.getState().push({
+      message: i18next.t('gv.relations.noIndex', { name: card.title }),
+      tone: 'error',
+    });
+    return true;
+  }
+
+  /** Relates the pages `from` and `to` stand for: a new relationship (the
+   *  edges are re-read), or the dialog of the one that exists. */
+  async function relateCards(from: GvCard, to: GvCard) {
+    if (needsIndex(from) || needsIndex(to)) return;
+    const source = pageOf(from)!;
+    const target = pageOf(to)!;
+    if (source === target) return;
+    const res = await relate(source, target);
+    if (res.status === 'created') {
+      useToastStore.getState().push({ message: i18next.t('gv.relations.created'), tone: 'info' });
+      await get().load();
+    } else if (res.status === 'exists') {
+      useUiStore.getState().openDialog({ type: 'relations', page: source, other: target });
+    }
+  }
+
   return {
+    connectFrom: null,
     stack: [{ kind: 'vault' }],
     expanded: [],
     levels: {},
@@ -272,6 +315,8 @@ export const useGvStore = create<GvState>((set, get) => {
       });
     },
     open: async (card) => {
+      // Connect mode: a click picks the other card (no navigation, M3b §2).
+      if (get().connectFrom) return get().completeConnect(card);
       if (mode() === 'drill') {
         // The page this level is about: already open (final review m2).
         if (card.path === get().canvas.centre) return;
@@ -290,6 +335,7 @@ export const useGvStore = create<GvState>((set, get) => {
       return get().load();
     },
     back: async (i) => {
+      set({ connectFrom: null });
       const stack = get().stack.slice(0, Math.max(1, i + 1));
       // A level is opened from the card of the same path: the keyboard goes
       // back to it (final review m13).
@@ -299,6 +345,7 @@ export const useGvStore = create<GvState>((set, get) => {
       return get().load();
     },
     up: async (path) => {
+      if (get().connectFrom) return get().cancelConnect();
       if (mode() === 'expand') {
         const ref = get().expanded.find((r) => r.kind !== 'vault' && r.path === path);
         const card = get().canvas.cards.find((c) => c.path === path);
@@ -308,7 +355,7 @@ export const useGvStore = create<GvState>((set, get) => {
       if (get().stack.length > 1) return get().back(get().stack.length - 2);
     },
     modeChanged: async () => {
-      set({ expanded: [], focus: null });
+      set({ expanded: [], focus: null, connectFrom: null });
       return get().load();
     },
     entryDir: () => {
@@ -354,6 +401,24 @@ export const useGvStore = create<GvState>((set, get) => {
       reportSave(await layoutSet(key, {}));
     },
     setFocus: (focus) => set({ focus }),
+    startConnect: (card) => {
+      if (needsIndex(card)) return;
+      set({ connectFrom: card, focus: card.path });
+    },
+    cancelConnect: () => set({ connectFrom: null }),
+    completeConnect: async (target) => {
+      const from = get().connectFrom;
+      if (!from || target.path === from.path) return;
+      set({ connectFrom: null });
+      await relateCards(from, target);
+    },
+    connectByDrag: async (from, to) => {
+      if (!to || to === from) return;
+      const cards = get().canvas.cards;
+      const a = cards.find((c) => c.path === from);
+      const b = cards.find((c) => c.path === to);
+      if (a && b) await relateCards(a, b);
+    },
     reset: () => {
       seq++;
       if (pinTimer) clearTimeout(pinTimer);
@@ -363,6 +428,7 @@ export const useGvStore = create<GvState>((set, get) => {
       saveFailed = false;
       shownAt = null;
       set({
+        connectFrom: null,
         stack: [{ kind: 'vault' }],
         expanded: [],
         levels: {},
```

Modify `apps/desktop/src/i18n/locales/en.json` (apply this change):

```diff
@@ -281,6 +281,11 @@
   "gv": {
     "relations": {
       "changedOnDisk": "Couldn’t update {name}: it changed on disk. Try again.",
+      "connect": "Connect to…",
+      "connecting": "Connecting",
+      "pick": "Pick the card to connect: {name} → ?",
+      "noIndex": "{name} has no index note. Pick one first.",
+      "created": "Relationship created.",
       "of": "Relationships of {name}",
       "between": "Relationships between {a} and {b}",
       "loading": "Loading…",
```

Modify `apps/desktop/src/i18n/locales/es.json` (apply this change):

```diff
@@ -281,6 +281,11 @@
   "gv": {
     "relations": {
       "changedOnDisk": "No se pudo actualizar {name}: cambió en el disco. Inténtalo de nuevo.",
+      "connect": "Conectar con…",
+      "connecting": "Conectando",
+      "pick": "Elige la tarjeta que conectar: {name} → ?",
+      "noIndex": "{name} no tiene nota índice. Elige una primero.",
+      "created": "Relación creada.",
       "of": "Relaciones de {name}",
       "between": "Relaciones entre {a} y {b}",
       "loading": "Cargando…",
```

Note: `nodesConnectable` is on so the handle starts connections; `connectOnClick={false}` keeps React Flow's click-to-connect path (its only `structuredClone`, Safari 15.0–15.3) unreachable. The drop target is the card under the pointer on release (`elementFromPoint` → `[data-gv-card]`); cards have no target handles.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 && pnpm lint && pnpm check:i18n`
Expected: PASS — `Test Files  76 passed (76)`, `Tests  709 passed (709)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/global-view/Canvas.tsx apps/desktop/src/features/global-view/Card.module.css apps/desktop/src/features/global-view/Card.tsx apps/desktop/src/features/global-view/Connect.test.tsx apps/desktop/src/features/global-view/GlobalView.module.css apps/desktop/src/features/global-view/GlobalView.tsx apps/desktop/src/features/global-view/gvStore.ts apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json
git commit -F - <<'MSG'
feat(global-view): connect two cards — drag from the connect handle, or Connect to… then a card (M3b §2)

The connect button is React Flow's source handle: a press that moves
draws the connection line (manual colour); dropping on a card relates
the pages. "Connect to…" in the card's menu enters connect mode: a status
bar ("Pick the card to connect: A → ?", Cancel), the source card ringed,
the keyboard back on it; the next click or Enter on a card completes it,
Escape / Cancel / a click on the background leaves. A folder stands for
its index note; one without says so. A relationship that exists opens
its dialog instead of a duplicate. React Flow's click-to-connect stays
off (structuredClone, Safari 15.0–15.3).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 7: Picking a folder’s index note

Spec §4.

**Files:**
- Modify: `apps/desktop/src/features/dialogs/DialogHost.tsx`
- Modify: `apps/desktop/src/features/global-view/Canvas.tsx`
- Modify: `apps/desktop/src/features/global-view/Connect.test.tsx`
- Create: `apps/desktop/src/features/global-view/IndexPickDialog.test.tsx`
- Create: `apps/desktop/src/features/global-view/IndexPickDialog.tsx`
- Modify: `apps/desktop/src/features/global-view/gvStore.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/stores/uiStore.ts`

**Interfaces:**
- Consumes: Task 2 (`indexPickSet`, `GvCard.indexFrom`), Task 6 (menu, `needsIndex` toast).
- Produces: `IndexPickDialog({ folder, current, onClose })`; dialog state `{ type: "indexPick"; folder; current }`; `gvStore` `pickable(card)`, `openIndexPick(card)`; i18n `gv.indexPick.*`.

- [ ] **Step 1: Write the failing test(s)**

Modify `apps/desktop/src/features/global-view/Connect.test.tsx` (apply this change):

```diff
@@ -199,4 +199,30 @@ describe('connecting two cards (M3b §2)', () => {
     expect(group).toHaveAttribute('data-connecting');
     expect(within(group).getByRole('button', { name: 'A' })).toBeInTheDocument();
   });
+
+  it('a folder without an index note offers to pick one (menu and toast action)', async () => {
+    render(<GlobalView />);
+    await userEvent.click(await screen.findByRole('button', { name: 'Connections of Delta' }));
+    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
+      'Connect to…',
+      'Pick index note…',
+    ]);
+    await userEvent.click(screen.getByRole('menuitem', { name: 'Connect to…' }));
+    const toast = useToastStore.getState().toasts.at(-1)!;
+    expect(toast.action?.label).toBe('Pick index note…');
+    act(() => toast.action!.run());
+    expect(useUiStore.getState().dialog).toEqual({
+      type: 'indexPick',
+      folder: 'Delta',
+      current: null,
+    });
+    // A picked index note can be changed too.
+    await userEvent.click(screen.getByRole('button', { name: 'Connections of Gamma' }));
+    await userEvent.click(screen.getByRole('menuitem', { name: 'Pick index note…' }));
+    expect(useUiStore.getState().dialog).toEqual({
+      type: 'indexPick',
+      folder: 'Gamma',
+      current: 'Gamma/b.md',
+    });
+  });
 });
```

Create `apps/desktop/src/features/global-view/IndexPickDialog.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { IndexPickDialog } from './IndexPickDialog';

let calls: [string, unknown][];
let fail = false;

beforeEach(() => {
  calls = [];
  fail = false;
  useToastStore.getState().clear();
  useVaultStore.setState({
    nodes: [
      { path: 'Delta', kind: 'folder' },
      { path: 'Delta/x.md', kind: 'page' },
      { path: 'Delta/y.md', kind: 'page' },
      { path: 'Delta/Inner', kind: 'folder' },
      { path: 'Delta/Inner/i.md', kind: 'page' },
      { path: 'Delta/pic.png', kind: 'attachment' },
      { path: 'Other.md', kind: 'page' },
    ],
  } as never);
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'index_pick_set') {
      if (fail) throw { kind: 'notFound', message: 'gone' };
      return { path: 'Delta' };
    }
    return null;
  });
});
afterEach(() => clearMocks());

describe('index note pick (M3b §4)', () => {
  it('lists the folder’s own pages; the choice is saved', async () => {
    const onClose = vi.fn();
    render(<IndexPickDialog folder="Delta" current={null} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Index note for Delta' })).toBeVisible();
    const options = screen
      .getAllByRole('radio')
      .map((r) => r.getAttribute('aria-label') ?? r.closest('label')?.textContent);
    expect(options).toEqual(['No index note', 'x', 'y']);
    expect(screen.getByRole('radio', { name: 'No index note' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'y' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toContainEqual(['index_pick_set', { folder: 'Delta', page: 'Delta/y.md' }]);
  });

  it('clearing a pick sends none', async () => {
    render(<IndexPickDialog folder="Delta" current="Delta/x.md" onClose={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'x' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'No index note' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual(['index_pick_set', { folder: 'Delta', page: null }]),
    );
  });

  it('many pages: a search narrows the list', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ path: `Big/p${i}.md`, kind: 'page' }));
    useVaultStore.setState({ nodes: [{ path: 'Big', kind: 'folder' }, ...pages] } as never);
    render(<IndexPickDialog folder="Big" current={null} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a page' }), 'p1');
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([
      'No index note',
      'p1',
      'p10',
      'p11',
    ]);
  });

  it('a failed save says why and keeps the dialog', async () => {
    fail = true;
    const onClose = vi.fn();
    render(<IndexPickDialog folder="Delta" current={null} onClose={onClose} />);
    await userEvent.click(screen.getByRole('radio', { name: 'x' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    render(<IndexPickDialog folder="Delta" current={null} onClose={vi.fn()} />);
    const violations = await axe
      .run(screen.getByRole('dialog'), { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/features/global-view/IndexPickDialog.test.tsx src/features/global-view/Connect.test.tsx`
Expected: FAIL — `Failed to resolve import "./IndexPickDialog"`; `expected [ 'Connect to…' ] to deeply equal [ 'Connect to…', 'Pick index note…' ]`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/dialogs/DialogHost.tsx` (apply this change):

```diff
@@ -1,4 +1,5 @@
 import { useUiStore } from '../../stores/uiStore';
+import { IndexPickDialog } from '../global-view/IndexPickDialog';
 import { RelationsDialog } from '../global-view/RelationsDialog';
 import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
 import { CreatePageDialog, OpenExternalDialog, OpenFileDialog } from './LinkDialogs';
@@ -23,6 +24,8 @@ export function DialogHost() {
       return <OpenExternalDialog url={dialog.url} onClose={close} />;
     case 'openFile':
       return <OpenFileDialog path={dialog.path} onClose={close} />;
+    case 'indexPick':
+      return <IndexPickDialog folder={dialog.folder} current={dialog.current} onClose={close} />;
     case 'relations':
       return <RelationsDialog page={dialog.page} other={dialog.other} onClose={close} />;
   }
```

Modify `apps/desktop/src/features/global-view/Canvas.tsx` (apply this change):

```diff
@@ -24,7 +24,7 @@ import { useUiStore } from '../../stores/uiStore';
 import { Card } from './Card';
 import type { CardMenuItem } from './CardMenu';
 import { EdgeLayer, MAX_AGGREGATED, strongest, type DrawnEdge } from './edges';
-import { pageOf, useGvStore } from './gvStore';
+import { openIndexPick, pageOf, pickable, useGvStore } from './gvStore';
 import {
   CARD_H,
   CARD_W,
@@ -211,14 +211,17 @@ export function Canvas({ mode, toggles, width, onOpen, onOpenEditor }: CanvasPro
         run: () => useGvStore.getState().startConnect(card),
       };
       const page = pageOf(card);
-      if (!page) return [connect];
-      return [
-        connect,
-        {
+      const items: CardMenuItem[] = [connect];
+      if (page) {
+        items.push({
           label: t('gv.relations.open'),
           run: () => useUiStore.getState().openDialog({ type: 'relations', page }),
-        },
-      ];
+        });
+      }
+      if (pickable(card)) {
+        items.push({ label: t('gv.indexPick.pick'), run: () => openIndexPick(card) });
+      }
+      return items;
     },
     [t],
   );
```

Create `apps/desktop/src/features/global-view/IndexPickDialog.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { indexPickSet } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import styles from '../dialogs/Dialogs.module.css';
import { useGvStore } from './gvStore';

/** A list longer than this gets a search field. */
const SEARCH_FROM = 10;
const stem = (path: string) => nameOf(path).replace(/\.md$/i, '');

/** Picks the page a folder's card previews (M3b §4, GV-02 rule 3): one of
 *  the folder's own pages, or none. Saved in `.nimw/vault.json`. */
export function IndexPickDialog({
  folder,
  current,
  onClose,
}: {
  folder: string;
  current: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useVaultStore((s) => s.nodes);
  const pages = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'page' && parentOf(n.path) === folder)
        .map((n) => n.path)
        .sort((a, b) => stem(a).localeCompare(stem(b), undefined, { numeric: true })),
    [nodes, folder],
  );
  const [choice, setChoice] = useState<string | null>(current);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = query.trim()
    ? pages.filter((p) => stem(p).toLowerCase().includes(query.trim().toLowerCase()))
    : pages;

  const save = async () => {
    setBusy(true);
    const res = await indexPickSet(folder, choice);
    setBusy(false);
    if (!res.ok) {
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      return;
    }
    onClose();
    if (useGvStore.getState().loaded) void useGvStore.getState().load();
  };

  return (
    <Dialog title={t('gv.indexPick.title', { name: nameOf(folder) })} onClose={onClose}>
      <p className={styles.text}>{t('gv.indexPick.hint')}</p>
      {pages.length > SEARCH_FROM && (
        <label className={styles.field}>
          <span>{t('gv.indexPick.search')}</span>
          <input
            className={styles.hexInput}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <fieldset className={styles.fieldset}>
        <legend>{t('gv.indexPick.legend')}</legend>
        <label className={styles.check}>
          <input
            type="radio"
            name="index-pick"
            checked={choice === null}
            onChange={() => setChoice(null)}
          />
          {t('gv.indexPick.none')}
        </label>
        {shown.map((p) => (
          <label key={p} className={styles.check}>
            <input
              type="radio"
              name="index-pick"
              checked={choice === p}
              onChange={() => setChoice(p)}
            />
            {stem(p)}
          </label>
        ))}
      </fieldset>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={busy}
          onClick={() => void save()}
        >
          {t('gv.relations.save')}
        </button>
      </div>
    </Dialog>
  );
}
```

Modify `apps/desktop/src/features/global-view/gvStore.ts` (apply this change):

```diff
@@ -38,6 +38,19 @@ export const nextLevel = (card: GvCard): GvLevelRef =>
 export const canvasKey = (mode: GlobalViewMode, root: GvLevelRef): string =>
   mode === 'expand' ? `expand:${levelKey(root)}` : levelKey(root);
 
+/** A folder card whose index note may be picked (M3b §4): none of GV-02's
+ *  rules 1–2 (named like the folder, `index.md`) gives one. */
+export const pickable = (card: GvCard): boolean =>
+  card.kind !== 'page' && card.indexFrom !== 'named' && card.indexFrom !== 'index';
+
+/** Opens the index-note pick for a folder card. */
+export const openIndexPick = (card: GvCard) =>
+  useUiStore.getState().openDialog({
+    type: 'indexPick',
+    folder: card.path,
+    current: card.indexFrom === 'picked' ? card.indexPage : null,
+  });
+
 /** The page a card stands for in a relationship (M3b §2): itself, or a
  *  folder's index note; `null` for a folder without one. */
 export const pageOf = (card: GvCard): string | null =>
@@ -225,6 +238,7 @@ export const useGvStore = create<GvState>((set, get) => {
     useToastStore.getState().push({
       message: i18next.t('gv.relations.noIndex', { name: card.title }),
       tone: 'error',
+      action: { label: i18next.t('gv.indexPick.pick'), run: () => openIndexPick(card) },
     });
     return true;
   }
```

Modify `apps/desktop/src/i18n/locales/en.json` (apply this change):

```diff
@@ -279,6 +279,14 @@
     "obsidianFolder": "the “{name}” folder"
   },
   "gv": {
+    "indexPick": {
+      "title": "Index note for {name}",
+      "hint": "The page this folder’s card shows in the Global View.",
+      "search": "Find a page",
+      "legend": "Index note",
+      "none": "No index note",
+      "pick": "Pick index note…"
+    },
     "relations": {
       "changedOnDisk": "Couldn’t update {name}: it changed on disk. Try again.",
       "connect": "Connect to…",
```

Modify `apps/desktop/src/i18n/locales/es.json` (apply this change):

```diff
@@ -279,6 +279,14 @@
     "obsidianFolder": "la carpeta «{name}»"
   },
   "gv": {
+    "indexPick": {
+      "title": "Nota índice de {name}",
+      "hint": "La página que muestra la tarjeta de esta carpeta en la Vista global.",
+      "search": "Buscar una página",
+      "legend": "Nota índice",
+      "none": "Sin nota índice",
+      "pick": "Elegir nota índice…"
+    },
     "relations": {
       "changedOnDisk": "No se pudo actualizar {name}: cambió en el disco. Inténtalo de nuevo.",
       "connect": "Conectar con…",
```

Modify `apps/desktop/src/stores/uiStore.ts` (apply this change):

```diff
@@ -11,6 +11,8 @@ export type DialogState =
   /** A page's relationships, or (with `other`) those between two cards'
    *  pages (M3b §3). */
   | { type: 'relations'; page: string; other?: string }
+  /** A folder's index note (M3b §4); `current`: the page picked now. */
+  | { type: 'indexPick'; folder: string; current: string | null }
   | null;
 
 /** Which screen the open vault shows (M3a §2). */
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 && pnpm lint && pnpm check:i18n`
Expected: PASS — `Test Files  77 passed (77)`, `Tests  715 passed (715)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/dialogs/DialogHost.tsx apps/desktop/src/features/global-view/Canvas.tsx apps/desktop/src/features/global-view/Connect.test.tsx apps/desktop/src/features/global-view/IndexPickDialog.test.tsx apps/desktop/src/features/global-view/IndexPickDialog.tsx apps/desktop/src/features/global-view/gvStore.ts apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json apps/desktop/src/stores/uiStore.ts
git commit -F - <<'MSG'
feat(global-view): pick a folder's index note (M3b §4)

A folder card whose index note doesn't come from GV-02 rules 1–2 offers
"Pick index note…" in its connections menu (and as the action of the
"has no index note" toast). The dialog lists the folder's own pages
(search when there are more than 10) plus "No index note", saves
through index_pick_set and re-reads the level.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 8: End to end in Chromium and WebKit; zero network

Spec §8.

**Files:**
- Modify: `apps/desktop/e2e/ipcMock.ts`
- Create: `apps/desktop/e2e/m3b.spec.ts`
- Modify: `apps/desktop/e2e/remote.md`
- Modify: `apps/desktop/e2e/zero-network.spec.ts`
- Modify: `apps/desktop/playwright.config.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `e2e/m3b.spec.ts`; the IPC mock answers `link_target`, `index_pick_set`, and draws manual edges from frontmatter `related:` lines; `playwright.config.ts` runs `m3b` in WebKit too.

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/e2e/m3b.spec.ts`:

```ts
// M3b in the built UI, in Chromium and WebKit (≈ WKWebView): connecting
// cards (Connect to… and a click, the keyboard, a drag from the connect
// handle), editing a relationship from its edge, deleting it, and picking a
// folder's index note.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

const PAGES = {
  'Alpha/One.md': '# One\n\nThe first.\n',
  'Beta/Three.md': '# Three\n\nThird.\n',
  'Beta/Four.md': '# Four\n\nFourth.\n',
  'Notes.md': '# Notes\n\nLoose notes.\n',
  'Welcome.md': '# Welcome\n\nStart here.\n',
};

async function globalView(page: Page, pages: Record<string, string> = PAGES) {
  await page.addInitScript(installIpcMock, {
    pages: { ...pages },
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('button', { name: 'Global view' }).click();
  await expect(page.getByRole('button', { name: 'Welcome', exact: true })).toBeVisible();
}

const card = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const writesTo = (page: Page, path: string) =>
  page.evaluate(
    (p) =>
      (
        (window as unknown as { __nimwWrites?: { path: string; text: string }[] }).__nimwWrites ??
        []
      )
        .filter((w) => w.path === p)
        .map((w) => w.text),
    path,
  );

test('Connect to…, then a click on a card: the source page gains the relationship and an edge', async ({
  page,
}) => {
  await globalView(page);
  await page.getByRole('button', { name: 'Connections of Welcome' }).click();
  await page.getByRole('menuitem', { name: 'Connect to…' }).click();
  await expect(page.getByRole('status', { name: 'Connecting' })).toContainText(
    'Pick the card to connect: Welcome → ?',
  );
  await card(page, 'Notes').click();
  await expect
    .poll(() => writesTo(page, 'Welcome.md'))
    .toEqual(['---\nrelated:\n  - "[[Notes]]"\n---\n# Welcome\n\nStart here.\n']);
  await expect(page.getByRole('status', { name: 'Connecting' })).toHaveCount(0);
  await expect(page.locator('[data-gv-edge="manual"]')).toHaveCount(1);
});

test('by keyboard: the menu, Connect to…, an arrow to the target, Enter', async ({ page }) => {
  await globalView(page);
  // Level 0 in three columns: Alpha, Beta, Notes over Welcome.
  await page.getByRole('button', { name: 'Connections of Notes' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Connect to…' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card(page, 'Notes')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(card(page, 'Welcome')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => writesTo(page, 'Notes.md')).toHaveLength(1);
  expect((await writesTo(page, 'Notes.md'))[0]).toContain('"[[Welcome]]"');
});

test('a drag from the connect handle onto another card relates them', async ({ page }) => {
  await globalView(page);
  const from = (await page.getByRole('button', { name: 'Connections of Welcome' }).boundingBox())!;
  const to = (await card(page, 'Notes').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() => writesTo(page, 'Welcome.md'))
    .toEqual(['---\nrelated:\n  - "[[Notes]]"\n---\n# Welcome\n\nStart here.\n']);
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('a relationship’s edge opens its dialog: label and arrow, then delete', async ({ page }) => {
  await globalView(page, {
    ...PAGES,
    'Welcome.md': '---\nrelated:\n  - "[[Notes]]"\n---\n# Welcome\n\nStart here.\n',
  });
  const hit = page.locator('[data-gv-hit]');
  await expect(hit).toHaveCount(1);
  await hit.click({ force: true });
  const dialog = page.getByRole('dialog', { name: 'Relationships between Notes and Welcome' });
  await expect(dialog).toBeVisible();
  const row = dialog.getByRole('group', { name: 'Welcome → Notes' });
  await row.getByRole('textbox', { name: 'Label' }).fill('inspired');
  await row.getByRole('checkbox', { name: 'Arrow to Notes' }).check();
  await row.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(async () => (await writesTo(page, 'Welcome.md')).at(-1))
    .toBe(
      '---\nrelated:\n  - { link: "[[Notes]]", label: inspired, directed: true }\n---\n# Welcome\n\nStart here.\n',
    );
  await expect(page.locator('[data-gv-arrow]')).toHaveCount(1);

  // The dialog is axe-clean in a real engine.
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const { axe } = window as unknown as {
      axe: { run: (el: Element) => Promise<{ violations: { id: string }[] }> };
    };
    const res = await axe.run(document.querySelector('[role="dialog"]')!);
    return res.violations.map((v) => v.id);
  });
  expect(violations).toEqual([]);

  await row.getByRole('button', { name: 'Delete relationship' }).click();
  await expect
    .poll(async () => (await writesTo(page, 'Welcome.md')).at(-1))
    .toBe('# Welcome\n\nStart here.\n');
  await expect(dialog.getByText('No relationships yet.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('[data-gv-edge="manual"]')).toHaveCount(0);
});

test('a folder without an index note: pick one, and its card previews it', async ({ page }) => {
  await globalView(page);
  await page.getByRole('button', { name: 'Connections of Beta' }).click();
  await page.getByRole('menuitem', { name: 'Pick index note…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Index note for Beta' });
  await dialog.getByRole('radio', { name: 'Four' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Beta, project' })).toContainText('Project · Beta');
});
```

Modify `apps/desktop/e2e/zero-network.spec.ts` (apply this change):

```diff
@@ -153,3 +153,25 @@ test('zero network requests: the Global View', async ({ page }) => {
   expect(csp).toEqual([]);
   expect(outside).toEqual([]);
 });
+
+// M3b: connecting cards, the relationships dialog and an index-note pick
+// load nothing from outside either.
+test('zero network requests: relationships in the Global View', async ({ page }) => {
+  const { outside, problems } = await openRemotePage(page, 'livePreview');
+  await page.getByRole('button', { name: 'Global view' }).click();
+  await page.getByRole('button', { name: 'Connections of Other' }).click();
+  await page.getByRole('menuitem', { name: 'Connect to…' }).click();
+  await page.getByRole('button', { name: 'Remote references', exact: true }).click();
+  await expect(page.locator('[data-gv-edge="manual"]')).toHaveCount(1);
+  await page.locator('[data-gv-hit]').click({ force: true });
+  await expect(page.getByRole('dialog')).toBeVisible();
+  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
+  await page.waitForLoadState('networkidle');
+  await page.waitForTimeout(300);
+  const csp = await page.evaluate(
+    () => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations,
+  );
+  expect(problems).toEqual([]);
+  expect(csp).toEqual([]);
+  expect(outside).toEqual([]);
+});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @nimw/desktop exec vite build && PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @nimw/desktop exec playwright test e2e/m3b.spec.ts`
Expected: FAIL before the mock change — `not mocked: link_target` (and no manual edge drawn). (While writing it: the keyboard test first started from Welcome, alone on the second row of the 3-column grid at 1280 px — ArrowLeft has nowhere to go; it starts from Notes and goes down.)

- [ ] **Step 3: Implement**

Modify `apps/desktop/e2e/ipcMock.ts` (apply this change):

```diff
@@ -53,13 +53,29 @@ export function installIpcMock({
     truncated: false,
     binary: false,
   });
-  /** Pages a page links to (`[[name]]`, resolved by file name). */
+  /** The page `[[name]]` resolves to (by file name, or by path). */
+  const resolveName = (name: string) =>
+    Object.keys(pages).find(
+      (p) => p.replace(/\.md$/, '') === name || p.replace(/\.md$/, '').split('/').pop() === name,
+    );
+  const FRONT = /^---\n[\s\S]*?\n---(?:\n|$)/;
+  /** Pages a page's text links to (`[[name]]`; the frontmatter is not text). */
   const linksOf = (path: string): string[] =>
-    [...(pages[path] ?? '').matchAll(/\[\[([^\]|#]+)/g)]
-      .map((m) =>
-        Object.keys(pages).find((p) => p.replace(/\.md$/, '').split('/').pop() === m[1].trim()),
-      )
+    [...(pages[path] ?? '').replace(FRONT, '').matchAll(/\[\[([^\]|#]+)/g)]
+      .map((m) => resolveName(m[1].trim()))
       .filter((p): p is string => !!p);
+  /** M3b: a page's relationships — the frontmatter lines naming `[[name]]`
+   *  (string or { link, label, directed } items, one per line). */
+  const relatedOf = (path: string) =>
+    ((pages[path] ?? '').match(FRONT)?.[0] ?? '').split('\n').flatMap((line) => {
+      const m = /\[\[([^\]|#]+)/.exec(line);
+      const target = m ? resolveName(m[1].trim()) : undefined;
+      if (!target) return [];
+      const label = /label: ([^,}]+)/.exec(line)?.[1].trim() ?? null;
+      return [{ target, label, directed: /directed: true/.test(line) }];
+    });
+  /** M3b: index-note picks (folder → page). */
+  const picks: Record<string, string> = {};
   /** A Global View card for a page or folder (M3a §8). */
   const gvCard = (path: string, kind: string, relation: string | null) => {
     const text = pages[path] ?? '';
@@ -86,7 +102,8 @@ export function installIpcMock({
           : '',
       hasImage: false,
       hasAudio: false,
-      indexPage: null,
+      indexPage: kind === 'page' ? null : (picks[path] ?? null),
+      indexFrom: kind === 'page' ? null : picks[path] ? 'picked' : null,
       pages:
         kind === 'page'
           ? 0
@@ -246,23 +263,56 @@ export function installIpcMock({
         }
         return null;
       };
-      const edges = new Map<
-        string,
-        { from: string; to: string; count: number; aggregated: boolean }
-      >();
+      type E = {
+        from: string;
+        to: string;
+        kind: string;
+        count: number;
+        aggregated: boolean;
+        directed: boolean;
+        label: string | null;
+      };
+      const edges = new Map<string, E>();
+      const add = (
+        src: string,
+        target: string,
+        kind: string,
+        directed = false,
+        label = null as string | null,
+      ) => {
+        const x = lift(src);
+        const y = lift(target);
+        if (!x || !y || x === y) return;
+        const [from, to] = directed ? [x, y] : x < y ? [x, y] : [y, x];
+        const key = `${kind}|${[x, y].sort().join('|')}`;
+        const e = edges.get(key) ?? {
+          from,
+          to,
+          kind,
+          count: 0,
+          aggregated: false,
+          directed: false,
+          label: null,
+        };
+        e.count++;
+        e.aggregated ||= x !== src || y !== target;
+        if (directed) Object.assign(e, { directed, from, to });
+        e.label ??= label;
+        edges.set(key, e);
+      };
       for (const src of Object.keys(pages)) {
-        for (const target of linksOf(src)) {
-          const x = lift(src);
-          const y = lift(target);
-          if (!x || !y || x === y) continue;
-          const [from, to] = x < y ? [x, y] : [y, x];
-          const e = edges.get(`${from}|${to}`) ?? { from, to, count: 0, aggregated: false };
-          e.count++;
-          e.aggregated ||= x !== src || y !== target;
-          edges.set(`${from}|${to}`, e);
-        }
+        for (const target of linksOf(src)) add(src, target, 'link');
+        for (const r of relatedOf(src)) add(src, r.target, 'manual', r.directed, r.label);
       }
-      return [...edges.values()].map((e) => ({ ...e, kind: 'link', directed: false, label: null }));
+      return [...edges.values()];
+    },
+    // ---- M3b: relationship targets and index-note picks ----
+    link_target: (a) => (a.target as string).replace(/\.md$/, '').split('/').pop(),
+    index_pick_set: (a) => {
+      const folder = a.folder as string;
+      if (a.page) picks[folder] = a.page as string;
+      else delete picks[folder];
+      return gvCard(folder, folder.includes('/') ? 'folder' : 'project', null);
     },
     layout_get: (a) => {
       const all = JSON.parse(localStorage.getItem('nimw-e2e-layout') ?? '{}');
```

Modify `apps/desktop/e2e/remote.md` (apply this change):

```diff
@@ -2,6 +2,7 @@
 cover: https://remote.example/cover.png
 subtitle: Every way a page can reference the network
 ---
+
 # Remote references
 
 ![md image](https://remote.example/a.png)
@@ -48,9 +49,9 @@ subtitle: Every way a page can reference the network
 :::
 ::::
 
-| a | b |
-|---|---|
-| ![cell](https://remote.example/u.png) | x |
+| a                                     | b   |
+| ------------------------------------- | --- |
+| ![cell](https://remote.example/u.png) | x   |
 
 ![[Other]]
```

Modify `apps/desktop/playwright.config.ts` (apply this change):

```diff
@@ -13,7 +13,7 @@ export default defineConfig({
     {
       name: 'webkit',
       use: { ...devices['Desktop Safari'], browserName: 'webkit' },
-      testMatch: /\/(checklist|m2b|m2c|m3a|m3a-a11y|m3a-perf)\.spec\.ts$/,
+      testMatch: /\/(checklist|m2b|m2c|m3a|m3a-a11y|m3a-perf|m3b)\.spec\.ts$/,
     },
   ],
   webServer: {
```

Note: Final gate on the clone: `check.sh all` → vitest 715/715 (77 files), cargo 250 passed + 2 ignored (perf) + the menu checks, e2e 87 passed; lint, typecheck, i18n, build, fmt, clippy, deny clean. Built bundle: no `color-mix(` in CSS; React Flow's one `structuredClone` sits in its click-to-connect handler (off); the other two are behind `typeof structuredClone` guards.

- [ ] **Step 4: Run them to see them pass**

Run: `PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @nimw/desktop exec playwright test e2e/m3b.spec.ts e2e/zero-network.spec.ts --repeat-each=2`
Expected: PASS — `20 passed` for m3b (5 tests × 2 engines × 2 repeats); the zero-network relationships case passes.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/ipcMock.ts apps/desktop/e2e/m3b.spec.ts apps/desktop/e2e/remote.md apps/desktop/e2e/zero-network.spec.ts apps/desktop/playwright.config.ts
git commit -F - <<'MSG'
test(e2e): M3b in Chromium and WebKit — connect by click, keyboard and drag; edit and delete from the edge; pick an index note; zero network

The IPC mock grows relationships (frontmatter lines naming [[X]] become
manual edges, with label and arrow), link_target and index_pick_set; a
page's text links no longer count its frontmatter. The relationships
dialog is axe-checked in both engines.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

## Self-review

- **Spec coverage:** §2 → Task 6 (+ handle, connect mode, folder/index resolution, duplicate → dialog); §3 → Task 5 (menu, dialog, edge click; label ≤ 40, arrow, delete); §4 → Tasks 2 and 7; §5 → Tasks 2 (indexer), 3, 4; §6 → Task 2; §7 → Task 1; §8 → Tasks 1–8 tests, Task 8 e2e. Deviations are in spec §10.
- **Placeholders:** none; every code step is the committed code.
- **Type consistency:** `Relation`/`RelatedEntry`, `RelateResult`, `GvCard.indexFrom`, `CardMenuItem`, dialog states `relations` / `indexPick` are used with the same names across tasks.
