# Capturing the showcase clips

`scenes.py` drives the real app (a release build) in a hidden Xvfb display and records the
clips and posters in `site/media/` (see `site/media/README.md` for the slots).

The app runs at 1152×720 at 2× (2304×1440 device pixels), light theme, English, the `saffron`
palette, on fresh copies of `examples/the-moons-of-kessari` in `/tmp/Vaults/`, with its own
config/cache dirs and its own D-Bus session: it never touches your settings or a running copy.
Nothing is recorded while a system file dialog is open (without a window manager they render
bare); those scenes are recorded in two parts or start after the dialog.

## Needs

- `Xvfb`, `ffmpeg` (libx264, libvpx-vp9, libwebp), `dbus-run-session`
- Python 3 with `python-xlib` and `Pillow` (a throwaway venv is fine)
- `cargo`/`pnpm`: `cd apps/desktop && pnpm tauri build --bundles deb` (the binary is
  `target/release/liber-desktop`; override with `LIBER_BINARY`)

## Run

```sh
python -m venv /tmp/capvenv && /tmp/capvenv/bin/pip install python-xlib pillow
cd site/tools/capture
/tmp/capvenv/bin/python scenes.py all         # or one: hero, sample-vault, global-view, editor,
                                              # search, obsidian, notion, encryption
/tmp/capvenv/bin/python scenes.py encode      # → site/media/<slug>.{webm,mp4,poster.webp}
```

Work files (lossless clips, review stills) go to `$CAPTURE_WORK` (default `/tmp/liber-capture`).
Then list the slugs in `videos` in `site/js/config.js`.

Coordinates are logical pixels of the 1152×720 window; a layout change can move a target.
`scenes.py` saves review stills to `<work>/shots/`; `sheet.py` puts several side by side.
The encryption scene encrypts a copy through the app's own dialog with a throwaway passphrase
and reads the recovery key from the clipboard; the two key groups it asks for are found by
watching the Done button's colour, since they are only drawn.
