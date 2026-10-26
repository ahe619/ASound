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
const hasNaN = (a) => { for (let i = 0; i < a.length; i += 97) if (Number.isNaN(a[i])) return true; return false; };
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    try {
      if (m.where) where = m.where;
      const t0 = performance.now();
      const mod = await import(BASE + "kokoro.web.js");
      mod.env.wasmPaths = BASE + "ortlib/";
      tts = await mod.KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: m.dtype, device: m.device });
      const warm = await tts.generate("Hello there.", { voice: "af_heart" });
      if (hasNaN(warm.audio)) throw new Error("the voice model produced invalid audio on this device");
      postMessage({ type: "ready", ms: Math.round(performance.now() - t0), device: m.device, dtype: m.dtype });
    } catch (err) {
      postMessage({ type: "error", error: String((err && err.message) || err) });
    }
  } else if (m.type === "gen") {
    try {
      const t0 = performance.now();
      const out = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
      const pcm = out.audio;
      postMessage({ type: "audio", id: m.id, pcm, sr: out.sampling_rate, ms: Math.round(performance.now() - t0) }, [pcm.buffer]);
    } catch (err) {
      postMessage({ type: "genError", id: m.id, error: String((err && err.message) || err) });
    }
  }
};
`;

let worker = null;
let readyPromise = null;
let where = { mode: "desktop" };

// Where the files are (from js/packs.js): {mode: "desktop"} or {mode: "web", base, cache, canon}.
export function configure(cfg) {
  const next = cfg && cfg.mode === "web" ? { mode: "web", base: cfg.base, cache: cfg.cache, canon: cfg.canon } : { mode: "desktop" };
  if (JSON.stringify(next) === JSON.stringify(where)) return;
  where = next;
  if (worker) { try { worker.terminate(); } catch {} worker = null; readyPromise = null; state = "off"; emit(); }
}
let state = "off";            // off | loading | ready | error
let lastError = "";
let engine = "";
let seq = 0;
const pending = new Map();
const listeners = new Set();
const cache = new Map();      // `${voice}|${speed}|${text}` -> {pcm, sr}

const emit = () => listeners.forEach((fn) => { try { fn(status()); } catch {} });
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function status() { return { state, error: lastError, engine, loaded: state === "ready" ? 1 : 0, total: 1 }; }

function start(device, dtype) {
  return new Promise((resolve, reject) => {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })), { type: "module", name: "kokoro-tts" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") resolve(m);
      else if (m.type === "error") reject(new Error(m.error));
      else if (m.type === "audio" || m.type === "genError") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.type === "audio") p.resolve({ pcm: m.pcm, sr: m.sr, ms: m.ms });
        else p.reject(new Error(m.error));
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || "voice worker failed"));
    worker.postMessage({ type: "init", device, dtype, where });
  });
}

export function load() {
  if (readyPromise) return readyPromise;
  state = "loading";
  emit();
  readyPromise = (async () => {
    // WebGPU output was unreliable on an NVIDIA RTX 50 (NaN audio, even in fp32), so the browser fallback uses
    // the CPU only. The main path is the native engine behind /api/tts (see server.py).
    const plans = [["wasm", "q8"]];
    let lastErr = null;
    for (const [device, dtype] of plans) {
      try {
        const r = await start(device, dtype);
        engine = `${device}/${dtype}`;
        state = "ready";
        emit();
        return r.ms;
      } catch (err) {
        lastErr = err;
        try { worker && worker.terminate(); } catch {}
        worker = null;
      }
    }
    throw lastErr;
  })().catch((err) => {
    state = "error";
    lastError = String((err && err.message) || err);
    readyPromise = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    emit();
    throw err;
  });
  return readyPromise;
}

export async function synthesize(text, { voice = "af_heart", speed = 1 } = {}) {
  const key = `${voice}|${speed}|${text}`;
  if (cache.has(key)) { const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit; }
  await load();
  const id = ++seq;
  const out = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: "gen", id, text, voice, speed });
  });
  cache.set(key, out);
  if (cache.size > 150) cache.delete(cache.keys().next().value);
  return out;
}

// Testing hook: load one specific engine.
export async function loadWith(device, dtype) {
  const r = await start(device, dtype);
  engine = `${device}/${dtype}`;
  state = "ready";
  readyPromise = Promise.resolve(r.ms);
  emit();
  return r.ms;
}

// The model files are local, so loading is always quick enough to start right away.
export async function isCached() { return true; }
