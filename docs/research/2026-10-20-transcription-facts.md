# Local speech-to-text: fact sheet for Liber Linteum

Researched 2026-10-20. Versions come from the crates.io API, the GitHub API and the Hugging Face API, queried that day.
Where a number comes from a secondary source, the entry says so. "Local probe" means a Swift script run on this Mac (macOS 27.0.1).

---

## 1. whisper.cpp and `whisper-rs`

**Versions and licences**
- whisper.cpp **v1.9.5** (released 2026-10-06), MIT. Sources: https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5 and https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE
- `whisper-rs` **0.16.0** (2026-03-12), **Unlicense**. Repo moved to Codeberg. Sources: https://crates.io/crates/whisper-rs and https://codeberg.org/tazz4843/whisper-rs
- `whisper-rs-sys` **0.15.0**, Unlicense. It vendors whisper.cpp at commit `2eeeba5`, which is the **v1.8.3** tag (2026-01-15). That is about six minor releases behind upstream. Sources: https://crates.io/crates/whisper-rs-sys and https://github.com/ggml-org/whisper.cpp/releases/tag/v1.8.3
- Both licences are on our allow-list. ggml is MIT.

**Build system**
- `whisper-rs-sys` builds whisper.cpp with the `cmake` crate. Its build dependencies are cmake, bindgen (needs libclang), cc, fs_extra and semver. Source: https://codeberg.org/tazz4843/whisper-rs/src/branch/master/sys/build.rs
- Bindgen can be skipped with `WHISPER_DONT_GENERATE_BINDINGS=1`, which uses the pre-generated bindings. Source: https://codeberg.org/tazz4843/whisper-rs/src/branch/master/README.md
- On macOS, BUILDING.md requires `brew install cmake`. Source: https://codeberg.org/tazz4843/whisper-rs/src/branch/master/BUILDING.md
- Cargo features: `metal`, `coreml`, `vulkan`, `cuda`, `hipblas`, `openblas`, `intel-sycl`, `openmp`, `log_backend`, `tracing_backend` and `raw-api`. Source: https://crates.io/crates/whisper-rs/0.16.0/features
- `build.rs` forwards any `WHISPER_*`, `GGML_*` or `CMAKE_*` environment variable to CMake, so ggml options can be set without forking (build.rs lines 278-290).

**Backends**
- **macOS**
  - Metal: the whole model runs on the GPU. Accelerate BLAS is linked on Apple targets.
  - Core ML: runs the encoder on the ANE, ">x3 faster" than CPU-only. The `.mlmodelc` encoder is a separate download, for example `ggml-large-v3-turbo-encoder.mlmodelc.zip` (1.17 GB) or `ggml-small-encoder.mlmodelc.zip` (163 MB).
  - Core ML's first run on a device is slow because the ANE compiles the model.
  - Sources: https://github.com/ggml-org/whisper.cpp#core-ml-support and https://huggingface.co/ggerganov/whisper.cpp/tree/main
- **Windows**
  - CPU (AVX/AVX2), Vulkan (needs the Vulkan SDK; links `vulkan-1`), CUDA (needs `CUDA_PATH`) and OpenVINO.
  - Upstream builds and tests on MSVC and MinGW.
  - Sources: https://github.com/ggml-org/whisper.cpp#vulkan-gpu-support and https://github.com/ggml-org/whisper.cpp/blob/master/.github/workflows/build.yml

**Cross-compiling to `x86_64-pc-windows-msvc` from macOS with cargo-xwin**
- cargo-xwin **0.23.1** writes a CMake toolchain file for crates that use the `cmake` crate. **ninja is required.** Source: https://github.com/rust-cross/cargo-xwin#cmake-support
  - This is different from LAME, which is not a CMake project. whisper.cpp is a plain CMake project, which is the path cargo-xwin supports.
- **Real-world evidence: it works, with one workaround.** The Tauri dictation app `dyktando-x` ships whisper-rs 0.16 (through `transcribe-rs`) and builds its Windows NSIS installer with `tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc` from a Mac.
  - Workaround: `could not find native static library ggml-blas`. whisper-rs-sys decides to link BLAS from the **host** OS (macOS). Their release script puts an empty `ggml-blas.lib` on the link path.
  - Their PR says the build was "not run on a real Windows machine". Its exe imports exactly the same DLL set as the installer built by GitHub Actions.
  - Sources: https://github.com/jash90/dyktando-x/pull/9 and https://github.com/jash90/dyktando-x/blob/main/RELEASING.md
- **Root cause, confirmed in `build.rs`.** Several checks use `cfg!(target_os = ...)` / `cfg!(windows)` inside a build script. These evaluate the **host**, not the target:
  - `cfg!(target_os = "macos")` adds `ggml-blas`, which is the bug above.
  - `cfg!(target_os = "windows")` adds `/utf-8` and `advapi32`. Both are **skipped** when cross-compiling.
  - The Vulkan branch picks `vulkan` instead of `vulkan-1`.
  - Linking the C++ stdlib and Accelerate correctly uses `env TARGET`.
  - Workarounds: an empty `ggml-blas.lib`, plus `-l advapi32` in rustflags if a link fails, plus `CMAKE_CXX_FLAGS=/utf-8` through the env passthrough.
  - Source: https://codeberg.org/tazz4843/whisper-rs/src/branch/master/sys/build.rs
- ggml turns `GGML_NATIVE` OFF when `CMAKE_CROSSCOMPILING`, so SSE4.2, AVX, AVX2, BMI2, F16C and FMA default ON. The binary needs a Haswell-or-newer CPU, which is portable enough. Source: https://github.com/ggml-org/whisper.cpp/blob/v1.8.3/ggml/CMakeLists.txt (lines 102-106, 138+)
- Cross-building with Vulkan would also need the Windows Vulkan import lib and `glslc` on the Mac, plus the host-cfg bug above. CUDA from macOS is not realistic. **Plan for a CPU-only Windows build.**
- Prior art: Handy, a Tauri app under MIT with about 34k stars, does offline STT with whisper.cpp and Parakeet V3 on Windows, macOS and Linux. Its crate `transcribe-rs` 0.3.12 (MIT) wraps whisper-rs, ONNX and Silero VAD. Sources: https://github.com/cjpais/Handy and https://crates.io/crates/transcribe-rs

**Speed on Apple Silicon**
- The official bench table (`whisper-bench`, Metal, flash attention off) gives encoder time per 30 s window in ms, then decoder time per token in ms. Source: https://huggingface.co/spaces/Xenobd/whisper.cpp/commit/d4f72cd38997a79451851f0eac3ac336fb83338e (mirror of the upstream "bench : update benches" commit, 2025-06-25). Units come from https://github.com/ggml-org/whisper.cpp/blob/master/scripts/bench-all.sh

  | Chip | Model | Enc ms / 30 s | Dec ms / token |
  |---|---|---|---|
  | M2 Ultra | tiny | 10 | 1.2 |
  | M2 Ultra | base | 16 | 1.7 |
  | M2 Ultra | small | 45 | 3.5 |
  | M2 Ultra | medium | 123 | 7.4 |
  | M2 Ultra | large-v3-turbo | 202 | 1.8 |
  | M4 Max | tiny | 13 | 0.9 |
  | M4 Max | base | 24 | 1.4 |
  | M4 Max | small | 72 | 3.0 |
  | M4 Max | medium | 209 | 7.0 |
  | M4 Max | large-v3-turbo | 346 | 2.0 |

- My estimate, not a published figure: a 30 s window is about 100-150 tokens, so on these GPUs turbo comes to roughly 0.4-0.6 s per 30 s, about **50-75x real-time**. Base M-series chips have 8-10 GPU cores against 40-76 here, so expect several times slower. That is still well faster than real time for small and turbo.
- M1 Pro on CPU (NEON+BLAS, 2023): large encoder **3.35 s** per 30 s window, medium 1.93 s. Source: https://github.com/ggml-org/whisper.cpp/pull/566
- Third-party test on an M4 MacBook Pro: whisper.cpp large-v3-turbo-q5_0 with Core ML took 1.23 s on a short clip, against 1.02 s for mlx-whisper and 0.19 s for Parakeet on Core ML. Clip length not stated. Source: https://github.com/anvanvan/mac-whisper-speedtest
- **Measure on our own hardware.** No primary source gives an end-to-end RTF on base M1/M2/M3 chips.

**Audio input**
- `WHISPER_SAMPLE_RATE 16000`. `whisper_full()` takes **f32 mono PCM at 16 kHz**. Source: https://github.com/ggml-org/whisper.cpp/blob/master/include/whisper.h
- whisper-rs adds helpers: `convert_integer_to_float_audio` (i16 to f32) and `convert_stereo_to_mono_audio`. There is **no resampler**. Source: https://codeberg.org/tazz4843/whisper-rs/src/branch/master/src/utilities.rs
- Our recorder writes at the cpal device rate and channel count (`crates/liber-audio/src/cpal_host.rs:118`), usually 44.1 or 48 kHz. We therefore need i16→f32, a downmix and a **resample to 16 kHz** (section 6).

**Implication for us:** this is the most mature path. Metal works on Mac. A cargo-xwin cross-build is proven by another Tauri app, with a documented one-line hack. Windows would be CPU-only. We do take on cmake, ninja, libclang, a C++ toolchain and an `-sys` crate that lags upstream.

---

## 2. Candle (`candle-core`, `candle-transformers`)

**Versions and licences**
- `candle-core`, `candle-nn` and `candle-transformers` are all **0.11.0** (2026-06-26), licensed **MIT OR Apache-2.0**. Source: https://crates.io/crates/candle-core

**Pure Rust or not**
- The CPU path is Rust: `gemm`, `safetensors`, `half`, `rayon`, `memmap2`.
- Features: `metal` (objc2-metal plus `candle-metal-kernels`), `accelerate` (links Apple's Accelerate via `accelerate-src`), `mkl`, `cuda` and `cudnn`. Source: https://crates.io/crates/candle-core/0.11.0/dependencies
- **One C dependency in 0.11.0.** `candle-core` 0.11.0 depends on `tokenizers` with `default-features=false, features=["onig"]`. That pulls `onig_sys`, which builds C through the `cc` crate (not cmake).
  - On `main`, this has already changed to `features=["fancy-regex"]`, which is pure Rust.
  - Sources: https://crates.io/crates/candle-core/0.11.0/dependencies, https://github.com/huggingface/candle/blob/main/candle-core/Cargo.toml and https://crates.io/crates/onig_sys
  - `cc` crates work under cargo-xwin with clang-cl. So a CPU-only Windows cross-build should need **no cmake and no MSVC**. I did not try it.
- Whisper in candle is example code (`candle-examples/examples/whisper/main.rs`, about 700 lines), not a library API. We would copy the decode loop, mel filters and timestamp rules into our own code. Source: https://github.com/huggingface/candle/tree/main/candle-examples/examples/whisper

**Checkpoints**
- The example loads `openai/whisper-{tiny,base,small,medium,large,large-v2,large-v3,large-v3-turbo}` and `distil-whisper/*` as `model.safetensors` plus `tokenizer.json` and `config.json`. Source: https://github.com/huggingface/candle/blob/main/candle-examples/examples/whisper/main.rs (lines 573-587)
- **Quantized GGUF:** the code supports it (`quantized_model::Whisper`), but the published quantized weights are **tiny / tiny.en only**. Files are `lmz/candle-whisper` `model-tiny-q80.gguf` (41.8 MB) and `model-tiny-q40.gguf` (23.3 MB). Any other size hits `unimplemented!("no quantized support")`.
  - Candle uses its own GGUF; the whisper.cpp GGML `.bin` files are not interchangeable.
  - Sources: main.rs lines 691-701 and https://huggingface.co/lmz/candle-whisper/tree/main

**Speed against whisper.cpp**
- No primary benchmark exists. The only evidence is anecdotal: candle issue #1048 (2023, Pixel 7) shows q80 candle at about 15 s against about 3 s for whisper.cpp, falling to about 4.5 s with `CANDLE_DEQUANTIZE_ALL=1`. Source: https://github.com/huggingface/candle/issues/1048
- Expect slower than whisper.cpp, and measure if it matters.

**Implication for us:** this is the cleanest licence and build story: Rust only, MIT/Apache, no cmake, and Metal on Mac. But we would own and maintain a Whisper decoder. VAD, long-form seeking, suppression and hallucination guards would be ours to build. Speed is unproven and probably below whisper.cpp.

---

## 3. Other embeddable options

**`ort` (ONNX Runtime bindings)**
- Version **2.0.0-rc.15** (2026-10-19), still pre-1.0. Licensed MIT OR Apache-2.0. ONNX Runtime itself is MIT, v1.31.0.
- The ONNX Runtime library is C++. `ort` downloads prebuilt binaries (`download-binaries` feature) or loads a DLL at runtime (`load-dynamic`).
- Alternative pure-Rust backends exist (`ort-tract`, `ort-candle`).
- Sources: https://crates.io/crates/ort, https://ort.pyke.io/setup/linking and https://github.com/microsoft/onnxruntime/releases
- **Verdict:** usable as a runtime for Parakeet or Whisper ONNX, but it adds a C++ runtime of about 10-20 MB and a pre-1.0 API.

**sherpa-onnx (k2-fsa)**
- Official Rust crate `sherpa-onnx` **1.13.8**, Apache-2.0.
- Its `-sys` build script **downloads prebuilt static libraries at build time**, then picks them by `CARGO_CFG_TARGET_OS`. Cross-compiling from a Mac fetches the Windows `.lib` directly, with no C compile.
  - The Windows static archive is `win-x64-static-MT-Release`, 123 MB compressed.
  - It is built with **/MT** (static CRT). Rust MSVC defaults to /MD, so we would likely need `+crt-static`. I have not verified this.
  - Sources: https://crates.io/crates/sherpa-onnx, https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/rust/sherpa-onnx-sys/build.rs and https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8
- It runs Whisper (ONNX), **NVIDIA Parakeet-TDT-0.6b-v3** (25 European languages including es and en, automatic language ID, word and segment timestamps) and Silero VAD.
- Parakeet v3 Spanish WER: FLEURS 3.45, MLS 4.39, CoVoST2 3.41. Sources: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 and https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
  - The **licence is CC-BY-4.0**, which requires attribution. `deny.toml` does not cover model files, but we would need a NOTICE.
  - The int8 encoder is 652 MB; the full `.nemo` is 2.5 GB.
- **Verdict:** the strongest alternative to whisper.cpp. Cross-building looks easy, Parakeet is fast and accurate for es/en, but the model needs CC-BY attribution and the libraries are big.

**Vosk (Kaldi)**
- `vosk` crate **0.3.1** (2024-10-27, stale), MIT. It needs the prebuilt `libvosk` shared library from alphacep. The API is Apache-2.0. Sources: https://crates.io/crates/vosk and https://github.com/alphacep/vosk-api
- Models, all Apache-2.0 (source: https://alphacephei.com/vosk/models):

  | Model | Size | WER |
  |---|---|---|
  | `vosk-model-small-es-0.42` | 39 MB | CV 16.0, MLS 11.2 |
  | `vosk-model-es-0.42` | 1.4 GB | CV 7.5, MLS 5.8 |
  | `vosk-model-small-en-us-0.15` | 40 MB | LibriSpeech clean 9.85 |

  - One language per model, so **no code-switching**.
- **Verdict:** tiny and streaming-friendly, but accuracy is clearly below Whisper or Parakeet, and the Rust binding is stale. Skip.

**Implication for us:** keep sherpa-onnx with Parakeet v3 as plan B, or as a second engine. The others are not worth it.

---

## 4. Whisper model weights

**Licence**
- The openai/whisper repo says: "Whisper's code and model weights are released under the MIT License." Source: https://github.com/openai/whisper#license
- The Hugging Face model-card metadata differs:
  - `openai/whisper-large-v3-turbo` is `mit`.
  - `openai/whisper-{tiny..large-v3}` are tagged `apache-2.0`.
  - Either is on our allow-list. Sources: https://huggingface.co/openai/whisper-large-v3 and https://huggingface.co/openai/whisper-large-v3-turbo
- The GGML conversions in `ggerganov/whisper.cpp` are tagged `mit`.

**Sizes in bytes, from the HF API**
- GGML: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>
- Safetensors: https://huggingface.co/openai/whisper-<m>/resolve/main/model.safetensors

| Model | GGML f16 `.bin` | q8_0 | q5 | safetensors (candle) |
|---|---|---|---|---|
| tiny (39M) | 77,691,713 | 43,537,433 | 32,152,673 (q5_1) | 151,061,672 (fp32) |
| base (74M) | 147,951,465 | 81,768,585 | 59,707,625 (q5_1) | 290,403,936 (fp32) |
| small (244M) | 487,601,967 | 264,464,607 | 190,085,487 (q5_1) | 966,995,080 (fp32) |
| medium (769M) | 1,533,763,059 | 823,369,779 | 539,212,467 (q5_0) | 3,055,544,304 (fp32) |
| large-v3 (1550M) | 3,095,033,483 | — (not published) | 1,081,140,203 (q5_0) | 3,087,130,976 (fp16) |
| large-v3-turbo (809M) | 1,624,555,275 | 874,188,075 | 574,041,195 (q5_0) | 1,617,824,864 (fp16) |

- GGML file names follow the pattern `ggml-<m>.bin`, `ggml-<m>-q8_0.bin` and `ggml-<m>-q5_0.bin` / `-q5_1.bin`.
- Example URL: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
- Candle's quantized GGUF exists only for tiny (section 2).
- The Silero VAD for whisper.cpp is `ggml-silero-v6.2.0.bin` (885 KB, MIT), at https://huggingface.co/ggml-org/whisper-vad

**Spanish quality**
- Whisper paper, Appendix D.2, WER %, large-v2 and earlier. Source: https://arxiv.org/abs/2212.04356 (Tables 10, 11 and 13):

  | Size | FLEURS es | CommonVoice9 es | MLS es | (FLEURS en) |
  |---|---|---|---|---|
  | tiny | 15.9 | 30.3 | 19.2 | 12.4 |
  | base | 9.9 | 19.6 | 12.8 | 8.9 |
  | small | 5.6 | 10.3 | 7.8 | 6.1 |
  | medium | 3.6 | 6.9 | 5.3 | 4.4 |
  | large-v2 | 3.0 | 5.6 | 4.2 | 4.2 |

- large-v3: "10% to 20% reduction of errors compared to large-v2". Source: https://huggingface.co/openai/whisper-large-v3
  - The Voxtral paper reports 2.81 FLEURS-es for large-v3. This comes from a search snippet that I did not re-verify. Source: https://arxiv.org/abs/2507.13264
- turbo: performs "similarly to large-v2" across languages. The larger losses are on Thai and Cantonese, not Spanish. It is **not trained for translation**. Sources: https://github.com/openai/whisper/discussions/2363 and https://github.com/openai/whisper#available-models-and-languages
- Spanish is one of Whisper's strongest languages. **small and up are usable; tiny and base are weak.**

**Code-switching (es/en mixed)**
- Language is detected once, from the first 30 s, unless it is set. Source: https://github.com/openai/whisper/discussions/1456
- A maintainer says code-switching works only "sometimes", where training data happened to contain it. The workaround is to split the audio by language. Sources: https://github.com/openai/whisper/discussions/2285 and https://github.com/openai/whisper/discussions/49
- Failure mode: the minority language gets **translated** into the dominant one, or dropped. Source: https://github.com/openai/whisper/discussions/2009
  - Vendor docs also describe the "re-detect per 30 s block" mode and how short switches fold into the dominant language. Source: https://docs.cloud.phonexia.com/products/speech-platform-4/3.2.0/technologies/speech-to-text/enhanced-speech-to-text-built-on-whisper/overview
- Parakeet v3 auto-detects language, but it is also not marketed for intra-sentence switching.
- **No local option handles es/en code-switching reliably.** Expect larger models (medium, turbo, large) to cope better.

**Hallucination and mitigations**
- About **1%** of Whisper transcripts contain whole invented sentences, concentrated in **long non-speech stretches**. Source: https://arxiv.org/abs/2402.08021 (Careless Whisper, FAccT 2024)
- The model card warns of hallucination and repetition loops. Source: https://huggingface.co/openai/whisper-large-v3
- Mitigations that whisper.cpp exposes, all reachable from whisper-rs `FullParams`:
  - Built-in **Silero VAD** (`vad`, `vad_model_path`, threshold, min-speech/min-silence ms, padding). Segment times map back to the original timeline.
  - `no_speech_thold`.
  - `entropy_thold`, equivalent to OpenAI's compression-ratio check.
  - `suppress_nst` and `suppress_blank`.
  - Temperature fallback.
  - Turning off conditioning on previous text: `no_context` in whisper.cpp.
  - Sources: https://github.com/ggml-org/whisper.cpp#voice-activity-detection-vad, https://github.com/ggml-org/whisper.cpp/blob/master/include/whisper.h and https://codeberg.org/tazz4843/whisper-rs/src/branch/master/src/whisper_params.rs
- OpenAI's reference defaults: `no_speech_threshold=0.6`, `compression_ratio_threshold=2.4`, `logprob_threshold=-1.0`, plus `hallucination_silence_threshold`. Source: https://github.com/openai/whisper/blob/main/whisper/transcribe.py

**Implication for us:** ship **small** (q5_1, 190 MB) as the default and **large-v3-turbo q5_0** (574 MB) as the "accurate" option. Download weights on demand only after the user explicitly opts in, because the download is a network request that needs policy carve-out or a manual import. Always enable VAD. Treat mixed es/en as best-effort.

---

## 5. OS built-in on-device recognition

**macOS**
- **`SFSpeechRecognizer`** (macOS 10.15+)
  - `requiresOnDeviceRecognition = true` keeps audio on the device. It is honoured only when `supportsOnDeviceRecognition` is true, and "on-device requests won't be as accurate". Sources: https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition and https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition
  - Permission: the Info.plist key `NSSpeechRecognitionUsageDescription` plus `SFSpeechRecognizer.requestAuthorization`, which shows a TCC prompt. This is not an entitlement. Source: https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition
  - Local probe on macOS 27.0.1: on-device was true for en-US, en-ID, en-PH and en-SA. It was **false for every es-* locale** until assets are installed.
- **`SpeechAnalyzer` + `SpeechTranscriber`** (new in **macOS 26 / iOS 26**, WWDC25)
  - Fully on-device and built for long-form audio. Results carry an `audioTimeRange` (CMTimeRange).
  - Models are fetched by the **system** through `AssetInventory` from Apple's servers, live outside the app's memory, are shared between apps and do not count toward app size.
  - Sources: https://developer.apple.com/documentation/speech/speechanalyzer, https://developer.apple.com/documentation/speech/speechtranscriber, https://developer.apple.com/documentation/speech/assetinventory and https://developer.apple.com/videos/play/wwdc2025/277/
  - Local probe, `SpeechTranscriber.supportedLocales`: en-US/GB/AU/CA/IE/IN/NZ/SG/ZA, **es-ES, es-MX, es-US, es-CL**, fr, de, it, pt, ja, ko, zh, yue and many Indic locales. Only `mul-IN` is multilingual, so **es+en code-switching is not supported**: one locale per transcriber.
  - `DictationTranscriber` is the older-device fallback.
  - Apple's pages do not say whether SpeechAnalyzer needs the speech-recognition TCC prompt. Community guides request it anyway. Source: https://blog.addpipe.com/apple-speechanalyzer-api/
  - It is a **Swift-only async API**, so it needs a Swift shim from Rust. `objc2-speech` 0.3.2 (Zlib/Apache/MIT) covers only the Objective-C `SFSpeech*` classes. Source: https://crates.io/crates/objc2-speech
  - There is no primary speed or accuracy benchmark. A third party claims it is about 2.2x faster than Whisper large-v3. Source: https://blog.addpipe.com/apple-speechanalyzer-api/
  - I found no macOS 27 additions to these APIs. The docs still list 26.0 as the introduction version.
- **Verdict:** a good zero-weight option for Mac only, with timestamps and es support. But the OS downloads the assets, the API is Swift-only, there is one language per pass and it does nothing for Windows.

**Windows**
- **`Windows.Media.SpeechRecognition`**
  - The free-text **dictation and web-search grammars run on a remote web service**, need the "Online speech recognition" privacy setting and cap input at about **10 s**.
  - Offline works only with constrained grammars (lists, SRGS) for command and control.
  - Input is the microphone; the API has no audio-file input.
  - Source: https://learn.microsoft.com/en-us/windows/uwp/ui-input/speech-recognition
  - Rust access exists through the `windows` crate feature `Media_SpeechRecognition` (windows 0.62.2). Source: https://crates.io/crates/windows
- **Verdict:** unusable for offline transcription of clips. Ignore it.

**Implication for us:** OS engines cannot be our cross-platform answer. SpeechTranscriber could be an optional Mac-only engine later.

---

## 6. Resampling

- `rubato` **5.0.1** (2026-10-01), **MIT OR Apache-2.0**. It is pure Rust, built on realfft/rustfft. Source: https://crates.io/crates/rubato
- It offers asynchronous sinc resamplers (high quality) and **synchronous FFT resamplers**, which suit fixed 48000→16000 or 44100→16000 conversion. Source: https://github.com/HEnquist/rubato
- Its API changed at 1.0 and again at 2.0: candle had to update its examples for "rubato 2.0 API". Pin the major version. Source: https://github.com/huggingface/candle/pull/3474
- `hound` 3.5.1 (Apache-2.0) is already in our tree and reads our WAVs. Source: https://crates.io/crates/hound

**Implication for us:** hound reads the WAV, then i16→f32 /32768, mean downmix, `rubato` FFT resampling to 16 kHz, then the engine. No new C code.

---

## 7. Practical notes

**RAM per model** (whisper.cpp README; f16, fixed allocation). Source: https://github.com/ggml-org/whisper.cpp#memory-usage

| Model | Disk | RAM |
|---|---|---|
| tiny | 75 MiB | ~273 MB |
| base | 142 MiB | ~388 MB |
| small | 466 MiB | ~852 MB |
| medium | 1.5 GiB | ~2.1 GB |
| large | 2.9 GiB | ~3.9 GB |

- Turbo should sit between medium and large: 1.6 GB on disk, so roughly 2-2.5 GB of RAM. That is my estimate.
- Quantized models use less.
- The OpenAI PyTorch VRAM figures are higher: tiny ~1 GB, small ~2 GB, medium ~5 GB, turbo ~6 GB, large ~10 GB. Source: https://github.com/openai/whisper#available-models-and-languages
- whisper.cpp does "zero memory allocations at runtime".

**Load time**
- whisper.cpp on M1 Pro (2023, warm cache): tiny 71 ms, base 96 ms, small 233 ms, medium 603 ms, large 1158 ms. Source: https://github.com/ggml-org/whisper.cpp/pull/566
- Core ML adds a **slow first run per device** while the ANE compiles the model: "several seconds", and much longer for medium and large.
- A user log shows large `load time = 1128 ms`. Source: https://github.com/ggml-org/whisper.cpp/issues/1901
- Load once and keep the context. whisper-rs separates `WhisperContext` (weights) from `WhisperState` (per run).

**Cancellation**
- whisper.cpp exposes `abort_callback`, which is polled during compute, and `progress_callback`. Source: https://github.com/ggml-org/whisper.cpp/blob/master/include/whisper.h (lines 566-575)
- whisper-rs wraps both: `FullParams::set_abort_callback_safe` and `set_progress_callback_safe`. Source: https://codeberg.org/tazz4843/whisper-rs/src/branch/master/src/whisper_params.rs
- In candle, cancellation is our own loop over 30 s windows, so it is trivial.

**Timestamps**
- whisper.cpp / whisper-rs give segment start and end in **centiseconds**, `segment.start_timestamp()`. With VAD on, the times are mapped back to the original audio timeline.
  - Token-level times come from `token_timestamps` or DTW. The README calls word-level timestamps "experimental".
  - Sources: https://codeberg.org/tazz4843/whisper-rs/src/branch/master/README.md, whisper.h lines 505 and 670-693, and https://github.com/ggml-org/whisper.cpp#word-level-timestamp-experimental
- Candle: `--timestamps` mode with timestamp-token rules (PR #3054). Source: https://github.com/huggingface/candle/pull/3054
- Parakeet: word and segment timestamps.
- SpeechTranscriber: an `audioTimeRange` per run.
- **Segment-level "click to jump to position in clip" is feasible on every serious option.**

**Implication for us:** keep the context in a long-lived worker thread, run each transcription with an abort flag wired to the UI, and store segment `[t0, t1, text]` alongside the clip so the transcript links back to positions.
