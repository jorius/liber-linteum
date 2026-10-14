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
