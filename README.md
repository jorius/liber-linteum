# Liber Linteum

> Renamed from Notes In My Way on 2026-10-20. Existing vaults keep working: their `.nimw/` folder becomes `.liber/` the first time they open, and the app copies its settings from `app.notesinmyway.desktop`, which it never changes.
>
> Once Liber Linteum has opened a vault, stop using the old app on it. The old app would recreate its old settings folder, and Liber Linteum then keeps using its own and ignores whatever the old app wrote there (it warns when a vault has both).

Private, local-only notes. Plain Markdown files in folders you own, compatible
with Obsidian vaults, with a visual **Global View** of your projects, folders
and pages as cards. No cloud, no accounts, no telemetry; the app makes no
network requests.

> Status: **M0–M5b merged on `main`** (2026-10-18): vault, editor, covers and
> attachments, Global View, block moves, Scratchpad and single-file windows,
> search, Trash and Archive, Favorites. Batch 6 (`feat/batch6`, unmerged):
> text files in search, M6 audio clips (WAV), M7 Notion import. Next: M8
> packaging. Start at `docs/README.md`; `docs/product-spec.md` is the *what*,
> `docs/superpowers/specs/2026-10-12-architecture-design.md` the *how*.

## Prerequisites

- Node 24 (`.nvmrc`; `engines` allows ≥ 22.18, but the project is built and tested on 24) and pnpm 12 (`npm i -g pnpm@12.11.2`)
- Rust 1.99 (rustup picks it up from `rust-toolchain.toml`)
- Platform deps for Tauri 2:
  - macOS: Xcode Command Line Tools
  - Windows: Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 11)
  - Linux: `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

## Commands

| Command | What it does |
|---------|--------------|
| `pnpm install` | Install JS dependencies |
| `pnpm dev` | Run the desktop app with hot reload |
| `pnpm build` | Build installers for the current OS |
| `pnpm check` | Everything CI runs: lint, types, unit tests, i18n parity, UI build, e2e, rustfmt, clippy, cargo test. It also builds the UI (`build:ui`) because the Tauri crate embeds `apps/desktop/dist` |
| `pnpm test:e2e` | Playwright against the built UI with a mocked backend, in Chromium and WebKit (≈ WKWebView). First run: `pnpm --filter @liber/desktop exec playwright install chromium webkit`. `LIBER_E2E_PORT` (default 4317) lets several checkouts run it side by side |
| `cargo deny check` | License and banned-crate checks. Needs cargo-deny installed (`brew install cargo-deny` or `cargo install cargo-deny --locked`) |
| `cargo test --release -p liber-session --test search -- --ignored --nocapture` | The NFR-03 performance tests on a generated 10k-note vault (also `--test global_view`) |
| `LIBER_XCHECK_PY=<venv>/bin/python cargo test -p liber-vault --test encrypted_xcheck -- --nocapture` | An encrypted vault the app wrote, decrypted by the independent Python reader (`xcheck.py vault`). Needs a Python with `cryptography>=44` (`python3 -m venv <venv> && <venv>/bin/pip install 'cryptography>=44'`); without the variable it prints SKIP |
| `LIBER_PERF=1 cargo test --release -p liber-session --test encrypted_perf -- --nocapture` | Encrypted vaults: unlock to searchable on a sealed 10k-note vault, budget 3 s |

### Windows installer from macOS

The Windows test builds are cross-compiled with [cargo-xwin](https://github.com/rust-cross/cargo-xwin), using a toolchain kept apart in `~/.liber-cross`. A machine set up before the rename to Liber Linteum has it in `~/.nimw-cross` (rename note): rename that folder, or use that path in the exports below. The same exports run `cargo xwin check -p liber-desktop --tests --target x86_64-pc-windows-msvc`, the Windows compile check.

```sh
cd apps/desktop
export CARGO_HOME=$HOME/.liber-cross/cargo RUSTUP_HOME=$HOME/.liber-cross/rustup RUSTUP_TOOLCHAIN=1.99.0 XWIN_ACCEPT_LICENSE=1
export PATH="/opt/homebrew/opt/rustup/bin:$CARGO_HOME/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

The installer lands in `target/x86_64-pc-windows-msvc/release/bundle/nsis/` and is unsigned until M8.

## Layout

- `apps/desktop/src`: React UI (`features/*`, `ipc/` is the only backend gateway)
- `apps/desktop/src-tauri`: thin Tauri shell (commands, CSP, capabilities: `main.json` for the vault window, `file.json` for single-file windows)
- `crates/*`: Rust core, no Tauri dependency:
  - `liber-vault`: the file system (scan, watch, CAS writes, `.liber/`, Trash and Archive)
  - `liber-markdown`: parsing a page (title, frontmatter, tags, links, body text)
  - `liber-index`: the SQLite index and search (see `docs/architecture/index-and-database.md`)
  - `liber-session`: one open vault, composing the three above
  - `liber-audio`: microphone capture (`cpal`), WAV writing (`hound`), level meter (M6). On Linux, `cpal` needs ALSA headers: `sudo apt install libasound2-dev`
  - `liber-import`: the Notion Markdown & CSV importer: safe zip reading, names, links, databases (M7)
  - `liber-testkit`: fixtures and the generated test vaults
- `design/prototype`: clickable design reference (not shipped)

## Privacy guarantees

Network access is blocked by a strict CSP, a Tauri capability allowlist, an
ESLint ban on network APIs, and a cargo-deny ban on HTTP client crates.

## Third-party software

The Global View's canvas is built with [React Flow](https://reactflow.dev)
(`@xyflow/react` and `@xyflow/system`, MIT, © 2019-2025 webkid GmbH). The app
hides React Flow's on-canvas attribution badge, which the MIT licence allows,
and credits it here and on the welcome screen instead. Its licence text is in
`THIRD-PARTY-NOTICES.md`.

## License

GPL-3.0-or-later. See `LICENSE`.
