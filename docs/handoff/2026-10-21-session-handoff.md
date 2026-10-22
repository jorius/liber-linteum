# Session hand-off (2026-10-21, late)

> **Superseded by `2026-10-22-overnight-handoff.md`.**

The previous session ran long and crashed several times (see "Resource rules"). Everything below is on disk; nothing is pushed. Start here.

## Resource rules (why the session crashed)

- 19:13 and 19:56: `systemd-oomd` killed the whole terminal (15.5 GB and 17.3 GB peaks) while Playwright e2e and the full Rust test build ran **at the same time**. Each `apps/desktop/src-tauri/tests/*.rs` binary links the whole app (1–2 GB per link).
- 22:36: the session process ended with no OOM record (6.7 GB peak), with five background agents and a ~15 MB transcript. A long session plus many concurrent agents is the likely cause.
- **Rules:** at most **two** background agents, and only **one** doing Rust builds or tests. Never run Rust builds and Playwright together. Use `CARGO_BUILD_JOBS=4 CARGO_PROFILE_DEV_DEBUG=line-tables-only` for cargo (much smaller links), `--workers=2` for Playwright, never `cargo test --workspace` in an agent. Start a fresh session after a big batch of work.
- Each agent worktree has its own `target/` (8–15 GB). Delete `target/` in a worktree once its branch is merged.

## Branches and worktrees

| Branch | Where | State | What's left |
|---|---|---|---|
| `feat/custom-titlebar` | main checkout (`<repo>`) | **Done, uncommitted** (the maintainer still to test the `.deb` built from it) | Commit; merge `origin/main` (`556884e`, vault-name menu items) into it — **merge, never rebase**; add menu items for Find, Go to line, Decrypt, Home when those land |
| `feat/find-and-extensions` | `.claude/worktrees/agent-a0f9290c3d8a8255e` | 2 commits: find in page + show file extensions; auto-close brackets and quotes | **Cursor position** (`Ln 12, Col 8 · 15 selected`, a button opening Go to line) and **Go to line** (Ctrl+G on every OS incl. macOS; `42`, `42:7`, `+5`/`-5`; macOS menu Edit → Go to Line… id `liber-goto-line`; shortcuts table). Then the checks |
| `feat/decrypt-vault` | `.claude/worktrees/agent-ae8a207fa54399ab0` | ~41 files uncommitted work in progress (based on `556884e`) | Review the diff, finish: Decrypt "<vault>" (passphrase **and** recovery key, crash-safe in-place decrypt mirroring encrypt-in-place, keys/header/epochs removed, re-encrypt gets new id) and the "keep a readable backup in a folder you pick" step of Encrypt in place. Design sections go in `docs/superpowers/specs/2026-10-21-encryption-ux-design.md` |
| `feat/home-page` | `.claude/worktrees/agent-a92400d8f4e7e8d4e` | ~35 files uncommitted work in progress | Finish: per-vault home (a page or the Global View) in `.liber/vault.json`, follows renames, cleared on trash/archive; set from the tree's context menu, the Global View, Settings → vault; house glyph in the tree; open flow goes home unless something explicit was requested |
| `feat/showcase-site` | `.claude/worktrees/agent-ac477d387ab76de74` | **Done**, 3 commits, 36 Playwright tests pass | Real media (videos/posters into `site/media/`, list them in `site/js/config.js`), donate URLs once accounts exist, `release.json` from the release pipeline. Preview: `python3 -m http.server 8765` in its `site/` |

Untracked in the main checkout: `examples/` (sample vault, Notion sample), `docs/research/2026-10-21-donation-platforms.md`, `docs/superpowers/specs/2026-10-21-custom-titlebar-design.md`, `docs/superpowers/specs/2026-10-21-showcase-site-design.md`, `docs/design/showcase/mock-v2.html`, this file.

## Sample vault (`examples/`)

- `examples/the-moons-of-kessari/`: the story (7 chapters in `The Story/`), `World/` (Kessari, moons, places, factions, people, timeline), `Field Notes/`, `Welcome.md` — written. **Check** the asset script `examples/scripts/make_kessari_assets.py` ran (covers in `attachments/covers/`, `map-of-the-salt-road.png`, `the-dunes-at-dusk.wav`), `.liber/vault.json`, and that every wikilink/cover/embed resolves; wire `screening-1..8.png` covers into `Screening Room/` pages.
- `Screening Room/`: 8 Dune film essays (one in Spanish) — done.
- `examples/notion-sample-export.zip` + `examples/scripts/make_notion_sample.py` — done, verified with the real importer (4 pages, 2 databases, 17 rows, 1 image, 0 warnings). Importer gaps found: relation cells stay raw text in database index tables; Notion date format kept in those tables.
- Later: an encrypted copy of the vault for the encryption demo.

## After all branches land

1. Merge everything into one integration branch (merges only), run the full checks once (serially), build the `.deb` (`cd apps/desktop && pnpm tauri build --bundles deb`), hand it to the maintainer with a test list.
2. Capture real screenshots/videos of the sample vault for the site.
3. Release pipeline: fix CI (known Linux issues already fixed on `feat/custom-titlebar`: `tests/menu.rs` macOS-only items; `m1b_every_command…` hanging on a real file dialog. Still failing on Linux: `cover-resize.spec.ts` ×3, `m2c.spec.ts:58`, `m4b3-files.spec.ts:172,193`; flaky `blockMoves` 200 KB perf test). Tagged releases with `.deb`, `.AppImage`, `.exe`, `.msi`, `.dmg`, SHA-256 checksums and VirusTotal links (unsigned is fine), writing the site's `release.json`.
4. Personal site card in the `jorius.github.io` repo (its own conventions: npm, capitalised-verb commits, **no Co-Authored-By**).

## Decided with the maintainer (don't re-ask)

- Linux/Windows title bar: the app draws its own (option B), menus mirror macOS.
- Encrypt in place offers a readable backup in a folder the user picks.
- Decrypt asks for both passphrase and recovery key.
- Ctrl+F finds in the page in the editor; Ctrl+Shift+F is vault search.
- Home page per vault: a page or the Global View.
- Showcase site: "open desert by day", approved round-2 mock; roadmap section with version history, slash menu, focus mode; credits "An idea by José Meza, built by Jose Ríos."
- Donations: GitHub Sponsors + Ko-fi recommended; the maintainer to create accounts (see `docs/research/2026-10-21-donation-platforms.md`).
- Releases unsigned, with checksums and VirusTotal.
- Next editor basics after this batch: from the list in the session (zoom shortcuts, print/PDF, quick switcher, multiple cursors, insert date, version history…), the maintainer picks.
