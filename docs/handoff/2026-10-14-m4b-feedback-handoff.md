# M4b — Feedback round (after the maintainer's real-window check of M2c–M4): Hand-off

**Specs:**
- Part 1: `docs/superpowers/specs/2026-10-14-m4b-feedback-design.md` (§10 amendments);
- Part 2: `docs/superpowers/specs/2026-10-14-m4b-part2-design.md` (§10 amendments);
- Personas and roadmap: product spec §1.2 and §13.

**Plans** (each replayed end to end on a scratch clone): `docs/superpowers/plans/2026-10-14-m4b-feedback.md` and `docs/superpowers/plans/2026-10-14-m4b-part2.md`.

**Branch:** `feat/m4b-feedback`, stacked on `feat/m4-block-moves` ← `feat/m3b-relationships` ← `feat/m3a-global-view` ← `feat/m2c-page-extras`. Merge in order: M2c → M3a → M3b → M4 → M4b.

**How this round was made:**
1. The maintainer tested M2c–M4 in the real window on 2026-10-14 and sent two lists of feedback.
2. Each answer was settled with him through questions: the header layout, `[[` search, the attachments override, how relationships are found, page width, text files, the code-block language picker, and the scratchpad.
3. The work was built in two parts, then went through one review and one fix pass.

## 1. What changed, by feedback item

| Feedback | Result |
|---|---|
| Reposition the cover right after uploading it | Add/Change cover opens reposition mode at once; one **Save position** |
| Icons on cover actions and the mode switch | Change, Reposition, Remove, Add cover, Save position, Cancel; Live Preview, Source, Split |
| Cover as a background behind the header | A compact **header band**: the cover is its background (132 px); breadcrumb, Saved, Format and the mode switch in row 1; tags, links/backlinks, Related and the title note in row 2, on semi-opaque pills that keep AA contrast on any image |
| Vault name in the sidebar; title and subtitle in the top bar | Done: the editor's text now starts in about the top quarter of the window |
| Screenshot paste | macOS saves screenshots to files by default: use ⌘⇧⌃4, or ⌘⇧5 → Options → Save to → Clipboard. TIFF/BMP/HEIC images (Preview, Photos) are now converted to PNG on paste |
| Dock icon bigger than others | The macOS icon sits inside Apple's icon grid (824/1024, transparent margin); only `icon.icns` changed |
| `[[` search and debounce | A search line at the top of the list ("Search: gen", match count); queries wait for an 80 ms pause |
| ⌘K picker stuck when scrolling | Follows the text, stays inside the window, flips above the line when there's no room |
| "New attachments go to" locked | Your vault has Obsidian's `./assets`; a switch, **Use a different place in Liber Linteum**, now lets Liber Linteum's choice win (Obsidian's file is never written) |
| Primary/secondary buttons from the palette | Shared primary (accent), secondary (outlined) and danger buttons on every dialog and bar, contrast-tested for every palette including custom accents |
| How to add manual relationships | **Related** chips in the header band (open, ×, **+ Related page**) and **Connect cards** in the Global View toolbar |
| Full page width | Per page (header band toggle), per vault and app-wide (Settings); stored in `.liber/vault.json` / settings, never in notes |
| Code blocks with language highlighting | Highlighting in every mode with palette colours; a language badge with a searchable picker and Copy on each code block |
| LaTeX and Mermaid | KaTeX (`$…$`, `$$…$$`, MathML for screen readers) and Mermaid diagrams (lazy-loaded, strict security), both fully offline |
| Outline panel and word count | Outline beside the editor (overlays under 1100 px; View → Toggle Outline); "N words · M min" in the header band, selection-aware |
| Plain-text files | `.txt`, `.json`, `.csv`, `.yaml`, code files etc. open in an editable text view with highlighting (UTF-8, no NUL, ≤ 2 MB) |
| Version control | Planned for a later batch (product spec §13) |

## 2. Totals

After the fix pass:
- **1154 vitest tests** (102 files);
- **168 Playwright tests** (Chromium + WebKit), plus 8 opt-in perf probes;
- **278 cargo tests passed**, plus the main-thread menu checks;
- eslint, prettier, tsc, i18n parity, clippy, rustfmt and `cargo deny` clean.

**New dependencies:** `@codemirror/language-data` 6.5.2, `lowlight` 3.3.0, `remark-math` 6.0.0, `katex` 0.18.9 and `mermaid` 11.17.2.

## 3. Needs the real window (you)

1. **Header and layout:**
   - the sidebar shows the vault name;
   - the top bar shows the page title and subtitle, both editable;
   - the band with a real cover (132 px, readable pills) and without one;
   - the editor starts near the top quarter;
   - try a few palettes, light and dark.
2. **Cover:** Add cover goes straight into reposition; drag, then **Save position** once. Check the icons on the cover buttons and the mode switch.
3. **Buttons:** the primary ones (Save, Create, Done…) use the palette accent, Cancel is outlined, Delete/Remove are red.
4. **Dock icon:** the same size as the other apps' icons.
5. **`[[` list:** the search line, and how it feels on your vault.
6. **⌘K:** select text, open the picker, scroll the note; it stays next to the text and inside the window.
7. **Attachments:** Settings → This vault → **Use a different place in Liber Linteum**; then paste an image, and it goes to the new place.
8. **Screenshot paste:** ⌘⇧⌃4, then ⌘V. Also paste an image copied from Preview (TIFF).
9. **Related chips:** **+ Related page**, then open a chip, then remove one with × (focus stays on the chips). **Connect cards** in the Global View toolbar.
10. **Full width:** the toggle in the band; Settings → Editor (app-wide) and Settings → This vault.
11. **Code:** a ```` ```js ```` block is coloured in every mode; the language badge and its picker (typing "py", "ts" or "xml" picks the right one); Copy.
12. **Maths:** `$x^2$`, a `$$…$$` block, and prices like "$10-$20" staying text.
13. **Mermaid:** a ```` ```mermaid ```` flowchart and a sequence diagram, in Live Preview and Split.
14. **Outline and word count:**
    - Outline on/off;
    - clicking a heading jumps to it;
    - a narrow window (overlay);
    - the word count with and without a selection.
15. **Text files:**
    - open a `.txt`, `.json` and `.csv` from the explorer, edit them, then reopen them;
    - rename one, and the extension is kept;
    - rewrite a file outside the app (e.g. export a CSV from Excel), and the app warns instead of overwriting.
16. **Block moves (M4):** fast Alt+↑ / Enter / ↓ sequences in Split all land.

## 4. Final review and fix pass

**Reviewer:** Opus, fresh context, on `9167140..b0405e3` (both parts). Report: `.superpowers/sdd/2026-10-14-m4b-feedback/final-review.md`.
- **Verdict:** ready with fixes: 1 Critical, 6 Important and 10 Minor findings, 8 of the minors fixed.
- **The good news:** the build change for frozen prototypes was checked against all 7,428 production dependency files; no network leaks; typing stays fast up to 400 KB; no layout overflow from 900 to 1440 px.

| # | Finding | Fix |
|---|---|---|
| C1 | The app wouldn't start on macOS 12.0–12.2 (lowlight called `Object.hasOwn` at load) | grammars registered one by one; startup test simulating missing APIs |
| I1 | The language picker chose the wrong language on Enter (`js` → JSON) and wrote ids with spaces | exact matches first; ids without spaces; editor and pane read them back the same way |
| I2 | Prices became maths (`$10-$20`) and links between them vanished | Pandoc's dollar rules |
| I3 | A text file rewritten outside as non-UTF-8 could be overwritten with � characters | never merged or overwritten; notice, toast and **Save as new file** |
| I4 | Focus fell to `<body>` after removing a Related chip and after renaming a text file | focus kept |
| I5 | Links inside Mermaid diagrams were live | inert |
| I6 | Recovery copies of text files became `.md` pages | extensions kept (`entry_create_text`) |
| Minors | Word count parsed twice and counted URLs; outline O(n²); `class_` colouring; Copy announcements; excerpts and `$$`; band height 163 px → 132; subtitle ellipsis; text view back arrow; page widths after delete | one commit each, RED → GREEN |
| M4 bug | Gutter keys pressed while the Split pane lagged were dropped | queued and replayed |

**Found by the maintainer after the fix pass:**
- **Symptom:** `pnpm dev` opened a blank window.
- **Cause:** Vite's dev server ran the freeze-safe transform a second time on its pre-bundled deps (`node_modules/.vite/deps`), turning the helper's own `Object.assign` into a call to itself, so startup overflowed the stack. Production builds run the transform once, so no e2e saw it.
- **Fix (`ed0b717`):** the transform is idempotent and skips pre-bundled deps; covered by tests in `tests/freezeSafe.test.ts`.
- **Lesson:** a change to the build pipeline also needs a check against the dev server (`pnpm dev`), not only the production bundle.

**Deferred:**
- `freezeSafe` edge cases (none occur in the dependency tree);
- `Object.assign` replacement overhead (~130 ns per call);
- the gutter's current block id isn't remapped after an external re-parse.

## 5. Added after the round: resizable covers (the maintainer, 2026-10-14)

**The feature:** drag the cover band's bottom edge to resize it, per page.
- **Storage:** heights live in `.liber/vault.json` `coverHeights`, never in the note. They follow renames and moves, and are forgotten when the page is deleted.
- **Default:** set in Settings → Editor → **Default cover height**: Small 132, Medium 200 (the default), Large 280 or Extra large 360.
- **Range:** 132 px up to 60% of the window, re-clamped when the window shrinks.
- **Keyboard:** focus the edge, then ↓/↑ (Shift for bigger steps), Home or End, Enter to save, Escape to cancel. Double-click or Delete resets it.
- **Backend:** command `cover_height_set` (real-ACL test).
- **Commits:** `8a980c9`, `cec75e9`.
- **Gate after it:** vitest 1174, e2e 180, cargo 290; all clean.

**Windows test build:** cross-compiled on macOS with `cargo-xwin` and NSIS, in a toolchain kept apart in `~/.liber-cross`.
- Output: `target/x86_64-pc-windows-msvc/release/bundle/nsis/Liber Linteum_0.1.0_x64-setup.exe` (unsigned; SmartScreen asks for More info → Run anyway).
- Rebuild with:

  ```bash
  cd apps/desktop
  export CARGO_HOME=$HOME/.liber-cross/cargo RUSTUP_HOME=$HOME/.liber-cross/rustup RUSTUP_TOOLCHAIN=1.99.0 XWIN_ACCEPT_LICENSE=1
  export PATH="/opt/homebrew/opt/rustup/bin:$CARGO_HOME/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
  pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
  ```
- Not yet run on real Windows.

