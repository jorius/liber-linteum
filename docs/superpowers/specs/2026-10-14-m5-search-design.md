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

## 10. Amendments from planning (2026-10-15)

Jose, 2026-10-15: "let's go with the scratchpad feature … then the search filters". M5 is built next to M4c, and **the filters get the most attention**. These amendments override §1–§9 where they conflict.

### Base and index

1. **Builds on M4c** (`feat/m4c-scratchpad`), not M4. It's developed on `feat/m5-search` from the tip of M4b part 3 and rebased onto M4c once M4c is integrated.
2. **Schema 3, not 2.** M4b part 3 already took schema 2 (the title rule). Search bumps it to **3**. An index built by version 2 is rebuilt on open, as before.
3. **External-content FTS5 over `page_text`,** replacing §9.3's contentless table.
   - **Why:** FTS5's `snippet()` and `highlight()` need the column text, which a contentless table doesn't have. Deleting from a contentless table also needs the old values anyway.
   - **The tables:**
     - `page_text(rowid, path, title, name, folders, tags, links, body)` holds one row per page. `path` references `files(path)`, cascading on delete and rename.
     - `fts` is an FTS5 table with `content='page_text'`, `tokenize='unicode61 remove_diacritics 2'` and `prefix='2 3'`.
   - **Sync:** three triggers on `page_text` keep `fts` in sync (the SQLite documentation's external-content pattern).
   - **Snippets** are cut from `page_text.body` in Rust, around the first word a query word starts (folded like the index), with every matching word marked. FTS5's `snippet()` was tried first: it re-expanded every prefix term for each result and alone cost 25–40 ms per page of results on the 10k vault (NFR-03).
   - **Size cost:** the same as §2's.
4. **The `title` column** holds the title the index already stores: the part 3 rule, a first-block H1, else the file name.
5. **Body text** is the page's text without its Markdown:
   - **Kept:** headings, paragraphs, list items, table cells, and code (inline and blocks, for the technical-docs persona).
   - **Dropped:** the frontmatter, `%% %%` and HTML comments, raw HTML, link URLs and embeds.
   - **Wikilinks** read as their alias, else their target.
6. **`has_image` / `has_audio`** have been pages flags since M1. Nothing is added. A cover doesn't count as an image: the flags come from embeds and image links, as parsed.
7. **Text and code files** (M4b part 2) **aren't searched in M5.**
   - **Why:** the index keeps them as attachments and never reads their text, and results are pages (§9.2).
   - **Cost if wrong:** a follow-up indexes their text as a second kind of row and opens them in the text view.
8. **Links to files outside the vault aren't vault links.**
   - **The `links` column** skips `file:` URLs, Windows and UNC paths, and relative paths that climb above the vault root. A `/`-leading target counts, because Obsidian reads it from the vault root first.
   - **`linksTo` / `linksFrom`** use only resolved vault targets, which outside links never have.
9. **The vault's scratch folder** (M4c; `.nimw/vault.json` `scratchpadFolder`) holds ordinary pages, which are searched like any other.

### Query and filters

10. **Ranking:** results sort by four keys, in order:
    - a metadata hit first. A metadata hit is any query word matching `title`, `name`, `folders`, `tags` or `links`.
    - then bm25 with §2's weights;
    - then the shorter path;
    - then the most recently modified.

    This is §2's "constant bonus", written as a sort key.
11. **The text:**
    - Words are made of letters and digits. A word with neither (`-`, `***`) is dropped.
    - Every word becomes a quoted FTS5 string with `*`, so `AND`, `OR`, `NOT`, `NEAR`, `"`, `*`, `^`, `(` and `:` are always text.
    - A quoted phrase keeps its order, and its last word is a prefix too.
12. **Each filter, precisely:**

    | Filter | Typed as | What it matches |
    |---|---|---|
    | `project` | (chip only) | The first path component, a top-level folder. Pages at the vault root have no project. |
    | `folder` | `in:` | A folder path, or a folder name matched case- and accent-insensitively anywhere in the vault (every folder with that name). |
    | `tags` | `#` | All of them must be present (case-insensitive). A tag also matches its nested tags: `#lore` matches `#lore/places`, as in Obsidian's tag search. |
    | `linksTo` | `to:` | A page path, or a name resolved like `[[name]]`, else a page whose title matches. |
    | `linksFrom` | `from:` | Same as `linksTo`. |

    **When a page reference can't be found:** the filter matches nothing, and its chip stays visible so it can be removed.
13. **Facets:**
    - The **project**, **links to** and **media** counts are computed with every other active filter applied, but not their own. That way you can switch project without removing the chip first.
    - **Tag** counts are computed within all filters: tags are ANDed, so this is a drill-down.
    - Active filters always appear, with a count of 0 when nothing matches.
14. **An empty text with filters** lists the matching pages, most recently modified first, 50 at a time. With no filters either, it's Recent: the 20 most recently modified pages.
15. **`indexing`** is true while a full re-index runs, such as after a watcher overflow. The index built on open finishes before the vault opens, so a search can't race it.
16. **Where the code lives:** the queries, parsing and facets are in `crates/nimw-index/src/search.rs`, because the index owns the SQLite connection. `nimw-session` adds `VaultSession::search` and the `indexing` flag.

### UI

17. **The Search button:**
    - **Placement:** in the top bar's right group, before Settings, labelled "Search" with a ⌘⇧F (Ctrl+Shift+F) hint. The top bar is shared, so the button shows in both Edit and Global View.
    - **Shortcut check:** ⌘⇧F was free in every keymap checked: the Rust menu, `useGlobalShortcuts` and the editor (which has no CodeMirror search keymap).
    - **On layouts without a Latin F,** the physical F key works.
18. **Filter words in the field:**
    - `#tag`, `in:name`, `to:name` and `from:name` become chips when Space or Enter follows them. A name with spaces is quoted: `in:"Game design"`.
    - When the text ends in a filter word, Enter makes the chip instead of opening a result.
    - Backspace in an empty field removes the last active chip.
19. **Shift+Enter** shows the page's own level in the Global View, under the vault in the breadcrumb.
20. **The query and filters are kept per vault session,** in memory. They're forgotten when another vault opens or the vault closes.

### Performance (found while measuring NFR-03)

21. **The matches are materialized once** into a temp table per search. The count, the page of results and the facets read that table instead of re-running the text query and the joins. Facets whose own filter is active get the matches without that filter, in a second temp table.
22. **On more than 1,500 matches, facets sample.**
    - The leading tags and links-to pages (3× the number shown) are found in an even, deterministic sample of the matches.
    - Each candidate is then counted exactly against all the matches.
    - Counts stay exact. Only a rare page or tag just outside the shown top could be missed on very broad queries.
23. **Measured** on the 10k reference vault (release, Apple Silicon, other builds running):
    - first full index, FTS included: 1.4 s;
    - `search` over 200 queries: p50 18.7 ms, p95 34.8 ms;
    - re-indexing one page: 18 ms.

## 11. Final review (2026-10-15)

A fresh-context review of `ba67c0a..73f909c` found no Critical issues. Its findings, re-graded by effect:

**Fixed** (each with a test that failed first):
1. **I1, renamed pages:** a page with no first-line H1 takes its title from its file name. A rename moved its index rows but kept the old title, so search found it by the old name and showed the old title. The session now re-parses each moved page whose file name changed. A rename made by another program was already right; a test pins it.
2. **I2, Enter on stale hits:** Enter pressed before the answer for the current text arrived opened a hit of the older text (often Recent). While a search is waiting or running, Enter now searches at once and opens the first hit of the current text.
3. **M1, decomposed text (re-graded Important, since NFD names are common in vaults from macOS):** combining marks count as word characters in the Rust snippet tokenizer and the TS highlight. A decomposed `Canción` gets its snippet and is marked whole.
4. **M2, tag forms (re-graded Important):** tag keys are NFC before lower-casing, in the index and in the dialog's chip comparisons. A tag matches, and shows as one chip, whichever form it was written in. Still schema 3.
5. **M3, odd query characters:** control characters split words. A word with no character FTS5 indexes (only combining marks, such as `ा`) is dropped instead of emptying the result.
6. **M4, self-links:** a page's link to itself doesn't count in the links-to filter, as in its facet, so the chip's count matches the results.
7. **M6, Show more:** asks once while a page is loading, and is disabled meanwhile.
8. **M7, long notes:** snippets keep a window of tokens around the first match instead of tokenizing the whole body.

**Deferred:**
- **M5:** `to:Name` silently picks one page when two share the name; the chip shows only the title. A later pass could show the path trail when the title is ambiguous.
- **M8:** short query words (`the`) can earn the metadata bonus through a title prefix (`Thesis`). Counting matched words, or a two-letter minimum, can come later.
- **Approximation:** "a character FTS5 indexes" is approximated as alphanumeric minus combining marks. Symbols with the alphabetic property, such as `Ⓐ`, can still form an empty phrase.
