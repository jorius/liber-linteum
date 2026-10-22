# Overnight hand-off (2026-10-22)

Supersedes `2026-10-21-session-handoff.md`. Everything is on branch **`feat/custom-titlebar`** (40 commits over `a0c84b7`, merges only, **nothing pushed**). The resource rules in the old hand-off still apply.

## Try first

1. Quit Liber Linteum, then install the new build: `sudo apt install "./target/release/bundle/deb/Liber Linteum_0.1.0_amd64.deb"` (built 00:20, everything below is in it).
2. Open your copy of the sample vault, *The Moons of Kessari* (covers fixed), and the Notion sample: File → Import from Notion → `examples/notion-sample-export.zip`.
3. The showcase site is served at **http://127.0.0.1:8765/liber-linteum/** (a detached `python3 -m http.server` in `/tmp/liber-site-preview`; stop it with `pkill -f '[h]ttp.server 8765'`).

## What's in the branch

| Area | What |
|---|---|
| Title bar (Linux, Windows) | The app draws its own frame with the macOS menus (Liber Linteum, File, Vault, Edit, View, Window); F10, Ctrl+Q, Alt+Ctrl+W, F11. Spec: `docs/superpowers/specs/2026-10-21-custom-titlebar-design.md` |
| Editor | Ctrl+F finds in the page (find and replace), Ctrl+Shift+F is vault search; auto-close brackets and quotes (Settings → Editor); `Ln 12, Col 8 · 15 selected` beside the word count; Ctrl+G Go to line (`42`, `42:7`, `+5`) |
| Files | Settings → Files → Show file extensions |
| Home page | A vault opens to a page or the Global View: right-click → Set as home page, the house in the page header, "Use as home" in the Global View, Settings → This vault → Home |
| Encryption | Decrypt "<vault>" (passphrase **and** recovery key; crash-safe; keys deleted, not trashed) and "Keep a readable copy?" when encrypting in place. Reviewed independently; all 10 findings fixed with tests (spec §9–§10 of `2026-10-21-encryption-ux-design.md`) |
| Linux fixes found tonight | Reading a note no longer counts as changing it (notify's IN_OPEN; three watcher tests failed on Linux); the sidebar menu stays on screen; Global View "See all" on a folder page shows its pages; card titles no longer run over subtitles (WebKitGTK line-clamp + inline-block); excerpts drop callout markers (index schema 6: one quick re-index); the drag ghost after the sidebar slide-in |
| Notion import | A database's table now links relations and shows ISO dates (it showed `Oren Vask (Caravan%20Roster…md)`) |
| Sample vault | `examples/the-moons-of-kessari/` (7 chapters, world, field notes, 8 Dune essays, covers, map, dune recording) and `examples/notion-sample-export.zip` |
| Showcase site | `site/` with 8 real clips recorded from the release build (`site/tools/capture/`, see its README), Roadmap section, credits; deploys with `.github/workflows/pages.yml` once the repo is public |
| Release | `.github/workflows/release.yml`: tag `vX.Y.Z` → .deb + AppImage (Ubuntu 22.04), .exe + .msi, universal .dmg (ad-hoc signed), sample vault + Notion sample, SHA256SUMS, VirusTotal (secret `VT_API_KEY`), **draft** release. Publishing it redeploys the site, which writes `release.json` from it |
| CI fixes | ALSA dev package; `tests/menu.rs` on Linux/Windows; the capability test's real file dialog; four runner-only flaky tests (macOS audio timing, WebKit-on-Linux key bindings, search re-render, an unanswered mock) |
| Personal site | Branch `feature/liber-linteum-card` in `jorius.github.io` (one commit, not merged): the project card as `draft: true`, chips for Tauri 2 and SQLite |

## Checks (last runs, this machine)

Rust: fmt, clippy `-D warnings` clean; every test binary passes (the three watcher tests now pass too). Frontend: lint, types, i18n parity clean; Vitest 1,993 pass (2 timing tests fail only under load). Playwright Chromium: all pass except 6 that fail on this machine on `main` too (`cover-resize` ×3, `m2c.spec.ts:58`, `m4b3-files.spec.ts:172,193`; they pass on GitHub's runners). Site: 36/36. WebKit isn't installed here, so the WebKit project hasn't run locally.

## Needs you

1. **Push** `feat/custom-titlebar` and open a PR to `main` to see CI run with the fixes (the old failures: ALSA, `tests/menu.rs`, the audio and search flakes, the WebKit audio test).
2. **VirusTotal**: create a free account, add the API key as the repo secret `VT_API_KEY` (without it releases still work, with no reports).
3. **First release**: bump nothing (0.1.0), tag `v0.1.0`, push the tag; review and publish the draft.
4. **Donations**: create GitHub Sponsors and Ko-fi (`docs/research/2026-10-21-donation-platforms.md`), then set `donate.enabled` and the URLs in `site/js/config.js`.
5. **Make the repo public**, then flip `draft` to `false` on the `jorius.github.io` card and merge that branch.
6. **Compare on the Mac**: Global View card titles (a two-line title's descenders may still be clipped on Linux), and the new drawn menus don't show there (macOS keeps the native menu, which gained Edit → Find…, Go to Line… and Vault → Decrypt).

## Noticed, not done

- **Voice clips don't play on Linux** (found 2026-10-22 morning): WebKitGTK's media player refuses the app's `liber-asset://` scheme (`MediaPlayerPrivateGStreamer … loadingFailed: FormatError`), so every audio embed shows `0:00 / 0:00`. Recording works. Fix options: serve audio to the player as a `blob:` URL (needs `liber-asset:` in the CSP's `connect-src`, or an IPC command returning the bytes); decide before changing the security policy.
- Showcase clips: `2026-10-22-macos-clips-handoff.md` has the storyboards for re-recording all 12 on macOS.

- A page opened with the cursor on line 1 shows its frontmatter and `# Title` raw in Live Preview (by design today; worth a look).
- The Notion import's report/breadcrumb shows an odd glyph after "Dela's Caravan Notes /".
- Editor basics still open from the list: zoom shortcuts, print/export to PDF, quick switcher, multiple cursors, insert date, version history (roadmap), tabs, command palette.
