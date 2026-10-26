// Speech output. Engines, best first:
//   natural - Chatterbox on an NVIDIA GPU through the local server (optional; most human-sounding, slower)
//   native  - Kokoro through kokoro-onnx in the local server (POST /api/tts): fast, all CPU threads
//   browser - Kokoro in the page (kokoro/neural-tts.js, 8-bit on WebAssembly): slower fallback
//   system  - the browser's own voices (speechSynthesis): last resort
import { prefs } from "./state.js";
import { h, icon, str, sentences, clamp } from "./util.js";
import { t } from "./i18n.js";

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
let audioCtx = null;
let active = [];          // playing AudioBufferSourceNodes
let seq = 0;
let speakingBtn = null;
let unlocked = false;
const nativeCache = new Map();
let browserMod = null;

const FORCE_WEB = new URLSearchParams(location.search).has("web"); // try the phone path on a computer
function readHealth() {
  if (FORCE_WEB) { status.native = false; emit(); return Promise.resolve(); }
  return fetch("api/health", { cache: "no-store" })
    .then((r) => r.json())
    .then((j) => { status.native = !!j.tts; status.natural = j.natural || "absent"; })
    .catch(() => { status.native = false; })
    .finally(emit);
}
const healthCheck = readHealth();
export const recheckSpeech = () => readHealth(); // after a voice pack was downloaded or removed

// Start the natural voice service and keep the status fresh until it is ready (it takes ~30 s the first time).
let naturalPoll = 0;
export function startNatural() {
  if (status.natural === "absent" || status.natural === "ready") return;
  fetch("api/natural/start", { method: "POST" }).then(readHealth).catch(() => {});
  clearInterval(naturalPoll);
  naturalPoll = setInterval(async () => {
    await readHealth();
    if (status.natural === "ready" || status.natural === "absent") clearInterval(naturalPoll);
  }, 3000);
}
healthCheck.then(() => { if (prefs.voiceEngine === "natural") startNatural(); });

function loadSystemVoices() {
  if (!synth) return;
  try { systemVoices = synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang)); } catch { systemVoices = []; }
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
  const done = () => {
    if (mine !== seq) return;
    paintSpeak(speakingBtn, false);
    speakingBtn = null;
    active = [];
    document.dispatchEvent(new CustomEvent("asound:speech-end"));
    onDone && onDone();
  };
  route(clean, mine, rate, voice, done);
}

async function route(text, mine, rate, voice, done) {
  if (status.native === null) await healthCheck;
  if (mine !== seq) return;
  const order = status.native ? ["native", "browser", "system"] : ["browser", "system"];
  if (status.native && prefs.voiceEngine === "natural") {
    if (status.natural === "ready") order.unshift("natural");
    else startNatural();
  }
  for (const engine of order) {
    try {
      if (engine === "natural") await playAudio(text, mine, rate, voice, done, naturalChunk);
      else if (engine === "native") await playAudio(text, mine, rate, voice, done, nativeChunk);
      else if (engine === "browser") await playAudio(text, mine, rate, voice, done, browserChunk);
      else if (engine === "system") { if (!systemVoices.length && !synth) throw new Error("no system voice"); playSystem(text, mine, rate, done); }
      if (status.engine !== engine) { status.engine = engine; emit(); }
      return;
    } catch (e) {
      if (mine !== seq) return;
      console.warn(`speech engine ${engine} failed`, e);
      status.error = str(e && e.message);
    }
  }
  done();
}

async function nativeChunk(text, rate, voice) {
  const key = `${voice}|${rate}|${text}`;
  if (nativeCache.has(key)) return nativeCache.get(key);
  const res = await fetch("api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, speed: rate }),
  });
  if (!res.ok) throw new Error(`native speech ${res.status}`);
  const buf = await ctx().decodeAudioData(await res.arrayBuffer());
  nativeCache.set(key, buf);
  if (nativeCache.size > 200) nativeCache.delete(nativeCache.keys().next().value);
  return buf;
}

async function naturalChunk(text, rate, voice) {
  const key = `natural|${voice}|${text}`;
  if (nativeCache.has(key)) return nativeCache.get(key);
  const res = await fetch("api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, speed: rate, engine: "natural" }),
  });
  if (!res.ok) { readHealth(); throw new Error(`natural speech ${res.status}`); }
  const buf = await ctx().decodeAudioData(await res.arrayBuffer());
  nativeCache.set(key, buf);
  return buf;
}

// Where the in-page voice finds its files (js/packs.js engineConfig): this computer, or the download cache.
let voiceConfig = null;
export function configureVoice(cfg) {
  voiceConfig = cfg;
  if (browserMod && browserMod.configure) browserMod.configure(cfg);
}

async function browserChunk(text, rate, voice) {
  if (!browserMod) {
    browserMod = await import("../kokoro/neural-tts.js");
    if (voiceConfig && browserMod.configure) browserMod.configure(voiceConfig);
    browserMod.onStatus((s) => { status.browser = s.state; emit(); });
  }
  const { pcm, sr } = await browserMod.synthesize(text, { voice, speed: rate });
  const a = ctx();
  const buf = a.createBuffer(1, pcm.length, sr);
  buf.copyToChannel(pcm, 0);
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
    const buf = await chunk(part, rate, voice);
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
  const voice = systemVoices.find((v) => /^en[-_]us/i.test(v.lang)) || systemVoices[0] || null;
  setTimeout(() => {
    if (mine !== seq) return;
    const parts = sentences(text);
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "en-US";
      u.rate = rate;
      u.onerror = done;
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
  healthCheck.then(() => { if (status.native) nativeChunk("Hi.", clamp(prefs.rate, 0.5, 1.6), prefs.voice).catch(() => {}); });
}
