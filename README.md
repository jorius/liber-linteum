# Notes In My Way

Private, local-only notes. Plain Markdown files in folders you own, compatible
with Obsidian vaults, with a visual **Global View** of your projects, folders
and pages as cards. No cloud, no accounts, no telemetry; the app makes no
network requests.

> Status: **M0 scaffold**. See `docs/product-spec.md` (what) and
> `docs/superpowers/specs/2026-10-12-architecture-design.md` (how).

## Prerequisites

- Node ≥ 22.18 (24 LTS recommended) and pnpm 12 (`npm i -g pnpm@12.11.2`)
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
| `pnpm check` | Everything CI runs: lint, types, tests, i18n parity, UI build, rustfmt, clippy, cargo test. It also builds the UI (`build:ui`) because the Tauri crate embeds `apps/desktop/dist` |
| `cargo deny check` | License and banned-crate checks. Needs cargo-deny installed (`brew install cargo-deny` or `cargo install cargo-deny --locked`) |

## Layout

- `apps/desktop/src`: React UI (`features/*`, `ipc/` is the only backend gateway)
- `apps/desktop/src-tauri`: thin Tauri shell (commands, CSP, capabilities)
- `crates/*`: Rust core (vault, markdown, index, audio, import), no Tauri dependency
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
