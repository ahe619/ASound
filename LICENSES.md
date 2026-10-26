# ASound — open-source components and licenses

ASound's own code (everything under `app/js`, `app/css`, `app/index.html`, `app/locales`, `app/sw.js`, `server.py`,
`packs.py`, `voice_server.py`, `launcher.py`, `mobile/`, `tools/`) and its logo (`branding/`) are original work for this project.

| Component | Used for | License | Commercial use / App Store |
|---|---|---|---|
| [Qwen3.5](https://huggingface.co/Qwen) 0.8B / 2B / 4B (MLC builds `mlc-ai/Qwen3.5-*-MLC`, downloaded in the app) | conversation, corrections, summaries | Apache-2.0 | OK (keep the license notice) |
| [WebLLM](https://github.com/mlc-ai/web-llm) `@mlc-ai/web-llm` 0.2.86 + MLC model library | runs the LLM on WebGPU | Apache-2.0 | OK |
| [wllama](https://github.com/ngxson/wllama) 3.8.1 + `@wllama/wllama-compat` 3.8.1 | processor-based LLM runtime, including compatibility JS/WASM | MIT | Keep bundled license notices; package source and checksums are recorded in `app/vendor/wllama/compat/SOURCE.json` |
| [ECDICT](https://github.com/skywind3000/ECDICT/tree/ab22ad36302cafc6349a050e2b60894855208055) | vocabulary definitions, phonetics, frequency ranks and postgraduate reference tags | MIT | License retained in `app/vocabulary/ECDICT-LICENSE.txt`; CET word-list membership has its own official source attribution in `docs/VOCABULARY_SOURCES.md` |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) weights | standard voice; optional hosted phone q8 pack | Apache-2.0 | [Full license and source attribution](app/kokoro/KOKORO-MODEL-LICENSE.txt). Hosted ONNX revision and file hashes are pinned in `tools/web_voice_manifest.json`. |
| [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) 0.6.1 | runs Kokoro in the local server | MIT | OK |
| [kokoro-js](https://github.com/hexgrad/kokoro) 1.2.1 | in-browser fallback voice | Apache-2.0 | OK |
| [phonemizer](https://github.com/bootphon/phonemizer) + [espeak-ng](https://github.com/espeak-ng/espeak-ng) (via `espeakng-loader`, and bundled inside kokoro-js) | turns English text into phonemes for Kokoro | **GPL-3.0** | **Not App-Store safe.** Fine for this personal Windows build. Before any store release, replace it with Kokoro's own G2P [misaki](https://github.com/hexgrad/misaki) (Apache-2.0) using its dictionaries only. |
| [Chatterbox](https://github.com/resemble-ai/chatterbox) 0.1.7 (optional natural voice) | most human-sounding voice on NVIDIA GPUs | MIT | OK. Its audio carries Resemble's inaudible Perth watermark. |
| [PyTorch](https://pytorch.org) (CUDA 12.8 build, optional) | runs Chatterbox | BSD-3-Clause | OK |
| [Moonshine](https://github.com/usefulsensors/moonshine) base (`onnx-community/moonshine-base-ONNX`) | speech recognition | MIT | OK |
| [Transformers.js](https://github.com/huggingface/transformers.js) 3.8.1 | runs Moonshine in the browser | Apache-2.0 | OK |
| [Whisper](https://github.com/openai/whisper) base (`onnx-community/whisper-base`, optional download) | understands the learner's own language when they ask for help | MIT | OK |
| [AndroidX WebKit](https://developer.android.com/jetpack/androidx/releases/webkit) (Android app only) | serves the app inside the Android WebView | Apache-2.0 | OK |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (web and Python) | model runtime | MIT | OK |
| [NumPy](https://numpy.org), [soundfile](https://github.com/bastibe/python-soundfile) | audio arrays and files | BSD-3-Clause | OK |
| [Literata](https://github.com/googlefonts/literata), [Atkinson Hyperlegible](https://brailleinstitute.org/freefont) | fonts | SIL Open Font License 1.1 | OK |
| [PyInstaller](https://pyinstaller.org) | builds ASound.exe | GPL-2.0 with a bootloader exception | OK: the exception allows distributing the built app under any license |
| Microsoft Edge (app mode) | the app window | already on Windows; not redistributed | — |

Notes for a future App Store or commercial release
- Replace the GPL phonemizer (see above). Everything else on this list allows commercial distribution.
- The app name "ASound": a quick search found no app with that exact name (closest: "Ausounds", an audio-hardware
  brand). Run a proper trademark search (USPTO, and CNIPA for China) before publishing.
- The interface uses University of Florida's blue and orange only as colors; there is no UF name, seal or logo in the
  app, so it does not suggest an affiliation.
