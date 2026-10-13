# M2a — Editor: Hand-off

Written for whoever continues by hand. It says what exists, where it lives, how
to run and check it, what was decided on your behalf, and what still needs a
person in front of the real window.

Spec: `docs/superpowers/specs/2026-10-12-m2a-editor-design.md` ·
Plan: `docs/superpowers/plans/2026-10-12-m2a-editor.md`

---

## 1. Status at a glance

| Area | State |
|---|---|
| Markdown model (`src/markdown/`): parse, extensions, frontmatter, sanitizer, incremental re-parse | done, tested (unit + TS/Rust parity fixtures + seeded fuzz vs full parse) |
| Backend: `page_read`, `page_write` (CAS + conflict payload), `page_create_conflict_copy`, `links_resolve`, `url_open`, `file_open_external` | done, async, ACL-tested |
| `nimw-asset:` protocol (vault files for `<img>/<audio>`) | done, tested (types, traversal, hidden files, ranges, no vault) |
| Page documents: autosave 500 ms, retry 1 s→30 s, 3-way merge, conflict copies, rename follow, deleted-while-dirty, quit flush | done, tested |
| Editor: Live Preview / Source / Split, scroll sync, ⌘-click / Mod-Enter links | done, tested in jsdom |
| Rendered pane: all node types, embeds, callouts, columns, privacy placeholders | done, tested (+ axe) |
| Page header: breadcrumb, cover (read-only), mode toggle, save status | done, tested (+ axe) |
| M1b polish a–f, j | done, tested |
| Zero-network e2e (Playwright, production CSP, frozen prototypes) | done, mutation-checked |
| Real-window checks (§9) | **need you** |

Totals at the end: 253 vitest tests (38 files), 4 Playwright tests, 176 cargo
tests; eslint, prettier, tsc, i18n parity, clippy `-D warnings`, rustfmt and
`cargo deny` all clean.

## 2. How to run

| What | Command (repo root) |
|---|---|
| Everything (the CI gate) | `pnpm check` |
| UI unit tests | `pnpm test` |
| Zero-network test | `pnpm --filter @nimw/desktop exec playwright install chromium` once, then `pnpm test:e2e` |
| Rust | `pnpm build:ui && cargo test --workspace` |
| App (dev) | `pnpm dev` |

`cargo test -p nimw-desktop` needs `apps/desktop/dist` (run `pnpm build:ui`
first). `NIMW_TRASH_TESTS=1` stays for CI only (it uses the real OS Trash).

## 3. Backend map (`apps/desktop/src-tauri/src/`)

| File | What it does |
|---|---|
| `editor_commands.rs` | The six M2a commands. Each is `*_impl(&AppState, …)` plus an `async` wrapper through `vault_commands::blocking` (never on the UI thread). |
| `asset.rs` | `nimw-asset:` — `serve(&AppState, uri_path, range)` resolves through the current session's `VaultPath` (no `..`, no absolute paths, no symlink escapes), refuses hidden files and the root (403), 404 without a vault, `Range` → 206/416. |
| `lib.rs` | Registers the opener plugin (Rust API only), the protocol (on a thread) and the commands. |
| `error.rs` | `ErrorKind::{Binary, InvalidUrl}`; `CommandError.conflict` flattens `{currentText, currentHash}` into a `conflict` error. |
| `settings.rs` | `editorMode: livePreview \| source \| split` (unknown value → default + warning). |
| `vault_commands.rs` | `vault_open` no longer fails when recents can't be saved: the failure becomes an index warning. |
| `crates/nimw-session/src/editing.rs` | `write_page` (CAS + reindex + resolve), `create_conflict_copy` (`<stem> (conflict).md`, `(conflict 2)`…), `resolve_links`. |

Permissions (`capabilities/main.json`): `allow-page-read`, `allow-page-write`,
`allow-page-create-conflict-copy`, `allow-links-resolve`, `allow-url-open`,
`allow-file-open-external`, `core:window:allow-destroy` (the UI closes the
window itself after saving). No `opener:*` permission: the webview cannot call
the opener plugin; `plugin:opener|open_url` is "not allowed" (tested).

CSP: `img-src`/`media-src` allow `nimw-asset: http://nimw-asset.localhost`
(instead of Tauri's `asset:`); nothing else changed.

## 4. Frontend map (`apps/desktop/src/`)

| Path | What it does |
|---|---|
| `markdown/parse.ts` | `parsePage(text)` → `ParsedPage {tree, frontmatter, links, tags, comments}`; `parseTree`, `finishPage` for the incremental path. |
| `markdown/incremental.ts` | `reparse(prev, prevText, text)`: re-parses only the touched top-level blocks (± one neighbour) when they are blank-line separated; anything non-local (fences, HTML, comments, definitions, directives, frontmatter, adjoining lists) → full parse. Takes ownership of `prev`. |
| `markdown/blocks.ts`, `inline.ts`, `wikilink.ts`, `frontmatter.ts` | Extensions: callouts, columns, `%%` comments; wikilinks, embeds, highlights, tags. |
| `markdown/sanitize.ts` | `toSafeHast(page, {sourcePath})`: mdast → hast → raw HTML parsed → `hast-util-sanitize` allowlist → URL policy (remote media → `remote-blocked`, vault paths → `dataAssetPath`, escaping paths → `missing`, links classified) → heading ids. |
| `markdown/section.ts` | `sectionOf(tree, heading)` for `![[Note#Heading]]`. |
| `features/editor/pageDoc.ts` | `PageDoc`: one open page — text, merge base, hash, save loop, merge, conflict copy, orphaning, Save as new. |
| `features/editor/merge.ts`, `eol.ts` | `merge3` (node-diff3, line based); CRLF kept on disk, LF in the editor. |
| `features/editor/Editor.tsx` | The CodeMirror view; per-page `EditorState` (undo survives page and mode switches); external text applied outside history; Split pane + scroll sync. |
| `features/editor/livePreview.ts`, `widgets.tsx` | Decorations from the model; block widgets render `<Preview embedded>`; checkboxes toggle the source; reduced set above 200 KB; ⌘-click / Mod-Enter follow links. |
| `features/preview/` | `Preview` (debounced 150 ms, incremental parse, memoized body), `renderHast`, `Embed`, `Callout`, `useResolved`. |
| `features/page/` | `PageView`, `PageHeader`, `Breadcrumb`, `ModeToggle`. |
| `features/dialogs/LinkDialogs.tsx` | Create page / open in browser / open in default app confirmations. |
| `stores/editorStore.ts` | Current + background `PageDoc`s, conflict toast with "Open", `saveAll`/`reset`, quit guard. |
| `stores/navigate.ts`, `stores/links.ts` | `openPage(path, heading)`, `openNewPage`; `followLink(action)`. |

## 5. Flows

- **Typing:** CodeMirror update → `PageDoc.edit` → 500 ms (at once when the editor loses focus) → `page_write(path, text, expectedHash)` → new hash → `pageStore.refresh()` (header) because the watcher does not report own writes.
- **External change:** watcher → `vault:changed` → `vaultStore` (100 ms coalesce) → `pageStore.onExternalChange` → `editorStore.onExternalChange` → `PageDoc.sync()` → reload (clean) / merge / conflict copy → `doc.sink` applies the text to CodeMirror synchronously, outside the undo history.
- **Write conflict:** `page_write` → `conflict {currentText, currentHash}` → same merge path, no extra read.
- **Vault switch / close:** `editorStore.saveAll()` first; if a page still can't be written, the switch is refused with a toast (text never dropped).
- **Quit:** `tauri://close-requested` → `flushAll(2000)` → `window.destroy()`.
- **Links:** pane/widget click or ⌘-click/Mod-Enter → `followLink` → open page (+ heading) · create-page dialog · external-link dialog → `url_open` · file dialog → `file_open_external`.

## 6. Recipes

- **New Markdown extension:** add the node type to `markdown/types.ts`, produce it in `blocks.ts`/`inline.ts`, render it in `sanitize.ts` handlers + `features/preview/renderHast.tsx`, decorate it in `livePreview.ts`; if it has non-local reach, add its marker to `NONLOCAL` in `incremental.ts`; add a parity fixture if Rust indexes it.
- **New backend command:** follow M1b hand-off §6 (build.rs list, capability, `*_impl` + async wrapper, ACL test in `tests/commands.rs`).

## 7. Tests inventory (new in M2a)

| File | Covers |
|---|---|
| `src/markdown/*.test.ts` | parse, blocks, sanitizer, section, incremental (fuzz + 5,000-line < 50 ms), parity with Rust |
| `src/features/editor/*.test.ts(x)` | PageDoc, merge/EOL, Live Preview, Editor, scroll sync |
| `src/features/preview/Preview.test.tsx` | node types, links, embeds, remote placeholders, axe |
| `src/features/page/*.test.tsx` | header, breadcrumb, modes, save status, orphan, axe |
| `src/stores/editorStore.test.tsx` | page switch mid-save, background retry, rename follow, delete, conflict toast, quit flush |
| `src/features/shell/Polish.test.tsx` | M1b polish a–f |
| `src/theme/palette.test.ts` | palette contrast ≥ 4.5:1 in light and dark |
| `tests/syntax-target.test.ts` | lint rule: no regex lookbehind |
| `e2e/zero-network.spec.ts` | zero requests + zero CSP violations, three modes |
| `src-tauri/tests/{commands,asset,settings}.rs`, `crates/nimw-session/tests/editing.rs`, `crates/nimw-markdown/tests/parity.rs` | backend |

## 8. Rulings made on your behalf (deviations from the spec)

1. **Own `nimw-asset:` protocol instead of Tauri's asset protocol + scope.** Tauri's scope can only add directories (no revoke), so a previous vault would stay readable. The protocol resolves every request through the current session instead. Spec §2.5/§7 "scope set on open and revoked on close" is met by construction and tested ("no vault → 404").
2. **Opening URLs/files through our own commands** (`url_open`, `file_open_external`, scheme-checked in Rust) instead of granting `opener:allow-open-url` to the webview. Smaller attack surface; same behaviour.
3. **`hast-util-sanitize` instead of DOMPurify:** it works on the tree, so source positions survive (Split scroll sync, M4 dragging). `dompurify` is not a dependency.
4. **Container directives only** (`:::name`), not the text form, which would turn `3:2` into a directive.
5. **Incremental re-parse** (`markdown/incremental.ts`): a full remark parse of a 5,000-line note takes ~110 ms, so the spec's "< 50 ms" needs it. Equivalence with the full parse is fuzz-tested.
6. **Switching or closing the vault with a page that can't be saved is refused** (toast), so text is never dropped.
7. **`core:window:allow-destroy`** added for the save-before-quit flow (Tauri's `onCloseRequested` destroys the window itself).
8. **No regex lookbehind** (lint rule): the build targets Safari 15 (WKWebView, macOS 12).
9. Versions: `@codemirror/language` 6.13.1, `@codemirror/view` 6.43.14 (pnpm's release-age gate resolved them); `@playwright/test` 1.64.0.

## 9. Needs the real window (you)

Agent screenshots must be launch-only (no synthetic keystrokes). Please check:

1. Typing feel in Live Preview (cursor never jumps; markup appears on the cursor line only).
2. IME input (e.g. Japanese/accents with dead keys) in Live Preview and Source.
3. Mode toggle; Split scroll sync both ways.
4. Edit the open page in another editor while typing (merge; overlapping edit → conflict copy toast → "Open").
5. Breadcrumb: folder segment reveals and focuses the folder; vault segment collapses the tree.
6. ⌘-click a link; Mod-Enter; unresolved link → Create page; external link → browser after confirmation.
7. A page with remote images: "Remote image blocked (privacy)" placeholder.
8. Images and audio from the vault (`nimw-asset:`) play/show; audio seeking (ranges).
9. Quit with unsaved text (⌘Q right after typing): the text is on disk.

## 10. Known gaps / deferred

| # | Gap | Target |
|---|---|---|
| a | Raw HTML blocks show as source in Live Preview (rendered in Split) | M2b |
| b | Large notes (> 200 KB) also re-parse fully if they contain fences/HTML/comments | later perf |
| c | Mixed line endings in one file are normalised to the first one on save | later |
| d | Cover editing, attachments, `[[` autocomplete | M2b |
| e | Header title updates after each save, not per keystroke | later |
| f | One giant paragraph (no blank lines) is slow to parse: a 200 KB single paragraph takes ~1.4 s to parse and ~2.1 s to open in Live Preview (jsdom), against ~0.35 s for 200 KB of normal paragraphs | later perf |
| g | On a busy machine the default vitest worker count can hit worker-start timeouts (CPU time stays ~40 s while wall time grew to 270 s); `pnpm exec vitest run --maxWorkers=2` is a workaround | watch in CI |

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Images don't show | `tauri.conf.json` CSP must list `nimw-asset: http://nimw-asset.localhost` in `img-src`/`media-src` |
| "not allowed" on a new command | `build.rs` list + `capabilities/main.json` + ACL test |
| `pnpm test:e2e` can't find a browser | `pnpm --filter @nimw/desktop exec playwright install chromium` |
| e2e fails with `csp:`/violations | something reached the DOM with a remote URL: the sanitizer, not the CSP, must stop it |

## 12. Next steps

1. Your real-window pass (§9); note anything odd in a new hand-off section.
2. **M2b:** covers/subtitle editing, paste/drop attachments, `[[` autocomplete.
3. M3 Global View (reuse `Breadcrumb`).
