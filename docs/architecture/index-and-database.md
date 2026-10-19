# The index: SQLite database and indexing process

> **As built at `de2378e`** (main, 2026-10-18; index schema **4**). Every
> claim below was checked against the code at that commit; file references are
> `path:line` there. Where the code doesn't handle something, this doc says
> "not handled" rather than guessing.

The index is a **disposable cache** of one vault: what the explorer, Global View,
link resolution, backlinks and search read. The vault's Markdown files are the
only source of truth. Deleting the database loses nothing; it is rebuilt the
next time the vault opens.

Who owns what:

| Crate | Role |
|---|---|
| `nimw-vault` | The file system: scan, stat, read, atomic CAS writes, watch. Never touches SQLite. |
| `nimw-markdown` | Parses one page's text into `PageMeta` (title, frontmatter, tags, links, body text, icon). No I/O. |
| `nimw-index` | The SQLite database: schema, writes inside transactions, reads, search. Never reads vault files (`crates/nimw-index/src/lib.rs:1-2`). |
| `nimw-session` | One open vault: feeds files from `nimw-vault` through `nimw-markdown` into `nimw-index`; the watcher loop; every write the app makes. |
| `apps/desktop/src-tauri` | Tauri commands that call the session on a blocking thread. |

---

## 1. Where the database lives

```
<app cache dir>/nimw/<16 hex chars>/index.sqlite   (+ -wal, -shm)
```

- **The app cache dir** is Tauri's `app_cache_dir()` (`apps/desktop/src-tauri/src/lib.rs:102`), which is the OS cache folder plus the bundle identifier `app.notesinmyway.desktop`:
  - macOS: `~/Library/Caches/app.notesinmyway.desktop/`
  - Windows: `%LOCALAPPDATA%\app.notesinmyway.desktop\`
  - Linux: `$XDG_CACHE_HOME/app.notesinmyway.desktop/` (usually `~/.cache/…`)
- **The folder name** is `cache_dir_name(vault_root)`: the first 8 bytes (16 hex characters) of the SHA-256 of the vault's canonical absolute path (`crates/nimw-index/src/lib.rs:28`). The path is built by `index_db_path` (`crates/nimw-session/src/session.rs:53`).
- **One database per vault.** Two vaults with the same folder name in different places get different hashes, so they never share a database. The global Scratchpad is an ordinary vault and gets its own.
- **Why not inside the vault:** opening a vault writes nothing into it (VLT-02), the index isn't Obsidian's business, and a synced vault (iCloud, Dropbox, git) must not carry a binary database that two machines would fight over.
- **Moving or renaming a vault folder** changes its canonical path, so it gets a fresh database (a full re-index) and the old one is left behind. **Orphaned databases are never cleaned up** (not handled).
- **A safe reset:** quit the app and delete the vault's `<hash>` folder, or the whole `nimw/` folder. The next open rebuilds it.

## 2. SQLite setup

- **Library:** `rusqlite 0.40` with the `bundled` feature (`Cargo.toml:23`). SQLite is compiled in, FTS5 included, so the system's SQLite version never matters.
- **Opening** (`Index::open`, `crates/nimw-index/src/index.rs:107`):
  1. Create the folder.
  2. A **new file** gets the schema straight away.
  3. An **existing file** must pass `PRAGMA quick_check` and carry `meta.schema_version` equal to the build's `SCHEMA_VERSION` (`index.rs:130-152`).
  4. Anything else — a corrupt file, a foreign file, an older or newer schema — is **deleted together with its `-wal` and `-shm` files and rebuilt** (`index.rs:111-121`).
- **Pragmas** (`index.rs:154-159`): `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`. No `busy_timeout` is set; there is only ever one connection per database (below).
- **Connection ownership:** one `rusqlite::Connection` inside `Index`, inside a `Mutex<Index>` in `VaultSession` (`crates/nimw-session/src/session.rs:21`). The lock helper recovers from a poisoned mutex rather than failing (`session.rs:101-103`).
- **Threads that touch it:**
  - **Tauri command threads.** Every command runs its session work through `blocking()`, which is `tauri::async_runtime::spawn_blocking` (`apps/desktop/src-tauri/src/vault_commands.rs:90-97`). So SQLite never runs on the async runtime or the UI thread.
  - **The watcher's batching thread** (`nimw-watch`, `crates/nimw-vault/src/watch.rs:86`). It calls `VaultSession::apply`, which takes the same mutex.
  - **Rayon workers** read and parse files in parallel during a full pass, but they **never touch SQLite**. All writes happen afterwards, on the calling thread, under the mutex (`session.rs:150-206`).
- **Transactions:** `Index::transaction` wraps a closure; it commits on `Ok`, and rolls back on `Err` by dropping the transaction (`index.rs:172-179`). The full pass writes in chunks of 500 rows per transaction (`BATCH_ROWS`, `session.rs:14`).

## 3. The schema (version 4)

Defined in one string, `crates/nimw-index/src/schema.rs:9-93`, and created in one batch by `Index::init`.

```
meta

files ──┬──< pages        (1:1, page rows only)
        ├──< page_text ──── fts (FTS5, external content)
        ├──< tags         (1:n)
        └──< links (src)  (1:n)  ── target_path ──> files.path (soft, nullable)
```

Every child references `files(path)` with `ON DELETE CASCADE ON UPDATE CASCADE`. So deleting a `files` row removes its page, text, tags and outgoing links, and changing its `path` moves them. `links.target_path` is **not** a foreign key: it is a resolved pointer that the session keeps up to date (§5.6).

### `meta`

| Column | Type | Filled with |
|---|---|---|
| `key` | TEXT PK | `'schema_version'` (the only key) |
| `value` | TEXT | `SCHEMA_VERSION` as text, `"4"` (`index.rs:163-166`) |

### `files` — every visible entry, folders included

| Column | Type | Filled with |
|---|---|---|
| `path` | TEXT PK | Vault-relative path, `/`-separated, as the scan found it (no normalisation of case or Unicode form) |
| `parent` | TEXT | The folder part of `path` (`''` at the root) |
| `name` | TEXT | The last component |
| `ext` | TEXT | The extension, from `ext_of(name)` |
| `kind` | TEXT, CHECK in `page`, `folder`, `attachment` | `page` for `.md` files that are valid UTF-8; `folder`; everything else, `.txt` and code files included, is `attachment` (`session.rs:47-50`, `219-250`) |
| `mtime_ns` | INTEGER | Modification time in ns since the epoch, clamped to i64 (`session.rs:513`); `0` if the OS doesn't report one |
| `size` | INTEGER | Bytes (`0` for folders) |
| `hash` | TEXT, nullable | BLAKE3 of the content, hex (`crates/nimw-vault/src/hash.rs:9`); `NULL` for folders |

Index: `files_parent(parent)`.

### `pages` — one row per page

| Column | Type | Filled with (`PageMeta`, `crates/nimw-markdown/src/page.rs:8`) |
|---|---|---|
| `path` | TEXT PK → `files` | |
| `title` | TEXT | The visible text of an H1 that is the body's **first block**, else the file stem (`crates/nimw-markdown/src/title.rs:1-10`, PG-01 as revised in M4b part 3) |
| `subtitle` | TEXT | Frontmatter `subtitle:` |
| `cover` | TEXT | Frontmatter `cover:` as written |
| `cover_y`, `cover_x` | INTEGER 0–100 | Frontmatter `cover-y`, `cover-x` |
| `excerpt` | TEXT | First ~200 characters of body text (`crates/nimw-markdown/src/body.rs:7`), shown on cards |
| `has_image`, `has_audio` | INTEGER 0/1 | Any embed, image or Markdown link whose target ends in an image or audio extension (`page.rs:36-56`) |
| `frontmatter_error` | TEXT | The YAML error, when the frontmatter doesn't parse (the page is still indexed) |
| `icon` | TEXT | Frontmatter `icon:`, when it is a valid emoji (schema 4, M5b §4) |

### `tags`

| Column | Filled with |
|---|---|
| `path` | → `files` |
| `tag` | The tag as written (frontmatter `tags:` plus body `#tags`, de-duplicated by key) |
| `tag_key` | NFC-normalised and lowercased (`crates/nimw-markdown/src/types.rs:37-41`) |

Indexes: `tags_key(tag_key)`, `tags_path(path)`.

### `links` — every outgoing link of every page

| Column | Filled with |
|---|---|
| `id` | INTEGER PK |
| `src` | The page the link is in (→ `files`) |
| `kind` | `wiki`, `embed`, `markdown`, `markdown_image`, `related` (frontmatter `related:`) or `cover` (frontmatter `cover:`) (`types.rs:59-64`) |
| `target_raw` | The target as written |
| `target_key` | `link_key(target)`: NFC-lowercased base name without a trailing `.md`. It follows `\` too, and a `file:` URL is decoded first (`crates/nimw-markdown/src/resolve.rs:16`). It decides which links a create, remove or rename can affect. |
| `target_path` | The resolved vault path, or `NULL` while unresolved (§5.6) |
| `heading`, `alias` | `[[Page#heading\|alias]]` parts |
| `start`, `end` | Byte offsets of the link in the file, used to rewrite links on rename (EXP-04) |
| `encoded`, `angle` | Whether the Markdown target was percent-encoded or `<…>`-wrapped, so a rewrite keeps the form |
| `label`, `directed` | For `related:` entries (GV-22) |

Indexes: `links_target_path`, `links_target_key`, `links_src`.

### `page_text` and `fts` — what search reads

`page_text` (`schema.rs:64-73`) holds one row per page, with an explicit `rowid` so FTS5 can point at it.

| Column | Filled with (`crates/nimw-index/src/text.rs`) |
|---|---|
| `path` | UNIQUE → `files` |
| `title` | The page title |
| `name` | The file name without `.md` |
| `folders` | The folder names, space-separated, outermost first (so the project is a word) |
| `tags` | The tags, space-separated |
| `links` | Base names of the vault files the page links to. Covers and links to files **outside** the vault (`file:`, drive letters, UNC, `../` above the root) are left out (M5 §10.8). |
| `body` | Plain body text from the parser: Markdown syntax, frontmatter and comments dropped; wikilinks shown as their alias or target |

`fts` (`schema.rs:74-78`) is an **FTS5 external-content** virtual table over those six columns:

```sql
CREATE VIRTUAL TABLE fts USING fts5(
    title, name, folders, tags, links, body,
    content = 'page_text', content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
```

- **Tokenizer:** `unicode61` with `remove_diacritics 2`, so `canción` matches `cancion`. It does **not** segment CJK text: `京都` doesn't find `東京都` (accepted in the M5 review).
- **Prefix indexes:** for 2 and 3 characters, so short prefix queries stay fast.
- **Triggers** (`schema.rs:79-92`) keep `fts` in step with `page_text`:
  - `page_text_ai` inserts the new row;
  - `page_text_ad` issues FTS5's `'delete'` command with the **old** values, which external content requires;
  - `page_text_au` does both on an update of any of the six columns.
- **Cascades:** a cascade delete from `files` fires `page_text_ad`, so a removed file leaves no ghost in `fts`. A rename cascades `path` into `page_text`, and `Tx::rename` updates `name` and `folders` (`index.rs:568-595`), which fires `page_text_au`.

### Not in the database

These live in files, not SQLite:

- **`<vault>/.nimw/vault.json`** keys:
  - `attachments`, `attachmentLinkFormat`, `exclude`, `indexPicks`;
  - `pageWidth`, `pageWidths`;
  - `coverHeights`, `coverSides`, `coverWidths`;
  - `autoNamed`, `scratchpadFolder`;
  - `icon`, `folderIcons`, `favorites`, `folderSorts`.
- **`<vault>/.nimw/layout.json`:** Global View positions.
- **`<vault>/.nimw/trash.json`** and **`archive.json`:** the Trash and Archive records.
- **App settings:** in the OS config dir.

## 4. Schema versions

| Version | Milestone | Change |
|---|---|---|
| 1 | M1 | `files`, `pages`, `tags`, `links`, `meta` |
| 2 | M4b part 3 | Titles follow the first-block H1 rule; `pages.cover_x`; `target_key` follows `\`; Markdown `file:` links indexed |
| 3 | M5 | `page_text` and `fts` (search) |
| 4 | M5b | `pages.icon` |

(Source: the comment at `schema.rs:1-7`.)

**Rule:** the version is checked on every open, and **any mismatch rebuilds from scratch**: older, newer, or missing. There are no migrations; the index is a cache.

**How to bump:**
1. Change `SCHEMA` and increase `SCHEMA_VERSION` in `schema.rs`, adding a line to the comment above it.
2. Update `Tx::upsert_*` and the readers.
3. A test should open a database written with the old version and see it rebuilt.

A bump costs every user one full re-index on first open (§7: about 1.5 s for 10k notes).

## 5. The indexing process

### 5.1 Opening a vault

`VaultSession::open` (`session.rs:64-93`):

1. **`Vault::open(root)`.** Checks the folder and loads the exclude globs. It writes nothing (VLT-02). `.nimw/vault.json`, and Obsidian's attachment settings, are read when needed.
2. **`Index::open`** (§2).
3. **`reindex_all()`**, the full incremental pass (§5.3).
4. **Clean up after files removed while the app was closed.** Their `.nimw` entries are forgotten (`forget_page_sizes`, `session.rs:447`): page widths, cover sizes, folder icons and sorts, favourites, auto-name flags, layout positions and index picks. Quick-note auto-name flags are also dropped for every page created or modified since the last session (M4c final review I2).
5. The desktop shell then calls `start_watching()` (`crates/nimw-session/src/watching.rs:13`).

### 5.2 What the scan sees

`Vault::scan` (`crates/nimw-vault/src/scan.rs:42`) walks the whole vault.

**Skipped:**
- **Hidden names at any depth:** a name starting with `.` (`crates/nimw-vault/src/lib.rs:42`), so `.obsidian`, `.git`, `.nimw` and **`.trash`**.
- **The Archive is the exception.** `.archive/` is scanned and indexed like any folder, but its own hidden children are not (`is_hidden_path`, `lib.rs:60-67`). Archived pages stay findable by links. Search and the tree filter them out unless asked (§6, `session.rs` `tree()`).
- **User-excluded globs** from `vault.json` `exclude`.
- **Symlinked folders**, and symlinks that resolve outside the vault.
- **Names that aren't valid UTF-8.** They are reported in `Scan::skipped`, which the open report shows as warnings.

**An unreadable subfolder** is reported and skipped; it doesn't stop the vault from opening (`scan.rs` `walk`).

### 5.3 The full incremental pass (`reindex_all`)

`session.rs:110-208`. It runs on open and on a watcher overflow, and sets the `indexing` flag (§5.8) while it runs.

1. **Scan** the disk; **read** every stored row's stat from the database (`Index::stats`).
2. **Diff:**
   - **Removed:** stored paths not on disk.
   - **Folders:** new, or a file that became a folder.
   - **Files:** unchanged when `mtime_ns` **and** `size` both match the stored row (`unchanged`, `session.rs:507-511`). An unchanged file is not read at all.
3. **Load changed files in parallel** with rayon (`load`, `session.rs:213-264`). Each file is read whole and BLAKE3-hashed (`crates/nimw-vault/src/fsops.rs:59-63`), then:
   - **Same hash as stored:** only the stat is updated (`StatOnly`). This happens when a file is touched without changing.
   - **Not `.md`:** an `attachment`.
   - **`.md` and valid UTF-8:** `parse_page(text, stem)` gives a `PageMeta`.
   - **`.md` but not UTF-8:** indexed as an `attachment`, with a warning.

   Progress is reported every 200 files (`SessionEvent::Progress`).
4. **Write**, under the mutex, in transactions of 500 rows each: removals, then folders, then loaded files (`Tx::remove`, `upsert_file`, `upsert_page`).
5. **Resolve every link** against the new file set (`resolve_all`, `index.rs:438`).
6. **Report:** emit `Indexed(IndexReport)` with counts, warnings and duration.

A crash in the middle leaves the already committed chunks in place. The next open's diff picks up the rest, because a file is only "unchanged" when its stored stat matches.

### 5.4 Writing one page (`upsert_page`)

`index.rs:500-554`, inside one transaction:

1. `INSERT OR REPLACE` the `pages` row.
2. Upsert the `page_text` row (`ON CONFLICT(path) DO UPDATE`). The rowid stays stable, and the trigger refreshes `fts`.
3. Delete and re-insert the page's `tags` and outgoing `links`. New links start with `target_path = NULL`; the caller resolves them afterwards.

When a `.md` file stops being a page (for example, invalid UTF-8), `upsert_file` with a non-page kind deletes its `pages`, `page_text`, `tags` and `links` rows (`index.rs:481-497`).

### 5.5 Live changes: the watcher

**In `nimw-vault`** (`crates/nimw-vault/src/watch.rs`):

- **Backend:** the `notify` crate's recommended backend (FSEvents, ReadDirectoryChangesW, inotify), watching recursively.
- **Batching:** the app does its own batching (`watch.rs:43-49`), because the debouncer crates drop macOS deletes or rescan signals. A batch closes after **200 ms** without events (`DEBOUNCE`), or after **2 s** under a continuous stream (`MAX_BATCH_WAIT`).
- **Events:** a batch carries only "this path changed" (`Changed`) or "this path is gone" (`Removed`). Hidden and excluded paths are dropped.
- **Overflow:** a backend error, a "rescan needed" flag, or an event on the vault root becomes `Overflow`.

**In the session** (`VaultSession::apply`, `crates/nimw-session/src/watching.rs:42`):

1. **Overflow:** run the full pass (§5.3) and report what changed.
2. **Otherwise, collect the dirty set:** the reported paths, plus every unindexed file and every vanished indexed file in their **parent folders**. That catches sibling renames that a backend reported badly. A changed folder is re-scanned below it.
3. **For each dirty path, stat the disk:**
   - gone → removed;
   - a new folder → its whole subtree is loaded;
   - a file whose `mtime_ns` and `size` are unchanged → skipped;
   - otherwise → `load` as in §5.3.
4. **Detect renames by content hash:** a removed file and a created file with the same BLAKE3 in one batch is a **rename**, not a delete plus create. Layout positions, icons, widths and favourites then follow it.
5. **Write everything in one transaction:** renames (`Tx::rename`, which moves the subtree and retargets resolved links), removals, folders, loaded files.
6. **Re-resolve only what can change:**
   - links whose `target_key` matches a created, removed or renamed path (`resolve_affected`);
   - every outgoing link of created, modified and renamed pages (`resolve_from`).
7. **Emit `Changed { created, modified, removed, renamed }`.** The UI reloads the tree, and an open page merges outside edits.

### 5.6 Link resolution

`resolve(kind, target, source, files)` (`crates/nimw-markdown/src/resolve.rs:147`), against a `FileSet` of every non-folder path (`index.rs:221`):

**Markdown links and images** are relative paths. They are joined with the source's folder and matched exactly, or with `.md` added when the target has no extension.

**Wikilinks, embeds and `related:`:**
1. `[[/Name]]` means the vault-root path only.
2. A target containing `/` is tried first as an exact vault path, then relative to the source folder.
3. **Otherwise, match by name.** Every file whose name key equals the target, or ends with `/target`, is a candidate (`name_key` is NFC plus lowercase, `resolve.rs:7`). Ties are broken in this order (`resolve.rs:198-207`):
   1. **Live before archived:** a page in `.archive/` only wins when nothing outside it has the name. The exception is a link that is itself in the Archive (M5b review M1).
   2. Same folder as the source.
   3. Fewest path components.
   4. Path order.

**Results:**
- An unresolvable link keeps `target_path = NULL`. It still counts as a link and shows as unresolved.
- Links to files outside the vault (absolute paths, `file:` URLs, `../` above the root) never resolve to a vault path. They are served separately, only when a saved note links them (M4b part 3 §15).
- When a file is removed, links pointing at it or into its folder are set back to `NULL` (`Tx::remove`, `index.rs:556-566`). They resolve again if the file returns.

### 5.7 Writes the app makes itself

Every write from the app goes through `Vault::write_cas` (`fsops.rs:74`): an atomic compare-and-swap that writes a temp file, fsyncs it, then renames it over the original. The session then re-indexes **that one file at once**, without waiting for the watcher (`reindex_written`, `session.rs:268-288`): re-stat, `upsert_file` and `upsert_page` in one transaction.

The callers are:
- autosave and Save (`editing.rs:19`);
- attachment imports (`attachments.rs:289`);
- new entries (`session.rs:384`);
- link rewrites on rename (`rename.rs:337`).

The watcher's later event for the same file sees an unchanged `mtime_ns` and `size` and skips it.

### 5.8 The `indexing` flag

`VaultSession.indexing` is an `AtomicBool`. It is set only while `reindex_all` runs (`session.rs:110-115`), which happens on open and on an overflow. `search` copies it into its answer (`crates/nimw-session/src/search.rs:13`), so the search dialog can say results may be incomplete. Incremental watcher batches don't set it.

### 5.9 Pages, attachments, text files

| On disk | `files.kind` | In `pages`, `fts` | Notes |
|---|---|---|---|
| `x.md`, valid UTF-8 | `page` | yes | |
| `x.md`, not UTF-8 | `attachment` | no | warning in the report |
| images, audio, PDFs, other files | `attachment` | no | link targets; `has_image`/`has_audio` come from links, not from these rows |
| `.txt`, code and other text files | `attachment` | **no** | opened in the app's text view (M4b part 2), but **not searchable** at `de2378e`; a batch-6 item |
| folders | `folder` | no | |
| `.trash/…`, `.git`, `.obsidian`, `.nimw` | not indexed | | hidden |
| `.archive/…` | as above | yes (flagged by path) | excluded from search and the tree unless asked |

## 6. Search on top of the index

Entry point: `Index::search` (`crates/nimw-index/src/search.rs:241`), called through `VaultSession::search` under the session mutex.

1. **Query text** (`fts_query`, `search.rs:144`):
   - The text is split into words and `"quoted phrases"`. An unclosed quote runs to the end, and control characters act as spaces.
   - Every word becomes a quoted FTS5 string with `*`, so it matches as a prefix. FTS5 syntax typed by the user (`AND`, `NEAR(`, `^`, `:`) is always plain text.
   - A word with no letter or digit is dropped.
   - Two queries are built: `all` (every word must match) and `any` (at least one).
2. **Scoring** (`fill_hits`, `search.rs:451`). Matches of `all` go into a temp table, `temp.nimw_hits`, with:
   - `bm25(fts, 10, 8, 5, 6, 4, 1)`, the weights for title, name, folders, tags, links and body (`search.rs:27-28`);
   - a `meta` flag, set when `any` also matches within `{title name folders tags links}`. This is the **metadata bonus**: a metadata match always ranks above a body-only match.
3. **Filters:**
   - SQL conditions on `files`, `pages`, `tags` and `links`: project, folder, tags (all must be present), links to, links from, has image, has audio.
   - Archived pages are left out unless the Archived chip is on.
   - All matches are written once into `temp.nimw_match`, which the count, the page of results and most facets read (`search.rs:365-381`).
4. **Order:**
   - With text: `meta DESC, score, length(path), mtime DESC, path`.
   - Without text: newest first. An empty query with no filters is **Recent**, the 20 newest pages.
5. **Facets:**
   - projects (top 20), tags (top 12), links-to (top 8), image and audio counts, archived count.
   - Project, links-to and media facets ignore their own filter; tags drill down.
   - Above 1,500 matches the candidates come from an even sample, and the counts are then exact (`SAMPLE`, `sampled`, `search.rs:24`, `605`).
6. **Snippets:**
   - About 12 words of the stored `page_text.body` around the first matching word, cut in Rust (`snippet`, `search.rs:560`).
   - FTS5's own `snippet()` cost 25–40 ms per page of results.
   - They are returned as structured parts, never HTML.
   - Folding for highlights uses `fold()`: NFD, combining marks dropped, then lowercase (`crates/nimw-index/src/fold.rs`).
7. **Temp tables** (`nimw_hits`, `nimw_match`, `nimw_except`) are per connection, created `IF NOT EXISTS` and cleared at the start of each search. Searches never overlap, because they run under the session mutex.

The UI debounces typing by 80 ms (`apps/desktop/src/features/search/searchStore.ts:7`).

## 7. Performance budgets and their tests

NFR-03, on a generated 10,000-note vault (`nimw_testkit::generate_vault`, `VaultShape::TEN_K`, `crates/nimw-testkit/src/lib.rs:112`, `144`):

| Budget | Test | Last measured |
|---|---|---|
| First full index < 30 s | `nfr_03_search_p95_under_50_ms` (`crates/nimw-session/tests/search.rs:105`) | 1.63 s |
| Search p95 < 50 ms over 200 queries | same test | p95 41.4 ms, p50 22.6 ms (M5 fix pass, machine under load); 34.8 ms on a quieter run |
| Re-index one changed page < 100 ms | same test | 20.9 ms |
| A 200-card Global View level and its edges < 100 ms | `nfr_03_a_200_card_level_and_its_edges_in_under_100_ms` (`crates/nimw-session/tests/global_view.rs:403`) | |
| An outside move of 1,000 pinned notes writes the layout once | `m3a_an_external_move_of_1000_pinned_notes_writes_the_layout_once` (`global_view.rs:517`) | |

They are `#[ignore]`d. Run them in release:

```sh
cargo test --release -p nimw-session --test search -- --ignored --nocapture
cargo test --release -p nimw-session --test global_view -- --ignored
```

There is no nightly benchmark job yet (architecture §9.2 planned one for M8).

## 8. Invariants and failure modes

| Situation | What happens |
|---|---|
| Crash in the middle of a write | Each transaction is atomic (WAL). The full pass commits in 500-row chunks; the next open's stat diff redoes whatever is missing. |
| Corrupt database | `PRAGMA quick_check` fails at open, so the database is deleted (with `-wal` and `-shm`) and rebuilt (`index.rs:111-121`, `137-140`). Corruption that appears **while** the vault is open surfaces as command errors until the next open (not detected live). |
| Database from another version | Rebuilt (§4). |
| Vault changed while the app was closed (Finder, Obsidian, sync, git) | The open pass diffs every file by `mtime_ns` and `size`. Content is hashed only for files whose stat changed. |
| A file rewritten with the **same** size and mtime | Not detected: the stat diff trusts it. This is very rare; tools that preserve mtime are the risk. Not handled. |
| Rename while the app was closed | Seen as a delete plus a create. Links re-resolve by name, but layout positions, icons and favourites don't follow it. Only renames the watcher sees in one batch are detected by hash. |
| Case-insensitive file systems (APFS, NTFS) | Paths are stored as the scan reports them. Name matching for links is case-insensitive (`name_key`). A case-only rename made outside the app arrives as a rename. |
| NFC vs NFD names (macOS) | Link keys and tag keys are NFC-normalised, so `Café` (NFD on disk) and a typed `Café` (NFC) match. `files.path` keeps the on-disk form. |
| Huge files | Indexing reads every **changed** file whole into memory to hash it, attachments included (`fsops.rs:59-63`). There is **no size cap** for indexing (not handled). A multi-GB attachment costs that much memory on first index and on every change. The text view caps text files at 2 MB (`TEXT_MAX_BYTES`), and single-file windows cap notes at 16 MB (`PAGE_MAX_BYTES`), but those are UI caps, not index caps. |
| Unreadable file or folder | Warned and skipped; the vault still opens. |
| Search while a full pass runs | Returns what is indexed so far, with `indexing: true`. |
| Long-running search | Holds the session mutex (~20–40 ms), so a watcher batch or a save's re-index waits for it. Stale debounced searches are not cancelled. |

## 9. Inspecting the database

Quit the app first. A second writer is safe with WAL, but the app doesn't expect one.

```sh
# macOS: find the vault's database by its folder's hash
DB=~/Library/Caches/app.notesinmyway.desktop/nimw/<hash>/index.sqlite
sqlite3 "$DB"
```

The `<hash>` is the first 16 hex characters of `sha256(<canonical vault path>)`. Alternatively, pick the folder whose `index.sqlite` changed last.

```sql
SELECT value FROM meta WHERE key = 'schema_version';     -- 4
SELECT kind, count(*) FROM files GROUP BY kind;
SELECT path, title, icon FROM pages ORDER BY path LIMIT 20;

-- Unresolved links, by page
SELECT src, target_raw FROM links WHERE target_path IS NULL AND kind IN ('wiki','embed');

-- Backlinks of a page
SELECT src FROM links WHERE target_path = 'Narrative & Lore/Brainstorming.md';

-- Tags with counts
SELECT tag_key, count(*) FROM tags GROUP BY tag_key ORDER BY 2 DESC LIMIT 20;

-- A raw full-text query (prefix match, best first)
SELECT pt.path, bm25(fts, 10, 8, 5, 6, 4, 1) AS score
FROM fts JOIN page_text pt ON pt.rowid = fts.rowid
WHERE fts MATCH '"drag"*' ORDER BY score LIMIT 10;

-- Integrity
PRAGMA quick_check;
INSERT INTO fts(fts) VALUES ('integrity-check');
```

**To force a rebuild,** do either of these:
- delete the vault's `<hash>/` folder while the app is closed;
- set the version to something else (`UPDATE meta SET value = '0' WHERE key = 'schema_version';`) and reopen the vault.

## 10. Known gaps (backlog candidates)

- **Orphaned databases** of moved, renamed or deleted vaults are never removed from the cache dir.
- **No size cap when indexing.** Large attachments are read whole to hash them. A cap, with attachments hashed only on demand, would bound memory.
- **`.txt` and code files aren't searchable** (they're `attachment` rows; batch 6 is adding this).
- **Renames made while the app was closed** lose layout positions, icons and favourites.
- **Corruption during a session** isn't detected until the next open.
- **CJK search** needs a different tokenizer (for example `trigram`) to match inside words.
