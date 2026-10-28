// ASound neural text-to-speech: Kokoro-82M (Apache-2.0) through kokoro-js (Apache-2.0), in a module worker.
// The worker's fetch is pointed at app/models/ on this computer, or (phones) at the download cache.
//
// This is the in-browser fallback; ASound normally speaks through the native engine in server.py.

const BASE = new URL("./", import.meta.url).href;
const MODELS = new URL("../models/onnx-community/Kokoro-82M-v1.0-ONNX/", import.meta.url).href;

const WORKER_SRC = `
const BASE = ${JSON.stringify(BASE)};
const MODELS = ${JSON.stringify(MODELS)};
const HF = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/";
// The files are already on this computer, so skip the browser's Cache Storage (copying a 310 MB model into it
// is slow and can fail).
const noCache = { match: async () => undefined, put: async () => {}, add: async () => {}, delete: async () => false, keys: async () => [] };
const noCaches = { open: async () => noCache, match: async () => undefined, has: async () => false, keys: async () => [], delete: async () => false };
const realCaches = self.caches;
try { Object.defineProperty(self, "caches", { value: noCaches, configurable: true }); } catch {}
const realFetch = self.fetch.bind(self);
let where = { mode: "desktop" };  // set by "init": desktop = files on this computer; web = download cache / source
const REPO = "onnx-community/Kokoro-82M-v1.0-ONNX/";
async function fromWeb(rest) {
  try {
    const hit = await (await realCaches.open(where.cache)).match(where.canon + REPO + rest);
    if (hit) return hit;
  } catch {}
  return realFetch(where.base + REPO + "resolve/main/" + rest);
}
self.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(HF)) return where.mode === "web" ? fromWeb(url.slice(HF.length)) : realFetch(MODELS + url.slice(HF.length));
  return realFetch(input, init);
};
let tts = null;
let generationQueue = Promise.resolve();
const invalidAudio = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return true; return false; };
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    try {
      if (m.where) where = m.where;
      const t0 = performance.now();
      const mod = await import(BASE + "kokoro.web.js");
      mod.env.wasmPaths = BASE + "ort-cpu/"; // matching WASM-only runtime; the recognizer keeps its own runtime
      tts = await mod.KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: m.dtype, device: m.device });
      postMessage({ type: "ready", ms: Math.round(performance.now() - t0), device: m.device, dtype: m.dtype });
    } catch (err) {
      postMessage({ type: "error", error: String((err && err.message) || err) });
    }
  } else if (m.type === "gen") {
    // One inference at a time on the shared WASM session. Validate the requested
    // audio instead of spending the first playback on an extra test sentence.
    generationQueue = generationQueue.then(async () => {
      const t0 = performance.now();
      try {
        const out = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
        const pcm = out.audio;
        if (invalidAudio(pcm)) throw new Error("the voice model produced invalid audio on this device");
        postMessage({ type: "audio", id: m.id, pcm, sr: out.sampling_rate, ms: Math.round(performance.now() - t0) }, [pcm.buffer]);
      } catch (err) {
        postMessage({ type: "genError", id: m.id, error: String((err && err.message) || err), ms: Math.round(performance.now() - t0) });
      }
    });
  }
};
`;

let worker = null;
let readyPromise = null;
let rejectStart = null;
let startTimer = null;
let revision = 0;
let where = { mode: "desktop" };
const INIT_TIMEOUT_MS = 120000;
const GENERATION_TIMEOUT_MS = 120000;

// Where the files are (from js/packs.js): {mode: "desktop"} or {mode: "web", base, cache, canon}.
export function configure(cfg) {
  const next = cfg && cfg.mode === "web" ? { mode: "web", base: cfg.base, cache: cfg.cache, canon: cfg.canon } : { mode: "desktop" };
  if (JSON.stringify(next) === JSON.stringify(where)) return;
  where = next;
  reset(new Error("voice configuration changed"));
  emit();
}
let state = "off";            // off | loading | ready | error
let lastError = "";
let engine = "";
let seq = 0;
const pending = new Map();
const jobs = [];
let currentJob = null;
let initMs = null;
let generationMs = null;
const listeners = new Set();
const cache = new Map();      // `${voice}|${speed}|${text}` -> {pcm, sr}
const inFlight = new Map();   // identical pending requests share one inference
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
let cacheBytes = 0;

function reset(error) {
  revision++;
  clearTimeout(startTimer);
  startTimer = null;
  if (worker) { try { worker.terminate(); } catch {} }
  worker = null;
  if (rejectStart) rejectStart(error);
  rejectStart = null;
  readyPromise = null;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.signal?.removeEventListener("abort", p.abort);
    p.reject(error);
  }
  pending.clear();
  jobs.length = 0;
  currentJob = null;
  inFlight.clear();
  cache.clear();
  cacheBytes = 0;
  state = "off";
  engine = "";
  lastError = "";
  initMs = null;
  generationMs = null;
}

function failWorker(error) {
  reset(error);
  state = "error";
  lastError = error.message;
  emit();
}

const cancelled = () => Object.assign(new Error("voice synthesis cancelled"), { name: "AbortError", code: "cancelled" });
const timedOut = (phase) => Object.assign(new Error(`Voice ${phase} timed out after 120 seconds. Retry or use basic speech.`), {
  code: phase === "initialization" ? "voice_init_timeout" : "voice_generation_timeout",
});

// Cancelling one caller during the shared initialization must not reject the
// other callers or restart a worker which is still making progress.
function waitForLoad(signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  const loading = load();
  if (!signal) return loading;
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    loading.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function pump() {
  if (currentJob || !jobs.length || !worker || state !== "ready") return;
  const job = jobs.shift();
  currentJob = job;
  job.timer = setTimeout(() => {
    if (currentJob === job) failWorker(timedOut("generation"));
  }, GENERATION_TIMEOUT_MS);
  try { worker.postMessage({ type: "gen", id: job.id, text: job.text, voice: job.voice, speed: job.speed }); }
  catch (error) { failWorker(error); return; }
  emit();
}

function generate(text, voice, speed, signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const job = { id: ++seq, text, voice, speed, signal, resolve, reject, cancelled: false, timer: null, abort: null };
    job.abort = () => {
      job.cancelled = true;
      // ONNX cannot stop a running inference. Keep that slot until its reply,
      // discard its audio, and never send cancelled queued work to the worker.
      if (currentJob !== job) {
        const at = jobs.indexOf(job);
        if (at >= 0) jobs.splice(at, 1);
        pending.delete(job.id);
      }
      signal.removeEventListener("abort", job.abort);
      reject(cancelled());
    };
    pending.set(job.id, job);
    jobs.push(job);
    signal?.addEventListener("abort", job.abort, { once: true });
    if (signal?.aborted) job.abort();
    pump();
  });
}

function remember(key, out) {
  if (out.pcm.byteLength > MAX_CACHE_BYTES) return;
  if (cache.has(key)) { cacheBytes -= cache.get(key).pcm.byteLength; cache.delete(key); }
  cache.set(key, out);
  cacheBytes += out.pcm.byteLength;
  while (cache.size > 150 || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).pcm.byteLength;
    cache.delete(oldest);
  }
}

const emit = () => listeners.forEach((fn) => { try { fn(status()); } catch {} });
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function status() {
  return { state, error: lastError, engine, loaded: state === "ready" ? 1 : 0, total: 1,
    initMs, generationMs, generating: !!currentJob };
}
export function dispose() {
  reset(new Error("voice removed"));
  emit();
}

function start(device, dtype) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
    let current;
    try { current = new Worker(url, { type: "module", name: "kokoro-tts" }); }
    finally { URL.revokeObjectURL(url); }
    worker = current;
    rejectStart = reject;
    startTimer = setTimeout(() => { if (worker === current) failWorker(timedOut("initialization")); }, INIT_TIMEOUT_MS);
    current.onmessage = (e) => {
      if (worker !== current) return;
      const m = e.data;
      if (m.type === "ready") {
        clearTimeout(startTimer);
        startTimer = null;
        rejectStart = null;
        resolve(m);
      }
      else if (m.type === "error") failWorker(new Error(m.error));
      else if (m.type === "audio" || m.type === "genError") {
        const p = pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        p.signal?.removeEventListener("abort", p.abort);
        pending.delete(m.id);
        if (currentJob === p) currentJob = null;
        generationMs = Number.isFinite(m.ms) ? m.ms : null;
        if (!p.cancelled) {
          if (m.type === "audio") p.resolve({ pcm: m.pcm, sr: m.sr, ms: m.ms });
          else p.reject(new Error(m.error));
        }
        pump();
        emit();
      }
    };
    current.onerror = (e) => {
      if (worker !== current) return;
      const error = new Error(e.message || "voice worker failed");
      failWorker(error);
    };
    current.postMessage({ type: "init", device, dtype, where });
  });
}

export function load() {
  if (readyPromise) return readyPromise;
  const mine = revision;
  state = "loading";
  lastError = "";
  emit();
  readyPromise = (async () => {
    // WebGPU output was unreliable on an NVIDIA RTX 50 (NaN audio, even in fp32), so the browser fallback uses
    // the CPU only. The main path is the native engine behind /api/tts (see server.py).
    const r = await start("wasm", "q8");
    if (mine !== revision) throw new Error("voice configuration changed");
    initMs = Number.isFinite(r.ms) ? r.ms : null;
    engine = "wasm/q8";
    state = "ready";
    emit();
    return r.ms;
  })().catch((err) => {
    // A cancelled older load must not reset a replacement worker's state.
    if (mine !== revision) throw err;
    reset(err);
    state = "error";
    lastError = String((err && err.message) || err);
    emit();
    throw err;
  });
  return readyPromise;
}

export async function synthesize(text, { voice = "af_heart", speed = 1, signal } = {}) {
  if (signal?.aborted) throw cancelled();
  const key = `${voice}|${speed}|${text}`;
  if (cache.has(key)) { const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit; }
  // Signal callers own their subscription; aborting one never cancels another
  // caller for the same text. All callers still reuse completed audio.
  if (!signal && inFlight.has(key)) return inFlight.get(key);
  const mine = revision;
  const promise = (async () => {
    await waitForLoad(signal);
    if (signal?.aborted) throw cancelled();
    if (mine !== revision) throw new Error("voice configuration changed");
    const out = await generate(text, voice, speed, signal);
    if (signal?.aborted) throw cancelled();
    if (mine !== revision) throw new Error("voice configuration changed");
    remember(key, out);
    return out;
  })().finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); });
  if (!signal) inFlight.set(key, promise);
  return promise;
}

// Testing hook: load one specific engine.
export async function loadWith(device, dtype) {
  const r = await start(device, dtype);
  initMs = Number.isFinite(r.ms) ? r.ms : null;
  engine = `${device}/${dtype}`;
  state = "ready";
  readyPromise = Promise.resolve(r.ms);
  emit();
  return r.ms;
}

// The model files are local, so loading is always quick enough to start right away.
export async function isCached() { return true; }
