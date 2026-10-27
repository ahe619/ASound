// Speech output. Only installed/configured engines are eligible:
//   natural - Chatterbox on an NVIDIA GPU through the local server (optional; most human-sounding, slower)
//   native  - Kokoro through kokoro-onnx in the local server (POST /api/tts): fast, all CPU threads
//   browser - Kokoro in the page (kokoro/neural-tts.js, 8-bit on WebAssembly): slower fallback
//   system  - the browser's own voices (speechSynthesis): mobile automatic default when English is available
import { prefs } from "./state.js";
import { h, icon, str, sentences, clamp } from "./util.js";
import { t } from "./i18n.js";
import { deviceInfo } from "./device.js";

// Measured median pitch (Hz) of each voice, from tools/voice_pitch.py.
export const VOICES = [
  { id: "af_heart", name: "Heart", gender: "f", f0: 194 },
  { id: "af_bella", name: "Bella", gender: "f", f0: 198 },
  { id: "af_sarah", name: "Sarah", gender: "f", f0: 189 },
  { id: "af_aoede", name: "Aoede", gender: "f", f0: 173 },
  { id: "af_nova", name: "Nova", gender: "f", f0: 155 },
  { id: "af_sky", name: "Sky", gender: "f", f0: 155 },
  { id: "af_kore", name: "Kore", gender: "f", f0: 149 },
  { id: "af_nicole", name: "Nicole", gender: "f", f0: 147 },
  { id: "af_alloy", name: "Alloy", gender: "f", f0: 140 },
  { id: "am_eric", name: "Eric", gender: "m", f0: 154 },
  { id: "am_fenrir", name: "Fenrir", gender: "m", f0: 138 },
  { id: "am_liam", name: "Liam", gender: "m", f0: 125 },
  { id: "am_michael", name: "Michael", gender: "m", f0: 118 },
  { id: "am_puck", name: "Puck", gender: "m", f0: 111 },
  { id: "am_echo", name: "Echo", gender: "m", f0: 107 },
  { id: "am_onyx", name: "Onyx", gender: "m", f0: 83 },
];
export const voiceById = (id) => VOICES.find((v) => v.id === id) || VOICES[0];

// Voices closest in pitch to the learner's (log scale), best first.
export function recommendVoices(f0, count = 3) {
  if (!f0) return [];
  return [...VOICES].sort((a, b) => Math.abs(Math.log(a.f0 / f0)) - Math.abs(Math.log(b.f0 / f0))).slice(0, count);
}

const status = { engine: "", native: null, natural: "absent", browser: "off", error: "" };
const listeners = new Set();
const emit = () => listeners.forEach((fn) => { try { fn({ ...status }); } catch {} });
export const onSpeechStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const speechStatus = () => ({ ...status });

const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
let systemVoices = [];
let systemVoicesPending = true;
let audioCtx = null;
let active = [];          // playing AudioBufferSourceNodes
let seq = 0;
let speakingBtn = null;
let unlocked = false;
// Synthesized audio, least recently played first. "Listen" again (or the next card's word) plays at once instead
// of being generated again; capped by total length (three minutes of speech, about 17 MB) for phones.
const nativeCache = new Map();
const CACHE_SECONDS = 180;
function cachedAudio(key) {
  const buf = nativeCache.get(key);
  if (buf) { nativeCache.delete(key); nativeCache.set(key, buf); }
  return buf;
}
// The cached audio for `key`, or the generation already under way for it (a prefetch and a tap on "Listen" for the
// same word share one), or a new one from make().
const inflight = new Map();
function shared(key, make) {
  const hit = cachedAudio(key);
  if (hit) return Promise.resolve(hit);
  if (!inflight.has(key)) {
    inflight.set(key, Promise.resolve().then(make).then((buf) => keepAudio(key, buf)).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}
function keepAudio(key, buf) {
  nativeCache.set(key, buf);
  let total = 0;
  for (const b of nativeCache.values()) total += b.duration;
  for (const [k, b] of nativeCache) {
    if (total <= CACHE_SECONDS || k === key) break;
    total -= b.duration;
    nativeCache.delete(k);
  }
  return buf;
}
let browserMod = null;
let browserModulePromise = null;
let voiceConfig = null;

// A display mode does not change device capabilities. WebAssembly works without CUDA.
export function speechEngineOrder({ preference = "auto", mobile = false, native = false,
  browser = false, system = false, systemEnglish = false, natural = "absent" } = {}) {
  if (preference === "system") return system ? ["system"] : [];
  const standard = (mobile ? ["browser", "native"] : ["native", "browser"])
    .filter(engine => engine === "native" ? native : browser);
  if (system) {
    // Installing an optional voice pack must not make ordinary mobile playback heavier.
    // An explicit voice choice still uses the downloaded voices first.
    if (preference === "auto" && mobile && systemEnglish) standard.unshift("system");
    else standard.push("system");
  }
  if (preference === "natural" && native && natural === "ready") standard.unshift("natural");
  return standard;
}

export function voiceCapabilities() {
  const mobile = deviceInfo().mobile;
  const systemEnglish = systemVoices.length > 0;
  const system = !!synth && (systemEnglish || systemVoicesPending);
  const native = status.native === true;
  const browser = !!voiceConfig;
  const natural = native && ["off", "loading", "ready"].includes(status.natural);
  return {
    mobile, system, systemEnglish, systemPending: !!synth && systemVoicesPending,
    native, browser, natural, canNatural: natural,
    effective: speechEngineOrder({ preference: prefs.voiceEngine, mobile, native, browser, system, systemEnglish, natural: status.natural })[0] || "",
  };
}

const FORCE_WEB = new URLSearchParams(location.search).has("web"); // try the phone path on a computer
async function requestHealth(path = "api/health", options = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const response = await fetch(path, { cache: "no-store", ...options, signal: ctl.signal });
    if (!response.ok) throw new Error(`voice service ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function readHealth() {
  try {
    if (FORCE_WEB) throw new Error("browser-only mode");
    const health = await requestHealth();
    status.native = health.tts === true;
    status.natural = status.native && ["off", "loading", "ready"].includes(health.natural) ? health.natural : "absent";
  } catch {
    status.native = false;
    status.natural = "absent";
  } finally { emit(); }
}
const healthCheck = readHealth();
export const recheckSpeech = () => readHealth(); // after a voice pack was downloaded or removed

// Start the natural voice service and keep the status fresh until it is ready (it takes ~30 s the first time).
let naturalStarting = false;
export async function startNatural() {
  if (naturalStarting || !voiceCapabilities().canNatural || status.natural === "ready") return;
  naturalStarting = true;
  try {
    if (status.natural !== "loading") await requestHealth("api/natural/start", { method: "POST" });
    // Bound retries, and keep only one health request in flight at a time.
    for (let attempt = 0; attempt < 40; attempt++) {
      await readHealth();
      if (["ready", "absent"].includes(status.natural)) return;
      if (prefs.voiceEngine !== "natural") return;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error("natural voice did not become ready");
  } catch (error) {
    status.natural = "error";
    status.error = str(error?.message);
    emit();
  } finally { naturalStarting = false; }
}
healthCheck.then(() => { if (prefs.voiceEngine === "natural") startNatural(); });

function loadSystemVoices() {
  if (!synth) return;
  try {
    const voices = synth.getVoices();
    systemVoicesPending = !voices.length;
    systemVoices = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
  } catch { systemVoices = []; systemVoicesPending = true; }
  emit();
}
if (synth) {
  loadSystemVoices();
  synth.addEventListener?.("voiceschanged", loadSystemVoices);
}

function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Call from clicks that may lead to speech: browsers only allow audio after a user gesture.
export function unlockAudio() {
  ctx();
  if (synth && !unlocked) {
    unlocked = true;
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch {}
  }
}

export function paintSpeak(btn, on) {
  if (!btn) return;
  btn.classList.toggle("on", on);
  const cap = btn.dataset.caption;
  btn.replaceChildren(icon(on ? "stop" : "speaker"), ...(cap ? [on ? t("speech.stop") : cap] : []));
  btn.setAttribute("aria-label", on ? t("speech.stop") : btn.dataset.label || t("speech.play"));
}

export function stopSpeaking() {
  seq++;
  if (synth) synth.cancel();
  for (const s of active) { try { s.onended = null; s.stop(); } catch {} }
  active = [];
  paintSpeak(speakingBtn, false);
  speakingBtn = null;
}

export const isSpeaking = () => !!speakingBtn || active.length > 0;

// speak(text, button?, rateMultiplier?, onDone?, voiceId?) - plays sentence by sentence; the button shows play/stop.
export function speak(text, btn = null, rateMul = 1, onDone = null, voiceId = null) {
  const clean = str(text);
  if (!clean) { onDone && onDone(); return; }
  stopSpeaking();
  const mine = seq;
  speakingBtn = btn;
  paintSpeak(btn, true);
  const rate = clamp(prefs.rate * rateMul, 0.5, 1.6);
  const voice = voiceId || prefs.voice;
  let finished = false;
  const done = () => {
    if (mine !== seq || finished) return;
    finished = true;
    paintSpeak(speakingBtn, false);
    speakingBtn = null;
    active = [];
    document.dispatchEvent(new CustomEvent("asound:speech-end"));
    onDone && onDone();
  };
  route(clean, mine, rate, voice, done);
}

// Make the audio for a word or a short line ahead of time (the card on screen, the next card) so playing it starts
// at once. Uses the engine speak() would use first; system speech needs nothing. Failures are left to speak().
export function prefetchSpeech(text, rateMul = 1) {
  const clean = str(text);
  if (!clean || clean.length > 200 || status.native === null) return; // health check pending: engine unknown
  if (systemVoicesPending) loadSystemVoices(); // as speak() does: the list can arrive late (Android Chrome)
  const capabilities = voiceCapabilities();
  // Phones on "auto" speak with the system voice once its list arrives, so make nothing before then.
  if (capabilities.systemPending && capabilities.mobile && prefs.voiceEngine === "auto") return;
  const order = speechEngineOrder({ ...capabilities, preference: prefs.voiceEngine, natural: status.natural });
  // Mobile WASM inference competes with the current lesson. Keep downloaded voices
  // on demand instead of queuing work for cards the learner may skip.
  if (capabilities.mobile && order[0] === "browser") return;
  const chunk = { natural: naturalChunk, native: nativeChunk, browser: browserChunk }[order[0]];
  if (!chunk) return;
  const rate = clamp(prefs.rate * rateMul, 0.5, 1.6);
  const mine = seq, voice = prefs.voice;
  for (const part of chunk === nativeChunk ? [clean] : sentences(clean)) {
    if (chunk === browserChunk) { prefetchInPage(part, rate, voice, mine); continue; }
    Promise.resolve().then(() => {
      if (mine === seq) return chunk(part, rate, voice, mine);
    }).catch(() => {});
  }
}

// The in-page voice makes one line at a time and cannot drop a line it was given, so lines made ahead of time go
// to it one by one, newest kept: a tap on "Listen" then waits behind at most one line for a skipped card.
const ahead = [];
let aheadBusy = false;
function prefetchInPage(text, rate, voice, mine) {
  const key = `${voice}|${rate}|${text}`;
  const i = ahead.findIndex(job => job.key === key);
  if (i >= 0) ahead.splice(i, 1);
  ahead.push({ key, text, rate, voice, mine });
  if (ahead.length > 2) ahead.shift(); // this card and the next
  if (!aheadBusy) runAhead();
}
async function runAhead() {
  aheadBusy = true;
  try {
    while (ahead.length) {
      const job = ahead.shift();
      if (job.mine === seq) await browserChunk(job.text, job.rate, job.voice, job.mine).catch(() => {});
    }
  } finally { aheadBusy = false; }
}

async function route(text, mine, rate, voice, done) {
  // System speech can start immediately even if a static host's health check is pending.
  loadSystemVoices();
  const initial = voiceCapabilities();
  const quickSystem = prefs.voiceEngine === "system" || (prefs.voiceEngine === "auto" && initial.mobile && initial.systemEnglish);
  if (!quickSystem && status.native === null) await healthCheck;
  if (mine !== seq) return;
  loadSystemVoices();
  const capabilities = voiceCapabilities();
  const order = speechEngineOrder({ ...capabilities, preference: prefs.voiceEngine, natural: status.natural });
  if (capabilities.canNatural && prefs.voiceEngine === "natural" && status.natural !== "ready") startNatural();
  status.error = "";
  for (const engine of order) {
    try {
      if (engine === "natural") await playAudio(text, mine, rate, voice, done, naturalChunk);
      else if (engine === "native") await playAudio(text, mine, rate, voice, done, nativeChunk);
      else if (engine === "browser") await playAudio(text, mine, rate, voice, done, browserChunk);
      else if (engine === "system") playSystem(text, mine, rate, done);
      if (mine !== seq) return;
      if (status.engine !== engine) { status.engine = engine; emit(); }
      return;
    } catch (e) {
      if (mine !== seq) return;
      console.warn(`speech engine ${engine} failed`, e);
      status.error = str(e && e.message);
    }
  }
  if (!order.length) status.error = t(prefs.voiceEngine === "system" ? "speech.noEnglishVoice" : "speech.voicePackRequired");
  status.engine = "";
  emit();
  done();
}

function nativeChunk(text, rate, voice) {
  return shared(`${voice}|${rate}|${text}`, async () => {
    const res = await fetch("api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, speed: rate }),
    });
    if (!res.ok) throw new Error(`native speech ${res.status}`);
    return ctx().decodeAudioData(await res.arrayBuffer());
  });
}

function naturalChunk(text, rate, voice) {
  return shared(`natural|${voice}|${text}`, async () => {
    const res = await fetch("api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, speed: rate, engine: "natural" }),
    });
    if (!res.ok) { readHealth(); throw new Error(`natural speech ${res.status}`); }
    return ctx().decodeAudioData(await res.arrayBuffer());
  });
}

// Where the in-page voice finds its files (js/packs.js engineConfig): this computer, or the download cache.
export function configureVoice(cfg) {
  if (JSON.stringify(cfg || null) !== JSON.stringify(voiceConfig)) {
    stopSpeaking();
    for (const key of [...nativeCache.keys()]) if (key.startsWith("browser|")) nativeCache.delete(key); // another voice model
  }
  voiceConfig = cfg || null;
  if (browserMod && browserMod.configure && cfg) browserMod.configure(cfg);
  if (!cfg && browserMod?.dispose) browserMod.dispose();
  if (!cfg) status.browser = "off";
  emit();
}

async function browserChunk(text, rate, voice, mine) {
  if (!voiceConfig) throw new Error(t("speech.voicePackRequired"));
  if (!browserModulePromise) {
    browserModulePromise = import("../kokoro/neural-tts.js").then(mod => {
      browserMod = mod;
      if (voiceConfig && mod.configure) mod.configure(voiceConfig);
      mod.onStatus((s) => { status.browser = s.state; emit(); });
      return mod;
    }).catch(error => { browserModulePromise = null; throw error; });
  }
  await browserModulePromise;
  if (mine !== undefined && mine !== seq) throw new Error("speech cancelled");
  if (!voiceConfig) throw new Error(t("speech.voicePackRequired"));
  const buf = await shared(`browser|${voice}|${rate}|${text}`, async () => {
    const { pcm, sr } = await browserMod.synthesize(text, { voice, speed: rate });
    const out = ctx().createBuffer(1, pcm.length, sr);
    out.copyToChannel(pcm, 0);
    return out;
  });
  if (mine !== undefined && mine !== seq) throw new Error("speech cancelled");
  return buf;
}

// The native engine is fast, so it gets the whole text at once: the intonation then flows across sentences.
// The slower in-browser engine goes sentence by sentence so playback can start early.
async function playAudio(text, mine, rate, voice, done, chunk) {
  const a = ctx();
  if (!a) throw new Error("audio is not available");
  // (the natural engine is slower, so it also goes sentence by sentence)
  const parts = chunk === nativeChunk && text.length <= 600 ? [text] : sentences(text);
  let at = 0, last = null;
  for (const part of parts) {
    if (mine !== seq) return;
    const buf = await chunk(part, rate, voice, mine);
    if (mine !== seq) return;
    const src = a.createBufferSource();
    src.buffer = buf;
    src.connect(a.destination);
    const start = Math.max(a.currentTime + 0.03, at);
    src.start(start);
    at = start + buf.duration;
    active.push(src);
    last = src;
  }
  if (!last) { done(); return; }
  last.onended = done;
}

function playSystem(text, mine, rate, done) {
  if (!synth || (!systemVoices.length && !systemVoicesPending)) throw new Error(t("speech.noEnglishVoice"));
  const voice = systemVoices.find((v) => /^en[-_]us/i.test(v.lang)) || systemVoices[0] || null;
  setTimeout(() => {
    if (mine !== seq) return;
    const parts = sentences(text);
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "en-US";
      u.rate = rate;
      u.onerror = () => {
        if (mine !== seq) return;
        synth.cancel();
        status.engine = "";
        status.error = t("speech.noEnglishVoice");
        emit();
        done();
      };
      if (i === parts.length - 1) u.onend = done;
      synth.speak(u);
    });
  }, 60);
}

// Speak button: with a caption it is a labelled .btn ("Listen"), otherwise a small icon button.
export function speakBtn(text, label, caption = "", rateMul = 1) {
  const b = h("button", { type: "button", class: caption ? "btn speak" : "icon-btn sm speak", "data-label": label || t("speech.play"), "data-caption": caption || null });
  paintSpeak(b, false);
  b.addEventListener("click", () => {
    unlockAudio();
    if (speakingBtn === b) stopSpeaking();
    else speak(text, b, rateMul);
  });
  return b;
}

// Synthesize without playing, for features that process the sound (a phone-line filter, a listening game).
// Resolves one AudioBuffer; play it through audioContext().
export async function renderSpeech(text, { voice = prefs.voice, rate = prefs.rate } = {}) {
  const clean = str(text);
  if (!clean) throw new Error("empty text");
  if (status.native === null) await healthCheck;
  const r = clamp(rate, 0.5, 1.6);
  const native = !!status.native;
  if (!native && !voiceConfig) throw new Error(t("speech.voicePackRequired"));
  const parts = native && clean.length <= 600 ? [clean] : sentences(clean);
  const bufs = [];
  for (const p of parts) {
    let b = null;
    if (native) b = await nativeChunk(p, r, voice).catch(() => null);
    if (!b) b = await browserChunk(p, r, voice);
    bufs.push(b);
  }
  if (bufs.length === 1) return bufs[0];
  const a = ctx();
  const rate0 = bufs[0].sampleRate;
  const gap = Math.round(rate0 * 0.08);
  const total = bufs.reduce((n, b) => n + b.length + gap, 0);
  const out = a.createBuffer(1, total, rate0);
  const data = out.getChannelData(0);
  let at = 0;
  for (const b of bufs) { data.set(b.getChannelData(0).subarray(0, Math.min(b.length, total - at)), at); at += b.length + gap; }
  return out;
}
export const audioContext = () => ctx();

// Warm the native engine so the first sentence is quick.
export function warmUp() {
  healthCheck.then(() => {
    if (prefs.voiceEngine !== "system" && voiceCapabilities().effective === "native") {
      nativeChunk("Hi.", clamp(prefs.rate, 0.5, 1.6), prefs.voice).catch(() => {});
    }
  });
}
