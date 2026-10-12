# Notes In My Way — Product Spec (v0.2)

> **Status:** v0.2 — all open questions closed · **Date:** 2026-10-12
> **Roles:** Jose — tech lead · PO — product owner (owns the idea and final say on behavior)
> **Purpose of this file:** the single source of truth for *what* we build and *why*, written to be handed to Claude Code.
> **Not in this file:** architecture, stack, libraries, storage engines. Those live in `docs/superpowers/specs/2026-10-12-architecture-design.md`.

---

## 0. Instructions for the implementing agent (Claude Code)

1. Architecture, framework and library decisions live in `docs/superpowers/specs/2026-10-12-architecture-design.md`. Do **not** make new ones from this spec; if a task needs a decision not covered there, stop and ask.
2. All requirements are **[DECIDED]**. §10 records how each former open question was resolved. If a new question arises, add it to §10 as open and ask before implementing around it.
3. Every requirement has an ID (e.g. `GV-04`). Reference IDs in commits, PRs and tests.
4. Acceptance criteria are written as *Given / When / Then* and must be covered by tests where feasible.

---

## 1. Product summary

A personal, **offline, local-only, privacy-first** note-taking desktop app that combines:

- **Obsidian's** model: plain Markdown files in user-owned folders, wikilinks, file explorer, Live Preview editing.
- **Milanote's** visual feel: a canvas of rich preview cards instead of abstract graph dots.

The defining feature is the **Global View**: a navigable canvas where each project, folder and page is shown as a **preview card** (cover image, title, subtitle, excerpt), connected by their relationships, explored level by level.

### 1.1 Principles [DECIDED]

| # | Principle |
|---|-----------|
| P1 | **Local-only, forever.** No cloud, no sync, no accounts. The app makes no network requests on its own. |
| P2 | **Your files stay yours.** Notes are plain `.md` files in a normal folder structure, readable without the app. |
| P3 | **Obsidian-compatible.** An existing Obsidian vault opens as-is; `[[wikilinks]]` are supported. |
| P4 | **Privacy by default.** No telemetry. Embedded HTML cannot run scripts or load remote resources. Optional vault encryption (post-MVP). |
| P5 | **Free and open source** (GPL-3.0-or-later), with a donations link. |
| P6 | **Bilingual from day one:** English and Spanish, built so more languages can be added later. |

---

## 2. Glossary

| Term | Meaning |
|------|---------|
| **Vault** | A folder on disk chosen by the user. Everything inside it is the user's notes and attachments. |
| **Project** | A **top-level folder** directly inside the vault root, excluding hidden and attachment folders (VLT-05). [DECIDED] |
| **Folder** | Any folder below a project. |
| **Page** (a.k.a. note) | A single `.md` file. |
| **Title** | The page's first H1 if present; otherwise the file name (without extension). [DECIDED] |
| **Subtitle** | The page's frontmatter `subtitle:` field, editable from the page header. [DECIDED] |
| **Cover** | An image attached to a page, Notion-style, shown at the top of the page and as the card image in the Global View. [DECIDED] |
| **Index note** | The page that represents a folder/project in the Global View: a page named like the folder or `index.md`; otherwise the page the user picked; a single-page folder uses that page. Without one, the card shows a folder summary. [DECIDED] (Q-GV-1) |
| **Card** | The preview of a project, folder or page in the Global View. |
| **Level** | One step of depth in the Global View. Level 0 = vault root. |
| **Edge** | A line between two cards. Three kinds: **link** (wikilink/Markdown link in text), **hierarchy** (parent/child folder relationship), **relationship** (drawn manually by the user). [DECIDED] |
| **Block** | A top-level or nested structural unit of a page: heading, paragraph, list item, quote, callout, code block, table row, image, audio clip, embed, HTML block, column. |
| **Clip** | An audio file recorded or uploaded by the user and embedded in a page. |

---

## 3. Scope

### 3.1 In scope for MVP
- Open/create a vault; file & folder explorer.
- Markdown pages with Obsidian-compatible syntax (§5).
- Global View with drill-down / expand-in-place toggle (§6).
- Editor: Live Preview, Source, and Split (source | rendered preview) (§7).
- Drag-and-drop block reordering in the rendered preview (§8).
- Audio clips: record, upload, inline playback (§9.1).
- Search with filters, including full-text (§9.2).
- Open Obsidian vaults as-is; **Notion importer** (Markdown & CSV export) (§9.3).
- English & Spanish UI; light and dark themes.
- Packages: Windows, macOS, Linux (`.deb`, `.AppImage`), shipped simultaneously.

### 3.2 Out of scope [DECIDED]
- Cloud sync, accounts, collaboration, sharing/publishing.
- Plugins / extension API.
- Mobile apps, web app.
- Evernote importer. (A dedicated Milanote importer was not requested; its Markdown export is plain Markdown and loses board layout/connections.)
- Running scripts or loading remote content inside notes.
- Explicit export (the vault folder is the export) (Q-IMP-2).
- In-app update checks; users update manually (Q-UPD-1).

### 3.3 Post-MVP [DECIDED]
- **Vault encryption** (Q-SEC-1..4): whole vault; while locked, files are unreadable by Obsidian or any other tool (accepted); a lost password means lost data, with a clear warning at setup (accepted). The MVP architecture keeps a storage seam for it.

---

## 4. Vault & file explorer

| ID | Requirement |
|----|-------------|
| VLT-01 | The user can create a new vault (choose an empty folder) or open an existing folder as a vault. |
| VLT-02 | Opening an existing Obsidian vault must not modify any existing file unless the user edits it. |
| VLT-03 | The app stores its own per-vault data (layout positions, index-note picks, settings) in a hidden `.nimw/` folder created only when first needed, plus a rebuildable cache outside the vault. Details: architecture doc. |
| VLT-04 | Changes made to files outside the app (another editor, Obsidian, file manager) are reflected in the app without restart. |
| VLT-05 | **Exclusions:** dot-folders (`.obsidian`, `.git`, `.trash`, `.nimw`, …) are ignored everywhere; attachment folders are hidden from the Global View but shown in the explorer; the user can add exclude globs per vault. [DECIDED] |
| EXP-01 | A collapsible sidebar shows the vault tree (folders and pages), Obsidian-style. |
| EXP-02 | Create, rename, move (drag & drop), and delete pages and folders from the explorer. |
| EXP-03 | Delete moves items to the OS trash (not permanent deletion). [DECIDED] |
| EXP-04 | Renaming or moving a page updates links pointing to it. [DECIDED] |
| EXP-05 | Clicking a page in the explorer opens it in the editor. |

**Acceptance**
- *Given* an Obsidian vault with nested folders, *when* the user opens it, *then* the explorer shows the same tree and no file's content or mtime changes.
- *Given* a page open in the app, *when* it is edited in another program and saved, *then* the app shows the new content.
- *Given* a vault containing `.obsidian/` and `.git/`, *when* the Global View opens, *then* neither appears as a project.

---

## 5. Page format

### 5.1 Syntax [DECIDED]
- **Tier A (portable):** CommonMark + GitHub-Flavored Markdown (tables, task lists, strikethrough) + Obsidian extensions: `[[wikilinks]]`, `![[embeds]]`, callouts, `#tags`, YAML frontmatter.
- **Tier B (Notion-like extras)** (Q-FMT-1):
  - **Layout columns** — syntax Obsidian renders as raw text; this incompatibility is accepted.
  - **Toggles** — foldable callouts (`> [!note]- Title`), Obsidian-native.
  - **Highlights** `==text==` (Obsidian-native) and **colored text** `<span data-color="…">` from a fixed, theme-aware palette (plain text in Obsidian).
  - **Dividers** `---`.
  - Not in MVP: custom callout colors, page icons.
  - Exact syntax: architecture doc.
- **Embedded HTML** is allowed, sanitized:
  - No `<script>`, no inline event handlers (`on*`), no `javascript:` URLs.
  - No remote sources of any kind (`http(s)://` in `src`, `href` for resources, `srcset`, CSS `url()`, `@import`, iframes to remote origins). Local vault files only.
  - Exact allowlist of tags/attributes: architecture doc.

### 5.2 Page metadata
| ID | Requirement |
|----|-------------|
| PG-01 | **Title** = first H1; fallback to file name. [DECIDED] |
| PG-02 | **Cover**: user can add, change, reposition and remove a cover image via UI ("Add cover"), Notion-style. Stored as frontmatter `cover:` (vault-relative image path) and `cover-y:` (vertical position). [DECIDED] |
| PG-03 | **Subtitle**: shown on cards and below the title; stored in frontmatter `subtitle:`, edited from the page header. [DECIDED] (Q-PG-1) |
| PG-04 | **Tags**: `#tag` in the body and frontmatter `tags:` (Obsidian compatibility). [DECIDED] |
| PG-05 | **Link resolution**: the file name is canonical; `[[x]]` resolves with Obsidian's shortest-unique-path rules. Link autocomplete matches titles and file names and inserts `[[file-name\|Title]]` when they differ. [DECIDED] |

**Acceptance**
- *Given* a file `draft.md` whose first line is `# Generator Rex`, *then* its title everywhere (cards, search, tabs) is "Generator Rex".
- *Given* a page with `<img src="https://x.com/p.png">`, *when* rendered, *then* no network request is made and a "remote content blocked" placeholder is shown.
- *Given* `rex-draft.md` titled "Generator Rex", *when* the user picks it from `[[` autocomplete, *then* `[[rex-draft|Generator Rex]]` is inserted and the link also resolves in Obsidian.

---

## 6. Global View

The view is opened from the floating top toggle **[Edit | Global view]** (see reference image `new-graph-navigation.jpeg`).

### 6.1 Cards
| ID | Requirement |
|----|-------------|
| GV-01 | Each card shows: cover image (or placeholder), title, subtitle (if any), a content excerpt, and a "See all" action. |
| GV-02 | A **project/folder card** shows its **index note**'s preview. Index note: a page named like the folder or `index.md`; else the page the user picked (stored per vault); a single-page folder uses that page. Without an index note, the card shows a folder summary (page/folder counts and child titles). [DECIDED] (Q-GV-1) |
| GV-03 | Cards are visually distinguishable by kind (project, folder, page). [DECIDED] |

### 6.2 Navigation
| ID | Requirement |
|----|-------------|
| GV-10 | **Level 0** shows all projects plus pages in the vault root, shown as page cards. [DECIDED] (Q-GV-2) |
| GV-11 | **Single click** on a card opens the next level for that card. |
| GV-12 | **Double click** on a card opens the page in the editor (for folders: the index note; with none, the folder opens as next level). |
| GV-13 | A **view toggle** selects how the next level appears: **Drill-down** (canvas is replaced by the next level; breadcrumb shows the path) or **Expand in place** (next level is added next to the clicked card on the same canvas). The choice is one global setting, persisted across restarts. [DECIDED] (Q-GV-6) |
| GV-14 | In Drill-down mode, a breadcrumb lets the user go back to any previous level. |
| GV-15 | In Expand mode, an expanded card can be collapsed again. [DECIDED] |
| GV-16 | Next level of a **page** = its neighborhood: pages it links to, pages linking to it (backlinks), and its manual relationships, with typed edges. [DECIDED] (Q-GV-3) For a **folder/project**, the next level contains its direct subfolders and pages. |
| GV-17 | A **"New entry"** button creates a new page in the folder of the current level. [DECIDED] |
| GV-18 | Keyboard navigation: arrow keys move between cards, Enter = single click, Shift+Enter = double click. [DECIDED] (Q-A11Y-1) |

### 6.3 Edges
| ID | Requirement |
|----|-------------|
| GV-20 | Edges are drawn between visible cards for: links in text, parent/child hierarchy, and manual relationships. [DECIDED] |
| GV-21 | Each edge kind is visually distinct, and each kind can be shown/hidden. [DECIDED] |
| GV-22 | The user can create a manual relationship by dragging from one card to another, and delete it. [DECIDED] |
| GV-23 | Manual relationships may optionally have a direction (arrow) and an optional short text label. [DECIDED] (Q-GV-4) |
| GV-24 | Manual relationships are stored in the source page's frontmatter under `related:` — a plain `"[[Page]]"` string, or `{link, label, directed}` when labeled or directed. [DECIDED] (Q-GV-5) |
| GV-25 | Links/relationships starting or ending inside a folder shown only as a card are drawn as one **aggregated** edge per card pair, with a count, in a distinct style; a "Links from inside folders" toggle shows/hides them. [DECIDED] (Q-GV-7) |

### 6.4 Layout
| ID | Requirement |
|----|-------------|
| GV-30 | Cards are auto-arranged by default. [DECIDED] |
| GV-31 | The user can drag cards to new positions; positions persist per level and survive restart. [DECIDED] |
| GV-32 | "Reset layout" restores the auto-arrangement for the current level. [DECIDED] |
| GV-33 | Pan and zoom the canvas. [DECIDED] |

**Acceptance**
- *Given* a vault with projects A, B, C, *when* the Global View opens, *then* three project cards appear at level 0.
- *Given* Drill-down mode, *when* the user single-clicks project A, *then* only A's children are shown and the breadcrumb reads "Vault › A".
- *Given* Expand mode, *when* the user single-clicks project A, *then* A's children appear beside A and B, C remain visible.
- *Given* the user moved a card and restarted the app, *then* the card is in the moved position.
- *Given* a page in A links to a page in B, *when* level 0 is shown with the aggregated toggle on, *then* one edge A–B with count 1 is drawn.
- *Given* folder `DMC` contains `DMC.md` and other pages, *then* the `DMC` card previews `DMC.md`.

---

## 7. Editor

| ID | Requirement |
|----|-------------|
| ED-01 | Three editing modes, switchable per page: **Live Preview** (Obsidian-style inline rendering, default), **Source** (raw Markdown), **Split** (source on the left, fully rendered page on the right). [DECIDED] |
| ED-02 | In Split mode, both panes stay in sync as the user types, and scroll is synchronized. [DECIDED] |
| ED-03 | `[[` triggers link autocomplete over page titles and file names (insertion rule: PG-05). [DECIDED] |
| ED-04 | Clicking a link in Live Preview or the rendered pane navigates to the target page. |
| ED-05 | Pasting or dropping an image saves it into the vault and inserts an embed. [DECIDED] Attachment location is configurable (vault folder / same folder / named subfolder); default is an `attachments/` subfolder next to the page; an existing Obsidian `attachmentFolderPath` is honored. [DECIDED] (Q-ED-1) |
| ED-06 | The page header shows the cover (with "Add cover" if none), title and subtitle. |
| ED-07 | Undo/redo works across typing, block reordering (§8) and inserts. |
| ED-08 | Auto-save; no "save" button. [DECIDED] |

---

## 8. Drag-and-drop block reordering

| ID | Requirement |
|----|-------------|
| DND-01 | In the **rendered preview pane** (Split mode), each block shows a drag handle on hover. [DECIDED — preview pane only] |
| DND-02 | Any **block** can be dragged: headings, paragraphs, lists and individual list items (including nested ones, which may move between nesting levels), quotes, callouts, code blocks, table rows, images, audio clips, embeds, HTML blocks, columns. [DECIDED] |
| DND-03 | **Inline** content (a word, a sentence, a bold span) is **not** draggable; that is text editing. [DECIDED] |
| DND-04 | Dropping a block rewrites the Markdown source accordingly; the source pane updates immediately. |
| DND-05 | Reordering never changes the content of a block, only its position (and nesting level for list items). |
| DND-06 | A reorder is a single undo step. |
| DND-07 | Dragging a **heading** moves the heading with its whole section (until the next heading of the same or higher level); Alt-drag moves only the heading line. [DECIDED] (Q-DND-1) |
| DND-08 | Every drag operation has a keyboard equivalent (move up/down, indent/outdent). [DECIDED] (Q-A11Y-1) |

**Acceptance**
- *Given* paragraphs P1, P2, P3, *when* P3 is dropped above P1, *then* the source reads P3, P1, P2 and every byte of each paragraph is unchanged.
- *Given* a reorder, *when* the user presses undo once, *then* the original order is restored.
- *Given* `## A` (with two paragraphs) above `## B`, *when* `## A` is dropped below B's section, *then* A's heading and both paragraphs move together.

---

## 9. Audio, Search & Import

### 9.1 Audio clips
| ID | Requirement |
|----|-------------|
| AUD-01 | Record a clip from any available microphone; the user picks the input device. [DECIDED] |
| AUD-02 | Recording format chosen by the user: **WAV** or **MP3**. A global setting with default **WAV**; the recorder can switch the format for a single take. [DECIDED] (Q-AUD-1) |
| AUD-03 | Upload an existing audio file into a page. Accepted formats: **WAV, MP3, M4A**. [DECIDED] |
| AUD-04 | The clip is saved as a file in the vault and embedded **inline where it was recorded/inserted**. [DECIDED] |
| AUD-05 | Inline player: play/pause, seek, duration, current time. [DECIDED] |
| AUD-06 | Playback stops when the user leaves the page. [DECIDED] |
| AUD-07 | Recording UI shows elapsed time and an input level meter; recording can be cancelled without saving. [DECIDED] |

### 9.2 Search
| ID | Requirement |
|----|-------------|
| SR-01 | A global search bar (keyboard shortcut) available from every view. |
| SR-02 | Searchable fields: **project name, folder name, file name, titles, tags, links**, and **full-text body**; metadata matches rank above body matches. [DECIDED] (Q-SR-1) |
| SR-03 | Filters: project, folder, tags, links (to/from), **has image** toggle, **has audio** toggle. [DECIDED] |
| SR-04 | Active filters show as removable **chips**. |
| SR-05 | Results show a compact preview (cover thumbnail, title, path, matching tags). [DECIDED] |
| SR-06 | Search must make no network requests (P1). |

### 9.3 Notion import [DECIDED] (Q-IMP-1)
| ID | Requirement |
|----|-------------|
| IMP-01 | Import a Notion "Markdown & CSV" export zip (including nested zips from large exports) into a new folder inside the open vault (becomes a project) or into a new vault. |
| IMP-02 | Notion's ID suffixes are stripped from file and folder names (collisions handled); internal links are rewritten to `[[wikilinks]]` and asset links to vault-relative embeds; `<aside>` becomes a callout and toggles (`<details>`) become foldable callouts. |
| IMP-03 | Databases (CSV + page folder): each row page gets frontmatter from its CSV columns; the database gets an index page with a Markdown table linking its rows. |
| IMP-04 | A dry-run preview (page/asset/database counts, warnings) is shown before anything is written; the import writes only inside the target folder and ends with a report page. |

**Acceptance**
- *Given* a Notion export with `Page abc123…def.md` linking to `Other%20xyz….md`, *when* imported, *then* the result is `Page.md` containing `[[Other]]`, and no file outside the target folder changed.

---

## 10. Resolved questions

| ID | Question | Decision |
|----|----------|----------|
| Q-IMP-1 | Answer to importers was "Obsidian and **Note**". Does "Note" mean **Notion**? | **Notion**, via its Markdown & CSV export, **in MVP** (§9.3). |
| Q-IMP-2 | Is an explicit export needed? | **No export in MVP**; the folder is the export. |
| Q-SEC-1 | Encryption: MVP or post-MVP? | **Post-MVP.** |
| Q-SEC-2 | Encryption scope? | **Whole vault.** |
| Q-SEC-3 | Encrypted files unreadable by Obsidian/other tools. Accepted? | **Accepted.** |
| Q-SEC-4 | Lost password = data lost. Accepted, with a clear warning at setup? | **Accepted**, with a clear warning. |
| Q-FMT-1 | Which Notion-like features besides columns? | **Toggles** (foldable callouts), **highlights & colored text**, **dividers**. No callout colors or page icons. |
| Q-PG-1 | Where does the **subtitle** come from? | Frontmatter **`subtitle:`**, edited from the page header. |
| Q-GV-1 | Folder with several pages: how is the index note chosen? | Page named like the folder or `index.md`; else user pick (stored in `.nimw/vault.json`); else folder summary card. |
| Q-GV-2 | Do vault-root pages appear at level 0? | **Yes**, as page cards. |
| Q-GV-3 | Single-clicking a **page** card: what is its next level? | Its **neighborhood**: outgoing links, backlinks, manual relationships. |
| Q-GV-4 | Can edges have text labels? | **Yes**, optional. |
| Q-GV-5 | Where are manual relationships stored? | **Source page frontmatter** `related:` (string or `{link, label, directed}`). |
| Q-GV-6 | Drill-down/Expand toggle scope? | **Global**, persisted. |
| Q-GV-7 | Draw aggregated edges between folder cards? | **Yes**, aggregated with count, plus a show/hide toggle. |
| Q-DND-1 | Dragging a heading moves what? | **Heading + its section**; Alt-drag moves the heading line only. |
| Q-ED-1 | Where do attachments go? | **Configurable**, default `attachments/` subfolder next to the page; honors Obsidian's `attachmentFolderPath`. |
| Q-AUD-1 | WAV/MP3 choice and default? | **Global setting, default WAV**, switchable per take in the recorder. |
| Q-SR-1 | Full-text body search? | **Yes**; metadata matches rank higher. |
| Q-I18N-1 | Default UI language? | **OS locale**, changeable on the welcome screen and in Settings. |
| Q-UI-1 | Themes? | **Light + dark**, following the OS, with an override in Settings. |
| Q-UPD-1 | Updates without phoning home? | **Manual only** (download new releases); NFR-04 stays absolute. |
| Q-A11Y-1 | Accessibility requirements? | **Keyboard + screen-reader basics**: keyboard Global View navigation (GV-18), keyboard block moves (DND-08), ARIA roles/labels, WCAG AA contrast. |
| Gap | Titles come from the H1 but Obsidian resolves links by file name. | **File name canonical** (PG-05). |
| Gap | Which top-level folders are not projects? | **Dot-folders and attachment folders**, plus user exclude globs (VLT-05). |

---

## 11. Non-functional requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | **Scale target:** comfortable with vaults up to **10,000 notes**. Scaling beyond that is not an MVP goal; the architecture must not rule it out. [DECIDED] |
| NFR-02 | Global View renders only the visible levels, never the whole vault at once. [DECIDED] |
| NFR-03 | **Performance budgets** at 10k notes, mid-range 2022 laptop: cold start to usable UI (cached index) < 2 s; first full index < 30 s in background; re-index of a changed file < 100 ms; search p95 < 50 ms; Global View level render (≤ 200 cards) < 300 ms; typing latency < 16 ms. [DECIDED] |
| NFR-04 | Zero outbound network requests from the app, verifiable by test. The donations link opens in the user's default browser, not inside the app. No update checks (Q-UPD-1). [DECIDED] |
| NFR-05 | No telemetry, crash reporting or analytics. [DECIDED via P1/P4] |
| NFR-06 | Platforms: Windows, macOS, Linux (`.deb`, `.AppImage`), **all three shipped simultaneously**. [DECIDED] |
| NFR-07 | All UI strings externalized; adding a language requires no code changes beyond adding a translation file. [DECIDED] |
| NFR-08 | No data loss: writes are atomic; a crash mid-save never corrupts a page. [DECIDED] |
| NFR-09 | License: **GPL-3.0-or-later**. [DECIDED] |
| NFR-10 | Accessibility: full keyboard operation, ARIA roles/labels, visible focus, WCAG AA contrast in both themes. [DECIDED] (Q-A11Y-1) |

---

## 12. Key user flows

1. **First run:** UI language from OS locale (changeable on the welcome screen) → create or open vault → land in Global View at level 0.
2. **Explore visually:** Global View → single-click project → next level (drill-down or expand, per toggle) → single-click folder → … → double-click page → editor.
3. **Explore by tree:** sidebar explorer → click page → editor.
4. **Write:** editor → Live Preview by default → switch to Split → drag blocks in the rendered pane to reorder → source updates.
5. **Enrich:** add cover → insert image → record a clip inline → add `#tags` and `[[links]]`.
6. **Connect:** Global View → drag from one card to another → manual relationship (optional arrow and label).
7. **Find:** search bar → type → add filter chips (project, tag, has audio…) → open result.
8. **Bring notes in:** open an existing Obsidian vault, or import a Notion export (dry-run preview → confirm → report).
9. **Protect (post-MVP):** settings → enable encryption → set password → warning about unrecoverable loss.

---

## 13. Decision log

| Date | Decision |
|------|----------|
| 2026-10-12 | Spec-driven development; single spec file for now. |
| 2026-10-12 | Desktop only: Windows, macOS, Linux (.deb, .AppImage). |
| 2026-10-12 | Local-only forever; no cloud or sync. |
| 2026-10-12 | Storage: plain `.md` files in folder structures; Obsidian vaults and wikilinks supported. |
| 2026-10-12 | Project = top-level folder. |
| 2026-10-12 | Edges: text links, parent/child hierarchy, manual relationships (direction optional). |
| 2026-10-12 | Global View: user toggle between drill-down and expand-in-place. |
| 2026-10-12 | Folder cards use a cover/index note; single-page folders use that page. |
| 2026-10-12 | Notion-style covers; H1 takes priority over file name for the title. |
| 2026-10-12 | Card positions: auto-arranged by default, user-movable, persisted. |
| 2026-10-12 | Editor: Live Preview + Source + Split (source/preview); layout columns inside pages, accepted as non-Obsidian syntax. |
| 2026-10-12 | Drag-reorder only in the rendered preview pane; block-level, not inline. |
| 2026-10-12 | Audio: record (mic selectable) + inline playback; WAV and MP3. |
| 2026-10-12 | Embedded HTML allowed but no scripts and no remote sources. |
| 2026-10-12 | Encryption optional; "lock" means encryption. |
| 2026-10-12 | Search fields/filters: project, folder, file name, titles, tags, links, has image, has audio. |
| 2026-10-12 | i18n: English + Spanish, extensible. |
| 2026-10-12 | Scale target 10k notes. |
| 2026-10-12 | Free and open source, donations link. |
| 2026-10-12 | Importers: Markdown-based only; Evernote dropped. |
| 2026-10-12 | Tech lead decides open questions directly; all marked [DECIDED]. All former [PROPOSED] items promoted to [DECIDED]. |
| 2026-10-12 | Q-IMP-1: "Note" = Notion; Notion importer in MVP. Q-IMP-2: no export in MVP. |
| 2026-10-12 | Q-SEC-1..4: encryption post-MVP, whole vault; unreadable by other tools while locked and unrecoverable without password — both accepted. |
| 2026-10-12 | Q-FMT-1: Tier B = columns, toggles (foldable callouts), highlights & colored text, dividers. |
| 2026-10-12 | Q-PG-1: subtitle from frontmatter `subtitle:`. |
| 2026-10-12 | Q-GV-1: index note = name match or `index.md`, else user pick, else folder summary. Q-GV-2: root pages at level 0. Q-GV-3: page next level = neighborhood. |
| 2026-10-12 | Q-GV-4: optional edge labels. Q-GV-5: relationships in source-page frontmatter `related:`. Q-GV-6: view mode global, persisted. Q-GV-7: aggregated edges with count + toggle. |
| 2026-10-12 | Q-DND-1: heading drags its section (Alt = line only). Q-ED-1: attachments configurable, default `attachments/` subfolder, Obsidian-compatible. |
| 2026-10-12 | Q-AUD-1: global recording format, default WAV, per-take override. Upload formats WAV/MP3/M4A. |
| 2026-10-12 | Q-SR-1: full-text search. Q-I18N-1: OS locale default. Q-UI-1: light + dark following OS. Q-UPD-1: manual updates only. Q-A11Y-1: keyboard + screen-reader basics. |
| 2026-10-12 | Link resolution: file name canonical (PG-05). Exclusions: dot-folders and attachment folders (VLT-05). |
| 2026-10-12 | NFR-03 budgets set; all three platforms ship simultaneously; license GPL-3.0-or-later. |
| 2026-10-12 | Architecture: Tauri 2 + Rust core + React/TypeScript UI (see `docs/superpowers/specs/2026-10-12-architecture-design.md`). |
