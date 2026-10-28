import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../app/js/packs.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")
  + "\nglobalThis.api = { initPacks, recommended, activePacks, variant, ready, packStatus, packMode, sourceList, hostedVoice, engineConfig, fileUrl, canonKey, checkConnections, connectionStatus, resolvedSource, refresh, install, cancel, remove, setSource };";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(check, message) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await flush();
  }
  assert.ok(check(), message);
}

class MemoryCache {
  entries = new Map();
  async match(key) { return this.entries.get(String(key))?.clone(); }
  async put(key, response) {
    // Like Cache.put, wait for the body to finish before publishing the entry.
    const body = await response.arrayBuffer();
    this.entries.set(String(key), new Response(body, { headers: response.headers }));
  }
  async delete(key) { return this.entries.delete(String(key)); }
}

function catalog() {
  const packs = [];
  for (const size of ["0.8", "2", "4"]) for (const dtype of ["f16", "f32"]) {
    packs.push({ id: `llm-${size}b-${dtype}`, group: `llm-${size}b`, kind: "llm", size: 10,
      llm: { model_id: `model-${size}-${dtype}`, repo: `test/model-${size}-${dtype}`, lib: `libs/runtime-${size}-${dtype}.wasm`, ctx: 1024 },
      files: [{ repo: `test/model-${size}-${dtype}`, path: "weights.bin", size: 10 }] });
  }
  packs.push({ id: "llm-cpu", group: "llm-cpu", kind: "llm-cpu", size: 10,
    cpu: { repo: "test/cpu", path: "weights.gguf", ctx: 1024 },
    files: [{ repo: "test/cpu", path: "weights.gguf", size: 10 }] });
  for (const id of ["asr-tiny", "asr-base", "voice"]) {
    packs.push({ id, group: id, kind: id === "voice" ? "voice" : "asr", size: 10,
      asr: id === "voice" ? undefined : { model: `test/${id}` },
      files: [{ repo: `test/${id}`, path: id === "voice" ? "weights.bin" : "config.json", size: 10 }] });
  }
  return { sources: {
    hf: { models: "https://hf.test", libs: "https://github.test/base" },
    mirror: { models: "https://mirror.test", libs: "https://cdn.test/base" },
  }, packs };
}

async function fixture({ mobile = false, gpu = true, f16 = true, vendor = "NVIDIA", desktop = false,
  data = catalog(), prefs = {}, flags = {}, cached = [], partial = {}, fetchRemote = null, download = null,
  release = null, controlled = true, runtimeFiles = [], runtimeFetch = null, initOptions } = {}) {
  const cache = new MemoryCache();
  const stored = new Map([["asound.llmCached.v1", JSON.stringify(flags)]]);
  const shell = new MemoryCache();
  const idle = [], swEvents = new Set();
  const root = "https://app.test/ASound/";
  const controller = { scriptURL: root + "sw.js", postMessage: data => env.runtimeCancels.push(data) };
  const serviceWorker = { controller: controlled ? controller : null,
    addEventListener: (_type, fn) => swEvents.add(fn), removeEventListener: (_type, fn) => swEvents.delete(fn) };
  const env = { cache, shell, idle, swEvents, serviceWorker, runtimeFetch, stored, data, requests: [], runtimeRequests: [], runtimeCancels: [], downloads: [], removedPartial: [], warnings: [], saved: 0,
    partials: new Map(), prefs: { source: "auto", llm: "", asr: "", ...prefs },
    remote: fetchRemote || (async (url) => url.endsWith(".wasm")
      ? new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0))
      : Response.json({ model_type: "moonshine" })) };
  env.control = async () => {
    serviceWorker.controller = controller;
    await shell.put(root + "__asound_release__", Response.json({ version: release, installed: 1 }));
    for (const fn of swEvents) fn();
  };
  env.runIdle = () => { for (const fn of idle.splice(0)) fn(); };
  if (release && controlled) await shell.put(root + "__asound_release__", Response.json({ version: release, installed: 1 }));
  for (const file of runtimeFiles) await shell.put(root + file, new Response("verified runtime"));
  const keyFor = (file) => "https://models.asound.invalid/" + (file.repo ? `${file.repo}/${file.path}` : file.path);
  for (const id of cached) for (const file of data.packs.find((p) => p.id === id).files) {
    await cache.put(keyFor(file), new Response(new Uint8Array(file.size)));
  }
  for (const [id, bytes] of Object.entries(partial)) {
    env.partials.set(keyFor(data.packs.find((p) => p.id === id).files[0]), bytes);
  }
  const context = {
    URL, URLSearchParams, Response, AbortController, performance, setTimeout, clearTimeout,
    location: { search: "", href: "https://app.test/ASound/" },
    console: { warn: (...args) => env.warnings.push(args) },
    navigator: {
      ...(release ? { serviceWorker } : {}),
      userAgent: mobile ? "Android Mobile" : "Windows Desktop",
      userAgentData: { mobile }, deviceMemory: 8,
      gpu: gpu ? { requestAdapter: async () => ({ features: new Set(f16 ? ["shader-f16"] : []), info: { vendor } }) } : undefined,
      storage: { persist: async () => true, estimate: async () => ({ quota: 100000, usage: 0 }) },
    },
    prefs: env.prefs, savePrefs: () => { env.saved++; },
    deviceInfo: () => ({ mobile }),
    localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    caches: { open: async name => name === "asound-models-v1" ? cache : shell },
    modelPartialBytes: async (key) => env.partials.get(key) || 0,
    discardModelPartial: async (key) => { env.removedPartial.push(key); env.partials.delete(key); },
    downloadModelFile: async (args) => {
      env.downloads.push(args);
      if (download) return download(args, env);
      args.signal.throwIfAborted();
      await args.cache.put(args.key, new Response(new Uint8Array(args.file.size)));
      args.onBytes(args.file.size);
    },
    window: { requestIdleCallback: fn => idle.push(fn), ASoundAI: { download: async (_config, progress, signal) => { signal.throwIfAborted(); progress(1); } } },
    fetch: async (url, options = {}) => {
      env.requests.push({ url: String(url), options });
      if (url === "packs.json") return Response.json(data);
      if (String(url) === root + "version.json") return release ? Response.json({ version: release }) : new Response("missing", { status: 404 });
      if (url === "api/health") return Response.json({ packs: desktop });
      if (url === "api/packs" || String(url).startsWith("api/packs/")) return Response.json({ packs: {}, free: 100000 });
      if (String(url).startsWith(root + "vendor/") || String(url).startsWith(root + "kokoro/")) {
        env.runtimeRequests.push(String(url).slice(root.length));
        if (env.runtimeFetch) return env.runtimeFetch(String(url), options, env);
        const response = new Response("verified runtime");
        if (serviceWorker.controller) await shell.put(String(url), response.clone());
        return response;
      }
      return env.remote(String(url), options);
    },
  };
  vm.runInNewContext(source, context, { filename: "packs.js" });
  env.api = context.api;
  await env.api.initPacks(initOptions);
  return env;
}

test("phones start with the small GPU model even when they report 8 GB memory", async () => {
  const phone = await fixture({ mobile: true });
  assert.deepEqual(plain(phone.api.recommended()), { llm: "llm-0.8b", asr: "asr-tiny" });
  assert.equal(phone.api.variant("llm-0.8b"), "llm-0.8b-f16");
  const f32 = await fixture({ mobile: true, f16: false });
  assert.equal(f32.api.variant("llm-0.8b"), "llm-0.8b-f32");
  const cpu = await fixture({ mobile: true, gpu: false });
  assert.deepEqual(plain(cpu.api.recommended()), { llm: "llm-cpu", asr: "asr-tiny" });
});

function hostedVoiceCatalog(version = "abcdef0123456789") {
  const data = catalog();
  const repo = "onnx-community/Kokoro-82M-v1.0-ONNX";
  data.voiceSource = { models: `voice-models/${version}`, repository: repo, version, manifest: "voice-models.json" };
  data.packs.find((p) => p.id === "voice").files = [{ repo, path: "onnx/model_quantized.onnx", size: 10 }];
  return data;
}

test("hosted voice downloads and runtime configuration stay on the site's own origin without probing external sources", async () => {
  const env = await fixture({ data: hostedVoiceCatalog(), mobile: true });
  const p = env.data.packs.find((p) => p.id === "voice");
  const before = env.requests.length;
  const config = await env.api.engineConfig("voice");
  assert.equal(env.api.hostedVoice(), true);
  assert.equal(config.base, "https://app.test/ASound/voice-models/abcdef0123456789/");
  assert.equal(config.canon, "https://models.asound.invalid/voice/abcdef0123456789/");
  assert.equal(env.requests.length, before);
  assert.equal(env.api.fileUrl(p.files[0], "hf"), `${config.base}${p.files[0].repo}/resolve/main/${p.files[0].path}`);
  assert.equal(env.api.fileUrl(env.data.packs.find((p) => p.id === "asr-tiny").files[0], "hf"), "https://hf.test/test/asr-tiny/resolve/main/config.json");
  await env.api.install("voice");
  await until(() => env.api.packStatus("voice").state === "installed", "voice should install independently");
  assert.equal(env.downloads.length, 1);
  assert.deepEqual(Array.from(env.downloads[0].urls), [env.api.fileUrl(p.files[0], null)]);
  assert.equal(env.requests.length, before);
});

test("a voice source revision changes cache identity and does not treat old unversioned files as installed", async () => {
  const old = await fixture({ data: hostedVoiceCatalog(), cached: ["voice"] });
  assert.equal(old.api.packStatus("voice").state, "absent");
  const newer = await fixture({ data: hostedVoiceCatalog("1111111111111111") });
  const file = old.data.packs.find((p) => p.id === "voice").files[0];
  assert.notEqual(old.api.canonKey(file), newer.api.canonKey(file));
  const desktop = await fixture({ data: hostedVoiceCatalog(), desktop: true });
  assert.equal(desktop.api.hostedVoice(), false);
  assert.equal((await desktop.api.engineConfig("voice")).base, "https://app.test/ASound/models/");
});

test("hosted voice source refuses absolute URLs and traversal instead of redirecting model downloads", async () => {
  for (const models of ["https://other.test/models", "//other.test/models", "../voice-models/abcdef0123456789"]) {
    const data = hostedVoiceCatalog();
    data.voiceSource.models = models;
    await assert.rejects(fixture({ data }), /Invalid hosted browser voice source/);
  }
});

test("existing desktop recommendations and local-server downloads are preserved", async () => {
  const strong = await fixture({ desktop: true, prefs: { source: "hf" } });
  assert.deepEqual(plain(strong.api.recommended()), { llm: "llm-4b", asr: "asr-base" });
  assert.equal(strong.api.packMode(), "desktop");
  assert.equal((await strong.api.engineConfig("llm-4b-f16")).llm.lib,
    "https://app.test/ASound/models/libs/runtime-4-f16.wasm");
  await strong.api.install("voice");
  const request = strong.requests.find((r) => r.url === "api/packs/install");
  assert.deepEqual(JSON.parse(request.options.body), { id: "voice", source: "hf" });
  assert.equal(strong.downloads.length, 0);
  const integrated = await fixture({ vendor: "Intel" });
  assert.deepEqual(plain(integrated.api.recommended()), { llm: "llm-2b", asr: "asr-base" });
});

test("a limited deployment recommends only the available small-model starter packs", async () => {
  const data = catalog();
  data.packs = data.packs.filter((p) => ["llm-0.8b-f16", "llm-0.8b-f32", "llm-cpu", "asr-tiny", "voice"].includes(p.id));
  const env = await fixture({ data });
  assert.deepEqual(plain(env.api.recommended()), { llm: "llm-0.8b", asr: "asr-tiny" });
  assert.ok((await env.api.checkConnections()).every((r) => r.ok));
  const runtimeRequests = env.requests.filter((r) => r.url.endsWith(".wasm"));
  assert.ok(runtimeRequests.length > 0);
  assert.ok(runtimeRequests.every((r) => r.url.endsWith("runtime-0.8-f16.wasm")));
});

test("connectivity probes use an available runtime and omit GPU probes for CPU-only packs", async () => {
  const twoB = catalog();
  twoB.packs = twoB.packs.filter((p) => ["llm-2b-f16", "asr-tiny", "voice"].includes(p.id));
  const env = await fixture({ data: twoB, mobile: true });
  assert.ok((await env.api.checkConnections()).every((r) => r.ok));
  assert.ok(env.requests.filter((r) => r.url.endsWith(".wasm")).every((r) => r.url.endsWith("runtime-2-f16.wasm")));

  const cpuOnly = catalog();
  cpuOnly.packs = cpuOnly.packs.filter((p) => ["llm-cpu", "asr-tiny", "voice"].includes(p.id));
  const cpu = await fixture({ data: cpuOnly });
  assert.equal(cpu.api.recommended().llm, "llm-cpu");
  assert.ok((await cpu.api.checkConnections()).every((r) => r.ok));
  assert.equal(cpu.requests.filter((r) => r.url.endsWith(".wasm")).length, 0);
});

test("a base-ASR-only deployment probes an uploaded configuration rather than the missing tiny pack", async () => {
  const data = catalog();
  data.packs = data.packs.filter((p) => ["llm-2b-f16", "asr-base", "voice"].includes(p.id));
  const env = await fixture({ data });
  assert.ok((await env.api.checkConnections()).every((r) => r.ok));
  const jsonRequests = env.requests.filter((r) => r.url.endsWith("config.json"));
  assert.ok(jsonRequests.length > 0);
  assert.ok(jsonRequests.every((r) => r.url.includes("/asr-base/")));
});

test("a deployment-only build drops old source choices and never falls back overseas", async () => {
  const data = catalog();
  data.sources = { deployment: { models: "https://models.site.test", libs: "https://models.site.test/libs" } };
  data.defaultSource = "deployment";
  const env = await fixture({ data, prefs: { source: "hf" }, flags: { "llm-0.8b-f16": "hf" } });
  assert.equal(env.prefs.source, "auto");
  assert.equal(env.saved, 1);
  assert.deepEqual(Array.from(env.api.sourceList()), ["deployment"]);
  assert.notEqual(env.api.packStatus("llm-0.8b-f16").state, "installed");
  const config = await env.api.engineConfig("llm-0.8b-f16");
  assert.equal(config.llm.model, "https://models.site.test/test/model-0.8-f16");
  assert.equal(config.llm.lib, "https://models.site.test/libs/runtime-0.8-f16.wasm");
  assert.equal(env.api.fileUrl({ lib: "libs/runtime-0.8-f16.wasm" }, "deployment"), config.llm.lib);
  assert.equal(env.api.fileUrl({ lib: "runtime-0.8-f16.wasm" }, "deployment"), config.llm.lib);
  await env.api.install("voice");
  await until(() => env.api.packStatus("voice").state === "installed", "voice installation should complete");
  assert.deepEqual(Array.from(env.downloads[0].urls), ["https://models.site.test/test/voice/resolve/main/weights.bin"]);
  assert.ok(env.requests.every((r) => !r.url.startsWith("https://") || r.url.startsWith("https://app.test/ASound/")), "the configured default needs no outside probes");
  env.api.setSource("mirror");
  assert.equal(env.prefs.source, "auto", "a source omitted from this deployment must remain unavailable");
});

test("a model JSON response alone is insufficient when its GPU runtime cannot load", async () => {
  const env = await fixture({ fetchRemote: async (url) => {
    if (!url.endsWith(".wasm")) return Response.json({ model_type: "moonshine" });
    return url.startsWith("https://github.test")
      ? new Response("<html>unavailable</html>")
      : new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  } });
  const result = await env.api.checkConnections();
  assert.equal(result.find((r) => r.name === "hf").ok, false);
  assert.equal(result.find((r) => r.name === "mirror").ok, true);
  assert.equal(env.api.resolvedSource(), "mirror");
  assert.equal(env.api.connectionStatus().checking, false);
  assert.ok(env.requests.filter((r) => r.url.endsWith(".wasm")).every((r) => r.options.headers.Range === "bytes=0-7"));
  assert.equal((await env.api.engineConfig("llm-0.8b-f16")).llm.lib,
    "https://cdn.test/base/runtime-0.8-f16.wasm");
});

test("unreachable sources do not prevent configuring models already cached for offline use", async () => {
  const env = await fixture({ cached: ["asr-tiny", "voice"], flags: { "llm-0.8b-f16": "hf" },
    fetchRemote: async () => { throw new TypeError("offline"); } });
  const speech = await env.api.engineConfig("asr-tiny");
  assert.equal(speech.mode, "web");
  assert.equal(speech.cache, "asound-models-v1");
  assert.equal(speech.canon, "https://models.asound.invalid/");
  assert.equal(env.api.packStatus("asr-tiny").state, "installed");
  const beforeLlm = env.requests.length;
  assert.equal((await env.api.engineConfig("llm-0.8b-f16")).llm.model, "https://hf.test/test/model-0.8-f16");
  assert.equal(env.requests.length, beforeLlm, "the cached GPU model must retain its source without a new probe");
  assert.equal(env.api.ready(), true);
});

test("partial cached chunks count toward progress but never make a pack installed", async () => {
  const env = await fixture({ partial: { voice: 10 } });
  assert.equal(env.api.packStatus("voice").done, 10);
  assert.equal(env.api.packStatus("voice").state, "partial", "even 100% chunks still require final verification and publication");
  await env.api.remove("voice");
  assert.equal(env.api.packStatus("voice").done, 0);
  assert.equal(env.api.packStatus("voice").state, "absent");
  assert.equal(env.removedPartial.length, 1);
});

test("cancelling a queued pack leaves no stuck queued status or later download", async () => {
  const entered = deferred(), release = deferred();
  const env = await fixture({ prefs: { source: "hf" }, download: async (args) => {
    entered.resolve();
    await release.promise;
    args.signal.throwIfAborted();
    await args.cache.put(args.key, new Response(new Uint8Array(args.file.size)));
  } });
  await env.api.install("asr-tiny");
  await entered.promise;
  await env.api.install("voice");
  assert.equal(env.api.packStatus("voice").state, "queued");
  await env.api.cancel("voice");
  assert.equal(env.api.packStatus("voice").state, "absent");
  release.resolve();
  await until(() => env.api.packStatus("asr-tiny").state === "installed", "active download should finish");
  await flush();
  assert.equal(env.downloads.length, 1, "the cancelled queued pack must not start later");
});

test("remove waits for an active download to stop before clearing final and partial data", async () => {
  const entered = deferred(), stopped = deferred();
  let signal;
  const env = await fixture({ prefs: { source: "hf" }, partial: { voice: 4 }, download: async (args) => {
    signal = args.signal;
    entered.resolve();
    await stopped.promise;
    // Simulate a final cache operation that was already pending when cancel was clicked.
    await args.cache.put(args.key, new Response(new Uint8Array(args.file.size)));
    args.signal.throwIfAborted();
  } });
  await env.api.install("voice");
  await entered.promise;
  let removed = false;
  const removing = env.api.remove("voice").then(() => { removed = true; });
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(removed, false, "remove must await completion of the in-flight task");
  stopped.resolve();
  await removing;
  await flush();
  assert.equal(env.api.packStatus("voice").state, "absent");
  assert.equal(env.cache.entries.size, 0, "late data cannot resurrect a removed pack");
  assert.equal(env.partials.size, 0);
});

test("a finishing download remains cancellable until its storage status refresh settles", async () => {
  const env = await fixture({ prefs: { source: "hf" } });
  const refreshing = deferred(), releaseRefresh = deferred();
  const match = env.cache.match.bind(env.cache);
  let hold = true;
  env.cache.match = async (key) => {
    const response = await match(key);
    if (response && hold && key.includes("/test/voice/")) {
      hold = false;
      refreshing.resolve();
      await releaseRefresh.promise;
    }
    return response;
  };
  await env.api.install("voice");
  await refreshing.promise;
  let removed = false;
  const removing = env.api.remove("voice").then(() => { removed = true; });
  await flush();
  const waitedForRefresh = !removed;
  releaseRefresh.resolve();
  await removing;
  await flush();
  assert.equal(waitedForRefresh, true, "remove must wait for the active task's final status refresh too");
  assert.equal(env.api.packStatus("voice").state, "absent", "a stale refresh cannot restore installed status");
  assert.equal(env.cache.entries.size, 0);
});

const ONNX = ["vendor/transformers/ort-wasm-simd-threaded.jsep.mjs", "vendor/transformers/ort-wasm-simd-threaded.jsep.wasm"];
const VOICE_ONNX = ["kokoro/ort-cpu/ort-wasm-simd-threaded.mjs", "kokoro/ort-cpu/ort-wasm-simd-threaded.wasm"];
const VOICE_RUNTIME = [...VOICE_ONNX, "kokoro/kokoro.web.js", "kokoro/neural-tts.js", "kokoro/lexicon-us.json"];

test("read-only diagnostics inspect incomplete packs without changing preferences or repairing runtimes", async () => {
  const env = await fixture({ release: "test-v1", cached: ["voice"], prefs: { source: "removed-source" },
    initOptions: { readOnly: true } });
  assert.equal(env.api.packStatus("voice").state, "partial");
  assert.equal(env.api.packStatus("voice").runtimeMissing, true);
  assert.equal(env.prefs.source, "removed-source");
  assert.equal(env.saved, 0);
  assert.equal(env.idle.length, 0);
  env.runIdle(); await env.api.refresh(); await flush();
  assert.deepEqual(env.runtimeRequests, []);
  assert.equal(env.downloads.length, 0);
  assert.equal(env.saved, 0);

  const normal = await fixture({ release: "test-v1", cached: ["voice"], prefs: { source: "removed-source" } });
  assert.equal(normal.prefs.source, "auto");
  assert.equal(normal.saved, 1);
  normal.runIdle();
  await until(() => normal.api.packStatus("voice").state === "installed", "ordinary startup still repairs runtime files");
  assert.deepEqual(normal.runtimeRequests, VOICE_RUNTIME);
  assert.equal(normal.downloads.length, 0);
});

test("an older JSEP voice installation repairs only its new CPU runtime and keeps model cache keys", async () => {
  const env = await fixture({ release: "test-v2", cached: ["voice"],
    runtimeFiles: [...ONNX, ...VOICE_RUNTIME.slice(2)] });
  const keys = [...env.cache.entries.keys()];
  assert.equal(env.api.packStatus("voice").state, "partial");
  assert.equal(env.api.packStatus("voice").runtimeMissing, true);
  env.runIdle();
  await until(() => env.api.packStatus("voice").state === "installed", "new CPU runtime completes the old installation");
  assert.deepEqual(env.runtimeRequests, VOICE_ONNX);
  assert.equal(env.downloads.length, 0, "already installed model bytes are not downloaded again");
  assert.deepEqual([...env.cache.entries.keys()], keys);
  assert.equal(env.cache.entries.size, 1);
});

test("a release pack stays downloading until its required runtime is verified in the offline snapshot", async () => {
  const entered = deferred(), release = deferred();
  const env = await fixture({ release: "test-v1", prefs: { source: "hf" }, runtimeFetch: async (url, options, env) => {
    entered.resolve(); await release.promise; options.signal.throwIfAborted();
    const response = new Response("verified runtime");
    await env.shell.put(url, response.clone());
    return response;
  } });
  await env.api.install("voice"); await entered.promise;
  assert.equal(env.api.packStatus("voice").state, "downloading");
  assert.equal(env.downloads.length, 1, "weights finish first and stay cached");
  release.resolve();
  await until(() => env.api.packStatus("voice").state === "installed", "verified runtime should complete installation");
  assert.deepEqual(env.runtimeRequests, VOICE_RUNTIME, "voice never downloads the LLM/ASR JS runtimes");
});

test("runtime HTTP failure is partial and retry keeps weights and already verified runtime files", async () => {
  const env = await fixture({ release: "test-v1", prefs: { source: "hf" }, runtimeFetch: async (url, _options, env) => {
    if (url.endsWith(".wasm")) return new Response("unavailable", { status: 503 });
    const response = new Response("verified runtime"); await env.shell.put(url, response.clone()); return response;
  } });
  await env.api.install("voice");
  await until(() => env.api.packStatus("voice").state === "partial", "503 must not count as installed");
  assert.match(env.api.packStatus("voice").error, /HTTP 503/);
  assert.equal(env.api.packStatus("voice").runtimeMissing, true);
  const failedCalls = env.runtimeRequests.length;
  env.runIdle(); await flush();
  assert.equal(env.runtimeRequests.length, failedCalls, "late startup idle does not restart a failed manual download");
  env.runtimeFetch = null; env.runtimeRequests.length = 0;
  await env.api.install("voice");
  await until(() => env.api.packStatus("voice").state === "installed", "retry should repair only the missing runtime");
  assert.equal(env.downloads.length, 1);
  assert.deepEqual(env.runtimeRequests, VOICE_RUNTIME.slice(1), "the previously verified mjs is reused");
});

test("a successful network response without verified offline storage cannot finish a release pack", async () => {
  const env = await fixture({ release: "test-v1", prefs: { source: "hf" }, runtimeFetch: async () => new Response("not stored") });
  await env.api.install("voice");
  await until(() => env.api.packStatus("voice").state === "partial", "uncontrolled response cannot mark installed");
  assert.match(env.api.packStatus("voice").error, /not saved for this release/);
  for (const file of VOICE_RUNTIME) await env.shell.put("https://app.test/ASound/" + file, new Response("verified runtime"));
  const calls = env.requests.length;
  await env.api.install("voice");
  await until(() => env.api.packStatus("voice").state === "installed", "a retry can reuse a runtime another tab already cached");
  assert.equal(env.requests.length, calls, "already cached runtime repair makes zero network requests");
  assert.equal(env.downloads.length, 1);
});

test("first installation waits for its own controller and cancelling the wait does not restart later", async () => {
  const env = await fixture({ release: "test-v1", controlled: false, prefs: { source: "hf" } });
  await env.api.install("voice");
  await until(() => env.swEvents.size === 1, "the runtime must wait for first service worker activation");
  assert.equal(env.api.packStatus("voice").state, "downloading");
  assert.deepEqual(env.runtimeRequests, []);
  await env.api.cancel("voice");
  assert.equal(env.swEvents.size, 0);
  assert.equal(env.api.packStatus("voice").state, "partial");
  await env.control(); env.runIdle(); await flush();
  assert.deepEqual(env.runtimeRequests, [], "controllerchange and startup idle cannot revive a cancelled job");
  await env.api.install("voice");
  await until(() => env.api.packStatus("voice").state === "installed", "explicit retry works after the controller is ready");
  assert.equal(env.downloads.length, 1);
});

test("first installation continues on controllerchange and caches only the selected ASR runtime", async () => {
  const env = await fixture({ release: "test-v1", controlled: false, prefs: { source: "hf" } });
  await env.api.install("asr-tiny");
  await until(() => env.swEvents.size === 1, "waiting for first controller");
  await env.control();
  await until(() => env.api.packStatus("asr-tiny").state === "installed", "controller activation should unblock the pending job");
  assert.deepEqual(env.runtimeRequests, ["vendor/transformers/transformers.min.js", ...ONNX]);
  assert.equal(env.swEvents.size, 0);
});

test("cancelling a runtime fetch aborts it, preserves the weights, and allows a clean retry", async () => {
  const entered = deferred();
  const env = await fixture({ release: "test-v1", prefs: { source: "hf" }, runtimeFetch: async (_url, { signal }) => {
    entered.resolve(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  await env.api.install("voice"); const signal = await entered.promise;
  let replacementMessages = 0;
  env.serviceWorker.controller = { scriptURL: "https://app.test/ASound/sw.js", postMessage: () => { replacementMessages++; } };
  await env.api.cancel("voice");
  assert.equal(signal.aborted, true);
  assert.equal(replacementMessages, 0, "cancellation is sent to the controller captured when the fetch began");
  assert.equal(env.runtimeCancels.length, 1);
  assert.equal(env.runtimeCancels[0].type, "ASOUND_CANCEL_RUNTIME");
  assert.equal(env.runtimeCancels[0].requestId, env.requests.find(r => r.options.headers?.["X-ASound-Runtime-Request"]).options.headers["X-ASound-Runtime-Request"]);
  assert.equal(env.api.packStatus("voice").state, "partial");
  env.runtimeFetch = null;
  await env.api.install("voice");
  await until(() => env.api.packStatus("voice").state === "installed", "cancelled runtime can be retried");
  assert.equal(env.downloads.length, 1);
});

test("startup repairs old weight-only packs in the serial queue without blocking initialization", async () => {
  const entered = deferred(), release = deferred();
  const env = await fixture({ release: "test-v1", cached: ["asr-tiny", "voice"], prefs: { source: "hf" }, runtimeFetch: async (url, _options, env) => {
    entered.resolve(); await release.promise;
    const response = new Response("verified runtime"); await env.shell.put(url, response.clone()); return response;
  } });
  assert.equal(env.api.packStatus("voice").state, "partial");
  assert.equal(env.api.packStatus("asr-tiny").state, "partial");
  assert.deepEqual(env.runtimeRequests, [], "initPacks returns before main registers the worker");
  env.runIdle(); await entered.promise;
  assert.equal(env.api.packStatus("voice").state, "queued");
  assert.equal(env.runtimeRequests.length, 1, "runtime loads are serial");
  release.resolve();
  await until(() => env.api.packStatus("voice").state === "installed", "queued repair should complete");
  assert.equal(env.downloads.length, 0);
  assert.deepEqual(env.runtimeRequests, ["vendor/transformers/transformers.min.js", ...ONNX, ...VOICE_RUNTIME],
    "ASR retains its runtime while voice repairs the separate WASM-only runtime");
});

test("an already verified release pack is installed offline with no runtime downloads", async () => {
  const env = await fixture({ release: "test-v1", cached: ["voice"], runtimeFiles: VOICE_RUNTIME,
    fetchRemote: async () => { throw new TypeError("offline"); } });
  assert.equal(env.api.packStatus("voice").state, "installed");
  env.runIdle(); await flush();
  assert.deepEqual(env.runtimeRequests, []);
  assert.equal(env.downloads.length, 0);
});
