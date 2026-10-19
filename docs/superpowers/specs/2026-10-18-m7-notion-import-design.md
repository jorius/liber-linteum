# M7 — Notion importer: Design

**Status:** Jose answered the three open questions on 2026-10-18. Everything else below is a ruling taken for him; they are listed in §12 for him to confirm.
- **Grounding:** product spec §9.3 (IMP-01–IMP-04, Q-IMP-1 and Q-IMP-2, all DECIDED). `crates/nimw-import` (`strip_notion_id`) exists since M0.
- **Branch:** `feat/m7-import`, from `feat/batch6` (`de2378e`, the same as `main`).

## 1. Goal

Turn a Notion workspace export into a vault the user can open at once, with:
- names cleaned;
- links working;
- callouts and toggles readable;
- databases kept as pages with properties.

Nothing is written before the user has seen what will happen.

## 2. Jose's answers

1. **Input:** Notion's **Markdown & CSV** export zip only, including the nested part zips that large exports contain. The HTML export is out of scope.
2. **Target:** **always a new vault.** Its parent folder is chosen in a dialog and its name typed by the user. Importing into an open vault isn't offered.
3. **Databases:** **an index page plus row pages.** Each row page gets frontmatter from its CSV columns. The database becomes an index page holding a Markdown table that links its rows.

## 3. Flow (UI)

**Entry points:**
- **File → Import from Notion…** in the native menu. It goes to the main window, as New Quick Note does.
- **Import from Notion** on the Welcome screen.

**The dialog** (one modal, four steps):
1. **Export file.**
   - **Choose export…** opens a Rust file dialog filtered to `.zip`.
   - The page never sends a path. Rust keeps the picked file as this import's grant.
2. **New vault.**
   - **Choose location…** opens a Rust folder dialog for the parent folder.
   - **Vault name** is a text field. Its default is the zip's name without the `Export-<uuid>` part, else "Notion".
   - The name must be one valid file name, and the folder must not exist yet.
3. **Preview** (dry run, nothing written). It shows:
   - counts of pages, databases, database rows, attachments, and folders;
   - the total size;
   - warnings, such as skipped entries, unmatched rows and links that point nowhere (the first 50, then "and N more").
4. **Import.**
   - A progress bar ("1,240 of 5,310 files") with **Cancel**.
   - On success, the new vault opens in the main window at its report page.
   - On cancel or failure, the dialog says what was written and where.

- **Keyboard:** the steps are in tab order; Enter on the last enabled button acts; Escape cancels the dialog (and asks to cancel a running import).
- **Floors:** axe-clean in light and dark; i18n in en and es; the Safari 15 floor.

## 4. Reading the zip (`nimw-import::archive`)

Every byte of the zip is untrusted input.

- **Nested zips:** when the outer zip holds nothing but `.zip` entries (Notion's multi-part export, `Export-…-Part-N.zip`), each part is copied to a temp file and read as one tree. Otherwise a `.zip` inside is an ordinary attachment. Only one level is expanded.
- **A common export root:** if every entry sits under one top-level folder whose name is `Export-<hex or uuid>` (newer exports), that folder is dropped.
- **Unsafe names are refused:**
  - absolute paths, drive prefixes, `..` and `.` components, NUL;
  - symlink entries (Unix mode `S_IFLNK`);
  - directory-only entries are ignored, since folders come from file paths.

  Backslashes are read as separators. Each refused entry becomes a warning. Names never reach the disk as given anyway: every component is rebuilt by §5 and written through `nimw-vault`'s `VaultPath`.
- **Limits** (bomb protection), refusing the export with a clear error:

  | Limit | Value |
  |---|---|
  | Entries | 200,000 |
  | Total uncompressed size | 16 GiB |
  | One entry | 4 GiB |
  | Ratio, for entries over 1 MiB | 1,000 : 1 |
  | `.md` or `.csv` read into memory | 32 MiB each (larger ones are skipped, with a warning) |

  Reads are capped at the declared size, so a lying header can't stream more.
- **Encodings:** UTF-8 names when flagged, otherwise the zip crate's CP437 decoding. Markdown and CSV that isn't valid UTF-8 is decoded lossily, with a warning. Notion writes UTF-8, with a BOM on CSVs, which is stripped.
- **Where it works:** straight from the archive. Only nested part zips go to temp files, which are deleted when the import ends.

## 5. Names (`nimw-import::names`)

For every path component:
1. **Strip** Notion's ` <32 hex>` id (`strip_notion_id`, M0).
2. **Clean the name:**
   - the vault name rules turn refused characters (`/ \ # | ^ [ ] : * " < > ?` and controls) into `-` (`sanitize_file_name`);
   - leading dots become `-`;
   - trailing dots and spaces are trimmed;
   - Windows device names (`CON`, `NUL`, `COM1`…) get a `-` suffix;
   - a component over 200 bytes is cut at a character boundary.
3. **De-duplicate** case-insensitively and with NFC within each folder, in a stable order (sorted original names), as `Name.md`, `Name 1.md`, `Name 2.md`. Files and folders share the namespace, but `Page.md` beside a folder `Page/` is fine, since that is Notion's page-and-children shape.

The original-to-new path map is the one source for links (§6) and for row matching (§7).

## 6. Pages (`nimw-import::markdown`)

**Links:**
- `[Text](Some%20Page%20<id>.md)` → `[[Target|Text]]`, or `[[Target]]` when `Text` equals the name. The link is relative to the page's own folder, and percent-decoded.
- `Target` is the bare name when it's unique in the vault, else the vault path without `.md`. Obsidian resolves both.
- `[Text](Tasks%20<id>.csv)` (a database) → a link to the database's index page.
- `![alt](Page%20<id>/image.png)` and other attachments → `![[path/in/vault/image.png]]`, the full vault path, so it always resolves.
- External links (with a scheme), `mailto:` and anchors stay as they are.
- A relative link that matches no entry stays as it is and adds a warning ("link to … points nowhere").
- Code spans and fenced code blocks are never rewritten.

**HTML Notion leaves in Markdown:**
- `<aside>` … `</aside>` → `> [!note]`, with each inner line quoted. Notion puts the callout's emoji on the first line; it stays as text.
- `<details><summary>Title</summary>` … `</details>` → `> [!note]- Title`, a folded callout, with the body quoted.
- Both nest: an inner block adds another `> ` level.
- **Any other HTML is kept as written.** The app's sanitizer already decides what renders.

**Database rows:** a row page's leading property lines (`Key: value` lines right after the `# Title`, for keys that are CSV columns) are removed. The values move to frontmatter (§7).

**Icons and covers:** the Markdown export carries no page icon or cover metadata, so none is imported. Images a page shows stay as images.

## 7. Databases (`nimw-import::database`)

- **Which CSV:** a database comes as `Tasks <id>.csv`, often with `Tasks <id>_all.csv` (every row, every property), plus a folder `Tasks <id>/` of row pages. `_all.csv` is used when present, otherwise the plain CSV. The other is ignored.
- **CSV parsing:** RFC 4180, so quoted fields, `""` escapes and newlines inside quotes work. A leading BOM is stripped. The first row is the header, and the **first column is the title** (Notion's Name).
- **Matching rows to pages:** a row's cleaned title is matched to the cleaned stem of a page in the database's folder. Duplicates are matched in order.
  - A page with no row stays a plain page, with a warning.
  - A row with no page gets one, `<folder>/<title>.md`, with frontmatter and `# Title` only.
- **Frontmatter:** one key per column other than the title, in CSV order, with types inferred per column from all non-empty values:

  | Values | Written as |
  |---|---|
  | all `Yes`/`No` | booleans |
  | all numbers (no leading zeros, no thousands separators) | numbers |
  | all Notion dates (`October 18, 2026`, optionally with a time), or ISO dates | `2026-10-18` (or `2026-10-18T15:30`) |
  | all relations (`Name (path.md)`, comma-separated) | a list of `"[[Target]]"`, resolved like §6 links |
  | some value holds `", "`, every part is ≤ 60 characters and no value is over 200 | a list of strings (multi-select) |
  | anything else | strings (people, URLs, text, formulas) |

  - Empty cells are left out.
  - Keys and strings are written as YAML double-quoted scalars, so `:`, `#` and quotes are safe.
- **The index page:** `<parent>/<Database>.md`, beside the rows' folder (de-duplicated like any name). It contains:
  - `# <Database>`;
  - a Markdown table with one row per CSV row: the first cell is `[[<folder>/<Row>\|<Row>]]`, the other cells the raw CSV values, with `|` escaped and newlines as `<br>`.
- A database with no folder (an inline database) gets its index page and its row pages, made from the CSV alone.

## 8. Writing (`nimw-import::import`)

- **Target:** `<parent>/<name>`.
  - It must not exist. It is created with `create_dir`, never merged into an existing folder.
  - The parent must be the folder the user just picked.
- **Order:**
  1. folders, created with `Vault::create_dir_all`;
  2. pages, rows and index pages, written as UTF-8 with LF, create-only (`write_cas(None)`);
  3. attachments, streamed from the zip through `Vault::import_reader`, create-only, through a hidden temp file then a rename;
  4. the report.
- **Paths:** every write goes through `VaultPath`, so nothing can land outside the new folder.
- **The report:** `Notion import report.md` at the root. It records:
  - the source file and the date;
  - the counts;
  - every warning;
  - every skipped entry, with its reason;
  - on cancel or error, how far the import got.
- **Cancel and errors:** checked between files.
  - Cancelling or failing leaves the partial vault, with the report saying so (ruling 4). Nothing is deleted, because removing files the app just wrote is the riskier choice.
  - The dialog offers **Open it anyway** or **Show in Finder**.
- **Progress:** the `notion:progress` event `{ done, total }`, at most every 100 ms.

## 9. Commands (desktop)

All of these are async through `blocking()`, allowed in `main` only, and denied in `file-*` windows (real-ACL tests both ways).

| Command | Does |
|---|---|
| `notion_pick_zip()` | Rust file dialog (`.zip`). Remembers the file and returns `{ name, suggestedName }` or nothing. |
| `notion_pick_parent()` | Rust folder dialog. Remembers it and returns its path for display, or nothing. |
| `notion_preview()` | Dry run of the remembered zip, returning counts and warnings. |
| `notion_import(name)` | Imports into the remembered parent `/ name`, opens the new vault (like `scratchpad_open`) and returns `{ vault, report }`. |
| `notion_cancel()` | Asks a running import to stop. |

The page never names a path. A test hook replaces each dialog, as `ScratchpadState` does.

## 10. Performance

- **Target:** a 5,000-page export with 1,000 database rows and 500 attachments imports in **under 60 s** on the reference Mac. The preview of the same export takes under 10 s.
- **Test:** a release test (`--ignored`) builds such a zip in a temp folder and measures both.

## 11. Testing

- **Rust (`nimw-import`)**, against synthetic exports built in the tests with the `zip` crate's writer:
  - id stripping, collisions, and dropping the common export root;
  - nested part zips, plus a zip inside an ordinary export that stays an attachment;
  - zip-slip entries (`../x`, `/abs`, `C:x`, symlinks), refused with warnings;
  - limits (ratio, entry count) refused;
  - link rewriting, including ambiguity, `.csv` links, attachments, externals, code blocks and missing targets;
  - `<aside>` and `<details>`, including nesting;
  - databases: `_all.csv` preferred, type inference per type, relations, CSV-only rows, unmatched pages, index table escaping;
  - writing: create-only, a target that already exists refused, the report, cancel halfway;
  - perf (`--ignored`).
- **Desktop:**
  - real-ACL allowed and denied;
  - each command with the picker hooks;
  - `notion_import` opens the vault;
  - a file window is refused.
- **TS:** the dialog's steps, validation, progress, cancel, the result and errors; axe; i18n.
- **E2E** (Chromium and WebKit, mocked IPC): Welcome → Import from Notion → pick → preview → import → the vault opens at the report.
- **Real window:** a real Notion export from Jose (§13).

## 12. Rulings to confirm (taken for Jose)

1. Only the multi-part shape expands nested zips. Any other `.zip` in an export is an attachment.
2. An `Export-<id>` top folder is dropped, so the vault's root is the workspace's top level.
3. Non-callout HTML is kept as written; the renderer's sanitizer handles it.
4. **Cancel or failure leaves the partial vault, with a report.** No rollback.
5. Multi-select is a heuristic: comma-separated short values. A text column whose values happen to contain commas could become a list.
6. Dates are written as plain ISO dates; times are kept when Notion gave one. Ranges (`A → B`) stay text.
7. Page icons and covers aren't imported, because the Markdown export doesn't carry them.
8. A database's index page sits beside its rows' folder (`Tasks.md` plus `Tasks/`).
9. `_all.csv` wins over the plain CSV.
10. Row pages lose their `Key: value` property lines; the values live in frontmatter only.

## 13. Needs a real export

- **The real shapes:** CSV date formats in Jose's Notion locale, and the relation format in CSVs.
- **Differences in the actual export:** callouts with colours, nested toggles inside lists, inline databases, and long-name truncation.
- **Performance** on a real multi-part export.

## 14. Out of scope

- The HTML export.
- Notion API sync.
- Comments.
- Inline databases inside pages beyond a link to their index.
- Importing into an existing vault.
- Notion's page icons and covers.
- Formula and rollup evaluation (their exported text is kept).

## 15. Amendments from building it

These override §4–§11 where they conflict.

1. **Plain create-only writes, without fsync.**
   - **How:** files go straight into the brand-new folder, using `create_new` with no temp file and no per-file `fsync`. This replaces `write_cas` and a temp-file rename.
   - **Why:** nothing else reads the folder until the import ends, and a crash leaves a partial vault anyway (ruling 4).
   - **Effect:** the 5,000-page perf test went from 49 s to **0.5 s** (release; the preview takes 75 ms).
   - **Failures:** a file that fails mid-copy is removed, so no half-written file is left.
2. **The import plans again rather than reusing the preview.** `notion_import` reads the export a second time and builds the same plan; nothing is cached between the two commands.
3. **Relations resolve relative to the CSV's folder,** the same way as links in a page.
4. **The report is written even when the import fails part-way.** It records where and why the import stopped, and the command then returns the error.
5. **Progress events** are sent at most every 100 ms, plus once at the end.
6. **The Welcome screen's button is now live.** It was disabled with "arrives in a later milestone", and that note and its string are removed.
7. **Unrelated to the importer:** three new Linux-only advisories, RUSTSEC-2026-0370, -0371 and -0372, were published on 2026-10-18. They mark zbus's `zvariant` family unmaintained, reaching the app through tauri-plugin-opener and tauri-plugin-single-instance. They are ignored in `deny.toml` with a reason, as RUSTSEC-2024-0370 is.
8. **Dependencies added:**
   - `zip` 9.0.5 (MIT), read and write, with deflate only through flate2 + zlib-rs (MIT/Apache-2.0, Zlib);
   - `tempfile` (MIT/Apache-2.0) at runtime, for nested part zips.

   `cargo deny` passes.

## 16. Batch 6 review

Fixes from the Opus review of `de2378e..1000f4e` (2026-10-18), each with a test that failed first. These override §3–§15 where they conflict.

**Fixed:**
- **I1:** a multi-byte character where a date's digits would be (`2026-10-1é`) no longer panics; the ISO check reads its parts with `str::get`.
- **I2:** link rewriting is linear: brackets are paired in one stack pass, and code spans are found without copying the rest of the line. A 1 MiB line of `[` converts in milliseconds. `plan()` checks the cancel flag between files.
- **I3:** the plan holds no converted page. Each page is converted once for its warnings, then again as it is written. An export whose pages hold more than `Limits.pages` (1 GiB) of Markdown is refused in the preview.
- **I4:** a multi-part export's parts count against `Limits.total` before each is copied to a temp file, and their number against `Limits.entries`.
- **I5:** a CSV is a database only when Notion named it (an id in its name) or its rows' folder is in the export. Any other CSV is an attachment, linked as a file.
- **I6:** `A → B` date ranges are dates, written quoted as ISO ranges. A column holding a date, or `, ` then a year, is never a list.
- **I7:** a cancelled re-pick keeps the export or place already picked; both Choose buttons are disabled while the export is read.
- **I8:**
  - A taken or refused vault name goes back to the preview with the error, with no re-pick.
  - An import that stops part-way (a full disk, or a report that can't be written) returns its vault unopened, with `failed` and `root`.
  - The dialog then offers **Open it anyway** and **Show in Finder / Explorer**, through `notion_open_partial` and `notion_reveal_partial`. Both act on the vault Rust recorded, never on a path from the page.
- **M1:** a folder that can't be made is a warning in the report, not silently ignored.
- **M2:**
  - A path the zip names twice (`x/a.md`, `x\a.md`) is listed once.
  - A file and a folder of one name each get a name.
  - A vault path over 600 bytes is skipped with a warning.
  - A file that can't be written is a warning, and the import goes on.
- **M3:** the report is written best-effort, and the first error is the one reported.
- **M4:**
  - A date's time part is validated strictly (`THH:MM[:SS[.f]][Z|±HH:MM]`), else it is quoted text.
  - Keys YAML reads as booleans, nulls or numbers are quoted.
  - Repeated headers get ` 2`, ` 3`.
- **M5:** each report warning is one Markdown code span, so export names can't format the report.
- **M6:** the device-name check runs after the 200-byte cut.
- **M7:**
  - The page checks the name rules Rust applies as you type.
  - An existing target is refused before the export is read again.
- **M8:** the cancel flag is reset when a preview starts, not when the import starts, so a Stop pressed in between is honoured.
- **M9:** importing moves focus to Stop, so Escape stops it.
- **M10:** the starting total counts each database's index page.

**Rulings (cost if wrong):**
1. **Only a full disk stops the import.** Every other per-file error is a warning, and the import goes on. Cost: an import with many failing files is reported as finished, though the report lists every failure.
2. **Long paths are skipped, not shortened.** A vault path over 600 bytes is skipped at plan time with a warning, rather than renamed to fit. Cost: very deep Notion trees lose their deepest pages; the report names them.
3. **A partial vault isn't opened automatically.** The dialog offers to open it instead. Cost: one click.
4. **The name rules live in two places.** The page mirrors Rust's rules rather than calling a separate check command. Rust still enforces them, so a mismatch only shows the error later.
5. **Pages are read and converted twice,** once while planning (for warnings) and once while writing. Cost: about twice the conversion time, still well under the budget (see §10).

**Deferred:** none from this review.
