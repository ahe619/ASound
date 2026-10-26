// Model packs: which local AI models are installed, downloading more, and which ones the engines use.
//   desktop - ASound.exe / server.py: the local server downloads into app/models (GET/POST api/packs)
//   web     - a phone or a plain browser, no local server: the browser downloads into its own storage
//             (Cache Storage for speech files, keyed independently of the mirror; WebLLM's own cache for the LLM)
// Add ?web to the address to try the phone path on a computer.
import { prefs, savePrefs } from "./state.js";

export const CACHE = "asound-models-v1";
export const CANON = "https://models.asound.invalid/"; // cache keys look the same whichever source served the file
const FORCE_WEB = new URLSearchParams(location.search).has("web");

let catalog = null;
let mode = "web";
let gpu = { webgpu: false, f16: false, vendor: "", mobile: false };
let status = {};               // pack id -> {state, done, total, rate?, error?}
let free = null;
let resolved = null;           // the source "auto" picked
const listeners = new Set();
const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } });
export const onPacks = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export const packMode = () => mode;
export const gpuInfo = () => ({ ...gpu });
export const packList = () => (catalog ? catalog.packs : []);
export const packById = (id) => packList().find((p) => p.id === id) || null;
export const packStatus = (id) => status[id] || { state: "absent", done: 0, total: (packById(id) || {}).size || 0 };
export const freeSpace = () => free;
export const resolvedSource = () => resolved;

export async function initPacks() {
  catalog = await fetch("packs.json", { cache: "no-cache" }).then((r) => r.json());
  mode = FORCE_WEB ? "web" : await fetch("api/health", { cache: "no-store" }).then((r) => r.json()).then((j) => (j.packs ? "desktop" : "web")).catch(() => "web");
  gpu = await probeGpu();
  await refresh();
}

async function probeGpu() {
  const ua = navigator.userAgent || "";
  const info = { webgpu: false, f16: false, vendor: "", mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || !!(navigator.userAgentData && navigator.userAgentData.mobile) };
  if (new URLSearchParams(location.search).has("nogpu")) return info; // try the no-WebGPU path on a computer
  try {
    const a = navigator.gpu && (await navigator.gpu.requestAdapter());
    if (a) {
      info.webgpu = true;
      info.f16 = a.features.has("shader-f16");
      info.vendor = String((a.info && (a.info.vendor || a.info.description)) || "");
    }
  } catch {}
  return info;
}

/* ---------- choices ---------- */

// The packs this device should start with.
export function recommended() {
  const strong = /nvidia|amd|ati|radeon/i.test(gpu.vendor);
  return {
    // phones: the medium model only on ones with plenty of memory (navigator.deviceMemory tops out at 8)
    llm: !gpu.webgpu ? "llm-cpu" : gpu.mobile ? ((navigator.deviceMemory || 4) >= 8 ? "llm-2b" : "llm-0.8b") : strong ? "llm-4b" : "llm-2b",
    asr: gpu.mobile || !gpu.webgpu ? "asr-tiny" : "asr-base",
  };
}

// group ("llm-2b") -> the pack id this device needs ("llm-2b-f16" when the GPU has 16-bit shaders)
export function variant(group) {
  if (!group.startsWith("llm-") || group === "llm-cpu") return group;
  return `${group}-${gpu.f16 ? "f16" : "f32"}`;
}
const installed = (id) => packStatus(id).state === "installed";
const groupInstalled = (group) => installed(variant(group));

// What the engines should load now: the chosen packs if installed, else any installed one of the same kind.
export function activePacks() {
  const rec = recommended();
  const firstOf = (wanted, order) => [wanted, ...order].find((g) => g && groupInstalled(g)) || null;
  // without WebGPU only the processor model can run
  const llms = gpu.webgpu ? ["llm-4b", "llm-2b", "llm-0.8b", "llm-cpu"] : ["llm-cpu"];
  return {
    llm: firstOf(llms.includes(prefs.llm) ? prefs.llm : rec.llm, llms),
    asr: firstOf(prefs.asr || rec.asr, ["asr-base", "asr-tiny"]),
    voice: groupInstalled("voice") ? "voice" : null,
    voiceHq: groupInstalled("voice-hq"),
    helpAsr: groupInstalled("help-asr"),
  };
}

// The minimum to practise: a language model, speech recognition and a voice.
export function ready() {
  const a = activePacks();
  return !!(a.llm && a.asr && a.voice);
}

/* ---------- where files come from ---------- */

let probing = null;
async function pickSource() {
  if (prefs.source !== "auto") return prefs.source;
  if (resolved) return resolved;
  if (!probing) {
    probing = (async () => {
      const tryOne = async (name) => {
        const t0 = performance.now();
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 6000);
        try {
          const r = await fetch(`${catalog.sources[name].models}/onnx-community/moonshine-tiny-ONNX/resolve/main/config.json`, { signal: ctl.signal, cache: "no-store" });
          if (!r.ok) throw new Error(String(r.status));
          await r.text();
          return { name, ms: performance.now() - t0 };
        } finally { clearTimeout(timer); }
      };
      const results = (await Promise.allSettled(Object.keys(catalog.sources).map(tryOne))).filter((r) => r.status === "fulfilled").map((r) => r.value);
      results.sort((a, b) => a.ms - b.ms);
      resolved = results.length ? results[0].name : "hf";
      probing = null;
      emit();
      return resolved;
    })();
  }
  return probing;
}

export function fileUrl(f, source) {
  const src = catalog.sources[source];
  return f.repo ? `${src.models}/${f.repo}/resolve/main/${f.path}` : `${src.libs}/${f.lib}`;
}
export const canonKey = (f) => CANON + (f.repo ? `${f.repo}/${f.path}` : f.path);

// Engine settings for a pack: local files on the desktop, the download source on the web.
export async function engineConfig(id, sourceName = null) {
  const p = packById(id);
  if (!p) return null;
  if (mode === "desktop") {
    const base = new URL("models/", location.href).href;
    return {
      mode, base, asr: p.asr,
      llm: p.llm ? { ...p.llm, model: `${base}${p.llm.repo}/`, lib: `${base}${p.llm.lib}` }
        : p.cpu ? { kind: "cpu", model_id: p.id, ctx: p.cpu.ctx, url: `${base}${p.cpu.repo}/${p.cpu.path}` } : null,
    };
  }
  // WebLLM caches by address, so a language model keeps the source it was downloaded from.
  const source = sourceName || (p.kind === "llm" && llmSource(id)) || (await pickSource());
  const src = catalog.sources[source];
  return {
    mode, base: `${src.models}/`, cache: CACHE, canon: CANON,
    llm: p.llm ? { ...p.llm, model: `${src.models}/${p.llm.repo}`, lib: `${src.libs}/${p.llm.lib.replace(/^libs\//, "")}` }
      : p.cpu ? { kind: "cpu", model_id: p.id, ctx: p.cpu.ctx, url: `${src.models}/${p.cpu.repo}/resolve/main/${p.cpu.path}`, cache: CACHE, key: canonKey(p.files[0]) } : null,
    asr: p.asr,
  };
}

/* ---------- status ---------- */

let pollTimer = 0;
export async function refresh() {
  if (!catalog) return;
  if (mode === "desktop") {
    try {
      const j = await fetch("api/packs", { cache: "no-store" }).then((r) => r.json());
      status = j.packs || {};
      free = j.free;
      if (j.resolved) resolved = j.resolved;
    } catch {}
    const busy = Object.values(status).some((s) => s.state === "downloading" || s.state === "queued");
    clearTimeout(pollTimer);
    if (busy) pollTimer = setTimeout(refresh, 1000);
  } else {
    await webStatus();
  }
  emit();
}

async function webStatus() {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch {}
  for (const p of packList()) {
    const cur = status[p.id];
    if (cur && (cur.state === "downloading" || cur.state === "queued")) continue;
    if (p.kind === "llm") {
      const have = !!llmSource(p.id);
      status[p.id] = { state: have ? "installed" : cur && cur.error ? "partial" : "absent", done: have ? p.size : 0, total: p.size, error: cur && cur.error };
      continue;
    }
    let have = 0;
    if (cache) for (const f of p.files) { if (await cache.match(canonKey(f))) have += f.size; }
    status[p.id] = { state: have >= p.size ? "installed" : have ? "partial" : "absent", done: have, total: p.size, error: cur && cur.error };
  }
  try { const est = await navigator.storage.estimate(); free = est.quota - est.usage; } catch { free = null; }
}
// WebLLM keeps its own cache; we remember which language models finished loading once, and from where.
const FLAG = "asound.llmCached.v1";
function llmSource(id) { try { return JSON.parse(localStorage.getItem(FLAG) || "{}")[id] || ""; } catch { return ""; } }
function setLlmSource(id, source) {
  try {
    const all = JSON.parse(localStorage.getItem(FLAG) || "{}");
    if (source) all[id] = source; else delete all[id];
    localStorage.setItem(FLAG, JSON.stringify(all));
  } catch {}
}

/* ---------- actions ---------- */

export async function install(id) {
  if (mode === "desktop") {
    await post("install", { id, source: prefs.source });
    return;
  }
  const cur = packStatus(id);
  if (cur.state === "downloading" || cur.state === "queued") return;
  status[id] = { ...cur, state: "queued", error: undefined };
  emit();
  webQueue.push(id);
  pumpWeb();
}

export async function cancel(id) {
  if (mode === "desktop") { await post("cancel", { id }); return; }
  const at = webQueue.indexOf(id);
  if (at >= 0) webQueue.splice(at, 1);
  if (webCurrent && webCurrent.id === id) webCurrent.ctl.abort();
  await refresh();
}

export async function remove(id) {
  if (mode === "desktop") { await post("remove", { id }); return; }
  await cancel(id);
  const p = packById(id);
  if (p.kind === "llm") {
    try {
      const webllm = await import(new URL("vendor/web-llm/index.js", location.href).href);
      const cfg = await engineConfig(id);
      await webllm.deleteModelAllInfoInCache(p.llm.model_id, { model_list: [{ model: cfg.llm.model, model_id: p.llm.model_id, model_lib: cfg.llm.lib }], cacheBackend: "opfs" });
    } catch (e) { console.warn(e); }
    setLlmSource(id, "");
  } else {
    const cache = await caches.open(CACHE);
    const inUse = new Set(packList().filter((q) => q.id !== id && installed(q.id)).flatMap((q) => q.files.map(canonKey)));
    for (const f of p.files) if (!inUse.has(canonKey(f))) await cache.delete(canonKey(f));
  }
  await refresh();
}

async function post(action, body) {
  const r = await fetch(`api/packs/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && body.id) status[body.id] = { ...packStatus(body.id), state: "partial", error: j.error || String(r.status) };
  if (j.packs) { status = j.packs; free = j.free; }
  emit();
  refresh();
}

// The language model "pack" on the web is downloaded by loading it once (WebLLM fetches and caches it).
const webQueue = [];
let webCurrent = null;
async function pumpWeb() {
  if (webCurrent || !webQueue.length) return;
  const id = webQueue.shift();
  const p = packById(id);
  const ctl = new AbortController();
  webCurrent = { id, ctl };
  const t0 = performance.now();
  const set = (done) => {
    const secs = (performance.now() - t0) / 1000;
    status[id] = { state: "downloading", done, total: p.size, rate: secs > 1 ? Math.round(done / secs) : 0 };
    emit();
  };
  set(0);
  try {
    try { await navigator.storage.persist(); } catch {}
    if (p.kind === "llm") {
      const source = await pickSource();
      const cfg = await engineConfig(id, source);
      await window.ASoundAI.download(cfg.llm, (frac) => set(Math.round(frac * p.size)), ctl.signal);
      setLlmSource(id, source);
    } else {
      const source = await pickSource();
      const cache = await caches.open(CACHE);
      let done = 0;
      for (const f of p.files) {
        if (await cache.match(canonKey(f))) { done += f.size; set(done); continue; }
        await fetchInto(cache, f, source, ctl.signal, (n) => set(done + n));
        done += f.size;
        set(done);
      }
    }
    delete status[id];
  } catch (e) {
    status[id] = { ...packStatus(id), state: "partial", error: ctl.signal.aborted ? undefined : String((e && e.message) || e).slice(0, 160) };
    if (!ctl.signal.aborted) console.warn("download failed", id, e);
  }
  webCurrent = null;
  await webStatus();
  emit();
  pumpWeb();
}

// Stream one file into the cache (large files never sit in memory), counting bytes for the progress bar.
async function fetchInto(cache, f, source, signal, onBytes) {
  let res;
  try {
    res = await fetch(fileUrl(f, source), { signal, cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${f.path}`);
  } catch (e) {
    if (signal.aborted) throw e;
    res = await fetch(fileUrl(f, source === "hf" ? "mirror" : "hf"), { signal, cache: "no-store" }); // one retry elsewhere
    if (!res.ok) throw new Error(`${res.status} ${f.path}`);
  }
  let n = 0;
  const counted = res.body.pipeThrough(new TransformStream({ transform(chunk, ctl) { n += chunk.length; onBytes(n); ctl.enqueue(chunk); } }));
  const key = canonKey(f);
  await cache.put(key, new Response(counted, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(f.size) } }));
  if (n !== f.size) { await cache.delete(key); throw new Error(`incomplete download: ${f.path}`); }
}

export function setSource(s) {
  prefs.source = s;
  savePrefs();
  resolved = null;
  emit();
}
