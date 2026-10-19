# M5 — Search with filters: Hand-off

**What M5 does:** find any page fast, by what it's called, where it lives, how it's tagged or linked, or what it says. On 2026-10-15 Jose said "let's go with the scratchpad feature … then the search filters", so **the filters** got the most attention.

**Spec:** `docs/superpowers/specs/2026-10-14-m5-search-design.md`.
- §1–§9: the design, written on 2026-10-14 without Jose's review. It includes the 7 judgement calls in §9.
- §10: amendments from planning, covering schema 3, external-content FTS, each filter in detail, the facets rules, the UI and performance.
- §11: the final review, with what was fixed and what was deferred.

**Plan (as run):** `docs/superpowers/plans/2026-10-15-m5-search.md`.

**Branch:** `feat/m5-search`, stacked on `feat/m4c-scratchpad`. Merge order for the whole stack: M2c → M3a → M3b → M4 → M4b → M4b part 3 → M4c → **M5**.

**How it was built:**
1. **The build.** One stream, developed in parallel with M4c from the tip of M4b part 3 (ba67c0a), with its own plan, worktree and full gate. A laptop restart killed the agent mid-way; it resumed from its worktree.
2. **Review and fixes.** A fresh-context Opus final review found no Critical issues. A fix pass followed, with every fix tested by a test that failed first.
3. **Rebase onto M4c.** M5 was cherry-picked onto the integrated M4c. Conflicts were resolved by hand, and one commit of combination pins was added (see §4).

## 1. What it does

### Opening search

- **Shortcut:** **⌘⇧F**, or Ctrl+Shift+F on Windows and Linux, from anywhere: the editor, the Global View and the explorer. On keyboard layouts without a Latin F, the physical F key works.
- **Search button** in the top bar, before Settings, with the shortcut hint. It shows in both Edit and Global View.
- **View → Search…** in the macOS menu. It always opens in the main window.
- **File windows** (M4c) have no search. Neither ⌘⇧F nor the menu opens it there, and the command is denied to them.

### What's searched

- **Fields:** the title, the file name, the folder names (including the project), tags, link targets and the full body text.
- **Accents and case:** neither matters, so `cancion` finds "Canción".
- **Word prefixes:** every word matches as a prefix, so `gen` finds "Generator".
- **Word logic:** all words must match. A quoted phrase keeps its order.
- **Ranking:** a metadata match (title, name, folders, tags, links) always ranks above a body-only match. Within each group, results sort by bm25 relevance (title > name > tags > folders > links > body), then by shorter path, then by most recently modified.
- **Typed operators are plain text.** Search operators (`AND`, `OR`, `NOT`, `NEAR`, `"`, `*`, `^`, `:`) never act as syntax and can never cause an error.
- **Body text** is the note without its Markdown:
  - kept: headings, paragraphs, list items, table cells and code;
  - dropped: frontmatter, comments, raw HTML, link URLs and embeds;
  - wikilinks read as their alias, or else their target.
- **Empty search:** with no text and no filters, the results show **Recent**, the 20 most recently changed pages. With filters but no text, the results list the matching pages, newest first.
- **What's not searched:**
  - `.txt` and code files: they're attachments in the index (ruling 5);
  - links to files outside the vault;
  - PDFs' text.

### The filters

**Filter rows.** These sit under the field. Each is a group of toggle chips with counts; a row hides when it has no choices.

| Row | Offers | Matches |
|---|---|---|
| **Project** | Top-level folders (up to 20, plus the active one) | Pages under that top-level folder |
| **Tags** | The 12 most frequent tags among the matches | Pages that have **all** chosen tags; a tag also matches its nested tags (`#lore` → `#lore/places`) |
| **Links to** | The 8 most-linked pages among the matches | Pages with a resolved link to that page |
| **Media** | Has image, Has audio | Pages with an image or audio embed (covers don't count) |

**Typed filter words.** These become chips when followed by Space or Enter. They're the same in every UI language, as in Obsidian.

| Typed | Filter |
|---|---|
| `#tag` | tag |
| `in:Folder` or `in:"Game design"` | a folder path, or a folder name anywhere in the vault |
| `to:Page` | links to that page (resolved like `[[Page]]`, else by title) |
| `from:Page` | the pages that page links to |

**The Active row** shows every active filter as a removable chip, plus **Clear all**:
- Backspace in an empty field removes the last chip.
- A filter whose page or folder can't be found matches nothing, and its chip stays visible so you can remove it.

**Facet counts:**
- Project, Links to and Media counts ignore their own filter, so you can switch project without removing the chip first.
- Tag counts drill down within all filters.
- Above 1,500 matches, the candidates for the tag and links-to rows are picked from a sample, but the counts shown are exact.

### Results

- **List:** "N results" (with proper plurals in English and Spanish), then a list of hits. Each hit shows:
  - a 48 × 32 cover thumbnail, or a placeholder;
  - the title with matched words highlighted;
  - the path (project › folder › file);
  - the matching tags first;
  - image and audio icons;
  - for body matches, a one-line snippet with the matched words highlighted.
- **Keyboard:**
  - ↑ and ↓ move through the results, with focus kept in the field.
  - **Enter** opens the page in the editor. If the answer for the current text hasn't arrived yet, Enter waits for it and never opens a hit from earlier text.
  - **Shift+Enter** shows the page in the Global View.
  - Escape clears the text first, and a second Escape closes. Focus returns to where it was.
- **Paging:** 50 results at a time, with **Show more** for the rest. It can't double-load.
- **Remembered:** the query and filters are kept per vault session, in memory.
- **Screen readers:** a polite live region announces the result count.

### Index

- **Schema 3**, so the index **rebuilds once** the first time each vault opens. (M4b part 3 took schema 2.)
- **New tables:** `page_text` (one row per page) and the external-content FTS5 table `fts` (unicode61 tokenizer, diacritics removed, 2- and 3-character prefix indexes). Triggers keep the two in sync, and every write and rename happens in one transaction.
- **Renames:** a page renamed in the app or by another program is found by its new name only, and re-titled if its title came from its file name.
- **Unicode forms:** tags are normalized to NFC, so decomposed names (common from macOS) match and highlight like composed ones.

## 2. Totals

**Commits:** 16 on top of M4c:
- 11 from the stream;
- 4 from the fix pass;
- 1 of combination pins added while rebasing onto M4c.

M4c's hand-off commit sits between them on the branch.

**Performance** (release build, 10k-note reference vault, Apple Silicon, with other builds running):

| Measure | Before the fixes | After the fixes | Budget (NFR-03) |
|---|---|---|---|
| `search` p50 | 18.7 ms | 22.6 ms | — |
| `search` p95 (200 queries of 1–3 words plus filter mixes) | 34.8 ms | 41.4 ms (on a more loaded machine) | < 50 ms |
| First full index, FTS included | 1.42 s | 1.63 s | < 30 s |
| Re-indexing one changed page | 18 ms | 20.9 ms | < 100 ms |

The first working version measured a p95 of about 450 ms. Three changes brought it down (spec §10.21–23):
- matches are written once into a temp table per search;
- facets are sampled above 1,500 matches;
- snippets are cut in Rust.

**Full gate** (`check.sh all`) on the combined M4c + M5 tip, before this doc's commit:

| Check | Result |
|---|---|
| vitest | 1375 tests in 126 files |
| e2e | 272 passed in Chromium and WebKit, plus 8 opt-in perf tests skipped |
| cargo | 461 passed, 3 ignored (the trash tests and the release perf test) |
| lint, typecheck, i18n, build, fmt, clippy, deny | all clean |

**Perf test:** it's `#[ignore]`. Run it with `cargo test --release -p nimw-session --test search -- --ignored`.

## 3. Needs the real window

### Jose, on the Mac (the built `.app` or `pnpm dev`)

1. **Rebuild.** Open your vault; the index rebuilds once (schema 3). The vault should open normally.
2. **Feel.** Press ⌘⇧F and type a few letters of a page name. Results update as you type with no lag in the field.
   - Paste a word and press Enter right away: the right page opens.
3. **Filters.**
   - Click a Project chip, then a Tag chip, then remove them.
   - Type `#sometag ` and `in:SomeFolder `, then `to:Some Page ` (with a space at the end). Each becomes a chip.
   - Press Backspace in the empty field to remove the last chip.
   - Check the counts look right.
4. **Snippets.** Search a word that only appears in a note's body. The result shows a snippet with the word highlighted.
5. **Accents.** Search `cancion` for a note titled "Canción". Then try a file you named in Finder with an accent (macOS stores those decomposed). It's found and highlighted.
6. **Renames.** Rename a page that has no H1. Searching its old name doesn't find it; its new name does.
7. **Shift+Enter** on a result shows it in the Global View.
8. **Cover thumbnails** show for pages with a local cover.
9. **Spanish layout.** With the Spanish keyboard layout, ⌘⇧F still opens search.
10. **View → Search…** opens it too, including from a file window, where it opens in the main window.
11. **Quick notes.** After a quick note renames itself from its first line, search finds it by that name.

### The friend, on Windows (the `.exe`)

1. Ctrl+Shift+F opens search; the Search button is in the top bar.
2. Search the real Obsidian vault ("Mind_PC"):
   - accented words;
   - tags with `#`;
   - a folder with `in:`.
3. The index rebuilds once on first open, and the vault opens normally.

## 4. Final review, fix pass and the rebase

### Review

A fresh-context Opus review of `ba67c0a..73f909c` found no Critical issues, 2 Important and 8 Minor (spec §11).
- **Fixed** (each with a test that failed first):
  - **I1:** a renamed page stayed findable, and titled, under its old name.
  - **I2:** Enter could open a result from the earlier text.
  - **M1** (re-graded Important): decomposed words had no snippet or highlight.
  - **M2** (re-graded Important): tags written in the other Unicode form didn't match.
  - **M3:** odd characters (NUL, a lone combining mark) could empty or break the query.
  - **M4:** self-link counts disagreed.
  - **M6:** Show more could double-load.
  - **M7:** snippets tokenized whole huge notes.
- **The reviewer checked sound:**
  - query injection (every operator and odd input listed);
  - index sync, including cascade deletes;
  - temp-table concurrency;
  - security (main window only; covers through the asset protocol; highlights built from text, never HTML);
  - the Safari 15 floor;
  - the facet rules.

### Rebase onto M4c

M5 was cherry-picked onto `feat/m4c-scratchpad`. Conflicts were resolved by keeping both sides:

| File | How it was resolved |
|---|---|
| `nimw-session/src/lib.rs` | the search re-exports next to the quick-note ones |
| `src-tauri/src/lib.rs`, `build.rs`, `capabilities/main.json` | the search command next to the M4c commands; `core:window:allow-destroy` stays removed (M4c I2) |
| `menu.rs` | View → Search… sends `menu:search` **to the main window** (shown and focused), like New Quick Note, because file windows have no search |
| `ipc/index.ts` | the search types and `onMenuSearch`, scoped to its own window like the other M4c listeners |
| `useGlobalShortcuts.ts` | `isSearchKey` and M4c's note that ⌘⇧N is New Quick Note |
| `main.tsx` | the search menu listener is installed in the main window only |
| `uiStore.ts` | both dialog kinds (`scratchpadSetup`, `search`) |
| locale files | merged by key (`scratchpad`, `singleFile`, `search`) |
| `playwright.config.ts` | WebKit runs m4c-scratchpad, m4c-files and m5-search |

**Combination pins** (commit `test(m4c+m5)`). These passed on first run, because the behaviour was already right:
- `search` is in the file-window denied list (`tests/file_windows.rs`);
- ⌘⇧F in a file window opens no search and calls no search command (`SingleFileApp.test.tsx`);
- a quick note renamed after its first line is found by that name and not by its generated one (`crates/nimw-session/tests/search.rs`).

### Deferred (for a later pass)

- **M5:** `to:Name` silently picks one page when two share the name; the chip shows only the title.
- **M8:** short query words (`the`) can earn the metadata bonus through a title prefix (`Thesis`).
- "A character FTS5 indexes" is approximated as alphanumeric minus combining marks. Symbols such as `Ⓐ` can still form an empty phrase.
- There's no live test of `indexing: true`; a full re-index after a watcher overflow sets it.
- Stale debounced searches still run on the backend; nothing cancels them. Each holds the index for about 35 ms.
- CJK words inside longer words (`京都` in `東京都`) aren't found: the unicode61 tokenizer doesn't segment CJK.

### Rulings to confirm (taken on your behalf; details in spec §9–§11)

**From the spec, written without your review:**
- **⌘⇧F, not ⌘K.** ⌘K is the link picker, and ⌘⇧F is Obsidian's "Search in all files".
- **Results are pages.** Folders aren't separate results; the Project row and `in:` narrow by folder.
- **Metadata always outranks body-only matches.**
- **Filter words are the same in every language.**
- **An empty query shows Recent.**
- **Enter opens the editor; Shift+Enter opens the Global View.**

**Taken while building:**
1. **Schema 3** (part 3 took 2). The index rebuilds once.
2. **External-content FTS5 over `page_text`**, instead of the spec's contentless table. Cost: about the vault's text size again on disk.
3. **Snippets cut in Rust**, because FTS5's `snippet()` cost 25–40 ms per page of results. Cost: every matching word is highlighted, even outside a phrase.
4. **Headings and code are body text.** Cost: a title H1 can appear in its own page's snippet.
5. **`.txt` and code files aren't searched.** Cost: their content can't be found yet; a follow-up would index it.
6. **Outside links are excluded** from links and links-to. A `/`-leading target counts as a vault link.
7. **Facets ignore their own filter** for project, links-to and media; tags drill down.
8. **The Project row is capped at 20**, plus the active project. `in:` still reaches the rest.
9. **Facet candidates are sampled above 1,500 matches**; counts stay exact.
10. **Tag filters are case-insensitive but not accent-insensitive**, as in Obsidian. `#cancion` doesn't match `#canción`, but both Unicode forms of `#canción` do.
11. **The Active row shows every active filter plus Clear all**, as in the prototype.
12. **Blank filter values count as no filter**; input is capped at 500 characters of text and 20 tags.
13. **The search DTOs live in `search_commands.rs`**, not `dto.rs`.
14. **Shift+Enter sets the Global View breadcrumb to vault › page.**
15. **Re-parse after a rename:** a failed re-parse emits a warning instead of failing a rename that already happened on disk.
16. **View → Search… always opens in the main window**, even from a file window (decided while rebasing onto M4c).

## 5. Builds

Both builds are from the `feat/m5-search` tip, which contains all of M4c and M5.

**Mac (unsigned `.app`):**

```bash
cd apps/desktop
CARGO_TARGET_DIR=<repo>/target pnpm tauri build --bundles app
```

- Output: `target/release/bundle/macos/Notes In My Way.app`.
- It's unsigned, so the first time you open it, right-click → Open.
- Finder's Open With lists it after it has been launched once.

**Windows (unsigned NSIS installer):** cross-compiled on the Mac with `cargo-xwin`, using the toolchain in `~/.nimw-cross`:

```bash
cd apps/desktop
export CARGO_HOME=$HOME/.nimw-cross/cargo RUSTUP_HOME=$HOME/.nimw-cross/rustup RUSTUP_TOOLCHAIN=1.99.0 XWIN_ACCEPT_LICENSE=1
export PATH="/opt/homebrew/opt/rustup/bin:$CARGO_HOME/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

- Output: `target/x86_64-pc-windows-msvc/release/bundle/nsis/Notes In My Way_0.1.0_x64-setup.exe`.
- SmartScreen asks for More info → Run anyway.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Search finds nothing in a vault that has notes | The index is still rebuilding (schema 3) or failed. Check the vault opened with no error toast. The index lives in the app's cache dir, so deleting it forces a rebuild. |
| A renamed page shows its old title in results | The rename path must re-parse moved pages whose file name changed (`rename.rs`, spec §11.1). Run `cargo test -p nimw-session --test search m5_review_i1`. |
| "Search failed" in the dialog | An FTS5 syntax error means the query parser let something through. Add the input to `m5_review_m3_odd_words_never_empty_the_result` and fix `search.rs` parsing. |
| ⌘⇧F does nothing | A dialog is open (search ignores the shortcut then), or focus is in a file window, which has no search. |
| Perf regression | Run the release perf test (`-- --ignored`). The temp-table materialization (§10.21) and facet sampling (§10.22) are the levers. |
| Accented names match but aren't highlighted | The highlight regex must allow combining marks (`[\p{L}\p{N}][\p{L}\p{N}\p{M}]*`, in `highlight.ts`), and so must the Rust tokenizer. |
