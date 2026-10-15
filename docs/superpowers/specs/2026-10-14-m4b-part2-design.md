# M4b, part 2 — Page width, code, maths, diagrams, outline, text files: Design

**Status:** agreed with Jose on 2026-10-14 (four answers). Part 2 of the M4b feedback round; it builds on part 1 (`docs/superpowers/specs/2026-10-14-m4b-feedback-design.md`) on the same branch, `feat/m4b-feedback`. Personas behind it are in product spec §1.2.

---

## 1. Full page width (F12): app, vault and page

- **Three levels**, the most specific set one winning:
  1. **Page:** `.nimw/vault.json` `pageWidths: { "<page path>": "full" | "readable" }`.
  2. **Vault:** `.nimw/vault.json` `pageWidth: "full" | "readable"` (absent = use the app's).
  3. **App:** `settings.json` `pageWidth: "readable" | "full"` (default `readable`).

  Page entries follow renames and moves, through the same Rust choke points as the M3a layout remap. Notes themselves are never written.
- **"Readable"** keeps today's 760 px measure in Live Preview and the Split pane.
- **"Full"** lets the text span the editor (Live Preview 40 px side padding; Split pane 28 px). Source has no measure in either mode.
- **UI:**
  - **Page:** a **Full width** toggle button (an icon with arrows, `aria-pressed`) in the header band's row 1, by the mode switch. Turning it off when the vault or app default is full sets the page to `readable` explicitly. A small "Reset to default" item clears the page entry.
  - **App:** Settings → Editor → **Page width: Readable / Full**.
  - **Vault:** Settings → This vault → **Page width for this vault: Use the app setting / Readable / Full**.
- **Backend:**
  - `page_width_set(path, width: "full" | "readable" | null)` validates a visible indexed page, writes atomically and keeps unknown keys.
  - `vault_settings_get/set` gain `pageWidth`.
  - Real-ACL tests.

## 2. Code blocks (F13): highlighting and a language picker

- **Editor (Source and Live Preview):**
  - `markdown({ codeLanguages: languages })` with `@codemirror/language-data`, whose language packages load lazily as separate Vite chunks.
  - A `HighlightStyle` maps Lezer tags to code-token CSS variables.
- **Rendered pane and widgets:** `lowlight` (highlight.js grammars, the "common" set) on the hast of fenced code, before sanitizing. The `hljs-*` classes are allowed on `span` in the schema and styled with the same variables.
- **Tokens:**
  - `--code-keyword`, `--code-string`, `--code-number`, `--code-comment`, `--code-function`, `--code-type`, `--code-variable`, `--code-meta`, `--code-punct`, generated per palette and mode;
  - ≥ 4.5:1 on `--color-code-bg` (tested), with no hue-only distinction (comments are italic too).
- **Language picker (Live Preview):**
  - When the cursor isn't in a fenced block, its first line shows a **language badge**: the fence language, or "Plain text".
  - Clicking the badge opens a searchable list (the language-data names and aliases; type to filter; ↑/↓/Enter; Escape).
  - Choosing a language rewrites the fence's info string in one undoable transaction.
  - A **Copy** button copies the block's code (feedback: "Copied").
- **Split pane:** code blocks get the language label and a Copy button.
- **Unknown languages** aren't highlighted; the badge shows the raw info string.
- **Mermaid and math fences** are handled by §3 and §4, not highlighted as code.

## 3. LaTeX (F14), with KaTeX

- **Syntax** (Obsidian's): `$inline$` and `$$block$$`, through `micromark-extension-math` / `mdast-util-math` (remark-math's parts) in `parsePage`.
  - `\$` stays a dollar sign.
  - A `$` followed by a space or digit-space doesn't open maths, so prices like `$5 and $10` stay text (as in Obsidian).
  - The incremental re-parse falls back to a full parse when an edit touches a `$$` line.
- **Rendering (preview, widgets):**
  - math nodes become `data-nimw="math"` placeholders carrying the TeX, which pass the sanitizer;
  - a React `Math` component renders them with `katex.render` (`throwOnError: false`, `trust: false`, `strict: "ignore"`, `output: "htmlAndMathml"`) for accessibility;
  - errors show the source in red with the KaTeX message as a `title`.
- **Live Preview:** inline maths renders as a widget when the cursor isn't inside it; `$$` blocks render as block widgets (cursor-in shows the source).
- **Assets:** KaTeX CSS and fonts are bundled locally (`font-src 'self'`), so no network is used (the zero-network e2e includes a maths page).
- **The Rust indexer** leaves `$…$` as text (no change needed); excerpts drop `$$` blocks.

## 4. Mermaid (F15)

- **What renders:** ```` ```mermaid ```` fences render as diagrams in the preview pane, Live Preview block widgets (cursor-in shows the source) and embeds.
- **Loading and security:**
  - `mermaid` is loaded **lazily** (dynamic import, its own chunk) the first time a diagram is on screen;
  - `securityLevel: "strict"` (labels sanitized, no click handlers, no HTML labels), `startOnLoad: false`, `theme: "base"`;
  - `themeVariables` come from the palette tokens and are re-rendered on palette or mode change.
- **Rendering:**
  - debounced (300 ms) and cached by source + theme;
  - an error shows the source and Mermaid's message in a muted error box;
  - the SVG gets `role="img"` and an `aria-label` ("Diagram", plus the first line of the source, e.g. "flowchart LR").
- **Compatibility:**
  - **Frozen prototypes:** Mermaid pulls in d3. The M3a `freezeSafe` transform must cover any d3-color copy it uses, in both the build and the dev pre-bundle; the plan verifies this in the real build.
  - **Safari 15 floor:** if Mermaid needs an API Safari 15.0–15.3 lacks, the diagram shows the error box ("This diagram needs a newer macOS"), never a broken page. This is recorded in the hand-off.
- **No network:** Mermaid fetches nothing; the zero-network e2e includes a diagram.

## 5. Outline panel and word count (F16)

- **Outline:** a right-side panel (260 px, resizable 200–420) listing the page's headings H1–H6, indented by level.
  - **Navigation:** clicking a heading scrolls the editor (and the Split pane) to it and puts the cursor there.
  - **Current heading:** the heading containing the cursor, or at the top of the viewport while scrolling, is highlighted.
  - **Keyboard:** a `tree` with ↑/↓, Enter, and ←/→ to collapse and expand sections.
  - **Toggling:** an **Outline** button in the header band (`aria-pressed`) and View → Toggle Outline. Its state is remembered app-wide (`settings.outline`, default `false`).
  - **Narrow windows:** under 1100 px it overlays the editor instead of squeezing it.
  - **Empty state:** "No headings yet."
- **Word count:** in the header band's row 1, next to Saved.
  - It reads "1,234 words · 6 min" (230 words per minute), or "45 of 1,234 words" with a selection.
  - Its `title` gives characters with and without spaces.
  - **Counted:** prose from the parsed model (front matter, `%%` comments, Markdown syntax and URLs excluded; code and maths blocks counted as text). CJK characters count one word each.
  - Recomputed 300 ms after typing stops.
- **Text files** (§6) show the line and character count instead.

## 6. Plain-text and code files (F17)

- **Which files open in the app:**
  - by extension: `txt text log csv tsv json jsonc yaml yml toml ini cfg conf xml html htm css scss less js mjs cjs ts tsx jsx py rb rs go java kt c h cpp hpp cs swift sh bash zsh fish ps1 sql lua php r dart vue svelte`, plus the names `Dockerfile`, `Makefile`, `.gitignore`, `.editorconfig`;
  - **and** only when the content is valid UTF-8, has no NUL bytes and is ≤ 2 MB.

  Anything else keeps "Open in default app".
- **The text view:** the explorer, links (`[[notes.txt]]`) and Global View opens all lead to a **text view**:
  - the top bar shows the file name, which can be renamed like a page title; there's no subtitle;
  - the header band shows the breadcrumb, Saved and line/character counts, with no cover, tags, Related or mode switch;
  - the editor is Source-style (monospace), with **syntax highlighting by extension** (language-data) and line numbers on by default (the line-numbers setting applies);
  - word wrap is on;
  - autosave, CAS, external reload and merge work as for notes (PageDoc in a `text` kind).
- **Backend:**
  - `text_read(path) -> { text, hash }` and `text_write(path, text, expectedHash) -> { hash }` mirror `page_read` / `page_write`;
  - they refuse anything that isn't an eligible text file (`notAText`), and reindex the file as an attachment, never as a page;
  - real-ACL tests.
- **Not included:** no Live Preview, formatting toolbar, autocomplete or IDE features. Text files stay out of the Global View (as now). Search (M5) will decide whether to include them.

## 7. Version control

Planned for a later batch (product spec §13, 2026-10-14); nothing is built in M4b.

## 8. Testing

- **Unit:**
  - width resolution (page → vault → app) and its remap on rename;
  - highlighting in both engines with token colours and contrast;
  - the language picker (axe, keyboard, rewrite and undo);
  - the Copy button;
  - maths parsing edge cases (prices, escaped dollars, `$$` across lines, incremental fallback);
  - KaTeX output accessible (MathML present);
  - Mermaid lazy load, cache, error box and theme switch (mocked in jsdom);
  - the outline tree (keyboard, current heading, overlay width);
  - word count rules (CJK, front matter, selection);
  - text-file eligibility (extensions, UTF-8, NUL, size);
  - the text view (no page features, rename, autosave).
- **Rust:** `page_width_set`, the `vault.json` fields and remap, and `text_read` / `text_write` (eligibility, CAS, indexing as an attachment), with real-ACL tests.
- **E2E (Chromium + WebKit):**
  - toggle full width and reload, and it is kept;
  - pick a language for a code block and see the colours;
  - a maths page and a Mermaid page render, both inside the zero-network test;
  - the outline jumps to a heading;
  - word count updates;
  - open and edit a `.json` file.
- **Real window:**
  - Mermaid in the Tauri build under frozen prototypes;
  - KaTeX fonts;
  - large code files;
  - outline overlay at narrow widths.

## 9. Out of scope

- Maths and diagram editors (WYSIWYG);
- export to PDF/HTML;
- syntax themes beyond the palette tokens;
- line-number gutters in the rendered pane;
- running code;
- version history.

## 10. Amendments from planning

The plan (`docs/superpowers/plans/2026-10-14-m4b-part2.md`) was replayed end to end on a scratch clone. These rulings and deviations came out of it.

### Page width (§1)

1. **"Full" changes Live Preview's measure only.** The Split pane already spans its half of the window.
2. **There is no separate "Reset to default" item.** Toggling a page back to the vault or app default clears its entry, so the page follows the default again. The vault's own setting is cleared with "Use the app setting" (`pageWidth: "default"` in the patch).

### Code (§2)

3. **Tokens are generated per palette** by an OKLCH lightness search to ≥ 4.6:1 on `--color-code-bg`. `--code-variable` is the text colour, and `--code-punct` the muted colour where that is readable.
4. **The editor colours tokens through classes** (`cm-nimw-code-*`), so a few Markdown tags take token colours too, such as a link title as a string.
5. **The fence id written by the picker** is the language's shortest language-data alias, or else its name in lower case (so Python is written `python`; language-data has no `py` alias). "Plain text" clears the id. The picker is its own combobox; the shared `PickerPopup` is a page search.

### Maths (§3)

6. **The dependencies are `remark-math@6.0.0`** (which carries `micromark-extension-math` and `mdast-util-math`) and **`katex@0.18.9`**. `0.18.10` was too new for the release-age gate.
7. **The "$ followed by a space" rule** is applied as: inline maths whose content starts or ends with white space reverts to text, as in Obsidian.
8. **The incremental re-parse already treated `$$` as non-local.** A test now pins it for maths.

### Mermaid (§4)

9. **Mermaid is `11.17.2`** (stable 11.x). It uses `flowchart.htmlLabels: false`, and `suppressErrorRendering: true` so that its own error drawing doesn't land at the end of `<body>`. Any leftover render node is removed.
10. **The cache key** includes the OS mode while the theme is "system", so a diagram redraws when macOS switches between light and dark.
11. **The Safari 15.0–15.3 message** shows when a render fails on a WebKit without `structuredClone`, `Array.prototype.at` or `Object.hasOwn`.
12. **Frozen prototypes: `freezeSafe` is now general.**
    - **Why:** Mermaid's tree has a long tail of code that assigns names `Object.prototype` defines: dayjs (`valueOf`/`toString`, which broke every diagram), d3-format (gantt), the vscode-jsonrpc copy in `@mermaid-js/parser`, layout-base, and cytoscape's `Object.assign` mixins (mindmap, architecture).
    - **What it does:** the transform parses every `node_modules` file that could need it, using Vite's oxc parser. It rewrites `obj.name = v` to `__nimwOwn(obj, "name").name = v`, and reads of `Object.assign` to `__nimwAssign`. Strings and comments are never touched.
    - **Semantics:** the helper defines an own writable, enumerable property only when the inherited one is a read-only data property, so behaviour is unchanged elsewhere.
    - **What it replaces:** the M3a d3-color rule.
    - **Not covered:** computed keys (`obj[k] = v`), for cost.
    - **Proof:** an e2e test draws all 22 diagram kinds under the frozen prototype, in Chromium and WebKit, offline.
13. **d3 now sits in a pre-bundle chunk shared by React Flow and Mermaid**, so the dev pre-bundle test scans the chunks too.

### Outline and word count (§5)

14. **Outline:**
    - It is a flat ARIA tree (`aria-level`, `aria-setsize`, `aria-posinset`).
    - Folded sections unfold when the number of headings changes.
    - Its width is kept per machine (`localStorage`).
    - A scroll within 250 ms of a cursor move keeps the cursor's heading marked.
    - Click and Enter put the keyboard in the editor.
    - Escape closes the panel only while it overlays the editor.
    - Headings inside quotes, callouts and lists aren't listed.
15. **Word count:**
    - "CJK" means Han, Hiragana and Katakana; Hangul is spaced, so it is counted by spaces.
    - A token counts only if it holds a letter or digit.
    - Characters count runs of white space as one space.
    - A partly selected word counts.
    - The text view shows lines and characters only.
16. **The header band's controls wrap in a narrow window.** Saved, the word count and the Outline button had widened the page at 900 px.

### Text files (§6)

17. **Line numbers are always on in the text view.** The line-numbers setting applies to pages.
18. **Renaming a text file keeps its extension**, which shows after the name field ("File name").
19. **`.gitignore` and `.editorconfig` are eligible by name, but the vault index skips hidden files**, so they don't appear in the explorer.
20. **The Global View has no text-file cards** (they stay out, as before), so there is nothing to route there.
21. **A text file that can't be read as text** (`notAText`) shows "This file opens in its default app." with an **Open in default app** button (the existing confirmation).

### Testing (§8)

22. **The e2e IPC mock keeps page widths in `sessionStorage`**, so the reload test sees them.
23. **The new axe e2e test turns off `label-content-name-mismatch`.** The rule flags the pre-existing **Format** button (named "Formatting toolbar"), which is outside this milestone.

## 11. Amendments from the final review (both parts of M4b)

These override the sections above, and §10, where they conflict.

1. **Startup on Safari 15.0–15.3:** lowlight's grammars are registered one by one (`createLowlight()` + `register`), so nothing calls `Object.hasOwn` at load. A highlighter that throws leaves the code plain. A startup test simulates the missing ≥ 15.4 APIs.
2. **Language picker:**
   - **Ranking:** exact id or alias, then exact name, then prefix, then substring, so `js` → JavaScript, `xml` → XML and `c` → C.
   - **Fence ids:** the shortest alias without spaces, else the name lower-cased with spaces removed.
   - **Read-back:** the editor and the rendered pane both read ids back through `languageFor`.
3. **Dollars (replaces §10.7's loose-dollar rule), Pandoc-style:**
   - an opening `$` needs a non-space character after it and isn't preceded by a letter or digit (`US$5`);
   - a closing `$` needs a non-space character before it and isn't followed by a digit;
   - `$10-$20`, `$5.99/$6.99` and `Pay $5 for [[Shop]]/$10` stay text, with their links;
   - `$$…$$` is unchanged.
4. **Text files:**
   - **Recovery:** a conflict copy keeps the extension (`data (conflict).csv`), and "Save as new" recreates a text file (`entry_create_text`, with a real-ACL test).
   - **Files rewritten outside the app as non-text** (not UTF-8, containing NUL, or over 2 MB) are never merged or overwritten. Rust replies `notAText` (`binary` for pages) with no lossy text, autosave stops, the user's text stays in the editor with a notice and a toast, and **Save as new file** is offered.
5. **Mermaid:** links in diagrams are inert. Each `<a>` becomes a `<g>` keeping its children and placement, with `on…` attributes removed.
6. **Focus:** after removing a Related chip, focus goes to the next chip's ×, else the previous one's, else **+ Related page**. Renaming a text file keeps focus in its name field.
7. **Header band:**
   - with a cover it stays 132 px from 900 to 1440 px wide, with the cover controls overlaid;
   - the breadcrumb stays on one line with an ellipsis;
   - the subtitle ends in an ellipsis, with its full text in a tooltip;
   - the text view shows the link-trail back arrow.
8. **Copy** announces "Copied" or "Couldn't copy" through a shared live region.
9. **Word count and outline:**
   - they reuse Live Preview's parsed model, so opening a page parses it once;
   - bare URLs aren't words;
   - the outline computes sibling positions in one pass.
10. **Split-pane highlighting** keeps highlight.js's `class_` token class.
11. **Card excerpts** drop only real display maths (pulldown-cmark's math parsing).
12. **Page widths** are forgotten when their page is deleted, in the app or by another program.
13. **Block moves (M4 §10.6):** gutter keys pressed while the Split pane lags are queued and replayed one per render, never dropped.

