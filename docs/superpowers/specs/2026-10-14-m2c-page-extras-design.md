# M2c — Page extras: Design

**Status:**
- **Agreed with Jose on 2026-10-13:** scope, extras and part 1 of the design (UI and behaviour, §2–§6).
- **Choices:** cover picker "Upload only"; for attachments, Obsidian's setting wins when the vault has one.
- **Part 2** (backend, data flow, security, §7–§9) was written after Jose asked to "carry on with everything that's missing" and review features in bulk later. The decisions taken for him are listed in §12 so they can be reviewed together.

**Scope sources:** product spec PG-02, PG-03, PG-05, ED-03, ED-05, ED-06; architecture §3.1, §3.3, §5.3; deferred items M2a hand-off §10 a and k, and M2b hand-off §10 a.

---

## 1. Goal and success criteria

Make a page feel finished: a cover, a subtitle, pasted screenshots, dropped files, and links you can find without remembering file names. Everything NIMW writes stays readable and resolvable in Obsidian.

1. **Cover:** add (upload), change, reposition and remove a cover from the page header. It is stored as frontmatter `cover:` and `cover-y:`.
2. **Subtitle:** edited in place under the title and stored as frontmatter `subtitle:`.
3. **Paste and drop:**
   - Pasting an image saves it into the vault and inserts an embed.
   - Dropping files from Finder copies them into the vault and inserts embeds or links at the drop point.
   - The attachment location is configurable per vault and honours Obsidian's `attachmentFolderPath`.
4. **Autocomplete:**
   - `[[` and `![[` suggest vault files by title and name, and `#` suggests headings.
   - ⌘K and the Link button get a "Link to…" picker that can make a `[[Page]]` link.
5. **"Create page"** for an unresolved `[[Folder/Name]]` creates the folders too.
6. **Raw HTML blocks** render in Live Preview, sanitized as in Split.

**Non-negotiables carried over:**
- no network (P1, NFR-04; the zero-network e2e is extended to these flows);
- every command async via `blocking()`, with a real-ACL test in `tests/commands.rs`;
- i18n en + es parity; axe-clean;
- Safari 15 floor: no regex lookbehind, no `color-mix`;
- undo through CodeMirror history (ED-07);
- opening a vault writes nothing (VLT-02): `.nimw/vault.json` and attachment folders are created only on first need.

---

## 2. Page header: cover (`features/page/Cover.tsx`, new)

- **With a cover:** a 200 px band at the top of the header.
  - The image uses `object-fit: cover` and `object-position: 50% <cover-y>%`, with 50 when `cover-y` is absent.
  - The **Change cover**, **Reposition** and **Remove** buttons sit at the band's bottom right. They show on hover and on `:focus-within`, and are always in the Tab order.
- **Change cover and Add cover** call `cover_pick(page)` (§7.4). Rust opens the native file dialog filtered to images and copies the file into the attachments folder. Then:
  - the frontmatter gets `cover: <reference>` and loses `cover-y:`;
  - cancelling the dialog does nothing.
- **The `<reference>`** is relative to the page's folder when the file lies inside that folder or below it (`attachments/x.png`). Otherwise it is vault-rooted (`/Images/x.png`). Both resolve with the existing path-style cover resolution (arch §3.3) and read naturally in Obsidian.
- **Remove** deletes `cover:` and `cover-y:`. The image file stays in the vault.
- **Reposition** enters a mode:
  - the cursor becomes `ns-resize`;
  - dragging moves the visible slice (pointer delta divided by the image's overflow height, as a percentage);
  - ↑ and ↓ move it 5%;
  - **Save position** writes `cover-y: <0–100 integer>`; **Cancel** or Escape restores it.
  - The band has `aria-label="Cover position"`, and a polite live region announces the percentage.
- **Covers that can't be shown** get a placeholder band in the same place, with Change and Remove:
  - a remote cover (URL) says "Remote cover not loaded (privacy)";
  - a missing file says "Cover image not found".
- **Without a cover:** an **Add cover** button above the title. It shows on header hover and focus, and is always in the Tab order.
- **When editing is unavailable** (binary, truncated or not-yet-loaded pages, i.e. `editorStore.doc === null`), the cover shows read-only with no buttons.

## 3. Page header: subtitle (`features/page/PageSubtitle.tsx`, new)

- **The field:** a single-line field under the title, styled like the current subtitle `<p>`. It has the accessible name "Subtitle" and shows the placeholder "Add a subtitle" only on hover or focus when empty.
- **Commit and cancel** behave as for the title (M2b §2, final-review m6):
  - Enter, or a real blur, commits;
  - a blur caused by the window losing focus (`!document.hasFocus()`) does not commit;
  - Escape restores the value and keeps focus.
- **What a commit writes:**
  - trimmed text goes to `subtitle:`;
  - empty text removes the key;
  - an unchanged value is a no-op.
- **Line breaks:** a newline can't be typed, and pasted newlines become spaces.

## 4. Frontmatter edits (`markdown/frontmatterEdit.ts`, new; `stores/editorStore.ts`)

- **The edit function:** `setFrontmatter(text, patch) → TextChange | null`, where `patch` is `Record<string, string | number | null>` and `null` means delete. It uses the `yaml` Document API (`parseDocument`):
  - other keys, their order, comments and quoting stay untouched;
  - the line ending follows the file's existing line ending.
- **When the note has no frontmatter,** the function creates `---\nkey: value\n---\n` at the top.
- **When the patch empties the frontmatter,** the whole block is removed.
- **Invalid YAML is refused:** the function returns `null` and the UI shows a toast: "Fix the note's frontmatter first (it isn't valid YAML)". The user's text is never rewritten.
- **The change is minimal:** it spans only the frontmatter block.
- **Undo:** `editorStore.applyEdit(path, change)` dispatches the change to the live `EditorView` of that page as a normal transaction (`userEvent: 'input.frontmatter'`), so it joins the undo history (ED-07).
  - The view is registered by `Editor.tsx` in a module-level `viewOf: Map<PageDoc, EditorView>`, set on mount and swap and cleared on unmount.
  - With no live view, the change goes through `PageDoc.edit`, which isn't undoable but is never lost.
  - After a header edit the page is flushed at once, so `pageStore.watchSaves` refreshes the header from `page_get` without waiting for the autosave debounce.
- **The DTO change:** `PageDto` gains `coverY: number | null` (from `pages.cover_y`), and the TS `Page` type gains the same field.

## 5. Paste and drop (`features/editor/attachments.ts`, new)

### 5.1 Paste

- **What counts:** a paste whose clipboard has an image file (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) and no `text/plain`. The handler is a CodeMirror `domEventHandlers.paste`.
- **Saving:** it calls `attachment_paste` (§7.3) with the bytes, the page path and the name `Pasted image YYYYMMDDHHmmss.<ext>` (local time, Obsidian's naming; `jpeg` becomes `jpg`).
- **Inserting:** `![[<link>]]` replaces the selection.
- **Other pastes:** any other paste, text included, is left to CodeMirror unchanged.

### 5.2 Drop

- **Source of drops:** Tauri's native file-drop events (`dragDropEnabled` stays at its default). The page listens with `getCurrentWebview().onDragDropEvent`.
  - **`over`:** when the position is over the editor content, a drop caret (a 2 px accent bar widget) shows at `posAtCoords`. Elsewhere there is no caret.
  - **`drop` over the editor:** the page calls `attachment_import(page, paths)` (§7.3). Rust only accepts paths it saw in that native drop (§8).
    - Each result is inserted at the drop position.
    - Images (png, jpg, jpeg, gif, webp, avif, svg, bmp), `pdf`, audio (mp3, m4a, wav, ogg, flac) and video (mp4, mov, webm) become `![[<link>]]`; anything else becomes `[[<link>]]`.
    - Several files are joined by newlines.
    - The selection moves to after the insertion.
  - **`drop` elsewhere:** a toast says "Drop files onto the page's text to attach them".
  - **`leave`:** the caret is removed.
- **Coordinates:** the drop position is in physical pixels relative to the webview. Divide by `devicePixelRatio`.
- **Errors and progress:**
  - dropped folders are skipped, with the toast "Folders can't be attached";
  - per-file failures show one toast listing the names and the reason;
  - while copying, the save status reads "Copying files…".
- **Refresh:** after paste or drop the UI calls `vaultStore.refreshTree()`, because the watcher doesn't report the app's own writes.

### 5.3 Where files go (`nimw-vault` `AttachmentPolicy`)

- **Precedence:** Jose's choice, which reverses the M1a order.
  1. Obsidian's `attachmentFolderPath` in `.obsidian/app.json`, when the key is present.
  2. `.nimw/vault.json` `attachments`.
  3. The default `attachments/` subfolder next to the page.
- **The four modes:**
  - `vault`: the vault root;
  - `same`: the page's folder;
  - `subfolder`: a named subfolder next to the page (default `attachments`);
  - `folder`: a fixed vault folder (Obsidian's `assets` form).
- **Obsidian's values** map as today (`AttachmentPolicy::from_obsidian`).
- **Freshness:** the policy is re-read on every attachment save and on `vault_settings_get`. That's cheap: two small files. So an edit to Obsidian's or NIMW's config while the vault is open takes effect without reopening.
- **Folders:** the target folder is created on first save, including intermediate folders, each name checked with `validate_name`.
- **Names:**
  - a dropped file keeps its name;
  - a taken name becomes `name 1.ext`, `name 2.ext`, … (create-only writes; `AlreadyExists` retries the next number);
  - a name failing `validate_name` (e.g. `a:b.png`) has the bad characters replaced by `-`.
- **The `<link>`** in an embed is Rust's `shortest_unique_target` from the page to the new file: `Pasted image ….png`, or a longer path when the name is ambiguous. Extensions are kept for non-pages, and the result resolves back to the same file in NIMW and in Obsidian.
- **A dropped file that already lives inside the vault** (its canonical path is under the vault root) is not copied. Only its `<link>` is returned.

### 5.4 Settings → This vault (`SettingsDialog.tsx`)

- **The section:** a new section, "This vault", after Files, shown only while a vault is open. It contains "Attachments", a select with the four modes, plus a text field for the `subfolder` and `folder` modes. Changes are saved with `vault_settings_set`.
- **When Obsidian's setting exists,** the controls are disabled and show "Set by Obsidian: `<value>` — new attachments go to <plain-language description>", plus the hint "Change it in Obsidian (Settings → Files and links)".
- **Invalid input:** a subfolder name failing `validate_name`, or a folder failing `VaultPath`, shows an inline error and isn't saved.

## 6. Autocomplete and Link picker (`features/editor/linkComplete.ts`, `LinkPicker.tsx`, new)

- **Dependency:** `@codemirror/autocomplete` 6.20.3 becomes a direct dependency. It is the version already in the lockfile, so it passes the release-age gate.
- **Triggers:**
  - `[[` or `![[` before the cursor, with no `]]` or newline in between, opens a list of files;
  - text after `[[` up to the cursor is the query;
  - `#` in the query switches to headings (§6.2);
  - `|` in the query closes the list.
- **The completion source** is async. Each query calls `link_suggest(source, query, embed)` (§7.2), which returns up to 50 matches; stale results are dropped (CodeMirror aborts superseded queries).
- **Each option** shows the title (or name), with the vault path in a muted detail.
- **Ranking** (in Rust):
  1. exact name or title;
  2. prefix;
  3. word-start;
  4. substring;
  5. subsequence;
  6. ties broken by the shorter path, then by most recently modified.
  - For `[[`, pages come before other files; for `![[`, attachments come first.
  - An empty query lists the 50 most recently modified files.
- **Accepting** (Enter or Tab; ↑ and ↓ move; Esc closes) replaces the query with:
  - `target` for files and for pages whose title matches the name case-insensitively;
  - `target|Title` for pages whose title differs (PG-05);
  - followed by `]]`, unless `]]` already follows the cursor.
- **Modes:** completion works in Live Preview, Source and the source side of Split.

### 6.1 Example (PG-05 acceptance)

`rex-draft.md` has the H1 "Generator Rex". Typing `[[gen` offers "Generator Rex — rex-draft.md", and accepting it inserts `[[rex-draft|Generator Rex]]`.

### 6.2 Headings

- **Which page:** for `[[page#`, the TS side resolves the page part with `links_resolve(source, wiki)`, reads it (`page_read`, cached per target during one completion session) and lists its headings with `parsePage`. `[[#` lists the current page's headings from the live editor text.
- **The inserted text:** the heading text, with `[`, `]`, `|`, `#` and `^` replaced by spaces and runs of spaces collapsed. M2a's `#heading` scroll must find the result (test).
- **Filtering:** headings are filtered by a case-insensitive substring of the text after `#`.

### 6.3 Link picker (⌘K, Link button)

- **The picker:** a popover anchored at the selection (`coordsAtPos`). It has one combobox, "Link to…", using the ARIA combobox pattern with a listbox.
  - Its options are the `link_suggest` page results.
  - When the input parses as an `http:`, `https:` or `mailto:` URL, a first option "Link to <url>" appears.
- **Choosing a page:**
  - with a selection: `[[target|selected text]]`;
  - without one: `[[target]]`, or `[[target|Title]]` when the title differs.
- **Choosing a URL:**
  - with a selection: `[selected](url)`;
  - without one: `[url](url)`.
- **Escape** closes the picker and returns focus to the editor with the selection intact.
- **Keyboard:** the picker opens for ⌘K too (replacing M2b's `[text](url)` insertion; M2b §11.5 is superseded).

## 7. Backend (`apps/desktop/src-tauri/src/attachment_commands.rs`, new; `nimw-session`, `nimw-vault`)

**Rules for every new command:**
- registered in `build.rs` `COMMANDS`, `generate_handler!`, `capabilities/main.json` and the test `COMMANDS` list;
- async through `blocking()`;
- a real-ACL test in `tests/commands.rs`;
- errors use the existing `ErrorKind`, plus `TooLarge` and `NotPermitted` (new, mapped and translated in the UI).

### 7.1 Session additions (`crates/nimw-session`)

- **Attachment indexing:** `reindex_attachment(path, hash)`.
  - It upserts `files` with `FileKind::Attachment`, then runs `resolve_affected` on `link_key(path)`, so an inserted embed resolves immediately.
  - `reindex_written` keeps its Page-only behaviour.
- **Saving bytes:** `save_attachment(page: &VaultPath, name: &str, bytes: &[u8]) -> (VaultPath, link)`.
  - It resolves the policy (§5.3), creates the folders, then writes create-only (`write_cas(None)`) with name dedupe.
  - It reindexes and returns the path plus `shortest_unique_target(page → path)`.
- **Importing files:** `import_attachment(page, source_fs_path) -> (VaultPath, link, copied: bool)`.
  - If the canonical source is inside the vault root, it returns that file without copying.
  - Otherwise it streams a copy into a hidden temp file in the target folder, `sync_all`s it, then renames create-only. It never overwrites; on a clash it moves to the next name.
  - It refuses directories, and anything that isn't a regular file after following symlinks.
- **Vault settings:**
  - `vault_settings()` returns `{ attachments: {mode, path}, obsidian: Option<String> }`;
  - `set_vault_settings(patch)` writes `.nimw/vault.json` through the vault's atomic write (hidden path, not indexed). It preserves unknown keys, creates `.nimw/` lazily and refreshes the in-memory policy.

### 7.2 `link_suggest(source: String, query: String, embed: bool) -> Vec<LinkSuggestion>`

- **The result type:** `LinkSuggestion { path, kind: "page" | "attachment", title: Option<String>, target: String, mtime }`.
- **Candidates:** `Index::tree()` without folders, with titles.
- **Ranking:** scoring per §6.
- **`target`:** `shortest_unique_target(path, source, files, Wiki, rooted=false)`, computed only for the returned (at most 50) rows.
- **Matching:** names are compared without `.md`, case- and Unicode-insensitively (`name_key`).

### 7.3 Attachments

- **`attachment_paste`** takes the raw IPC body (`tauri::ipc::Request`, `InvokeBody::Raw`).
  - The headers are `x-nimw-page` (percent-encoded vault path) and `x-nimw-name` (percent-encoded file name).
  - The body is capped at 64 MiB (`TooLarge`).
  - The extension must be one of png, jpg, gif or webp (`InvalidName`).
  - It returns `{ path, link }`.
- **`attachment_import(page: String, paths: Vec<String>)`** returns one `{ source, ok: { path, link, copied } | err: CommandError }` per path. Each path must be granted by a native drop (§8), else `NotPermitted`.

### 7.4 `cover_pick(page: String) -> Option<{ path, reference }>`

- **The dialog:** Rust opens the native file dialog through the dialog plugin's Rust API (`app.dialog().file().add_filter("Images", […]).blocking_pick_file()` on the blocking pool). The page never sees or supplies a path.
- **The result:** the chosen file is imported as in §7.1 (inside the vault: no copy). `reference` is the frontmatter cover reference (§2).
- **Tests:** they inject a `FilePicker` (a state trait; the real one uses the dialog plugin, the test one returns a fixture path or `None`).

### 7.5 `vault_settings_get() / vault_settings_set(patch)`

- **The patch:** `{ attachments: { mode: "vault"|"same"|"subfolder"|"folder", path?: string } }`.
- **Validation:** `subfolder` must pass `validate_name`, and `folder` must pass `VaultPath`.
- **When Obsidian's key is present,** `set` is refused (`NotPermitted`), since Obsidian wins.

### 7.6 Create page with folders (`LinkDialogs.tsx`, UI only)

- **Wiki targets with `/`** (`[[Ideas/New idea]]`) create `Ideas/New idea.md` from the vault root. A leading `/` is stripped.
- **Markdown link targets** are already vault-joined, so they are used as is.
- **Targets without `/`** keep M2a's rule: next to the linking page.
- **Missing folders** are created one by one with `entry_create_folder`, in order, after each name passes `validateName`, then `entry_create_page` creates the page. An invalid component shows the dialog's inline error; nothing is created.
- **The dialog** says "Create page 'New idea' in Ideas/?" when folders are involved.

### 7.7 Raw HTML in Live Preview (`livePreview.ts`)

- **Which nodes:** root-level mdast `html` nodes (flow HTML) become block `PreviewWidget`s, like tables, unless the selection touches them. Inline HTML inside a paragraph stays as text.
- **Empty results stay as source:** an HTML node whose sanitized render is empty (comments, `<script>`-only) keeps showing its source, styled `cm-nimw-frontmatter`-muted, so nothing silently disappears.

## 8. Security

- **Paths from outside the vault enter only through Rust-observed native events:**
  - **Drop grants:** `configure` registers `.on_window_event`. For `WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. })` it records the paths in `AppState.drop_grants`:
    - each grant is valid for 2 minutes;
    - it is consumed when imported;
    - at most 1,000 entries, oldest dropped first.
  - `attachment_import` refuses any path not granted (`NotPermitted`), so a compromised page cannot copy, for example, `~/.ssh/id_ed25519` into the vault and read it back.
  - **Cover upload:** Rust opens the dialog itself (§7.4).
  - **Paste:** the page sends bytes, never paths.
- **The dialog plugin's JS `open`** stays limited to the folder picker (directory-only use; documented in the capability description).
- **Written names are validated** (`validate_name`); paths go through `VaultPath` / `fs_path` (no symlink escapes); hidden temp files are used; writes are create-only and atomic.
- **Pasted image types** are png, jpg, gif and webp. Dropped files of any type are allowed, because they are only copied; serving them stays behind `nimw-asset`'s sandbox CSP, and opening externally keeps M2a's `check_openable` rules.

## 9. Testing

- **Rust:**
  - `save_attachment` and `import_attachment`: policy × modes, dedupe, a name clash on a case-insensitive FS, invalid names, inside-vault no-copy, directory refused, symlink to a file;
  - precedence of the Obsidian / NIMW / default policy;
  - `link_suggest` ranking and the alias rule (PG-05 example);
  - `vault_settings` round trip preserving unknown keys;
  - drop grants (expiry, consume, refuse).
- **ACL** (`tests/commands.rs`):
  - every new command allowed from `main` and denied elsewhere;
  - `attachment_paste` with a raw body;
  - `cover_pick` through a fake `FilePicker`;
  - `attachment_import` with granted and ungranted paths (grants recorded through the same function the window event calls).
- **TS:**
  - `frontmatterEdit` (create, update, delete, empty-to-removed, comments and order kept, CRLF, invalid YAML refused);
  - cover and subtitle components (axe, keyboard, Escape and focus rules, read-only states);
  - completion source (triggers, `]]` handling, alias, embed ordering, headings);
  - Link picker (axe, keyboard, URL option);
  - paste handler; drop insertion from synthetic drag-drop events;
  - CreatePage with folders; raw HTML widget.
- **E2E** (Chromium + WebKit; ipcMock grows these commands and emits `tauri://drag-*` events):
  - add, reposition and remove a cover;
  - edit the subtitle;
  - paste an image (a synthetic `ClipboardEvent` with a `DataTransfer` file);
  - `[[` completion inserting an alias;
  - ⌘K picker → `[[Page|text]]`;
  - zero-network across all of these.
- **Real window (Jose):**
  - dropping from Finder (coordinates with Retina scaling);
  - pasting a screenshot (⌘⇧⌃4);
  - the cover dialog;
  - Obsidian opening the same vault (embeds, covers, aliases resolve);
  - an Obsidian vault with `attachmentFolderPath` set.

## 10. Out of scope (later)

- picking a cover from images already in the vault;
- drag-and-drop onto the cover;
- remote URL covers;
- pasting files copied in Finder;
- an "Insert file…" menu for the body;
- `![[x.png|300]]` sizing UI;
- tag (`#`) autocomplete;
- Markdown-link (`](`) autocomplete;
- live header updates per keystroke while typing frontmatter in Source (M2a gap e);
- audio recording (M6).

## 11. Real-window checklist (goes into the hand-off)

1. Drop 1 and then 3 files from Finder into Live Preview, Source and Split: the caret follows the pointer, and the files land where dropped.
2. Paste a screenshot.
3. Add, change, reposition and remove a cover; remove its image file in Finder (the placeholder appears).
4. Edit the subtitle; ⌘Z undoes cover and subtitle edits.
5. `[[` and `![[` autocomplete on the test vault; `[[Page#` headings.
6. ⌘K picker.
7. `[[New folder/New page]]` → Create page.
8. Open the vault in Obsidian and check that links, embeds and covers resolve.

## 12. Decisions taken for Jose (part 2, to review in bulk)

1. **Drop security:** drops are honoured only for paths Rust saw in the native drop event (grants valid 2 min). Covers come from a Rust-opened dialog; the page never names an outside path.
2. **Autocomplete source:** matching, ranking and shortest-link computation run in Rust (`link_suggest`, ≤ 50 rows per query) rather than in a TS cache of every file. That gives one source of truth for resolution, with nothing to invalidate.
3. **Cover reference format:** relative to the page when the image is in its folder subtree, else vault-rooted `/…`.
4. **Header edits** flush the page immediately, so the header updates without waiting for the autosave debounce.
5. **Attachment policy is re-read on each save,** so Obsidian config edits apply while the vault is open.
6. **Name sanitizing:** characters invalid in vault names are replaced by `-` in dropped and pasted file names, not refused.
7. **Paste cap:** 64 MiB; drops have no size cap (streamed copy).
8. **Create page with folders** is done in the UI with existing commands (no new command).
9. **HTML comments** in Live Preview stay visible (muted) rather than disappearing.

## 13. Amendments from planning (plan `docs/superpowers/plans/2026-10-14-m2c-page-extras.md`, replayed end-to-end)

These override the sections above where they conflict.

1. **Attachment policy** (§5.3): `Vault::attachment_policy()` re-reads both config files on every call and returns an owned policy. NIMW's own modes gain `folder` (Obsidian's fixed-folder form); `vault` with a path still reads as a folder (M1a compatibility). An Obsidian value that isn't a usable path is ignored (NIMW's setting applies) and isn't reported as "Set by Obsidian".
2. **Dropped Markdown files** are copied like any file, indexed as pages (title parsed) and linked as `[[name]]`.
3. **Error kinds:** besides `tooLarge` and `notPermitted`, `notAFile` (a dropped folder). Dropped and pasted names are sanitized with `-` for every character `validate_name` refuses, a leading dot included; empty becomes `file`.
4. **Ranking** (§6, §7.2): match quality first; the page/attachment preference (`[[` / `![[`) breaks ties, then shorter path, then newer file. Subsequence matching applies to names and titles, not paths. An empty query sorts by that preference, then by modification time. `link_suggest` returns `{ path, kind, title, target }` (no `mtime`).
5. **Frontmatter edits** (§4) replace only the touched pairs' source text (yaml Document ranges): re-stringifying the Document reformats untouched keys (`[a, b]` → `[ a, b ]`). New keys are appended; values are folded to one line. The edit entry point is `editorStore.editFrontmatter(patch)` (current page) with the view registry in `features/editor/views.ts`, instead of `applyEdit(path, change)`.
6. **Reposition** (§2): a vertical slider — ↑ increases `cover-y` (slider semantics), PageUp/PageDown ±20, Home/End, Enter saves, Escape cancels; `aria-valuetext` carries the announcement (no separate live region); focus returns to Reposition. Add cover is invisible until the header is hovered or the button focused, and always in the Tab order.
7. **Heading links** (§6.2): writing headings link-safe (spaces, collapsed) can change their slug (`Pipes | and ^carets`), so Split's anchor scroll and `![[Page#Heading]]` sections also match through `sameHeading` (link-safe, case-insensitive).
8. **Link picker** (§6.3): the opener registry is `linkPickerOpen.ts` (`linkPicker.ts` would shadow `LinkPicker.tsx` on case-insensitive file systems). Without a React editor host, ⌘K keeps the Markdown `[text](url)` insertion. Pages only, at most 8.
9. **Create page** (§7.6): a target with a leading `/` is vault-root-relative too; the "in Folder/" title is used only for path targets.
10. **Paste** (§5.1): a clipboard that also has `text/plain` (e.g. an image copied from a browser with its URL) is pasted as text by CodeMirror.
11. **Drop** (§5.2): the position falls back to the cursor when `posAtCoords` has none; the pending insertion point is a mapped StateField, so typing while files copy can't misplace them; the caret is `.cm-nimw-drop-caret`. Grants are recorded from both the window and the webview drag-drop events (webview windows report drops on the window).
12. **HTML blocks** (§7.7): muted with `cm-nimw-muted`; "renders nothing" is decided by running the sanitizer (memoized per block text).
13. **This vault** (§5.4): labelled "New attachments go to" with "A subfolder next to the page / The page's folder / The vault root / A folder in the vault"; a subfolder or folder name is saved on Enter or blur; when Obsidian's setting applies, the text says in plain words where files go.
14. **Autocomplete list** is styled with a scoped `EditorView.theme` (a base theme loses to `@codemirror/autocomplete`'s own); `@codemirror/autocomplete` is declared `^6.20.3` like the other CodeMirror packages.
15. **Tooling:** `pnpm check:i18n` needs Node ≥ 22.18 (`.nvmrc`: 24); the e2e mock gains `remoteCover`, a new hash per write (the header refreshes on it) and an event bus for `tauri://drag-*`.
