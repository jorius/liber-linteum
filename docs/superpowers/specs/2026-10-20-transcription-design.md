# Local voice-note transcription: decision spec

Status: **for the maintainer's go / no-go** (2026-10-20). Nothing is built yet.

Facts, with sources for every claim: `docs/research/2026-10-20-transcription-facts.md`. Section numbers below like "facts §1" point there.

## 0. The question

The question: can a recorded or uploaded clip be transcribed to text without any third-party or cloud service?

**Yes.** Speech recognition can run entirely on the machine, with no account and no network at transcription time. This spec describes what it would take, what it costs, and what could go wrong, so the maintainer can decide whether to build it or drop it.

M6 deliberately left transcription out. This would be a new milestone, independent of encryption.

## 1. What the user would get

- **Every audio clip in a page gets a "Transcribe" action.** That covers clips recorded in the app, uploaded clips, and clips imported from Notion.
- **Progress and Cancel while it runs.** A one-minute clip takes seconds on Apple Silicon (§4).
- **The text is inserted under the clip** as ordinary Markdown, so it is searchable, editable and Obsidian-compatible:
  - a paragraph per segment;
  - optionally, small timestamps like `[01:23]`. Clicking one plays the clip from there (facts §7: segment times are available).
- **Language:** Auto, Spanish or English, chosen per clip. The last choice is remembered.
- **Encrypted vaults:** the transcript lives in the page, so it is encrypted like everything else. The audio never leaves the app.

## 2. Goals, non-goals and anti-goals

**Goals**
- Offline transcription of Spanish and English clips, with quality good enough for notes.
- macOS and Windows.

**Non-goals**
- Live dictation while recording. It could come later, but it is a different pipeline.
- Speaker labels (who said what).
- Translation.
- Summaries.

**Anti-goals**
- **Any network call made by the app on its own.** P1 still holds.
- **Invented text.** Whisper can hallucinate sentences during silence, in about 1% of transcripts (facts §4). We always run the built-in voice-activity filter and its "no speech" thresholds, and we never present the output as verbatim truth. The inserted block says "Transcribed automatically".
- **Freezing the app.** Transcription runs on a background thread, can be cancelled, and doesn't block editing.

## 3. Honest limits

- **Mixed Spanish and English in one sentence isn't handled well by any local option** (facts §4, §5). Whisper picks one language per 30-second window and may translate or drop the other. Clips that are mostly one language work well.
- **Quality depends on the model size the user picks.** Spanish word error rate on the FLEURS benchmark (facts §4):

  | Model | Word error rate | Verdict |
  |---|---|---|
  | tiny | ≈16% | too weak for Spanish |
  | base | ≈10% | too weak for Spanish |
  | small | ≈5.6% | good |
  | large-v3-turbo | ≈3% | excellent |

- **Windows will be CPU-only.** GPU builds (Vulkan or CUDA) can't realistically be cross-compiled from the Mac (facts §1), so transcription is slower there: several times real-time on a modern CPU, not the 50× of Apple Silicon.

## 4. Recommended engine: whisper.cpp through `whisper-rs`

- **Licences:** MIT (whisper.cpp) and Unlicense (whisper-rs), both on our allow-list (facts §1). The OpenAI Whisper weights are MIT.
- **Speed and features:**
  - fastest of the options, using Metal on Apple Silicon (facts §1);
  - built-in voice-activity detection (Silero, MIT, 885 KB);
  - abort and progress callbacks;
  - segment timestamps.
- **Windows cross-build (the main risk).** It is a plain CMake project, unlike LAME, and another Tauri app ships it to Windows from a Mac with cargo-xwin. That needs one workaround: an empty `ggml-blas.lib`, because whisper-rs-sys's build script checks the build machine instead of the target. That app's installer was never tested on real Windows. **So step 1 of any go decision is a throwaway spike:**
  1. Build whisper-rs for `x86_64-pc-windows-msvc` with our toolchain.
  2. Transcribe a real clip on the maintainer's Mac and time it.
  3. Have the Windows tester run the Windows test build.

  If the cross-build fails, the fallback is §5's plan B.
- **Audio prep:** our recorder writes at the device's native rate and channel count. Whisper needs 16 kHz mono, so clips are resampled with `rubato` (pure Rust, MIT OR Apache-2.0; facts §6).
- **Memory:** a model loads once and stays in memory while the app is open. About 0.85 GB for small, 2–2.5 GB for turbo (facts §7). It unloads after a few idle minutes.

## 5. Alternatives considered

| Option | Verdict |
|---|---|
| **Candle** (pure Rust, Hugging Face) | Easiest to build. But Whisper exists only as example code we'd copy and maintain, quantized weights only exist for tiny, and anecdotally it's slower. Second choice if whisper.cpp won't cross-build. |
| **sherpa-onnx + Parakeet-TDT v3** | Plan B for Windows: prebuilt libraries (no C compile), strong Spanish (3.45 FLEURS), word timestamps. The model is CC-BY-4.0 (needs an attribution notice) and 650 MB+. |
| **Apple SpeechAnalyzer** (macOS 26+) | On-device, with good Spanish locales. But macOS downloads its models from Apple, the API is Swift-only (needs a native shim), it's Mac-only, and it takes one locale per pass. Not recommended as the main engine. |
| **Windows built-in speech** | Its dictation is cloud-based and short-input only. Rejected. |
| **Vosk** | Stale Rust bindings, single-language models, weaker Spanish. Rejected. |

## 6. Where the model comes from (the policy decision)

Every engine needs a model file of 190 MB to 1+ GB that we don't ship. Three ways to get it:

1. **Import from disk (recommended, keeps P1 intact).**
   - Settings → Transcription lists the supported models (name, size, quality) with their official download page.
   - The user downloads a model in their browser and adds it with "Add model from disk…", the same way as spelling dictionaries.
   - The file is checked: its size, format and a known checksum for each official model.
   - It is then copied into the app's data folder.
2. **One-time, opt-in download inside the app.**
   - A clearly labelled button, which is the app's first and only network request.
   - It fetches the chosen model from Hugging Face and verifies its checksum.
   - It needs a P1 policy exception and an HTTP client crate, which deny.toml currently bans.
3. **Bundle a model in the installer.** small-q5 adds about 190 MB to every download, for every user, whether they transcribe or not.

**Recommendation:** option 1, with these two models listed:

| Model | Size | Use |
|---|---|---|
| small (q5_1) | 190 MB | good |
| large-v3-turbo (q5_0) | 574 MB | best |

## 7. Shape of the work, if it's a go

1. **Spike:** cross-build plus a speed check on the maintainer's Mac and on Windows. Throwaway, with a go/no-go on the engine.
2. **`liber-transcribe` crate:** loads the model, resamples, runs VAD, transcribes with progress and cancel, and returns segments.
3. **Model management:** Settings → Transcription. Add, remove and checksum models, and pick a default model and language.
4. **Editor action:**
   - a "Transcribe" action on clips;
   - progress and Cancel;
   - inserting the transcript, with or without timestamps;
   - clickable timestamps that seek the player.
5. **Tests:**
   - fixtures with short Spanish and English clips (license-clean, recorded by us);
   - snapshot tests on segments with a tiny model, run only when the model is present;
   - UI e2e tests against an IPC mock.

## 8. Decisions for the maintainer

1. **Go or drop?** If go, the spike runs first and decides the engine.
2. **Model delivery:** import from disk (recommended), an opt-in in-app download (a P1 exception), or bundled.
3. **Transcript format:** plain paragraphs, or paragraphs with clickable `[mm:ss]` timestamps (recommended).
