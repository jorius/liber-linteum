# M5 — Search: Design

**Status:** written on 2026-10-14 without Jose's review. He asked to "carry on with everything that's missing" and review features in bulk later.
- **Grounding:** product spec §9.2 (SR-01–SR-06, Q-SR-1, all DECIDED), NFR-03 (search p95 < 50 ms at 10k notes), architecture §3.2 (FTS5 `unicode61 remove_diacritics 2`, bm25 weights) and §4.5 (`search(query, filters)`, 80 ms debounce), and the prototype's search modal (`design/prototype/Main.dc.html`: a field, filter-chip rows PROJECT / TAGS / LINKS TO / MEDIA, a result count, compact results with a cover thumbnail, title, path, tags and media icons).
- **Builds on:** M4 (`feat/m4-block-moves`).
- **Judgement calls** are listed in §9.

---

## 1. Goal and success criteria

Find any page fast, by what it's called, where it lives, how it's tagged or linked, or what it says.

1. **SR-01:** one search, reachable from every view: a top-bar **Search** button, **⌘⇧F** (Ctrl+Shift+F elsewhere) and View → Search….
2. **SR-02:**
   - **Fields searched:** project name, folder names, file name, title, tags, link targets and full body text.
   - **Ranking:** a metadata match ranks above a body-only match.
   - **Accents:** accent-insensitive, so `canción` matches `cancion`.
   - **Prefixes:** each word matches as a prefix, so `gen` finds "Generator".
3. **SR-03 / SR-04:**
   - **Filters:** project, folder, tags (all of them), links to, links from, has image, has audio.
   - **Chips:** active filters show as removable chips, and the filter rows offer the most useful choices as chips.
4. **SR-05:** each result shows:
   - a cover thumbnail (or a placeholder);
   - the title and the path (project › folder › file);
   - matching tags;
   - image and audio icons;
   - for body matches, a one-line snippet with the matched words highlighted.
5. **SR-06 and NFR-03:**
   - no network;
   - p95 < 50 ms for `search` on the 10k reference vault (release);
   - the UI debounces typing by 80 ms;
   - typing latency is unaffected.

The non-negotiables are as before.

## 2. Index (`crates/nimw-index`, schema v2)

- **A schema bump to 2,** which triggers the existing rebuild on open (§3.2 meta).
- **New table:** `fts`, an FTS5 virtual table with `content=''` (contentless), `tokenize='unicode61 remove_diacritics 2'`, and columns `title, name, folders, tags, links, body`. The rowid equals `files.rowid` of the page.
  - **`folders`:** the page's folder path components, space-separated, including the project.
  - **`tags`:** the tags without `#`.
  - **`links`:** the targets' names.
  - **`body`:** plain text from the parser: Markdown syntax, front matter and comments dropped; wikilinks shown as their alias or target.
- **Snippets need a body copy:** a contentless FTS can't produce snippets, so the plain body is also stored in a new `page_text(rowid, body)` table. Snippets are computed from it with the FTS match offsets (`fts5vocab` isn't needed). The size cost is about the vault's text size.
- **Writes stay in sync:** `upsert_page`, `remove` and `rename` update `fts` and `page_text` in the same transaction as `pages`.
- **Ranking:** `bm25(fts, 10.0, 8.0, 5.0, 6.0, 4.0, 1.0)` for title, name, folders, tags, links and body. Rows whose match touches any non-body column get a constant bonus, so a metadata match always outranks a body-only match (SR-02). Ties go to the shorter path, then the most recently modified.

## 3. Query and filters (`crates/nimw-session/src/search.rs`)

- **`search(query: SearchQuery) -> SearchPage`**
  - `SearchQuery { text, project?, folder?, tags: Vec, linksTo?, linksFrom?, hasImage?, hasAudio?, offset, limit ≤ 50 }`.
  - **Parsing the text:**
    - it is split into words, and quoted phrases are kept;
    - each word becomes an FTS5 string literal with `*` (prefix);
    - FTS5 operators typed by the user are treated as text, never as syntax: quotes are escaped and `AND`/`OR`/`NOT`/`NEAR` are quoted;
    - all words must match (AND).
  - **An empty text with no filters** returns the 20 most recently modified pages ("Recent").
  - **Filters** are SQL on `files`/`pages`/`tags`/`links`:
    - `project` = the first path component;
    - `folder` = the path prefix;
    - `tags` = all present;
    - `linksTo` = resolved links whose target is X;
    - `linksFrom` = the targets of X's resolved links;
    - `hasImage` / `hasAudio` = the `pages` flags.
- **`SearchPage`:** `{ results: Vec<SearchHit>, total: u32, facets: Facets }`.
  - `SearchHit { path, title, cover: Option<String> (resolved vault path), tags: Vec<String> (matching first), hasImage, hasAudio, snippet: Option<Vec<SnippetPart>> }`.
  - `SnippetPart { text, hit: bool }`: about 12 words around the first body match. It is structured data, never HTML.
- **Facets:**
  - computed over the current matches, or the whole vault when the text is empty;
  - `projects` (all, with counts), `tags` (the 12 most frequent), `linksTo` (the 8 most linked targets), and counts for `hasImage` / `hasAudio`;
  - active filters are always included, so their chips stay visible.
- **Indexing in progress:** a search during indexing returns what's indexed so far, with `indexing: true`.

## 4. UI (`features/search/SearchDialog.tsx`, `searchStore.ts`)

- **The modal** (the app's Dialog pattern, matching the prototype), 780 px wide:
  - **Field row:** a search `input` (combobox), a clear button (×) and close.
  - **Filter rows:** PROJECT, TAGS, LINKS TO, MEDIA, each a labelled group of toggle chips (`aria-pressed`). A row is hidden when it has no choices.
  - **Active filters** not offered by a row (a folder, links from, a tag outside the top 12) show as removable chips in an "Active" row.
  - **Filter text input:** typing `#tag`, `in:Folder`, `to:Page` or `from:Page` in the field turns into a chip when Space or Enter is pressed. The words are the same in every UI language, as in Obsidian.
- **Results:** "N results" (ICU plural), then a listbox of hits.
  - ↑ and ↓ move through the hits (`aria-activedescendant`, with focus kept in the field).
  - **Enter** opens the page in the editor (switching to Edit, like the explorer).
  - **Shift+Enter** shows it in the Global View (its page level).
  - A click opens it.
  - Up to 50 hits show; **Show more** loads the next 50.
- **Search state:** when the dialog reopens it restores the last query and filters for this vault session.
  - Escape clears the query first when it isn't empty; a second Escape closes.
  - Focus returns to where it was opened.
- **Thumbnails and highlights:**
  - thumbnails are 48 × 32 `object-fit: cover`, through the asset protocol, lazy;
  - remote covers show the placeholder;
  - highlighted words in titles and snippets are `<mark>`s built from the structured parts. Titles are highlighted in TS by the same accent-insensitive prefix rule.
- **Screen reader:** a polite live region announces the result count after each search, debounced.
- **Opening the dialog:** ⌘⇧F from anywhere, including from the editor (CodeMirror doesn't bind it) and from Global View; the top-bar button; View → Search… (`menu:search`, no accelerator, the M2b rule).

## 5. Commands

- **`search(query)`** is async via `blocking()`, with a real-ACL test.
- **Facets** come back with each page of results.
- No other command is needed.

## 6. Performance

- **Release perf tests:** a 10k-note reference vault (generated, as M1/M3a do); 200 random queries of 1–3 words plus filter mixes. The test asserts p95 < 50 ms for `search`, and < 30 s for the first full index including FTS (NFR-03).
- **Index cost:** the FTS writes must keep the re-index of a changed file under 100 ms.

## 7. Testing

- **Rust:**
  - schema v2 rebuild;
  - FTS sync on create, edit, rename and delete;
  - ranking: metadata above body; title above tags above body;
  - accent and prefix matching;
  - phrase queries;
  - operator injection (`AND`, `"`, `*`, `NEAR(`, `^`) as text;
  - each filter alone and combined;
  - facets with counts, active filters kept;
  - snippets around the match;
  - "Recent" for an empty query;
  - perf (release, `--ignored`).
- **ACL:** `search` allowed from main, denied elsewhere.
- **TS:**
  - `searchStore` (debounce, stale responses dropped, restore);
  - SearchDialog: axe light and dark; keyboard (↑/↓, Enter, Shift+Enter, Escape twice); chips (toggle, remove, filter words); live-region count; highlights;
  - TopBar button; ⌘⇧F in each view.
- **E2E (Chromium + WebKit):**
  - ⌘⇧F → type → Enter opens the page;
  - a tag chip filters, and removing it restores;
  - a body match shows a highlighted snippet;
  - zero-network with search open.
- **Real window:** search feel on the real test vault, and the ⌘⇧F shortcut with the Spanish layout.

## 8. Out of scope

- Search and replace;
- regular expressions;
- saved searches;
- searching inside attachments (PDF text);
- fuzzy (typo-tolerant) matching beyond prefixes;
- searching the Global View canvas.

## 9. Decisions taken for Jose (to review in bulk)

1. **⌘⇧F, not the prototype's Ctrl K:** ⌘K is the editor's Link picker (M2b/M2c). ⌘⇧F is Obsidian's "Search in all files".
2. **Results are pages.** Project and folder names make their pages findable, and the PROJECT filter row narrows them; folders aren't separate results.
3. **Contentless FTS5 plus a `page_text` table for snippets,** rather than an external-content FTS over `pages`. The body isn't stored in `pages` today.
4. **Metadata always outranks body-only matches,** with a constant bonus on top of bm25, following Q-SR-1's "metadata matches rank higher".
5. **Filter words** (`#tag`, `in:`, `to:`, `from:`) are typed shortcuts for chips. They are the same in every language.
6. **An empty query shows Recent** (the 20 most recently modified pages).
7. **Enter opens the editor; Shift+Enter opens the Global View page level.**
