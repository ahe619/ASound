# ASound on phones

ASound's interface is one web app (`app/`). Phones run the same code; what changes is where the models come from
(downloaded in the app into the phone's storage, see `app/js/packs.js`) and which sizes are recommended (the 0.8B
conversation model, or 2B on phones with 8 GB of memory; Moonshine tiny; Kokoro on the CPU).

What a phone needs: a compatible browser, a microphone, and enough storage for the chosen models. WebGPU speeds
up the conversation model; a 0.8B CPU/WebAssembly fallback is now implemented for browsers without it. Availability
does not establish acceptable latency or memory use on a particular phone: test the target devices.

## Publishing and updates

The first release target is the hosted PWA. Build with `python tools/build_web.py`, then deploy `dist/web/`
through the GitHub Pages workflow. Users can install that website to their home screen. The complete app release
is checked before activation; Settings offers an update when it is ready, without replacing model storage or
learning records. See [the release guide](../docs/WEB_RELEASES.md) for publishing, rollback and the mobile plan.

The existing Android and iOS shells below bundle local files. **Publishing a new website does not update those
bundled files.** For Android, a future Trusted Web Activity can load the hosted PWA in the system browser and
share its web update flow; native shell changes still need a new signed package. iOS should start with the
home-screen PWA; an App Store version needs separate device testing and review.

## Android (first)

1. **Web app**: publish the generated `dist/web/` on an HTTPS static host, open it in Chrome, tap
   "Install app" / "Add to Home screen". Chrome on Android 12+ has WebGPU on most recent phones. Speech recognition and
   the voice run on WebAssembly, so they also work on phones without WebGPU; only the conversation model needs it.
2. **App (APK)**: `android/` is a minimal WebView app (Java, no other dependencies than AndroidX WebKit). It serves the
   bundled `app/` at `https://appassets.androidplatform.net` with `WebViewAssetLoader` (a secure origin, so the
   microphone, Cache Storage and OPFS work), asks for the microphone permission when the page wants it, and opens
   other links in the browser. Build: `powershell -ExecutionPolicy Bypass -File tools\build_android.ps1` ->
   `dist\ASound-android.apk`. Not yet built or tested on a device: building needs the Android SDK, whose license you
   accept yourself when the script asks.
   - Open question: WebGPU inside the system WebView. Chromium has been bringing WebGPU (and a compatibility mode for
     older GPUs) to Android WebView; on phones where `navigator.gpu` is missing in the app, the models screen says so and
     the CPU fallback is available, but the hosted web app in Chrome is the preferred path to test first.

## iPhone / iPad (next)

1. **Web app**: Safari on iOS/iPadOS 26 ships WebGPU, so the same https web app works: open it in Safari, Share > "Add
   to Home Screen". The microphone works in home-screen web apps. Storage: Safari gives installed web apps a large
   quota, enough for the phone model set.
2. **App Store app** (needs a Mac with Xcode): `ios/` has the starting point: a SwiftUI app with one `WKWebView`
   (`ASoundApp.swift`) that loads the bundled `app/` folder from a tiny read-only server on `http://localhost`
   (`LocalServer.swift`, a secure context, so the microphone works) and grants the page's microphone request after
   iOS's own prompt. `project.yml` generates the Xcode project with XcodeGen (steps inside). Written on Windows, so it
   has not been compiled yet. WKWebView gets WebGPU where Safari has it on by default (iOS 26+).
3. Before any store release: the GPL phonemizer must be gone (see `LICENSES.md`); ASound's own G2P replaces it.
