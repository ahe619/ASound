import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Exercise real routing with bounded fake browser/server engines, never model downloads.
const source = readFileSync(new URL("../app/js/speech.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/^export /gm, "")
  .replace('import("../kokoro/neural-tts.js")', "loadBrowserModule()")
  .replaceAll("import.meta.url", JSON.stringify("https://app.test/js/speech.js"))
  + "\nglobalThis.speech = { speechEngineOrder, voiceCapabilities, configureVoice, speak, previewVoice, useBasicSpeechNow, stopSpeaking, renderSpeech, recheckSpeech, startNatural, speechStatus, onSpeechStatus, warmUp, prefetchSpeech };";
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const en = { name: "English", lang: "en-US" };

function fixture({ mobile = true, preference = "auto", voices = [en], system = true,
  health = null, search = "", failStart = false, healthGate = null, browserGate = null, synthesisGate = null, parts = null } = {}) {
  const requests = [], utterances = [], sources = [], timers = new Map(), listeners = {}, synthesized = [], signals = [];
  let serial = 0, imports = 0, syntheses = 0, currentVoices = voices, currentHealth = health;
  const prefs = { voiceEngine: preference, voice: "af_heart", rate: 1 };
  const buffer = () => ({ length: 80, duration: 0.01, sampleRate: 24000,
    copyToChannel() {}, getChannelData: () => new Float32Array(80) });
  class AudioContext {
    constructor() { this.state = "running"; this.currentTime = 0; }
    createBuffer() { return buffer(); }
    async decodeAudioData() { return buffer(); }
    createBufferSource() {
      const src = { connect() {}, start() {}, stop() {} };
      sources.push(src); return src;
    }
  }
  const synth = {
    getVoices: () => currentVoices, addEventListener: (name, fn) => { listeners[name] = fn; },
    speak: u => utterances.push(u), cancel() {},
  };
  const context = vm.createContext({
    prefs, location: { search }, deviceInfo: () => ({ mobile }), AudioContext,
    ...(system ? { speechSynthesis: synth } : {}),
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    h() {}, icon() {}, str: value => String(value || ""), sentences: text => parts || [text],
    clamp: (value, low, high) => Math.max(low, Math.min(high, value)), t: key => key,
    URL, URLSearchParams, AbortController, Float32Array, CustomEvent: class {},
    document: { dispatchEvent() {} }, console: { warn() {} },
    setTimeout(fn, delay) {
      const id = ++serial;
      if (delay < 1000) queueMicrotask(fn); else timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    async fetch(path, options) {
      requests.push({ path, options });
      if (path === "api/health") {
        if (healthGate) await healthGate;
        return { ok: !!currentHealth, status: currentHealth ? 200 : 404, json: async () => currentHealth };
      }
      if (path === "api/natural/start") return { ok: !failStart, status: failStart ? 500 : 200, json: async () => ({ natural: "loading" }) };
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    async loadBrowserModule() {
      imports++;
      if (browserGate) await browserGate;
      return { configure() {}, onStatus() {}, async synthesize(text, options) {
        signals.push(options?.signal);
        syntheses++; synthesized.push(text);
        if (synthesisGate) await (typeof synthesisGate === "function" ? synthesisGate(text) : synthesisGate);
        return { pcm: new Float32Array(80), sr: 24000 };
      } };
    },
  });
  vm.runInContext("globalThis.window = globalThis;", context);
  vm.runInContext(source, context, { filename: "speech.js" });
  return { ...context.speech, prefs, requests, utterances, sources, timers, signals,
    imports: () => imports, syntheses: () => syntheses, synthesized: () => [...synthesized],
    setHealth: value => { currentHealth = value; },
    setVoices(value) { currentVoices = value; listeners.voiceschanged?.(); },
  };
}

test("mobile auto keeps system English first even after installing a voice pack", async () => {
  const f = fixture();
  f.configureVoice({ mode: "web", base: "/voices/" });
  f.warmUp(); await f.recheckSpeech();
  f.speak("Hello."); await flush();
  assert.equal(f.speechStatus().engine, "system");
  assert.equal(f.voiceCapabilities().effective, "system");
  assert.equal(f.imports(), 0);
  assert.equal(f.syntheses(), 0);
  assert.equal(f.utterances.length, 1);
  assert.equal(f.prefs.voiceEngine, "auto");
  assert.ok(f.requests.every(r => r.path === "api/health"));
});

test("explicit natural voices (standard preference) still use the installed browser pack on mobile", async () => {
  const f = fixture({ preference: "standard" });
  f.configureVoice({ mode: "web", base: "/voices/" });
  await flush();
  assert.equal(f.imports(), 0, "configuration alone does not load a model");
  f.speak("Hello."); await flush();
  assert.equal(f.speechStatus().engine, "browser");
  assert.equal(f.imports(), 1);
  assert.equal(f.syntheses(), 1);
  assert.equal(f.utterances.length, 0);
  assert.equal(f.voiceCapabilities().canNatural, false);
  assert.ok(f.requests.every(r => r.path === "api/health"));
  assert.equal(f.prefs.voiceEngine, "standard");
});

test("a repeated or prefetched line is generated once; another voice model starts afresh", async () => {
  const f = fixture({ mobile: false, preference: "standard" });
  f.configureVoice({ mode: "web", base: "/voices/" });
  f.speak("Hello."); await flush();
  f.speak("Hello."); await flush();
  assert.equal(f.syntheses(), 1);
  f.prefetchSpeech("Goodbye."); await flush();
  assert.equal(f.syntheses(), 2);
  f.speak("Goodbye."); await flush();
  assert.equal(f.syntheses(), 2);
  assert.equal(f.speechStatus().engine, "browser");
  f.configureVoice({ mode: "web", base: "/other-voices/" });
  f.speak("Hello."); await flush();
  assert.equal(f.syntheses(), 3);
});

test("mobile browser voices remain on demand instead of prefetching skipped cards", async () => {
  for (const options of [{ preference: "standard" }, { voices: [{ lang: "zh-CN" }] }]) {
    const f = fixture(options);
    f.configureVoice({ mode: "web" }); await flush();
    for (const word of ["old one", "old two", "current"]) f.prefetchSpeech(word);
    await flush();
    assert.equal(f.imports(), 0);
    assert.equal(f.syntheses(), 0);
    f.speak("current"); await flush();
    assert.equal(f.syntheses(), 1);
    assert.equal(f.sources.length, 1);
  }
});

test("mobile auto prefetch makes nothing while the system voice list is still loading", async () => {
  // Chrome on Android lists its voices a moment after the page starts; speak() then uses the system voice.
  for (const options of [{}, { health: { tts: true } }]) {
    const f = fixture({ voices: [], ...options });
    if (!options.health) f.configureVoice({ mode: "web" });
    await flush();
    f.prefetchSpeech("apple"); await flush();
    assert.equal(f.imports(), 0);
    assert.ok(f.requests.every(r => r.path === "api/health"), "no server audio either");
    f.setVoices([en]);
    f.speak("apple"); await flush();
    assert.equal(f.speechStatus().engine, "system");
    assert.equal(f.imports(), 0);
  }
});

test("desktop prefetch for the in-page voice keeps at most one skipped card ahead of a tap", async () => {
  let release;
  const f = fixture({ mobile: false, preference: "standard", synthesisGate: new Promise(resolve => { release = resolve; }) });
  f.configureVoice({ mode: "web" }); await flush();
  for (let card = 0; card < 10; card++) {
    f.stopSpeaking(); // word study stops speech on each new card
    f.prefetchSpeech(`word ${card}`); f.prefetchSpeech(`word ${card + 1}`); await flush();
  }
  f.speak("word 9"); await flush();
  assert.deepEqual(f.synthesized(), ["word 0", "word 9"], "the voice runs one line at a time, in order");
  release(); await flush();
  assert.equal(f.sources.length, 1);
  assert.deepEqual(f.synthesized(), ["word 0", "word 9"], "lines for skipped cards are never made");
});

test("desktop prefetch for the in-page voice makes the newest lines once the running one is done", async () => {
  let release;
  const f = fixture({ mobile: false, preference: "standard", synthesisGate: new Promise(resolve => { release = resolve; }) });
  f.configureVoice({ mode: "web" }); await flush();
  for (let n = 0; n < 6; n++) f.prefetchSpeech(`line ${n}`);
  f.prefetchSpeech("line 4"); await flush();
  assert.deepEqual(f.synthesized(), ["line 0"]);
  release(); await flush();
  assert.deepEqual(f.synthesized(), ["line 0", "line 5", "line 4"]);
  f.speak("line 4"); await flush();
  assert.equal(f.syntheses(), 3, "made ahead of time, so it plays at once");
  assert.equal(f.sources.length, 1);
});

test("stopping desktop prefetch during module import drops obsolete tasks", async () => {
  let release;
  const f = fixture({ mobile: false, preference: "standard", browserGate: new Promise(resolve => { release = resolve; }) });
  f.configureVoice({ mode: "web" }); await flush();
  f.prefetchSpeech("old one"); f.prefetchSpeech("old two"); await flush();
  assert.equal(f.imports(), 1);
  f.stopSpeaking();
  release(); await flush();
  assert.equal(f.syntheses(), 0);
});

test("cancelling pending prefetch does not cancel a new requested utterance", async () => {
  let release;
  const f = fixture({ mobile: false, preference: "standard", browserGate: new Promise(resolve => { release = resolve; }) });
  f.configureVoice({ mode: "web" }); await flush();
  f.prefetchSpeech("apple"); await flush();
  f.speak("apple");
  release(); await flush();
  assert.equal(f.syntheses(), 1);
  assert.equal(f.sources.length, 1);
  assert.equal(f.speechStatus().engine, "browser");
});

test("an already running desktop prefetch still shares its result with an explicit playback", async () => {
  let release;
  const f = fixture({ mobile: false, preference: "standard", synthesisGate: new Promise(resolve => { release = resolve; }) });
  f.configureVoice({ mode: "web" }); await flush();
  f.prefetchSpeech("apple"); await flush();
  assert.equal(f.syntheses(), 1);
  f.speak("apple"); await flush();
  release(); await flush();
  assert.equal(f.syntheses(), 1);
  assert.equal(f.sources.length, 1);
  f.stopSpeaking();
  f.speak("apple"); await flush();
  assert.equal(f.syntheses(), 1, "stop does not throw away the completed audio cache");
});

test("mobile automatic speech starts without waiting for the local-service health check", async () => {
  const f = fixture({ healthGate: new Promise(() => {}) });
  f.configureVoice({ mode: "web" });
  f.speak("Hello."); await flush();
  assert.equal(f.speechStatus().engine, "system");
  assert.equal(f.utterances.length, 1);
  assert.equal(f.imports(), 0);
});

test("mobile auto falls back to installed voices when system English is absent or still unknown", async () => {
  for (const options of [{ voices: [{ lang: "zh-CN" }] }, { system: false }, { voices: [] }]) {
    const f = fixture(options);
    f.configureVoice({ mode: "web" });
    f.speak("Hello."); await flush();
    assert.equal(f.speechStatus().engine, "browser");
    assert.equal(f.syntheses(), 1);
    assert.equal(f.utterances.length, 0);
    assert.equal(f.prefs.voiceEngine, "auto");
  }
});

test("mobile auto switches to system English when voices arrive without changing saved preference", async () => {
  const f = fixture({ voices: [{ lang: "zh-CN" }] });
  f.configureVoice({ mode: "web" });
  f.speak("First."); await flush();
  f.setVoices([en]);
  f.speak("Second."); await flush();
  assert.equal(f.syntheses(), 1);
  assert.equal(f.utterances.length, 1);
  assert.equal(f.voiceCapabilities().effective, "system");
  assert.equal(f.prefs.voiceEngine, "auto");
});

test("stopping and switching to auto prevents an older synthesis from playing or changing the engine", async () => {
  let release;
  const f = fixture({ preference: "standard", synthesisGate: new Promise(resolve => { release = resolve; }) });
  f.configureVoice({ mode: "web" });
  let oldDone = 0;
  f.speak("Slow sentence.", null, 1, () => oldDone++); await flush();
  assert.equal(f.syntheses(), 1);
  f.stopSpeaking();
  f.prefs.voiceEngine = "auto";
  f.speak("Fast sentence."); await flush();
  release(); await flush();
  assert.equal(f.sources.length, 0, "the stopped neural audio was not scheduled");
  assert.equal(f.speechStatus().engine, "system");
  assert.equal(f.utterances.length, 1);
  assert.equal(oldDone, 0);
});

test("concurrent playback imports the browser module once and skips superseded requests", async () => {
  let release;
  const f = fixture({ preference: "standard", browserGate: new Promise(resolve => { release = resolve; }) });
  f.configureVoice({ mode: "web" });
  await flush();
  f.speak("First.");
  f.speak("Second.");
  await flush();
  assert.equal(f.imports(), 1);
  release(); await flush();
  assert.equal(f.syntheses(), 1);
  assert.equal(f.sources.length, 1);
});

test("changing voice configuration cancels audio still being generated by the previous configuration", async () => {
  let release;
  const f = fixture({ preference: "standard", synthesisGate: new Promise(resolve => { release = resolve; }) });
  f.configureVoice({ mode: "web", base: "/old/" });
  let completed = 0;
  f.speak("Old sentence.", null, 1, () => completed++); await flush();
  f.configureVoice({ mode: "web", base: "/new/" });
  release(); await flush();
  assert.equal(f.sources.length, 0);
  assert.equal(completed, 0);
  assert.equal(f.prefs.voiceEngine, "standard");
});

test("without a downloaded voice, mobile auto speaks through the system without importing models", async () => {
  const f = fixture();
  f.speak("Hello."); await flush();
  assert.equal(f.imports(), 0);
  assert.equal(f.utterances.length, 1);
  assert.equal(f.utterances[0].voice.lang, "en-US");
  assert.equal(f.speechStatus().engine, "system");
});

test("explicit system speech never loads or warms native or browser models", async () => {
  const f = fixture({ preference: "system", health: { tts: true, natural: "ready" } });
  f.configureVoice({ mode: "web" });
  f.warmUp(); f.speak("Hello."); await flush();
  assert.equal(f.imports(), 0);
  assert.equal(f.utterances.length, 1);
  assert.ok(f.requests.every(r => r.path === "api/health"));
});

test("a stored natural preference cannot expose or call CUDA on a static host", async () => {
  const f = fixture({ preference: "natural" });
  f.configureVoice({ mode: "web" });
  f.speak("Hello."); await flush();
  await f.startNatural();
  assert.equal(f.voiceCapabilities().natural, false);
  assert.equal(f.speechStatus().engine, "browser");
  assert.equal(f.prefs.voiceEngine, "natural", "do not overwrite a preference based on temporary availability");
  assert.ok(f.requests.every(r => r.path === "api/health"));
});

test("failed health refresh clears previously available native and natural services", async () => {
  const f = fixture({ health: { tts: true, natural: "ready" } });
  await flush();
  assert.equal(f.voiceCapabilities().natural, true);
  f.setHealth(null); await f.recheckSpeech();
  assert.equal(f.speechStatus().natural, "absent");
  assert.equal(f.voiceCapabilities().native, false);
  assert.equal(f.voiceCapabilities().natural, false);
});

test("browser-only mode does not probe or start local voice services", async () => {
  const f = fixture({ search: "?web", preference: "natural", health: { tts: true, natural: "ready" } });
  await flush(); await f.startNatural();
  assert.equal(f.requests.length, 0);
  assert.equal(f.voiceCapabilities().natural, false);
});

test("natural start failures stop polling and leave a recoverable error", async () => {
  const f = fixture({ preference: "natural", health: { tts: true, natural: "off" }, failStart: true });
  await flush();
  assert.equal(f.speechStatus().natural, "error");
  assert.equal(f.timers.size, 0);
  assert.equal(f.requests.filter(r => r.path === "api/natural/start").length, 1);
});

test("system voice availability refreshes when English voices arrive", async () => {
  const f = fixture({ preference: "system", voices: [{ lang: "zh-CN" }] });
  await flush();
  assert.equal(f.voiceCapabilities().system, false);
  f.speak("Hello."); await flush();
  assert.equal(f.utterances.length, 0);
  assert.equal(f.speechStatus().error, "speech.noEnglishVoice");
  let notices = 0;
  f.onSpeechStatus(() => notices++);
  f.setVoices([en]);
  assert.equal(notices, 1);
  assert.equal(f.voiceCapabilities().systemEnglish, true);
  f.speak("Hello."); await flush();
  assert.equal(f.utterances.length, 1);
});

test("removing the configured voice prevents future browser model use", async () => {
  const f = fixture();
  f.configureVoice({ mode: "web" });
  f.configureVoice(null);
  f.speak("Hello."); await flush();
  assert.equal(f.imports(), 0);
  assert.equal(f.voiceCapabilities().browser, false);
  assert.equal(f.speechStatus().engine, "system");
});

test("audio processing modes require an installed neural voice, never download one implicitly", async () => {
  const f = fixture();
  await assert.rejects(f.renderSpeech("Hello."), /speech.voicePackRequired/);
  assert.equal(f.imports(), 0);
});

test("desktop auto preserves native speech and natural requires ready service", async () => {
  const f = fixture({ mobile: false, health: { tts: true, natural: "ready" } });
  f.configureVoice({ mode: "desktop" });
  f.speak("Hello."); await flush();
  assert.equal(f.speechStatus().engine, "native");
  assert.equal(f.imports(), 0);
  f.prefs.voiceEngine = "natural";
  f.speak("A different sentence."); await flush();
  assert.equal(f.speechStatus().engine, "natural");
  assert.equal(JSON.parse(f.requests.at(-1).options.body).engine, "natural");
});

test("desktop automatic speech still prefers the installed browser pack to system speech", async () => {
  const f = fixture({ mobile: false });
  f.configureVoice({ mode: "web" });
  f.speak("Hello."); await flush();
  assert.equal(f.speechStatus().engine, "browser");
  assert.equal(f.syntheses(), 1);
  assert.equal(f.utterances.length, 0);
});

test("speech completion fires once even if a system error is followed by an end event", async () => {
  const f = fixture({ preference: "system" });
  let done = 0;
  f.speak("Hello.", null, 1, () => done++); await flush();
  f.utterances[0].onerror(); f.utterances[0].onend();
  assert.equal(done, 1);
  assert.equal(f.speechStatus().engine, "");
});

test("voice previews play the selected recording without loading the model, even on automatic", async () => {
  const f = fixture({ preference: "auto" });
  f.configureVoice({ mode: "web" }); await flush();
  f.previewVoice("am_michael"); await flush();
  assert.equal(f.speechStatus().phase, "playing");
  assert.equal(f.speechStatus().engine, "preview");
  assert.equal(f.imports(), 0);
  assert.equal(f.syntheses(), 0);
  assert.ok(f.requests.some(r => String(r.path) === "https://app.test/audio/voices/am_michael.wav"));
  assert.equal(f.sources.length, 1);
  const requests = f.requests.length;
  f.previewVoice("am_michael"); await flush();
  assert.equal(f.requests.length, requests, "replay uses the decoded short recording");
  f.sources.at(-1).onended();
  assert.equal(f.speechStatus().phase, "idle");
});

test("a new mobile tap cancels the old request without sharing its aborted signal", async () => {
  let release;
  const f = fixture({ preference: "standard", synthesisGate: new Promise(resolve => { release = resolve; }) });
  f.configureVoice({ mode: "web" }); await flush();
  f.speak("apple"); await flush();
  assert.equal(f.speechStatus().phase, "loading");
  const old = f.signals[0];
  f.speak("apple"); await flush();
  assert.equal(old.aborted, true);
  assert.notEqual(f.signals[1], old);
  assert.equal(f.signals[1].aborted, false);
  release(); await flush();
  assert.equal(f.sources.length, 1, "only the current tap plays");
  assert.equal(f.speechStatus().phase, "playing");
});

test("basic read aloud can replace a slow natural reading without changing the saved choice", async () => {
  let release;
  const f = fixture({ preference: "standard", synthesisGate: new Promise(resolve => { release = resolve; }) });
  f.configureVoice({ mode: "web" }); await flush();
  let done = 0;
  f.speak("Hello.", null, 1, () => done++); await flush();
  f.useBasicSpeechNow(); await flush();
  assert.equal(f.signals[0].aborted, true);
  assert.equal(f.prefs.voiceEngine, "standard");
  const utterance = f.utterances.find(u => u.text === "Hello.");
  assert.ok(utterance);
  utterance.onstart();
  assert.equal(f.speechStatus().phase, "playing");
  release(); await flush();
  assert.equal(f.sources.length, 0, "obsolete natural voice never plays over the basic reading");
  utterance.onend();
  assert.equal(done, 1);
  assert.equal(f.speechStatus().phase, "idle");
});

test("a gap between generated sentences restores waiting feedback until the next audio starts", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ preference: "standard", parts: ["First.", "Second."],
    synthesisGate: text => text === "Second." ? gate : undefined });
  f.configureVoice({ mode: "web" }); await flush();
  let done = 0;
  f.speak("First. Second.", null, 1, () => done++); await flush();
  assert.equal(f.speechStatus().phase, "playing");
  f.sources[0].onended();
  assert.equal(f.speechStatus().phase, "generating");
  assert.ok(f.speechStatus().waitingSince > 0);
  assert.equal(done, 0);
  release(); await flush();
  assert.equal(f.speechStatus().phase, "playing");
  f.sources[1].onended();
  assert.equal(f.speechStatus().phase, "idle");
  assert.equal(done, 1);
});
