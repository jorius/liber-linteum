# M3a — Global View (browse, layout, edges) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Global View screen that shows the vault as cards, level by level (Drill-down or Expand in place), with text-link, parent/child, manual and aggregated edges, pinned card positions that survive restarts, and full keyboard use.

**Architecture:**
- **Rust (`liber-session`, `liber-index`):** levels and cards (`gv_children`) and edges lifted to the visible cards (`gv_edges`), read from the index. Indexed range queries keep a 200-card level at ~2 ms on 10k notes.
- **Rust (`liber-vault`):** `.liber/layout.json`, which follows renames.
- **Commands:** four thin async commands with real-ACL tests.
- **UI:** a zustand store (`gvStore`) owns the drill stack, expansions, loaded levels, edges and pins; pure functions place the cards (the prototype's grid, columns and neighbourhood); React Flow (`@xyflow/react` 12.12.0) draws the canvas.
- **Editor:** stays mounted, hidden, while the Global View shows.

**Tech Stack:** Rust (rusqlite, serde_json), Tauri 2.12 (MockRuntime IPC tests), React 19 + TypeScript + zustand, `@xyflow/react` 12.12.0, Vitest + jsdom, Playwright (Chromium + WebKit).

**Spec:** `docs/superpowers/specs/2026-10-14-m3a-global-view-design.md` (§13 lists the amendments this plan's test run made).

**How this plan was written:** every task was implemented on a scratch clone exactly as written here, and every Run line was executed with its output compared to the Expected line. The code in each step is the code that ran. A step that adds a file shows the whole file; a step that changes one shows a unified diff against the previous task's result. Apply each diff with `git apply`, or by hand.

## Global Constraints

- No network (P1, NFR-04): the app makes no outside request, and the zero-network e2e covers the Global View. (Adding `@xyflow/react` from the registry is the only network use, at development time.)
- Every new Tauri command: in `build.rs` `COMMANDS`, `generate_handler!`, `capabilities/main.json`, and the `tests/commands.rs` `COMMANDS` list, plus a real-ACL test; async via `blocking()`.
- i18n en + es parity (`pnpm check:i18n`); axe-clean components (colour contrast is checked by the palette tests; jsdom has no CSS); WCAG AA in light and dark for every palette, edges ≥ 3:1 on the canvas.
- Safari 15 floor: no regex lookbehind and no `color-mix()` in new code; scan the built bundle after adding a dependency.
- Tauri `"freezePrototype": true`: third-party code must load with `Object.prototype` frozen. The e2e IPC mock freezes it too.
- Performance (NFR-03): a level of ≤ 200 cards < 300 ms at 10k notes; backend `gv_children` + `gv_edges` for a 200-card level < 100 ms (release).
- Only open levels are mounted (NFR-02).
- Opening a vault writes nothing (VLT-02): `.liber/layout.json` appears on the first card move.
- Vitest with `--maxWorkers=2` on this machine; Node 24 first on PATH (`pnpm check:i18n` needs ≥ 22.18).
- Any shell chain that filters output runs with `set -o pipefail`.
- Prettier runs from the repo root: run from `apps/desktop` it misses the root ignore file and rewrites the generated `palettes.css`.

## Review Focus

The five inputs the spec implies that ordinary feature tests would miss and that are most likely to bite. Each is pinned by a test in the owning task:

1. **A big vault.** A 200-card folder on 10,000 notes, and level 0, which reads every link. Expected: within budget. Pinned in Task 3: `nfr_03_a_200_card_level_and_its_edges_in_under_100_ms` (release, `--ignored`): ~2 ms for 200 cards and ~90 ms for level 0, against assertions of < 100 ms and < 150 ms.
2. **The folder or page shown is deleted or renamed** (in the app or by another program). Expected: the view falls back to the nearest existing level, and pinned positions follow the rename. Pinned in Task 8 (`a level that no longer exists falls back to the nearest one that does`) and Task 4 (`m3a_pinned_positions_follow_in_app_and_external_renames`).
3. **Third-party code under Tauri's frozen `Object.prototype`.** d3-color, pulled in by React Flow, throws at load and the UI never starts. Pinned in Task 10: `tests/freezeSafe.test.ts`, and every e2e test (the mock freezes like Tauri).
4. **A double click in WebKit.** A card re-measured between the two presses lets the second one hit the pane. Expected: the page opens in the editor. Pinned in Task 12: e2e `a double click opens the page in the editor` (WebKit project), and in Task 9 the Card click-timing test.
5. **Keyboard focus across a level change.** The card that opened the level unmounts, and the breadcrumb changes before the level arrives. Expected: focus lands on the new level's first card. Pinned in Task 12: e2e `keyboard only: …` and the store test `shownKey names the level the canvas holds …`.

## File Structure

| Path | Responsibility |
|---|---|
| `crates/liber-index/src/{rows,index}.rs` | `CardRow` / `PageLink`; `card_children`, `card`, `page_links_of`, `page_links_from` (indexed range per visible card) |
| `crates/liber-session/src/global_view.rs` | levels (`gv_children`), cards, index-note rules, attachment-folder exclusion, neighbourhoods; `gv_edges` aggregation; `follow_layout` on renames |
| `crates/liber-vault/src/layout.rs` | `.liber/layout.json`: `layout_level`, `set_layout_level`, `remap_layout`; `CardPosition` |
| `crates/liber-vault/src/{config,vault}.rs` | `indexPicks`; the shared `.liber` JSON read-modify-write helper |
| `apps/desktop/src-tauri/src/gv_commands.rs`, `dto.rs` | `gv_children`, `gv_edges`, `layout_get`, `layout_set` + DTOs |
| `apps/desktop/src-tauri/src/settings.rs` | `globalViewMode`, `globalViewEdges` |
| `apps/desktop/src-tauri/src/menu.rs` | View → Editor / Global View (`menu:screen`) |
| `apps/desktop/src/features/global-view/layout.ts` | pure layouts (grid, columns, neighbourhood), pins, arrow-key geometry |
| `…/global-view/gvStore.ts` | drill stack, expansions, levels, canvas, edges, pins, focus, `shownKey`, `entryDir` |
| `…/global-view/Card.tsx` | one card (kinds, covers, placeholders, timing, a11y) |
| `…/global-view/edges.tsx` | border-to-border edges, one stroke per kind |
| `…/global-view/Canvas.tsx`, `Toolbar.tsx`, `GlobalView.tsx` | the screen: React Flow canvas, keyboard, zoom; breadcrumb, mode, toggles, Reset; New entry; refresh |
| `apps/desktop/src/stores/{uiStore,navigate,pageStore}.ts` | `screen`; opening a page shows Edit; the title-focus request |
| `apps/desktop/src/theme/paletteCss.ts`, `tokens.css` | canvas, card border and edge tokens per palette |
| `apps/desktop/scripts/freezeSafe.ts` | Vite transform keeping d3-color loadable under a frozen `Object.prototype` |
| `apps/desktop/e2e/{ipcMock,m3a.spec,zero-network.spec}.ts` | e2e mock commands and Global View flows |

**Commands used throughout (repo root):**
- `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`
- Vitest: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 <paths>`
- Cargo: `cargo test -p <crate> --test <file>`
- E2E:
  ```bash
  pnpm --filter @liber/desktop exec vite build
  PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @liber/desktop exec playwright test <spec>
  ```

---

### Task 1: Settings: Global View mode and edge toggles

**Commits in the test run:** `9ad8cdc`

**Files:**
- Modify: `apps/desktop/src-tauri/src/settings.rs`
- Modify: `apps/desktop/src-tauri/tests/commands.rs` (test)
- Modify: `apps/desktop/src-tauri/tests/settings.rs` (test)
- Modify: `apps/desktop/src/ipc/index.ts`
- Modify: `apps/desktop/src/stores/settingsStore.ts`
- Modify: `apps/desktop/src/stores/stores.test.ts` (test)

**Interfaces:**
- **Produces (Rust):**
  - `settings::GlobalViewMode { Drill, Expand }` (serde lowercase), default `Drill`;
  - `settings::GlobalViewEdges { links, tree, manual, aggregated: bool }` (serde default true per key);
  - `Settings.global_view_mode` / `global_view_edges`, the same `Option`s on `SettingsPatch`;
  - JSON keys `globalViewMode` / `globalViewEdges`.
- **Produces (TS):** `GlobalViewMode = 'drill' | 'expand'`, `GlobalViewEdges { links, tree, manual, aggregated }`, both on `Settings` / `SettingsPatch`; defaults in `DEFAULT_SETTINGS`.

- [ ] **Step 1: Write the failing tests**

Modify `apps/desktop/src-tauri/tests/commands.rs` (apply this diff):

```diff
@@ -632,7 +632,9 @@ fn m2b_settings_round_trip_over_ipc() {
             "fontSource": "source-code-pro",
             "fontSize": 17,
             "toolbar": false,
-            "lineNumbers": true
+            "lineNumbers": true,
+            "globalViewMode": "expand",
+            "globalViewEdges": { "links": false, "tree": true, "manual": true, "aggregated": true }
         }}),
     )
     .unwrap();
@@ -643,6 +645,8 @@ fn m2b_settings_round_trip_over_ipc() {
     assert_eq!(saved["fontSize"], 17);
     assert_eq!(saved["toolbar"], false);
     assert_eq!(saved["lineNumbers"], true);
+    assert_eq!(saved["globalViewMode"], "expand");
+    assert_eq!(saved["globalViewEdges"]["links"], false);
     let got = call(&h.main, "settings_get", json!({})).unwrap();
     assert_eq!(got["settings"]["palette"], "graphite");
     assert!(
```

Modify `apps/desktop/src-tauri/tests/settings.rs` (apply this diff):

```diff
@@ -309,3 +309,56 @@ fn m2b_font_size_is_clamped_and_font_choices_are_bounded() {
     assert!(HexColor::parse("#abc").is_none());
     assert!(HexColor::parse("abcdef").is_none());
 }
+
+/// M3a §5, §6, §8: the Global View's mode and edge toggles are global
+/// settings with defaults (Drill-down, every edge kind shown), persisted, and
+/// reset on their own when unreadable.
+#[test]
+fn m3a_global_view_settings_default_persist_and_reset() {
+    use liber_desktop::settings::{GlobalViewEdges, GlobalViewMode};
+    let dir = tempfile::tempdir().unwrap();
+    let s = store(dir.path());
+    let d = s.get().0;
+    assert_eq!(d.global_view_mode, GlobalViewMode::Drill);
+    assert_eq!(
+        d.global_view_edges,
+        GlobalViewEdges {
+            links: true,
+            tree: true,
+            manual: true,
+            aggregated: true
+        }
+    );
+    s.update(SettingsPatch {
+        global_view_mode: Some(GlobalViewMode::Expand),
+        global_view_edges: Some(GlobalViewEdges {
+            links: true,
+            tree: false,
+            manual: true,
+            aggregated: false,
+        }),
+        ..Default::default()
+    })
+    .unwrap();
+    let saved: serde_json::Value =
+        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
+            .unwrap();
+    assert_eq!(saved["globalViewMode"], "expand");
+    assert_eq!(
+        saved["globalViewEdges"],
+        serde_json::json!({ "links": true, "tree": false, "manual": true, "aggregated": false })
+    );
+    assert_eq!(store(dir.path()).get().0, s.get().0, "round-trips");
+
+    // A missing toggle defaults to shown; an unknown mode resets on its own.
+    std::fs::write(
+        dir.path().join("settings.json"),
+        r#"{"globalViewMode":"radial","globalViewEdges":{"tree":false},"theme":"dark"}"#,
+    )
+    .unwrap();
+    let (s, warning) = store(dir.path()).get();
+    assert_eq!(s.global_view_mode, GlobalViewMode::Drill);
+    assert!(!s.global_view_edges.tree && s.global_view_edges.links);
+    assert_eq!(s.theme, Theme::Dark);
+    assert!(warning.unwrap().contains("globalViewMode"));
+}
```

Modify `apps/desktop/src/stores/stores.test.ts` (apply this diff):

```diff
@@ -87,6 +87,17 @@ describe('settingsStore', () => {
     expect(i18next.language).toBe('es');
   });
 
+  it('M3a: the Global View defaults (Drill-down, every edge kind) fill in for an older backend', async () => {
+    const older: Partial<typeof DEFAULT_SETTINGS> = { ...DEFAULT_SETTINGS };
+    delete older.globalViewMode;
+    delete older.globalViewEdges;
+    backend({ settings_get: () => ({ settings: older }) });
+    await useSettingsStore.getState().load();
+    const s = useSettingsStore.getState().settings;
+    expect(s.globalViewMode).toBe('drill');
+    expect(s.globalViewEdges).toEqual({ links: true, tree: true, manual: true, aggregated: true });
+  });
+
   it('falls back to defaults outside Tauri / on error', async () => {
     backend({
       settings_get: () => {
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p liber-desktop --test settings && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/stores/stores.test.ts`
Expected: Rust does not compile: `unresolved imports liber_desktop::settings::GlobalViewEdges, GlobalViewMode`, `no field global_view_mode on type Settings`. Vitest: `M3a: the Global View defaults … fill in for an older backend` fails with `expected undefined to be 'drill'`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src-tauri/src/settings.rs` (apply this diff):

```diff
@@ -142,6 +142,40 @@ impl From<FontChoice> for String {
     }
 }
 
+/// How a Global View click opens the next level (M3a §5, GV-13).
+#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
+#[serde(rename_all = "lowercase")]
+pub enum GlobalViewMode {
+    /// The next level replaces the canvas (breadcrumb back).
+    #[default]
+    Drill,
+    /// The next level is added beside the clicked card.
+    Expand,
+}
+
+/// Which Global View edge kinds are shown (M3a §6, GV-21); a missing key
+/// means shown.
+#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
+#[serde(default)]
+pub struct GlobalViewEdges {
+    pub links: bool,
+    pub tree: bool,
+    pub manual: bool,
+    /// "Links from inside folders" (GV-25).
+    pub aggregated: bool,
+}
+
+impl Default for GlobalViewEdges {
+    fn default() -> GlobalViewEdges {
+        GlobalViewEdges {
+            links: true,
+            tree: true,
+            manual: true,
+            aggregated: true,
+        }
+    }
+}
+
 pub const MIN_FONT_SIZE: u8 = 13;
 pub const MAX_FONT_SIZE: u8 = 20;
 
@@ -206,6 +240,10 @@ pub struct Settings {
     pub toolbar: bool,
     /// Line numbers in the editor gutter (M2b §11, feedback round).
     pub line_numbers: bool,
+    /// Global View: Drill-down or Expand in place (M3a §5).
+    pub global_view_mode: GlobalViewMode,
+    /// Global View: edge kinds shown (M3a §6).
+    pub global_view_edges: GlobalViewEdges,
     pub recent_vaults: Vec<RecentVault>,
     /// Keys this build does not know (written by a newer version); kept on save.
     #[serde(flatten)]
@@ -228,6 +266,8 @@ impl Default for Settings {
             font_size: FontSize::default(),
             toolbar: true,
             line_numbers: false,
+            global_view_mode: GlobalViewMode::Drill,
+            global_view_edges: GlobalViewEdges::default(),
             recent_vaults: Vec::new(),
             extra: serde_json::Map::new(),
         }
@@ -250,6 +290,8 @@ pub struct SettingsPatch {
     pub font_size: Option<FontSize>,
     pub toolbar: Option<bool>,
     pub line_numbers: Option<bool>,
+    pub global_view_mode: Option<GlobalViewMode>,
+    pub global_view_edges: Option<GlobalViewEdges>,
 }
 
 /// A recent vault as shown on the welcome screen.
@@ -305,6 +347,8 @@ fn parse_lenient(text: &str) -> Result<(Settings, Vec<String>), serde_json::Erro
     field!("fontSize", font_size);
     field!("toolbar", toolbar);
     field!("lineNumbers", line_numbers);
+    field!("globalViewMode", global_view_mode);
+    field!("globalViewEdges", global_view_edges);
     match map.remove("recentVaults") {
         None => {}
         Some(Value::Array(items)) => {
@@ -427,6 +471,12 @@ impl SettingsStore {
         if let Some(v) = patch.line_numbers {
             next.line_numbers = v;
         }
+        if let Some(v) = patch.global_view_mode {
+            next.global_view_mode = v;
+        }
+        if let Some(v) = patch.global_view_edges {
+            next.global_view_edges = v;
+        }
         self.save(&next)?;
         *s = next.clone();
         Ok(next)
```

Modify `apps/desktop/src/ipc/index.ts` (apply this diff):

```diff
@@ -168,6 +168,20 @@ export interface Settings {
   toolbar: boolean;
   /** Line numbers in the editor gutter. */
   lineNumbers: boolean;
+  /** Global View: how a click opens the next level (M3a §5). */
+  globalViewMode: GlobalViewMode;
+  /** Global View: edge kinds shown (M3a §6). */
+  globalViewEdges: GlobalViewEdges;
+}
+
+export type GlobalViewMode = 'drill' | 'expand';
+
+export interface GlobalViewEdges {
+  links: boolean;
+  tree: boolean;
+  manual: boolean;
+  /** "Links from inside folders". */
+  aggregated: boolean;
 }
 
 /** `language: 'system'` means follow the OS again. */
@@ -184,6 +198,8 @@ export interface SettingsPatch {
   fontSize?: number;
   toolbar?: boolean;
   lineNumbers?: boolean;
+  globalViewMode?: GlobalViewMode;
+  globalViewEdges?: GlobalViewEdges;
 }
 
 export interface SettingsResponse {
```

Modify `apps/desktop/src/stores/settingsStore.ts` (apply this diff):

```diff
@@ -26,6 +26,8 @@ export const DEFAULT_SETTINGS: Settings = {
   fontSize: 15,
   toolbar: true,
   lineNumbers: false,
+  globalViewMode: 'drill',
+  globalViewEdges: { links: true, tree: true, manual: true, aggregated: true },
 };
 
 interface SettingsState {
```


- [ ] **Step 4: Run the tests and watch them pass**

Run: `cargo test -p liber-desktop --test settings --test commands && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/stores/stores.test.ts && pnpm --filter @liber/desktop typecheck`
Expected: both cargo binaries `ok … 0 failed`; vitest `Tests 28 passed (28)`; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/settings.rs apps/desktop/src-tauri/tests/commands.rs apps/desktop/src-tauri/tests/settings.rs apps/desktop/src/ipc/index.ts apps/desktop/src/stores/settingsStore.ts apps/desktop/src/stores/stores.test.ts
git commit -m "$(cat <<'EOF'
feat(settings): Global View mode and edge toggles (M3a §5, §6)

globalViewMode (drill | expand, default drill) and globalViewEdges
(links, tree, manual, aggregated; missing keys shown), each reset on its
own when unreadable, persisted globally (GV-13).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Session: Global View levels and cards

**Commits in the test run:** `f36875c`

**Files:**
- Modify: `crates/liber-index/src/index.rs`
- Modify: `crates/liber-index/src/lib.rs`
- Modify: `crates/liber-index/src/rows.rs`
- Create: `crates/liber-session/src/global_view.rs`
- Modify: `crates/liber-session/src/lib.rs`
- Create: `crates/liber-session/tests/global_view.rs` (test)
- Modify: `crates/liber-vault/src/config.rs`
- Modify: `crates/liber-vault/src/vault.rs`

**Interfaces:**
- **Consumes:**
  - `Vault::attachment_policy()` and the `AttachmentPolicy` variants (M2c);
  - `Index::card_children` / `card` / `page_links_of` (added here).
- **Produces (`liber_session`):**
  - `GvLevel { Vault, Folder(VaultPath), Page(VaultPath) }`;
  - `CardKind { Project, Folder, Page }`;
  - `Relation { Centre, In, Out, Both }`;
  - `GvCard { path, kind, title, subtitle, cover, cover_remote, cover_y, excerpt, has_image, has_audio, index_page, pages, folders, child_titles, relation }`;
  - `GvChildren { cards, centre }`;
  - `VaultSession::gv_children(&GvLevel) -> Result<GvChildren>` (missing / wrong-kind level → `SessionError::NotIndexed`);
  - `SUMMARY_TITLES = 5`.
- **Produces (`liber_index`):** `CardRow`, `PageLink { src, target, kind, label, directed }`.
- **Produces (`liber_vault`):** `Vault::index_picks() -> HashMap<String, String>`.

- [ ] **Step 1: Write the failing test**

Create `crates/liber-session/tests/global_view.rs`:

```rust
//! M3a §3, §4, §8: Global View levels (vault, folder, page neighbourhood),
//! cards (index notes, folder summaries, covers), edges and layouts.

use liber_session::{CardKind, GvCard, GvLevel, Relation, SessionEvent, VaultSession};
use liber_vault::VaultPath;
use std::path::Path;

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn open(dir: &Path) -> (tempfile::TempDir, VaultSession) {
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(dir, cache.path(), |_: SessionEvent| {}).unwrap();
    (cache, s)
}

/// Alpha (index note named like the folder, a Sub folder with index.md),
/// Beta (a single page), Gamma (an index pick), Delta (no index note: a
/// summary; its attachments folder is not a card), a root attachments
/// folder, and two root pages that link to each other.
fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    write(
        r,
        "Alpha/Alpha.md",
        "---\nsubtitle: The first project\n---\n# Alpha home\n\nAll about alpha.\n",
    );
    write(
        r,
        "Alpha/note.md",
        "---\nrelated: \"[[Welcome]]\"\n---\n# A note\n",
    );
    write(r, "Alpha/Sub/index.md", "# Sub index\n");
    write(r, "Alpha/Sub/deep.md", "# Deep\n");
    write(r, "Beta/only.md", "# Only page\n\nSee [[Welcome]].\n");
    write(r, "Gamma/a.md", "# Gamma A\n");
    write(
        r,
        "Gamma/b.md",
        "# Gamma B\n\nPicked as the folder's preview.\n",
    );
    write(r, "Delta/x.md", "---\ncover: missing.png\n---\n# X title\n");
    write(
        r,
        "Delta/y.md",
        "---\nrelated:\n  - { link: \"[[Welcome]]\", label: inspired, directed: true }\n---\n# y\n",
    );
    write(r, "Delta/Inner/i.md", "# I\n");
    write(r, "Delta/attachments/pic.png", "png");
    write(r, "attachments/w.png", "png");
    write(
        r,
        "Welcome.md",
        "---\ncover: attachments/w.png\ncover-y: 30\n---\n# Welcome\n\nStart at [[note]] or [[zeta]]. ![[w.png]]\n",
    );
    write(
        r,
        "zeta.md",
        "---\ncover: https://example.com/x.png\n---\n# Zeta\n\nBack to [[Welcome]].\n",
    );
    write(
        r,
        ".liber/vault.json",
        r#"{"version":1,"indexPicks":{"Gamma":"Gamma/b.md"}}"#,
    );
    dir
}

fn card<'a>(cards: &'a [GvCard], path: &str) -> &'a GvCard {
    cards
        .iter()
        .find(|c| c.path == path)
        .unwrap_or_else(|| panic!("no card {path} in {:?}", paths(cards)))
}

fn paths(cards: &[GvCard]) -> Vec<&str> {
    cards.iter().map(|c| c.path.as_str()).collect()
}

#[test]
fn gv_10_vault_level_shows_projects_then_root_pages_without_attachment_folders() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    let level = s.gv_children(&GvLevel::Vault).unwrap();
    assert_eq!(
        paths(&level.cards),
        ["Alpha", "Beta", "Delta", "Gamma", "Welcome.md", "zeta.md"]
    );
    assert!(level.centre.is_none());
    assert!(level.cards[..4].iter().all(|c| c.kind == CardKind::Project));
    assert!(level.cards[4..].iter().all(|c| c.kind == CardKind::Page));
}

#[test]
fn gv_02_folder_cards_preview_their_index_note_or_summarise_their_children() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    let cards = s.gv_children(&GvLevel::Vault).unwrap().cards;

    // 1. A page named like the folder.
    let alpha = card(&cards, "Alpha");
    assert_eq!(alpha.index_page.as_deref(), Some("Alpha/Alpha.md"));
    assert_eq!(alpha.title, "Alpha home");
    assert_eq!(alpha.subtitle.as_deref(), Some("The first project"));
    assert_eq!(alpha.excerpt, "All about alpha.");
    assert_eq!((alpha.pages, alpha.folders), (2, 1));
    // 4. The only page of a folder with no subfolders.
    assert_eq!(
        card(&cards, "Beta").index_page.as_deref(),
        Some("Beta/only.md")
    );
    // 3. The page picked in .liber/vault.json.
    let gamma = card(&cards, "Gamma");
    assert_eq!(gamma.index_page.as_deref(), Some("Gamma/b.md"));
    assert_eq!(gamma.title, "Gamma B");
    // No index note: a summary (the attachments folder is not counted).
    let delta = card(&cards, "Delta");
    assert_eq!(delta.index_page, None);
    assert_eq!(delta.title, "Delta");
    assert_eq!(delta.subtitle.as_deref(), Some("Delta"));
    assert_eq!((delta.pages, delta.folders), (2, 1));
    assert_eq!(delta.child_titles, ["Inner", "X title", "y"]);
    assert_eq!(delta.excerpt, "Inner · X title · y");

    // 2. index.md, one level down; subfolders there are "folder" cards.
    let alpha_level = s.gv_children(&GvLevel::Folder(vp("Alpha"))).unwrap();
    assert_eq!(
        paths(&alpha_level.cards),
        ["Alpha/Sub", "Alpha/Alpha.md", "Alpha/note.md"]
    );
    let sub = card(&alpha_level.cards, "Alpha/Sub");
    assert_eq!(sub.kind, CardKind::Folder);
    assert_eq!(sub.index_page.as_deref(), Some("Alpha/Sub/index.md"));
    assert_eq!(sub.title, "Sub index");
}

#[test]
fn m3a_covers_are_resolved_remote_ones_flagged_missing_ones_dropped() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    let cards = s.gv_children(&GvLevel::Vault).unwrap().cards;
    let welcome = card(&cards, "Welcome.md");
    assert_eq!(welcome.cover.as_deref(), Some("attachments/w.png"));
    assert_eq!(welcome.cover_y, Some(30));
    assert!(!welcome.cover_remote);
    assert!(welcome.has_image);
    let zeta = card(&cards, "zeta.md");
    assert_eq!(zeta.cover, None);
    assert!(zeta.cover_remote);
    let delta = s.gv_children(&GvLevel::Folder(vp("Delta"))).unwrap();
    let x = card(&delta.cards, "Delta/x.md");
    assert_eq!((x.cover.as_deref(), x.cover_remote), (None, false));
    assert_eq!(
        paths(&delta.cards),
        ["Delta/Inner", "Delta/x.md", "Delta/y.md"],
        "the attachments folder is not a card"
    );
}

#[test]
fn gv_16_page_level_is_the_page_and_its_neighbourhood() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    let level = s.gv_children(&GvLevel::Page(vp("Welcome.md"))).unwrap();
    assert_eq!(level.centre.as_deref(), Some("Welcome.md"));
    let rel = |p: &str| card(&level.cards, p).relation;
    assert_eq!(rel("Welcome.md"), Some(Relation::Centre));
    assert_eq!(level.cards[0].path, "Welcome.md", "the centre comes first");
    // Links out; an undirected `related:` pointing here goes right too.
    assert_eq!(rel("Alpha/note.md"), Some(Relation::Out));
    assert_eq!(rel("zeta.md"), Some(Relation::Both));
    assert_eq!(rel("Beta/only.md"), Some(Relation::In));
    // A directed relationship towards this page comes in.
    assert_eq!(rel("Delta/y.md"), Some(Relation::In));
    assert_eq!(level.cards.len(), 5, "no image card, no duplicates");
    assert!(level.cards.iter().all(|c| c.kind == CardKind::Page));
}

#[test]
fn m3a_levels_that_do_not_exist_are_errors() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    assert!(s.gv_children(&GvLevel::Folder(vp("Nope"))).is_err());
    assert!(s.gv_children(&GvLevel::Folder(vp("Welcome.md"))).is_err());
    assert!(s.gv_children(&GvLevel::Page(vp("Alpha"))).is_err());
    assert!(s.gv_children(&GvLevel::Page(vp("gone.md"))).is_err());
}

#[test]
fn m3a_an_obsidian_attachment_folder_is_hidden_and_a_fixed_one_too() {
    let dir = vault();
    write(
        dir.path(),
        ".obsidian/app.json",
        r#"{"attachmentFolderPath":"Gamma"}"#,
    );
    let (_c, s) = open(dir.path());
    let cards = s.gv_children(&GvLevel::Vault).unwrap().cards;
    assert_eq!(
        paths(&cards),
        [
            "Alpha",
            "attachments",
            "Beta",
            "Delta",
            "Welcome.md",
            "zeta.md"
        ],
        "Gamma is now the attachment folder; `attachments` is an ordinary folder"
    );
}
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cargo test -p liber-session --test global_view`
Expected: does not compile: `unresolved imports liber_session::CardKind, GvCard, GvLevel, Relation` and `no method named gv_children`.

- [ ] **Step 3: Implement**

Modify `crates/liber-index/src/index.rs` (apply this diff):

```diff
@@ -1,5 +1,6 @@
 use crate::rows::{
-    FileKind, FileRow, LinkCandidate, LinkRow, PageRow, Stat, TreeNode, ext_of, split_path,
+    CardRow, FileKind, FileRow, LinkCandidate, LinkRow, PageLink, PageRow, Stat, TreeNode, ext_of,
+    split_path,
 };
 use crate::schema::{SCHEMA, SCHEMA_VERSION};
 use liber_markdown::{FileSet, LinkKind, PageMeta, Tag, link_key, name_key, resolve};
@@ -54,6 +55,41 @@ fn link_row(r: &Row<'_>) -> rusqlite::Result<LinkRow> {
     })
 }
 
+const CARD_SELECT: &str = "SELECT f.path, f.parent, f.name, f.kind, p.title, p.subtitle, p.cover, \
+     (SELECT l.target_path FROM links l WHERE l.src = f.path AND l.kind = 'cover' LIMIT 1), \
+     p.cover_y, p.excerpt, p.has_image, p.has_audio \
+     FROM files f LEFT JOIN pages p ON p.path = f.path";
+
+fn card_row(r: &Row<'_>) -> rusqlite::Result<CardRow> {
+    Ok(CardRow {
+        path: r.get(0)?,
+        parent: r.get(1)?,
+        name: r.get(2)?,
+        kind: FileKind::parse(&r.get::<_, String>(3)?),
+        title: r.get(4)?,
+        subtitle: r.get(5)?,
+        cover: r.get(6)?,
+        cover_path: r.get(7)?,
+        cover_y: r.get::<_, Option<i64>>(8)?.map(|v| v.clamp(0, 100) as u8),
+        excerpt: r.get(9)?,
+        has_image: r.get::<_, Option<bool>>(10)?.unwrap_or(false),
+        has_audio: r.get::<_, Option<bool>>(11)?.unwrap_or(false),
+    })
+}
+
+/// Link kinds that connect pages in the Global View.
+const PAGE_LINK_KINDS: &str = "('wiki', 'embed', 'markdown', 'related')";
+
+fn page_link(r: &Row<'_>) -> rusqlite::Result<PageLink> {
+    Ok(PageLink {
+        src: r.get(0)?,
+        target: r.get(1)?,
+        kind: LinkKind::parse(&r.get::<_, String>(2)?).unwrap_or(LinkKind::Wiki),
+        label: r.get(3)?,
+        directed: r.get(4)?,
+    })
+}
+
 /// `?1` is the path itself or a folder containing it.
 const IN_SUBTREE: &str =
     "(path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1) + 1) = ?1 || '/'))";
@@ -211,6 +247,58 @@ impl Index {
         Ok(nodes)
     }
 
+    /// The entries directly inside `parent` (`""`: the vault root) with their
+    /// card data, folders first, then by name like the explorer (M3a §3).
+    pub fn card_children(&self, parent: &str) -> Result<Vec<CardRow>> {
+        let mut stmt = self
+            .conn
+            .prepare_cached(&format!("{CARD_SELECT} WHERE f.parent = ?1"))?;
+        let mut rows = stmt
+            .query_map([parent], card_row)?
+            .collect::<rusqlite::Result<Vec<_>>>()?;
+        rows.sort_by_cached_key(|r| {
+            (
+                r.kind != FileKind::Folder,
+                name_key(&r.name),
+                r.name.clone(),
+            )
+        });
+        Ok(rows)
+    }
+
+    /// One entry with its card data.
+    pub fn card(&self, path: &str) -> Result<Option<CardRow>> {
+        let mut stmt = self
+            .conn
+            .prepare_cached(&format!("{CARD_SELECT} WHERE f.path = ?1"))?;
+        Ok(stmt.query_row([path], card_row).optional()?)
+    }
+
+    /// Every resolved link between two pages (M3a §6).
+    pub fn page_links(&self) -> Result<Vec<PageLink>> {
+        let mut stmt = self.conn.prepare_cached(&format!(
+            "SELECT l.src, l.target_path, l.kind, l.label, l.directed FROM links l \
+             JOIN files t ON t.path = l.target_path \
+             WHERE t.kind = 'page' AND l.kind IN {PAGE_LINK_KINDS} ORDER BY l.src, l.start"
+        ))?;
+        Ok(stmt
+            .query_map([], page_link)?
+            .collect::<rusqlite::Result<Vec<_>>>()?)
+    }
+
+    /// Resolved page-to-page links from or to `path` (a page's neighbourhood).
+    pub fn page_links_of(&self, path: &str) -> Result<Vec<PageLink>> {
+        let mut stmt = self.conn.prepare_cached(&format!(
+            "SELECT l.src, l.target_path, l.kind, l.label, l.directed FROM links l \
+             JOIN files t ON t.path = l.target_path \
+             WHERE t.kind = 'page' AND l.kind IN {PAGE_LINK_KINDS} \
+             AND (l.src = ?1 OR l.target_path = ?1) ORDER BY l.src, l.start"
+        ))?;
+        Ok(stmt
+            .query_map([path], page_link)?
+            .collect::<rusqlite::Result<Vec<_>>>()?)
+    }
+
     /// Every page and attachment with its title (pages) and mtime (M2c §7.2).
     pub fn link_candidates(&self) -> Result<Vec<LinkCandidate>> {
         let mut stmt = self.conn.prepare(
```

Modify `crates/liber-index/src/lib.rs` (apply this diff):

```diff
@@ -6,7 +6,9 @@ mod rows;
 mod schema;
 
 pub use index::{Index, IndexError, Result, Tx};
-pub use rows::{FileKind, FileRow, LinkCandidate, LinkRow, PageRow, Stat, TreeNode};
+pub use rows::{
+    CardRow, FileKind, FileRow, LinkCandidate, LinkRow, PageLink, PageRow, Stat, TreeNode,
+};
 pub use schema::SCHEMA_VERSION;
 
 use sha2::{Digest, Sha256};
```

Modify `crates/liber-index/src/rows.rs` (apply this diff):

```diff
@@ -54,6 +54,37 @@ pub struct LinkCandidate {
     pub mtime_ns: i64,
 }
 
+/// A file with the page data a Global View card shows (M3a §8). Page
+/// columns are `None` for folders and attachments.
+#[derive(Debug, Clone, PartialEq, Eq)]
+pub struct CardRow {
+    pub path: String,
+    pub parent: String,
+    pub name: String,
+    pub kind: FileKind,
+    pub title: Option<String>,
+    pub subtitle: Option<String>,
+    /// The frontmatter `cover:` value as written.
+    pub cover: Option<String>,
+    /// Where `cover:` resolves (`None`: no cover, remote or missing).
+    pub cover_path: Option<String>,
+    pub cover_y: Option<u8>,
+    pub excerpt: Option<String>,
+    pub has_image: bool,
+    pub has_audio: bool,
+}
+
+/// A resolved link from one page to another page (Global View edges and
+/// neighbourhoods, M3a §3, §6): text links, embeds of pages and `related:`.
+#[derive(Debug, Clone, PartialEq, Eq)]
+pub struct PageLink {
+    pub src: String,
+    pub target: String,
+    pub kind: LinkKind,
+    pub label: Option<String>,
+    pub directed: bool,
+}
+
 /// An explorer row (EXP-01). `title` is set for pages.
 #[derive(Debug, Clone, PartialEq, Eq)]
 pub struct TreeNode {
```

Create `crates/liber-session/src/global_view.rs`:

```rust
//! M3a §3, §4, §8: Global View levels and cards — the vault (projects and
//! root pages), a folder (subfolders and pages) or a page and its
//! neighbourhood — read from the index in a few queries.

use crate::error::{Result, SessionError};
use crate::session::VaultSession;
use liber_index::{CardRow, FileKind, Index, PageLink};
use liber_markdown::{LinkKind, name_key};
use liber_vault::{AttachmentPolicy, VaultPath};
use std::collections::{BTreeMap, HashMap};

/// What one click opens (M3a §3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GvLevel {
    /// Level 0: projects and the pages in the vault root (GV-10).
    Vault,
    /// A folder's subfolders and pages.
    Folder(VaultPath),
    /// A page and the pages it links to, links from and is related to (GV-16).
    Page(VaultPath),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardKind {
    /// A top-level folder.
    Project,
    Folder,
    Page,
}

/// Where a page sits in another page's neighbourhood (layout side, §7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    Centre,
    /// Links (or is directed) to the centre page: shown left.
    In,
    /// The centre links to it, or an undirected relationship: shown right.
    Out,
    Both,
}

/// One Global View card (M3a §4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GvCard {
    pub path: String,
    pub kind: CardKind,
    pub title: String,
    pub subtitle: Option<String>,
    /// The cover's vault path; `None` for no, remote or missing covers.
    pub cover: Option<String>,
    pub cover_remote: bool,
    pub cover_y: Option<u8>,
    pub excerpt: String,
    pub has_image: bool,
    pub has_audio: bool,
    /// Folders: the page previewed on the card (GV-02).
    pub index_page: Option<String>,
    /// Folders: direct pages and (visible) subfolders.
    pub pages: u32,
    pub folders: u32,
    /// Folders: the first child names/titles (folder summary).
    pub child_titles: Vec<String>,
    /// Page levels: the card's place around the centre.
    pub relation: Option<Relation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GvChildren {
    pub cards: Vec<GvCard>,
    /// Page levels: the page itself.
    pub centre: Option<String>,
}

/// Most child titles a folder summary lists.
pub const SUMMARY_TITLES: usize = 5;

impl VaultSession {
    /// The cards of one Global View level (M3a §3).
    pub fn gv_children(&self, level: &GvLevel) -> Result<GvChildren> {
        let policy = self.vault.attachment_policy();
        let picks = self.vault.index_picks();
        let index = self.index();
        let ctx = Ctx {
            index: &index,
            policy: &policy,
            picks: &picks,
        };
        match level {
            GvLevel::Vault => Ok(GvChildren {
                cards: ctx.children("", CardKind::Project)?,
                centre: None,
            }),
            GvLevel::Folder(folder) => {
                match index.card(folder.as_str())? {
                    Some(row) if row.kind == FileKind::Folder => {}
                    _ => return Err(SessionError::NotIndexed(folder.to_string())),
                }
                Ok(GvChildren {
                    cards: ctx.children(folder.as_str(), CardKind::Folder)?,
                    centre: None,
                })
            }
            GvLevel::Page(page) => {
                let centre = match index.card(page.as_str())? {
                    Some(row) if row.kind == FileKind::Page => row,
                    _ => return Err(SessionError::NotIndexed(page.to_string())),
                };
                let mut cards = vec![page_card(&centre, Some(Relation::Centre))];
                for (path, relation) in
                    neighbours(page.as_str(), &index.page_links_of(page.as_str())?)
                {
                    if let Some(row) = index.card(&path)? {
                        cards.push(page_card(&row, Some(relation)));
                    }
                }
                Ok(GvChildren {
                    cards,
                    centre: Some(page.to_string()),
                })
            }
        }
    }
}

struct Ctx<'a> {
    index: &'a Index,
    policy: &'a AttachmentPolicy,
    picks: &'a HashMap<String, String>,
}

impl Ctx<'_> {
    /// Cards for the entries inside `parent`: folders (as `folder_kind`),
    /// then pages; attachments and attachment folders are left out.
    fn children(&self, parent: &str, folder_kind: CardKind) -> Result<Vec<GvCard>> {
        let mut cards = Vec::new();
        for row in self.index.card_children(parent)? {
            match row.kind {
                FileKind::Folder if !is_attachment_folder(self.policy, &row.path) => {
                    cards.push(self.folder_card(&row, folder_kind)?);
                }
                FileKind::Page => cards.push(page_card(&row, None)),
                _ => {}
            }
        }
        Ok(cards)
    }

    /// A folder card: its index note's preview, else a summary (GV-02).
    fn folder_card(&self, folder: &CardRow, kind: CardKind) -> Result<GvCard> {
        let children = self.index.card_children(&folder.path)?;
        let subfolders: Vec<&CardRow> = children
            .iter()
            .filter(|r| r.kind == FileKind::Folder && !is_attachment_folder(self.policy, &r.path))
            .collect();
        let pages: Vec<&CardRow> = children
            .iter()
            .filter(|r| r.kind == FileKind::Page)
            .collect();
        let child_titles: Vec<String> = subfolders
            .iter()
            .map(|r| r.name.clone())
            .chain(pages.iter().map(|r| title_of(r)))
            .take(SUMMARY_TITLES)
            .collect();
        let own = name_key(&folder.name);
        let named_like = pages.iter().find(|r| name_key(stem(&r.name)) == own);
        let index_md = pages.iter().find(|r| name_key(&r.name) == "index.md");
        let picked = match self.picks.get(&folder.path) {
            Some(p) => self.index.card(p)?.filter(|r| r.kind == FileKind::Page),
            None => None,
        };
        let index_row: Option<CardRow> = named_like
            .or(index_md)
            .map(|r| (*r).clone())
            .or(picked)
            .or_else(|| (pages.len() == 1 && subfolders.is_empty()).then(|| pages[0].clone()));
        let mut card = match &index_row {
            Some(row) => page_card(row, None),
            None => GvCard {
                path: String::new(),
                kind,
                title: folder.name.clone(),
                subtitle: Some(folder.name.clone()),
                cover: None,
                cover_remote: false,
                cover_y: None,
                excerpt: child_titles.join(" · "),
                has_image: false,
                has_audio: false,
                index_page: None,
                pages: 0,
                folders: 0,
                child_titles: Vec::new(),
                relation: None,
            },
        };
        card.path = folder.path.clone();
        card.kind = kind;
        card.index_page = index_row.map(|r| r.path);
        card.pages = pages.len() as u32;
        card.folders = subfolders.len() as u32;
        card.child_titles = child_titles;
        Ok(card)
    }
}

/// A page's card data from its index row.
fn page_card(row: &CardRow, relation: Option<Relation>) -> GvCard {
    let remote = row.cover.as_deref().is_some_and(has_scheme);
    GvCard {
        path: row.path.clone(),
        kind: CardKind::Page,
        title: title_of(row),
        subtitle: row.subtitle.clone(),
        cover: if remote { None } else { row.cover_path.clone() },
        cover_remote: remote,
        cover_y: row.cover_y,
        excerpt: row.excerpt.clone().unwrap_or_default(),
        has_image: row.has_image,
        has_audio: row.has_audio,
        index_page: None,
        pages: 0,
        folders: 0,
        child_titles: Vec::new(),
        relation,
    }
}

/// The pages around `centre`, by name: links out (and undirected
/// relationships either way) go right, links in and relationships directed
/// at the centre go left; both ways is `Both`.
fn neighbours(centre: &str, links: &[PageLink]) -> Vec<(String, Relation)> {
    let mut sides: BTreeMap<(String, String), (bool, bool)> = BTreeMap::new();
    for l in links {
        let (other, out) = if l.src == centre && l.target != centre {
            (&l.target, true)
        } else if l.target == centre && l.src != centre {
            let undirected_related = l.kind == LinkKind::FrontmatterRelated && !l.directed;
            (&l.src, undirected_related)
        } else {
            continue;
        };
        let file = other.rsplit('/').next().unwrap_or(other);
        let entry = sides
            .entry((name_key(file), other.clone()))
            .or_insert((false, false));
        if out {
            entry.1 = true;
        } else {
            entry.0 = true;
        }
    }
    sides
        .into_iter()
        .map(|((_, path), side)| {
            let relation = match side {
                (true, true) => Relation::Both,
                (true, false) => Relation::In,
                _ => Relation::Out,
            };
            (path, relation)
        })
        .collect()
}

/// True when `path` is where the vault's attachments go (M3a §3.1).
pub(crate) fn is_attachment_folder(policy: &AttachmentPolicy, path: &str) -> bool {
    match policy {
        AttachmentPolicy::Subfolder(sub) => {
            let key = name_key(path);
            let sub = name_key(sub);
            key == sub || key.ends_with(&format!("/{sub}"))
        }
        AttachmentPolicy::Folder(folder) => name_key(path) == name_key(folder.as_str()),
        AttachmentPolicy::VaultRoot | AttachmentPolicy::SameAsNote => false,
    }
}

fn title_of(row: &CardRow) -> String {
    row.title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| stem(&row.name).to_string())
}

fn stem(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((s, ext)) if !s.is_empty() && ext.eq_ignore_ascii_case("md") => s,
        _ => name,
    }
}

/// `https:`, `data:`… — a cover that isn't a vault path (M2a URL policy).
fn has_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        && scheme.len() > 1
}
```

Modify `crates/liber-session/src/lib.rs` (apply this diff):

```diff
@@ -5,6 +5,7 @@ mod attachments;
 mod editing;
 mod error;
 mod events;
+mod global_view;
 mod rename;
 mod session;
 mod watching;
@@ -12,4 +13,5 @@ mod watching;
 pub use attachments::{Attached, LinkSuggestion, cover_reference, sanitize_file_name};
 pub use error::{Result, SessionError};
 pub use events::{IndexReport, RenameOutcome, SessionEvent};
+pub use global_view::{CardKind, GvCard, GvChildren, GvLevel, Relation, SUMMARY_TITLES};
 pub use session::{VaultSession, index_db_path};
```

Modify `crates/liber-vault/src/config.rs` (apply this diff):

```diff
@@ -60,6 +60,9 @@ pub(crate) struct LiberVaultJson {
     pub exclude: Vec<String>,
     #[serde(default)]
     pub attachments: Option<LiberAttachments>,
+    /// Folder → the page picked as its card preview (GV-02, picked in M3b).
+    #[serde(default, rename = "indexPicks")]
+    pub index_picks: std::collections::HashMap<String, String>,
 }
 
 #[derive(Debug, Clone, Deserialize)]
```

Modify `crates/liber-vault/src/vault.rs` (apply this diff):

```diff
@@ -146,6 +146,13 @@ impl Vault {
         (liber.attachments, obsidian)
     }
 
+    /// `indexPicks` from `.liber/vault.json` (folder → page; GV-02), re-read on
+    /// every call like the attachment policy. Unreadable: none.
+    pub fn index_picks(&self) -> std::collections::HashMap<String, String> {
+        let liber: LiberVaultJson = read_json(&self.root, LIBER_JSON, &mut Vec::new());
+        liber.index_picks
+    }
+
     /// Non-fatal configuration problems found while opening.
     pub fn warnings(&self) -> &[String] {
         &self.warnings
```


- [ ] **Step 4: Run the tests and watch them pass**

Run: `cargo test -p liber-session --test global_view && cargo clippy -p liber-session -p liber-index -p liber-vault --all-targets -- -D warnings`
Expected: `6 passed; 0 failed`; clippy clean.

- [ ] **Step 5: Commit**

```bash
git add crates/liber-index/src/index.rs crates/liber-index/src/lib.rs crates/liber-index/src/rows.rs crates/liber-session/src/global_view.rs crates/liber-session/src/lib.rs crates/liber-session/tests/global_view.rs crates/liber-vault/src/config.rs crates/liber-vault/src/vault.rs
git commit -m "$(cat <<'EOF'
feat(session): Global View levels and cards (M3a §3, §4)

gv_children for the vault (projects, root pages), a folder (subfolders,
pages) and a page (itself plus links out, backlinks and relationships,
each placed in/out/both). Folder cards preview their index note — named
like the folder, index.md, an indexPicks entry, or the only page — else
summarise their children. Attachment folders (per the attachment
policy) are never cards; covers are resolved, remote ones flagged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Notes from the test run:** Only the list form of `related:` is indexed (`related:\n  - "[[X]]"`); a scalar `related: "[[X]]"` is not. That is pre-existing behaviour, and the fixtures use the list form.

---

### Task 3: Session: edges aggregated to the visible cards (+ perf)

**Commits in the test run:** `ffeeda0`

**Files:**
- Modify: `crates/liber-index/src/index.rs`
- Modify: `crates/liber-session/src/global_view.rs`
- Modify: `crates/liber-session/src/lib.rs`
- Modify: `crates/liber-session/tests/global_view.rs` (test)

**Interfaces:**
- **Produces:**
  - `EdgeKind { Link, Manual }`;
  - `GvEdge { from, to, kind, count: u32, aggregated, directed, label }`;
  - `MAX_VISIBLE = 1000`;
  - `VaultSession::gv_edges(&[String]) -> Result<Vec<GvEdge>>`;
  - `Index::page_links_from(&[String])`: one indexed `src` range query per visible card (a link whose source isn't shown can't become an edge).
- **Edge rules:**
  - undirected edges carry `from < to`;
  - a directed relationship keeps its source as `from`.

- [ ] **Step 1: Write the failing test**

Modify `crates/liber-session/tests/global_view.rs` (apply this diff):

```diff
@@ -1,7 +1,9 @@
 //! M3a §3, §4, §8: Global View levels (vault, folder, page neighbourhood),
 //! cards (index notes, folder summaries, covers), edges and layouts.
 
-use liber_session::{CardKind, GvCard, GvLevel, Relation, SessionEvent, VaultSession};
+use liber_session::{
+    CardKind, EdgeKind, GvCard, GvEdge, GvLevel, Relation, SessionEvent, VaultSession,
+};
 use liber_vault::VaultPath;
 use std::path::Path;
 
@@ -33,15 +35,15 @@ fn vault() -> tempfile::TempDir {
         "Alpha/Alpha.md",
         "---\nsubtitle: The first project\n---\n# Alpha home\n\nAll about alpha.\n",
     );
-    write(
-        r,
-        "Alpha/note.md",
-        "---\nrelated: \"[[Welcome]]\"\n---\n# A note\n",
-    );
+    write(r, "Alpha/note.md", "# A note\n");
     write(r, "Alpha/Sub/index.md", "# Sub index\n");
     write(r, "Alpha/Sub/deep.md", "# Deep\n");
     write(r, "Beta/only.md", "# Only page\n\nSee [[Welcome]].\n");
-    write(r, "Gamma/a.md", "# Gamma A\n");
+    write(
+        r,
+        "Gamma/a.md",
+        "---\nrelated:\n  - \"[[Welcome]]\"\n---\n# Gamma A\n",
+    );
     write(
         r,
         "Gamma/b.md",
@@ -176,11 +178,12 @@ fn gv_16_page_level_is_the_page_and_its_neighbourhood() {
     assert_eq!(level.cards[0].path, "Welcome.md", "the centre comes first");
     // Links out; an undirected `related:` pointing here goes right too.
     assert_eq!(rel("Alpha/note.md"), Some(Relation::Out));
+    assert_eq!(rel("Gamma/a.md"), Some(Relation::Out));
     assert_eq!(rel("zeta.md"), Some(Relation::Both));
     assert_eq!(rel("Beta/only.md"), Some(Relation::In));
     // A directed relationship towards this page comes in.
     assert_eq!(rel("Delta/y.md"), Some(Relation::In));
-    assert_eq!(level.cards.len(), 5, "no image card, no duplicates");
+    assert_eq!(level.cards.len(), 6, "no image card, no duplicates");
     assert!(level.cards.iter().all(|c| c.kind == CardKind::Page));
 }
 
@@ -217,3 +220,128 @@ fn m3a_an_obsidian_attachment_folder_is_hidden_and_a_fixed_one_too() {
         "Gamma is now the attachment folder; `attachments` is an ordinary folder"
     );
 }
+
+/// Pages in folders A and B linking across, a relationship with a label and
+/// a direction, an image embed (never an edge) and a link inside A.
+fn linked_vault() -> tempfile::TempDir {
+    let dir = tempfile::tempdir().unwrap();
+    let r = dir.path();
+    write(r, "A/p.md", "# P\n\n[[q]] and [[s]] ![[pic.png]]\n");
+    write(r, "A/r.md", "# R\n\n[[q]] [[p]]\n");
+    write(r, "A/pic.png", "png");
+    write(
+        r,
+        "B/q.md",
+        "---\nrelated:\n  - { link: \"[[root]]\", label: sequel, directed: true }\n---\n# Q\n",
+    );
+    write(r, "B/s.md", "# S\n");
+    write(r, "C/t.md", "# T\n");
+    write(r, "root.md", "---\nrelated:\n  - \"[[t]]\"\n---\n# Root\n");
+    dir
+}
+
+fn visible(list: &[&str]) -> Vec<String> {
+    list.iter().map(|s| s.to_string()).collect()
+}
+
+fn edge<'a>(edges: &'a [GvEdge], a: &str, b: &str, kind: EdgeKind) -> &'a GvEdge {
+    edges
+        .iter()
+        .find(|e| e.kind == kind && ((e.from == a && e.to == b) || (e.from == b && e.to == a)))
+        .unwrap_or_else(|| panic!("no {kind:?} edge {a}–{b} in {edges:?}"))
+}
+
+#[test]
+fn gv_25_links_inside_folders_aggregate_to_one_edge_per_card_pair() {
+    let dir = linked_vault();
+    let (_c, s) = open(dir.path());
+    let edges = s.gv_edges(&visible(&["A", "B", "C", "root.md"])).unwrap();
+    // p→q, p→s and r→q: three links from A into B, one aggregated edge.
+    let ab = edge(&edges, "A", "B", EdgeKind::Link);
+    assert_eq!((ab.count, ab.aggregated, ab.directed), (3, true, false));
+    // The link inside A (r→p) and the image embed draw nothing.
+    assert!(!edges.iter().any(|e| e.from == e.to));
+    // Relationships: B/q.md → root (directed, labelled), root → C/t.md.
+    let manual = edge(&edges, "B", "root.md", EdgeKind::Manual);
+    assert_eq!(
+        (manual.from.as_str(), manual.to.as_str()),
+        ("B", "root.md"),
+        "directed edges keep their orientation"
+    );
+    assert!(manual.directed && manual.aggregated);
+    assert_eq!(manual.label.as_deref(), Some("sequel"));
+    let rc = edge(&edges, "root.md", "C", EdgeKind::Manual);
+    assert!(!rc.directed && rc.label.is_none());
+    assert_eq!(edges.len(), 3, "{edges:?}");
+}
+
+#[test]
+fn gv_20_visible_pages_connect_directly_and_folders_take_the_rest() {
+    let dir = linked_vault();
+    let (_c, s) = open(dir.path());
+    // Expand-like canvas: folder A expanded to show p.md; B stays a card.
+    let edges = s
+        .gv_edges(&visible(&[
+            "A", "A/p.md", "B", "B/q.md", "B/s.md", "root.md",
+        ]))
+        .unwrap();
+    let pq = edge(&edges, "A/p.md", "B/q.md", EdgeKind::Link);
+    assert_eq!((pq.count, pq.aggregated), (1, false));
+    edge(&edges, "A/p.md", "B/s.md", EdgeKind::Link);
+    // r.md isn't visible: its links count for A (r→q → A–q; r→p → A–p).
+    let aq = edge(&edges, "A", "B/q.md", EdgeKind::Link);
+    assert!(aq.aggregated);
+    let ap = edge(&edges, "A", "A/p.md", EdgeKind::Link);
+    assert!(ap.aggregated);
+    let qr = edge(&edges, "B/q.md", "root.md", EdgeKind::Manual);
+    assert!(!qr.aggregated && qr.directed);
+}
+
+#[test]
+fn m3a_no_visible_cards_no_edges() {
+    let dir = linked_vault();
+    let (_c, s) = open(dir.path());
+    assert!(s.gv_edges(&[]).unwrap().is_empty());
+    assert!(s.gv_edges(&visible(&["Nope"])).unwrap().is_empty());
+}
+
+/// NFR-03 (M3a §10): on a 10,000-note vault, a 200-card folder level and its
+/// edges take < 100 ms. Release only:
+/// `cargo test --release -p liber-session --test global_view -- --ignored`.
+#[test]
+#[ignore = "perf: run in release with --ignored"]
+fn nfr_03_a_200_card_level_and_its_edges_in_under_100_ms() {
+    use liber_testkit::{VaultShape, generate_vault};
+    let dir = tempfile::tempdir().unwrap();
+    generate_vault(dir.path(), VaultShape::TEN_K, 42);
+    for i in 0..200 {
+        write(
+            dir.path(),
+            &format!("Big/Page {i}.md"),
+            &format!(
+                "# Page {i}\n\n[[Page {}]] [[hub]] [[Note {i}]]\n",
+                (i + 1) % 200
+            ),
+        );
+    }
+    let (_c, s) = open(dir.path());
+    let started = std::time::Instant::now();
+    let level = s.gv_children(&GvLevel::Folder(vp("Big"))).unwrap();
+    let shown: Vec<String> = level.cards.iter().map(|c| c.path.clone()).collect();
+    let edges = s.gv_edges(&shown).unwrap();
+    let took = started.elapsed();
+    assert_eq!(level.cards.len(), 200);
+    assert_eq!(edges.len(), 200, "one ring of links");
+    eprintln!("200-card level + edges: {took:?}");
+    assert!(took < std::time::Duration::from_millis(100), "{took:?}");
+
+    // Level 0 reads every link in the vault (each project is a subtree):
+    // ~90 ms here, inside the 300 ms render budget with room for the UI.
+    let started = std::time::Instant::now();
+    let level = s.gv_children(&GvLevel::Vault).unwrap();
+    let shown: Vec<String> = level.cards.iter().map(|c| c.path.clone()).collect();
+    s.gv_edges(&shown).unwrap();
+    let took = started.elapsed();
+    eprintln!("level 0 ({} cards) + edges: {took:?}", level.cards.len());
+    assert!(took < std::time::Duration::from_millis(150), "{took:?}");
+}
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cargo test -p liber-session --test global_view`
Expected: does not compile: `unresolved imports liber_session::EdgeKind, GvEdge`, `no method named gv_edges`.

- [ ] **Step 3: Implement**

Modify `crates/liber-index/src/index.rs` (apply this diff):

```diff
@@ -81,12 +81,17 @@ fn card_row(r: &Row<'_>) -> rusqlite::Result<CardRow> {
 const PAGE_LINK_KINDS: &str = "('wiki', 'embed', 'markdown', 'related')";
 
 fn page_link(r: &Row<'_>) -> rusqlite::Result<PageLink> {
+    page_link_at(r, 0)
+}
+
+/// A `PageLink` from the five columns starting at `at`.
+fn page_link_at(r: &Row<'_>, at: usize) -> rusqlite::Result<PageLink> {
     Ok(PageLink {
-        src: r.get(0)?,
-        target: r.get(1)?,
-        kind: LinkKind::parse(&r.get::<_, String>(2)?).unwrap_or(LinkKind::Wiki),
-        label: r.get(3)?,
-        directed: r.get(4)?,
+        src: r.get(at)?,
+        target: r.get(at + 1)?,
+        kind: LinkKind::parse(&r.get::<_, String>(at + 2)?).unwrap_or(LinkKind::Wiki),
+        label: r.get(at + 3)?,
+        directed: r.get(at + 4)?,
     })
 }
 
@@ -274,16 +279,30 @@ impl Index {
         Ok(stmt.query_row([path], card_row).optional()?)
     }
 
-    /// Every resolved link between two pages (M3a §6).
-    pub fn page_links(&self) -> Result<Vec<PageLink>> {
+    /// Resolved links between two pages that start at one of `paths` or
+    /// inside it (folders), each once, in index order (M3a §6): one indexed
+    /// range query per path, so a level costs what it shows, not the vault.
+    pub fn page_links_from(&self, paths: &[String]) -> Result<Vec<PageLink>> {
+        let mut found: std::collections::BTreeMap<i64, PageLink> =
+            std::collections::BTreeMap::new();
         let mut stmt = self.conn.prepare_cached(&format!(
-            "SELECT l.src, l.target_path, l.kind, l.label, l.directed FROM links l \
+            "SELECT l.id, l.src, l.target_path, l.kind, l.label, l.directed FROM links l \
              JOIN files t ON t.path = l.target_path \
-             WHERE t.kind = 'page' AND l.kind IN {PAGE_LINK_KINDS} ORDER BY l.src, l.start"
+             WHERE t.kind = 'page' AND l.kind IN {PAGE_LINK_KINDS} \
+             AND (l.src = ?1 OR (l.src >= ?2 AND l.src < ?3))"
         ))?;
-        Ok(stmt
-            .query_map([], page_link)?
-            .collect::<rusqlite::Result<Vec<_>>>()?)
+        for path in paths {
+            // Everything inside `path/`: '/' + 1 is '0'.
+            let rows = stmt
+                .query_map(params![path, format!("{path}/"), format!("{path}0")], |r| {
+                    Ok((r.get::<_, i64>(0)?, page_link_at(r, 1)?))
+                })?;
+            for row in rows {
+                let (id, link) = row?;
+                found.entry(id).or_insert(link);
+            }
+        }
+        Ok(found.into_values().collect())
     }
 
     /// Resolved page-to-page links from or to `path` (a page's neighbourhood).
```

Modify `crates/liber-session/src/global_view.rs` (apply this diff):

```diff
@@ -300,3 +300,96 @@ fn has_scheme(value: &str) -> bool {
         && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
         && scheme.len() > 1
 }
+
+/// Edge kinds drawn from the index (parent/child edges are drawn by the UI).
+#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
+pub enum EdgeKind {
+    /// Text links and page embeds.
+    Link,
+    /// `related:` relationships (GV-22–24).
+    Manual,
+}
+
+/// One edge between two visible cards (M3a §6).
+#[derive(Debug, Clone, PartialEq, Eq)]
+pub struct GvEdge {
+    /// Undirected edges: the smaller path. Directed ones: the source.
+    pub from: String,
+    pub to: String,
+    pub kind: EdgeKind,
+    /// Links (or relationships) folded into this edge.
+    pub count: u32,
+    /// An end stands for a folder card the link starts or ends inside (GV-25).
+    pub aggregated: bool,
+    /// Manual edges: an entry for this pair is directed (`from` → `to`).
+    pub directed: bool,
+    /// Manual edges: the first label found for this pair.
+    pub label: Option<String>,
+}
+
+/// Most cards one `gv_edges` call may name.
+pub const MAX_VISIBLE: usize = 1000;
+
+impl VaultSession {
+    /// Edges between `visible` cards: every resolved page-to-page link and
+    /// relationship, each end moved to its nearest visible ancestor-or-self,
+    /// one edge per card pair and kind with a count (GV-20, GV-25).
+    pub fn gv_edges(&self, visible: &[String]) -> Result<Vec<GvEdge>> {
+        if visible.is_empty() {
+            return Ok(Vec::new());
+        }
+        let shown: std::collections::HashSet<&str> = visible.iter().map(String::as_str).collect();
+        let lift = |path: &str| -> Option<String> {
+            let mut p = path;
+            loop {
+                if shown.contains(p) {
+                    return Some(p.to_string());
+                }
+                p = &p[..p.rfind('/')?];
+            }
+        };
+        // A link whose source isn't shown (or inside a shown folder) can't
+        // become an edge, so only those are read.
+        let links = self.index().page_links_from(visible)?;
+        let mut edges: BTreeMap<(String, String, EdgeKind), GvEdge> = BTreeMap::new();
+        for l in links {
+            let (Some(a), Some(b)) = (lift(&l.src), lift(&l.target)) else {
+                continue;
+            };
+            if a == b {
+                continue;
+            }
+            let kind = if l.kind == LinkKind::FrontmatterRelated {
+                EdgeKind::Manual
+            } else {
+                EdgeKind::Link
+            };
+            let aggregated = a != l.src || b != l.target;
+            let (lo, hi) = if a < b { (&a, &b) } else { (&b, &a) };
+            let edge = edges
+                .entry((lo.clone(), hi.clone(), kind))
+                .or_insert_with(|| GvEdge {
+                    from: lo.clone(),
+                    to: hi.clone(),
+                    kind,
+                    count: 0,
+                    aggregated: false,
+                    directed: false,
+                    label: None,
+                });
+            edge.count += 1;
+            edge.aggregated |= aggregated;
+            if kind == EdgeKind::Manual {
+                if edge.label.is_none() {
+                    edge.label = l.label.clone().filter(|s| !s.trim().is_empty());
+                }
+                if l.directed && !edge.directed {
+                    edge.directed = true;
+                    edge.from = a.clone();
+                    edge.to = b.clone();
+                }
+            }
+        }
+        Ok(edges.into_values().collect())
+    }
+}
```

Modify `crates/liber-session/src/lib.rs` (apply this diff):

```diff
@@ -13,5 +13,7 @@ mod watching;
 pub use attachments::{Attached, LinkSuggestion, cover_reference, sanitize_file_name};
 pub use error::{Result, SessionError};
 pub use events::{IndexReport, RenameOutcome, SessionEvent};
-pub use global_view::{CardKind, GvCard, GvChildren, GvLevel, Relation, SUMMARY_TITLES};
+pub use global_view::{
+    CardKind, EdgeKind, GvCard, GvChildren, GvEdge, GvLevel, MAX_VISIBLE, Relation, SUMMARY_TITLES,
+};
 pub use session::{VaultSession, index_db_path};
```


- [ ] **Step 4: Run the tests and watch them pass**

Run: `cargo test -p liber-session --test global_view && cargo test --release -p liber-session --test global_view -- --ignored --nocapture`
Expected: `9 passed; 0 failed; 1 ignored`; release perf: `200-card level + edges: ~1.7 ms`, `level 0 (95 cards) + edges: ~91 ms`, `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/liber-index/src/index.rs crates/liber-session/src/global_view.rs crates/liber-session/src/lib.rs crates/liber-session/tests/global_view.rs
git commit -m "$(cat <<'EOF'
feat(session): Global View edges, aggregated to the visible cards (M3a §6)

gv_edges lifts both ends of every resolved page-to-page link and
relationship to the nearest visible card (or folder containing it), one
edge per pair and kind with a count; aggregated when an end stands for a
folder (GV-25); manual edges keep the first label and a direction.
Only links starting inside a shown card are read (indexed range
queries): a 200-card level and its edges take ~2 ms on 10k notes, level
0 ~90 ms (release; ignored perf test).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Notes from the test run:** A first version read every page link (`page_links()`, ordered by `src, start`): 83 ms for 200 cards. Reading only links that start inside a shown card brought it to ~2 ms, and level 0 (every project, so every link) to ~90 ms.

---

### Task 4: Vault: pinned positions in .liber/layout.json, following renames

**Commits in the test run:** `be285cf`

**Files:**
- Modify: `crates/liber-session/src/global_view.rs`
- Modify: `crates/liber-session/src/rename.rs`
- Modify: `crates/liber-session/src/watching.rs`
- Modify: `crates/liber-session/tests/global_view.rs` (test)
- Create: `crates/liber-vault/src/layout.rs`
- Modify: `crates/liber-vault/src/lib.rs`
- Modify: `crates/liber-vault/src/vault.rs`
- Create: `crates/liber-vault/tests/layout.rs` (test)

**Interfaces:**
- **Produces (`liber_vault`):**
  - `CardPosition { x: f64, y: f64 }`;
  - `Vault::layout_level(&str) -> BTreeMap<String, CardPosition>` (missing or unreadable: empty);
  - `Vault::set_layout_level(&str, &BTreeMap<..>) -> Result<()>` (empty removes; created lazily; non-finite refused);
  - `Vault::remap_layout(from, to) -> Result<()>` (no file: no write);
  - `pub(crate) update_json_object(rel, create, edit)`, now also used by `set_liber_attachments`.
- **Produces (`liber_session`):** `VaultSession::follow_layout` (crate-private), called by `rename_with_hook` and the watcher's rename handling; a failure becomes `SessionEvent::Warning`.

- [ ] **Step 1: Write the failing tests**

Modify `crates/liber-session/tests/global_view.rs` (apply this diff):

```diff
@@ -345,3 +345,47 @@ fn nfr_03_a_200_card_level_and_its_edges_in_under_100_ms() {
     eprintln!("level 0 ({} cards) + edges: {took:?}", level.cards.len());
     assert!(took < std::time::Duration::from_millis(150), "{took:?}");
 }
+
+#[test]
+fn m3a_pinned_positions_follow_in_app_and_external_renames() {
+    use liber_vault::{CardPosition, WatchEvent};
+    use std::collections::BTreeMap;
+    let dir = vault();
+    let (_c, s) = open(dir.path());
+    let pin = |path: &str| -> BTreeMap<String, CardPosition> {
+        [(path.to_string(), CardPosition { x: 1.0, y: 2.0 })].into()
+    };
+    s.vault().set_layout_level("", &pin("Alpha")).unwrap();
+    s.vault()
+        .set_layout_level("Alpha", &pin("Alpha/note.md"))
+        .unwrap();
+    s.vault()
+        .set_layout_level("", &{
+            let mut m = pin("Alpha");
+            m.extend(pin("zeta.md"));
+            m
+        })
+        .unwrap();
+
+    // In-app: the folder moves, its level key and card entries follow.
+    s.rename(&vp("Alpha"), &vp("Projects A"), false).unwrap();
+    assert!(s.vault().layout_level("").contains_key("Projects A"));
+    assert!(
+        s.vault()
+            .layout_level("Projects A")
+            .contains_key("Projects A/note.md")
+    );
+
+    // Another program renames a page (delete + create with the same content).
+    std::fs::rename(dir.path().join("zeta.md"), dir.path().join("omega.md")).unwrap();
+    s.apply(vec![
+        WatchEvent::Removed(vp("zeta.md")),
+        WatchEvent::Changed(vp("omega.md")),
+    ])
+    .unwrap();
+    let root = s.vault().layout_level("");
+    assert!(
+        root.contains_key("omega.md") && !root.contains_key("zeta.md"),
+        "{root:?}"
+    );
+}
```

Create `crates/liber-vault/tests/layout.rs`:

```rust
//! M3a §7: pinned Global View card positions in `.liber/layout.json`.

use liber_vault::{CardPosition, Vault};
use std::collections::BTreeMap;

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

fn at(x: f64, y: f64) -> CardPosition {
    CardPosition { x, y }
}

fn positions(list: &[(&str, f64, f64)]) -> BTreeMap<String, CardPosition> {
    list.iter()
        .map(|(p, x, y)| (p.to_string(), at(*x, *y)))
        .collect()
}

fn file(dir: &tempfile::TempDir) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.path().join(".liber/layout.json")).unwrap()).unwrap()
}

#[test]
fn gv_31_positions_are_saved_per_level_lazily_and_read_back() {
    let (dir, vault) = fresh();
    assert!(vault.layout_level("").is_empty());
    assert!(
        !dir.path().join(".liber").exists(),
        "VLT-02: reading writes nothing"
    );
    vault
        .set_layout_level("", &positions(&[("Alpha", 10.0, 20.5)]))
        .unwrap();
    vault
        .set_layout_level("page:Notes/a.md", &positions(&[("Notes/b.md", -3.0, 4.0)]))
        .unwrap();
    assert_eq!(vault.layout_level(""), positions(&[("Alpha", 10.0, 20.5)]));
    let json = file(&dir);
    assert_eq!(json["version"], 1);
    assert_eq!(json["levels"][""]["Alpha"]["x"], 10.0);
    assert_eq!(json["levels"]["page:Notes/a.md"]["Notes/b.md"]["y"], 4.0);
}

#[test]
fn gv_32_an_empty_level_is_removed_and_unknown_keys_survive() {
    let (dir, vault) = fresh();
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    std::fs::write(
        dir.path().join(".liber/layout.json"),
        r#"{"version":1,"future":{"keep":true},"levels":{"Alpha":{"Alpha/x.md":{"x":1,"y":2}},"":{"Alpha":{"x":0,"y":0}}}}"#,
    )
    .unwrap();
    vault.set_layout_level("Alpha", &BTreeMap::new()).unwrap();
    let json = file(&dir);
    assert!(json["levels"].get("Alpha").is_none());
    assert_eq!(json["levels"][""]["Alpha"]["x"], 0.0);
    assert_eq!(json["future"]["keep"], true);
}

#[test]
fn m3a_layout_follows_renames_of_folders_and_pages() {
    let (dir, vault) = fresh();
    vault
        .set_layout_level("", &positions(&[("Alpha", 1.0, 1.0), ("Beta", 2.0, 2.0)]))
        .unwrap();
    vault
        .set_layout_level(
            "Alpha",
            &positions(&[("Alpha/a.md", 3.0, 3.0), ("Alpha/Sub", 4.0, 4.0)]),
        )
        .unwrap();
    vault
        .set_layout_level("page:Alpha/a.md", &positions(&[("Beta/b.md", 5.0, 5.0)]))
        .unwrap();
    vault
        .set_layout_level("expand:Alpha", &positions(&[("Alpha/Sub/c.md", 6.0, 6.0)]))
        .unwrap();
    vault
        .set_layout_level("Alphabet", &positions(&[("Alphabet/z.md", 7.0, 7.0)]))
        .unwrap();

    vault.remap_layout("Alpha", "Projects/Alpha").unwrap();
    let level = |k: &str| vault.layout_level(k);
    assert_eq!(
        level(""),
        positions(&[("Beta", 2.0, 2.0), ("Projects/Alpha", 1.0, 1.0)])
    );
    assert_eq!(
        level("Projects/Alpha"),
        positions(&[
            ("Projects/Alpha/Sub", 4.0, 4.0),
            ("Projects/Alpha/a.md", 3.0, 3.0)
        ])
    );
    assert_eq!(
        level("page:Projects/Alpha/a.md"),
        positions(&[("Beta/b.md", 5.0, 5.0)])
    );
    assert_eq!(
        level("expand:Projects/Alpha"),
        positions(&[("Projects/Alpha/Sub/c.md", 6.0, 6.0)])
    );
    assert!(level("Alpha").is_empty());
    assert_eq!(
        level("Alphabet"),
        positions(&[("Alphabet/z.md", 7.0, 7.0)]),
        "a sibling sharing the prefix is untouched"
    );
    let _ = dir;
}

#[test]
fn m3a_remap_without_a_layout_writes_nothing_and_bad_numbers_are_refused() {
    let (dir, vault) = fresh();
    vault.remap_layout("a.md", "b.md").unwrap();
    assert!(!dir.path().join(".liber").exists());
    assert!(
        vault
            .set_layout_level("", &positions(&[("x", f64::NAN, 0.0)]))
            .is_err()
    );
    assert!(!dir.path().join(".liber").exists());
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p liber-vault --test layout && cargo test -p liber-session --test global_view`
Expected: does not compile: `unresolved import liber_vault::CardPosition`, `no method named layout_level / set_layout_level`. Once the vault part exists, `m3a_pinned_positions_follow_in_app_and_external_renames` fails with `assertion failed: s.vault().layout_level("").contains_key("Projects A")`.

- [ ] **Step 3: Implement**

Modify `crates/liber-session/src/global_view.rs` (apply this diff):

```diff
@@ -301,6 +301,18 @@ fn has_scheme(value: &str) -> bool {
         && scheme.len() > 1
 }
 
+impl VaultSession {
+    /// Pinned Global View positions follow a rename (M3a §7). The layout is
+    /// a convenience: a failure is reported, never fails the rename.
+    pub(crate) fn follow_layout(&self, from: &str, to: &str) {
+        if let Err(e) = self.vault.remap_layout(from, to) {
+            self.emit(crate::events::SessionEvent::Warning(format!(
+                "Global View layout not updated for {from} → {to}: {e}"
+            )));
+        }
+    }
+}
+
 /// Edge kinds drawn from the index (parent/child edges are drawn by the UI).
 #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
 pub enum EdgeKind {
```

Modify `crates/liber-session/src/rename.rs` (apply this diff):

```diff
@@ -226,6 +226,7 @@ impl VaultSession {
         self.vault.rename(from, to)?;
         self.index()
             .transaction(|tx| tx.rename(from.as_str(), to.as_str()))?;
+        self.follow_layout(from.as_str(), to.as_str());
 
         let mut outcome = RenameOutcome {
             moved: {
```

Modify `crates/liber-session/src/watching.rs` (apply this diff):

```diff
@@ -237,6 +237,9 @@ impl VaultSession {
             index.resolve_from(&files, p)?;
         }
         drop(index);
+        for (from, to) in &renamed {
+            self.follow_layout(from, to);
+        }
         for w in warnings {
             self.emit_warning(w);
         }
```

Create `crates/liber-vault/src/layout.rs`:

```rust
//! M3a §7: pinned Global View card positions, per level, in
//! `.liber/layout.json` (arch §3.1): `{ "version": 1, "levels": { "<level
//! key>": { "<card path>": { "x": 0, "y": 0 } } } }`. Level keys: `""` (the
//! vault), a folder path, `page:<path>`, `expand:<level key>`.

use crate::error::{Result, VaultError};
use crate::vault::{Vault, read_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const LAYOUT_JSON: &str = ".liber/layout.json";

/// Where a card was dropped on the canvas (flow coordinates).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CardPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Default, Deserialize)]
struct LayoutJson {
    #[serde(default)]
    levels: BTreeMap<String, BTreeMap<String, CardPosition>>,
}

impl Vault {
    /// The pinned positions of one level (none when the file is missing or
    /// unreadable — the layout is a convenience, never an error).
    pub fn layout_level(&self, level: &str) -> BTreeMap<String, CardPosition> {
        let layout: LayoutJson = read_json(self.root(), LAYOUT_JSON, &mut Vec::new());
        layout.levels.get(level).cloned().unwrap_or_default()
    }

    /// Stores a level's pinned positions (an empty map removes the level).
    /// The file is created on first need; other levels and keys are kept.
    pub fn set_layout_level(
        &self,
        level: &str,
        positions: &BTreeMap<String, CardPosition>,
    ) -> Result<()> {
        if positions
            .values()
            .any(|p| !p.x.is_finite() || !p.y.is_finite())
        {
            return Err(VaultError::InvalidConfig {
                file: LAYOUT_JSON.to_string(),
                reason: "card positions must be finite numbers".to_string(),
            });
        }
        let value = serde_json::to_value(positions).expect("positions serialize");
        self.update_json_object(LAYOUT_JSON, !positions.is_empty(), |map| {
            let levels = levels_of(map);
            if positions.is_empty() {
                levels.remove(level);
            } else {
                levels.insert(level.to_string(), value);
            }
        })
    }

    /// Follows a rename or move of `from` to `to` (file or folder): level
    /// keys and card paths at or below `from` move below `to`. Without a
    /// layout file nothing is written.
    pub fn remap_layout(&self, from: &str, to: &str) -> Result<()> {
        self.update_json_object(LAYOUT_JSON, false, |map| {
            let levels = levels_of(map);
            let old = std::mem::take(levels);
            for (key, cards) in old {
                let key = remap_level_key(&key, from, to).unwrap_or(key);
                let cards = match cards {
                    serde_json::Value::Object(cards) => serde_json::Value::Object(
                        cards
                            .into_iter()
                            .map(|(path, pos)| (remap(&path, from, to).unwrap_or(path), pos))
                            .collect(),
                    ),
                    other => other,
                };
                match (levels.get_mut(&key), cards) {
                    (
                        Some(serde_json::Value::Object(existing)),
                        serde_json::Value::Object(moved),
                    ) => {
                        existing.extend(moved);
                    }
                    (_, cards) => {
                        levels.insert(key, cards);
                    }
                }
            }
        })
    }
}

/// The `levels` object of a layout file (created if missing or not an object).
fn levels_of(
    map: &mut serde_json::Map<String, serde_json::Value>,
) -> &mut serde_json::Map<String, serde_json::Value> {
    let entry = map
        .entry("levels")
        .or_insert_with(|| serde_json::Value::Object(Default::default()));
    if !entry.is_object() {
        *entry = serde_json::Value::Object(Default::default());
    }
    entry.as_object_mut().expect("just made an object")
}

/// `path` with `from` (itself or as a folder prefix) replaced by `to`.
fn remap(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    let rest = path.strip_prefix(from)?.strip_prefix('/')?;
    Some(format!("{to}/{rest}"))
}

fn remap_level_key(key: &str, from: &str, to: &str) -> Option<String> {
    if let Some(rest) = key.strip_prefix("expand:") {
        return remap_level_key(rest, from, to).map(|k| format!("expand:{k}"));
    }
    if let Some(rest) = key.strip_prefix("page:") {
        return remap(rest, from, to).map(|p| format!("page:{p}"));
    }
    remap(key, from, to)
}
```

Modify `crates/liber-vault/src/lib.rs` (apply this diff):

```diff
@@ -5,6 +5,7 @@ mod config;
 mod error;
 mod fsops;
 mod hash;
+mod layout;
 mod path;
 mod scan;
 mod vault;
@@ -14,6 +15,7 @@ pub use config::{AttachmentConfig, AttachmentPolicy};
 pub use error::{Result, VaultError};
 pub use fsops::TMP_MARKER;
 pub use hash::Hash;
+pub use layout::CardPosition;
 pub use path::VaultPath;
 pub use scan::{Entry, EntryKind, Scan};
 pub use vault::Vault;
```

Modify `crates/liber-vault/src/vault.rs` (apply this diff):

```diff
@@ -109,20 +109,42 @@ impl Vault {
         {
             return Err(invalid(&format!("invalid attachment folder {path:?}")));
         }
-        let file = VaultPath::new(LIBER_JSON)?;
+        self.update_json_object(LIBER_JSON, true, |map| {
+            map.insert(
+                "attachments".to_string(),
+                serde_json::json!({ "mode": mode, "path": stored }),
+            );
+        })
+    }
+
+    /// Reads the JSON object at `rel` (under `.liber/`), lets `edit` change it
+    /// and writes it back atomically (compare-and-swap), keeping every key
+    /// `edit` doesn't touch and adding `"version": 1`. A missing file is
+    /// created only when `create` (VLT-02: `.liber/` appears on first need);
+    /// a file that isn't a JSON object is never overwritten.
+    pub(crate) fn update_json_object(
+        &self,
+        rel: &str,
+        create: bool,
+        edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
+    ) -> Result<()> {
+        let file = VaultPath::new(rel)?;
         let (mut map, expected) = match self.read(&file) {
             Ok((bytes, hash)) => match serde_json::from_slice(&bytes) {
                 Ok(serde_json::Value::Object(map)) => (map, Some(hash)),
-                _ => return Err(invalid("not a JSON object; fix or remove it first")),
+                _ => {
+                    return Err(VaultError::InvalidConfig {
+                        file: rel.to_string(),
+                        reason: "not a JSON object; fix or remove it first".to_string(),
+                    });
+                }
             },
-            Err(VaultError::NotFound(_)) => (serde_json::Map::new(), None),
+            Err(VaultError::NotFound(_)) if create => (serde_json::Map::new(), None),
+            Err(VaultError::NotFound(_)) => return Ok(()),
             Err(e) => return Err(e),
         };
         map.entry("version").or_insert(1.into());
-        map.insert(
-            "attachments".to_string(),
-            serde_json::json!({ "mode": mode, "path": stored }),
-        );
+        edit(&mut map);
         let dir = self.fs_path(&VaultPath::new(".liber")?)?;
         if !dir.is_dir() {
             std::fs::create_dir(&dir).map_err(|e| io_err(".liber", e))?;
@@ -164,10 +186,10 @@ impl Vault {
     }
 }
 
-const LIBER_JSON: &str = ".liber/vault.json";
+pub(crate) const LIBER_JSON: &str = ".liber/vault.json";
 const OBSIDIAN_JSON: &str = ".obsidian/app.json";
 
-fn read_json<T: serde::de::DeserializeOwned + Default>(
+pub(crate) fn read_json<T: serde::de::DeserializeOwned + Default>(
     root: &Path,
     rel: &str,
     warnings: &mut Vec<String>,
```


- [ ] **Step 4: Run the tests and watch them pass**

Run: `cargo test -p liber-vault && cargo test -p liber-session`
Expected: all `ok … 0 failed`: `layout` 4 passed, M2c's `attachments` still green through the shared helper; `global_view` 10 passed, 1 ignored.

- [ ] **Step 5: Commit**

```bash
git add crates/liber-session/src/global_view.rs crates/liber-session/src/rename.rs crates/liber-session/src/watching.rs crates/liber-session/tests/global_view.rs crates/liber-vault/src/layout.rs crates/liber-vault/src/lib.rs crates/liber-vault/src/vault.rs crates/liber-vault/tests/layout.rs
git commit -m "$(cat <<'EOF'
feat(vault): pinned Global View positions in .liber/layout.json (M3a §7)

Per level key ('' vault, folder, page:<path>, expand:<key>): read back,
saved atomically (created on first need, unknown keys kept, an empty
level removed, non-finite numbers refused) and remapped by path prefix
when a file or folder is renamed — in the app and by another program
(watcher renames). A shared helper now writes both .liber JSON files.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Notes from the test run:** Another program moving a folder is reported file by file (the watcher matches files by hash), so card entries follow but the folder's own level key does not.

---

### Task 5: Commands: gv_children, gv_edges, layout_get, layout_set

**Commits in the test run:** `2a2b70c`

**Files:**
- Modify: `apps/desktop/src-tauri/build.rs`
- Modify: `apps/desktop/src-tauri/capabilities/main.json`
- Create: `apps/desktop/src-tauri/permissions/autogenerated/gv_children.toml` (generated — see the step)
- Create: `apps/desktop/src-tauri/permissions/autogenerated/gv_edges.toml` (generated — see the step)
- Create: `apps/desktop/src-tauri/permissions/autogenerated/layout_get.toml` (generated — see the step)
- Create: `apps/desktop/src-tauri/permissions/autogenerated/layout_set.toml` (generated — see the step)
- Modify: `apps/desktop/src-tauri/src/dto.rs`
- Create: `apps/desktop/src-tauri/src/gv_commands.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tests/commands.rs` (test)
- Create: `apps/desktop/src/ipc/globalView.test.ts` (test)
- Modify: `apps/desktop/src/ipc/index.ts`

**Interfaces:**
- **Consumes:** Tasks 2–4.
- **Produces (commands):**
  - `gv_children(level: {kind:'vault'} | {kind:'folder', path} | {kind:'page', path}) -> { cards: GvCardDto[], centre }` (camelCase);
  - `gv_edges(visible: string[])` (more than 1,000: `tooLarge`);
  - `layout_get(level) -> Record<path, {x, y}>`;
  - `layout_set(level, positions)`.
- **Produces (TS):**
  - types `GvLevelRef`, `GvCardKind`, `GvRelation`, `GvCard`, `GvLevel`, `GvEdge`, `CardPosition`;
  - wrappers `gvChildren`, `gvEdges`, `layoutGet`, `layoutSet`.

- [ ] **Step 1: Write the failing tests**

Modify `apps/desktop/src-tauri/tests/commands.rs` (apply this diff):

```diff
@@ -42,6 +42,10 @@ const COMMANDS: &[&str] = &[
     "attachment_import",
     "cover_pick",
     "link_suggest",
+    "gv_children",
+    "gv_edges",
+    "layout_get",
+    "layout_set",
 ];
 
 struct Harness {
@@ -949,3 +953,156 @@ fn m2c_cover_outside_the_page_folder_is_vault_rooted_and_resolves() {
     .unwrap();
     assert_eq!(resolved, json!(["Media/sky.png"]));
 }
+
+/// M3a §8: Global View levels over IPC (camelCase cards; index notes; the
+/// Obsidian attachment folder `assets` is no card; page neighbourhoods).
+#[test]
+fn m3a_gv_children_over_ipc() {
+    let h = harness();
+    let _vault = open_fixture(&h, "obsidian-basic");
+    let level = |body: Value| call(&h.main, "gv_children", json!({ "level": body }));
+    let paths = |v: &Value| -> Vec<String> {
+        v["cards"]
+            .as_array()
+            .unwrap()
+            .iter()
+            .map(|c| c["path"].as_str().unwrap().to_string())
+            .collect()
+    };
+    let root = level(json!({ "kind": "vault" })).unwrap();
+    assert_eq!(
+        paths(&root),
+        ["Character Design", "Game Design", "Welcome.md"]
+    );
+    assert_eq!(root["cards"][0]["kind"], "project");
+    assert_eq!(root["cards"][1]["indexPage"], "Game Design/Game 1.md");
+    assert_eq!(root["cards"][1]["title"], "Game 1");
+    assert_eq!(root["centre"], Value::Null);
+
+    let chars = level(json!({ "kind": "folder", "path": "Character Design" })).unwrap();
+    assert_eq!(
+        paths(&chars),
+        [
+            "Character Design/DMC",
+            "Character Design/My characters.md",
+            "Character Design/rex-draft.md"
+        ]
+    );
+    let dmc = &chars["cards"][0];
+    assert_eq!(dmc["kind"], "folder");
+    assert_eq!(dmc["indexPage"], "Character Design/DMC/Sparda.md");
+    assert_eq!(
+        (dmc["pages"].as_u64(), dmc["folders"].as_u64()),
+        (Some(1), Some(0))
+    );
+    let rex = &chars["cards"][2];
+    assert_eq!(rex["cover"], "Character Design/assets/rex-cover.png");
+    assert_eq!(rex["coverY"], 40);
+    assert_eq!(rex["coverRemote"], false);
+    assert_eq!(rex["subtitle"], "Hero redesign · v3");
+    assert_eq!(rex["hasImage"], true);
+    assert_eq!(rex["hasAudio"], true);
+
+    let page = level(json!({ "kind": "page", "path": "Character Design/rex-draft.md" })).unwrap();
+    assert_eq!(page["centre"], "Character Design/rex-draft.md");
+    let relation = |path: &str| {
+        page["cards"]
+            .as_array()
+            .unwrap()
+            .iter()
+            .find(|c| c["path"] == path)
+            .map(|c| c["relation"].clone())
+    };
+    assert_eq!(
+        relation("Character Design/rex-draft.md"),
+        Some(json!("centre"))
+    );
+    assert_eq!(relation("Game Design/Game 1.md"), Some(json!("both")));
+    assert_eq!(
+        relation("Character Design/My characters.md"),
+        Some(json!("in"))
+    );
+    assert_eq!(
+        relation("Character Design/DMC/Sparda.md"),
+        Some(json!("out"))
+    );
+
+    let missing = level(json!({ "kind": "folder", "path": "Nope" })).unwrap_err();
+    assert_eq!(kind(missing), "notFound");
+    assert!(level(json!({ "kind": "galaxy" })).is_err());
+}
+
+/// M3a §6, §8: aggregated edges between visible cards; at most 1,000 cards.
+#[test]
+fn m3a_gv_edges_over_ipc() {
+    let h = harness();
+    let _vault = open_fixture(&h, "obsidian-basic");
+    let edges = call(
+        &h.main,
+        "gv_edges",
+        json!({ "visible": ["Character Design", "Game Design", "Welcome.md"] }),
+    )
+    .unwrap();
+    let edges = edges.as_array().unwrap();
+    let find = |a: &str, b: &str, kind: &str| {
+        edges
+            .iter()
+            .find(|e| {
+                e["kind"] == kind
+                    && ((e["from"] == a && e["to"] == b) || (e["from"] == b && e["to"] == a))
+            })
+            .cloned()
+            .unwrap_or_else(|| panic!("no {kind} edge {a}–{b} in {edges:?}"))
+    };
+    let links = find("Character Design", "Game Design", "link");
+    assert_eq!(
+        (links["count"].as_u64(), links["aggregated"].as_bool()),
+        (Some(3), Some(true))
+    );
+    let manual = find("Character Design", "Game Design", "manual");
+    assert_eq!(manual["directed"], true);
+    assert_eq!(manual["label"], "playable version");
+    assert_eq!(
+        (manual["from"].as_str(), manual["to"].as_str()),
+        (Some("Character Design"), Some("Game Design"))
+    );
+    find("Character Design", "Welcome.md", "link");
+    assert_eq!(edges.len(), 3, "{edges:?}");
+
+    let too_many: Vec<String> = (0..1001).map(|i| format!("p{i}.md")).collect();
+    let err = call(&h.main, "gv_edges", json!({ "visible": too_many })).unwrap_err();
+    assert_eq!(kind(err), "tooLarge");
+}
+
+/// M3a §7: pinned positions round-trip per level; an empty map removes it.
+#[test]
+fn m3a_layout_get_set_over_ipc() {
+    let h = harness();
+    let vault = open_fixture(&h, "obsidian-basic");
+    assert_eq!(
+        call(&h.main, "layout_get", json!({ "level": "" })).unwrap(),
+        json!({})
+    );
+    assert!(!vault.path().join(".liber").exists(), "VLT-02");
+    call(
+        &h.main,
+        "layout_set",
+        json!({ "level": "", "positions": { "Game Design": { "x": 12.5, "y": -40 } } }),
+    )
+    .unwrap();
+    assert_eq!(
+        call(&h.main, "layout_get", json!({ "level": "" })).unwrap(),
+        json!({ "Game Design": { "x": 12.5, "y": -40.0 } })
+    );
+    assert!(vault.path().join(".liber/layout.json").exists());
+    call(
+        &h.main,
+        "layout_set",
+        json!({ "level": "", "positions": {} }),
+    )
+    .unwrap();
+    assert_eq!(
+        call(&h.main, "layout_get", json!({ "level": "" })).unwrap(),
+        json!({})
+    );
+}
```

Create `apps/desktop/src/ipc/globalView.test.ts`:

```ts
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { gvChildren, gvEdges, layoutGet, layoutSet } from './index';

afterEach(() => clearMocks());

describe('M3a ipc commands', () => {
  it('passes camelCase arguments and returns the typed payloads', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'gv_children') return { cards: [], centre: null };
      if (cmd === 'gv_edges') return [];
      if (cmd === 'layout_get') return { A: { x: 1, y: 2 } };
      return null;
    });
    expect(await gvChildren({ kind: 'vault' })).toEqual({
      ok: true,
      value: { cards: [], centre: null },
    });
    await gvChildren({ kind: 'folder', path: 'A' });
    await gvEdges(['A', 'b.md']);
    expect(await layoutGet('')).toEqual({ ok: true, value: { A: { x: 1, y: 2 } } });
    await layoutSet('page:b.md', { A: { x: 3, y: 4 } });
    expect(calls).toEqual([
      ['gv_children', { level: { kind: 'vault' } }],
      ['gv_children', { level: { kind: 'folder', path: 'A' } }],
      ['gv_edges', { visible: ['A', 'b.md'] }],
      ['layout_get', { level: '' }],
      ['layout_set', { level: 'page:b.md', positions: { A: { x: 3, y: 4 } } }],
    ]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p liber-desktop --test commands m3a && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/ipc/globalView.test.ts`
Expected: three `m3a_*` command tests panic (the commands aren't registered); vitest `TypeError: gvChildren is not a function`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src-tauri/build.rs` (apply this diff):

```diff
@@ -29,6 +29,10 @@ const COMMANDS: &[&str] = &[
     "attachment_import",
     "cover_pick",
     "link_suggest",
+    "gv_children",
+    "gv_edges",
+    "layout_get",
+    "layout_set",
 ];
 
 fn main() {
```

Modify `apps/desktop/src-tauri/capabilities/main.json` (apply this diff):

```diff
@@ -32,6 +32,10 @@
     "allow-attachment-import",
     "allow-cover-pick",
     "allow-link-suggest",
+    "allow-gv-children",
+    "allow-gv-edges",
+    "allow-layout-get",
+    "allow-layout-set",
     "core:event:allow-listen",
     "core:event:allow-unlisten",
     "core:window:allow-destroy",
```

Modify `apps/desktop/src-tauri/src/dto.rs` (apply this diff):

```diff
@@ -164,3 +164,103 @@ pub struct VaultSettingsDto {
 pub struct VaultSettingsPatch {
     pub attachments: Option<AttachmentsDto>,
 }
+
+/// `gv_children`'s argument: which level to open (M3a §3).
+#[derive(Debug, Clone, serde::Deserialize)]
+#[serde(tag = "kind", rename_all = "lowercase")]
+pub enum GvLevelDto {
+    Vault,
+    Folder { path: String },
+    Page { path: String },
+}
+
+/// One Global View card (M3a §4, §8).
+#[derive(Debug, Clone, Serialize)]
+#[serde(rename_all = "camelCase")]
+pub struct GvCardDto {
+    pub path: String,
+    /// `"project" | "folder" | "page"`.
+    pub kind: &'static str,
+    pub title: String,
+    pub subtitle: Option<String>,
+    pub cover: Option<String>,
+    pub cover_remote: bool,
+    pub cover_y: Option<u8>,
+    pub excerpt: String,
+    pub has_image: bool,
+    pub has_audio: bool,
+    pub index_page: Option<String>,
+    pub pages: u32,
+    pub folders: u32,
+    pub child_titles: Vec<String>,
+    /// Page levels: `"centre" | "in" | "out" | "both"`.
+    pub relation: Option<&'static str>,
+}
+
+impl From<liber_session::GvCard> for GvCardDto {
+    fn from(c: liber_session::GvCard) -> GvCardDto {
+        use liber_session::{CardKind, Relation};
+        GvCardDto {
+            path: c.path,
+            kind: match c.kind {
+                CardKind::Project => "project",
+                CardKind::Folder => "folder",
+                CardKind::Page => "page",
+            },
+            title: c.title,
+            subtitle: c.subtitle,
+            cover: c.cover,
+            cover_remote: c.cover_remote,
+            cover_y: c.cover_y,
+            excerpt: c.excerpt,
+            has_image: c.has_image,
+            has_audio: c.has_audio,
+            index_page: c.index_page,
+            pages: c.pages,
+            folders: c.folders,
+            child_titles: c.child_titles,
+            relation: c.relation.map(|r| match r {
+                Relation::Centre => "centre",
+                Relation::In => "in",
+                Relation::Out => "out",
+                Relation::Both => "both",
+            }),
+        }
+    }
+}
+
+#[derive(Debug, Clone, Serialize)]
+pub struct GvLevelResultDto {
+    pub cards: Vec<GvCardDto>,
+    pub centre: Option<String>,
+}
+
+/// One Global View edge (M3a §6).
+#[derive(Debug, Clone, Serialize)]
+pub struct GvEdgeDto {
+    pub from: String,
+    pub to: String,
+    /// `"link" | "manual"`.
+    pub kind: &'static str,
+    pub count: u32,
+    pub aggregated: bool,
+    pub directed: bool,
+    pub label: Option<String>,
+}
+
+impl From<liber_session::GvEdge> for GvEdgeDto {
+    fn from(e: liber_session::GvEdge) -> GvEdgeDto {
+        GvEdgeDto {
+            from: e.from,
+            to: e.to,
+            kind: match e.kind {
+                liber_session::EdgeKind::Link => "link",
+                liber_session::EdgeKind::Manual => "manual",
+            },
+            count: e.count,
+            aggregated: e.aggregated,
+            directed: e.directed,
+            label: e.label,
+        }
+    }
+}
```

Create `apps/desktop/src-tauri/src/gv_commands.rs`:

```rust
//! M3a §8: the Global View — levels and their cards, edges between visible
//! cards, pinned card positions. Thin wrappers over `liber-session`.

use crate::dto::{GvEdgeDto, GvLevelDto, GvLevelResultDto};
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use liber_session::{GvLevel, MAX_VISIBLE};
use liber_vault::{CardPosition, VaultPath};
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager, Runtime};

pub(crate) fn gv_children_impl(state: &AppState, level: GvLevelDto) -> CmdResult<GvLevelResultDto> {
    let session = state.session()?;
    let level = match level {
        GvLevelDto::Vault => GvLevel::Vault,
        GvLevelDto::Folder { path } => GvLevel::Folder(VaultPath::new(&path)?),
        GvLevelDto::Page { path } => GvLevel::Page(VaultPath::new(&path)?),
    };
    let found = session.gv_children(&level)?;
    Ok(GvLevelResultDto {
        cards: found.cards.into_iter().map(Into::into).collect(),
        centre: found.centre,
    })
}

pub(crate) fn gv_edges_impl(state: &AppState, visible: Vec<String>) -> CmdResult<Vec<GvEdgeDto>> {
    if visible.len() > MAX_VISIBLE {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("at most {MAX_VISIBLE} cards at once"),
        ));
    }
    let session = state.session()?;
    Ok(session
        .gv_edges(&visible)?
        .into_iter()
        .map(Into::into)
        .collect())
}

pub(crate) fn layout_get_impl(
    state: &AppState,
    level: String,
) -> CmdResult<BTreeMap<String, CardPosition>> {
    Ok(state.session()?.vault().layout_level(&level))
}

pub(crate) fn layout_set_impl(
    state: &AppState,
    level: String,
    positions: BTreeMap<String, CardPosition>,
) -> CmdResult<()> {
    state
        .session()?
        .vault()
        .set_layout_level(&level, &positions)?;
    Ok(())
}

#[tauri::command]
pub async fn gv_children<R: Runtime>(
    app: AppHandle<R>,
    level: GvLevelDto,
) -> CmdResult<GvLevelResultDto> {
    blocking(app, move |app| {
        gv_children_impl(&app.state::<AppState>(), level)
    })
    .await
}

#[tauri::command]
pub async fn gv_edges<R: Runtime>(
    app: AppHandle<R>,
    visible: Vec<String>,
) -> CmdResult<Vec<GvEdgeDto>> {
    blocking(app, move |app| {
        gv_edges_impl(&app.state::<AppState>(), visible)
    })
    .await
}

#[tauri::command]
pub async fn layout_get<R: Runtime>(
    app: AppHandle<R>,
    level: String,
) -> CmdResult<BTreeMap<String, CardPosition>> {
    blocking(app, move |app| {
        layout_get_impl(&app.state::<AppState>(), level)
    })
    .await
}

#[tauri::command]
pub async fn layout_set<R: Runtime>(
    app: AppHandle<R>,
    level: String,
    positions: BTreeMap<String, CardPosition>,
) -> CmdResult<()> {
    blocking(app, move |app| {
        layout_set_impl(&app.state::<AppState>(), level, positions)
    })
    .await
}
```

Modify `apps/desktop/src-tauri/src/lib.rs` (apply this diff):

```diff
@@ -6,6 +6,7 @@ pub mod dto;
 pub mod editor_commands;
 pub mod error;
 pub mod fonts;
+pub mod gv_commands;
 pub mod menu;
 pub mod navigation;
 pub mod settings;
@@ -107,6 +108,10 @@ pub fn configure<R: tauri::Runtime>(
         attachment_commands::attachment_import,
         attachment_commands::cover_pick,
         attachment_commands::link_suggest,
+        gv_commands::gv_children,
+        gv_commands::gv_edges,
+        gv_commands::layout_get,
+        gv_commands::layout_set,
     ])
 }
```

Modify `apps/desktop/src/ipc/index.ts` (apply this diff):

```diff
@@ -283,6 +283,57 @@ export interface VaultSettingsPatch {
   attachments?: { mode: AttachmentMode; path: string };
 }
 
+/** What one Global View click opens (M3a §3). */
+export type GvLevelRef =
+  { kind: 'vault' } | { kind: 'folder'; path: string } | { kind: 'page'; path: string };
+
+export type GvCardKind = 'project' | 'folder' | 'page';
+export type GvRelation = 'centre' | 'in' | 'out' | 'both';
+
+/** One Global View card (M3a §4). */
+export interface GvCard {
+  path: string;
+  kind: GvCardKind;
+  title: string;
+  subtitle: string | null;
+  /** The cover's vault path (`null`: none, remote or missing). */
+  cover: string | null;
+  coverRemote: boolean;
+  coverY: number | null;
+  excerpt: string;
+  hasImage: boolean;
+  hasAudio: boolean;
+  /** Folders: the page previewed on the card. */
+  indexPage: string | null;
+  pages: number;
+  folders: number;
+  childTitles: string[];
+  /** Page levels: where the card sits around the centre. */
+  relation: GvRelation | null;
+}
+
+export interface GvLevel {
+  cards: GvCard[];
+  /** Page levels: the page itself. */
+  centre: string | null;
+}
+
+/** One edge between visible cards (M3a §6). */
+export interface GvEdge {
+  from: string;
+  to: string;
+  kind: 'link' | 'manual';
+  count: number;
+  aggregated: boolean;
+  directed: boolean;
+  label: string | null;
+}
+
+export interface CardPosition {
+  x: number;
+  y: number;
+}
+
 // ---- commands ----
 
 const call = <T>(cmd: string, args?: Record<string, unknown>) =>
@@ -334,6 +385,12 @@ export const attachmentImport = (page: string, paths: string[]) =>
 export const coverPick = (page: string) => call<CoverPick | null>('cover_pick', { page });
 export const linkSuggest = (source: string, query: string, embed: boolean) =>
   call<LinkSuggestion[]>('link_suggest', { source, query, embed });
+export const gvChildren = (level: GvLevelRef) => call<GvLevel>('gv_children', { level });
+export const gvEdges = (visible: string[]) => call<GvEdge[]>('gv_edges', { visible });
+export const layoutGet = (level: string) =>
+  call<Record<string, CardPosition>>('layout_get', { level });
+export const layoutSet = (level: string, positions: Record<string, CardPosition>) =>
+  call<void>('layout_set', { level, positions });
 export const vaultSettingsGet = () => call<VaultSettings>('vault_settings_get');
 export const vaultSettingsSet = (patch: VaultSettingsPatch) =>
   call<VaultSettings>('vault_settings_set', { patch });
```


- [ ] **Step 4: Generated files**

The four `apps/desktop/src-tauri/permissions/autogenerated/*.toml` files are written by `tauri-build` from `build.rs` `COMMANDS` on the next `cargo build` / `cargo test`. Commit them.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cargo test -p liber-desktop --test commands && cargo clippy -p liber-desktop --all-targets -- -D warnings && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/ipc`
Expected: `29 passed; 0 failed` (including `m1b_every_command_is_allowed_from_main_and_denied_elsewhere` with the four new commands); vitest `Tests 14 passed`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/build.rs apps/desktop/src-tauri/capabilities/main.json apps/desktop/src-tauri/permissions/autogenerated/gv_children.toml apps/desktop/src-tauri/permissions/autogenerated/gv_edges.toml apps/desktop/src-tauri/permissions/autogenerated/layout_get.toml apps/desktop/src-tauri/permissions/autogenerated/layout_set.toml apps/desktop/src-tauri/src/dto.rs apps/desktop/src-tauri/src/gv_commands.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tests/commands.rs apps/desktop/src/ipc/globalView.test.ts apps/desktop/src/ipc/index.ts
git commit -m "$(cat <<'EOF'
feat(commands): Global View levels, edges and layout over IPC (M3a §8)

gv_children (vault | folder | page level), gv_edges (at most 1,000
visible cards, else tooLarge), layout_get / layout_set; each async via
blocking(), allowed from main only (real-ACL tests), with typed TS
wrappers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Shell: switch between the editor and the Global View

**Commits in the test run:** `7fec851`

**Files:**
- Modify: `apps/desktop/src-tauri/src/menu.rs`
- Modify: `apps/desktop/src-tauri/tests/menu.rs` (test)
- Create: `apps/desktop/src/features/global-view/GlobalView.module.css`
- Create: `apps/desktop/src/features/global-view/GlobalView.tsx`
- Modify: `apps/desktop/src/features/shell/AppShell.test.tsx` (test)
- Modify: `apps/desktop/src/features/shell/AppShell.tsx`
- Modify: `apps/desktop/src/features/shell/Shell.module.css`
- Modify: `apps/desktop/src/features/shell/TopBar.tsx`
- Modify: `apps/desktop/src/features/shell/useGlobalShortcuts.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/ipc/index.ts`
- Modify: `apps/desktop/src/stores/menuToggles.test.ts` (test)
- Modify: `apps/desktop/src/stores/menuToggles.ts`
- Modify: `apps/desktop/src/stores/navigate.test.ts` (test)
- Modify: `apps/desktop/src/stores/navigate.ts`
- Modify: `apps/desktop/src/stores/uiStore.ts`
- Modify: `apps/desktop/src/stores/vaultStore.ts`

**Interfaces:**
- **Produces:**
  - `uiStore.screen: 'edit' | 'global'` and `setScreen`;
  - `menu::EDITOR_ID`, `GLOBAL_VIEW_ID`, `SCREEN_EVENT = "menu:screen"`;
  - `ipc.onMenuScreen`;
  - `installMenuScreen()` (also started by `installMenuTogglesIfTauri`);
  - `features/global-view/GlobalView.tsx`: a placeholder region "Global View", filled from Task 10.
- **Behaviour:**
  - `openPage()` always shows Edit;
  - opening a vault starts on Edit;
  - `shell.globalLater` is removed from both locales.

- [ ] **Step 1: Write the failing tests**

Modify `apps/desktop/src-tauri/tests/menu.rs` (apply this diff):

```diff
@@ -118,6 +118,8 @@ fn macos_menu_quit_is_ours_and_the_standard_items_stay() {
         "Forward",
         "Toggle Formatting Toolbar",
         "Toggle Line Numbers",
+        "Editor",
+        "Global View",
     ] {
         assert!(view.iter().any(|t| t == want), "{want}: {view:?}");
     }
@@ -235,6 +237,39 @@ fn toggle_items_emit_menu_toggle() {
     );
 }
 
+/// M3a §2: View → Editor / Global View tell the page which screen to show.
+fn screen_items_emit_menu_screen() {
+    use tauri::Listener;
+    let got: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
+    let log = got.clone();
+    build_app("screen").run_return(move |handle, event| {
+        if let RunEvent::Ready = event {
+            let log = log.clone();
+            handle.listen("menu:screen", move |e| {
+                log.lock().unwrap().push(e.payload().to_string());
+            });
+            for id in [
+                liber_desktop::menu::EDITOR_ID,
+                liber_desktop::menu::GLOBAL_VIEW_ID,
+            ] {
+                liber_desktop::menu::on_menu_event(
+                    handle,
+                    MenuEvent {
+                        id: MenuId::new(id),
+                    },
+                );
+            }
+            for window in handle.webview_windows().into_values() {
+                window.close().unwrap();
+            }
+        }
+    });
+    assert_eq!(
+        *got.lock().unwrap(),
+        ["\"edit\"".to_string(), "\"global\"".into()]
+    );
+}
+
 fn main() {
     #[cfg(target_os = "macos")]
     {
@@ -247,4 +282,6 @@ fn main() {
     println!("test back_and_forward_items_emit_menu_navigate ... ok");
     toggle_items_emit_menu_toggle();
     println!("test toggle_items_emit_menu_toggle ... ok");
+    screen_items_emit_menu_screen();
+    println!("test screen_items_emit_menu_screen ... ok");
 }
```

Modify `apps/desktop/src/features/shell/AppShell.test.tsx` (apply this diff):

```diff
@@ -1,9 +1,13 @@
+import { undo } from '@codemirror/commands';
+import { EditorView } from '@codemirror/view';
 import { act, render, screen, waitFor } from '@testing-library/react';
 import userEvent from '@testing-library/user-event';
 import axe from 'axe-core';
 import { afterEach, describe, expect, it } from 'vitest';
 import type { TreeNode } from '../../ipc';
 import { clearMocks, mockIPC } from '../../ipc/testing';
+import { fakeDisk } from '../../test/fakeDisk';
+import { openPage } from '../../stores/navigate';
 import { usePageStore } from '../../stores/pageStore';
 import { childrenByParent } from '../../stores/tree';
 import { useUiStore } from '../../stores/uiStore';
@@ -43,6 +47,7 @@ afterEach(async () => {
   await resetVaultStore();
   usePageStore.getState().clear();
   useUiStore.getState().closeDialog();
+  useUiStore.setState({ screen: 'edit' });
   clearMocks();
 });
 
@@ -58,13 +63,56 @@ describe('AppShell', () => {
     expect(screen.getByText('Pick a page in the explorer')).toBeInTheDocument();
   });
 
-  it('has Edit active and Global view disabled with an explanation', () => {
+  it('M3a §2: Edit and Global view switch the screen; the editor stays mounted (undo survives)', async () => {
     seed();
+    fakeDisk(
+      { 'Welcome.md': 'hello\n' },
+      {
+        vault_tree: () => nodes,
+        gv_children: () => ({ cards: [], centre: null }),
+        gv_edges: () => [],
+        layout_get: () => ({}),
+      },
+    );
     render(<AppShell />);
-    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
+    await act(() => openPage('Welcome.md'));
+    const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
+    const before = view();
+    act(() => before.dispatch({ changes: { from: 5, insert: ' world' }, userEvent: 'input.type' }));
+
+    const edit = screen.getByRole('button', { name: 'Edit' });
     const global = screen.getByRole('button', { name: 'Global view' });
-    expect(global).toHaveAttribute('aria-disabled', 'true');
-    expect(global).toHaveAccessibleDescription('Global view arrives in a later milestone.');
+    expect(edit).toHaveAttribute('aria-pressed', 'true');
+    await userEvent.click(global);
+    expect(global).toHaveAttribute('aria-pressed', 'true');
+    expect(edit).toHaveAttribute('aria-pressed', 'false');
+    expect(screen.getByRole('region', { name: 'Global View' })).toBeInTheDocument();
+    expect(screen.queryByRole('region', { name: 'Page' })).not.toBeInTheDocument();
+
+    await userEvent.click(edit);
+    expect(screen.queryByRole('region', { name: 'Global View' })).not.toBeInTheDocument();
+    expect(view()).toBe(before);
+    expect(view().state.doc.toString()).toBe('hello world\n');
+    act(() => {
+      undo(view());
+    });
+    expect(view().state.doc.toString()).toBe('hello\n');
+  });
+
+  it('M3a §2: ⌘1 / ⌘2 (Ctrl elsewhere) switch between Edit and the Global View', async () => {
+    seed();
+    fakeDisk({}, { gv_children: () => ({ cards: [], centre: null }), gv_edges: () => [] });
+    render(<AppShell />);
+    const key = (k: string) =>
+      act(() => {
+        window.dispatchEvent(
+          new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true }),
+        );
+      });
+    await key('2');
+    expect(useUiStore.getState().screen).toBe('global');
+    await key('1');
+    expect(useUiStore.getState().screen).toBe('edit');
   });
 
   it("new page goes into the selected folder (or the selected file's folder)", async () => {
```

Modify `apps/desktop/src/stores/menuToggles.test.ts` (apply this diff):

```diff
@@ -1,6 +1,7 @@
 import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
 import { clearMocks, emit, mockIPC } from '../ipc/testing';
-import { installMenuToggles } from './menuToggles';
+import { installMenuScreen, installMenuToggles } from './menuToggles';
+import { useUiStore } from './uiStore';
 import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';
 
 let patches: Record<string, unknown>[];
@@ -41,3 +42,18 @@ describe('View menu toggles (M2b feedback round)', () => {
     stop();
   });
 });
+
+describe('View → Editor / Global View (M3a §2)', () => {
+  it('switch the screen (menu:screen); an unknown payload is ignored', async () => {
+    useUiStore.setState({ screen: 'edit' });
+    const stop = await installMenuScreen();
+    await emit('menu:screen', 'global');
+    await vi.waitFor(() => expect(useUiStore.getState().screen).toBe('global'));
+    await emit('menu:screen', 'sideways');
+    await new Promise((r) => setTimeout(r, 10));
+    expect(useUiStore.getState().screen).toBe('global');
+    await emit('menu:screen', 'edit');
+    await vi.waitFor(() => expect(useUiStore.getState().screen).toBe('edit'));
+    stop();
+  });
+});
```

Modify `apps/desktop/src/stores/navigate.test.ts` (apply this diff):

```diff
@@ -4,6 +4,7 @@ import { followLink } from './links';
 import { goBack, goForward, installMenuNavigation, openPage } from './navigate';
 import { usePageStore } from './pageStore';
 import { useTrailStore } from './trailStore';
+import { useUiStore } from './uiStore';
 import { resetVaultStore, useVaultStore } from './vaultStore';
 
 const page = (path: string) => ({
@@ -40,6 +41,12 @@ afterEach(async () => {
 const at = () => usePageStore.getState().path;
 
 describe('navigation and the link trail (M2b §3)', () => {
+  it('M3a §2: opening a page from anywhere (Global View, explorer) shows the editor', async () => {
+    useUiStore.setState({ screen: 'global' });
+    await openPage('A.md');
+    expect(useUiStore.getState().screen).toBe('edit');
+  });
+
   it('links add to the trail; direct opens start a fresh one; back/forward walk it', async () => {
     await openPage('A.md');
     await openPage('B.md', null, 'link');
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/shell src/stores && cargo test -p liber-desktop --test menu`
Expected: AppShell `M3a §2: Edit and Global view switch …` fails on `aria-pressed`; `⌘1 / ⌘2 …` fails with `expected 'edit' to be 'global'`; `installMenuScreen is not a function`; navigate `opening a page from anywhere … shows the editor` fails; the menu test does not compile (`cannot find value EDITOR_ID`). (An unrelated AppShell test can fail after the first one aborts with a page open; it passes once the feature exists.)

- [ ] **Step 3: Implement**

Modify `apps/desktop/src-tauri/src/menu.rs` (apply this diff):

```diff
@@ -31,10 +31,17 @@ pub const LINE_NUMBERS_ID: &str = "liber-toggle-line-numbers";
 /// Event telling the page to flip a setting; payload `"toolbar"` or
 /// `"lineNumbers"` (the settings key).
 pub const TOGGLE_EVENT: &str = "menu:toggle";
+/// Ids of View → Editor / Global View (M3a §2).
+pub const EDITOR_ID: &str = "liber-screen-edit";
+pub const GLOBAL_VIEW_ID: &str = "liber-screen-global";
+/// Event telling the page which screen to show; payload `"edit"` or
+/// `"global"`.
+pub const SCREEN_EVENT: &str = "menu:screen";
 
 /// The app menu: About, Services, Hide, Hide Others, Show All, Quit (ours);
 /// Edit (Undo, Redo, Cut, Copy, Paste, Select All: macOS routes the text
-/// editing shortcuts through it); View (Back, Forward along the link trail —
+/// editing shortcuts through it); View (Editor, Global View — no
+/// accelerators: the page handles ⌘1 / ⌘2; Back, Forward along the link trail —
 /// no accelerators: the page handles ⌘[ / ⌘] itself, which also works where
 /// there is no app menu; the formatting toolbar and line-number toggles —
 /// plain items, the page owns the settings; full screen); Window (Minimize,
@@ -89,6 +96,9 @@ pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
     )?;
     let back = MenuItem::with_id(app, BACK_ID, "Back", true, None::<&str>)?;
     let forward = MenuItem::with_id(app, FORWARD_ID, "Forward", true, None::<&str>)?;
+    // No accelerators: the page handles ⌘1 / ⌘2 itself (as ⌘[ / ⌘]).
+    let editor = MenuItem::with_id(app, EDITOR_ID, "Editor", true, None::<&str>)?;
+    let global_view = MenuItem::with_id(app, GLOBAL_VIEW_ID, "Global View", true, None::<&str>)?;
     let toolbar = MenuItem::with_id(
         app,
         TOOLBAR_ID,
@@ -108,6 +118,9 @@ pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
         "View",
         true,
         &[
+            &editor,
+            &global_view,
+            &PredefinedMenuItem::separator(app)?,
             &back,
             &forward,
             &PredefinedMenuItem::separator(app)?,
@@ -148,6 +161,9 @@ pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
     } else if id == BACK_ID || id == FORWARD_ID {
         let direction = if id == BACK_ID { "back" } else { "forward" };
         let _ = app.emit(NAVIGATE_EVENT, direction);
+    } else if id == EDITOR_ID || id == GLOBAL_VIEW_ID {
+        let screen = if id == EDITOR_ID { "edit" } else { "global" };
+        let _ = app.emit(SCREEN_EVENT, screen);
     } else if id == TOOLBAR_ID {
         let _ = app.emit(TOGGLE_EVENT, "toolbar");
     } else if id == LINE_NUMBERS_ID {
```

Create `apps/desktop/src/features/global-view/GlobalView.module.css`:

```css
/* Global View screen (M3a §2). */
.view {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
```

Create `apps/desktop/src/features/global-view/GlobalView.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import styles from './GlobalView.module.css';

/** The Global View screen (M3a): the vault as cards, level by level. */
export function GlobalView() {
  const { t } = useTranslation();
  return <section className={styles.view} aria-label={t('gv.region')} />;
}
```

Modify `apps/desktop/src/features/shell/AppShell.tsx` (apply this diff):

```diff
@@ -2,7 +2,9 @@ import { useCallback, useState } from 'react';
 import { DialogHost } from '../dialogs/DialogHost';
 import { ContextMenu, type MenuState } from '../explorer/ContextMenu';
 import { requestDelete } from '../explorer/deleteFlow';
+import { GlobalView } from '../global-view/GlobalView';
 import { PageView } from '../page/PageView';
+import { useUiStore } from '../../stores/uiStore';
 import { Sidebar } from './Sidebar';
 import { TopBar } from './TopBar';
 import { useGlobalShortcuts } from './useGlobalShortcuts';
@@ -18,6 +20,7 @@ export function AppShell() {
     if (path) document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
   }, [menu]);
   useGlobalShortcuts(menu !== null);
+  const current = useUiStore((s) => s.screen);
   return (
     <div className={styles.shell}>
       <Sidebar
@@ -27,7 +30,12 @@ export function AppShell() {
       <div className={styles.main}>
         <TopBar />
         <main className={styles.content}>
-          <PageView />
+          {/* The editor stays mounted while the Global View shows, so text,
+              selection and undo survive switching (M3a §2). */}
+          <div className={styles.screen} hidden={current !== 'edit'}>
+            <PageView />
+          </div>
+          {current === 'global' && <GlobalView />}
         </main>
       </div>
       {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
```

Modify `apps/desktop/src/features/shell/Shell.module.css` (apply this diff):

```diff
@@ -183,6 +183,17 @@
   display: flex;
 }
 
+.screen {
+  flex: 1;
+  min-width: 0;
+  min-height: 0;
+  display: flex;
+}
+
+.screen[hidden] {
+  display: none;
+}
+
 .srOnly {
   position: absolute;
   width: 1px;
```

Modify `apps/desktop/src/features/shell/TopBar.tsx` (apply this diff):

```diff
@@ -4,35 +4,38 @@ import { useUiStore } from '../../stores/uiStore';
 import { useVaultStore } from '../../stores/vaultStore';
 import styles from './Shell.module.css';
 
-/** Vault name, the [Edit · Global view] toggle (Global view arrives in M3),
- * settings and close. */
+/** Vault name, the [Edit · Global view] switch (M3a §2), settings and close. */
 export function TopBar() {
   const { t } = useTranslation();
   const name = useVaultStore((s) => s.info?.name ?? '');
   const close = useVaultStore((s) => s.close);
   const openDialog = useUiStore((s) => s.openDialog);
+  const current = useUiStore((s) => s.screen);
+  const setScreen = useUiStore((s) => s.setScreen);
   return (
     <header className={styles.topbar}>
       <span className={styles.vaultName}>{name}</span>
       <div className={styles.toggle} role="group" aria-label={t('shell.view')}>
-        <button type="button" className={`${styles.tg} ${styles.on}`} aria-pressed="true">
+        <button
+          type="button"
+          className={`${styles.tg} ${current === 'edit' ? styles.on : ''}`}
+          aria-pressed={current === 'edit'}
+          aria-keyshortcuts="Meta+1 Control+1"
+          onClick={() => setScreen('edit')}
+        >
           <PencilIcon />
           {t('shell.edit')}
         </button>
         <button
           type="button"
-          className={styles.tg}
-          aria-pressed="false"
-          aria-disabled="true"
-          aria-describedby="global-later"
-          title={t('shell.globalLater')}
+          className={`${styles.tg} ${current === 'global' ? styles.on : ''}`}
+          aria-pressed={current === 'global'}
+          aria-keyshortcuts="Meta+2 Control+2"
+          onClick={() => setScreen('global')}
         >
           <GraphIcon />
           {t('shell.globalView')}
         </button>
-        <span id="global-later" className={styles.srOnly}>
-          {t('shell.globalLater')}
-        </span>
       </div>
       <div className={styles.tright}>
         <button
```

Modify `apps/desktop/src/features/shell/useGlobalShortcuts.ts` (apply this diff):

```diff
@@ -22,9 +22,18 @@ function trailKey(e: KeyboardEvent): 'back' | 'forward' | null {
   return null;
 }
 
+/** ⌘1 Edit, ⌘2 Global View (M3a §2): the digit key, or the physical one
+ *  on layouts where digits need ⇧ (French). */
+function screenKey(e: KeyboardEvent): 'edit' | 'global' | null {
+  if (e.key === '1' || (e.shiftKey && e.code === 'Digit1')) return 'edit';
+  if (e.key === '2' || (e.shiftKey && e.code === 'Digit2')) return 'global';
+  return null;
+}
+
 /** ⌘ (macOS) / Ctrl shortcuts (spec §3.5): ⇧E explorer, O open vault,
  * , settings, N new page, ⇧N new folder, [ / ] back and forward along the
- * link trail (M2b §3). Ignored while a dialog is open. */
+ * link trail (M2b §3), 1 / 2 Edit and Global View (M3a §2). Ignored while a
+ * dialog is open. */
 export function useGlobalShortcuts(menuOpen: boolean) {
   useEffect(() => {
     const onKeyDown = (e: KeyboardEvent) => {
@@ -39,7 +48,10 @@ export function useGlobalShortcuts(menuOpen: boolean) {
       if (e.altKey) return;
       const vault = useVaultStore.getState();
       const key = e.key.toLowerCase();
-      if (key === ',') {
+      const screen = screenKey(e);
+      if (screen) {
+        useUiStore.getState().setScreen(screen);
+      } else if (key === ',') {
         useUiStore.getState().openDialog({ type: 'settings' });
       } else if (key === 'o' && !e.shiftKey) {
         void pickFolder()
```

Modify `apps/desktop/src/i18n/locales/en.json` (apply this diff):

```diff
@@ -80,7 +80,6 @@
     "view": "View",
     "edit": "Edit",
     "globalView": "Global view",
-    "globalLater": "Global view arrives in a later milestone.",
     "settings": "Settings",
     "closeVault": "Close vault"
   },
@@ -277,5 +276,8 @@
     "obsidianSame": "the page’s folder",
     "obsidianSubfolder": "the “{name}” folder next to the page",
     "obsidianFolder": "the “{name}” folder"
+  },
+  "gv": {
+    "region": "Global View"
   }
 }
```

Modify `apps/desktop/src/i18n/locales/es.json` (apply this diff):

```diff
@@ -80,7 +80,6 @@
     "view": "Vista",
     "edit": "Editar",
     "globalView": "Vista global",
-    "globalLater": "La vista global llega en un hito posterior.",
     "settings": "Ajustes",
     "closeVault": "Cerrar bóveda"
   },
@@ -277,5 +276,8 @@
     "obsidianSame": "la carpeta de la página",
     "obsidianSubfolder": "la carpeta «{name}» junto a la página",
     "obsidianFolder": "la carpeta «{name}»"
+  },
+  "gv": {
+    "region": "Vista global"
   }
 }
```

Modify `apps/desktop/src/ipc/index.ts` (apply this diff):

```diff
@@ -417,6 +417,9 @@ export const onMenuNavigate = (cb: (direction: 'back' | 'forward') => void): Pro
  *  the settings key to flip. */
 export const onMenuToggle = (cb: (key: string) => void): Promise<UnlistenFn> =>
   listen<string>('menu:toggle', (e) => cb(e.payload));
+/** View → Editor / Global View in the app menu (M3a §2). */
+export const onMenuScreen = (cb: (screen: string) => void): Promise<UnlistenFn> =>
+  listen<string>('menu:screen', (e) => cb(e.payload));
 export const onVaultWarning = (cb: (p: WarningPayload) => void): Promise<UnlistenFn> =>
   listen<WarningPayload>('vault:warning', (e) => cb(e.payload));
```

Modify `apps/desktop/src/stores/menuToggles.ts` (apply this diff):

```diff
@@ -1,5 +1,6 @@
-import { isTauri, onMenuToggle } from '../ipc';
+import { isTauri, onMenuScreen, onMenuToggle } from '../ipc';
 import { useSettingsStore } from './settingsStore';
+import { useUiStore } from './uiStore';
 
 /** Follows View → Toggle Formatting Toolbar / Toggle Line Numbers from the
  *  app menu; returns the unsubscribe. */
@@ -11,6 +12,15 @@ export async function installMenuToggles(): Promise<() => void> {
   });
 }
 
+/** Follows View → Editor / Global View (M3a §2); returns the unsubscribe. */
+export async function installMenuScreen(): Promise<() => void> {
+  return onMenuScreen((screen) => {
+    if (screen === 'edit' || screen === 'global') useUiStore.getState().setScreen(screen);
+  });
+}
+
 export function installMenuTogglesIfTauri(): void {
-  if (isTauri()) void installMenuToggles().catch(() => undefined);
+  if (!isTauri()) return;
+  void installMenuToggles().catch(() => undefined);
+  void installMenuScreen().catch(() => undefined);
 }
```

Modify `apps/desktop/src/stores/navigate.ts` (apply this diff):

```diff
@@ -1,6 +1,7 @@
 import { isTauri, onMenuNavigate } from '../ipc';
 import { usePageStore } from './pageStore';
 import { useTrailStore, type TrailEntry } from './trailStore';
+import { useUiStore } from './uiStore';
 import { parentOf } from './tree';
 import { useVaultStore } from './vaultStore';
 
@@ -30,6 +31,8 @@ export async function openPage(
   } else if (via === 'direct') {
     trail.reset();
   }
+  // Wherever it was opened from (Global View, explorer), the page is shown.
+  useUiStore.getState().setScreen('edit');
   const vault = useVaultStore.getState();
   const dir = parentOf(path);
   if (dir) vault.expand(dir);
```

Modify `apps/desktop/src/stores/uiStore.ts` (apply this diff):

```diff
@@ -10,14 +10,21 @@ export type DialogState =
   | { type: 'openFile'; path: string }
   | null;
 
+/** Which screen the open vault shows (M3a §2). */
+export type Screen = 'edit' | 'global';
+
 interface UiState {
   dialog: DialogState;
+  screen: Screen;
+  setScreen: (screen: Screen) => void;
   openDialog: (d: Exclude<DialogState, null>) => void;
   closeDialog: () => void;
 }
 
 export const useUiStore = create<UiState>((set) => ({
   dialog: null,
+  screen: 'edit',
+  setScreen: (screen) => set({ screen }),
   openDialog: (dialog) => set({ dialog }),
   closeDialog: () => set({ dialog: null }),
 }));
```

Modify `apps/desktop/src/stores/vaultStore.ts` (apply this diff):

```diff
@@ -25,6 +25,7 @@ import { errorMessage } from './messages';
 import { usePageStore } from './pageStore';
 import { useToastStore } from './toastStore';
 import { useTrailStore } from './trailStore';
+import { useUiStore } from './uiStore';
 import { childrenByParent, joinPath, nextFreeName, parentOf, remap } from './tree';
 
 /** External changes arriving within this window trigger one tree refresh. */
@@ -184,6 +185,7 @@ export const useVaultStore = create<VaultState>((set, get) => {
       return res;
     }
     set({ info: res.value, selected: null, expanded: new Set(), renaming: null });
+    useUiStore.getState().setScreen('edit');
     useTrailStore.getState().reset();
     usePageStore.getState().clear();
     useEditorStore.getState().reset();
```


- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/shell src/stores src/i18n && cargo test -p liber-desktop --test menu`
Expected: all pass; the menu prints 5 `… ok` checks including `screen_items_emit_menu_screen`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/menu.rs apps/desktop/src-tauri/tests/menu.rs apps/desktop/src/features/global-view/GlobalView.module.css apps/desktop/src/features/global-view/GlobalView.tsx apps/desktop/src/features/shell/AppShell.test.tsx apps/desktop/src/features/shell/AppShell.tsx apps/desktop/src/features/shell/Shell.module.css apps/desktop/src/features/shell/TopBar.tsx apps/desktop/src/features/shell/useGlobalShortcuts.ts apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json apps/desktop/src/ipc/index.ts apps/desktop/src/stores/menuToggles.test.ts apps/desktop/src/stores/menuToggles.ts apps/desktop/src/stores/navigate.test.ts apps/desktop/src/stores/navigate.ts apps/desktop/src/stores/uiStore.ts apps/desktop/src/stores/vaultStore.ts
git commit -m "$(cat <<'EOF'
feat(shell): switch between the editor and the Global View (M3a §2)

The top bar's Edit · Global view group is a real switch (aria-pressed),
also on ⌘1 / ⌘2 (Ctrl elsewhere; the physical digit where digits need
⇧) and View → Editor / Global View (menu:screen, no accelerators). The
editor stays mounted, hidden, while the Global View shows, so text,
selection and undo survive switching; opening a page from anywhere shows
the editor; opening a vault starts on Edit.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Notes from the test run:** No ⌘ symbols appear in tooltips: there is no precedent in the app, and ⌘ is wrong on Windows and Linux. The buttons carry `aria-keyshortcuts="Meta+1 Control+1"` instead.

---

### Task 7: Pure layouts: grid, columns, neighbourhood, pins, arrow keys

**Commits in the test run:** `3a5e848`

**Files:**
- Create: `apps/desktop/src/features/global-view/layout.test.ts` (test)
- Create: `apps/desktop/src/features/global-view/layout.ts`

**Interfaces:**
- **Produces (`layout.ts`):**
  - constants `CARD_W = 240`, `CARD_H = 300`, `CELL_W = 300`, `CELL_H = 370`, `COL_W = 310`, `ROW_H = 340`, `ORIGIN = 48`;
  - `XY`;
  - `gridLayout(paths, width)`;
  - `columnsLayout(roots, children: Map)`;
  - `neighbourhoodLayout(cards)`;
  - `withPinned(auto, pinned)`;
  - `Direction`, `nearestInDirection(from, at, dir)`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/features/global-view/layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CARD_H,
  CARD_W,
  columnsLayout,
  gridLayout,
  nearestInDirection,
  neighbourhoodLayout,
  withPinned,
  type XY,
} from './layout';

const obj = (m: Map<string, XY>) => Object.fromEntries(m);

describe('Global View layouts (M3a §7)', () => {
  it('grid: cells of 300 × 370 from (48, 48), as many columns as fit', () => {
    const cards = ['a', 'b', 'c', 'd', 'e'];
    expect(obj(gridLayout(cards, 1220))).toEqual({
      a: { x: 48, y: 48 },
      b: { x: 348, y: 48 },
      c: { x: 648, y: 48 },
      d: { x: 948, y: 48 },
      e: { x: 48, y: 418 },
    });
    expect(gridLayout(cards, 700).get('c'), 'two columns').toEqual({ x: 48, y: 418 });
    expect(gridLayout(cards, 100).get('b'), 'at least one').toEqual({ x: 48, y: 418 });
  });

  it('columns: children right of their parent, the parent level with its first child', () => {
    const children = new Map([
      ['A', ['A/1', 'A/2']],
      ['A/2', ['A/2/x']],
    ]);
    expect(obj(columnsLayout(['A', 'B'], children))).toEqual({
      A: { x: 48, y: 48 },
      'A/1': { x: 358, y: 48 },
      'A/2': { x: 358, y: 388 },
      'A/2/x': { x: 668, y: 388 },
      B: { x: 48, y: 728 },
    });
    expect(columnsLayout(['A'], new Map([['A', []]])).get('A')).toEqual({ x: 48, y: 48 });
  });

  it('neighbourhood: backlinks left, the page centred, links out right', () => {
    const at = neighbourhoodLayout([
      { path: 'p', relation: 'centre' },
      { path: 'in1', relation: 'in' },
      { path: 'out1', relation: 'out' },
      { path: 'both', relation: 'both' },
      { path: 'out2', relation: 'out' },
    ]);
    expect(obj(at)).toEqual({
      in1: { x: 48, y: 388 },
      p: { x: 358, y: 388 },
      out1: { x: 668, y: 48 },
      both: { x: 668, y: 388 },
      out2: { x: 668, y: 728 },
    });
    expect(obj(neighbourhoodLayout([{ path: 'p', relation: 'centre' }]))).toEqual({
      p: { x: 358, y: 48 },
    });
  });

  it('pinned positions override the layout, only for cards on the canvas', () => {
    const auto = new Map([
      ['a', { x: 48, y: 48 }],
      ['b', { x: 348, y: 48 }],
    ]);
    expect(obj(withPinned(auto, { b: { x: 5, y: 6 }, gone: { x: 1, y: 1 } }))).toEqual({
      a: { x: 48, y: 48 },
      b: { x: 5, y: 6 },
    });
  });

  it('GV-18 arrow keys: the nearest card in that direction, by card centres', () => {
    const at = new Map<string, XY>([
      ['c', { x: 300, y: 300 }],
      ['right', { x: 620, y: 320 }],
      ['farRight', { x: 950, y: 300 }],
      ['upRight', { x: 600, y: -100 }],
      ['down', { x: 280, y: 680 }],
      ['left', { x: 0, y: 290 }],
    ]);
    expect(nearestInDirection('c', at, 'right')).toBe('right');
    expect(nearestInDirection('c', at, 'down')).toBe('down');
    expect(nearestInDirection('c', at, 'left')).toBe('left');
    expect(nearestInDirection('c', at, 'up'), 'off-axis is still above').toBe('upRight');
    expect(nearestInDirection('left', at, 'left')).toBeNull();
    expect(nearestInDirection('missing', at, 'left')).toBeNull();
    expect(CARD_W).toBe(240);
    expect(CARD_H).toBe(300);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/global-view/layout.test.ts`
Expected: `Failed to resolve import "./layout"`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/features/global-view/layout.ts`:

```ts
// Global View layouts (M3a §7): deterministic placements taken from the
// prototype (`design/prototype/Main.dc.html`), plus pinned overrides and the
// arrow-key geometry (GV-18). Pure functions.
import type { GvRelation } from '../../ipc';

export const CARD_W = 240;
export const CARD_H = 300;
/** Grid cells (drill-down vault and folder levels). */
export const CELL_W = 300;
export const CELL_H = 370;
/** Columns (Expand, neighbourhoods). */
export const COL_W = 310;
export const ROW_H = 340;
export const ORIGIN = 48;

export interface XY {
  x: number;
  y: number;
}

/** Rows of as many 300-px columns as fit `width` (at least one). */
export function gridLayout(paths: string[], width: number): Map<string, XY> {
  const cols = Math.max(1, Math.floor((width - ORIGIN - CARD_W) / CELL_W) + 1);
  return new Map(
    paths.map((p, i) => [
      p,
      { x: ORIGIN + (i % cols) * CELL_W, y: ORIGIN + Math.floor(i / cols) * CELL_H },
    ]),
  );
}

/** Expand in place: each expansion fills the column right of its card, rows
 *  in depth-first order; a card with children sits level with the first. */
export function columnsLayout(roots: string[], children: Map<string, string[]>): Map<string, XY> {
  const out = new Map<string, XY>();
  let row = 0;
  const place = (path: string, depth: number) => {
    const x = ORIGIN + depth * COL_W;
    const kids = children.get(path) ?? [];
    if (!kids.length) {
      out.set(path, { x, y: ORIGIN + row * ROW_H });
      row++;
      return;
    }
    out.set(path, { x, y: ORIGIN + row * ROW_H });
    for (const kid of kids) place(kid, depth + 1);
  };
  for (const root of roots) place(root, 0);
  return out;
}

/** A page level: backlinks left, the page in the middle, links out (and
 *  both ways) right; each column centred on the page. */
export function neighbourhoodLayout(
  cards: { path: string; relation: GvRelation | null }[],
): Map<string, XY> {
  const left = cards.filter((c) => c.relation === 'in');
  const right = cards.filter((c) => c.relation === 'out' || c.relation === 'both');
  const centre = cards.find((c) => c.relation === 'centre');
  const rows = Math.max(left.length, right.length, 1);
  const top = (n: number) => ORIGIN + ((rows - n) * ROW_H) / 2;
  const out = new Map<string, XY>();
  left.forEach((c, i) => out.set(c.path, { x: ORIGIN, y: top(left.length) + i * ROW_H }));
  if (centre) out.set(centre.path, { x: ORIGIN + COL_W, y: top(1) });
  right.forEach((c, i) =>
    out.set(c.path, { x: ORIGIN + 2 * COL_W, y: top(right.length) + i * ROW_H }),
  );
  return out;
}

/** `auto` with the pinned positions of cards that are on the canvas. */
export function withPinned(auto: Map<string, XY>, pinned: Record<string, XY>): Map<string, XY> {
  const out = new Map(auto);
  for (const [path, at] of Object.entries(pinned)) if (out.has(path)) out.set(path, at);
  return out;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** The card an arrow key moves to: the nearest one whose centre lies that way,
 *  preferring cards within 45° of the arrow (GV-18). */
export function nearestInDirection(
  from: string,
  at: Map<string, XY>,
  dir: Direction,
): string | null {
  const here = at.get(from);
  if (!here) return null;
  let best: { path: string; score: number } | null = null;
  for (const [path, p] of at) {
    if (path === from) continue;
    const dx = p.x - here.x;
    const dy = p.y - here.y;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    const score = along + across * 2 + (across > along ? 10_000 : 0);
    if (!best || score < best.score) best = { path, score };
  }
  return best?.path ?? null;
}
```


- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/global-view/layout.test.ts && pnpm --filter @liber/desktop typecheck`
Expected: `Tests 5 passed (5)`; tsc clean. Vitest's `toBe` / `toEqual` take one argument: a message goes in `expect(value, message)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/global-view/layout.test.ts apps/desktop/src/features/global-view/layout.ts
git commit -m "$(cat <<'EOF'
feat(global-view): grid, column and neighbourhood layouts (M3a §7)

Deterministic placements from the prototype — a grid for vault and
folder levels, columns for Expand in place, backlinks / page / links out
for a page level — pinned positions on top, and the arrow-key geometry
(nearest card that way, within 45° first; GV-18). Pure functions.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: gvStore: drill stack, expansions, loading, pins

**Commits in the test run:** `7c1e57d`

**Files:**
- Create: `apps/desktop/src/features/global-view/gvStore.test.ts` (test)
- Create: `apps/desktop/src/features/global-view/gvStore.ts`
- Modify: `apps/desktop/src/stores/stores.test.ts` (test)
- Modify: `apps/desktop/src/stores/vaultStore.ts`

**Interfaces:**
- **Consumes:** Task 5's wrappers; `useSettingsStore` (`globalViewMode`).
- **Produces (`gvStore.ts`):**
  - `levelKey(ref)`, `nextLevel(card)`, `canvasKey(mode, root)`;
  - `Canvas { cards, roots, children, centre }`;
  - `buildCanvas(mode, root, expanded, levels)`;
  - `PIN_SAVE_MS = 300`;
  - `useGvStore` with `stack`, `expanded`, `levels`, `canvas`, `edges`, `pinned`, `focus`, `loaded`, and `load / open / back / up / modeChanged / pin / resetLayout / setFocus / reset`.
- **vaultStore:** `open` and `close` call `useGvStore.getState().reset()`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/features/global-view/gvStore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GvCard, GvLevel, GvLevelRef } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { buildCanvas, canvasKey, levelKey, useGvStore } from './gvStore';

/** A card with defaults; folders get a `kind` of project/folder. */
function card(path: string, kind: GvCard['kind'] = 'page', extra: Partial<GvCard> = {}): GvCard {
  return {
    path,
    kind,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
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

/** The levels of a small vault: projects A and B, A/Sub, pages linking. */
const LEVELS: Record<string, GvLevel> = {
  '': { cards: [card('A', 'project'), card('B', 'project'), card('root.md')], centre: null },
  A: { cards: [card('A/Sub', 'folder'), card('A/a.md'), card('A/b.md')], centre: null },
  'A/Sub': { cards: [card('A/Sub/deep.md')], centre: null },
  B: { cards: [card('B/q.md')], centre: null },
  'page:A/a.md': {
    cards: [
      card('A/a.md', 'page', { relation: 'centre' }),
      card('B/q.md', 'page', { relation: 'out' }),
      card('root.md', 'page', { relation: 'in' }),
    ],
    centre: 'A/a.md',
  },
};

let calls: [string, Record<string, unknown>][];
let levels: Record<string, GvLevel>;

beforeEach(() => {
  calls = [];
  levels = { ...LEVELS };
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useGvStore.getState().reset();
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push([cmd, args]);
    if (cmd === 'gv_children') {
      const key = levelKey(args.level as GvLevelRef);
      const found = levels[key];
      if (!found) throw { kind: 'notFound', message: key };
      return found;
    }
    if (cmd === 'gv_edges') return [];
    if (cmd === 'layout_get') return {};
    return null;
  });
});

afterEach(() => {
  vi.useRealTimers();
  clearMocks();
});

const paths = () => useGvStore.getState().canvas.cards.map((c) => c.path);
const mode = (m: 'drill' | 'expand') =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, globalViewMode: m } });

describe('Global View store (M3a §5)', () => {
  it('drill-down: a click opens the next level; the breadcrumb goes back', async () => {
    const gv = useGvStore.getState();
    await gv.load();
    expect(paths()).toEqual(['A', 'B', 'root.md']);
    await gv.open(card('A', 'project'));
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }, { kind: 'folder', path: 'A' }]);
    expect(paths()).toEqual(['A/Sub', 'A/a.md', 'A/b.md']);
    await useGvStore.getState().open(card('A/a.md'));
    expect(paths()).toEqual(['A/a.md', 'B/q.md', 'root.md']);
    expect(useGvStore.getState().canvas.centre).toBe('A/a.md');
    // Edges are asked for exactly what is on the canvas.
    expect(calls.filter(([c]) => c === 'gv_edges').at(-1)?.[1]).toEqual({
      visible: ['A/a.md', 'B/q.md', 'root.md'],
    });
    await useGvStore.getState().back(0);
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }]);
    expect(paths()).toEqual(['A', 'B', 'root.md']);
  });

  it('expand in place: children join beside the card, no duplicates; a second click collapses', async () => {
    mode('expand');
    const gv = useGvStore.getState();
    await gv.load();
    await gv.open(card('A', 'project'));
    expect(paths()).toEqual(['A', 'B', 'root.md', 'A/Sub', 'A/a.md', 'A/b.md']);
    await useGvStore.getState().open(card('A/Sub', 'folder'));
    // a.md's neighbourhood: root.md is already on the canvas, B/q.md isn't
    // (only its folder card B is).
    await useGvStore.getState().open(card('A/a.md'));
    const canvas = useGvStore.getState().canvas;
    expect(canvas.cards.map((c) => c.path)).toEqual([
      'A',
      'B',
      'root.md',
      'A/Sub',
      'A/a.md',
      'A/b.md',
      'A/Sub/deep.md',
      'B/q.md',
    ]);
    expect(canvas.children.get('A')).toEqual(['A/Sub', 'A/a.md', 'A/b.md']);
    expect(canvas.children.get('A/Sub')).toEqual(['A/Sub/deep.md']);
    expect(canvas.children.get('A/a.md')).toEqual(['B/q.md']);
    expect(useGvStore.getState().stack, 'the root level stays').toEqual([{ kind: 'vault' }]);
    // Collapsing A takes everything expanded from it.
    await useGvStore.getState().open(card('A', 'project'));
    expect(paths()).toEqual(['A', 'B', 'root.md']);
    expect(useGvStore.getState().expanded).toEqual([]);
  });

  it('a level that no longer exists falls back to the nearest one that does', async () => {
    const gv = useGvStore.getState();
    await gv.load();
    await gv.open(card('A', 'project'));
    await useGvStore.getState().open(card('A/Sub', 'folder'));
    delete levels['A/Sub'];
    await useGvStore.getState().load();
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }, { kind: 'folder', path: 'A' }]);
    expect(paths()).toEqual(['A/Sub', 'A/a.md', 'A/b.md']);
  });

  it('GV-31: dragged positions are saved per canvas (debounced, only cards on it); reset clears them', async () => {
    vi.useFakeTimers();
    const gv = useGvStore.getState();
    await gv.load();
    useGvStore.setState({ pinned: { gone: { x: 0, y: 0 } } });
    gv.pin('A', { x: 10, y: 20 });
    gv.pin('B', { x: 30, y: 40 });
    expect(calls.some(([c]) => c === 'layout_set')).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.filter(([c]) => c === 'layout_set')).toEqual([
      ['layout_set', { level: '', positions: { A: { x: 10, y: 20 }, B: { x: 30, y: 40 } } }],
    ]);
    await useGvStore.getState().resetLayout();
    expect(calls.at(-1)).toEqual(['layout_set', { level: '', positions: {} }]);
    expect(useGvStore.getState().pinned).toEqual({});
  });

  it('a slower, older load never overwrites a newer one', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    mockIPC(async (cmd, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      if (cmd === 'gv_children') {
        const key = levelKey(args.level as GvLevelRef);
        if (key === '') await held;
        return levels[key];
      }
      if (cmd === 'gv_edges') return [];
      if (cmd === 'layout_get') return {};
      return null;
    });
    const first = useGvStore.getState().load();
    useGvStore.setState({ stack: [{ kind: 'vault' }, { kind: 'folder', path: 'B' }] });
    await useGvStore.getState().load();
    release();
    await first;
    expect(paths()).toEqual(['B/q.md']);
  });
});

describe('canvas helpers', () => {
  it('canvas keys follow the arch §3.1 level keys', () => {
    expect(levelKey({ kind: 'vault' })).toBe('');
    expect(levelKey({ kind: 'folder', path: 'A' })).toBe('A');
    expect(levelKey({ kind: 'page', path: 'A/a.md' })).toBe('page:A/a.md');
    expect(canvasKey('drill', { kind: 'folder', path: 'A' })).toBe('A');
    expect(canvasKey('expand', { kind: 'vault' })).toBe('expand:');
  });

  it('buildCanvas without the expanded level loaded shows just the root', () => {
    const canvas = buildCanvas('expand', { kind: 'vault' }, [{ kind: 'folder', path: 'A' }], {
      '': LEVELS[''],
    });
    expect(canvas.cards.map((c) => c.path)).toEqual(['A', 'B', 'root.md']);
  });
});
```

Modify `apps/desktop/src/stores/stores.test.ts` (apply this diff):

```diff
@@ -4,6 +4,7 @@ import type { TreeNode } from '../ipc';
 import { clearMocks, emit, mockIPC } from '../ipc/testing';
 import { usePageStore } from './pageStore';
 import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';
+import { useGvStore } from '../features/global-view/gvStore';
 import { useTrailStore } from './trailStore';
 import { useToastStore } from './toastStore';
 import { resetVaultStore, useVaultStore } from './vaultStore';
@@ -192,6 +193,16 @@ describe('vaultStore', () => {
     expect(useTrailStore.getState().back.map((x) => x.path)).toEqual(['A.md']);
   });
 
+  it('M3a: opening or closing a vault starts the Global View over at level 0', async () => {
+    backend({ vault_open: () => info, vault_tree: () => [], vault_close: () => null });
+    useGvStore.setState({ stack: [{ kind: 'vault' }, { kind: 'folder', path: 'Old' }] });
+    await useVaultStore.getState().open('/v');
+    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }]);
+    useGvStore.setState({ stack: [{ kind: 'vault' }, { kind: 'folder', path: 'Old' }] });
+    await useVaultStore.getState().close();
+    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }]);
+  });
+
   it('VLT-01 open: closed → opening → open, with tree loaded', async () => {
     const gate = deferred<typeof info>();
     backend({ vault_open: () => gate.promise, vault_tree: () => tree });
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/global-view/gvStore.test.ts src/stores/stores.test.ts`
Expected: `Failed to resolve import "./gvStore"`; once it exists, the stores test `opening or closing a vault starts the Global View over` fails with `expected [ { kind: 'vault' }, …(1) ] to deeply equal [ { kind: 'vault' } ]`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/features/global-view/gvStore.ts`:

```ts
// Global View state (M3a §5, §7): the drill-down stack (breadcrumb), the
// cards expanded in place, the loaded levels, edges and pinned positions.
import { create } from 'zustand';
import {
  gvChildren,
  gvEdges,
  layoutGet,
  layoutSet,
  type CardPosition,
  type GlobalViewMode,
  type GvCard,
  type GvEdge,
  type GvLevel,
  type GvLevelRef,
} from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';

/** Saving a dragged card waits this long for the next drag (M3a §7). */
export const PIN_SAVE_MS = 300;

/** Arch §3.1 level keys: `""` vault, a folder path, `page:<path>`. */
export const levelKey = (ref: GvLevelRef): string =>
  ref.kind === 'vault' ? '' : ref.kind === 'folder' ? ref.path : `page:${ref.path}`;

/** The level a card's single click opens. */
export const nextLevel = (card: GvCard): GvLevelRef =>
  card.kind === 'page' ? { kind: 'page', path: card.path } : { kind: 'folder', path: card.path };

/** The layout key of what the canvas shows. */
export const canvasKey = (mode: GlobalViewMode, root: GvLevelRef): string =>
  mode === 'expand' ? `expand:${levelKey(root)}` : levelKey(root);

/** What the canvas shows, derived from the loaded levels. */
export interface Canvas {
  /** Every card on the canvas, once. */
  cards: GvCard[];
  /** The root level's cards, in order. */
  roots: string[];
  /** Expand in place: the cards each expanded card added. */
  children: Map<string, string[]>;
  /** A page level's page (Drill-down). */
  centre: string | null;
}

const EMPTY_CANVAS: Canvas = { cards: [], roots: [], children: new Map(), centre: null };

export function buildCanvas(
  mode: GlobalViewMode,
  root: GvLevelRef,
  expanded: GvLevelRef[],
  levels: Record<string, GvLevel>,
): Canvas {
  const base = levels[levelKey(root)];
  if (!base) return EMPTY_CANVAS;
  const cards = [...base.cards];
  const roots = cards.map((c) => c.path);
  const children = new Map<string, string[]>();
  if (mode === 'drill') return { cards, roots, children, centre: base.centre };
  const shown = new Set(roots);
  for (const ref of expanded) {
    if (ref.kind === 'vault' || !shown.has(ref.path)) continue;
    const level = levels[levelKey(ref)];
    if (!level) continue;
    const added = level.cards.filter((c) => c.path !== ref.path && !shown.has(c.path));
    for (const c of added) shown.add(c.path);
    cards.push(...added);
    children.set(
      ref.path,
      added.map((c) => c.path),
    );
  }
  return { cards, roots, children, centre: null };
}

interface GvState {
  /** Drill-down levels opened, vault first (the breadcrumb); its last entry
   *  is also the root of an Expand canvas. */
  stack: GvLevelRef[];
  /** Expand in place: the cards expanded, in the order they were opened. */
  expanded: GvLevelRef[];
  levels: Record<string, GvLevel>;
  canvas: Canvas;
  edges: GvEdge[];
  /** Pinned positions of the current canvas. */
  pinned: Record<string, CardPosition>;
  /** The card with keyboard focus (roving tabindex). */
  focus: string | null;
  loaded: boolean;
  /** Reads what the canvas shows: levels (falling back from deleted ones),
   *  edges and pinned positions. */
  load: () => Promise<void>;
  /** A single click: the next level (Drill-down) or expand / collapse. */
  open: (card: GvCard) => Promise<void>;
  /** Breadcrumb: back to `stack[i]`. */
  back: (i: number) => Promise<void>;
  /** Escape (M3a §5): one level up, or collapse `path` in Expand. */
  up: (path: string | null) => Promise<void>;
  /** The mode changed: keep the root level, forget expansions. */
  modeChanged: () => Promise<void>;
  pin: (path: string, at: CardPosition) => void;
  resetLayout: () => Promise<void>;
  setFocus: (path: string | null) => void;
  reset: () => void;
}

const mode = (): GlobalViewMode => useSettingsStore.getState().settings.globalViewMode;
let seq = 0;
let pinTimer: ReturnType<typeof setTimeout> | null = null;

export const useGvStore = create<GvState>((set, get) => {
  /** Cards `path` added, and theirs, recursively (Expand). */
  function subtree(path: string): Set<string> {
    const out = new Set<string>();
    const walk = (p: string) => {
      for (const kid of get().canvas.children.get(p) ?? []) {
        if (!out.has(kid)) {
          out.add(kid);
          walk(kid);
        }
      }
    };
    walk(path);
    return out;
  }

  function savePins() {
    pinTimer = null;
    const { stack, canvas, pinned } = get();
    const shown = new Set(canvas.cards.map((c) => c.path));
    // Entries for cards no longer on the canvas are pruned here (M3a §7).
    const kept = Object.fromEntries(Object.entries(pinned).filter(([p]) => shown.has(p)));
    void layoutSet(canvasKey(mode(), stack[stack.length - 1]), kept);
  }

  return {
    stack: [{ kind: 'vault' }],
    expanded: [],
    levels: {},
    canvas: EMPTY_CANVAS,
    edges: [],
    pinned: {},
    focus: null,
    loaded: false,
    load: async () => {
      const mine = ++seq;
      const m = mode();
      let stack = get().stack;
      let expanded = m === 'expand' ? get().expanded : [];
      const levels: Record<string, GvLevel> = {};
      // The root level, or the nearest one above it that still exists.
      while (stack.length) {
        const root = stack[stack.length - 1];
        const res = await gvChildren(root);
        if (mine !== seq) return;
        if (res.ok) {
          levels[levelKey(root)] = res.value;
          break;
        }
        stack = stack.length > 1 ? stack.slice(0, -1) : [{ kind: 'vault' }];
        expanded = [];
        if (root.kind === 'vault') return; // no vault open
      }
      const results = await Promise.all(expanded.map((ref) => gvChildren(ref)));
      if (mine !== seq) return;
      expanded = expanded.filter((ref, i) => {
        const res = results[i];
        if (res.ok) levels[levelKey(ref)] = res.value;
        return res.ok;
      });
      const root = stack[stack.length - 1];
      const canvas = buildCanvas(m, root, expanded, levels);
      const [edges, pinned] = await Promise.all([
        gvEdges(canvas.cards.map((c) => c.path)),
        layoutGet(canvasKey(m, root)),
      ]);
      if (mine !== seq) return;
      const shown = new Set(canvas.cards.map((c) => c.path));
      const focus = get().focus;
      set({
        stack,
        expanded,
        levels,
        canvas,
        edges: edges.ok ? edges.value : [],
        pinned: pinned.ok ? pinned.value : {},
        focus: focus && shown.has(focus) ? focus : null,
        loaded: true,
      });
    },
    open: async (card) => {
      if (mode() === 'drill') {
        set({ stack: [...get().stack, nextLevel(card)], focus: null });
        return get().load();
      }
      const expanded = get().expanded;
      if (expanded.some((r) => r.kind !== 'vault' && r.path === card.path)) {
        const gone = subtree(card.path);
        gone.add(card.path);
        set({ expanded: expanded.filter((r) => r.kind === 'vault' || !gone.has(r.path)) });
      } else {
        set({ expanded: [...expanded, nextLevel(card)] });
      }
      return get().load();
    },
    back: async (i) => {
      set({ stack: get().stack.slice(0, Math.max(1, i + 1)), expanded: [], focus: null });
      return get().load();
    },
    up: async (path) => {
      if (mode() === 'expand') {
        const ref = get().expanded.find((r) => r.kind !== 'vault' && r.path === path);
        const card = get().canvas.cards.find((c) => c.path === path);
        if (ref && card) return get().open(card);
        return;
      }
      if (get().stack.length > 1) return get().back(get().stack.length - 2);
    },
    modeChanged: async () => {
      set({ expanded: [], focus: null });
      return get().load();
    },
    pin: (path, at) => {
      set({ pinned: { ...get().pinned, [path]: at } });
      if (pinTimer) clearTimeout(pinTimer);
      pinTimer = setTimeout(savePins, PIN_SAVE_MS);
    },
    resetLayout: async () => {
      if (pinTimer) clearTimeout(pinTimer);
      pinTimer = null;
      set({ pinned: {} });
      const { stack } = get();
      await layoutSet(canvasKey(mode(), stack[stack.length - 1]), {});
    },
    setFocus: (focus) => set({ focus }),
    reset: () => {
      seq++;
      if (pinTimer) clearTimeout(pinTimer);
      pinTimer = null;
      set({
        stack: [{ kind: 'vault' }],
        expanded: [],
        levels: {},
        canvas: EMPTY_CANVAS,
        edges: [],
        pinned: {},
        focus: null,
        loaded: false,
      });
    },
  };
});
```

Modify `apps/desktop/src/stores/vaultStore.ts` (apply this diff):

```diff
@@ -25,6 +25,7 @@ import { errorMessage } from './messages';
 import { usePageStore } from './pageStore';
 import { useToastStore } from './toastStore';
 import { useTrailStore } from './trailStore';
+import { useGvStore } from '../features/global-view/gvStore';
 import { useUiStore } from './uiStore';
 import { childrenByParent, joinPath, nextFreeName, parentOf, remap } from './tree';
 
@@ -186,6 +187,7 @@ export const useVaultStore = create<VaultState>((set, get) => {
     }
     set({ info: res.value, selected: null, expanded: new Set(), renaming: null });
     useUiStore.getState().setScreen('edit');
+    useGvStore.getState().reset();
     useTrailStore.getState().reset();
     usePageStore.getState().clear();
     useEditorStore.getState().reset();
@@ -238,6 +240,7 @@ export const useVaultStore = create<VaultState>((set, get) => {
       useEditorStore.getState().reset();
       stopListening();
       await vaultClose();
+      useGvStore.getState().reset();
       useTrailStore.getState().reset();
       usePageStore.getState().clear();
       treeSeq++;
```


- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/stores src/features/global-view`
Expected: all pass (`gvStore.test.ts` 7).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/global-view/gvStore.test.ts apps/desktop/src/features/global-view/gvStore.ts apps/desktop/src/stores/stores.test.ts apps/desktop/src/stores/vaultStore.ts
git commit -m "$(cat <<'EOF'
feat(global-view): levels, drill stack, expansions and pins in one store (M3a §5, §7)

Drill-down pushes the next level (breadcrumb back); Expand in place adds
a card's level beside it without duplicating cards already shown and a
second click collapses everything expanded from it. Loading falls back
from levels that no longer exist, never lets an older load win, asks for
edges between exactly the cards shown and reads the canvas's pinned
positions; dragged positions save after 300 ms, pruned to cards on the
canvas. A vault opening or closing starts over at level 0.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Notes from the test run:** In Expand, `B/q.md` is not on the canvas when only its folder card `B` is shown, so expanding `A/a.md` adds it. `root.md`, already shown, is not added again.

---

### Task 9: Cards and their colours

**Commits in the test run:** `eaee779`

**Files:**
- Modify: `apps/desktop/src/app/icons.tsx`
- Create: `apps/desktop/src/features/global-view/Card.module.css`
- Create: `apps/desktop/src/features/global-view/Card.test.tsx` (test)
- Create: `apps/desktop/src/features/global-view/Card.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/theme/paletteCss.ts`
- Modify: `apps/desktop/src/theme/palettes.css` (generated — see the step)
- Modify: `apps/desktop/src/theme/palettes.test.ts` (test)
- Modify: `apps/desktop/src/theme/tokens.css`

**Interfaces:**
- **Produces:**
  - `Card({ card, open, focusable, connections, onOpen, onOpenEditor, onFocus })`;
  - `SINGLE_CLICK_MS = 240`;
  - icons `GripIcon`, `ImageIcon`, `AudioIcon`;
  - tokens `--color-canvas`, `--color-card-border`, `--color-edge-link`, `--color-edge-tree`, `--color-edge-manual` in `paletteVars` (every palette and custom accent) and in `tokens.css`;
  - `MANUAL_EDGE`;
  - the `gv.*` card strings (ICU plurals).
- **Behaviour:**
  - each card's focusable surface is `[role=button][data-gv-card=<path>]`;
  - its move handle carries the `.gv-grip` class.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/features/global-view/Card.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GvCard } from '../../ipc';
import { Card, SINGLE_CLICK_MS } from './Card';

function card(extra: Partial<GvCard> = {}): GvCard {
  return {
    path: 'Character Design/rex-draft.md',
    kind: 'page',
    title: 'Generator Rex',
    subtitle: 'Hero redesign · v3',
    cover: 'Character Design/assets/rex-cover.png',
    coverRemote: false,
    coverY: 40,
    excerpt: 'Teen agent who builds machines.',
    hasImage: true,
    hasAudio: true,
    indexPage: null,
    pages: 0,
    folders: 0,
    childTitles: [],
    relation: null,
    ...extra,
  };
}

function show(c: GvCard, handlers: Partial<Record<'onOpen' | 'onOpenEditor', () => void>> = {}) {
  const onOpen = handlers.onOpen ?? vi.fn();
  const onOpenEditor = handlers.onOpenEditor ?? vi.fn();
  const view = render(
    <Card
      card={c}
      open={false}
      focusable
      connections="Links to 2 cards, linked from 1."
      onOpen={onOpen}
      onOpenEditor={onOpenEditor}
      onFocus={() => undefined}
    />,
  );
  return { ...view, onOpen, onOpenEditor };
}

afterEach(() => vi.useRealTimers());

describe('Global View card (M3a §4)', () => {
  it('a page: kind, cover at its position, text, media icons and a description', () => {
    show(card());
    expect(screen.getByRole('group', { name: 'Generator Rex, page' })).toBeInTheDocument();
    expect(screen.getByText('Page')).toBeInTheDocument();
    const img = document.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(
      'liber-asset://localhost/Character%20Design/assets/rex-cover.png',
    );
    expect(img.style.objectPosition).toBe('50% 40%');
    expect(img.getAttribute('alt')).toBe('');
    const open = screen.getByRole('button', { name: 'Generator Rex' });
    expect(open).toHaveAccessibleDescription(
      'Hero redesign · v3 Teen agent who builds machines. Links to 2 cards, linked from 1.',
    );
    expect(screen.getByRole('img', { name: 'Has images' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Has audio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See all: Generator Rex' })).toHaveTextContent(
      'See all',
    );
  });

  it('GV-02: a folder without an index note summarises its children', () => {
    show(
      card({
        path: 'Delta',
        kind: 'project',
        title: 'Delta',
        subtitle: 'Delta',
        cover: null,
        coverY: null,
        excerpt: 'Inner · X title · y',
        hasImage: false,
        hasAudio: false,
        pages: 2,
        folders: 1,
      }),
    );
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('2 pages · 1 folder')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Has images' })).not.toBeInTheDocument();
  });

  it('GV-03: a folder previewing its index note says so in its kind label', () => {
    show(
      card({
        path: 'Character Design/DMC',
        kind: 'folder',
        indexPage: 'Character Design/DMC/Sparda.md',
      }),
    );
    expect(screen.getByText('Folder · DMC')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Generator Rex, folder' })).toBeInTheDocument();
  });

  it('placeholders: no cover, and a remote cover that is never loaded', () => {
    const { unmount } = show(card({ cover: null }));
    expect(screen.getByText('No cover')).toBeInTheDocument();
    unmount();
    show(card({ cover: null, coverRemote: true }));
    expect(screen.getByText('Remote cover not loaded')).toBeInTheDocument();
  });

  it('GV-11/12/18: a click opens the next level after a pause, a double click the editor; Enter / Shift+Enter', async () => {
    vi.useFakeTimers();
    const { onOpen, onOpenEditor } = show(card());
    const open = screen.getByRole('button', { name: 'Generator Rex' });
    fireEvent.click(open);
    expect(onOpen).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(SINGLE_CLICK_MS));
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(open);
    fireEvent.click(open);
    fireEvent.doubleClick(open);
    await act(() => vi.advanceTimersByTimeAsync(SINGLE_CLICK_MS * 2));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpenEditor).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(open, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(open, { key: 'Enter', shiftKey: true });
    expect(onOpenEditor).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'See all: Generator Rex' }));
    expect(onOpenEditor).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('NFR-10: no axe violations (contrast: palettes.test.ts, jsdom has no CSS)', async () => {
    const { container } = show(card());
    await userEvent.setup().tab();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
```

Modify `apps/desktop/src/theme/palettes.test.ts` (apply this diff):

```diff
@@ -40,6 +40,51 @@ describe('built-in palettes (M2b §4, §10)', () => {
   );
 });
 
+/** Global View colours (M3a §4, §6): plain hex, and every edge kind stands
+ *  out from the canvas (WCAG 1.4.11 non-text contrast, 3:1). */
+const GV_TOKENS = [
+  '--color-canvas',
+  '--color-card-border',
+  '--color-edge-link',
+  '--color-edge-tree',
+  '--color-edge-manual',
+] as const;
+
+function expectReadableGlobalView(vars: Record<string, string>, at: string) {
+  for (const key of GV_TOKENS) expect(vars[key], `${at} ${key}`).toMatch(/^#[0-9a-f]{6}$/);
+  for (const edge of ['--color-edge-link', '--color-edge-tree', '--color-edge-manual']) {
+    expect(
+      contrast(vars[edge], vars['--color-canvas']),
+      `${at} ${edge} on canvas`,
+    ).toBeGreaterThanOrEqual(3);
+  }
+  expect(
+    contrast(vars['--color-accent'], vars['--color-surface']),
+    `${at} card title`,
+  ).toBeGreaterThanOrEqual(4.5);
+}
+
+describe('Global View tokens (M3a §4, §6)', () => {
+  it.each(PALETTES.flatMap((p) => (['light', 'dark'] as const).map((m) => [p.id, m] as const)))(
+    '%s %s: canvas, card border and edges',
+    (id, mode) => {
+      expectReadableGlobalView(
+        paletteVars(
+          PALETTES.find((p) => p.id === id)!,
+          mode,
+        ),
+        `${id} ${mode}`,
+      );
+    },
+  );
+
+  it('the default tokens (before settings load) define them too, in both modes', () => {
+    for (const key of GV_TOKENS) {
+      expect(tokensCss.split(`${key}:`).length - 1, key).toBe(3);
+    }
+  });
+});
+
 describe('palette CSS', () => {
   it('maps every token and derives the in-between shades as plain hex (Safari 15)', () => {
     const vars = paletteVars(PALETTES[1], 'light');
@@ -122,6 +167,7 @@ describe('custom accent → palette (M2b §4, derive.ts)', () => {
       expect(contrast(t.accent, t.soft), `${at} accent on accent-soft`).toBeGreaterThanOrEqual(4.5);
       expect(contrast(t.contrast, t.accent), `${at} text on accent`).toBeGreaterThanOrEqual(4.5);
       expect(contrast(t.text, t.bg), `${at} text on background`).toBeGreaterThanOrEqual(7);
+      expectReadableGlobalView(paletteVars({ id: 'custom', ...p }, mode), `${hex} ${mode}`);
     }
     for (const v of Object.values(p.light).concat(Object.values(p.dark))) {
       expect(v).toMatch(/^(#[0-9a-f]{6}|rgba\(.*\))$/);
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/theme/palettes.test.ts src/features/global-view/Card.test.tsx`
Expected: `Global View tokens` fail for every palette (`lavender light: canvas, card border and edges` …); `Failed to resolve import "./Card"`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/app/icons.tsx` (apply this diff):

```diff
@@ -133,3 +133,35 @@ export function NewPageIcon() {
     </svg>
   );
 }
+
+/** Global View card handle (drag to move). */
+export function GripIcon() {
+  return (
+    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
+      <circle cx="9" cy="6" r="1.6" />
+      <circle cx="15" cy="6" r="1.6" />
+      <circle cx="9" cy="12" r="1.6" />
+      <circle cx="15" cy="12" r="1.6" />
+      <circle cx="9" cy="18" r="1.6" />
+      <circle cx="15" cy="18" r="1.6" />
+    </svg>
+  );
+}
+
+export function ImageIcon() {
+  return (
+    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
+      <rect x="3" y="4" width="18" height="16" rx="2" />
+      <circle cx="9" cy="10" r="2" />
+      <path d="M21 17l-5-5-9 8" />
+    </svg>
+  );
+}
+
+export function AudioIcon() {
+  return (
+    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
+      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
+    </svg>
+  );
+}
```

Create `apps/desktop/src/features/global-view/Card.module.css`:

```css
/* Global View card (M3a §4): prototype `.card` (Main.dc.html lines 64-79)
   as theme tokens. 240 × 300 px. */
.card {
  box-sizing: border-box;
  width: 240px;
  height: 300px;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.card[data-open] {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-accent);
}

.head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 36px;
  padding: 2px 4px 2px 12px;
  border-bottom: 1px solid var(--color-border);
}

.kind {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 600 10.5px var(--font-body);
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.grip {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: grab;
}

.grip:hover {
  background: var(--color-accent-soft);
}

.hit {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  cursor: pointer;
  outline: none;
}

.hit:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: -2px;
}

.cover {
  flex: 0 0 96px;
  display: grid;
  place-items: center;
  overflow: hidden;
}

.coverNone {
  background: var(--color-surface-subtle);
  border-bottom: 1px dashed var(--color-border-strong);
}

.coverFolder {
  background: var(--color-accent-soft);
}

.image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.none {
  font: 500 11px var(--font-mono);
  color: var(--color-text-muted);
}

.summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 600 12px var(--font-body);
  color: var(--color-accent);
}

.title {
  margin: 0;
  padding: 10px 12px 2px;
  font: 700 19px/1.15 var(--font-display);
  color: var(--color-accent);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.subtitle {
  margin: 0;
  padding: 0 12px;
  font: 500 12px var(--font-body);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.excerpt {
  margin: 0;
  padding: 6px 12px 0;
  font: 400 12px/1.45 var(--font-body);
  color: var(--color-text-body);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  color: var(--color-text-muted);
}

.media {
  display: inline-grid;
  place-items: center;
}

.seeAll {
  margin-left: auto;
  min-height: 32px;
  padding: 6px 14px;
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-pill);
  background: var(--color-surface);
  color: var(--color-accent);
  font: 600 12px var(--font-body);
  cursor: pointer;
}

.seeAll:hover {
  background: var(--color-accent);
  color: var(--color-accent-contrast);
}

.seeAll:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

.srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
```

Create `apps/desktop/src/features/global-view/Card.tsx`:

```tsx
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AudioIcon, FolderIcon, GripIcon, ImageIcon } from '../../app/icons';
import { assetUrl, type GvCard } from '../../ipc';
import { nameOf } from '../../stores/tree';
import styles from './Card.module.css';

/** A single click waits this long for a second one (prototype; M3a §5), so
 *  a double click never also opens the next level. */
export const SINGLE_CLICK_MS = 240;

export interface CardProps {
  card: GvCard;
  /** Accent ring: the card this level was opened from, or an expanded card. */
  open: boolean;
  /** Roving tabindex (GV-18): only one card is in the Tab order. */
  focusable: boolean;
  /** Its edges in plain words, for screen readers (M3a §6). */
  connections: string;
  /** Single click / Enter: the next level (GV-11). */
  onOpen: () => void;
  /** Double click / Shift+Enter / See all: the editor (GV-12). */
  onOpenEditor: () => void;
  onFocus: () => void;
}

/** One Global View card (M3a §4, prototype `.card`). */
export function Card({
  card,
  open,
  focusable,
  connections,
  onOpen,
  onOpenEditor,
  onFocus,
}: CardProps) {
  const { t } = useTranslation();
  const descId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const kind = t(`gv.kind.${card.kind}`);
  const label =
    card.kind !== 'page' && card.indexPage
      ? t('gv.kindWithName', { kind, name: nameOf(card.path) })
      : kind;
  const summary = card.kind !== 'page' && !card.indexPage;

  const click = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onOpen();
    }, SINGLE_CLICK_MS);
  };
  const doubleClick = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    onOpenEditor();
  };
  const keyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (e.shiftKey) onOpenEditor();
      else onOpen();
    }
  };

  let cover;
  if (card.cover) {
    cover = (
      <img
        className={styles.image}
        src={assetUrl(card.cover)}
        alt=""
        loading="lazy"
        draggable={false}
        style={{ objectPosition: `50% ${card.coverY ?? 50}%` }}
      />
    );
  } else if (summary) {
    cover = (
      <span className={styles.summary}>
        <FolderIcon />
        {t('gv.counts', { pages: card.pages, folders: card.folders })}
      </span>
    );
  } else {
    cover = (
      <span className={styles.none}>{t(card.coverRemote ? 'gv.remoteCover' : 'gv.noCover')}</span>
    );
  }

  return (
    <div
      className={styles.card}
      data-open={open || undefined}
      role="group"
      aria-label={t('gv.cardName', { title: card.title, kind: kind.toLocaleLowerCase() })}
    >
      <div className={styles.head}>
        <span className={styles.kind}>{label}</span>
        <span className={`${styles.grip} gv-grip`} title={t('gv.move')} aria-hidden="true">
          <GripIcon />
        </span>
      </div>
      <div
        className={styles.hit}
        role="button"
        tabIndex={focusable ? 0 : -1}
        aria-label={card.title}
        aria-describedby={descId}
        data-gv-card={card.path}
        onClick={click}
        onDoubleClick={doubleClick}
        onKeyDown={keyDown}
        onFocus={onFocus}
      >
        <div
          className={`${styles.cover} ${card.cover ? '' : summary ? styles.coverFolder : styles.coverNone}`}
        >
          {cover}
        </div>
        <p className={styles.title}>{card.title}</p>
        {card.subtitle && <p className={styles.subtitle}>{card.subtitle}</p>}
        {card.excerpt && <p className={styles.excerpt}>{card.excerpt}</p>}
        <span id={descId} className={styles.srOnly}>
          {[card.subtitle, card.excerpt, connections].filter(Boolean).join(' ')}
        </span>
      </div>
      <div className={styles.foot}>
        {card.hasImage && (
          <span role="img" aria-label={t('gv.hasImage')} className={styles.media}>
            <ImageIcon />
          </span>
        )}
        {card.hasAudio && (
          <span role="img" aria-label={t('gv.hasAudio')} className={styles.media}>
            <AudioIcon />
          </span>
        )}
        <button
          type="button"
          className={styles.seeAll}
          tabIndex={focusable ? 0 : -1}
          aria-label={t('gv.seeAllLabel', { title: card.title })}
          onClick={onOpenEditor}
        >
          {t('gv.seeAll')}
        </button>
      </div>
    </div>
  );
}
```

Modify `apps/desktop/src/i18n/locales/en.json` (apply this diff):

```diff
@@ -278,6 +278,22 @@
     "obsidianFolder": "the “{name}” folder"
   },
   "gv": {
-    "region": "Global View"
+    "region": "Global View",
+    "vault": "Vault",
+    "kind": {
+      "project": "Project",
+      "folder": "Folder",
+      "page": "Page"
+    },
+    "kindWithName": "{kind} · {name}",
+    "cardName": "{title}, {kind}",
+    "noCover": "No cover",
+    "remoteCover": "Remote cover not loaded",
+    "counts": "{pages, plural, one {# page} other {# pages}} · {folders, plural, one {# folder} other {# folders}}",
+    "hasImage": "Has images",
+    "hasAudio": "Has audio",
+    "seeAll": "See all",
+    "seeAllLabel": "See all: {title}",
+    "move": "Move card"
   }
 }
```

Modify `apps/desktop/src/i18n/locales/es.json` (apply this diff):

```diff
@@ -278,6 +278,22 @@
     "obsidianFolder": "la carpeta «{name}»"
   },
   "gv": {
-    "region": "Vista global"
+    "region": "Vista global",
+    "vault": "Bóveda",
+    "kind": {
+      "project": "Proyecto",
+      "folder": "Carpeta",
+      "page": "Página"
+    },
+    "kindWithName": "{kind} · {name}",
+    "cardName": "{title}, {kind}",
+    "noCover": "Sin portada",
+    "remoteCover": "Portada remota no cargada",
+    "counts": "{pages, plural, one {# página} other {# páginas}} · {folders, plural, one {# carpeta} other {# carpetas}}",
+    "hasImage": "Tiene imágenes",
+    "hasAudio": "Tiene audio",
+    "seeAll": "Ver todo",
+    "seeAllLabel": "Ver todo: {title}",
+    "move": "Mover tarjeta"
   }
 }
```

Modify `apps/desktop/src/theme/paletteCss.ts` (apply this diff):

```diff
@@ -32,9 +32,20 @@ export function paletteVars(p: Palette, mode: 'light' | 'dark'): Record<string,
     '--color-drop-ring': p.dark.accent,
     '--color-highlight-bg': t.mark,
     '--color-code-bg': t.code,
+    // Global View (M3a §4, §6): the canvas sits between page and card;
+    // relationships are orange in every palette and drawn wider than links,
+    // so the kinds differ by more than colour.
+    '--color-canvas': mix(t.bg, t.surface, 0.35),
+    '--color-card-border': mix(t.border, t.text, 0.05),
+    '--color-edge-link': t.accent,
+    '--color-edge-tree': t.muted,
+    '--color-edge-manual': mode === 'light' ? MANUAL_EDGE.light : MANUAL_EDGE.dark,
   };
 }
 
+/** Manual-relationship edges (prototype `#c2571a`, kept readable on every canvas). */
+export const MANUAL_EDGE = { light: '#b4501a', dark: '#e8935a' } as const;
+
 const block = (selector: string, vars: Record<string, string>, indent = '') =>
   `${indent}${selector} {\n${Object.entries(vars)
     .map(([k, v]) => `${indent}  ${k}: ${v};`)
```

Modify `apps/desktop/src/theme/tokens.css` (apply this diff):

```diff
@@ -24,6 +24,12 @@
   --color-sidebar-selected: rgba(185, 162, 230, 0.22);
   --color-highlight-bg: #fbf1c7;
   --color-code-bg: #efe9f6;
+  /* Global View (M3a): lavender values; palettes.css derives them per palette. */
+  --color-canvas: #f8f5fa;
+  --color-card-border: #dcd3e5;
+  --color-edge-link: #4b2f86;
+  --color-edge-tree: #6b5f80;
+  --color-edge-manual: #b4501a;
   --color-warn-bg: #fff1e3;
   --color-warn-border: #efc49c;
   --color-warn-text: #7a330b;
@@ -85,6 +91,11 @@
     --color-focus: #cbb8ef;
     --color-highlight-bg: #4a3f12;
     --color-code-bg: #2a2533;
+    --color-canvas: #1a181f;
+    --color-card-border: #3b3646;
+    --color-edge-link: #b9a2e6;
+    --color-edge-tree: #a59cb5;
+    --color-edge-manual: #e8935a;
     --palette-red: #ff9d92;
     --palette-red-bg: #4a1f1c;
     --palette-orange: #ffb877;
@@ -129,6 +140,11 @@
   --color-focus: #cbb8ef;
   --color-highlight-bg: #4a3f12;
   --color-code-bg: #2a2533;
+  --color-canvas: #1a181f;
+  --color-card-border: #3b3646;
+  --color-edge-link: #b9a2e6;
+  --color-edge-tree: #a59cb5;
+  --color-edge-manual: #e8935a;
   --palette-red: #ff9d92;
   --palette-red-bg: #4a1f1c;
   --palette-orange: #ffb877;
```


- [ ] **Step 4: Generated files**

`pnpm --filter @liber/desktop gen:palettes` rewrites `src/theme/palettes.css` from `palettes.ts` + `paletteCss.ts`. Never format that file with prettier from `apps/desktop`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/theme src/features/global-view src/i18n && pnpm --filter @liber/desktop typecheck && pnpm --filter @liber/desktop check:i18n`
Expected: `Tests 117 passed`; tsc clean; `i18n OK: 2 locales in parity.`

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/app/icons.tsx apps/desktop/src/features/global-view/Card.module.css apps/desktop/src/features/global-view/Card.test.tsx apps/desktop/src/features/global-view/Card.tsx apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json apps/desktop/src/theme/paletteCss.ts apps/desktop/src/theme/palettes.css apps/desktop/src/theme/palettes.test.ts apps/desktop/src/theme/tokens.css
git commit -m "$(cat <<'EOF'
feat(global-view): cards and their colours (M3a §4)

The prototype's 240 × 300 card as theme tokens: kind label ("Folder ·
DMC" for a folder previewing its index note), cover at its cover-y, "No
cover" / "Remote cover not loaded" / folder summary placeholders,
title, subtitle, excerpt, media icons and See all. One button-like
surface per card (roving tabindex) described by its text and edges; a
click waits 240 ms for a double click; Enter / Shift+Enter. New tokens
(canvas, card border, three edge colours) derived for every palette and
custom accent, edges ≥ 3:1 on the canvas.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Notes from the test run:** `derive()` returns `{ light, dark }` without an `id`, so pass `{ id: 'custom', ...p }` to `paletteVars`.

---

### Task 10: Canvas: React Flow, edges, toolbar, keyboard (+ freeze-safe build)

**Commits in the test run:** `3122946`

**Files:**
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/scripts/freezeSafe.ts`
- Create: `apps/desktop/src/features/global-view/Canvas.tsx`
- Modify: `apps/desktop/src/features/global-view/GlobalView.module.css`
- Create: `apps/desktop/src/features/global-view/GlobalView.test.tsx` (test)
- Modify: `apps/desktop/src/features/global-view/GlobalView.tsx`
- Create: `apps/desktop/src/features/global-view/Toolbar.tsx`
- Create: `apps/desktop/src/features/global-view/edges.test.ts` (test)
- Create: `apps/desktop/src/features/global-view/edges.tsx`
- Modify: `apps/desktop/src/features/global-view/gvStore.test.ts` (test)
- Modify: `apps/desktop/src/features/global-view/gvStore.ts`
- Modify: `apps/desktop/src/features/shell/AppShell.test.tsx` (test)
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Create: `apps/desktop/src/test/reactFlow.ts` (test)
- Create: `apps/desktop/tests/freezeSafe.test.ts` (test)
- Modify: `apps/desktop/vite.config.ts`
- Modify: `pnpm-lock.yaml` (generated — see the step)

**Interfaces:**
- **Consumes:** Tasks 6–9.
- **Produces:**
  - `GlobalView` (screen);
  - `Canvas({ mode, toggles, width, onOpen, onOpenEditor })` (Task 12 removes a `canvasKey` prop);
  - `Toolbar`;
  - `edges.tsx` with `GvFlowEdgeView`, `exitPoint(box, to)`, `strokeOf(kind, aggregated)`;
  - `REFRESH_MS = 150`;
  - `src/test/reactFlow.ts` `installReactFlowStubs()` (jsdom);
  - `scripts/freezeSafe.ts` `freezeSafe()` (Vite plugin);
  - the `gv.*` toolbar strings.
- **gvStore:** an edge or layout read that fails, or returns nothing, means "none".

- [ ] **Step 1: Add the dependency (pinned)**

```bash
pnpm --filter @liber/desktop add @xyflow/react   # the release-age gate picks 12.12.0 (2026-09-24)
# then pin it exactly in apps/desktop/package.json: "@xyflow/react": "12.12.0"
pnpm install
```
Expected: `+19` packages, including `@xyflow/system@0.0.83` and `zustand@4.5.7` (React Flow's own); the lockfile specifier is `12.12.0`.

- [ ] **Step 2: Write the failing tests**

Create `apps/desktop/src/features/global-view/GlobalView.test.tsx`:

```tsx
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GvCard, GvLevel, GvLevelRef } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { installReactFlowStubs } from '../../test/reactFlow';
import { GlobalView } from './GlobalView';
import { levelKey, useGvStore } from './gvStore';

beforeAll(installReactFlowStubs);

function card(path: string, kind: GvCard['kind'] = 'page', extra: Partial<GvCard> = {}): GvCard {
  return {
    path,
    kind,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
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
  '': { cards: [card('A', 'project'), card('B', 'project'), card('root.md')], centre: null },
  A: { cards: [card('A/a.md'), card('A/b.md')], centre: null },
  B: { cards: [], centre: null },
};

let calls: [string, Record<string, unknown>][];

beforeEach(() => {
  calls = [];
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useGvStore.getState().reset();
  useUiStore.setState({ screen: 'global' });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push([cmd, args]);
    switch (cmd) {
      case 'gv_children': {
        const found = LEVELS[levelKey(args.level as GvLevelRef)];
        if (!found) throw { kind: 'notFound', message: 'x' };
        return found;
      }
      case 'gv_edges':
        return [];
      case 'layout_get':
        return {};
      case 'settings_set':
        return { ...useSettingsStore.getState().settings, ...(args.patch as object) };
      case 'page_get':
        return {
          path: args.path,
          title: 'a',
          subtitle: null,
          cover: null,
          coverY: null,
          tags: [],
          links: 0,
          backlinks: 0,
          text: '',
          truncated: false,
          binary: false,
        };
      case 'page_read':
        return { text: '', hash: 'h' };
      default:
        return null;
    }
  });
});

afterEach(() => {
  usePageStore.getState().clear();
  clearMocks();
});

const cardButton = (name: string) => screen.findByRole('button', { name });

describe('Global View screen (M3a §5, §6)', () => {
  it('GV-10/14: level 0 shows the projects and root pages; a click drills in, the breadcrumb goes back', async () => {
    render(<GlobalView />);
    const nav = screen.getByRole('navigation', { name: 'Global View path' });
    await cardButton('A');
    expect(within(nav).getByText('Vault')).toHaveAttribute('aria-current', 'page');
    await userEvent.click(await cardButton('A'));
    await cardButton('a');
    expect(within(nav).getByRole('button', { name: 'Vault' })).toBeInTheDocument();
    expect(within(nav).getByText('A')).toHaveAttribute('aria-current', 'page');
    await userEvent.click(within(nav).getByRole('button', { name: 'Vault' }));
    await cardButton('root');
  });

  it('GV-12: a double click opens the page in the editor', async () => {
    render(<GlobalView />);
    await userEvent.dblClick(await cardButton('root'));
    await waitFor(() => expect(usePageStore.getState().path).toBe('root.md'));
    expect(useUiStore.getState().screen).toBe('edit');
  });

  it('GV-18: arrow keys move between cards, Enter opens, Escape goes back up', async () => {
    render(<GlobalView />);
    const a = await cardButton('A');
    act(() => a.focus());
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(await cardButton('B'));
    expect(screen.getByRole('button', { name: 'B' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'A' })).toHaveAttribute('tabindex', '-1');
    await userEvent.keyboard('{ArrowLeft}{Enter}');
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('a')));
    await userEvent.keyboard('{Escape}');
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('A')));
  });

  it('GV-13/21/32: mode, edge toggles and Reset layout', async () => {
    render(<GlobalView />);
    await cardButton('A');
    const drill = screen.getByRole('button', { name: 'Drill-down' });
    expect(drill).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Expand in place' }));
    expect(calls).toContainEqual(['settings_set', { patch: { globalViewMode: 'expand' } }]);
    await userEvent.click(screen.getByRole('button', { name: 'Parent / child' }));
    expect(calls).toContainEqual([
      'settings_set',
      { patch: { globalViewEdges: { links: true, tree: false, manual: true, aggregated: true } } },
    ]);
    expect(screen.getByRole('button', { name: 'Parent / child' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reset layout' }));
    expect(calls).toContainEqual(['layout_set', { level: 'expand:', positions: {} }]);
  });

  it('an empty folder says so', async () => {
    render(<GlobalView />);
    await userEvent.click(await cardButton('B'));
    expect(await screen.findByText('Empty folder.')).toBeInTheDocument();
  });

  it('NFR-10: no axe violations', async () => {
    const { container } = render(<GlobalView />);
    await cardButton('A');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
```

Create `apps/desktop/src/features/global-view/edges.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { exitPoint, strokeOf } from './edges';

describe('Global View edges (M3a §6)', () => {
  it('end at the card border, 5 px out, on the line between centres', () => {
    const box = { x: 0, y: 0, w: 240, h: 300 }; // centre (120, 150)
    expect(exitPoint(box, { x: 1000, y: 150 })).toEqual({ x: 245, y: 150 });
    expect(exitPoint(box, { x: 120, y: -500 })).toEqual({ x: 120, y: -5 });
    // At 45° a card taller than wide is left through its side: (240, 270) + 5 px.
    const corner = exitPoint(box, { x: 1120, y: 1150 });
    expect(corner.x).toBeCloseTo(243.54, 1);
    expect(corner.y).toBeCloseTo(273.54, 1);
    expect(exitPoint(box, { x: 120, y: 150 })).toEqual({ x: 120, y: 150 });
  });

  it('GV-21: every kind differs by more than colour (width or dash pattern)', () => {
    const kinds = [
      strokeOf('link', false),
      strokeOf('link', true),
      strokeOf('tree', false),
      strokeOf('manual', false),
      strokeOf('manual', true),
    ];
    const shapes = new Set(kinds.map((s) => `${s.width}/${s.dash ?? 'solid'}`));
    expect(shapes.size).toBe(kinds.length);
  });
});
```

Modify `apps/desktop/src/features/global-view/gvStore.test.ts` (apply this diff):

```diff
@@ -153,6 +153,19 @@ describe('Global View store (M3a §5)', () => {
     expect(useGvStore.getState().pinned).toEqual({});
   });
 
+  it('failing edge and layout reads leave the cards showing', async () => {
+    mockIPC((cmd, raw) => {
+      const args = (raw ?? {}) as Record<string, unknown>;
+      if (cmd === 'gv_children') return levels[levelKey(args.level as GvLevelRef)];
+      if (cmd === 'gv_edges') throw { kind: 'io', message: 'x' };
+      return undefined; // layout_get answering nothing
+    });
+    await useGvStore.getState().load();
+    expect(paths()).toEqual(['A', 'B', 'root.md']);
+    expect(useGvStore.getState().edges).toEqual([]);
+    expect(useGvStore.getState().pinned).toEqual({});
+  });
+
   it('a slower, older load never overwrites a newer one', async () => {
     let release: () => void = () => undefined;
     const held = new Promise<void>((r) => (release = r));
```

Modify `apps/desktop/src/features/shell/AppShell.test.tsx` (apply this diff):

```diff
@@ -3,10 +3,11 @@ import { EditorView } from '@codemirror/view';
 import { act, render, screen, waitFor } from '@testing-library/react';
 import userEvent from '@testing-library/user-event';
 import axe from 'axe-core';
-import { afterEach, describe, expect, it } from 'vitest';
+import { afterEach, beforeAll, describe, expect, it } from 'vitest';
 import type { TreeNode } from '../../ipc';
 import { clearMocks, mockIPC } from '../../ipc/testing';
 import { fakeDisk } from '../../test/fakeDisk';
+import { installReactFlowStubs } from '../../test/reactFlow';
 import { openPage } from '../../stores/navigate';
 import { usePageStore } from '../../stores/pageStore';
 import { childrenByParent } from '../../stores/tree';
@@ -43,6 +44,8 @@ function backend(handlers: Record<string, (a: Record<string, unknown>) => unknow
   return calls;
 }
 
+beforeAll(installReactFlowStubs);
+
 afterEach(async () => {
   await resetVaultStore();
   usePageStore.getState().clear();
```

Create `apps/desktop/src/test/reactFlow.ts`:

```ts
// React Flow in jsdom (imported by Global View tests): jsdom has no layout,
// so nodes get their size from their inline style (cards are 240 × 300) and
// the observers React Flow needs exist (reactflow.dev "Testing").
class ResizeObserverStub {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    const el = target as HTMLElement;
    const contentRect = { width: el.offsetWidth, height: el.offsetHeight } as DOMRectReadOnly;
    this.cb([{ target, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

const sized = (axis: 'width' | 'height', fallback: number) =>
  function (this: HTMLElement) {
    if (this.classList?.contains('react-flow__node')) return axis === 'width' ? 240 : 300;
    return parseFloat(this.style?.[axis]) || fallback;
  };

export function installReactFlowStubs() {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: sized('width', 1220) },
    offsetHeight: { configurable: true, get: sized('height', 760) },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}
```

Create `apps/desktop/tests/freezeSafe.test.ts`:

```ts
// @vitest-environment node
// tauri.conf.json sets "freezePrototype": true. d3-color (pulled in by React
// Flow's d3-zoom) assigns `prototype.constructor` on a plain object at load,
// which throws once Object.prototype is frozen — the whole UI would fail to
// start (M3a, found by the e2e mock that freezes like Tauri does).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { freezeSafe } from '../scripts/freezeSafe';

// pnpm keeps transitive packages in node_modules/.pnpm (not resolvable from here).
const store = new URL('../../../node_modules/.pnpm/', import.meta.url).pathname;
const d3Color = readdirSync(store).find((d) => d.startsWith('d3-color@'))!;
const DEFINE = join(store, d3Color, 'node_modules/d3-color/src/define.js');

/** Runs d3-color's define() in a fresh realm whose Object.prototype is frozen. */
function runFrozen(source: string): string {
  const body = source
    .replace('export default function', 'function define')
    .replace('export function extend', 'function extend');
  const ctx = vm.createContext({});
  return vm.runInContext(
    `'use strict';
     Object.freeze(Object.prototype);
     ${body}
     function Color() {}
     function color() {}
     define(Color, color, { toString() { return 'colour'; } });
     function Rgb() {}
     define(Rgb, function () {}, extend(Color, { brighter() { return 1; } }));
     [String(new Color()), Rgb.prototype.constructor === Rgb, typeof Rgb.prototype.brighter].join(' ');`,
    ctx,
  ) as string;
}

describe('freeze-safe build transform', () => {
  const original = readFileSync(DEFINE, 'utf8');

  it("d3-color's define() throws under a frozen Object.prototype as published", () => {
    expect(() => runFrozen(original)).toThrow(/read only property 'constructor'/);
  });

  it('the transform makes it work, and changes nothing else', () => {
    const plugin = freezeSafe();
    const out = plugin.transform(original, DEFINE);
    expect(out).not.toBeNull();
    expect(runFrozen(out!)).toBe('colour true function');
    expect(plugin.transform(original, '/elsewhere/define.js')).toBeNull();
    expect(plugin.transform('export const x = 1;', DEFINE)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/global-view tests/freezeSafe.test.ts`
Expected: the six `GlobalView.test.tsx` tests fail against the placeholder; `Failed to resolve import "./edges"` and `"../scripts/freezeSafe"`; `failing edge and layout reads leave the cards showing` fails (`TypeError` in `withPinned`).

- [ ] **Step 4: Implement**

Modify `apps/desktop/package.json` (apply this diff):

```diff
@@ -36,6 +36,7 @@
     "@lezer/highlight": "^1.2.5",
     "@tauri-apps/api": "^2.12.3",
     "@tauri-apps/plugin-dialog": "^2.8.2",
+    "@xyflow/react": "12.12.0",
     "github-slugger": "^2.0.0",
     "hast-util-raw": "^9.1.0",
     "hast-util-sanitize": "^5.0.2",
```

Create `apps/desktop/scripts/freezeSafe.ts`:

```ts
// A Vite transform that keeps third-party code working under Tauri's
// "freezePrototype": true (M3a). With Object.prototype frozen, assigning a
// property whose nearest definition is Object.prototype's (here
// `constructor`) throws in strict mode. d3-color (React Flow → d3-zoom →
// d3-interpolate) does exactly that while loading, so the UI would not start.
// The assignment becomes a property definition, which a frozen prototype
// allows. Matched by file path and exact source text: anything unexpected
// is left alone (and the e2e mock, which freezes like Tauri, would catch it).

const D3_COLOR_DEFINE = /[\\/]d3-color[\\/]src[\\/]define\.js$/;
const ASSIGN = 'prototype.constructor = constructor;';
const DEFINE =
  'Object.defineProperty(prototype, "constructor", { value: constructor, writable: true, configurable: true });';

export function freezeSafe() {
  return {
    name: 'liber-freeze-safe',
    enforce: 'pre' as const,
    transform(code: string, id: string): string | null {
      if (!D3_COLOR_DEFINE.test(id.split('?')[0]) || !code.includes(ASSIGN)) return null;
      return code.replace(ASSIGN, DEFINE);
    },
  };
}
```

Create `apps/desktop/src/features/global-view/Canvas.tsx`:

```tsx
import '@xyflow/react/dist/base.css';
import {
  Handle,
  Position,
  ReactFlow,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { GlobalViewEdges, GvCard } from '../../ipc';
import { Card } from './Card';
import { GvFlowEdgeView, type GvFlowEdge } from './edges';
import { useGvStore } from './gvStore';
import {
  CARD_H,
  CARD_W,
  columnsLayout,
  gridLayout,
  nearestInDirection,
  neighbourhoodLayout,
  withPinned,
  type Direction,
  type XY,
} from './layout';
import styles from './GlobalView.module.css';

interface CardData extends Record<string, unknown> {
  card: GvCard;
  open: boolean;
  focusable: boolean;
  connections: string;
  onOpen: (card: GvCard) => void;
  onOpenEditor: (card: GvCard) => void;
}

type CardNode = Node<CardData, 'card'>;

/** A card as a React Flow node; hidden handles let edges attach (they are
 *  drawn border to border, see edges.tsx). */
function CardNodeView({ data }: NodeProps<CardNode>) {
  const setFocus = useGvStore((s) => s.setFocus);
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className={styles.handle}
      />
      <Card
        card={data.card}
        open={data.open}
        focusable={data.focusable}
        connections={data.connections}
        onOpen={() => data.onOpen(data.card)}
        onOpenEditor={() => data.onOpenEditor(data.card)}
        onFocus={() => setFocus(data.card.path)}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className={styles.handle}
      />
    </>
  );
}

const nodeTypes = { card: CardNodeView };
const edgeTypes = { gv: GvFlowEdgeView };
const KEYS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

export interface CanvasProps {
  /** Layout key of what is shown; a new key fits the view again. */
  canvasKey: string;
  mode: 'drill' | 'expand';
  toggles: GlobalViewEdges;
  width: number;
  onOpen: (card: GvCard) => void;
  onOpenEditor: (card: GvCard) => void;
}

/** The Global View canvas (M3a §6, §7): cards placed by the level's layout
 *  (pinned positions win), edges per the toggles, pan and zoom. */
export function Canvas({ canvasKey, mode, toggles, width, onOpen, onOpenEditor }: CanvasProps) {
  const { t } = useTranslation();
  const canvas = useGvStore((s) => s.canvas);
  const edges = useGvStore((s) => s.edges);
  const pinned = useGvStore((s) => s.pinned);
  const expanded = useGvStore((s) => s.expanded);
  const focus = useGvStore((s) => s.focus);
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  const positions = useMemo(() => {
    let auto: Map<string, XY>;
    if (mode === 'expand') auto = columnsLayout(canvas.roots, canvas.children);
    else if (canvas.centre) auto = neighbourhoodLayout(canvas.cards);
    else auto = gridLayout(canvas.roots, width);
    return withPinned(auto, pinned);
  }, [canvas, mode, pinned, width]);

  const expandedPaths = useMemo(
    () => new Set(expanded.map((r) => (r.kind === 'vault' ? '' : r.path))),
    [expanded],
  );

  const flowEdges = useMemo<GvFlowEdge[]>(() => {
    const out: GvFlowEdge[] = [];
    for (const e of edges) {
      const shown = e.kind === 'link' ? toggles.links : toggles.manual;
      if (!shown || (e.aggregated && !toggles.aggregated)) continue;
      out.push({
        id: `${e.kind}:${e.from}→${e.to}`,
        source: e.from,
        target: e.to,
        type: 'gv',
        data: {
          kind: e.kind,
          aggregated: e.aggregated,
          directed: e.directed,
          count: e.count,
          label: e.label,
        },
      });
    }
    if (toggles.tree) {
      for (const [parent, kids] of canvas.children) {
        for (const kid of kids) {
          out.push({
            id: `tree:${parent}→${kid}`,
            source: parent,
            target: kid,
            type: 'gv',
            data: { kind: 'tree', aggregated: false, directed: false, count: 1, label: null },
          });
        }
      }
    }
    return out;
  }, [edges, toggles, canvas.children]);

  const connections = useMemo(() => {
    const links = new Map<string, number>();
    const manual = new Map<string, number>();
    for (const e of edges) {
      const m = e.kind === 'link' ? links : manual;
      for (const p of [e.from, e.to]) m.set(p, (m.get(p) ?? 0) + 1);
    }
    return (path: string) =>
      t('gv.connections', { links: links.get(path) ?? 0, manual: manual.get(path) ?? 0 });
  }, [edges, t]);

  const tabStop = focus ?? canvas.centre ?? canvas.cards[0]?.path ?? null;
  const computed = useMemo<CardNode[]>(
    () =>
      canvas.cards.map((card) => ({
        id: card.path,
        type: 'card',
        position: positions.get(card.path) ?? { x: 0, y: 0 },
        dragHandle: '.gv-grip',
        selectable: false,
        focusable: false,
        style: { width: CARD_W, height: CARD_H },
        data: {
          card,
          open: canvas.centre === card.path || expandedPaths.has(card.path),
          focusable: card.path === tabStop,
          connections: connections(card.path),
          onOpen,
          onOpenEditor,
        },
      })),
    [canvas, positions, expandedPaths, tabStop, connections, onOpen, onOpenEditor],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(computed);
  useEffect(() => setNodes(computed), [computed, setNodes]);

  // A new level: fit it in view, and keep the keyboard on a card when the
  // card that opened it is gone (it unmounted, focus fell to the page).
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (!initialized) return;
    void flow.fitView({ padding: 0.12, maxZoom: 1, duration: 0 });
    const active = document.activeElement;
    if (active === document.body || (active && wrapper.current?.contains(active))) {
      const first = useGvStore.getState().focus ?? canvas.centre ?? canvas.cards[0]?.path;
      if (first) focusCard(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasKey, initialized]);

  /** Moves the keyboard to a card: at once when it is on screen, else after
   *  the next render (a level that just loaded). */
  function focusCard(path: string) {
    useGvStore.getState().setFocus(path);
    const find = () =>
      wrapper.current?.querySelector<HTMLElement>(`[data-gv-card="${CSS.escape(path)}"]`);
    const el = find();
    if (el) el.focus({ preventScroll: true });
    else requestAnimationFrame(() => find()?.focus({ preventScroll: true }));
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>('[data-gv-card]')?.dataset.gvCard;
    if (!from) return;
    const dir = KEYS[e.key];
    if (dir) {
      e.preventDefault();
      const at = new Map(nodes.map((n) => [n.id, n.position]));
      const next = nearestInDirection(from, at, dir);
      if (next) {
        focusCard(next);
        const p = at.get(next)!;
        void flow.setCenter(p.x + CARD_W / 2, p.y + CARD_H / 2, {
          zoom: flow.getZoom(),
          duration: 150,
        });
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void useGvStore.getState().up(from);
    }
  };

  return (
    <div ref={wrapper} className={styles.canvas} onKeyDown={onKeyDown}>
      <ReactFlow<CardNode, GvFlowEdge>
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => useGvStore.getState().pin(node.id, node.position)}
        nodesConnectable={false}
        connectOnClick={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        disableKeyboardA11y
        zoomOnDoubleClick={false}
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      />
      <div className={styles.zoom} role="group" aria-label={t('gv.zoom')}>
        <button type="button" onClick={() => void flow.zoomIn()} aria-label={t('gv.zoomIn')}>
          +
        </button>
        <button type="button" onClick={() => void flow.zoomOut()} aria-label={t('gv.zoomOut')}>
          −
        </button>
        <button
          type="button"
          onClick={() => void flow.fitView({ padding: 0.12, maxZoom: 1 })}
          aria-label={t('gv.fit')}
        >
          ⤢
        </button>
      </div>
    </div>
  );
}
```

Modify `apps/desktop/src/features/global-view/GlobalView.module.css` (apply this diff):

```diff
@@ -1,4 +1,5 @@
-/* Global View screen (M3a §2). */
+/* Global View screen (M3a §2, §5–§7): prototype `.gvbar`, `.canvas`, `.fab`
+   (Main.dc.html lines 51-82) as theme tokens. */
 .view {
   flex: 1;
   min-width: 0;
@@ -6,3 +7,201 @@
   display: flex;
   flex-direction: column;
 }
+
+.toolbar {
+  display: flex;
+  flex-wrap: wrap;
+  align-items: center;
+  gap: 10px;
+  padding: 10px 20px;
+  border-bottom: 1px solid var(--color-border);
+  background: var(--color-surface-subtle);
+}
+
+.crumbs {
+  margin-right: auto;
+  min-width: 0;
+}
+
+.crumbs ol {
+  display: flex;
+  flex-wrap: wrap;
+  align-items: center;
+  margin: 0;
+  padding: 0;
+  list-style: none;
+}
+
+.crumbs li + li::before {
+  content: '›';
+  margin: 0 2px;
+  color: var(--color-text-faint);
+}
+
+.crumb,
+.crumbHere {
+  display: inline-block;
+  min-height: 34px;
+  padding: 6px 8px;
+  border: 0;
+  border-radius: var(--radius-sm);
+  background: transparent;
+  font: 600 14px var(--font-body);
+  color: var(--color-text-muted);
+}
+
+.crumb {
+  cursor: pointer;
+}
+
+.crumb:hover {
+  background: var(--color-accent-soft);
+}
+
+.crumbHere {
+  color: var(--color-text-strong);
+}
+
+.seg {
+  display: flex;
+  border: 1px solid var(--color-border-strong);
+  border-radius: var(--radius-md);
+  background: var(--color-surface);
+  overflow: hidden;
+}
+
+.seg button {
+  min-height: 38px;
+  padding: 8px 14px;
+  border: 0;
+  background: transparent;
+  font: 600 13px var(--font-body);
+  color: var(--color-text-body);
+  cursor: pointer;
+}
+
+.seg button + button {
+  border-left: 1px solid var(--color-border);
+}
+
+.seg .segOn {
+  background: var(--color-accent);
+  color: var(--color-accent-contrast);
+}
+
+.chips {
+  display: flex;
+  flex-wrap: wrap;
+  gap: 6px;
+}
+
+.chip {
+  display: inline-flex;
+  align-items: center;
+  gap: 8px;
+  min-height: 34px;
+  padding: 6px 12px;
+  border: 1px solid var(--color-border-strong);
+  border-radius: var(--radius-pill);
+  background: var(--color-surface);
+  font: 500 13px var(--font-body);
+  color: var(--color-text-body);
+  cursor: pointer;
+}
+
+.chip[aria-pressed='true'] {
+  background: var(--color-accent-soft);
+  border-color: var(--color-accent);
+  color: var(--color-text-strong);
+}
+
+.chip[aria-pressed='false'] svg {
+  opacity: 0.35;
+}
+
+.reset {
+  min-height: 38px;
+  padding: 7px 12px;
+  border: 1px solid var(--color-border-strong);
+  border-radius: var(--radius-md);
+  background: var(--color-surface);
+  font: 600 13px var(--font-body);
+  color: var(--color-text-body);
+  cursor: pointer;
+}
+
+.seg button:focus-visible,
+.chip:focus-visible,
+.reset:focus-visible,
+.crumb:focus-visible,
+.zoom button:focus-visible {
+  outline: 2px solid var(--color-focus);
+  outline-offset: 2px;
+}
+
+.area {
+  position: relative;
+  flex: 1;
+  min-height: 0;
+}
+
+.canvas {
+  position: absolute;
+  inset: 0;
+  background-color: var(--color-canvas);
+  background-image: radial-gradient(var(--color-bg-dots) 1.2px, transparent 1.4px);
+  background-size: 18px 18px;
+}
+
+.handle {
+  opacity: 0;
+  pointer-events: none;
+}
+
+.edgeLabel {
+  position: absolute;
+  pointer-events: none;
+  padding: 1px 6px;
+  border-radius: var(--radius-pill);
+  background: var(--color-surface);
+  border: 1px solid var(--color-border);
+  font: 600 11px var(--font-body);
+  color: var(--color-text-body);
+  white-space: nowrap;
+}
+
+.zoom {
+  position: absolute;
+  left: 16px;
+  bottom: 16px;
+  display: flex;
+  flex-direction: column;
+  border: 1px solid var(--color-border-strong);
+  border-radius: var(--radius-md);
+  background: var(--color-surface);
+  overflow: hidden;
+  z-index: 5;
+}
+
+.zoom button {
+  width: 36px;
+  height: 36px;
+  border: 0;
+  background: transparent;
+  font: 600 16px var(--font-body);
+  color: var(--color-text-body);
+  cursor: pointer;
+}
+
+.zoom button + button {
+  border-top: 1px solid var(--color-border);
+}
+
+.empty {
+  position: absolute;
+  left: 48px;
+  top: 48px;
+  margin: 0;
+  font: 400 15px var(--font-body);
+  color: var(--color-text-muted);
+}
```

Modify `apps/desktop/src/features/global-view/GlobalView.tsx` (apply this diff):

```diff
@@ -1,8 +1,92 @@
+import { ReactFlowProvider } from '@xyflow/react';
+import { useCallback, useEffect, useRef, useState } from 'react';
 import { useTranslation } from 'react-i18next';
+import type { GvCard } from '../../ipc';
+import { useEditorStore } from '../../stores/editorStore';
+import { openPage } from '../../stores/navigate';
+import { useSettingsStore } from '../../stores/settingsStore';
+import { useVaultStore } from '../../stores/vaultStore';
+import { Canvas } from './Canvas';
+import { canvasKey, useGvStore } from './gvStore';
+import { Toolbar } from './Toolbar';
 import styles from './GlobalView.module.css';
 
+/** Re-reading after vault changes waits for a burst to settle (M3a §9). */
+export const REFRESH_MS = 150;
+
 /** The Global View screen (M3a): the vault as cards, level by level. */
 export function GlobalView() {
   const { t } = useTranslation();
-  return <section className={styles.view} aria-label={t('gv.region')} />;
+  const mode = useSettingsStore((s) => s.settings.globalViewMode);
+  const toggles = useSettingsStore((s) => s.settings.globalViewEdges);
+  const stack = useGvStore((s) => s.stack);
+  const loaded = useGvStore((s) => s.loaded);
+  const empty = useGvStore((s) => s.canvas.cards.length === 0);
+  const area = useRef<HTMLDivElement>(null);
+  const [width, setWidth] = useState(1220);
+
+  // Load on show; re-read when the vault or a saved page changes.
+  useEffect(() => {
+    void useGvStore.getState().load();
+    let timer: ReturnType<typeof setTimeout> | undefined;
+    const later = () => {
+      clearTimeout(timer);
+      timer = setTimeout(() => void useGvStore.getState().load(), REFRESH_MS);
+    };
+    const stopVault = useVaultStore.subscribe((s, p) => {
+      if (s.nodes !== p.nodes) later();
+    });
+    const stopEditor = useEditorStore.subscribe((s, p) => {
+      if (s.hash !== p.hash) later();
+    });
+    return () => {
+      clearTimeout(timer);
+      stopVault();
+      stopEditor();
+    };
+  }, []);
+
+  // A new mode keeps the root level and forgets expansions (M3a §5).
+  const firstMode = useRef(mode);
+  useEffect(() => {
+    if (mode === firstMode.current) return;
+    firstMode.current = mode;
+    void useGvStore.getState().modeChanged();
+  }, [mode]);
+
+  useEffect(() => {
+    const el = area.current;
+    if (!el) return;
+    const observer = new ResizeObserver(() => setWidth(el.clientWidth || el.offsetWidth || 1220));
+    observer.observe(el);
+    return () => observer.disconnect();
+  }, []);
+
+  const onOpen = useCallback((card: GvCard) => void useGvStore.getState().open(card), []);
+  /** Double click / See all (GV-12): the page, or a folder's index note; a
+   *  folder without one opens as the next level. */
+  const onOpenEditor = useCallback((card: GvCard) => {
+    const page = card.kind === 'page' ? card.path : card.indexPage;
+    if (page) void openPage(page);
+    else void useGvStore.getState().open(card);
+  }, []);
+
+  return (
+    <section className={styles.view} aria-label={t('gv.region')}>
+      <Toolbar />
+      <div ref={area} className={styles.area}>
+        <ReactFlowProvider>
+          <Canvas
+            canvasKey={canvasKey(mode, stack[stack.length - 1])}
+            mode={mode}
+            toggles={toggles}
+            width={width}
+            onOpen={onOpen}
+            onOpenEditor={onOpenEditor}
+          />
+        </ReactFlowProvider>
+        {loaded && empty && <p className={styles.empty}>{t('gv.empty')}</p>}
+      </div>
+    </section>
+  );
 }
```

Create `apps/desktop/src/features/global-view/Toolbar.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import type { GlobalViewEdges, GvLevelRef } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { nameOf } from '../../stores/tree';
import { strokeOf, type GvEdgeKind } from './edges';
import { levelKey, useGvStore } from './gvStore';
import styles from './GlobalView.module.css';

const TOGGLES: { key: keyof GlobalViewEdges; kind: GvEdgeKind; aggregated: boolean }[] = [
  { key: 'links', kind: 'link', aggregated: false },
  { key: 'tree', kind: 'tree', aggregated: false },
  { key: 'manual', kind: 'manual', aggregated: false },
  { key: 'aggregated', kind: 'link', aggregated: true },
];

/** Breadcrumb, Drill-down | Expand in place, edge toggles and Reset layout
 *  (M3a §5–§7; prototype `.gvbar`). */
export function Toolbar() {
  const { t } = useTranslation();
  const stack = useGvStore((s) => s.stack);
  const levels = useGvStore((s) => s.levels);
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const mode = settings.globalViewMode;
  const toggles = settings.globalViewEdges;

  const crumbLabel = (ref: GvLevelRef) => {
    if (ref.kind === 'vault') return t('gv.vault');
    if (ref.kind === 'folder') return nameOf(ref.path);
    const centre = levels[levelKey(ref)]?.cards.find((c) => c.path === ref.path);
    return centre?.title ?? nameOf(ref.path).replace(/\.md$/i, '');
  };
  // Expand canvases show only their root level in the breadcrumb (M3a §5).
  const crumbs = stack;

  return (
    <div className={styles.toolbar}>
      <nav className={styles.crumbs} aria-label={t('gv.breadcrumb')}>
        <ol>
          {crumbs.map((ref, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={`${i}:${levelKey(ref)}`}>
                {last ? (
                  <span className={styles.crumbHere} aria-current="page">
                    {crumbLabel(ref)}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.crumb}
                    onClick={() => void useGvStore.getState().back(i)}
                  >
                    {crumbLabel(ref)}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className={styles.seg} role="group" aria-label={t('gv.mode')}>
        {(['drill', 'expand'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            className={mode === m ? styles.segOn : undefined}
            onClick={() => void update({ globalViewMode: m })}
          >
            {t(`gv.${m}`)}
          </button>
        ))}
      </div>
      <div className={styles.chips} role="group" aria-label={t('gv.edges')}>
        {TOGGLES.map(({ key, kind, aggregated }) => {
          const s = strokeOf(kind, aggregated);
          return (
            <button
              key={key}
              type="button"
              className={styles.chip}
              aria-pressed={toggles[key]}
              onClick={() => void update({ globalViewEdges: { ...toggles, [key]: !toggles[key] } })}
            >
              <svg width="20" height="6" aria-hidden="true">
                <line
                  x1="1"
                  y1="3"
                  x2="19"
                  y2="3"
                  style={{
                    stroke: s.stroke,
                    strokeWidth: Math.min(s.width, 3),
                    strokeDasharray: s.dash,
                    strokeLinecap: 'round',
                  }}
                />
              </svg>
              {t(`gv.edge.${key}`)}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className={styles.reset}
        onClick={() => void useGvStore.getState().resetLayout()}
      >
        {t('gv.reset')}
      </button>
    </div>
  );
}
```

Create `apps/desktop/src/features/global-view/edges.tsx`:

```tsx
// Global View edges (M3a §6): straight lines between card borders ("floating"
// edges), one style per kind so they differ by more than colour.
import {
  EdgeLabelRenderer,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type InternalNode,
} from '@xyflow/react';
import styles from './GlobalView.module.css';

export type GvEdgeKind = 'link' | 'manual' | 'tree';

export interface GvEdgeData extends Record<string, unknown> {
  kind: GvEdgeKind;
  aggregated: boolean;
  directed: boolean;
  count: number;
  label: string | null;
}

export type GvFlowEdge = Edge<GvEdgeData, 'gv'>;

/** Gap between a card's border and its edges' ends (prototype: 5 px). */
const GAP = 5;
const LABEL_CHARS = 24;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxOf(node: InternalNode): Box {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured.width ?? 240,
    h: node.measured.height ?? 300,
  };
}

/** Where the line from `box`'s centre towards `to` leaves the box, `GAP`
 *  further out. */
export function exitPoint(box: Box, to: { x: number; y: number }): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = to.x - cx;
  const dy = to.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Infinity : box.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.h / 2 / Math.abs(dy),
  );
  const len = Math.hypot(dx, dy);
  return { x: cx + dx * scale + (dx / len) * GAP, y: cy + dy * scale + (dy / len) * GAP };
}

const STROKES: Record<string, { stroke: string; width: number; dash?: string }> = {
  link: { stroke: 'var(--color-edge-link)', width: 2 },
  'link-aggregated': { stroke: 'var(--color-edge-link)', width: 2.5, dash: '1 6' },
  tree: { stroke: 'var(--color-edge-tree)', width: 1.5, dash: '6 5' },
  manual: { stroke: 'var(--color-edge-manual)', width: 3 },
  'manual-aggregated': { stroke: 'var(--color-edge-manual)', width: 3, dash: '12 6' },
};

export function strokeOf(kind: GvEdgeKind, aggregated: boolean) {
  return STROKES[kind !== 'tree' && aggregated ? `${kind}-aggregated` : kind];
}

/** One edge between two card borders; directed relationships get an arrow,
 *  aggregated edges a count, relationships their label. */
export function GvFlowEdgeView({ source, target, data }: EdgeProps<GvFlowEdge>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to || !data) return null;
  const a = boxOf(from);
  const b = boxOf(to);
  const s = exitPoint(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const t = exitPoint(b, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
  const style = strokeOf(data.kind, data.aggregated);
  const angle = Math.atan2(t.y - s.y, t.x - s.x);
  const head = (r: number) =>
    `${t.x - 11 * Math.cos(angle) + r * 6 * Math.sin(angle)},${t.y - 11 * Math.sin(angle) - r * 6 * Math.cos(angle)}`;
  const mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
  const label = data.kind === 'manual' ? data.label : null;
  const shown = label && label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label;
  const badge = data.count > 1 ? `×${data.count}` : null;
  return (
    <>
      <path
        d={`M ${s.x},${s.y} L ${t.x},${t.y}`}
        fill="none"
        style={{
          stroke: style.stroke,
          strokeWidth: style.width,
          strokeDasharray: style.dash,
          strokeLinecap: 'round',
        }}
        data-gv-edge={`${data.kind}${data.aggregated ? '-aggregated' : ''}`}
      />
      {data.directed && (
        <path
          d={`M ${t.x},${t.y} L ${head(1)} L ${head(-1)} Z`}
          style={{ fill: style.stroke }}
          data-gv-arrow=""
        />
      )}
      {(shown || badge) && (
        <EdgeLabelRenderer>
          <div
            className={styles.edgeLabel}
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
            title={label ?? undefined}
            aria-hidden="true"
          >
            {[shown, badge].filter(Boolean).join(' ')}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
```

Modify `apps/desktop/src/features/global-view/gvStore.ts` (apply this diff):

```diff
@@ -181,8 +181,10 @@ export const useGvStore = create<GvState>((set, get) => {
         expanded,
         levels,
         canvas,
-        edges: edges.ok ? edges.value : [],
-        pinned: pinned.ok ? pinned.value : {},
+        // A layout or edge read that fails (or answers nothing) just means
+        // none: the canvas still shows.
+        edges: edges.ok && Array.isArray(edges.value) ? edges.value : [],
+        pinned: pinned.ok && pinned.value ? pinned.value : {},
         focus: focus && shown.has(focus) ? focus : null,
         loaded: true,
       });
```

Modify `apps/desktop/src/i18n/locales/en.json` (apply this diff):

```diff
@@ -294,6 +294,24 @@
     "hasAudio": "Has audio",
     "seeAll": "See all",
     "seeAllLabel": "See all: {title}",
-    "move": "Move card"
+    "move": "Move card",
+    "breadcrumb": "Global View path",
+    "mode": "Next level",
+    "drill": "Drill-down",
+    "expand": "Expand in place",
+    "edges": "Edges",
+    "edge": {
+      "links": "Text links",
+      "tree": "Parent / child",
+      "manual": "Manual",
+      "aggregated": "Links from inside folders"
+    },
+    "reset": "Reset layout",
+    "empty": "Empty folder.",
+    "zoom": "Zoom",
+    "zoomIn": "Zoom in",
+    "zoomOut": "Zoom out",
+    "fit": "Fit to screen",
+    "connections": "{links, plural, =0 {No links.} one {Linked with # card.} other {Linked with # cards.}} {manual, plural, =0 {} one {# relationship.} other {# relationships.}}"
   }
 }
```

Modify `apps/desktop/src/i18n/locales/es.json` (apply this diff):

```diff
@@ -294,6 +294,24 @@
     "hasAudio": "Tiene audio",
     "seeAll": "Ver todo",
     "seeAllLabel": "Ver todo: {title}",
-    "move": "Mover tarjeta"
+    "move": "Mover tarjeta",
+    "breadcrumb": "Ruta de la vista global",
+    "mode": "Siguiente nivel",
+    "drill": "Profundizar",
+    "expand": "Expandir aquí",
+    "edges": "Conexiones",
+    "edge": {
+      "links": "Enlaces de texto",
+      "tree": "Padre / hijo",
+      "manual": "Manuales",
+      "aggregated": "Enlaces desde dentro de carpetas"
+    },
+    "reset": "Restablecer disposición",
+    "empty": "Carpeta vacía.",
+    "zoom": "Zoom",
+    "zoomIn": "Acercar",
+    "zoomOut": "Alejar",
+    "fit": "Ajustar a la pantalla",
+    "connections": "{links, plural, =0 {Sin enlaces.} one {Enlazada con # tarjeta.} other {Enlazada con # tarjetas.}} {manual, plural, =0 {} one {# relación.} other {# relaciones.}}"
   }
 }
```

Modify `apps/desktop/vite.config.ts` (apply this diff):

```diff
@@ -1,10 +1,13 @@
 import react from '@vitejs/plugin-react';
 import { defineConfig } from 'vitest/config';
+import { freezeSafe } from './scripts/freezeSafe';
 
 const host = process.env.TAURI_DEV_HOST;
 
 export default defineConfig({
-  plugins: [react()],
+  // freezeSafe: third-party code must load with Object.prototype frozen
+  // (tauri.conf.json "freezePrototype": true).
+  plugins: [freezeSafe(), react()],
   clearScreen: false,
   server: {
     port: 1420,
```


- [ ] **Step 5: Generated files**

`pnpm-lock.yaml` is updated by the add / install in the first step.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 && pnpm --filter @liber/desktop typecheck && pnpm lint && pnpm --filter @liber/desktop exec vite build`
Expected: `Test Files 64 passed`, all tests pass; build ok. Scan the bundle as in the Final gate: this task adds one `structuredClone` (React Flow, click-to-connect, disabled). Do not drop the freeze-safe plugin: without it every e2e test fails to load (`Cannot assign to read only property 'constructor' of object`).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/package.json apps/desktop/scripts/freezeSafe.ts apps/desktop/src/features/global-view/Canvas.tsx apps/desktop/src/features/global-view/GlobalView.module.css apps/desktop/src/features/global-view/GlobalView.test.tsx apps/desktop/src/features/global-view/GlobalView.tsx apps/desktop/src/features/global-view/Toolbar.tsx apps/desktop/src/features/global-view/edges.test.ts apps/desktop/src/features/global-view/edges.tsx apps/desktop/src/features/global-view/gvStore.test.ts apps/desktop/src/features/global-view/gvStore.ts apps/desktop/src/features/shell/AppShell.test.tsx apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json apps/desktop/src/test/reactFlow.ts apps/desktop/tests/freezeSafe.test.ts apps/desktop/vite.config.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(global-view): the canvas — cards, edges, breadcrumb, modes, toggles, keyboard (M3a §5–§7)

React Flow (@xyflow/react 12.12.0, pinned; no attribution badge, credited
in About later) shows the level's cards at the grid, column or
neighbourhood layout with pinned positions on top; cards move by their
grip and save where dropped. Edges run border to border, one stroke per
kind (solid links, dotted aggregated links, dashed parent/child, wide
relationships, dashed aggregated relationships) with counts, labels and
arrows; the four toggles and the mode are settings. Breadcrumb back,
Reset layout, zoom buttons, "Empty folder."; arrow keys move between
cards (nearest that way), Enter opens, Shift+Enter / double click / See
all open the editor, Escape goes up or collapses; focus follows into a
new level. Refreshes after vault changes and saves.
Tauri's freezePrototype would stop the UI from loading: d3-color (React
Flow → d3-zoom) assigns prototype.constructor while loading, which throws
with Object.prototype frozen. A Vite transform (scripts/freezeSafe.ts)
turns that one assignment into Object.defineProperty, matched by file
path and exact text; tests/freezeSafe.test.ts shows the published code
throwing in a frozen realm and the transformed code working.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Notes from the test run:** Found while test-running: (1) d3-color's `define()` throws under Tauri's `freezePrototype`, hence the Vite transform, folded into this task so the commit is self-contained; (2) React Flow needs `ResizeObserver` entries with `contentRect`, `DOMMatrixReadOnly` and sized elements in jsdom, hence `src/test/reactFlow.ts`, which `AppShell.test.tsx` installs too; (3) the `exitPoint` unit test: at 45° a card taller than wide is left through its side (243.54, 273.54).

---

### Task 11: New entry: a page in the folder shown, ready to name

**Commits in the test run:** `2a226d7`

**Files:**
- Modify: `apps/desktop/src/features/global-view/GlobalView.module.css`
- Modify: `apps/desktop/src/features/global-view/GlobalView.test.tsx` (test)
- Modify: `apps/desktop/src/features/global-view/GlobalView.tsx`
- Modify: `apps/desktop/src/features/global-view/gvStore.test.ts` (test)
- Modify: `apps/desktop/src/features/global-view/gvStore.ts`
- Modify: `apps/desktop/src/features/page/PageTitle.test.tsx` (test)
- Modify: `apps/desktop/src/features/page/PageTitle.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/stores/pageStore.ts`

**Interfaces:**
- **Produces:**
  - `gvStore.entryDir(): string`:
    - `''` at level 0;
    - the folder itself at a folder level;
    - a page level's folder;
    - in Expand, the focused card's folder;
  - `pageStore.titleFocus: { path } | null`, `requestTitleFocus(path)`, `clearTitleFocus()`;
  - `PageTitle` focuses and selects its input once for a matching request;
  - the New entry button (`gv.newEntry`).

- [ ] **Step 1: Write the failing tests**

Modify `apps/desktop/src/features/global-view/GlobalView.test.tsx` (apply this diff):

```diff
@@ -78,6 +78,10 @@ beforeEach(() => {
         };
       case 'page_read':
         return { text: '', hash: 'h' };
+      case 'entry_create_page':
+        return `${args.dir}/${args.name}.md`;
+      case 'vault_tree':
+        return [];
       default:
         return null;
     }
@@ -146,6 +150,19 @@ describe('Global View screen (M3a §5, §6)', () => {
     expect(calls).toContainEqual(['layout_set', { level: 'expand:', positions: {} }]);
   });
 
+  it('GV-17: New entry creates a page in the folder shown and opens it, title selected', async () => {
+    render(<GlobalView />);
+    await userEvent.click(await cardButton('A'));
+    await cardButton('a');
+    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));
+    await waitFor(() =>
+      expect(calls).toContainEqual(['entry_create_page', { dir: 'A', name: 'Untitled' }]),
+    );
+    await waitFor(() => expect(usePageStore.getState().path).toBe('A/Untitled.md'));
+    expect(useUiStore.getState().screen).toBe('edit');
+    expect(usePageStore.getState().titleFocus).toEqual({ path: 'A/Untitled.md' });
+  });
+
   it('an empty folder says so', async () => {
     render(<GlobalView />);
     await userEvent.click(await cardButton('B'));
```

Modify `apps/desktop/src/features/global-view/gvStore.test.ts` (apply this diff):

```diff
@@ -189,6 +189,24 @@ describe('Global View store (M3a §5)', () => {
   });
 });
 
+describe('New entry folder (GV-17)', () => {
+  it('is the vault root, the folder shown or the folder of a page level; in Expand, the focused card', async () => {
+    const gv = useGvStore.getState();
+    await gv.load();
+    expect(gv.entryDir()).toBe('');
+    await gv.open(card('A', 'project'));
+    expect(useGvStore.getState().entryDir()).toBe('A');
+    await useGvStore.getState().open(card('A/a.md'));
+    expect(useGvStore.getState().entryDir()).toBe('A');
+    mode('expand');
+    await useGvStore.getState().back(0);
+    useGvStore.getState().setFocus('B');
+    expect(useGvStore.getState().entryDir()).toBe('B');
+    useGvStore.getState().setFocus('root.md');
+    expect(useGvStore.getState().entryDir()).toBe('');
+  });
+});
+
 describe('canvas helpers', () => {
   it('canvas keys follow the arch §3.1 level keys', () => {
     expect(levelKey({ kind: 'vault' })).toBe('');
```

Modify `apps/desktop/src/features/page/PageTitle.test.tsx` (apply this diff):

```diff
@@ -193,6 +193,17 @@ describe('editable title (M2b §2)', () => {
     expect(useToastStore.getState().toasts).toEqual([]);
   });
 
+  it('M3a §5: a title focus request (New entry) focuses and selects the name once', async () => {
+    fakeDisk({ 'Notes/Untitled.md': '' });
+    act(() => usePageStore.getState().requestTitleFocus('Notes/Untitled.md'));
+    render(<PageView />);
+    await open('Notes/Untitled.md');
+    await waitFor(() => expect(document.activeElement).toBe(title()));
+    const input = title() as HTMLInputElement;
+    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Untitled'.length]);
+    expect(usePageStore.getState().titleFocus, 'consumed').toBeNull();
+  });
+
   it('has no axe violations', async () => {
     fakeDisk({ 'A.md': 'x\n' });
     render(<PageView />);
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/page/PageTitle.test.tsx src/features/global-view`
Expected: the PageTitle focus-request test and `GV-17: New entry …` fail; `entryDir is not a function`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/global-view/GlobalView.module.css` (apply this diff):

```diff
@@ -205,3 +205,31 @@
   font: 400 15px var(--font-body);
   color: var(--color-text-muted);
 }
+
+.fab {
+  position: absolute;
+  right: 28px;
+  bottom: 28px;
+  z-index: 5;
+  display: inline-flex;
+  align-items: center;
+  gap: 8px;
+  min-height: 52px;
+  padding: 14px 28px;
+  border: 0;
+  border-radius: var(--radius-pill);
+  background: var(--color-accent);
+  color: var(--color-accent-contrast);
+  font: 600 16px var(--font-body);
+  box-shadow: var(--shadow-panel);
+  cursor: pointer;
+}
+
+.fab:hover {
+  background: var(--color-accent-hover);
+}
+
+.fab:focus-visible {
+  outline: 2px solid var(--color-focus);
+  outline-offset: 3px;
+}
```

Modify `apps/desktop/src/features/global-view/GlobalView.tsx` (apply this diff):

```diff
@@ -1,10 +1,15 @@
 import { ReactFlowProvider } from '@xyflow/react';
 import { useCallback, useEffect, useRef, useState } from 'react';
 import { useTranslation } from 'react-i18next';
-import type { GvCard } from '../../ipc';
+import { PlusIcon } from '../../app/icons';
+import { entryCreatePage, type GvCard } from '../../ipc';
 import { useEditorStore } from '../../stores/editorStore';
-import { openPage } from '../../stores/navigate';
+import { errorMessage } from '../../stores/messages';
+import { openNewPage, openPage } from '../../stores/navigate';
+import { usePageStore } from '../../stores/pageStore';
 import { useSettingsStore } from '../../stores/settingsStore';
+import { useToastStore } from '../../stores/toastStore';
+import { nextFreeName } from '../../stores/tree';
 import { useVaultStore } from '../../stores/vaultStore';
 import { Canvas } from './Canvas';
 import { canvasKey, useGvStore } from './gvStore';
@@ -71,6 +76,19 @@ export function GlobalView() {
     else void useGvStore.getState().open(card);
   }, []);
 
+  /** GV-17: "Untitled" in the folder shown, opened with its name selected. */
+  const newEntry = async () => {
+    const dir = useGvStore.getState().entryDir();
+    const name = nextFreeName(useVaultStore.getState().nodes, dir, t('explorer.untitled'), '.md');
+    const res = await entryCreatePage(dir, name);
+    if (!res.ok) {
+      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
+      return;
+    }
+    usePageStore.getState().requestTitleFocus(res.value);
+    await openNewPage(res.value);
+  };
+
   return (
     <section className={styles.view} aria-label={t('gv.region')}>
       <Toolbar />
@@ -86,6 +104,10 @@ export function GlobalView() {
           />
         </ReactFlowProvider>
         {loaded && empty && <p className={styles.empty}>{t('gv.empty')}</p>}
+        <button type="button" className={styles.fab} onClick={() => void newEntry()}>
+          <PlusIcon />
+          {t('gv.newEntry')}
+        </button>
       </div>
     </section>
   );
```

Modify `apps/desktop/src/features/global-view/gvStore.ts` (apply this diff):

```diff
@@ -97,6 +97,8 @@ interface GvState {
   up: (path: string | null) => Promise<void>;
   /** The mode changed: keep the root level, forget expansions. */
   modeChanged: () => Promise<void>;
+  /** The folder New entry creates its page in (GV-17, M3a §5). */
+  entryDir: () => string;
   pin: (path: string, at: CardPosition) => void;
   resetLayout: () => Promise<void>;
   setFocus: (path: string | null) => void;
@@ -221,6 +223,16 @@ export const useGvStore = create<GvState>((set, get) => {
       set({ expanded: [], focus: null });
       return get().load();
     },
+    entryDir: () => {
+      const parent = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
+      const { stack, focus, canvas } = get();
+      const focused =
+        mode() === 'expand' && focus ? canvas.cards.find((c) => c.path === focus) : null;
+      if (focused) return focused.kind === 'page' ? parent(focused.path) : focused.path;
+      const root = stack[stack.length - 1];
+      if (root.kind === 'vault') return '';
+      return root.kind === 'folder' ? root.path : parent(root.path);
+    },
     pin: (path, at) => {
       set({ pinned: { ...get().pinned, [path]: at } });
       if (pinTimer) clearTimeout(pinTimer);
```

Modify `apps/desktop/src/features/page/PageTitle.tsx` (apply this diff):

```diff
@@ -1,7 +1,8 @@
-import { useEffect, useId, useState, type KeyboardEvent } from 'react';
+import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
 import { useTranslation } from 'react-i18next';
 import type { Page } from '../../ipc';
 import { errorMessage } from '../../stores/messages';
+import { usePageStore } from '../../stores/pageStore';
 import { nameOf, parentOf } from '../../stores/tree';
 import { useVaultStore } from '../../stores/vaultStore';
 import { validateName } from '../explorer/nameRules';
@@ -25,10 +26,19 @@ export function PageTitle({ page }: { page: Page }) {
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
   const errorId = useId();
+  const input = useRef<HTMLInputElement>(null);
   useEffect(() => {
     setDraft(stem);
     setError(null);
   }, [stem]);
+  // A page just made from the Global View: ready to be named (M3a §5).
+  const focusRequest = usePageStore((s) => s.titleFocus);
+  useEffect(() => {
+    if (focusRequest?.path !== page.path || !input.current) return;
+    input.current.focus();
+    input.current.select();
+    usePageStore.getState().clearTitleFocus();
+  }, [focusRequest, page.path]);
 
   const taken = () => t('page.titleTaken', { name: draft.trim() });
 
@@ -81,6 +91,7 @@ export function PageTitle({ page }: { page: Page }) {
     <>
       <h1 className={styles.title}>
         <input
+          ref={input}
           className={styles.titleInput}
           aria-label={t('page.titleLabel')}
           aria-invalid={error !== null}
```

Modify `apps/desktop/src/i18n/locales/en.json` (apply this diff):

```diff
@@ -312,6 +312,7 @@
     "zoomIn": "Zoom in",
     "zoomOut": "Zoom out",
     "fit": "Fit to screen",
-    "connections": "{links, plural, =0 {No links.} one {Linked with # card.} other {Linked with # cards.}} {manual, plural, =0 {} one {# relationship.} other {# relationships.}}"
+    "connections": "{links, plural, =0 {No links.} one {Linked with # card.} other {Linked with # cards.}} {manual, plural, =0 {} one {# relationship.} other {# relationships.}}",
+    "newEntry": "New entry"
   }
 }
```

Modify `apps/desktop/src/i18n/locales/es.json` (apply this diff):

```diff
@@ -312,6 +312,7 @@
     "zoomIn": "Acercar",
     "zoomOut": "Alejar",
     "fit": "Ajustar a la pantalla",
-    "connections": "{links, plural, =0 {Sin enlaces.} one {Enlazada con # tarjeta.} other {Enlazada con # tarjetas.}} {manual, plural, =0 {} one {# relación.} other {# relaciones.}}"
+    "connections": "{links, plural, =0 {Sin enlaces.} one {Enlazada con # tarjeta.} other {Enlazada con # tarjetas.}} {manual, plural, =0 {} one {# relación.} other {# relaciones.}}",
+    "newEntry": "Nueva entrada"
   }
 }
```

Modify `apps/desktop/src/stores/pageStore.ts` (apply this diff):

```diff
@@ -18,6 +18,11 @@ interface PageState {
   page: Page | null;
   state: PageViewState;
   anchor: Anchor | null;
+  /** Asks the title field of `path` to take focus with the name selected
+   *  (a page just made from the Global View, M3a §5); consumed once. */
+  titleFocus: { path: string } | null;
+  requestTitleFocus: (path: string) => void;
+  clearTitleFocus: () => void;
   /** Scrolls the open page to `heading`. */
   reveal: (heading: string | null) => void;
   /** Opens `path` (header data + editor). */
@@ -54,6 +59,9 @@ export const usePageStore = create<PageState>((set, get) => ({
   page: null,
   state: 'empty',
   anchor: null,
+  titleFocus: null,
+  requestTitleFocus: (path) => set({ titleFocus: { path } }),
+  clearTitleFocus: () => set({ titleFocus: null }),
   reveal: (heading) =>
     set({ anchor: heading ? { heading, nonce: (get().anchor?.nonce ?? 0) + 1 } : null }),
   load: async (path) => {
```


- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 && pnpm --filter @liber/desktop typecheck`
Expected: `Test Files 64 passed`, `Tests 560 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/global-view/GlobalView.module.css apps/desktop/src/features/global-view/GlobalView.test.tsx apps/desktop/src/features/global-view/GlobalView.tsx apps/desktop/src/features/global-view/gvStore.test.ts apps/desktop/src/features/global-view/gvStore.ts apps/desktop/src/features/page/PageTitle.test.tsx apps/desktop/src/features/page/PageTitle.tsx apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json apps/desktop/src/stores/pageStore.ts
git commit -m "$(cat <<'EOF'
feat(global-view): New entry — a page in the folder shown, ready to name (M3a §5)

The floating New entry button creates "Untitled" (next free name) in the
vault root, the folder shown, a page level's folder, or the focused card's
folder in Expand, then opens it in the editor with the title field
focused and its name selected (a one-shot pageStore request).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Notes from the test run:** The page is created with `entryCreatePage` directly: `vaultStore.createPage` would start the explorer's inline rename and take the focus away from the title.

---

### Task 12: Fit and focus once per loaded level; e2e in Chromium and WebKit

**Commits in the test run:** `9b4e87f`, `2787b45`

**Files:**
- Modify: `apps/desktop/src/features/global-view/Canvas.tsx`
- Modify: `apps/desktop/src/features/global-view/GlobalView.tsx`
- Modify: `apps/desktop/src/features/global-view/gvStore.test.ts` (test)
- Modify: `apps/desktop/src/features/global-view/gvStore.ts`
- Modify: `apps/desktop/e2e/ipcMock.ts` (test)
- Create: `apps/desktop/e2e/m3a.spec.ts` (test)
- Modify: `apps/desktop/e2e/zero-network.spec.ts` (test)
- Modify: `apps/desktop/playwright.config.ts`

**Interfaces:**
- **Produces:**
  - `gvStore.shownKey`: the canvas key of the level `canvas` was loaded for (the breadcrumb changes first, the key when the level arrives);
  - `Canvas` fits and focuses once per `shownKey`, and nodes carry `width` / `height`;
  - e2e mock commands `gv_children` / `gv_edges` (derived from the mock pages) and `layout_get` / `layout_set` (kept in `localStorage`, so a reload keeps them);
  - `e2e/m3a.spec.ts`, included in the WebKit project's `testMatch`;
  - a Global View case in `zero-network.spec.ts`.

- [ ] **Step 1: Write the failing test**

Modify `apps/desktop/src/features/global-view/gvStore.test.ts` (apply this diff):

```diff
@@ -166,6 +166,19 @@ describe('Global View store (M3a §5)', () => {
     expect(useGvStore.getState().pinned).toEqual({});
   });
 
+  it('shownKey names the level the canvas holds: the breadcrumb moves first, the key when the level arrives', async () => {
+    await useGvStore.getState().load();
+    expect(useGvStore.getState().shownKey).toBe('');
+    const opening = useGvStore.getState().open(card('A', 'project'));
+    expect(useGvStore.getState().stack.at(-1)).toEqual({ kind: 'folder', path: 'A' });
+    expect(useGvStore.getState().shownKey, 'still the vault while A loads').toBe('');
+    await opening;
+    expect(useGvStore.getState().shownKey).toBe('A');
+    mode('expand');
+    await useGvStore.getState().modeChanged();
+    expect(useGvStore.getState().shownKey).toBe('expand:A');
+  });
+
   it('a slower, older load never overwrites a newer one', async () => {
     let release: () => void = () => undefined;
     const held = new Promise<void>((r) => (release = r));
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/global-view/gvStore.test.ts`
Expected: `shownKey names the level the canvas holds …` fails: `shownKey` is undefined. (In e2e at Task 11's commit: the WebKit double click and the keyboard test fail, see the notes.)

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/global-view/Canvas.tsx` (apply this diff):

```diff
@@ -3,7 +3,6 @@ import {
   Handle,
   Position,
   ReactFlow,
-  useNodesInitialized,
   useNodesState,
   useReactFlow,
   type Node,
@@ -80,8 +79,6 @@ const KEYS: Record<string, Direction> = {
 };
 
 export interface CanvasProps {
-  /** Layout key of what is shown; a new key fits the view again. */
-  canvasKey: string;
   mode: 'drill' | 'expand';
   toggles: GlobalViewEdges;
   width: number;
@@ -91,7 +88,7 @@ export interface CanvasProps {
 
 /** The Global View canvas (M3a §6, §7): cards placed by the level's layout
  *  (pinned positions win), edges per the toggles, pan and zoom. */
-export function Canvas({ canvasKey, mode, toggles, width, onOpen, onOpenEditor }: CanvasProps) {
+export function Canvas({ mode, toggles, width, onOpen, onOpenEditor }: CanvasProps) {
   const { t } = useTranslation();
   const canvas = useGvStore((s) => s.canvas);
   const edges = useGvStore((s) => s.edges);
@@ -170,6 +167,11 @@ export function Canvas({ canvasKey, mode, toggles, width, onOpen, onOpenEditor }
         dragHandle: '.gv-grip',
         selectable: false,
         focusable: false,
+        // Known size: React Flow needn't measure (and hide) a card again each
+        // time its data changes — a hidden card drops focus and the second
+        // click of a double click (found in WebKit e2e).
+        width: CARD_W,
+        height: CARD_H,
         style: { width: CARD_W, height: CARD_H },
         data: {
           card,
@@ -185,11 +187,18 @@ export function Canvas({ canvasKey, mode, toggles, width, onOpen, onOpenEditor }
   const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(computed);
   useEffect(() => setNodes(computed), [computed, setNodes]);
 
-  // A new level: fit it in view, and keep the keyboard on a card when the
-  // card that opened it is gone (it unmounted, focus fell to the page).
-  const initialized = useNodesInitialized();
+  // A level just loaded: fit it in view and keep the keyboard on a card when
+  // the one that opened it is gone (it unmounted, focus fell to the page).
+  // Once per loaded level, keyed by what the store loaded (the breadcrumb
+  // changes before the level arrives) — a refresh of the same level, or nodes
+  // updated for focus, must not move the view.
+  const shownKey = useGvStore((s) => s.shownKey);
+  const fitted = useRef<string | null>(null);
   useEffect(() => {
-    if (!initialized) return;
+    if (shownKey === null || fitted.current === shownKey) return;
+    const ids = canvas.cards.map((c) => c.path);
+    if (nodes.length !== ids.length || nodes.some((n, i) => n.id !== ids[i])) return;
+    fitted.current = shownKey;
     void flow.fitView({ padding: 0.12, maxZoom: 1, duration: 0 });
     const active = document.activeElement;
     if (active === document.body || (active && wrapper.current?.contains(active))) {
@@ -197,7 +206,7 @@ export function Canvas({ canvasKey, mode, toggles, width, onOpen, onOpenEditor }
       if (first) focusCard(first);
     }
     // eslint-disable-next-line react-hooks/exhaustive-deps
-  }, [canvasKey, initialized]);
+  }, [shownKey, nodes, canvas]);
 
   /** Moves the keyboard to a card: at once when it is on screen, else after
    *  the next render (a level that just loaded). */
```

Modify `apps/desktop/src/features/global-view/GlobalView.tsx` (apply this diff):

```diff
@@ -12,7 +12,7 @@ import { useToastStore } from '../../stores/toastStore';
 import { nextFreeName } from '../../stores/tree';
 import { useVaultStore } from '../../stores/vaultStore';
 import { Canvas } from './Canvas';
-import { canvasKey, useGvStore } from './gvStore';
+import { useGvStore } from './gvStore';
 import { Toolbar } from './Toolbar';
 import styles from './GlobalView.module.css';
 
@@ -24,7 +24,6 @@ export function GlobalView() {
   const { t } = useTranslation();
   const mode = useSettingsStore((s) => s.settings.globalViewMode);
   const toggles = useSettingsStore((s) => s.settings.globalViewEdges);
-  const stack = useGvStore((s) => s.stack);
   const loaded = useGvStore((s) => s.loaded);
   const empty = useGvStore((s) => s.canvas.cards.length === 0);
   const area = useRef<HTMLDivElement>(null);
@@ -95,7 +94,6 @@ export function GlobalView() {
       <div ref={area} className={styles.area}>
         <ReactFlowProvider>
           <Canvas
-            canvasKey={canvasKey(mode, stack[stack.length - 1])}
             mode={mode}
             toggles={toggles}
             width={width}
```

Modify `apps/desktop/src/features/global-view/gvStore.ts` (apply this diff):

```diff
@@ -80,6 +80,9 @@ interface GvState {
   expanded: GvLevelRef[];
   levels: Record<string, GvLevel>;
   canvas: Canvas;
+  /** Layout key of the level `canvas` was loaded for (the stack changes
+   *  first, the canvas when the level arrives). */
+  shownKey: string | null;
   edges: GvEdge[];
   /** Pinned positions of the current canvas. */
   pinned: Record<string, CardPosition>;
@@ -139,6 +142,7 @@ export const useGvStore = create<GvState>((set, get) => {
     expanded: [],
     levels: {},
     canvas: EMPTY_CANVAS,
+    shownKey: null,
     edges: [],
     pinned: {},
     focus: null,
@@ -183,6 +187,7 @@ export const useGvStore = create<GvState>((set, get) => {
         expanded,
         levels,
         canvas,
+        shownKey: canvasKey(m, root),
         // A layout or edge read that fails (or answers nothing) just means
         // none: the canvas still shows.
         edges: edges.ok && Array.isArray(edges.value) ? edges.value : [],
@@ -255,6 +260,7 @@ export const useGvStore = create<GvState>((set, get) => {
         expanded: [],
         levels: {},
         canvas: EMPTY_CANVAS,
+        shownKey: null,
         edges: [],
         pinned: {},
         focus: null,
```


- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/global-view src/features/shell`
Expected: all pass (`gvStore.test.ts` 10).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/global-view/Canvas.tsx apps/desktop/src/features/global-view/GlobalView.tsx apps/desktop/src/features/global-view/gvStore.test.ts apps/desktop/src/features/global-view/gvStore.ts
git commit -m "$(cat <<'EOF'
fix(global-view): fit and focus once per loaded level; cards keep their size (M3a §5)

Found in WebKit/Chromium e2e: nodes re-created without a size were
re-measured (and hidden) whenever card data changed — a focused card lost
focus and a double click's second press hit the pane; the breadcrumb
moving before the level loaded made the fit/focus run on the old level.
Cards now carry their 240 × 300 size, and the store records which level
the canvas holds (shownKey), fitted and focused once.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Write the failing tests**

Modify `apps/desktop/e2e/ipcMock.ts` (apply this diff):

```diff
@@ -53,6 +53,51 @@ export function installIpcMock({
     truncated: false,
     binary: false,
   });
+  /** Pages a page links to (`[[name]]`, resolved by file name). */
+  const linksOf = (path: string): string[] =>
+    [...(pages[path] ?? '').matchAll(/\[\[([^\]|#]+)/g)]
+      .map((m) =>
+        Object.keys(pages).find((p) => p.replace(/\.md$/, '').split('/').pop() === m[1].trim()),
+      )
+      .filter((p): p is string => !!p);
+  /** A Global View card for a page or folder (M3a §8). */
+  const gvCard = (path: string, kind: string, relation: string | null) => {
+    const text = pages[path] ?? '';
+    const cover =
+      front(text).cover ??
+      (kind === 'page' && remoteCover ? 'https://remote.example/cover.png' : null);
+    const remote = !!cover && /^[a-z][a-z0-9+.-]*:/i.test(cover);
+    const name = path.split('/').pop()!;
+    return {
+      path,
+      kind,
+      title: kind === 'page' ? titleOf(path, text) : name,
+      subtitle: kind === 'page' ? (front(text).subtitle ?? null) : name,
+      cover: remote || !cover ? null : files.has(cover) ? cover : null,
+      coverRemote: remote,
+      coverY: null,
+      excerpt:
+        kind === 'page'
+          ? text
+              .replace(/^---[\s\S]*?---\n/, '')
+              .replace(/^#.*$/m, '')
+              .trim()
+              .slice(0, 200)
+          : '',
+      hasImage: false,
+      hasAudio: false,
+      indexPage: null,
+      pages:
+        kind === 'page'
+          ? 0
+          : Object.keys(pages).filter(
+              (p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'),
+            ).length,
+      folders: 0,
+      childTitles: [],
+      relation,
+    };
+  };
   let settings: Record<string, unknown> = {
     version: 1,
     language: 'en',
@@ -156,6 +201,79 @@ export function installIpcMock({
         }))
         .filter((s) => s.title.toLowerCase().includes(q) || s.path.toLowerCase().includes(q));
     },
+    // ---- M3a (spec §8): levels, edges and layouts from `pages` ----
+    gv_children: (a) => {
+      const level = a.level as { kind: string; path?: string };
+      const folders = new Set<string>();
+      for (const p of Object.keys(pages)) {
+        for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) folders.add(p.slice(0, i));
+      }
+      const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
+      if (level.kind === 'page') {
+        const centre = level.path!;
+        const out = new Set(linksOf(centre));
+        const into = new Set(Object.keys(pages).filter((p) => linksOf(p).includes(centre)));
+        const others = [...new Set([...out, ...into])].filter((p) => p !== centre).sort();
+        const rel = (p: string) => (out.has(p) && into.has(p) ? 'both' : out.has(p) ? 'out' : 'in');
+        return {
+          cards: [
+            gvCard(centre, 'page', 'centre'),
+            ...others.map((p) => gvCard(p, 'page', rel(p))),
+          ],
+          centre,
+        };
+      }
+      const dir = level.kind === 'folder' ? level.path! : '';
+      if (dir && !folders.has(dir)) throw { kind: 'notFound', message: dir };
+      const kind = dir ? 'folder' : 'project';
+      const subs = [...folders].filter((f) => parentOf(f) === dir).sort();
+      const here = Object.keys(pages)
+        .filter((p) => parentOf(p) === dir)
+        .sort();
+      return {
+        cards: [
+          ...subs.map((f) => gvCard(f, kind, null)),
+          ...here.map((p) => gvCard(p, 'page', null)),
+        ],
+        centre: null,
+      };
+    },
+    gv_edges: (a) => {
+      const shown = new Set(a.visible as string[]);
+      const lift = (p: string): string | null => {
+        for (let q = p; q; q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : '') {
+          if (shown.has(q)) return q;
+        }
+        return null;
+      };
+      const edges = new Map<
+        string,
+        { from: string; to: string; count: number; aggregated: boolean }
+      >();
+      for (const src of Object.keys(pages)) {
+        for (const target of linksOf(src)) {
+          const x = lift(src);
+          const y = lift(target);
+          if (!x || !y || x === y) continue;
+          const [from, to] = x < y ? [x, y] : [y, x];
+          const e = edges.get(`${from}|${to}`) ?? { from, to, count: 0, aggregated: false };
+          e.count++;
+          e.aggregated ||= x !== src || y !== target;
+          edges.set(`${from}|${to}`, e);
+        }
+      }
+      return [...edges.values()].map((e) => ({ ...e, kind: 'link', directed: false, label: null }));
+    },
+    layout_get: (a) => {
+      const all = JSON.parse(localStorage.getItem('liber-e2e-layout') ?? '{}');
+      return all[a.level as string] ?? {};
+    },
+    layout_set: (a) => {
+      const all = JSON.parse(localStorage.getItem('liber-e2e-layout') ?? '{}');
+      all[a.level as string] = a.positions;
+      localStorage.setItem('liber-e2e-layout', JSON.stringify(all));
+      return null;
+    },
     entry_create_folder: (a) => (a.parent ? `${a.parent}/${a.name}` : (a.name as string)),
     entry_create_page: (a) => {
       const name = `${a.name}.md`;
```

Create `apps/desktop/e2e/m3a.spec.ts`:

```ts
// M3a in the built UI, in Chromium and WebKit (≈ WKWebView): the Global View
// — levels, Drill-down and Expand, the editor from a card, pinned positions
// across a reload, edge toggles and keyboard-only use.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const PAGES = {
  'Alpha/One.md': '# One\n\nSee [[Two]].\n',
  'Alpha/Two.md': '# Two\n\nThe second.\n',
  'Beta/Three.md': '# Three\n\nSee [[One]].\n',
  'Welcome.md': '# Welcome\n\nStart here.\n',
};

async function globalView(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES },
    editorMode: 'livePreview',
    settings,
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('button', { name: 'Global view' }).click();
  await expect(page.getByRole('region', { name: 'Global View' })).toBeVisible();
}

const card = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Global View path' });

test('level 0 shows projects and root pages; a click drills in; the breadcrumb goes back', async ({
  page,
}) => {
  await globalView(page);
  for (const name of ['Alpha', 'Beta', 'Welcome']) await expect(card(page, name)).toBeVisible();
  await card(page, 'Alpha').click();
  await expect(card(page, 'One')).toBeVisible();
  await expect(card(page, 'Two')).toBeVisible();
  await expect(card(page, 'Beta')).toHaveCount(0);
  await expect(crumbs(page).getByRole('button', { name: 'Vault' })).toBeVisible();
  await expect(crumbs(page).getByText('Alpha')).toHaveAttribute('aria-current', 'page');
  await crumbs(page).getByRole('button', { name: 'Vault' }).click();
  await expect(card(page, 'Beta')).toBeVisible();
});

test('expand in place adds the children beside the card; a second click collapses', async ({
  page,
}) => {
  await globalView(page, { globalViewMode: 'expand' });
  await card(page, 'Alpha').click();
  await expect(card(page, 'One')).toBeVisible();
  await expect(card(page, 'Beta')).toBeVisible();
  await expect(page.locator('[data-gv-edge="tree"]')).toHaveCount(2);
  await card(page, 'Alpha').click();
  await expect(card(page, 'One')).toHaveCount(0);
});

test('a double click opens the page in the editor', async ({ page }) => {
  await globalView(page);
  await card(page, 'Welcome').dblclick();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Welcome');
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
});

test('a dragged card keeps its place after a reload (GV-31); Reset layout restores it', async ({
  page,
}) => {
  await globalView(page);
  const node = page.locator('.react-flow__node[data-id="Beta"]');
  const before = await node.boundingBox();
  const grip = node.locator('.gv-grip');
  const at = (await grip.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + 120, at.y + 160, { steps: 8 });
  await page.mouse.up();
  const moved = (await node.boundingBox())!;
  expect(moved.y - before!.y).toBeGreaterThan(30);
  // Saved after the debounce; a reload (restart) reads it back.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('liber-e2e-layout') ?? ''))
    .toContain('Beta');
  await page.reload();
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('button', { name: 'Global view' }).click();
  await expect(card(page, 'Beta')).toBeVisible();
  const transform = () => node.evaluate((n) => (n as HTMLElement).style.transform);
  const pinned = await transform();
  await page.getByRole('button', { name: 'Reset layout' }).click();
  await expect.poll(transform).not.toBe(pinned);
});

test('links from inside folders draw one aggregated edge; its toggle hides it', async ({
  page,
}) => {
  await globalView(page);
  const aggregated = page.locator('[data-gv-edge="link-aggregated"]');
  await expect(aggregated).toHaveCount(1);
  const toggle = page.getByRole('button', { name: 'Links from inside folders' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(aggregated).toHaveCount(0);
});

test('keyboard only: arrows move, Enter opens, Escape goes back, Shift+Enter edits (GV-18)', async ({
  page,
}) => {
  await globalView(page);
  await card(page, 'Alpha').focus();
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Beta')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card(page, 'Three')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card(page, 'Alpha')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Welcome')).toBeFocused();
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Welcome');
});
```

Modify `apps/desktop/e2e/zero-network.spec.ts` (apply this diff):

```diff
@@ -125,3 +125,31 @@ for (const palette of [
     expect(outside).toEqual([]);
   });
 }
+
+// M3a §1: the Global View — cards with remote covers, edges, a page's
+// neighbourhood and Expand — loads nothing from outside either.
+test('zero network requests: the Global View', async ({ page }) => {
+  const { outside, problems } = await openRemotePage(page, 'livePreview');
+  await page.getByRole('button', { name: 'Global view' }).click();
+  const remote = page.getByRole('button', { name: 'Remote references', exact: true });
+  await expect(remote).toBeVisible();
+  const gv = page.getByRole('region', { name: 'Global View' });
+  await expect(gv.getByText('Remote cover not loaded', { exact: true }).first()).toBeVisible();
+  await remote.click();
+  await expect(page.getByRole('navigation', { name: 'Global View path' })).toContainText(
+    'Remote references',
+  );
+  await page.getByRole('button', { name: 'Expand in place' }).click();
+  await expect(page.getByRole('button', { name: 'Expand in place' })).toHaveAttribute(
+    'aria-pressed',
+    'true',
+  );
+  await page.waitForLoadState('networkidle');
+  await page.waitForTimeout(300);
+  const csp = await page.evaluate(
+    () => (window as unknown as { __liberCspViolations: string[] }).__liberCspViolations,
+  );
+  expect(problems).toEqual([]);
+  expect(csp).toEqual([]);
+  expect(outside).toEqual([]);
+});
```

- [ ] **Step 7: Run the tests and watch them fail**

Run: `pnpm --filter @liber/desktop exec vite build && PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @liber/desktop exec playwright test e2e/m3a.spec.ts e2e/zero-network.spec.ts`
Expected: these check behaviour built in Tasks 6–12a and pass as soon as they are written. To see them fail, run them on Task 11's commit: `a double click opens the page in the editor` (WebKit) and `keyboard only …` (Chromium) fail there.

- [ ] **Step 8: Implement**

Modify `apps/desktop/playwright.config.ts` (apply this diff):

```diff
@@ -13,7 +13,7 @@ export default defineConfig({
     {
       name: 'webkit',
       use: { ...devices['Desktop Safari'], browserName: 'webkit' },
-      testMatch: /\/(checklist|m2b|m2c)\.spec\.ts$/,
+      testMatch: /\/(checklist|m2b|m2c|m3a)\.spec\.ts$/,
     },
   ],
   webServer: {
```


- [ ] **Step 9: Run the tests and watch them pass**

Run: `for i in 1 2 3 4 5; do pnpm --filter @liber/desktop exec playwright test e2e/m3a.spec.ts; done`
Expected: `12 passed` five times in a row; the full Playwright run `60 passed`.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/e2e/ipcMock.ts apps/desktop/e2e/m3a.spec.ts apps/desktop/e2e/zero-network.spec.ts apps/desktop/playwright.config.ts
git commit -m "$(cat <<'EOF'
test(e2e): the Global View in Chromium and WebKit (M3a §10)

Level 0 → drill → breadcrumb back; Expand and collapse (parent/child
edges); double click opens the editor; a dragged card keeps its place
after a reload and Reset layout restores the layout; the aggregated edge
and its toggle; keyboard only (arrows, Enter, Escape, Shift+Enter); zero
network with the Global View open. The IPC mock answers gv_children /
gv_edges from its pages and keeps layouts in localStorage.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Notes from the test run:** Root causes, found from event and effect logs rather than by adding waits:
- **Re-measured cards:** `setNodes` with fresh node objects made React Flow re-measure and hide every card whenever card data changed (focus moving). A hidden card drops focus, and in WebKit the second press of a double click hits the pane.
- **Early fit and focus:** `open()` moves the breadcrumb before the level loads, so the fit-and-focus effect ran on the old level and nothing was left pending when the new cards arrived (Chromium).

The keyboard e2e waits on focus (`toBeFocused`), not on time. WebKit drags move the card less than the pointer, so the drag test asserts that the card moved (> 30 px) and that the position persists, not the distance.

---

## Final gate

- [ ] Run the whole gate:

```bash
set -o pipefail
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm check:i18n \
  && pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 \
  && pnpm build:ui && cargo fmt --all --check \
  && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace && cargo deny check \
  && pnpm --filter @liber/desktop exec playwright test
```

Expected:
- vitest: 563 passed (65 files);
- cargo: 232 passed, 1 ignored (the release perf test), plus the 5 main-thread menu checks;
- Playwright: 60 passed (Chromium + WebKit);
- lint, typecheck, i18n, fmt, clippy and deny clean.

- [ ] Perf (release): `cargo test --release -p liber-session --test global_view -- --ignored --nocapture`. Expected: "200-card level + edges: ~2 ms" and "level 0 (95 cards) + edges: ~90 ms", 1 passed.

- [ ] Bundle scan (Safari 15), after `pnpm build:ui`:

```bash
grep -c "(?<[=!]" apps/desktop/dist/assets/*.js
grep -o color-mix apps/desktop/dist/assets/*.css
grep -o structuredClone apps/desktop/dist/assets/*.js
```

Expected:
- 3 lookbehinds, all pre-existing: markdown autolink and trailing-space regexes, built inside `try`;
- 6 `color-mix`, all pre-existing (sidebar and backdrop hovers from M1);
- 3 `structuredClone`: one from React Flow's click-to-connect path (disabled here: `connectOnClick={false}`, no connectable handles), one feature-tested by its library.

## Self-review (done)

1. **Spec coverage:** every section of §1–§10 maps to a task:
   - §2: Task 6;
   - §3: Tasks 2 and 3;
   - §4: Tasks 2 and 9;
   - §5: Tasks 8, 10, 11 and 12;
   - §6: Tasks 3, 9 and 10;
   - §7: Tasks 4, 7 and 10;
   - §8: Tasks 1–5;
   - §9: Tasks 8 and 10;
   - §10: every task's tests, plus Task 12's e2e.
2. **Placeholders:** none. Every code step shows the full file or diff that ran.
3. **Type consistency:** `GvLevelRef`, `GvCard`, `GvEdge`, `CardPosition` and `levelKey` / `canvasKey` are defined once (`ipc/index.ts`, `gvStore.ts`) and used as defined; Rust `GvLevel`, `GvCard`, `GvEdge` and `EdgeKind` map 1:1 to the DTOs.
4. **Review Focus:** each of the five lines is pinned by a named test, above.
