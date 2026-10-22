# Capturing the showcase clips

`scenes.py` drives the real app (a release build) in a hidden Xvfb display and records the
clips and posters in `site/media/` (see `site/media/README.md` for the slots). This is the
**Linux** pipeline; recording on macOS is described in
`docs/handoff/2026-10-22-macos-clips-handoff.md`, with each scene's storyboard.

The app runs at 1152×720 at 2× (2304×1440 device pixels), light theme, English, the `saffron`
palette, on fresh copies of `examples/the-moons-of-kessari` in `/tmp/Vaults/`, with its own
config/cache dirs and its own D-Bus session: it never touches your settings or a running copy.
Nothing is recorded while a system file dialog is open (without a window manager they render
bare); those scenes are recorded in parts.

## Needs

- `Xvfb`, `ffmpeg` (libx264, libvpx-vp9, libwebp), `dbus-run-session`
- Python 3 with `python-xlib` and `Pillow` (a throwaway venv is fine)
- For the voice scene: PipeWire (`pw-cli`, `pw-loopback`, `pw-cat`, `pw-link`) and its ALSA
  plugin. `fakemic.py` adds a virtual microphone fed with a synthetic, speech-like signal and a
  silent sink for playback, only while the scene runs; your real microphone and speakers are
  never used.
- `cargo`/`pnpm`: `cd apps/desktop && pnpm tauri build --bundles deb` (the binary is
  `target/release/liber-desktop`; override with `LIBER_BINARY`)

## Run

```sh
python -m venv /tmp/capvenv && /tmp/capvenv/bin/pip install python-xlib pillow
cd site/tools/capture
export CAPTURE_WORK=~/.cache/liber-capture   # on disk: lossless clips are large, /tmp may be RAM
/tmp/capvenv/bin/python scenes.py all            # or some: hero obsidian notion global-view atoms
                                                 # editor maths drag-drop voice search encryption
                                                 # sample-vault
/tmp/capvenv/bin/python scenes.py encode         # or: encode hero atoms
```

`encode` cuts each recording as `EDITS` in `scenes.py` says (several parts for scenes that
leave something out: a file dialog, guessing the key groups, most of a wait), applies its
camera zooms with `zoom.py`, joins the parts and writes `site/media/<slug>.{webm,mp4,poster.webp}`.
Then list the slugs in `videos` in `site/js/config.js`.

Coordinates are logical pixels of the 1152×720 window; a layout change can move a target.
`scenes.py` saves review stills to `<work>/shots/`; `sheet.py` puts several side by side. A
per-second strip of a recording helps to place cuts and zooms:

```sh
ffmpeg -i <work>/clips/obsidian-c.mkv -vf "fps=1,scale=384:-1,drawtext=text='%{pts\:hms}':fontsize=20:fontcolor=red,tile=6x3" -frames:v 1 strip.png
```

The encryption scene encrypts a copy through the app's own dialog with a throwaway passphrase
and reads the recovery key from the clipboard; the two key groups it asks for are found by
watching the Done button's colour (they are only drawn), with the recording paused, then typed
again on camera.

Known on Linux: WebKitGTK won't play audio from the app's `liber-asset://` scheme, so the voice
clip shows the recording and the inserted player but not playback.
