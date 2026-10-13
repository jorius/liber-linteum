# M2a — Editor: Design

> **Status:** Approved in design review · **Date:** 2026-10-12
> **Roles:** Jose — tech lead (decisions below are DECIDED)
> **Parent docs:** product spec `docs/product-spec.md` (ED-*, PG-*, §5.1 syntax & HTML rules) · architecture `docs/superpowers/specs/2026-10-12-architecture-design.md` (§3.4 Tier B, §4.2 editor, §6.2 HTML) · M1a/M1b designs and hand-offs in `docs/`
> **Scope:** the Markdown editor and renderer. Page extras (covers editing, subtitle editing, paste/drop attachments, `[[` autocomplete) are **M2b**.

---

## 1. Goal and success criteria

After M2a a person can open any page and **edit** it in Live Preview (default), Source or Split, see a faithful rendered page (Obsidian syntax + Tier B, sanitized HTML, vault images, embedded notes), have every keystroke saved safely, keep working when the file changes underneath, and see where the page lives through a breadcrumb.

Success means:
1. **ED-01:** Live Preview, Source and Split (source | rendered) per page; the last-used mode is remembered globally; Live Preview is the default.
2. **ED-02:** in Split both panes stay in sync while typing; scroll is synchronized.
3. **ED-04:** clicking a link (⌘-click in Live Preview) navigates; unresolved links offer "Create page"; `#heading` targets scroll.
4. **ED-07 / ED-08:** undo/redo across all edits; autosave (no save button) with visible status; nothing typed is lost on failures.
5. **External changes (VLT-04):** clean reload when no unsaved edits; 3-way merge when there are; conflict copy when edits overlap.
6. **Rendering:** CommonMark + GFM + Obsidian (wikilinks, embeds, callouts incl. foldable, tags, highlights, comments, frontmatter hidden) + Tier B (columns, colored text, toggles = foldable callouts, dividers); embedded notes transcluded one level; images and audio from the vault.
7. **Privacy (P1, P4, §5.1):** embedded HTML sanitized (no scripts, handlers, `javascript:`, `style`, iframes, forms); **no remote resource is ever loaded** (placeholder instead) — proven by an end-to-end test; the asset protocol only serves the open vault.
8. **Breadcrumb** (Jose's request) in the page header.
9. **M1b polish** items listed in §6 are fixed.
10. Obsidian compatibility: the parser agrees with the Rust indexer on links and tags over shared fixtures.

### 1.1 Decisions taken in the M2 design review
| Topic | Decision |
|---|---|
| Split | M2a editor (this doc) + M2b page extras (covers, subtitle editing, attachments, `[[` autocomplete) |
| Mode memory | Last-used mode, global setting `editorMode`, default `livePreview` |
| `![[note]]` | Rendered inline (transclusion), one level deep, cycles stopped |
| External change while dirty | 3-way merge; overlapping edits → keep mine in the editor, save theirs as `<name> (conflict).md` |
| Parsing model | **One TS model**: unified/remark + our micromark/mdast extensions drives both Live Preview decorations and the rendered pane (and M4's block dragging); CodeMirror's Lezer grammar only for Source highlighting |
| Link resolution | Stays in Rust (`links_resolve` command) — single implementation of Obsidian's rules |

---

## 2. Markdown model (`apps/desktop/src/markdown/`)

### 2.1 Parser
`unified` + `remark-parse` + `remark-gfm` + `remark-frontmatter` (YAML) + our extensions. Output: an mdast tree where **every node carries `position` (start/end offsets)**.

| Extension (micromark syntax + mdast utils) | Syntax | Node |
|---|---|---|
| `wikilink` | `[[target]]`, `[[target#heading]]`, `[[target\|alias]]`, `[[target\\|alias]]` (table form), escaped `\[[` ignored | `wikiLink { target, heading?, alias? }` |
| `embed` | `![[target]]`, `![[target#heading]]`, `![[img.png\|300]]` / `\|300x200` | `embed { target, heading?, size? }` |
| `callout` (mdast transform on blockquotes) | `> [!type] Title`, `> [!type]- Title` (folded), `> [!type]+` | `callout { calloutType, title, foldable, folded }` |
| `highlight` | `==text==` | `highlight` |
| `tag` | `#tag`, `#nested/tag` — Obsidian rules identical to `nimw-markdown` | `tag { name }` |
| `columns` (container directive) | `::::columns` … `:::column` … `:::` … `::::` | `columns` → `column[]` |
| `comment` | `%% … %%` (inline and block) | `comment` (not rendered) |

Links, tags and embeds inside code (fenced, indented, inline) and HTML are not interpreted (same as Rust).

### 2.2 Model API
```ts
export interface ParsedPage {
  tree: Root;                  // mdast with positions
  frontmatter: { range: [number, number]; data: Record<string, unknown> | null; error?: string };
  links: LinkRef[];            // { kind, target, heading?, alias?, range: [number, number] }
  tags: string[];
}
export function parsePage(text: string): ParsedPage;
```
`parsePage` is pure, synchronous, and runs on a 150 ms debounce after edits.

### 2.3 Link resolution
New backend command `links_resolve({ source, targets: { kind, target }[] }) → (string | null)[]` using `nimw_markdown::resolve` with the session's current `FileSet`. The editor batches unresolved targets per parse and caches results per page until `vault:changed` touches any file (cache cleared).

### 2.4 Sanitizer (`markdown/sanitize.ts`)
- Raw HTML (`html` nodes) goes through **DOMPurify** with an allowlist: tags `a b strong i em u s del ins mark sub sup kbd code pre br hr p span div blockquote ul ol li table thead tbody tr th td details summary img audio video source h1–h6`; attributes `href src alt title width height data-color data-bg open controls`. Everything else is removed (incl. `style`, `on*`, `iframe`, `object`, `embed`, `form`, `script`, SVG/MathML).
- **URL policy** for every `src`/`href` from Markdown or HTML:
  - vault-relative or vault-absolute path → `asset:` URL of the resolved file (only if inside the vault; otherwise treated as missing);
  - `http(s):` in `src` (images, audio, video, sources) → **"Remote content blocked"** placeholder showing the URL as text; never requested;
  - `http(s):`/`mailto:` in `href` → external link (opens in the OS browser after a confirmation dialog);
  - anything else (`javascript:`, `data:` except images already embedded, `file:`, custom schemes) → removed.
- `data-color` / `data-bg` accept only the palette names `red orange yellow green blue purple gray`.

### 2.5 Asset protocol
`tauri.conf.json` enables `assetProtocol` with an **empty static scope**; `vault_open/create` set the runtime scope to the vault root (`app.asset_protocol_scope().allow_directory(root, true)`) and `vault_close`/switching revokes the previous root (`forbid_directory`). The CSP already allows `asset:` / `http://asset.localhost` in `img-src` and `media-src`.

### 2.6 Parity fixtures
`fixtures/markdown/*.md` with `*.expected.json` (`{ links: [{kind, target, heading, alias}], tags: [] }`). The TS model (Vitest) and `nimw-markdown` (cargo test) both assert against them.

---

## 3. Editor (`apps/desktop/src/features/editor/`)

### 3.1 Backend commands
| Command | Args → Result |
|---|---|
| `page_read` | `{ path }` → `{ text, hash }` (no size cap; non-UTF-8 → `binary` error) |
| `page_write` | `{ path, text, expectedHash }` → `{ hash }`; on a hash mismatch → error `conflict` with `{ currentText, currentHash }` and nothing written |
| `page_create_conflict_copy` | `{ path, text }` → new path `"<stem> (conflict).md"` (or `(conflict 2)` …) |
| `links_resolve` | §2.3 |

All `async` (blocking thread), all in the capability allowlist, all with IPC tests.

### 3.2 Modes
- **Live Preview** (default): CodeMirror 6 + a `ViewPlugin` that maps the parsed model to decorations: markup hidden (`Decoration.replace`) except on lines touched by the selection; headings styled by level; emphasis/strong/strike/highlight/code styled; links shown as link text; images, embeds, callouts, horizontal rules, task checkboxes (clickable → toggles the `[ ]`/`[x]` source), tables and columns rendered as block widgets reusing the preview components (§4).
- **Source:** CodeMirror with `@codemirror/lang-markdown` highlighting, monospace.
- **Split:** Source left, rendered pane (§4) right. Scroll sync: the top-most visible source line maps to the deepest model node containing it; the right pane scrolls that node's element to the top (and vice versa).
- Mode toggle in the page header; stored as setting `editorMode: "livePreview" | "source" | "split"`.
- **Large notes** (> 200 KB): Live Preview uses a reduced decoration set (headings, emphasis, links only) and the header shows "Simplified preview for large notes".

### 3.3 Saving and conflicts
- One `EditorState` per open page; undo history is CodeMirror's (ED-07).
- **Autosave** 500 ms after the last change, on blur, on page switch, on vault close and on app quit (Tauri `CloseRequested` waits for the pending save, max 2 s).
- Status in the header: `Saved` · `Saving…` · `Unsaved — retrying` (exponential backoff 1 s → 30 s); the text is never discarded.
- **External change for the open page** (`vault:changed` modified/created/renamed):
  - not dirty → `page_read`, replace the document keeping the selection by offset (clamped), no undo entry merge;
  - dirty → 3-way merge with `node-diff3` (base = last saved text, mine = editor, theirs = disk). Clean → apply as one transaction and save. Conflict → keep mine, `page_create_conflict_copy(theirs)`, toast "Someone else changed this page — their version was saved as …" with "Open".
- `page_write` → `conflict` follows the same merge path with the returned text/hash.
- Renamed externally → the editor follows the new path (state kept); deleted externally while dirty → the editor keeps the text and offers "Save as new page".

### 3.4 Navigation
Click (Split pane, rendered widgets) or ⌘-click (Live Preview text) on a link: resolved → open target (scroll to heading); unresolved → "Create page '<target>'?" which creates it next to the source (M1a `create_page`) and opens it; external → confirmation dialog → opener plugin (`opener:allow-open-url` scoped to `http:` / `https:` / `mailto:`).

---

## 4. Rendered pane (`apps/desktop/src/features/preview/`)
- React renderer over the model: headings with `id` slugs, paragraphs, lists, task lists (read-only checkboxes in the pane), blockquotes, callouts (colours per type, foldable), code blocks (monospace, no syntax highlighting in M2a), GFM tables, highlights, colored spans (palette tokens readable in light/dark), columns (CSS grid, stacking below 600 px container width), tags as chips, horizontal rules, sanitized HTML.
- Frontmatter is not rendered (header shows subtitle/tags).
- Links: resolved internal (accent), unresolved (dimmed, dashed, "Create page" on click), external (↗ icon).
- **Embeds** (§1.1): images (`asset:`; Obsidian size syntax; lazy), audio `wav/mp3/m4a` (native `<audio controls>` until M6), notes (`![[Note]]` / `![[Note#Heading]]` transcluded in a bordered block with title + "Open"; nested embeds inside become link cards; cycles → "Embedded note refers back to this page"), missing → "Not found" card with "Create page", other files → file card with "Open in default app" (opener, confirmation).
- Remote media → "Remote image blocked (privacy)" placeholder.
- Re-render on the same 150 ms debounce; embedded notes and images load when scrolled into view.

---

## 5. Page header and breadcrumb (`features/page/`)
- **Breadcrumb**: `<nav aria-label="Breadcrumb">` with the vault name and each folder of the path, then the page name (`aria-current="page"`). Folder segment → expand it in the explorer (whole ancestor chain) and focus it; vault segment → collapse the tree to the top and focus it. Keyboard reachable; shared component reused by M3's Global View (GV-14).
- Title (H1, PG-01), subtitle, tags, `N links · M backlinks` as in M1b; existing cover shown read-only (editing in M2b).
- Mode toggle (segmented control) and save status on the right.

---

## 6. M1b polish included (M1b hand-off §10)
a. A failed ⌘O switch keeps the current vault (`status` restored to `open`). b. Welcome is `inert` while opening; a second `open` is refused while one is in flight. c. Delete dialog: Enter confirms; initial focus on the confirm button. d. A "…" button on tree rows opens the context menu. e. Inline-rename error id via `useId()`. f. Recent list reloads after a failed open. j. `vault_open` does not fail when recent vaults can't be saved (warning instead).

---

## 7. Testing and verification
- **Model:** each extension over fixtures; positions correct; parity fixtures with Rust; sanitizer (scripts, handlers, `javascript:`, `style`, iframes stripped; remote → placeholder; vault path → `asset:`; outside-vault path → missing; palette-only colors).
- **Editor:** mode switching keeps text and undo; Live Preview hides markup except on the cursor line; checkbox toggle edits source; autosave debounce/blur/switch/close; status states; retry with backoff; external change clean reload; clean merge; overlapping merge → conflict copy; `page_write` conflict path; rename-follow; deleted-while-dirty; large-note fallback; typing a character in a 5,000-line note re-parses within the debounce budget (< 50 ms parse in jsdom).
- **Pane:** every node type; embeds (image size syntax, audio, note, heading section, nested, cycle, missing, other file); remote placeholder; columns; axe; light/dark tokens.
- **Rust:** `page_read`, `page_write` incl. conflict payload, `page_create_conflict_copy` naming, `links_resolve`, asset scope set to the vault on open and revoked on close; ACL tests for new commands and `opener` scope.
- **Zero network (NFR-04, arch §6.1 layer 3):** Playwright (Chromium) renders the built UI with the exact production CSP and a mocked IPC serving a fixture page full of remote references (img, audio, video, srcset, CSS-looking attributes, HTML `<img>`, Markdown images, embeds); a request interceptor asserts **zero** non-local requests.
- **Real window:** agent screenshots (launch only); Jose checks typing feel, modes, Split scroll sync, an external edit while typing, breadcrumb, a link click, the remote-image placeholder.

## 8. Dependencies (all GPL-3.0-compatible, no network code)
`@codemirror/state` 6.7, `@codemirror/view` 6.43, `@codemirror/commands` 6.11, `@codemirror/language` 6.13, `@codemirror/lang-markdown` 6.5 (MIT); `unified` 11, `remark-parse` 11, `remark-gfm` 4, `remark-frontmatter` 5, `mdast-util-*`, `micromark-*` (MIT); `dompurify` 3.4 (MPL-2.0 OR Apache-2.0); `node-diff3` 3.2 (MIT); `tauri-plugin-opener` 2.7 + `@tauri-apps/plugin-opener` 2.7 (MIT/Apache-2.0); dev: `@playwright/test` (Apache-2.0) for the zero-network test.

## 9. Out of scope (→ later)
Covers/subtitle editing, paste/drop attachments, `[[` autocomplete (**M2b**); Global View (M3); block drag-and-drop (M4); search (M5); custom audio player and recording (M6); syntax highlighting inside code blocks; math; Mermaid; PDF rendering; multiple panes/tabs.
