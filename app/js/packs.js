// Model packs: which local AI models are installed, downloading more, and which ones the engines use.
//   desktop - ASound.exe / server.py: the local server downloads into app/models (GET/POST api/packs)
//   web     - a phone or a plain browser, no local server: the browser downloads into its own storage
//             (Cache Storage for speech files, keyed independently of the mirror; WebLLM's own cache for the LLM)
// Add ?web to the address to try the phone path on a computer.
import { prefs, savePrefs } from "./state.js";
import { downloadModelFile, discardModelPartial, modelPartialBytes } from "./model-download.js";
import { deviceInfo } from "./device.js";

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
export const sourceList = () => Object.keys(catalog?.sources || {});
export const hostedVoice = () => mode === "web" && !!voiceRoot();
let connectionResults = null;
let checkingConnections = false;
export const connectionStatus = () => ({ checking: checkingConnections, results: connectionResults });

export async function initPacks() {
  catalog = await fetch("packs.json", { cache: "no-cache" }).then((r) => r.json());
  if (!sourceList().length) throw new Error("No model download source configured");
  if (prefs.source !== "auto" && !sourceList().includes(prefs.source)) {
    prefs.source = "auto";
    savePrefs();
  }
  mode = FORCE_WEB ? "web" : await fetch("api/health", { cache: "no-store" }).then((r) => r.json()).then((j) => (j.packs ? "desktop" : "web")).catch(() => "web");
  if (mode === "web") voiceRoot(); // Validate the optional same-origin voice source before using it.
  gpu = await probeGpu();
  await refresh();
}

async function probeGpu() {
  const info = { webgpu: false, f16: false, vendor: "", mobile: deviceInfo().mobile };
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
  const available = (groups) => groups.find((g) => packById(variant(g)));
  const llms = !gpu.webgpu ? ["llm-cpu"] : gpu.mobile
    ? ["llm-0.8b", "llm-2b", "llm-cpu"]
    : strong ? ["llm-4b", "llm-2b", "llm-0.8b", "llm-cpu"] : ["llm-2b", "llm-0.8b", "llm-cpu"];
  return {
    // Start small on every phone; a memory hint alone does not establish inference speed.
    llm: available(llms) || llms[0],
    asr: available(gpu.mobile || !gpu.webgpu ? ["asr-tiny", "asr-base"] : ["asr-base", "asr-tiny"]) || "asr-tiny",
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
  const llms = gpu.webgpu ? (gpu.mobile ? ["llm-0.8b", "llm-2b", "llm-4b", "llm-cpu"] : ["llm-4b", "llm-2b", "llm-0.8b", "llm-cpu"]) : ["llm-cpu"];
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
async function probeSource(name) {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const asr = packById(recommended().asr);
    const configFile = asr?.files.find((f) => f.path === "config.json")
      || packList().flatMap((p) => p.files).find((f) => f.repo && /(?:^|\/)(?:config|mlc-chat-config)\.json$/.test(f.path));
    if (!configFile) throw new Error("No model configuration file is available for a connection check");
    const r = await fetch(fileUrl(configFile, name), { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`Model source: HTTP ${r.status}`);
    await r.json();
    // Check the GPU library too: an accessible model mirror alone is not enough.
    const pack = packById(variant(recommended().llm));
    if (gpu.webgpu && pack?.llm) {
      const lib = await fetch(fileUrl({ lib: pack.llm.lib }, name), { signal: ctl.signal, cache: "no-store", headers: { Range: "bytes=0-7" } });
      if (!lib.ok || !lib.body) throw new Error(`Model runtime: HTTP ${lib.status}`);
      const reader = lib.body.getReader();
      const prefix = [];
      try {
        while (prefix.length < 8) {
          const { done, value } = await reader.read();
          if (done) break;
          prefix.push(...value.subarray(0, 8 - prefix.length));
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (prefix.length < 8 || prefix.slice(0, 4).join(",") !== "0,97,115,109") throw new Error("Invalid model runtime response");
    }
    return { name, ok: true, ms: Math.round(performance.now() - t0) };
  } catch (error) {
    return { name, ok: false, error: String(error.message || error).slice(0, 160) };
  } finally { clearTimeout(timer); }
}

// A short connectivity check, not a bandwidth or device-performance benchmark.
export async function checkConnections() {
  if (!probing) {
    checkingConnections = true;
    emit();
    probing = (async () => {
      try {
        connectionResults = await Promise.all(sourceList().map(probeSource));
        const working = connectionResults.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
        resolved = working[0]?.name || null;
        return connectionResults;
      } finally {
        checkingConnections = false;
        probing = null;
        emit();
      }
    })();
  }
  return probing;
}

async function pickSource() {
  if (prefs.source !== "auto" && sourceList().includes(prefs.source)) return prefs.source;
  if (sourceList().includes(catalog.defaultSource)) return catalog.defaultSource;
  if (resolved) return resolved;
  await checkConnections();
  // Cached speech models can still load offline through their source-independent keys.
  return resolved || sourceList()[0];
}

function voiceRoot() {
  const source = catalog?.voiceSource;
  if (!source) return null;
  if (!/^[a-f0-9]{16}$/.test(source.version) || source.models !== `voice-models/${source.version}`
      || source.repository !== "onnx-community/Kokoro-82M-v1.0-ONNX") {
    throw new Error("Invalid hosted browser voice source");
  }
  return new URL(`${source.models}/`, location.href).href;
}
function hostedVoiceFile(f) {
  return mode === "web" && voiceRoot() && f.repo === catalog.voiceSource.repository
    && packById("voice")?.files.some((item) => item.path === f.path && item.repo === f.repo);
}
function voiceCanon() { return `${CANON}voice/${catalog.voiceSource.version}/`; }

export function fileUrl(f, source) {
  if (hostedVoiceFile(f)) return `${voiceRoot()}${f.repo}/resolve/main/${f.path}`;
  const src = catalog.sources[source];
  return f.repo ? `${src.models}/${f.repo}/resolve/main/${f.path}` : `${src.libs}/${f.lib.replace(/^libs\//, "")}`;
}
export const canonKey = (f) => (hostedVoiceFile(f) ? voiceCanon() : CANON) + (f.repo ? `${f.repo}/${f.path}` : f.path);

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
  if (id === "voice" && hostedVoice()) {
    return { mode, base: voiceRoot(), cache: CACHE, canon: voiceCanon(), asr: undefined, llm: null };
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
    let have = 0, partial = 0;
    if (cache) for (const f of p.files) {
      if (await cache.match(canonKey(f))) have += f.size;
      else partial += await modelPartialBytes(canonKey(f), f).catch(() => 0);
    }
    status[p.id] = { state: have >= p.size ? "installed" : have || partial || cur?.error ? "partial" : "absent", done: have + partial, total: p.size, error: cur && cur.error };
  }
  try { const est = await navigator.storage.estimate(); free = est.quota - est.usage; } catch { free = null; }
}
// WebLLM keeps its own cache; we remember which language models finished loading once, and from where.
const FLAG = "asound.llmCached.v1";
function llmSource(id) { try { const source = JSON.parse(localStorage.getItem(FLAG) || "{}")[id]; return sourceList().includes(source) ? source : ""; } catch { return ""; } }
function setLlmSource(id, source) {
  try {
    const all = JSON.parse(localStorage.getItem(FLAG) || "{}");
    if (source) all[id] = source; else delete all[id];
    localStorage.setItem(FLAG, JSON.stringify(all));
  } catch {}
}

/* ---------- actions ---------- */

export async function install(id) {
  if (!packById(id)) return;
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
  if (at >= 0) { webQueue.splice(at, 1); delete status[id]; }
  if (webCurrent && webCurrent.id === id) {
    const current = webCurrent;
    current.ctl.abort();
    await current.finished;
  }
  await refresh();
}

export async function remove(id) {
  if (mode === "desktop") { await post("remove", { id }); return; }
  await cancel(id);
  const p = packById(id);
  if (!p) return;
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
    for (const f of p.files) if (!inUse.has(canonKey(f))) {
      await cache.delete(canonKey(f));
      await discardModelPartial(canonKey(f));
    }
  }
  delete status[id];
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
  let finish;
  webCurrent = { id, ctl, finished: new Promise((resolve) => { finish = resolve; }) };
  const t0 = performance.now();
  let lastPaint = -Infinity;
  const set = (done) => {
    const now = performance.now();
    const secs = (now - t0) / 1000;
    status[id] = { state: "downloading", done, total: p.size, rate: secs > 1 ? Math.round(done / secs) : 0 };
    if (now - lastPaint >= 150 || done === p.size) { lastPaint = now; emit(); }
  };
  set(0);
  try {
    try { await navigator.storage.persist(); } catch {}
    if (p.kind === "llm") {
      const source = await pickSource();
      ctl.signal.throwIfAborted();
      const cfg = await engineConfig(id, source);
      await window.ASoundAI.download(cfg.llm, (frac) => set(Math.round(frac * p.size)), ctl.signal);
      ctl.signal.throwIfAborted();
      setLlmSource(id, source);
    } else {
      const source = p.id === "voice" && hostedVoice() ? null : await pickSource();
      ctl.signal.throwIfAborted();
      const cache = await caches.open(CACHE);
      let done = 0;
      for (const f of p.files) {
        ctl.signal.throwIfAborted();
        if (await cache.match(canonKey(f))) { done += f.size; set(done); continue; }
        await downloadModelFile({ cache, key: canonKey(f), file: f,
          urls: source === null ? [fileUrl(f, null)] : [source, ...sourceList().filter((s) => s !== source)].map((s) => fileUrl(f, s)),
          signal: ctl.signal, onBytes: (n) => set(done + n) });
        done += f.size;
        set(done);
      }
    }
    ctl.signal.throwIfAborted();
    delete status[id];
  } catch (e) {
    status[id] = { ...packStatus(id), state: "partial", error: ctl.signal.aborted ? undefined : String((e && e.message) || e).slice(0, 160) };
    if (!ctl.signal.aborted) console.warn("download failed", id, e);
  }
  try {
    await webStatus();
  } catch (e) {
    console.warn("Could not refresh model storage", e);
  } finally {
    webCurrent = null;
    finish();
    emit();
    pumpWeb();
  }
}

export function setSource(s) {
  if (s !== "auto" && !sourceList().includes(s)) return;
  prefs.source = s;
  savePrefs();
  resolved = null;
  emit();
}
