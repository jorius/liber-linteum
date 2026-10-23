# Developing Liber Linteum

How to run, build, test and release the app, how the code is organised, and how the website
is made. For *what* the app does and why, see [`product-spec.md`](product-spec.md); for the
design documents behind each part, [`README.md`](README.md) in this folder.

- [1. Prerequisites](#1-prerequisites)
- [2. Run it](#2-run-it)
- [3. Build installers](#3-build-installers)
- [4. Tests and checks](#4-tests-and-checks)
- [5. How it is built](#5-how-it-is-built)
- [6. Where things live at run time](#6-where-things-live-at-run-time)
- [7. Continuous integration](#7-continuous-integration)
- [8. Releasing](#8-releasing)
- [9. The website](#9-the-website)
- [10. Conventions](#10-conventions)
- [11. Known issues](#11-known-issues)

## 1. Prerequisites

| Tool    | Version                                    | Notes                                                                    |
| ------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Node.js | 24 (`.nvmrc`; `engines` allows ≥ 22.18)    | The project is built and tested on 24                                    |
| pnpm    | 12 (`packageManager` in `package.json`)    | `corepack enable`, or `npm i -g pnpm@12.11.2`                            |
| Rust    | 1.99.0 (`rust-toolchain.toml`)             | rustup installs it on first use, with rustfmt and clippy                 |

System packages for Tauri 2:

- **Linux** (Ubuntu 22.04 or newer; WebKitGTK 4.1 isn't in 20.04):

  ```sh
  sudo apt install -y build-essential curl wget file git pkg-config patchelf \
    libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev \
    librsvg2-dev libasound2-dev
  ```

  `libasound2-dev` is for voice recording (ALSA, through `cpal`).

- **macOS**: Xcode Command Line Tools (`xcode-select --install`).
- **Windows**: Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 11).

Then, at the repository root:

```sh
pnpm install
```

## 2. Run it

```sh
pnpm dev
```

This starts Vite and the Tauri app with hot reload for the UI; Rust changes rebuild and
restart the app. To try it on real content, open `examples/the-moons-of-kessari` with **Open
folder as vault**, and import `examples/notion-sample-export.zip` with **File → Import from
Notion…**. Copy the sample vault somewhere else first if you don't want the app's
`.liber/` folder and your edits in the repository.

## 3. Build installers

```sh
pnpm build                     # every installer type for this system
cd apps/desktop
pnpm tauri build --bundles deb             # Linux: just the .deb
pnpm tauri build --bundles deb,appimage    # Linux: .deb and .AppImage
pnpm tauri build --bundles nsis,msi        # Windows
pnpm tauri build --target universal-apple-darwin --bundles dmg   # macOS, Intel + Apple silicon
```

Output goes to `target/release/bundle/<type>/` at the repository root
(`target/universal-apple-darwin/release/bundle/dmg/` for the universal build). Run
`pnpm tauri …` from `apps/desktop`: from the root, pnpm can't find the `tauri` command.

On Linux, install the result with
`sudo apt install "./target/release/bundle/deb/Liber Linteum_0.1.1_amd64.deb"`. Quit the app
first: a running copy keeps the old version until it restarts.

### A Windows installer from macOS

Cross-compiled with [cargo-xwin](https://github.com/rust-cross/cargo-xwin), with a toolchain
kept apart in `~/.liber-cross` (a machine set up before the rename has it in `~/.nimw-cross`).
The same exports run `cargo xwin check -p liber-desktop --tests --target x86_64-pc-windows-msvc`,
the Windows compile check.

```sh
cd apps/desktop
export CARGO_HOME=$HOME/.liber-cross/cargo RUSTUP_HOME=$HOME/.liber-cross/rustup RUSTUP_TOOLCHAIN=1.99.0 XWIN_ACCEPT_LICENSE=1
export PATH="/opt/homebrew/opt/rustup/bin:$CARGO_HOME/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

The installer lands in `target/x86_64-pc-windows-msvc/release/bundle/nsis/`.

## 4. Tests and checks

`pnpm check` runs everything CI runs. The pieces:

| Command                          | What                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm lint`                      | ESLint (including the ban on network APIs) and Prettier over the whole repository          |
| `pnpm typecheck`                 | TypeScript                                                                                 |
| `pnpm test`                      | Vitest: the UI's unit and component tests (jsdom), about 2,000                             |
| `pnpm check:i18n`                | English and Spanish have exactly the same keys                                             |
| `pnpm build:ui`                  | Builds `apps/desktop/dist`, which the Rust crate embeds: needed before any `cargo` build   |
| `pnpm test:e2e`                  | Playwright against the built UI with a mocked backend, in Chromium and WebKit             |
| `cargo fmt --all --check`        | Rust formatting                                                                            |
| `cargo clippy --workspace --all-targets -- -D warnings` | Lints, warnings as errors                                           |
| `cargo test --workspace`         | Every Rust test                                                                            |
| `cargo deny check`               | Licences and banned crates (any HTTP client is banned). Needs `cargo install cargo-deny --locked` |

First Playwright run: `pnpm --filter @liber/desktop exec playwright install chromium webkit`.
`LIBER_E2E_PORT` (default 4317) lets several checkouts run e2e side by side.

Heavier, opt-in tests:

| Command                                                                                     | What                                                              |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `cargo test --release -p liber-session --test search -- --ignored --nocapture`              | Search performance on a generated 10k-note vault (also `--test global_view`) |
| `LIBER_PERF=1 cargo test --release -p liber-session --test encrypted_perf -- --nocapture`   | Encrypted vault: unlock to searchable on 10k notes, budget 3 s    |
| `LIBER_XCHECK_PY=<venv>/bin/python cargo test -p liber-vault --test encrypted_xcheck -- --nocapture` | An encrypted vault the app wrote, read back by the independent Python reader (`pip install 'cryptography>=44'`) |
| `LIBER_TRASH_TESTS=1 cargo test …`                                                          | Tests that use the real OS trash (CI sets it; its home is throwaway) |

A few UI timing tests (block moves in a 200 KB note) can fail on a busy machine; they pass on
their own (`pnpm exec vitest run src/markdown/blockMoves.test.ts` in `apps/desktop`).

On a laptop, a full `cargo test --workspace` next to Playwright can exhaust memory: run them
one after the other, and cap Rust's parallelism (`CARGO_BUILD_JOBS=4`) if needed.

## 5. How it is built

```
apps/desktop/
  src/             React 19 + TypeScript UI (Vite)
    features/      one folder per feature: editor, global-view, search, explorer, page, …
    ipc/           the only way to the backend (Tauri commands and events)
    markdown/      parsing and rendering for the preview (remark/rehype, sanitised)
    stores/        Zustand stores
    i18n/locales/  en.json, es.json
  src-tauri/       the thin Tauri shell: commands, menus, windows, CSP, capabilities
  e2e/             Playwright tests (mocked backend)
crates/            the Rust core, no Tauri dependency
  liber-vault      the file system: scan, watch, compare-and-swap writes, .liber/, Trash, Archive
  liber-markdown   reading a page: title, frontmatter, tags, links, body text
  liber-index      the SQLite index and search
  liber-session    one open vault, composing the three above
  liber-crypto     encrypted vaults (format: docs/security/vault-format-v1.md)
  liber-audio      microphone capture (cpal), WAV files (hound), level meter
  liber-import     the Notion importer: safe zip reading, names, links, databases
  liber-spell      offline spell check (English, Spanish)
  liber-testkit    fixtures and generated test vaults
examples/          the sample vault and the sample Notion export
site/              the website (section 9)
design/prototype/  clickable design reference (not shipped)
```

**The UI** is a Tauri webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on
Linux). The editor is CodeMirror 6 with three modes: Live Preview (Markdown rendered around
the cursor, `features/editor/livePreview.ts`), Source and Split. The Global View is React
Flow. Everything the UI needs from disk goes through `src/ipc/`.

**The backend** keeps one `liber-session` per open vault: it scans the folder, keeps a SQLite
index (`liber-index`) for search, links and the Global View, watches the disk for outside
changes, and writes files with compare-and-swap so an edit made elsewhere is never
overwritten silently. Encrypted vaults go through a storage seam
([`architecture/storage-seam.md`](architecture/storage-seam.md)) so the same code reads plain
and encrypted vaults.

**Privacy is enforced, not configured**: a strict Content Security Policy (no remote origins),
a Tauri capability allowlist, an ESLint ban on network APIs in the UI, and a `cargo deny` ban
on HTTP client crates. An e2e test fails on any network request. Remote images in notes show
a placeholder instead of loading.

**Vaults** are ordinary folders of Markdown. The app keeps its own settings for a vault in a
`.liber/` folder inside it (`vault.json`: Global View layout, home page and the like); links
and relationships live in the notes themselves (wikilinks, the `related:` frontmatter). It
reads `.obsidian/` settings but never writes them.

More depth: the architecture design
([`superpowers/specs/2026-10-12-architecture-design.md`](superpowers/specs/2026-10-12-architecture-design.md),
start at §0 "As built"), and the index
([`architecture/index-and-database.md`](architecture/index-and-database.md)).

## 6. Where things live at run time

The app's identifier is `app.liberlinteum.desktop`. Its settings (`settings.json`: theme,
language, recent vaults, editor options) are in the config directory; the cache directory
holds what can be rebuilt (each vault's index):

| System  | Settings                                                   | Cache                                            |
| ------- | ---------------------------------------------------------- | ------------------------------------------------ |
| Linux   | `~/.config/app.liberlinteum.desktop/`                      | `~/.cache/app.liberlinteum.desktop/`             |
| macOS   | `~/Library/Application Support/app.liberlinteum.desktop/`  | `~/Library/Caches/app.liberlinteum.desktop/`     |
| Windows | `%APPDATA%\app.liberlinteum.desktop\`                      | `%LOCALAPPDATA%\app.liberlinteum.desktop\`       |

Deleting the cache only costs a re-index. Moving the settings folder aside gives a clean first
run (put it back afterwards).

The app was called Notes In My Way until 2026-10-20: a vault's old `.nimw/` folder becomes
`.liber/` the first time it opens, and settings are copied once from
`app.notesinmyway.desktop`, which is never changed.

## 7. Continuous integration

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`:

| Job        | Runs on                         | What                                                    |
| ---------- | ------------------------------- | ------------------------------------------------------- |
| `frontend` | Ubuntu                          | lint, typecheck, Vitest, i18n parity                    |
| `e2e`      | Ubuntu                          | Playwright in Chromium and WebKit                       |
| `rust`     | Ubuntu, macOS, Windows          | builds the UI, then rustfmt (Linux), clippy, cargo test |
| `deny`     | Ubuntu                          | cargo-deny                                              |

## 8. Releasing

Releases are built by `.github/workflows/release.yml` from a tag:

1. Set the version in **three places**: `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/package.json` and `[workspace.package]` in `Cargo.toml` (the workflow fails if
   the tag and `tauri.conf.json` disagree). Commit and merge to `main`.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`. (Or run the workflow by hand
   from the Actions tab with an existing tag.)
3. The workflow builds on each system:

   | Runner        | Files (stable names, so `releases/latest/download/<name>` always works) |
   | ------------- | ------------------------------------------------------------------------ |
   | Ubuntu 22.04  | `Liber-Linteum_amd64.deb`, `Liber-Linteum_amd64.AppImage` (oldest glibc we support) |
   | Windows       | `Liber-Linteum_x64-setup.exe`, `Liber-Linteum_x64.msi`                    |
   | macOS         | `Liber-Linteum_universal.dmg` (Intel + Apple silicon, ad-hoc signed)      |

   It adds `The-Moons-of-Kessari.zip` and `Notion-Sample-Export.zip`, writes `SHA256SUMS`,
   uploads each file to VirusTotal when the repository secret `VT_API_KEY` is set (a free
   VirusTotal account's API key; without it the release just has no reports), and creates a
   **draft** release with notes listing the files, checksums and scans.
4. Review the draft on GitHub and **publish** it. Publishing triggers the website workflow,
   which reads the release and updates the download section.

Nothing is code-signed: Windows shows SmartScreen ("More info → Run anyway") and macOS asks
for right-click → Open the first time. Signing needs an Apple Developer ID and a Windows
certificate.

The scripts behind it are in `.github/scripts/`: `virustotal.py`, `release_notes.py`,
`release_json.py` (the website's `release.json`).

## 9. The website

`site/` is the showcase at **https://jorius.github.io/liber-linteum/**: plain HTML, CSS and
JavaScript modules, no build step, no third-party requests (strict CSP, self-hosted fonts),
English and Spanish (`site/js/i18n.js`).

- **Preview locally**: serve a folder that has `site` linked as `liber-linteum`, so paths match
  GitHub Pages:

  ```sh
  mkdir -p /tmp/preview && ln -sfn "$PWD/site" /tmp/preview/liber-linteum
  python3 -m http.server 8765 -d /tmp/preview   # http://127.0.0.1:8765/liber-linteum/
  ```

- **Settings without touching HTML**: `site/js/config.js` (repository, donation link, which
  clips exist).
- **Tests**: `pnpm --filter @liber/desktop exec playwright test -c ../../site/playwright.config.ts`
  (privacy, both languages, downloads with and without a release, the lightbox, layout and
  accessibility); format with `pnpm exec prettier --check site`.
- **Clips**: `site/media/<slug>.{webm,mp4,poster.webp}`, recorded from the real app by
  `site/tools/capture/` (see its README; Linux pipeline with Xvfb). Re-recording them on macOS
  is described in [`handoff/2026-10-22-macos-clips-handoff.md`](handoff/2026-10-22-macos-clips-handoff.md).
- **Deploy**: `.github/workflows/pages.yml` publishes `site/` on pushes to `main` that touch
  it, when a release is published, or by hand (Actions → Showcase site → Run workflow). It
  writes `release.json` from the latest published release (version, files, checksums,
  VirusTotal links); without one the page says "First release coming soon". The repository's
  **Settings → Pages → Source** must be **GitHub Actions**. The job skips while the repository
  is private (Pages needs a public repository on the free plan).

## 10. Conventions

- **Git**: branches are brought up to date with `git merge`, never rebased; history records
  what happened. Commit messages follow Conventional Commits (`feat(editor): …`,
  `fix(site): …`).
- **Formatting**: Prettier for TypeScript, CSS, HTML, JSON and Markdown; rustfmt for Rust.
- **Strings**: every user-facing string is in `en.json` and `es.json` (UI) or `site/js/i18n.js`
  (website); the parity checks fail otherwise.
- **No network code** anywhere in the app. If a feature seems to need one, it needs a design
  discussion first.
- **Docs**: a milestone gets a design spec in `docs/superpowers/specs/` and a hand-off in
  `docs/handoff/` (see [`README.md`](README.md)).

## 11. Known issues

- **Voice clips don't play on Linux**: WebKitGTK's media player refuses the app's
  `liber-asset://` scheme (`FormatError`), so players show `0:00 / 0:00`. Recording works, and
  the clips play on macOS and Windows. A fix (serving audio as a `blob:` URL) touches the
  security policy and is pending a decision.
- A page opened with the cursor on its first line shows its frontmatter as source in Live
  Preview.
- WebKit e2e tests need `playwright install webkit`, which some Linux distributions can't
  run; CI runs them on Ubuntu.
