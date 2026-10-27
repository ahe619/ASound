import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Exercise real routing with bounded fake browser/server engines, never model downloads.
const source = readFileSync(new URL("../app/js/speech.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/^export /gm, "")
  .replace('import("../kokoro/neural-tts.js")', "loadBrowserModule()")
  + "\nglobalThis.speech = { speechEngineOrder, voiceCapabilities, configureVoice, speak, stopSpeaking, renderSpeech, recheckSpeech, startNatural, speechStatus, onSpeechStatus, warmUp, prefetchSpeech };";
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const en = { name: "English", lang: "en-US" };

function fixture({ mobile = true, preference = "auto", voices = [en], system = true,
  health = null, search = "", failStart = false, healthGate = null, browserGate = null, synthesisGate = null } = {}) {
  const requests = [], utterances = [], sources = [], timers = new Map(), listeners = {};
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
    h() {}, icon() {}, str: value => String(value || ""), sentences: text => [text],
    clamp: (value, low, high) => Math.max(low, Math.min(high, value)), t: key => key,
    URLSearchParams, AbortController, Float32Array, CustomEvent: class {},
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
      return { configure() {}, onStatus() {}, async synthesize() {
        syntheses++;
        if (synthesisGate) await synthesisGate;
        return { pcm: new Float32Array(80), sr: 24000 };
      } };
    },
  });
  vm.runInContext("globalThis.window = globalThis;", context);
  vm.runInContext(source, context, { filename: "speech.js" });
  return { ...context.speech, prefs, requests, utterances, sources, timers,
    imports: () => imports, syntheses: () => syntheses,
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
  const f = fixture({ preference: "standard" });
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
