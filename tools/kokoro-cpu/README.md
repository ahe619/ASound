# Rebuild the browser voice runtime

The voice uses Kokoro 1.2.1, Transformers.js 3.5.1 and phonemizer 1.2.1. This build selects the **WASM-only** variant of ONNX Runtime Web **1.22.0-dev.20250409-89f8206ba4**, matching the runtime version used by the original Kokoro bundle. It preserves text normalization, phonemization, tokenization, model weights and all voices.

The original bundle's ONNX common API also reports 1.21.0; that is a separate dependency and is not the correct Web runtime version. Do not mix versions or rename JSEP files to the plain runtime filenames.

From this directory, with Node.js and npm available:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

The exact dependency tree and npm package integrity values are in `package-lock.json`. Dependency installation skips lifecycle scripts. Building uses the installed files and performs no network downloads. The script verifies the selected package versions and ORT commit and fails on unresolved imports or a remaining JSEP runtime reference.

Output is always under `build/kokoro-cpu/` at the repository root. It does **not** overwrite `app/`:

- `kokoro.web.js`
- `ort-cpu/ort-wasm-simd-threaded.mjs`
- `ort-cpu/ort-wasm-simd-threaded.wasm`
- `ort-cpu/LICENSE.txt` — ONNX Runtime's MIT license
- `ort-cpu/sources.json` — source versions, package integrity and artifact SHA-256 values
- `build-report.json` — local module graph and build warnings, not a published asset

After review and real inference tests, copy the first five outputs to the matching paths under `app/kokoro/`. Keep `neural-tts.js` pointed at `ort-cpu/` and keep `RUNTIMES.voice` in `app/js/packs.js` in sync. The shared ASR runtime has its own files. Do not change the voice-model manifest or its cache keys: existing downloaded weights remain usable.

This compatibility change avoids the JSEP/Asyncify path implicated in [ONNX Runtime issue 26827](https://github.com/microsoft/onnxruntime/issues/26827) and [issue 33516](https://github.com/microsoft/onnxruntime/issues/33516). Those reports do not prove the cause of every playback failure. Keep real iPhone playback checks separate from desktop WebKit tests and single-run timing measurements.

The previous app bundle matched the published Kokoro 1.2.1 browser bundle after U+FFFD literal escaping. It did not reference `lexicon-us.json`; this build retains the same bundled phonemizer instead of introducing a new dictionary path or external G2P service. Existing Kokoro and third-party license notices still apply.
