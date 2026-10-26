import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../app/js/packs.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")
  + "\nglobalThis.api = { initPacks, recommended, activePacks, variant, ready, packStatus, packMode, sourceList, engineConfig, fileUrl, canonKey, checkConnections, connectionStatus, resolvedSource, refresh, install, cancel, remove, setSource };";
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
  data = catalog(), prefs = {}, flags = {}, cached = [], partial = {}, fetchRemote = null, download = null } = {}) {
  const cache = new MemoryCache();
  const stored = new Map([["asound.llmCached.v1", JSON.stringify(flags)]]);
  const env = { cache, stored, data, requests: [], downloads: [], removedPartial: [], warnings: [], saved: 0,
    partials: new Map(), prefs: { source: "auto", llm: "", asr: "", ...prefs },
    remote: fetchRemote || (async (url) => url.endsWith(".wasm")
      ? new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0))
      : Response.json({ model_type: "moonshine" })) };
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
      userAgent: mobile ? "Android Mobile" : "Windows Desktop",
      userAgentData: { mobile }, deviceMemory: 8,
      gpu: gpu ? { requestAdapter: async () => ({ features: new Set(f16 ? ["shader-f16"] : []), info: { vendor } }) } : undefined,
      storage: { persist: async () => true, estimate: async () => ({ quota: 100000, usage: 0 }) },
    },
    prefs: env.prefs, savePrefs: () => { env.saved++; },
    localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    caches: { open: async () => cache },
    modelPartialBytes: async (key) => env.partials.get(key) || 0,
    discardModelPartial: async (key) => { env.removedPartial.push(key); env.partials.delete(key); },
    downloadModelFile: async (args) => {
      env.downloads.push(args);
      if (download) return download(args, env);
      args.signal.throwIfAborted();
      await args.cache.put(args.key, new Response(new Uint8Array(args.file.size)));
      args.onBytes(args.file.size);
    },
    window: { ASoundAI: { download: async (_config, progress, signal) => { signal.throwIfAborted(); progress(1); } } },
    fetch: async (url, options = {}) => {
      env.requests.push({ url: String(url), options });
      if (url === "packs.json") return Response.json(data);
      if (url === "api/health") return Response.json({ packs: desktop });
      if (url === "api/packs" || String(url).startsWith("api/packs/")) return Response.json({ packs: {}, free: 100000 });
      return env.remote(String(url), options);
    },
  };
  vm.runInNewContext(source, context, { filename: "packs.js" });
  env.api = context.api;
  await env.api.initPacks();
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
  assert.ok(env.requests.every((r) => !r.url.startsWith("https://")), "the configured default needs no outside probes");
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
