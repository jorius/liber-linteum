# M4b part 3 — Second feedback round (Windows test, Obsidian vault): Hand-off

**Where the feedback came from:**
- Jose's Mac check.
- A friend's test on Windows with a real Obsidian vault ("Mind_PC").
- Two later requests from Jose:
  - wide tables;
  - Escape and a click outside close Settings.

**Specs:**
- `docs/superpowers/specs/2026-10-15-m4b-part3-design.md`. It holds §1–§12, plus:
  - the planning amendments: §13 (covers and titles), §14 (Global View), §15 (files and links);
  - §16, the files-and-links final review.
- `docs/superpowers/specs/2026-10-15-m4b-part3-wide-elements-design.md`, with its §6 amendments.
- Product spec PG-01 now has the new title rule.

**Plans (as run):**
- `docs/superpowers/plans/2026-10-15-m4b3-covers-titles.md`
- `docs/superpowers/plans/2026-10-15-m4b3-global-view.md`
- `docs/superpowers/plans/2026-10-15-m4b3-files.md`
- `docs/superpowers/plans/2026-10-15-m4b3-wide-elements.md`

**Branch:** `feat/m4b3-feedback`, stacked on `feat/m4b-feedback`. Merge order for the whole stack: M2c → M3a → M3b → M4 → M4b → M4b part 3.

**How it was built:**
1. Six questions answered by Jose: titles, side covers, link formats, picked files, atoms, and the Windows cover.
2. A further question about wide elements.
3. Four streams built in parallel, each with its own plan, worktree and full gate:

   | Stream | Covers |
   |---|---|
   | A | Global View |
   | B | Covers and titles |
   | C | Files and links |
   | D | Wide elements |

4. The streams were integrated by cherry-pick, with conflicts resolved by hand.
5. Two final reviews: A/B/D, and C with a security focus. Then two parallel fix passes.
6. The Settings change, done directly.

## 1. What changed, by feedback item

| Feedback | Result |
|---|---|
| Some Obsidian titles weren't shown ("Tipos de comisiones" showed as "WIP (Work In Progress):") | A title is an H1 **only when it's the first block of the note** (after frontmatter and blank lines); otherwise the **file name**, as Obsidian does. This also holds after an empty or unusual frontmatter block and after a UTF-8 byte-order mark (Windows Notepad). Indexes rebuild once (schema 2). |
| Windows: Global View cards ignore the repositioned part of the cover | **Cause:** in WebView2 (Chromium), the card's image kept its natural height (1190 px in a 96 px frame), so `object-position` had nothing to crop and the card showed the image's top. **Fix:** the frame has a fixed size and the image fills it, so the stored focus shows. A Chromium e2e reproduced the bug first. |
| Covers on the left or right | **Placement:** Top / Left / Right per page (radio group in the cover actions; ⌘Z works). A side cover is a **tall strip** beside the text, with these behaviours: drag its inner edge to resize (160 px to 45% of the window, never leaving the text under 520 px); arrow keys, Home/End, Enter and Escape work on the edge; double-click resets it to 280; repositioning works in both axes (new frontmatter `cover-x`); it falls back to a top band in narrow windows. **Storage:** `.liber/vault.json` `coverSides`/`coverWidths`. **Global View cards** show the strip on the same side. |
| Pages and folders look alike on cards | **Page cards:** **Edit** with a pencil icon. **Folder and project cards:** keep **See all** with a stack icon, and look like folders (a tab, a second sheet behind, a tinted head). Kind labels get icons. |
| Parent/child and "links from inside folder" lines hard to tell apart | **Lines:** parent/child lines are now thin solid **elbows**, while folder links are long dashes with a **count chip** ("12 links"). **Focus:** hovering or keyboard-focusing a card lights its lines and dims the rest. **Legend:** the edge toggles show a sample of each line. |
| "See atoms" | **What it shows:** a page as a map of its **sections and every block**: paragraphs, lists, quotes, code, tables, images, audio, embeds, maths and diagrams. Lines run to linked pages and related pages. **Entry points:** an Atoms button on page cards, "See atoms" in the card menu, and View → See Atoms of This Page. **Clicking an atom** opens the editor at that block and flashes it. The map is read-only. |
| Format bar: pick files through the OS dialog | **Attach** (paperclip) opens the system file dialog with multiple selection; "All files" comes first on Windows. It then asks **Copy into the vault** or **Link to where it is**, each time. Files already in the vault are linked directly. |
| Optional: show attachments' whole local path | **Settings → This vault → Link format for new attachments:** Shortest name / Full path in the vault / Relative to the note / Absolute path on disk (written as `file:///…`, which Obsidian opens). It follows Obsidian's `newLinkFormat` until set. **Settings → Editor → Show where attachments are on disk:** a caption with the full path and Copy under each embed. |
| Attach with absolute or relative paths (`![[D:\Docs\my-file.pdf]]`) | **Path forms read:** Windows drive paths, UNC, `file:` URLs, `../` above the vault root, and a leading `/` (vault first, then disk). **Serving:** outside files are served only if a saved note links them (an allow-list); only regular, non-hidden files. **Network paths** are never touched until you click **Load from network**. **Open** works for documents and media only; anything else gets **Show in Finder/Explorer**. |
| Tables use the full width (Jose) | **New width:** a third page width, **Wide elements** (header menu: Readable / Wide elements / Full width / Reset to default; Settings → Editor; Settings → This vault). **What goes wide:** chosen in Settings → Editor (Tables and Diagrams on by default; also Code blocks, Images, Maths). Text keeps the readable width. **Table cells** no longer split words ("Typic al"); a table that doesn't fit scrolls sideways in its own box. |
| Escape and a click outside save and close Settings (Jose) | **Escape** closes Settings even when nothing in it has focus (WKWebView doesn't focus a clicked checkbox). **A click on the backdrop** also closes it. Before closing, a value typed but not confirmed (a folder or an accent hex) is saved. A press inside released outside doesn't close it. Other dialogs are unchanged. |

## 2. Totals

Full gate (`check.sh all`) on the final tip, before this doc's commit:

| Check | Result |
|---|---|
| vitest | 1281 tests in 115 files |
| e2e | 246 passed in Chromium and WebKit, plus 8 opt-in perf tests skipped |
| cargo | 356 passed, 2 ignored (the trash tests, never run here) |
| lint, typecheck, i18n, build, fmt, clippy, deny | all clean |

`pnpm dev` itself was checked as well: the dev server booted in Chromium and WebKit with the IPC mock, with no page errors, through a page with a wide table and code, maths and Mermaid blocks, then Settings and Escape, then the Global View.

## 3. Needs the real window

### Jose, on the Mac (`pnpm dev`)

1. **Titles.**
   - A note whose first line is `# Something` shows "Title in the note: Something" if that differs from the file name.
   - A note with an H1 further down shows only the file name (cards, `[[` list).
2. **Side covers.**
   - On a page with a cover, choose Left, then Right, then Top. ⌘Z undoes a placement.
   - Drag the strip's edge, restart, and check the width is kept. Double-click the edge to reset it.
   - Narrow the window and check the strip turns into a top band, then comes back when you widen.
   - Reposition a side cover in both directions, then Save position.
3. **Global View cards.**
   - Side covers show as strips.
   - Pages say **Edit**; folders look like folders (tab, second sheet) and say **See all**.
4. **Edges.**
   - In a busy view, check parent/child elbows against the dashed folder links with counts.
   - Hover a card and check its lines light up.
   - Check the legend in the edge toggles.
5. **See atoms.**
   - From a page card's Atoms button, a long note shows sections as columns with blocks under them.
   - Clicking a block opens the editor there with a flash.
   - Escape goes back.
   - Try View → See Atoms of This Page from the editor.
6. **Attach.**
   - Pick one image, then three files. Choose Copy, then repeat with Link.
   - Cancel the popup.
   - Pick a file that's already in the vault: it isn't asked about.
7. **Link format.**
   - Try each option in Settings → This vault, pasting an image after each.
   - Turn on "Show where attachments are on disk" and check the captions and Copy.
8. **Outside files.**
   - Type `![](file:///Users/<you>/Pictures/x.png)` and save: the image shows.
   - `[[/Missing page]]` still offers Create page.
   - A `.pdf` outside the vault has Open; a `.zip` only has Show in Finder.
9. **Wide elements.**
   - Open your "Military Ranks" page, choose Wide elements, and check the table spreads while text stays narrow.
   - Untick Tables in Settings and check it comes back.
   - Check no cell splits a word in Readable.
   - Drag a wide table's scrollbar.
10. **Settings.**
    - Change something, press Escape, and check it's saved and closed.
    - Open it again and click outside.
    - Type a folder name in This vault → attachments without pressing Enter, then click outside: it's kept.

### The friend, on Windows (the `.exe`)

1. Global View cards show the **repositioned** part of each cover, not the top.
2. "Tipos de comisiones" is titled by its file name everywhere; the "Title in the note" label is gone for it.
3. **Attach:** the dialog opens on All files, so PDFs are visible. Copy and Link both work.
4. `![[D:\Docs\my-file.pdf]]` (any real file) shows a file card with Open.
5. A link to `\\some-server\share\x.png` shows a **Network file** card and connects only after **Load from network**.
6. Side covers, wide tables, See atoms and Settings behave as on the Mac.
7. The index rebuilds once on first open; the vault should open normally.

## 4. Final reviews and fix passes

### Review of A/B/D

No Critical findings. Three Important findings, plus one Minor re-graded to Important; all four fixed with tests that failed first.

1. **Side strip resize.**
   - Bug: widening past the room flipped the strip to a top band mid-drag and lost the change.
   - Fix: the drag and keys stop where the text would go under 520 px.
2. **See atoms in CRLF notes.**
   - Bug: notes with Windows line endings jumped to the wrong block.
   - Fix: the text is normalised to LF before offsets are built.
3. **Table scrollbar.**
   - Bug: pressing a wide table's scrollbar turned the table into source.
   - Fix: presses on the scroll box itself are ignored.
4. **Titles after unusual frontmatter or a BOM** (re-graded from Minor). The title is now read from the body after the app's own frontmatter split, and a UTF-8 BOM no longer hides frontmatter.

### Review of C (security focus)

One Critical and three Important findings. Fixed: the Critical, two of the Important, and two Minors re-graded up. I3 was ruled.

- **C1, Critical: a Windows credential leak.**
  - Bug: just viewing a note with a UNC link made Windows connect to that server with the user's NTLM hash (the class of Outlook CVE-2023-23397).
  - Fix:
    - Network targets (UNC, `file://host/`, and macOS `/net/host/…`) are never touched until **Load from network** is clicked; the approval lasts for the session.
    - Device namespaces and reserved names are refused.
    - `exists` is computed only for listed paths, so the app can't be used to probe whether a file exists.
- **m2, re-graded: raw HTML.** It can no longer name an outside file; the pipeline seals its own markers.
- **I1: links starting with `/`.** A `/`-leading link to a missing file offers Create page again (a vault link unless a saved note links an existing disk file).
- **I2: opening outside files.** It now uses an allow-list of document and media types (spec §16), checked against both the name and the real path. Everything else gets Show in Finder/Explorer.
- **m7, re-graded: the Windows file dialog** starts on All files.
- **I3, ruled: no second schema bump.** No schema-2 build had shipped, so the next build rebuilds every index once anyway.

### Deferred minors (for a later pass)

**From the A/B/D review:**
- Several overflowing tables on one page give identical region names ("Table, scrolls sideways").
- A second jump within 1 s has its flash cut short.
- A jump requested for a page that fails to open stays queued.
- HTML-comment blocks make empty atom cards.
- Housekeeping:
  - unused i18n keys `cover.top/left/right`;
  - a stale docblock on `WidthIcon`;
  - the `NoteTitle` comment.
- A failed page-width save gives no toast.

**From the C review:**
- **Paths and names:**
  - File names with a literal `%XX` never load through Markdown `file:` URLs.
  - Windows hidden-attribute and macOS hidden-flag folders count as visible.
  - `\\?\` long-path vault roots give a broken `file://` URL.
- **Reading files:**
  - Huge outside files are read whole on each request.
  - There's a small gap between checking a file and reading it.
- **The Attach popup:**
  - no close on outside click, and no focus trap;
  - the import grant expires after 2 minutes;
  - mixed in-vault and outside picks take two undo steps.
- **Wording:**
  - one doc comment is inaccurate;
  - the tooltip says "Attach…" where the spec said "Insert…".

### Rulings to confirm (taken on your behalf; details in the spec amendments)

**Global View and atoms:**
- Link edges stay straight, with no arrowheads: Rust aggregates links as undirected pairs. Directed relationships keep theirs.
- The atoms map refreshes on save, not per keystroke.
- A click on a linked page's card in an atoms map shows that page's atoms.

**Page width:**
- Width changes aren't undoable with ⌘Z; use "Reset to default" in the width menu.
- With line numbers on, wide blocks keep the text's left edge and grow to the right; otherwise they grow evenly.
- The Split pane has no measure, so Wide elements doesn't change it.

**Covers:**
- A cover's placement can only be undone while the page is open in the editor.
- `cover-x` is shared by top and side placements.

**Outside files and links:**
- Absolute paths are always outside files, even when they point inside the vault: no backlinks, not rewritten on rename. This is how Obsidian treats `file:` links.
- Only links in the note body can name outside files; `cover:` and `related:` can't.
- "Link to where it is" writes `![](file:///…)` for media and PDFs and `[name](file:///…)` for others.
- A network share that holds the vault itself isn't "another computer".
- The macOS file dialog has no type filters, because of a library limitation.

**Settings:**
- Escape and a click outside apply only to Settings, the one dialog that saves as you go. The other dialogs keep Escape as Cancel.

## 5. Builds

**Mac:** `pnpm dev` from the repo on `feat/m4b3-feedback`.

**Windows:** cross-compiled on the Mac with `cargo-xwin` and NSIS, in a toolchain kept apart in `~/.liber-cross`.
- Output: `target/x86_64-pc-windows-msvc/release/bundle/nsis/Liber Linteum_0.1.0_x64-setup.exe`.
- It's unsigned, so SmartScreen asks for More info → Run anyway.
- Rebuild with:

```bash
cd apps/desktop
export CARGO_HOME=$HOME/.liber-cross/cargo RUSTUP_HOME=$HOME/.liber-cross/rustup RUSTUP_TOOLCHAIN=1.99.0 XWIN_ACCEPT_LICENSE=1
export PATH="/opt/homebrew/opt/rustup/bin:$CARGO_HOME/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```
