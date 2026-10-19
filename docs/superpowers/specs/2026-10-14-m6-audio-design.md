# M6 — Audio clips: Design

**Status:** written on 2026-10-14 without Jose's review. He asked to "carry on with everything that's missing" and review features in bulk later.
- **Grounding:** product spec §9.1 (AUD-01–AUD-07, Q-AUD-1, all DECIDED), architecture §5.1–§5.2 (cpal capture, hound WAV, LAME MP3, `audio:level` events, a custom player over `<audio>`), and the prototype's recorder bar (`design/prototype/Main.dc.html`: Record clip / Upload clip header buttons; a bar with Microphone select, Format WAV|MP3, Start recording → "● Recording 0:01", a level meter, **Stop & insert**, Cancel).
- **Builds on:** M5 (`feat/m5-search`).
- **Judgement calls** are listed in §9.

---

## 1. Goal and success criteria

1. **Record (AUD-01, AUD-02, AUD-07):**
   - **Record clip** in the page header opens the recorder bar. You choose the input device and the format; the format defaults to the global setting `recordingFormat` (`wav`), and a switch changes it for this take.
   - While recording, the bar shows the elapsed time and a live level meter.
   - **Stop & insert** saves the clip and embeds it; **Cancel** discards it, so nothing is written to the vault.
2. **Where clips go (AUD-04):**
   - the clip is saved in the page's attachments folder (M2c policy) as `clip-YYYYMMDD-HHMMSS.wav|mp3`, de-duplicated;
   - it is embedded as `![[…]]` **where the cursor was when recording started**, mapped through any edits made meanwhile, in one undoable transaction;
   - it goes into the page recording started on, even if you've switched pages since (M2c I1 lesson).
3. **Upload (AUD-03):** **Upload clip** opens a Rust-side file dialog filtered to WAV, MP3 and M4A, imports the file (M2c `import_attachment`; files already in the vault are linked) and embeds it at the cursor. Dropping audio files already works (M2c).
4. **Player (AUD-05, AUD-06):**
   - audio embeds in Live Preview, Split and the rendered pane show a custom player: play/pause, a seek slider, current time and duration;
   - only one clip plays at a time;
   - playback stops when the page is left, or the editor gives way to the Global View or another vault.
5. **Non-negotiables:**
   - no network;
   - the microphone is used only while you record, with no background capture;
   - every command async via `blocking()` with real-ACL tests;
   - i18n en + es; axe-clean; keyboard parity; Safari 15 floor.
   - **Automated tests never open a real microphone** (§7).

## 2. Recorder UI (`features/audio/RecorderBar.tsx`, `recorderStore.ts`)

- **The bar** sits under the page header, using the warn-tone tokens as the prototype does. It contains:
  - **Microphone:** a select listing `audio_devices()`, with the system default first, and remembered for the session;
  - **Format:** a WAV | MP3 segmented control;
  - **Start recording**, then **Recording 0:12** with a pulsing dot, a level meter, **Stop & insert** and **Cancel**.
- **The level meter:**
  - 16 bars driven by `audio:level` events (RMS and peak at about 20 Hz);
  - `aria-hidden`, with the state announced as text ("Recording, 12 seconds") every 10 s through a polite live region;
  - with reduced motion, a single bar with no animation.
- **Keyboard:** focus moves to Start recording when the bar opens, then to Stop & insert once recording. Escape cancels: while recording, it asks "Discard this recording?" (Discard / Keep recording).
- **Errors:**
  - **Microphone permission denied:** "Notes In My Way can't use the microphone. Allow it in System Settings → Privacy & Security → Microphone." The bar stays open with a Retry button.
  - **The device disappears mid-take:** the clip recorded so far is saved and inserted, with a toast.
- **Limits:** one recording at a time, app-wide. Record clip is disabled when the page isn't editable (binary or truncated).

## 3. Backend (`crates/nimw-audio`, `apps/desktop/src-tauri/src/audio_commands.rs`)

- **`nimw-audio` (no Tauri dependency):**
  - `trait CaptureSource { fn start(&mut self, on_frames) …; fn stop(); }`;
  - `CpalSource` (the real one) and `SyntheticSource` (tests: a sine wave or silence, deterministic);
  - `WavWriter` (hound, 16-bit PCM at the device rate, mono or stereo as the device);
  - `Mp3Writer` (LAME through `mp3lame-encoder`, 192 kbps CBR).
  - **Writes:** both write into a hidden part file `.clip-<ts>.part` in the target folder and `sync_all` when finished.
  - **Levels:** RMS and peak computed per 50 ms window.
- **Commands:**
  - `audio_devices() -> Vec<{ id, name, isDefault }>`;
  - `audio_start(page, device?, format) -> { recordingId }`:
    - validates the page (visible, indexed: the M2c m7 rule);
    - resolves the attachments folder;
    - starts capture on a dedicated thread;
    - emits `audio:level { recordingId, rms, peak, elapsedMs }` and refuses a second recording (`busy`);
  - `audio_stop(recordingId) -> { path, link }`:
    - finalizes the writer and renames the part file to `clip-YYYYMMDD-HHMMSS.<ext>` (local time; dedupe ` 1`, …; create-only);
    - reindexes the attachment and returns the shortest-unique link (M2c helpers);
  - `audio_cancel(recordingId)` stops and deletes the part file;
  - `audio_pick(page) -> Option<{ path, link }>`: a Rust-opened dialog (WAV/MP3/M4A), imported like `cover_pick`.
- **Permissions on macOS:**
  - `NSMicrophoneUsageDescription` goes in `Info.plist` (Tauri `bundle.macOS.infoPlist`), and the `com.apple.security.device.audio-input` entitlement in the app's entitlements file;
  - `tauri dev` inherits the terminal's permission;
  - a denial (cpal error) maps to `ErrorKind::Permission`.
- **Lifecycle:**
  - closing the vault or the window while recording runs through the quit guard (`mayClose`): the take is stopped, saved and inserted, then pages are flushed, so a recording is never silently lost;
  - part files left by a crash (`.clip-*.part`) are deleted on the next vault open, with an open warning naming them.

## 4. Player (`features/audio/AudioPlayer.tsx`)

- **Where it replaces the default player:** `renderHast`'s audio embed renders `<AudioPlayer src=asset-url title=name />` instead of `<audio controls>`.
- **Its parts:**
  - an `<audio preload="metadata">` element (the asset protocol already serves `Range`);
  - a play/pause button (`aria-pressed`, "Play <name>" / "Pause <name>");
  - a seek slider (`role="slider"` via `input type=range`, `aria-valuetext` "0:12 of 1:30");
  - time text.
- **Keyboard:** Space or Enter on the button toggles; ←/→ on the slider seeks 5 s; Home/End.
- **One at a time:** a module-level registry pauses the previous player when another starts. Unmounting pauses and releases (AUD-06), and so do page changes, ⌘2 and vault switches.
- **Missing or remote audio:** shows the existing placeholder, unchanged from M2a.

## 5. Settings

- **The field:** `recordingFormat: 'wav' | 'mp3'` (default `wav`), lenient per field (the M1 and M2b pattern).
- **Where you set it:** Settings → Editor → "Recording format".

## 6. Security and privacy

- **Microphone:** it is opened only between `audio_start` and stop or cancel. A capture thread that outlives its recording is a bug; tests assert the source is stopped.
- **Upload:** paths for uploads come only from the Rust-opened dialog (the M2c §8 rule).
- **Writes:** names are generated (clips) or sanitized (uploads), writes are create-only and atomic, and part files are hidden.

## 7. Testing

- **Never the real microphone.**
  - Automated tests and probes must not instantiate `CpalSource` or call cpal's device APIs that would trigger macOS TCC.
  - The Tauri state holds an injectable `AudioHost`: the real one in the app, a synthetic one in tests.
  - `audio_devices` in tests lists synthetic devices.
- **Rust:**
  - WAV header, length and sample rate from synthetic frames;
  - MP3 frames decodable (verify the first frame header and the approximate duration);
  - level computation;
  - start, stop, rename, dedupe and reindex;
  - cancel deletes the part file;
  - busy refusal;
  - crash leftovers cleaned on open;
  - real-ACL tests for all commands with the synthetic host.
- **TS:**
  - `recorderStore` (state machine: idle → ready → recording → saving; cancel; errors);
  - RecorderBar (axe, keyboard, Escape confirmation, live region, reduced motion);
  - insertion at the start cursor after edits, and into the original page after a switch;
  - AudioPlayer (axe, keyboard, one at a time, pause on unmount);
  - the settings field.
- **E2E (Chromium + WebKit, IPC mock with synthetic levels):**
  - record → Stop & insert puts `![[clip-…wav]]` at the cursor;
  - cancel inserts nothing;
  - upload through the mocked picker;
  - the player plays a fixture WAV served by the e2e server (play, pause, seek);
  - zero-network.
- **Real window (Jose):**
  - record with the built-in and an external microphone, in WAV and in MP3;
  - permission prompt and denial guidance;
  - unplugging a USB microphone mid-take;
  - quitting while recording;
  - playback of real clips;
  - Obsidian playing the embedded clips.

## 8. Out of scope

- Waveform display;
- trimming or editing clips;
- transcription;
- background or global recording shortcuts;
- input gain control;
- M4A recording (M4A is upload-only, per AUD-03).

## 9. Decisions taken for Jose (to review in bulk)

1. **The clip goes where the cursor was when recording started**, mapped through edits, into the page recording started on.
2. **Escape while recording asks before discarding.** Cancel discards without asking, because it's an explicit button.
3. **Closing or quitting mid-take saves and inserts the clip** rather than dropping it. Crash leftovers are cleaned on the next open, with a warning.
4. **The microphone choice is remembered for the session only.** The format default lives in Settings.
5. **Upload clip uses a Rust-opened dialog** (the same trust rule as covers). Drops of audio files keep working through M2c.
6. **The custom player replaces `<audio controls>` everywhere** an audio embed renders.
7. **The level meter is decorative for screen readers,** with periodic text announcements instead.
8. **MP3 through LAME** (`mp3lame-encoder`) as the architecture states. If the crate or its licence fails `cargo deny` or can't build offline, the plan records a ruling (the fallback is WAV-only with MP3 deferred), and the user is told.

## 10. Amendments (batch 6, 2026-10-18)

Jose confirmed the spec on 2026-10-18 ("Keep as written"). It predates M4b part 2/3, M4c, M5 and M5b; these rulings bring it up to date and override §1–§9 where they conflict.

1. **WAV only for now; MP3 is deferred.**
   - `mp3lame-encoder` (LGPL-3.0, LAME 3.100) builds on macOS, but its `mp3lame-sys` build runs LAME's autotools `configure`, which can't target MSVC from the Mac. Windows builds are cross-compiled with cargo-xwin. Three tries failed: as is ("cannot run C compiled programs"), with `MP3LAME_SYS_OVERRIDE_HOST=x86_64-w64-mingw32` ("/lib/cpp fails sanity check"), and with `CPP="clang-cl -E"`.
   - Shipping MP3 on two systems out of three breaks the "all desktop OSes ship together" rule.
   - So: no MP3 encoder dependency, no WAV|MP3 toggle and no `recordingFormat` setting yet, since there is nothing to choose. `RecordingFormat` stays in `nimw-audio` for when MP3 returns.
   - **The way back:** a pure-Rust encoder, or building LAME's C files with `cc` and its `configMS.h`, as `mp3lame-sys` already does on a Windows host.
2. **Where the controls go:**
   - **Record clip:** a microphone button in the page header controls, beside Format. The top bar is gone (M5b §2.3), and the formatting toolbar is optional.
   - **The recorder bar:** opens under the header band. It holds the microphone select, Start recording, then the timer, the level meter, **Stop & insert** and **Cancel**, plus **Upload clip…**.
   - The floating action button stays screen-level (Search, Global View, Edit).
3. **No schema bump.** The index already sets `hasAudio` for pages that embed audio (M5), and search's SHOW row has its Audio chip. An inserted clip sets both once the page is saved and re-indexed.
4. **Read-only pages can't record.**
   - The button is hidden on archived pages, on text files and in single-file windows.
   - `audio_record_start` and `audio_pick` refuse `.archive/` pages (`not_archived`).
   - All audio commands are main-window only; `capabilities/file.json` doesn't list them.
5. **With Auto save off,** the inserted embed only makes the page unsaved; it isn't written. The clip itself is an attachment and is written when you stop. If you then choose Don't Save, the clip stays in the attachments folder, unlinked.
6. **Where clips go.**
   - A take is written to the app's cache folder (`<cache>/audio/clip-YYYYMMDD-HHMMSS.wav`), never into the vault while recording.
   - Stop imports it with `import_attachment`, which brings the vault's attachment folder rule, de-duplication (` 1`) and re-indexing. The temporary file is then removed.
   - This replaces §3's hidden `.clip-*.part` files in the target folder. Nothing half-written ever sits in the vault, and leftovers from a crash are cleared from the cache when the next recording starts.
   - **The name:** the page proposes it in local time (`clip-YYYYMMDD-HHMMSS`), as pasted images are named. Rust accepts only that exact shape.
   - Clips are ordinary attachments for the Trash and Archive.
7. **Quitting or closing the vault while recording** stops the take and inserts it before pages are saved (the M2a quit guard runs the recorder first).
8. **The microphone on macOS:**
   - `NSMicrophoneUsageDescription` is in `src-tauri/Info.plist`, which Tauri merges into the bundle. The audio-input entitlement waits for the hardened runtime and signing in M8.
   - A denied microphone gives silence on macOS, not an error. So the bar says so after 3 s of exact digital silence: "No sound is reaching the app. If you denied microphone access, allow it in System Settings → Privacy & Security → Microphone."
   - cpal's `PermissionDenied` maps to `notPermitted` with the same guidance.
9. **A microphone that disconnects mid-take** ends the capture. The bar says "The microphone was disconnected", and **Stop & insert** keeps what was recorded.
10. **Building per system:**
    - **Windows:** cpal (WASAPI) and hound pass `cargo xwin` for `x86_64-pc-windows-msvc`.
    - **Linux:** cpal needs the ALSA headers (`libasound2-dev`) to build. This is noted for CI and M8.
    - **Licences:** cpal Apache-2.0, hound Apache-2.0.
11. **The player** (§4) replaces `<audio controls>` for `![[…]]` audio embeds and for audio files outside the vault (M4b part 3). Raw HTML `<audio>` written in a note keeps the browser's player.
12. **Microphone choice** is remembered for the app session (§9.4, unchanged).
