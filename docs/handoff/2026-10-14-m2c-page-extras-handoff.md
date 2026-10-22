# M2c — Page extras: Hand-off

**Spec:** `docs/superpowers/specs/2026-10-14-m2c-page-extras-design.md` (§12: decisions taken for the maintainer without review; §13: amendments from planning) · **Plan:** `docs/superpowers/plans/2026-10-14-m2c-page-extras.md` (replayed end to end on a scratch clone before execution)
**Branch:** `feat/m2c-page-extras` (from `main` `2de6d7b`). Previous hand-off: `docs/handoff/2026-10-13-m2b-editor-ux-handoff.md`.

**How this milestone was made.**
1. The maintainer agreed the scope, the extras and part 1 of the design (UI and behaviour) on 2026-10-13.
2. The request was then to build the remaining features and review them in bulk later.
3. Everything from the backend design onward was decided on his behalf:
   - each decision is listed in spec §12 and §13, and summarised in §8 below;
   - nothing is merged into `main` until he has checked it in the real window (§9).

## 1. Status at a glance

| Area | State |
|---|---|
| Cover: add (Rust-opened file dialog), change, reposition (drag + slider keys), remove; placeholders for remote/missing covers; read-only when the page can't be edited | done, tested |
| Subtitle: in place under the title (Enter/blur commit, Escape reverts, app switch doesn't commit, empty removes the key) | done, tested |
| Frontmatter edits from the header: undoable (⌘Z), byte-minimal (only the touched keys' text changes), CRLF kept, invalid YAML refused | done, tested |
| Paste an image → `Pasted image YYYYMMDDHHmmss.png` in the attachments folder + `![[…]]` | done, tested |
| Drop files from Finder → copied (or linked when already in the vault) at the drop point; Retina coordinates; folders refused | done, tested (synthetic drag-drop events) |
| Attachment location: Obsidian's `attachmentFolderPath` wins, else `.liber/vault.json`, else `attachments/` next to the page; Settings → This vault | done, tested |
| `[[` / `![[` autocomplete (Rust ranking, PG-05 alias rule, `#` headings, `]]` handling) | done, tested |
| ⌘K / Link button → "Link to…" picker (`[[Page\|selection]]` or `[text](url)`) | done, tested |
| "Create page" for `[[Folder/Name]]` creates the folders | done, tested |
| Raw HTML blocks rendered in Live Preview (sanitized; comments stay visible, muted) | done, tested |
| E2E in Chromium and WebKit | done |
| Final review (opus) + fix pass (§13): 2 Critical, 3 Important, 8 upgraded minors fixed test-first | done |
| Real-window checks (§9) | **need you** |

Totals after the fix pass: **548 vitest tests (59 files)**, **47 Playwright tests** (Chromium + WebKit; 14 new), **219 cargo tests** (215 + 4 main-thread menu checks); eslint, prettier, tsc, i18n parity, clippy `-D warnings`, rustfmt and `cargo deny` clean.

## 2. How to run

| What | Command (repo root) |
|---|---|
| Everything (CI gate) | `pnpm check` |
| UI unit tests | `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2` |
| E2E (both engines) | once: `pnpm --filter @liber/desktop exec playwright install chromium webkit`; then `pnpm test:e2e` |
| App (dev) | `pnpm dev` (Rust changed in this milestone: restart it) |
| i18n check | `pnpm check:i18n` needs Node ≥ 22.18 (`.nvmrc` says 24) |

## 3. Backend map

| File | What it does |
|---|---|
| `crates/liber-vault/src/config.rs` | `AttachmentPolicy` (VaultRoot / Folder / SameAsNote / Subfolder), precedence Obsidian → Liber Linteum → default, re-read on every use; Liber Linteum setting writes into `.liber/vault.json` (unknown keys kept, created lazily) |
| `crates/liber-vault/src/fsops.rs` | `create_dir_all` (each name checked), streamed create-only `import_file` (hidden temp → rename, never overwrites) |
| `crates/liber-index/src/{rows,index}.rs` | `link_candidates()` for suggestions |
| `crates/liber-session/src/attachments.rs` | `save_attachment` (paste bytes), `import_attachment` (dropped/picked files; inside-vault → link only), `sanitize_file_name` (`-` for refused characters, leading dot included), `cover_reference` (relative inside the page's folder, else `/…`), `link_suggest` ranking, vault settings |
| `apps/desktop/src-tauri/src/attachment_commands.rs` | `attachment_paste` (raw IPC body, headers `x-liber-page`/`x-liber-name`, 64 MiB cap), `attachment_import(page, paths)`, `cover_pick(page)`, `link_suggest(source, query, embed)`, `vault_settings_get`, `vault_settings_set(patch)` |
| `apps/desktop/src-tauri/src/drops.rs` | Drop grants: paths seen in native drag-drop events (window and webview), valid 2 min, consumed on import, ≤ 1000 |
| `apps/desktop/src-tauri/src/{state,dto,error}.rs` | `FilePicker` hook (tests inject a fake), `coverY` on `PageDto`, error kinds `tooLarge` / `notPermitted` / `notAFile` |

## 4. Frontend map (`apps/desktop/src/`)

| File | What it does |
|---|---|
| `markdown/frontmatterEdit.ts` | Byte-minimal frontmatter edits (yaml Document ranges); creates/removes the block; refuses invalid YAML |
| `markdown/headings.ts`, `markdown/section.ts` | Link-safe heading text and `sameHeading` matching (anchor scroll, `![[Page#Heading]]`) |
| `stores/editorStore.ts`, `features/editor/views.ts` | `editFrontmatter(patch)` (undoable dispatch to the live view, flush after), live-view registry, `copying` status |
| `features/page/Cover.tsx`, `PageSubtitle.tsx`, `PageHeader.tsx` | Header cover and subtitle |
| `features/editor/attachments.ts` | Paste handler, drag-drop listener, drop caret, mapped insertion point |
| `features/editor/linkComplete.ts` | `[[` / `![[` / `#` completion source (async, `link_suggest`) |
| `features/editor/LinkPicker.tsx`, `linkPickerOpen.ts` | ⌘K / Link button picker |
| `features/editor/livePreview.ts` | HTML block widgets |
| `features/dialogs/LinkDialogs.tsx` | Create page with folders |
| `features/dialogs/VaultSettingsSection.tsx` | Settings → This vault |

## 5. Flows

- **Cover upload:**
  1. Add cover / Change cover → `cover_pick(page)`.
  2. Rust opens the dialog (images only) and imports the chosen file into the attachments folder (or links it, if it's already in the vault).
  3. Rust returns `{ path, reference }`.
  4. `editorStore.editFrontmatter({ cover: reference, 'cover-y': null })` dispatches an undoable change, then flushes.
  5. `pageStore` refreshes on the new hash, and the header shows the cover.
- **Paste:**
  1. CodeMirror's paste handler checks for an image file with no `text/plain`.
  2. It calls `attachment_paste` with the raw bytes.
  3. It inserts `![[link]]`.
  4. It calls `refreshTree()`, because the watcher doesn't report the app's own writes.
- **Drop:**
  1. Native drop: Rust records the grants.
  2. `tauri://drag-drop` reaches the page with the paths and physical position.
  3. The page divides by `devicePixelRatio`, then `posAtCoords` (falling back to the cursor).
  4. It calls `attachment_import(page, paths)`, which refuses ungranted paths.
  5. It inserts at the mapped position: `![[…]]` for media, `[[…]]` otherwise, one per line.
  6. It calls `refreshTree()`.
- **Autocomplete:**
  1. `[[` → `link_suggest` (Rust: candidates, ranking, shortest unique target).
  2. The option list appears.
  3. Accepting it writes `target`, or `target|Title` when the title differs, then `]]` unless one already follows.
- **Headings:** `[[Page#` → `links_resolve` + `page_read` (cached 5 s) → `parsePage` headings.

## 6. Recipes

- **Add an attachment mode:** extend `AttachmentPolicy`, `from_obsidian`, `dir_for`, the Liber Linteum JSON mode names, `VaultSettingsSection` options and the i18n strings, plus tests in `crates/liber-vault` and `tests/attachments.rs`.
- **Add an embeddable extension:** update the media list in `features/editor/attachments.ts` (embed vs link), plus the preview renderer if it needs a new element.

## 7. Tests inventory (new in M2c)

| Layer | Files |
|---|---|
| Rust crates | `crates/liber-vault/tests/attachments.rs` (policy precedence, folder creation, streamed create-only import), `crates/liber-vault/tests/open_scan.rs`, `crates/liber-session/tests/attachments.rs` (save/import, dedupe, sanitizing, inside-vault links, suggestions + PG-05 alias, vault settings) |
| Commands (real ACL) | `apps/desktop/src-tauri/tests/commands.rs` (all six commands allowed from main / denied elsewhere; raw-body paste; fake cover picker; granted vs ungranted drops; outside-folder cover is vault-rooted; hidden/missing page refused), `tests/errors.rs` (new kinds) |
| TS | `markdown/frontmatterEdit.test.ts` (incl. a 14×27 sweep: every edit reads back exactly or is refused), `markdown/section.test.ts`, `stores/editorStore.test.tsx` (undo, CRLF, typing + header edit, refusal toast), `features/page/Cover.test.tsx`, `PageView.test.tsx`, `features/editor/attachments.test.tsx` (paste, drop, Retina vs Windows coordinates, text drags, pending drops, page switch), `linkComplete.test.tsx`, `LinkPicker.test.tsx`, `livePreview.test.ts` (HTML widgets), `features/preview/Preview.test.tsx`, `features/dialogs/LinkDialogs.test.tsx`, `SettingsDialog.test.tsx` (This vault), `ipc/attachments.test.ts`, `theme/cssCompat.test.ts` (no `:focus-visible` in shared selector lists) |
| E2E | `e2e/m2c.spec.ts`: cover add/reposition/remove, subtitle, paste, drop (2× screen), `[[` alias, ⌘K picker, Create page with folders — Chromium + WebKit |

## 8. Decisions taken for you (review in bulk)

These come from spec §12 (design part 2) and §13 (planning):
- **Drop security:** only paths Rust saw in a native drop can be imported. Covers come through a dialog Rust opens itself. Paste sends bytes, never paths.
- **Autocomplete ranking and shortest-link computation** run in Rust, with at most 50 rows per keystroke.
- **Cover reference:** relative inside the page's folder, else vault-rooted `/…`.
- **Header edits** save at once. Frontmatter edits change only the touched keys' text: re-serialising the YAML reformatted other keys.
- **Attachment policy** is re-read on every use. Obsidian's setting wins and is shown read-only.
- **Names:** refused characters in dropped and pasted names become `-`. The paste cap is 64 MiB; drops have no cap (streamed).
- **Create page with folders** uses the existing commands. A leading `/` also means "from the vault root".
- **HTML comments** in Live Preview stay visible, muted.
- **Dropped Markdown files** are copied, indexed as pages and linked as `[[name]]`.
- **New error kind:** `notAFile`, for a dropped folder.
- **Reposition** is a slider (↑ raises `cover-y`; PageUp/PageDown ±20; Enter saves; Escape cancels).
- **Heading links** use link-safe text, and anchor/section lookups match it through `sameHeading`.
- **Paste with text:** a clipboard that also has plain text pastes as text.

## 9. Needs the real window (you)

1. Drop 1 and then 3 files from Finder into Live Preview, Source and Split: the caret follows the pointer and the files land where dropped (Retina).
2. Paste a screenshot (⌘⇧⌃4, then ⌘V).
3. Add a cover through the dialog; change, reposition (drag and keys) and remove it; delete its image in Finder and check the placeholder.
4. Edit the subtitle; click into the text, then ⌘Z undoes cover and subtitle edits; switching apps mid-edit doesn’t commit.
5. `[[` and `![[` autocomplete on the test vault; `[[Page#` headings; an alias inserted for a page whose H1 differs from its file name.
6. ⌘K with a selection → pick a page → `[[page|selection]]`; type a URL → `[selection](url)`.
7. `[[New folder/New page]]` → Create page.
8. Settings → This vault: change the mode; in a vault with Obsidian's setting, it shows read-only.
9. Open the vault in Obsidian: links, embeds and covers resolve, and `.liber/vault.json` keeps its other keys.
10. Which native drop event fires (window vs webview): both are handled, and the reviewer couldn't check it.
11. Drag a selected word to another place in the text: if it doesn't move, Tauri's native drag handling swallows in-editor drags (pre-existing, not M2c).
12. Paste an image copied from Preview or Photos (TIFF clipboards): whether it arrives as a PNG file.

## 10. Known gaps / deferred

| # | Gap | Target |
|---|---|---|
| a | Legacy `{"mode":"vault","path":"Files"}` (an M1a form nothing ever wrote) shows as "The vault root" in Settings | later |
| b | Link-safe heading characters may differ from Obsidian's (`:`, `\`, `%%`); please check `![[Page#Step 1: Setup]]`-style links in Obsidian | your Obsidian check |
| c | A dropped in-vault file named `a#b.png` is linked unsanitized | later |
| d | The heading-completion page cache never evicts; saving a reposition briefly snaps back; `" .png"` loses its extension | later |
| e | `.liber/vault.json` keys are re-sorted on the first Liber Linteum write (unknown keys kept) | later |
| f | Opening another vault before a copy finishes: the file is copied but not linked, silently | later |
| g | A page closed and reopened during a copy shows the link after its next save merges | later |
| h | `[text](url)` from the link picker doesn't escape unbalanced brackets in the selection | later |
| i | A BOM-prefixed note not starting with `---` gets its new block before the BOM | later |
| j | **Security, pre-existing (M1b):** `vault_open(path)` + `page_read` would let a compromised page read any folder; M2c's drop grants don't cover that path | hardening milestone (Rust-side folder-picker grant) |
| k | Out of scope by design: cover from vault images, drop onto the cover, remote covers, pasting Finder-copied files, Insert file…, image sizing UI, tag and `](` autocomplete, per-keystroke header updates | later |

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `pnpm check:i18n` fails with a syntax error | Node 20 is first on PATH; use Node 24 (`.nvmrc`) |
| A drop does nothing | `attachment_import` refused it: the path wasn't granted (drop older than 2 min, or the event wasn't seen); check that `on_window_event`/`on_webview_event` are registered in `configure` |
| `[[` list unstyled | the autocomplete theme must be a scoped `EditorView.theme`, not a base theme |
| An inserted embed doesn't resolve right away | the attachment must be reindexed before the command returns (`reindex_attachment`) |

## 12. Next steps

1. Your real-window check (§9), then a local merge into `main`.
2. **M3a, the Global View,** is being prepared on `feat/m3a-global-view`, stacked on this branch. Its spec is `docs/superpowers/specs/2026-10-14-m3a-global-view-design.md`.

## 13. Final review and fix pass

**Reviewer:** Opus, fresh context, on `babe247..3cb0cde`. Report: `.superpowers/sdd/2026-10-14-m2c-page-extras/final-review.md`, git-ignored and deleted when the branch merges, so the table below is the record.
- **Verdict:** not ready, with 2 Critical, 3 Important and 14 Minor findings.
- **The good news:** the drop-grant design is sound, and Review Focus items 2–5 held.
- **Re-grading:** re-graded by effect, 8 minors joined the fix pass. Fixes ran in three parallel worktrees, were cherry-picked, and every fix has a test that failed first.

| # | Finding | Fix | Test(s) |
|---|---|---|---|
| C1 | Drops landed at half the distance on Retina Macs (wry reports CSS pixels on macOS despite the type) | ÷ `devicePixelRatio` only on Windows (`dragPixelRatio`) | `attachments.test.tsx` "Retina Mac … as is" / "only Windows…"; e2e drop on a 2× screen (WebKit = macOS UA) |
| C2 | Header edits could write invalid YAML (`cover:` empty, block scalars, trailing comments) | rewrite non-simple pairs whole; re-parse and refuse unless it reads back exactly | `frontmatterEdit.test.ts` cases + 14×27 sweep |
| I1 | A paste/drop finishing after a page switch went into the other page | target page captured at start; late results go into that page's stored state/text | `attachments.test.tsx` ×4 |
| I2 | Create page refused existing folders with odd names (`C# notes/`) | validate only folders being created | `LinkDialogs.test.tsx` ×4 |
| I3 | Focus fell to `<body>` after Add/Remove cover | refocus Add/Change cover; Change stays mounted while loading | `Cover.test.tsx` ×5 |
| m2↑ | `...`-closed/BOM frontmatter got a second block prepended | refuse unconfirmed blocks | `frontmatterEdit.test.ts` ×3 |
| m3↑ | Every text drag showed the file-drop caret/toast | ignore drags without paths | `attachments.test.tsx` |
| m4↑ | A second drag moved a pending drop | per-drop mapped positions, separate from the caret | `attachments.test.tsx` ×2 |
| m5↑ | Tabbing through This vault created `.liber/vault.json` | save only real changes | `SettingsDialog.test.tsx` ×2 |
| m7↑ | Attachment commands accepted hidden pages (`.obsidian/x.md`) | require a visible, indexed page | `tests/commands.rs` `m2c_attachments_refuse_a_hidden_or_missing_page` |
| m8↑ | A cover picked during a page switch landed on the other page | drop the late result | `Cover.test.tsx` |
| m9↑ | Add cover invisible on WebKit < 15.4 (`:focus-visible` in a shared list) | split rules; guard test over all CSS | `cssCompat.test.ts` |
| m11↑ | `]]`/`|` in a ⌘K selection broke the link | link-safe alias, live selection | `LinkPicker.test.tsx` ×3 |
| — | The refusal toast blamed "invalid YAML" for valid YAML the guard refuses | "Liber Linteum can't safely change this note's frontmatter. Edit it in Source mode." | `editorStore.test.tsx` |

**Rulings made in the fix pass:**
- **⌘Z after a header edit:** with focus still in the subtitle or on a cover button, ⌘Z goes to that control. CodeMirror's undo works from the text (§9 item 4).
- **Text drag-move inside the editor:** this may be swallowed by Tauri's native drag handling (pre-existing). Check it in the real window.
- **A note that starts with a horizontal rule** is not refused.
