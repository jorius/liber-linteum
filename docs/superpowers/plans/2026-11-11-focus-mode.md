# Focus Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) A Zen-style Focus mode: full screen, only the page's text in Live Preview, a quiet bottom strip (← · words · read time · saved status), left with Escape twice, the shortcut or the menu. (B) A right-click Preview for Mermaid diagrams and block maths, in a dialog with zoom and pan.

**Architecture:** One session-only flag `focus` in `uiStore`. A small `features/focus/` module owns entering/leaving (full screen, announce, restore), the shortcut, the double-Escape rule, the menu event and the "something else turned it off" watchers. Views read the flag and hide their chrome with `hidden`/conditional rendering of *siblings* only — the tree around `Editor` never changes, so the editor is never remounted.

**Tech Stack:** React 19, TypeScript, zustand, CodeMirror 6, Tauri 2 (Rust commands + macOS menu), vitest/jsdom, Playwright (chromium + webkit).

**Spec:** `docs/superpowers/specs/2026-11-11-focus-mode-design.md`

## Global Constraints

- State lives in `uiStore` (session only), never in `settingsStore`; `settings.editorMode` is never written by Focus mode.
- Main window with an open vault only; not in the single-file window.
- Shortcut **Alt+Mod+Z** (`⌥⌘Z` on macOS, `Ctrl+Alt+Z` elsewhere), matched by `e.code === 'KeyZ'`; ignored when `e.getModifierState('AltGraph')` (AltGr typing must stay typing).
- Double Escape window: **500 ms**.
- Leaving full screen only if Focus mode entered it; if full screen fails, Focus mode still works in the window.
- Every new string in both `src/i18n/locales/en.json` and `es.json` (`npm run check:i18n` passes).
- Reduced motion: no fade transitions (`@media (prefers-reduced-motion: reduce)`).
- Commands: `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:i18n`, `npm run test:e2e` (all from `apps/desktop`); `cargo test` from `apps/desktop/src-tauri`.

## Review Focus

1. **A single Escape that closes something** (autocomplete, find panel, spell menu, link/language picker, table tool, go-to-line, search dialog) must never count toward leaving. Pinned in Task 2 (unit) and Task 6 (e2e per overlay).
2. **Toggling Focus mode must not remount the editor** — text, selection, undo and scroll survive. Pinned in Task 4 (same `.cm-editor` node, undo works after leaving).
3. **User already in full screen before entering** stays in full screen after leaving. Pinned in Task 2.
4. **Unsaved / orphaned / unwritable page while focused**: the protective banners stay visible. Pinned in Task 4.
5. **macOS full-screen animation** fires resizes during Focus mode's own enter — must not immediately end Focus mode. Pinned in Task 2 (settling window).

---

### Task 1: Full-screen IPC (Rust + TS + mocks)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (next to `window_toggle_fullscreen`, ~line 103)
- Modify: `apps/desktop/src-tauri/src/lib.rs:~161` (register)
- Modify: `apps/desktop/src/ipc/index.ts:~844`
- Modify: `apps/desktop/e2e/ipcMock.ts:~1244`, `apps/desktop/e2e/fileWindowMock.ts` (if it mocks window commands)

**Interfaces:**
- Produces (Rust): `window_fullscreen(window) -> CmdResult<bool>`; `window_set_fullscreen(window, full: bool) -> CmdResult<()>` — same shape as `window_maximized`.
- Produces (TS): `windowFullscreen(): Promise<Result<boolean>>`, `windowSetFullscreen(full: boolean): Promise<Result<void>>` via `call(...)` like `windowMaximized`.
- Produces (mock): `window_fullscreen` returns `window.__liberFullscreen ?? false`; `window_set_fullscreen({full})` sets `window.__liberFullscreen = full` and dispatches a `resize` on `window` (so the e2e watcher path runs).

- [ ] **Step 1:** Add the two commands, register them in `lib.rs`'s `generate_handler!`.
- [ ] **Step 2:** `cargo build` from `src-tauri` — expect success.
- [ ] **Step 3:** Add the TS wrappers and the mock entries.
- [ ] **Step 4:** `npm run typecheck` — expect no errors.
- [ ] **Step 5:** Commit `feat(focus): full-screen state commands`.

---

### Task 2: Focus state and the focus module

**Files:**
- Modify: `apps/desktop/src/stores/uiStore.ts` (add `focus`)
- Create: `apps/desktop/src/features/focus/focusMode.ts`
- Test: `apps/desktop/src/features/focus/focusMode.test.ts`

**Interfaces:**
- Consumes: `windowFullscreen`, `windowSetFullscreen`, `onWindowResized` (ipc), `announce` (`features/editor/announce.ts`), `usePageStore`, `useUiStore`, `useSettingsStore`.
- Produces:
  - `uiStore`: `focus: boolean` (default `false`), `setFocus(on: boolean): void`.
  - `canFocus(): boolean` — vault open, `usePageStore.getState().state === 'ready'`, no dialog.
  - `enterFocus(): Promise<void>`, `leaveFocus(): Promise<void>`, `toggleFocus(): Promise<void>`.
  - `isFocusKey(e: KeyboardEvent, mac?: boolean): boolean` — Alt+Mod+`KeyZ`, no Shift, not AltGraph.
  - `installFocusMode(): () => void` — keydown listeners (shortcut + double Escape), resize watcher, store watchers. Returns uninstall.
  - `FOCUS_ESCAPE_MS = 500`, `FOCUS_SETTLE_MS = 1000`.

Behaviour to implement (decided here):
- **enter:** if `!canFocus()` → no-op. If `screen !== 'edit'` → `setScreen('edit')`. Read `windowFullscreen()`; remember `enteredFullscreen = !wasFull`; if `!wasFull` call `windowSetFullscreen(true)` — on error, leave `enteredFullscreen = false` and carry on. `setFocus(true)`. Start settling for `FOCUS_SETTLE_MS` after the set call resolves. Focus `.cm-content` if the keyboard isn't already in it. `announce(t('focus.on'))`.
- **leave:** `setFocus(false)`; if `enteredFullscreen` → `windowSetFullscreen(false)` (settling again); `announce(t('focus.off'))`.
- **Double Escape** (algorithm the tests don't fully determine):
  ```
  capture-phase keydown on window, key === 'Escape':
      overlayOpen = !!document.querySelector(OVERLAYS) || uiStore.dialog !== null
  bubble-phase keydown on window, key === 'Escape', focus on:
      if overlayOpen || e.defaultPrevented: lastEscape = 0; return
      if now - lastEscape <= FOCUS_ESCAPE_MS: lastEscape = 0; leaveFocus()
      else lastEscape = now
  any other keydown: lastEscape = 0
  OVERLAYS = '.cm-tooltip-autocomplete, .cm-panels .cm-search, [role="dialog"], [role="menu"], [role="listbox"], [data-liber-popup]'
  ```
  The capture snapshot is needed because React flushes discrete updates synchronously, so the overlay is already gone by the bubble phase. Any overlay that a Task 6 test shows slipping past both checks gets `data-liber-popup` on its root (allowed by the spec).
- **Watchers** (while focus is on): a resize where `windowFullscreen()` answers `false` outside settling → `leaveFocus()` (and `enteredFullscreen = false`, nothing to undo). `uiStore.screen` leaving `'edit'` → `leaveFocus()`. `settings.toolbar | lineNumbers | outline` changing → `leaveFocus()`. Vault closing/locking → `setFocus(false)` without touching full screen.

- [ ] **Step 1: Write failing tests** in `focusMode.test.ts` (mock `../../ipc` with `vi.mock`, fake timers):
  - `enters full screen and remembers it entered` — `windowFullscreen`→false; after `enterFocus()`: `windowSetFullscreen` called with `true`, `useUiStore.getState().focus === true`; after `leaveFocus()`: called with `false`.
  - `stays in full screen the user chose` — `windowFullscreen`→true; enter then leave: `windowSetFullscreen` never called.
  - `works when full screen fails` — `windowSetFullscreen` returns `{ok:false}`; `focus === true`; leave doesn't call it again.
  - `does nothing without a ready page` — pageStore state `'empty'`; `focus === false`.
  - `switches to the editor screen first` — screen `'global'`; after enter, screen `'edit'`.
  - `two Escapes within 500 ms leave` / `two Escapes 600 ms apart don't` / `Escape, a letter, Escape doesn't`.
  - `an Escape another handler prevented doesn't count` — first Escape dispatched with a listener calling `preventDefault`, second plain → still focused.
  - `an Escape that closes an overlay doesn't count` — a `<div role="listbox">` present at capture and removed by a bubble listener on `document.body`; then one plain Escape → still focused.
  - `the resize during its own enter doesn't leave` — resize callback fires with `windowFullscreen`→false within 1000 ms of enter → still focused; after 1000 ms → leaves.
  - `leaving full screen yourself leaves Focus mode` (outside settling).
  - `Global View, or a toolbar/outline/line-number toggle, leaves` — `setScreen('global')` → `focus === false`; `settings.update({ outline: !x })` → `focus === false`.
  - `isFocusKey` — `{altKey, metaKey, code:'KeyZ', key:'Ω'}` true on mac; `{altKey, ctrlKey, code:'KeyZ'}` true off mac; with `shiftKey` false; with AltGraph modifier false.
- [ ] **Step 2:** `npx vitest run src/features/focus` — expect FAIL (module missing).
- [ ] **Step 3:** Implement the store field and `focusMode.ts`.
- [ ] **Step 4:** `npx vitest run src/features/focus` — expect PASS.
- [ ] **Step 5:** Commit `feat(focus): focus state, enter/leave and double Escape`.

---

### Task 3: Shared `SaveStatus` component

**Files:**
- Create: `apps/desktop/src/features/page/SaveStatus.tsx`
- Modify: `features/page/PageHeader.tsx:86-95`, `features/page/TextView.tsx:73-80`, `features/singleFile/SingleFileApp.tsx:~188-195`
- Test: `apps/desktop/src/features/page/SaveStatus.test.tsx`

**Interfaces:**
- Produces: `SaveStatus({ className }: { className?: string })` — renders `<span role="status" aria-label={t('editor.saveStatus')} data-status={status}>` with `editor.copying` while `copying > 0`, else `editor.${status}`; classes `styles.status styles.pill` plus `className`. Reads `useEditorStore` itself.

Note: TextView and SingleFileApp currently never show "copying"; showing it there too is accepted (same store, it is accurate). SingleFileApp passes its own `page.status page.pill` classes — the component's default classes come from the same `PageView.module.css`, so check they are the same module; if so, drop its own.

- [ ] **Step 1: Failing test:** `shows each status` (`saved`, `saving`, `retrying`, `notSaved`, `unsaved` → text from en.json, `data-status` matches); `shows copying while copying`; `has the status role and label`.
- [ ] **Step 2:** `npx vitest run src/features/page/SaveStatus` — FAIL.
- [ ] **Step 3:** Implement; replace the three inline spans.
- [ ] **Step 4:** `npm test` — the new test plus all existing PageHeader/TextView/SingleFileApp tests PASS unchanged.
- [ ] **Step 5:** Commit `refactor(page): one SaveStatus component`.

---

### Task 4: Hiding the chrome and the focus strip

**Files:**
- Create: `apps/desktop/src/features/focus/FocusStrip.tsx`, `apps/desktop/src/features/focus/Focus.module.css`
- Modify: `features/shell/AppShell.tsx` (sidebar, reopen button, `OriginalsBanner`, `ActionButton` not rendered while focused; `data-focus` on `.shell`; render `<FocusStrip />`)
- Modify: `main.tsx:66` / `features/titlebar/TitleBar.tsx` (TitleBar returns `null` while focused in the main window)
- Modify: `features/page/PageView.tsx` (pass `focus ? 'livePreview' : mode` to `Editor` in both places)
- Modify: `features/page/PageHeader.tsx` (header band, cover, side cover hidden with `hidden`/CSS while focused; `children` stay at the same position in the tree)
- Modify: `features/page/TextView.tsx`, `features/page/ImageView.tsx` (their header bands hidden the same way)
- Modify: `features/editor/Editor.tsx` (toolbar, line numbers, outline: `setting && !focus`)
- Test: `apps/desktop/src/features/focus/FocusStrip.test.tsx`, `apps/desktop/e2e/focus-mode.spec.ts`

**Interfaces:**
- Consumes: `useUiStore(s => s.focus)`, `SaveStatus` (Task 3), `WordCount`, `BackArrow`, `TextStats` (from `TextView.tsx`).
- Produces: `FocusStrip()` — `<div data-focus-strip>` fixed bottom, centred: `<BackArrow />` always; then for a page with a doc `<WordCount />` + `<SaveStatus />`; for a text file `<TextStats />` + `<SaveStatus />`; for an image nothing more. Hidden entirely when `focus` is false. The editor's scroller gets bottom padding `var(--focus-strip-h)` while focused.

Kept visible while focused (spec §3): `UnwritableNotice`, orphan banner, `ArchivedBanner`, `RecorderBar`, dialogs, toasts.

Strip look (within theme tokens): opacity 0.35, 1 when `:hover`, `:focus-within`, or the pointer is in the bottom 64 px (a `data-near` attribute set from a `pointermove` listener); 150 ms opacity transition, none under reduced motion.

- [ ] **Step 1: Failing unit tests** (`FocusStrip.test.tsx`): `renders nothing out of focus`; `shows words and save status for a page`; `shows only the back arrow for an image`.
- [ ] **Step 2: Failing e2e** (`e2e/focus-mode.spec.ts`, open helper like `m5b-shell.spec.ts`, settings `editorMode: 'split'`, `outline: true`, `toolbar: true`):
  - `hides everything but the text` — after ⌥⌘Z/Ctrl+Alt+Z: no tree, no `Page title` textbox visible, no toolbar, no outline, no `Actions` button, no `.cm-gutters`; `[data-focus-strip]` shows `words` and `Saved`; the editor is Live Preview (no split pane).
  - `keeps the same editor` — store `.cm-editor` handle before; after enter and leave, `isSameNode` true; type "x", leave, Mod+Z removes it.
  - `restores split mode and the chrome` — after Escape, Escape: tree, title, outline, toolbar back; split pane back; settings write log contains no `editorMode` change.
  - `stays focused across a link and goes back` — `A.md` links `[[B]]`; click it → title hidden, strip shows; click the strip's ← → A, still focused.
  - `keeps the orphan / unwritable notice` — use the mock's existing unwritable option; notice visible while focused.
  - `full screen` — `window.__liberFullscreen` true after enter, false after leave; pre-set true → still true after leave.
- [ ] **Step 3:** Run `npx vitest run src/features/focus` and `npx playwright test e2e/focus-mode.spec.ts` — FAIL.
- [ ] **Step 4:** Implement. Call `installFocusMode()` from `main.tsx` in the non-single-file branch.
- [ ] **Step 5:** Re-run both — PASS (chromium + webkit; add the spec to WebKit's list in `playwright.config.ts` as `m4b3-gv` was).
- [ ] **Step 6:** Commit `feat(focus): hide the chrome, focus strip`.

---

### Task 5: Menus, shortcut list, strings

**Files:**
- Modify: `apps/desktop/src-tauri/src/menu.rs` (`FOCUS_ID = "liber-toggle-focus"`, `FOCUS_EVENT = "menu:focus"`; a `MenuItem` "Toggle Focus Mode" before `PredefinedMenuItem::fullscreen`, no accelerator — the page handles the key, as with the sidebar; `activate`: `emit_main(app, FOCUS_EVENT, ())`); add a case to the existing `#[cfg(test)]` module if it tests id routing.
- Modify: `apps/desktop/src/ipc/index.ts` (`onMenuFocus(cb)` like `onMenuSidebar`)
- Modify: `apps/desktop/src/features/focus/focusMode.ts` (`installFocusMode` also listens to `onMenuFocus(toggleFocus)` when in Tauri)
- Modify: `apps/desktop/src/features/titlebar/menus.ts` (main View menu: `item('focus', { id: 'liber-toggle-focus', keys: 'Alt+Mod+Z', checked: toggles.focus, disabled: !open })` before Full screen; `toggles.focus` added to `MenuContext`), `TitleBar.tsx:~112` (feed `toggles.focus`)
- Modify: `apps/desktop/src/features/dialogs/shortcuts.ts` (`{ keys: 'Alt+Mod+Z', label: 'focus' }` in the view group)
- Modify: `apps/desktop/src/features/shell/shellMenu.ts` `toggleSidebar` — first line: if focused, `leaveFocus()` and return (Mod+\ just leaves; the sidebar comes back as it was).
- Modify: `src/i18n/locales/en.json`, `es.json`
- Test: existing `menus` / `shortcuts.test.ts` tests extended

Strings (en / es):
- `titlebar.items.focus`: "Focus mode" / "Modo concentración"
- `shortcuts.focus`: "Focus mode" / "Modo concentración"
- `focus.on`: "Focus mode on. Press Escape twice to leave." / "Modo concentración activado. Pulsa Escape dos veces para salir."
- `focus.off`: "Focus mode off." / "Modo concentración desactivado."

Note: macOS's other View toggles are plain `MenuItem`s with no checkmark, so Focus mode follows them there (the spec's "checked item" holds for the custom title bar). This is a correction to spec §5.

- [ ] **Step 1: Failing tests:** in the menus test, `View lists Focus mode before Full screen, checked when focused`; in `shortcuts.test.ts`, `keyLabel('Alt+Mod+Z', true) === '⌥⌘Z'` and the list has `focus`; in a shellMenu test, `toggleSidebar while focused leaves Focus mode and keeps the sidebar setting`.
- [ ] **Step 2:** `npm test` — FAIL.
- [ ] **Step 3:** Implement all of the above.
- [ ] **Step 4:** `npm test && npm run check:i18n && npm run typecheck && npm run lint` and `cargo test` — all PASS.
- [ ] **Step 5:** Commit `feat(focus): View menu item, shortcut, strings`.

---

### Task 6: Escape never leaks from overlays (e2e)

**Files:**
- Modify: `apps/desktop/e2e/focus-mode.spec.ts`
- Modify (only if a test fails): the overlay's root gets `data-liber-popup`

- [ ] **Step 1: Write one test per overlay**, each: enter Focus mode, open the overlay, press Escape once → overlay closed and `[data-focus-strip]` still visible; press Escape once more → still focused (the 500 ms window started fresh). Overlays:
  - `[[` link autocomplete (type `[[`)
  - find in page (Mod+F)
  - go to line (Ctrl+G)
  - Search dialog (Mod+Shift+F)
  - language picker (fenced code block's language button)
  - spell menu (right-click a misspelt word; reuse `spell.spec.ts`'s setup)
  - table tool (reuse the existing table spec's setup)
- [ ] **Step 2:** `npx playwright test e2e/focus-mode.spec.ts` — note which fail.
- [ ] **Step 3:** Add `data-liber-popup` to each failing overlay's root element.
- [ ] **Step 4:** Re-run — all PASS in chromium and webkit.
- [ ] **Step 5:** Commit `test(focus): one Escape in an overlay never leaves Focus mode`.

---

### Task 7: Roadmap wording

**Files:**
- Modify: `site/index.html:891-894`, `site/js/i18n.js:215-216` and the Spanish `roadmap.focus.body` (~line 451)

Copy:
- en: "Hide everything but the text: no sidebar, no toolbar, just the words, the word count and whether it's saved."
- es: "Oculta todo menos el texto: sin barra lateral ni barra de herramientas, solo tus palabras, el recuento y si está guardado."

(README and moving the entry to "done" wait for the release, per spec §7.)

- [ ] **Step 1:** Edit the three places.
- [ ] **Step 2:** `npx playwright test` from `site/` (its own config) — PASS.
- [ ] **Step 3:** Commit `docs(site): focus mode roadmap wording`.

---

## Part B — Diagram preview (added 2026-11-11, agreed in chat)

Requirement (maintainer): a normal click on a rendered Mermaid diagram or block maths edits it, as now. A **right click** opens a context menu with **Preview** and **Edit source**. Preview opens a dialog to zoom in, zoom out and move across the diagram. No hover button. Not included: inline maths, tables, images, Global View atom cards, export.

Decided (Claude's calls): no new dependency (CSS transform); zoom 25 %–800 %; wheel/pinch zooms around the pointer, + / − / 0 keys and buttons zoom around the centre / fit; drag or arrow keys pan; the dialog shows the already-rendered markup (cloned `innerHTML`, which is already sanitised: `inertSvg` for Mermaid, KaTeX with `trust: false`), never re-rendering. In Split mode's rendered pane (`[data-preview]`) the menu offers Preview only (no source position to go to). Separate commits from Focus mode, `feat(preview): …`.

### Task 8: Shared popup menu, diagram context menu

**Files:**
- Create: `apps/desktop/src/features/preview/PopupMenu.tsx` (the list, placement, outside-click and keyboard logic moved out of `ImageMenu`)
- Modify: `apps/desktop/src/features/preview/ImageMenu.tsx` (uses `PopupMenu`; behaviour unchanged)
- Create: `apps/desktop/src/features/preview/DiagramMenu.tsx`
- Modify: `apps/desktop/src/features/preview/MermaidView.tsx:~151` (add `data-liber="diagram"` on the diagram's div)
- Modify: `apps/desktop/src/features/shell/AppShell.tsx` (render `<DiagramMenuHost />` next to `<ImageMenuHost />`)
- Modify: `src/i18n/locales/en.json`, `es.json`
- Test: `apps/desktop/src/features/preview/DiagramMenu.test.tsx`; existing ImageMenu tests unchanged

**Interfaces:**
- Produces: `PopupMenu({ label, items, anchor, onClose }: { label: string; items: { label: string; run: () => void }[]; anchor: { x: number; y: number }; onClose: () => void })` — `role="menu"`, `liber-menu` class, arrows / Escape / Tab exactly as `ImageMenu` does today.
- Produces: `diagramAt(target: EventTarget | null): HTMLElement | null` — `closest('[data-liber="diagram"], div[data-liber="math"]')` inside `.cm-editor` or `[data-preview]`; `null` otherwise (inline maths is a `span`, so it's excluded).
- Produces: `DiagramMenuHost()` — capture-phase `contextmenu` listener on `document` (like `ImageMenuHost`); on a diagram: `preventDefault`, `stopPropagation`, open the menu. Items: `diagram.preview` → `openDiagramPreview(el)` (Task 9); `diagram.editSource` (only inside `.cm-editor`) → find the `EditorView` (`EditorView.findFromDOM`), `pos = view.posAtDOM(el)`, dispatch `selection: { anchor: pos }`, `view.focus()`.

Strings (en / es): `diagram.menu` "Diagram menu" / "Menú del diagrama"; `diagram.preview` "Preview" / "Vista previa"; `diagram.editSource` "Edit source" / "Editar código".

- [ ] **Step 1: Failing tests:** `right-click on a mermaid diagram opens Preview and Edit source`; `right-click on block maths opens the menu`; `right-click on inline maths does nothing`; `in the rendered pane only Preview is offered`; `Edit source puts the cursor in the diagram's source` (Live Preview editor with a ```mermaid block; after Edit source, `view.state.selection.main.head` is inside the fence's range); `a left click is not intercepted` (no menu on `mousedown`).
- [ ] **Step 2:** `npx vitest run src/features/preview` — FAIL.
- [ ] **Step 3:** Implement; move `ImageMenu`'s list into `PopupMenu`.
- [ ] **Step 4:** `npm test` — new and existing ImageMenu tests PASS.
- [ ] **Step 5:** Commit `feat(preview): right-click menu on diagrams and maths`.

### Task 9: Diagram preview dialog with zoom and pan

**Files:**
- Create: `apps/desktop/src/features/preview/DiagramPreview.tsx`, `DiagramPreview.module.css`
- Create: `apps/desktop/src/features/preview/panZoom.ts` (pure maths)
- Modify: `stores/uiStore.ts` (`DialogState` gets `| { type: 'diagramPreview'; html: string; kind: 'diagram' | 'math'; returnTo: HTMLElement | null }`)
- Modify: `features/dialogs/DialogHost.tsx` (renders `DiagramPreview`)
- Modify: `src/i18n/locales/en.json`, `es.json`
- Test: `apps/desktop/src/features/preview/panZoom.test.ts`, `DiagramPreview.test.tsx`, `apps/desktop/e2e/diagram-preview.spec.ts`

**Interfaces:**
- Consumes: `Dialog` (`title`, `onClose`, `returnFocus`, `wide`), `PopupMenu` caller from Task 8.
- Produces: `openDiagramPreview(el: HTMLElement): void` — `openDialog({ type: 'diagramPreview', html: el.innerHTML, kind, returnTo: document.activeElement })`.
- Produces (`panZoom.ts`): `type View = { scale: number; x: number; y: number }`; `MIN_SCALE = 0.25`, `MAX_SCALE = 8`, `STEP = 1.25`; `zoomAt(v: View, factor: number, px: number, py: number): View` (keeps the point under (px,py) fixed, clamps scale); `panBy(v: View, dx: number, dy: number): View`; `fit(content: {w,h}, box: {w,h}): View` (scale `min(box/content, 1)` — never upscales on fit — centred).

Behaviour: content in a `transform: translate(x,y) scale(s)` layer, `transform-origin: 0 0`. Wheel: `preventDefault`; factor `exp(-deltaY * 0.002)` (pinch arrives as ctrl+wheel in Chromium/WebKit — same handler). Pointer drag pans (pointer capture). Keys: `+`/`=` zoom in, `-` zoom out, `0` fit, arrows pan 40 px. Toolbar: −, percentage (`Math.round(scale*100)%`), +, Fit — buttons with `aria-label`s. Opens at `fit`. The layer gets `role="img"` and `aria-label` = `diagram.previewLabel`; for maths, the KaTeX MathML inside stays readable. Escape is the `Dialog`'s own (it sets `role="dialog"`, so Task 2's overlay check covers Focus mode).

Strings (en / es): `diagram.previewTitle` "Diagram preview" / "Vista previa del diagrama"; `diagram.previewLabel` "Diagram" / "Diagrama"; `diagram.zoomIn` "Zoom in" / "Acercar"; `diagram.zoomOut` "Zoom out" / "Alejar"; `diagram.fit` "Fit" / "Ajustar".

- [ ] **Step 1: Failing unit tests** (`panZoom.test.ts`): `zoomAt keeps the point under the pointer` (zoom 2× at (100,50) from identity → (100,50) maps to the same screen point); `zoomAt clamps to 0.25 and 8`; `panBy adds`; `fit centres and never upscales` (content 200×100 in 800×600 → scale 1, x 300, y 250; content 1600×600 in 800×600 → scale 0.5).
- [ ] **Step 2: Failing component tests** (`DiagramPreview.test.tsx`): `shows the cloned markup`; `+ and − change the percentage` (100% → 125% → 100%); `0 fits`; `Escape closes and gives the keyboard back to returnTo`.
- [ ] **Step 3: Failing e2e** (`e2e/diagram-preview.spec.ts`, chromium + webkit): page with a ```mermaid graph and a `$$` block; click the diagram → source shows (unchanged behaviour); right-click → Preview → dialog with an `svg`; wheel up → percentage > 100%; drag → transform's translate changes; Escape → closed; in Focus mode, right-click → Preview → Escape closes the dialog and Focus mode stays on.
- [ ] **Step 4:** `npx vitest run src/features/preview` and `npx playwright test e2e/diagram-preview.spec.ts` — FAIL.
- [ ] **Step 5:** Implement.
- [ ] **Step 6:** Re-run both — PASS.
- [ ] **Step 7:** Commit `feat(preview): zoom and pan diagram preview`.

---

### Task 10: Full verification

- [ ] **Step 1:** From `apps/desktop`: `npm run typecheck && npm run lint && npm test && npm run check:i18n && npm run test:e2e`; from `src-tauri`: `cargo test`. All green.
- [ ] **Step 2:** Manual check on macOS via `npm run tauri dev`: ⌥⌘Z enters (animated full screen, no immediate exit), Escape twice leaves, green button while focused leaves Focus mode, View → Toggle Focus Mode works; right-click a Mermaid diagram → Preview, pinch-zoom on the trackpad and drag work.
