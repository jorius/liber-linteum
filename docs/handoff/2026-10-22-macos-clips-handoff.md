# Hand-off: re-record the showcase clips on macOS (2026-10-22)

For a Claude Code session on Jose's Mac. **The job is only this:** record the 12 showcase
clips again from the macOS build and replace the files in `site/media/`. The site, the
storyboards, the sample vault and the app changes are done and committed on the branch; the
current clips were recorded on Linux and are complete, so every clip you replace is an
improvement, and any you can't do can stay as it is.

## Ground rules (Jose's, apply everywhere)

- **Never rebase**, never `git pull --rebase`, never force-push. Bring other branches in with
  `git merge`; merge commits are fine.
- Work on branch **`feat/custom-titlebar`** (or whatever Jose says is current). Commit when the
  clips are in; **don't push, tag or publish** unless Jose asks. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Don't touch Jose's own settings or vaults without putting them back (see "Isolation").
- Heavy jobs crashed earlier sessions: at most two background agents; never run a Rust build and
  Playwright at the same time.

## What the site expects

`site/media/README.md` lists the slots. For each slug: `<slug>.webm` (VP9), `<slug>.mp4`
(H.264, `+faststart`) and `<slug>.poster.webp`, no audio track, **2304×1440** (16:10),
light mode, English. Clips open large in a lightbox, so 10–35 s is fine; keep about 1.5 MB per
10 s of video and posters under ~150 KB (the hero poster under ~100 KB if you can).
`site/js/config.js` already lists all 12 slugs in `videos`; replacing files needs no code change.

| Slug | Storyboard (Linux reference: the function of the same name in `site/tools/capture/scenes.py`) |
|---|---|
| `hero` (~35 s) | Global View of the sample vault in Drill-down → switch to **Expand in place**, zoom the canvas a little, **See all** on *The Story*: its chapters appear beside it → back to **Drill-down**, click *World* (drill in) → on the *Kessari* card, the atoms button (**See atoms**) → zoom into the tree, click the **formula** atom: the page opens at it → a quick **Live Preview** edit at the end of "That is a **Closing**.": ` The Keepers call it ==the breath of the Well==.` (the highlight renders as you leave the line) |
| `obsidian` (~25 s) | Welcome screen; the camera **zooms in on "Open an Obsidian vault"** as the pointer reaches it (`EDITS` + `zoom.py` do the camera move) → the folder dialog (cut it, or keep it short) → the vault open as it is: a folder tree with no `.obsidian` in sight → *World › Places › The Salt Road*: zoom on the paragraph of `[[wikilinks]]` and the `![[map]]` embed, scroll to the table of links → Liber Linteum › **Settings… › This vault**: zoom on "Obsidian puts new attachments in attachments" and "Link format: Use Obsidian's setting (Shortest name)". The vault is a copy of the sample vault without `.liber/`, with `.obsidian/app.json` = `{"attachmentFolderPath": "attachments", "newLinkFormat": "shortest", "useMarkdownLinks": false}` (see `make_obsidian_vault`) |
| `notion` (~13 s) | File › Import from Notion… with `examples/notion-sample-export.zip`, vault name *Dela's Caravan Notes*, Import → open *Salt Road Ledger*: the database is a table whose links and dates work |
| `global-view` (~11 s) | Drill into *World*, then *Places*, back to *World* by the breadcrumb |
| `atoms` (~17 s) | Global View › *World* → *Kessari*'s **See atoms** → zoom into the tree (sections, paragraphs, the formula, the diagram, links to pages) → click the formula atom: the page opens there |
| `editor` (~11 s) | Chapter 01 in Live Preview: at the end of "…mending its selvedge." type ` She tied one more knot for ==the water owed==, as [[Moth` → pick *Mother Hesk* from the link menu → ` had taught her.` |
| `maths` (~16 s) | *Kessari*, sidebar hidden, **Split** view at the `$$ \begin{aligned}` formula: at the end of "That is a **Closing**." type ` A year holds $Y / S = 26$ of them.` (renders on the right as typed) → scroll to the Mermaid block, add a line `    Dusk -.-> Year(["26 Closings in a year"])`: the diagram gains a node |
| `drag-drop` (~21 s) | *Expedition Checklist* in Split view: drag "Tell anyone else" by its handle (in the rendered pane) into the "On the road" list, the Markdown follows → show the sidebar (Favorites folded), drag *Scratch - Loose Threads* onto *The Story* → Cmd+2, drag from *Screening Room*'s link handle to *Welcome*: "Relationship created." |
| `voice` (~20 s) | *Scratch - Loose Threads*, end of the page: type "Voice note, the night before the Closing:", the mic button (**Record clip**) → **Start recording** (5–6 s, the level meter moving) → **Stop & insert** → move off the line so the player shows → **press play and let it run a few seconds** (this is the part Linux couldn't show) |
| `search` (~11 s) | Cmd+Shift+F, type `camels`, click the `#place` tag chip, click *Cairn of Teeth*: the page opens **with "camels" selected and flashed** (new in this batch) |
| `encryption` (~45 s) | From a chapter: Vault › **Encrypt "The Moons of Kessari"…** → the warning → Continue → **Keep a readable copy?**: choose *Don't keep a copy* → passphrase twice → Continue → the **recovery key** (zoom on it) → Copy, I've saved it → type the two groups it asks for → Done → the summary → Open → Vault › Lock → unlock with the passphrase → the chapter again. Throwaway passphrase: `moons over the salt road` |
| `sample-vault` (~11 s) | Welcome screen → *The Moons of Kessari* from Recent → Cmd+2 → drill into *World* |

Posters: a representative frame, set in `POSTERS` (seconds into the finished clip). The hero
poster is the first thing the page shows: make it the Global View with covers.

## Isolation

The app's data lives in `~/Library/Application Support/app.liberlinteum.desktop/`
(`settings.json`, recent vaults, keys for encrypted vaults). Before recording:

1. Ask Jose to quit Liber Linteum, then move that folder aside
   (`mv … app.liberlinteum.desktop.jose`) and **put it back when done**.
2. Write a fresh `settings.json` there from `site/tools/capture/settings.json` (light, English,
   *saffron*, spell check off, attachment paths hidden) with `recentVaults` pointing at your
   copy of the sample vault (see `common.settings()`).
3. Use fresh copies of `examples/the-moons-of-kessari` for every scene (e.g. under
   `/tmp/Vaults/`), never Jose's `~/Vaults`. The encryption scene encrypts its copy.

## Recording on macOS (suggested approach)

The Linux driver (`cap.py`) uses Xvfb + XTest; on the Mac write a small `MacSession` with the
same methods (`start/stop/move/click/drag/scroll/key/type/record/shot/clipboard/pixel`) so
`scenes.py` runs with new coordinates:

- **Build**: `cd apps/desktop && pnpm tauri build --bundles app`, run
  `target/release/bundle/macos/Liber Linteum.app`.
- **Window**: 1152×720 points on a Retina screen gives 2304×1440 pixels. Size and place it
  with AppleScript (`System Events` → `set size of window 1 to {1152, 720}`, `set position…`);
  the terminal needs **Accessibility** permission.
- **Input**: `pyobjc-framework-Quartz` (`CGEventCreateMouseEvent`, `CGEventCreateScrollWheelEvent`,
  `CGEventCreateKeyboardEvent`/`CGEventKeyboardSetUnicodeString`) gives eased moves, drags,
  wheel and typing in one place. Shortcuts use **Cmd** where Linux used Ctrl (Cmd+2, Cmd+Shift+F,
  Cmd+, …; Go to line stays Ctrl+G).
- **Capture**: `ffmpeg -f avfoundation -capture_cursor 1 -framerate 30 -i "<screen>:none"`
  cropped to the window, lossless (`-c:v libx264rgb -crf 0 -preset ultrafast`), into the same
  `<work>/clips/<name>.mkv` names, so `scenes.py encode` (cuts, `zoom.py`, joins, encodes)
  works unchanged. The terminal needs **Screen Recording** permission.
- **Menus**: on macOS the menus are in the system menu bar, outside the window. Either use the
  shortcuts and the in-window buttons, or place the window just under the menu bar and crop a
  16:10 region that includes the menu bar's left part, so menu clicks are on camera. Pick one
  and use it for every clip.
- **File dialogs** (Obsidian, Notion): the native panel; Cmd+Shift+G, type the path, Return.
  Record them or cut them, as the Linux scenes do.
- **Microphone** (voice): simplest is to ask Jose to say a sentence while the scene records.
  Without him: a virtual device (BlackHole) as the input, with `site/tools/capture/fakemic.py`'s
  `voice_wav()` signal played into it. Mind the first-run microphone permission prompt (do it
  once before recording).
- **Recovery key groups**: on macOS read them from the dialog with a screenshot (or OCR via
  the Vision framework) instead of the Linux trial-and-error; type them on camera.

Check each clip by eye (a per-second strip: see `site/tools/capture/README.md`), then:

```sh
CAPTURE_WORK=… python scenes.py encode            # → site/media/
pnpm --filter @liber/desktop exec playwright test -c ../../site/playwright.config.ts --workers=2
pnpm exec prettier --check site
```

Serve `site/` and look at it (`python3 -m http.server 8765` in a folder with `site` linked as
`liber-linteum`, then http://127.0.0.1:8765/liber-linteum/), including the lightbox (click a
clip). Commit the media, plus any `scenes.py`/`cap.py` changes for the Mac, on the branch.

## Things to look at while you're in there

- Voice clips **play** on macOS? On Linux they don't (WebKitGTK refuses the `liber-asset://`
  scheme for media: `FormatError`), which is an open bug for Jose to decide on.
- Global View card titles: on Linux a two-line title's descenders may still be clipped; compare.
- Report anything else that looks wrong in the app instead of working around it silently.
