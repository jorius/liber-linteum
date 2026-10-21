# Building the Ubuntu .deb (hand-off, 2026-10-21)

Build Liber Linteum's `.deb` natively on an amd64 Ubuntu machine. A native build takes about 5–10 minutes the first time and 1–2 minutes after that. Building it on an Apple Silicon Mac means emulating x86 and takes 30–60 minutes, which is why it moved here.

The repository is private: `github.com/jorius/liber-linteum`. The branch to build is `main`.

## 1. Requirements

Ubuntu **22.04 or newer** (amd64). The app uses WebKitGTK 4.1, which 20.04 doesn't ship.

```sh
sudo apt update
sudo apt install -y build-essential curl wget file git pkg-config xz-utils patchelf \
  libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev libasound2-dev
```

`libasound2-dev` is for voice recording (ALSA). On Ubuntu 24.04 the runtime package is named `libasound2t64`; the `-dev` name above works on both.

**Rust**: the repo pins its toolchain (`rust-toolchain.toml`, 1.99.0); rustup installs it on first use.

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
```

**Node 24 and pnpm**: the repo pins Node 24 (`.nvmrc`) and pnpm 12 (`packageManager`). Corepack provides pnpm.

```sh
curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz \
  | sudo tar -xJ -C /usr/local --strip-components=1
sudo corepack enable
node --version   # v24.21.0
```

(With nvm instead: `nvm install 24 && corepack enable`.)

## 2. Get the code

The repo is private, so authenticate first: `gh auth login` (GitHub CLI), or an HTTPS personal access token, or an SSH key added to your account.

```sh
gh repo clone jorius/liber-linteum
# or: git clone git@github.com:jorius/liber-linteum.git
cd liber-linteum
```

## 3. Build

```sh
pnpm install --frozen-lockfile
cd apps/desktop
pnpm tauri build --bundles deb
```

The package lands in **`target/release/bundle/deb/`** at the repo root, named `Liber Linteum_0.1.0_amd64.deb` (Tauri keeps the product name's space).

To build an AppImage as well (it runs on most distros without installing): `pnpm tauri build --bundles deb,appimage`. It goes to `target/release/bundle/appimage/`.

## 4. Install and run

```sh
sudo apt install ./target/release/bundle/deb/Liber\ Linteum_0.1.0_amd64.deb
# then open "Liber Linteum" from the app grid; the command name is listed by:
dpkg -L liber-linteum | grep /usr/bin/
```

Uninstall: `sudo apt remove liber-linteum`. If either command says the package isn't found, `dpkg -l | grep -i liber` shows its exact name.

App data lives in `~/.config/app.liberlinteum.desktop/` (settings, rollback memory `vault-epochs.json`, install id) and `~/.cache/app.liberlinteum.desktop/` (plain vaults' search index). Delete both for a clean start.

## 5. What to test on Linux

The step-by-step encryption scripts are in `docs/handoff/2026-10-20-e4-handoff.md` §3 and `docs/handoff/2026-10-21-encrypt-in-place-ui-handoff.md`. Linux-specific points:

- **No screen-lock signal on Linux.** Encrypted vaults lock on idle, on sleep (a clock-jump check), on ⌥/Ctrl+Alt+L and on quit, but not when the screen locks. This is a documented residual (spec §16, E3).
- **The Trash.** Encrypting in place sends the readable originals to the freedesktop Trash (`~/.local/share/Trash`) as "<name> (unencrypted originals)". If the Trash refuses (some network or removable drives), the app keeps them hidden in the vault folder and shows a banner with "Move to Trash". Check both paths if you can.
- **Decrypted attachment copies** are written under `/tmp/liber-<pid>-<random>/` (mode 0700) and wiped on lock and quit. A crash leaves the folder until the next start's sweep.
- **Microphone**: recording uses ALSA through cpal. With PipeWire or PulseAudio the default device usually works; if not, pick the device in Settings.
- Use **throwaway vaults** for encryption tests, never your real notes. Pause any sync (Dropbox, Syncthing) on the folder while encrypting in place.

## 6. If the build fails

- `webkit2gtk-4.1 not found`: the distribution is older than 22.04, or the `-dev` package is missing.
- `alsa` / `asound` not found: install `libasound2-dev`.
- `pnpm: command not found`: run `corepack enable` (with sudo if Node is in `/usr/local`).
- Rust errors about an unknown toolchain: `rustup toolchain install` inside the repo.
- Out of memory while linking: release builds of the desktop crate need about 4 GB of RAM; close other apps, or add swap.
