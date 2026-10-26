# ASound

An American-English speaking coach whose AI runs on your own device: no account, no API key, and nothing you say is
uploaded. Windows today (ASound.exe); phones through the installable web app (Android Chrome, iPhone/iPad Safari on
iOS 26+) and an Android app shell.

## Start

Unzip **ASound-win-x64.zip** and double-click **ASound.exe**. It starts a small local server and opens ASound in its own
window (Microsoft Edge in app mode). Close the window to quit.

The download is small (about 60 MB) because the AI models are not inside it. On first start ASound shows **Download
your AI coach**: one button fetches the models recommended for this computer (a conversation model, speech
recognition and a voice), from Hugging Face or its China mirror, whichever is faster. Downloads resume after an
interruption and are checked against their checksums. After that everything works offline. Change or remove models
any time in **Settings > Models & downloads**:

| Pack | Size | For |
|---|---|---|
| Conversation AI: Qwen3.5 0.8B / 2B / 4B | 0.45 / 1.1 / 2.4 GB | phones / laptops / computers with a graphics card |
| Listening: Moonshine tiny / base | 32 / 221 MB | phones / computers |
| Voice: Kokoro (16 American voices) | 101 MB | everyone |
| Voice, full precision | 326 MB | computers (a little smoother) |
| Help in your own language: Whisper base | 80 MB | say something in your language when you're stuck |

Developer start (same app, from source): `start.bat`, or `.venv\Scripts\python.exe server.py`.

Requirements: Windows 10/11, a recent Edge or Chrome, a microphone. WebGPU speeds up the conversation model;
browsers without it can use the smaller CPU model through WebAssembly. The optional "most natural" voice needs
an NVIDIA graphics card. Mobile performance still needs validation on real devices.

## What's inside

- **Talk** - role-play scenarios (small talk, office hours, group project, cafe, interview, clinic, IELTS/TOEFL, a TA
  speaking test), **My Field** (from your major or job), **My Document** (talk about your essay or resume), **Dress
  Rehearsal** (practise a real conversation that's coming up: script, then keywords, then live with a surprise; a few
  hours after the real one ASound asks how it went and gives you lines for next time) and your own scene. Speak or
  type; **hands-free** mode keeps listening and waits longer for learners: say "um" or "let me think..." and it keeps
  listening instead of jumping in. Every line gets red-pen corrections and more natural alternatives. Stuck? Tap the
  globe and say or type it in your own language: you get the English, hear it, practise it, and the conversation goes
  on. Expressions you saved show up as "try to use for real"; one you use in three different conversations counts as
  yours.
- **Accent** - shadowing drills for American sounds (flap T, R, TH, ae, reductions, linking, dark L, stress) and a
  reading check with a fresh paragraph, a transcript-match score and a report. The score measures recognized
  words against the target text; it is not a phoneme-level accent assessment.
- **More practice** - Talk includes Shrinking Retell (three progressively shorter rounds) and Phone Practice;
  Accent includes Reduction Ladder (listen to reduced speech, slow down as needed, then work back up).
- **Vocab** - everything you saved, with audio, plus spoken review (see the meaning, say the English, spaced repetition).
- **Me** - five levels (Beginner, Foundational, Skilled, Talented, Master); a placement test built from 5 words you
  choose or a topic; an "about you" interview; a voice recommendation based on your own pitch.
- **Settings** - automatic / phone / tablet / desktop layouts, interface and help languages, downloadable
  Kokoro voices or system speech, speed and correction strictness. The natural server voice is offered only
  when that service is available.

## Phones

- **Installable web app**: run `python tools/build_web.py` and publish **`dist/web/`** over HTTPS. Open it in a
  compatible phone browser and use "Add to Home screen". A complete, verified app release is cached separately
  from the models. Updates wait until you choose **Settings > App updates > Update and reopen**, or close every
  old app window. Failed updates leave the current installed version available. Raw `app/` is for development;
  it does not install the new release worker. To try browser-side model downloads on a computer, use
  `http://localhost:8770/?web`.
- **GitHub Pages**: `.github/workflows/pages.yml` checks and builds `dist/soundoa-site/site` on pushes to `main`. Enable publishing by
  configuring Pages to use GitHub Actions and setting the repository Actions variable `ASOUND_PAGES_ENABLED`
  to `true`. It hosts the pinned 101 MB Kokoro q8 voice pack as an optional download; conversation models and
  local Python environments are excluded. See
  [the publishing and mobile update guide](docs/WEB_RELEASES.md).
- **Android app**: `mobile/android` is a small WebView app around the same `app/` folder.
  `powershell -ExecutionPolicy Bypass -File tools\build_android.ps1` builds `dist\ASound-android.apk` (it fetches Java
  and Gradle; the Android SDK license is shown to you to accept). The conversation AI needs WebGPU in the phone's
  system WebView; where it is missing, use the web app in Chrome instead.
- **iPhone / iPad**: see [mobile/README.md](mobile/README.md).

For a mainland-China pilot, run `python tools/build_china_pilot.py` to create a small-model web build and a deployment
zip, including a separate model upload manifest. No model weights are downloaded by the builder. Configure your own
model host with `--model-base-url` once available; both model weights and GPU runtime libraries use that host.
See [the China deployment guide](docs/CHINA_DEPLOYMENT.md). This is preparation for testing, not a claim that mainland
network access or real-phone inference performance has been validated. Browser ASR/TTS/CPU downloads can retain
verified-size ranges on compatible servers and check available SHA-256 digests; GPU downloads remain managed by WebLLM.

For `soundoa.cn`, run `python tools/prepare_soundoa_site.py --with-web-voice` to prepare a verified website and ZIP
using the local voice files. CI uses `--download-web-voice` to fetch missing files from a pinned upstream revision
and verify every checksum. The existing public `ahe619/ASound` repository publishes the generated website. See [the soundoa.cn launch guide](docs/SOUNDOA_LAUNCH.md) for
the free hosting setup, domain verification, DNS and HTTPS steps. Preparing the bundle does not publish the website.

## Vocabulary study

Text study works without model downloads. For spoken words, download just the **Phone-compatible voice pack**
in Settings or the model setup screen. It uses Kokoro q8 on WebAssembly, with no NVIDIA requirement. The voice
files download from the same website and are cached separately from webpage updates. Automatic speech uses
the installed voice; without it, an available system English voice can be used (some system voices need the
internet). Browser simulation and real CPU synthesis are checked; real-phone memory and speed still need testing.

The **Vocabulary / Learn words** page includes local flashcards for everyday vocabulary, CET-4, CET-6, and a
postgraduate-exam reference list. Topic and situation filters are independently optional; leaving both empty
draws a random batch from the selected list. Reveal the Chinese meaning and rate recall to schedule a review.
Progress and the current batch stay in this browser; saved expressions remain under **Saved words**.
Text study needs no AI model. The list provenance, coverage and regeneration instructions are in
[Vocabulary sources](docs/VOCABULARY_SOURCES.md); exam-list membership is never generated by the conversation model.

## Folder layout

| Path | What |
|---|---|
| `ASound.exe`, `_internal/` | the packaged launcher and local server |
| `app/` | the interface (HTML/CSS/JS); text in `app/locales/*.json`; `packs.json` lists the downloadable models |
| `app/models/` | downloaded models (made by the app) |
| `server.py`, `packs.py`, `launcher.py` | local server, model downloads, exe entry point |
| `.venv-voice/`, `voice_server.py` | optional natural voice (Chatterbox, CUDA PyTorch) |
| `mobile/` | Android app shell and the iOS plan |
| `tools/` | `build_release.ps1` (Windows zip), `build_android.ps1`, `build_packs.py` (model catalog), `check_i18n.py`, `ascii_code.py`, `make_icon.py` |
| `branding/` | logo (SVG, PNG, ICO) and voice samples |

Licenses: see [LICENSES.md](LICENSES.md).

## Development checks

No package installation is required for these checks (Python 3.10+ and Node.js 22):

```text
python tools/check_i18n.py
python -m unittest discover -s tests -p "test_*.py"
node tools/check_js.mjs
node --test tests/*.mjs
python tools/build_web.py
python -m http.server 8782 --directory dist/web
```

`VERSION` supplies the web release version; the builder appends a content hash, so any shipped asset or worker
change creates a new update even if the version number was not changed. Build artifacts go under `dist/`.
The optimization backup is under `build/optimization-backup/` and is not published.
