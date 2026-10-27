import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";

const source = await readFile(new URL("../app/sw.js", import.meta.url), "utf8");
const SCOPE = "https://example.test/ASound/";
const prefix = `asound-shell-v2:${encodeURIComponent(SCOPE)}:`;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const assets = (files) => Object.entries(files).map(([url, text]) => ({ url, sha256: hash(text) }));

class CacheStorage {
  data = new Map();
  deleted = [];
  async open(name) {
    if (!this.data.has(name)) this.data.set(name, new Map());
    const rows = this.data.get(name);
    return {
      match: async (key) => rows.get(String(key.url || key))?.clone(),
      put: async (key, response) => { rows.set(String(key.url || key), response.clone()); },
    };
  }
  async keys() { return [...this.data.keys()]; }
  async delete(name) { this.deleted.push(name); return this.data.delete(name); }
}

function worker(version, files, storage = new CacheStorage(), manifest = assets(files)) {
  const events = new Map();
  const env = {
    storage, files: { ...files }, fetched: [], skipped: 0, claimed: 0,
    windows: [{ id: "one", url: SCOPE }],
  };
  const context = {
    URL, Request, Response, AbortController, Date: class extends Date { static now() { return env.now ?? Date.now(); } },
    Uint8Array, crypto: webcrypto, caches: storage,
    fetch: async (request) => {
      const relative = String(request.url || request).slice(SCOPE.length);
      env.fetched.push(relative);
      if (env.interceptFetch) return env.interceptFetch(request);
      if (!(relative in env.files)) return new Response("missing", { status: 404 });
      return new Response(env.files[relative]);
    },
    self: {
      registration: { scope: SCOPE },
      addEventListener: (name, fn) => events.set(name, fn),
      skipWaiting: async () => { env.skipped++; },
      clients: { claim: async () => { env.claimed++; }, matchAll: async () => env.windows },
    },
  };
  const script = source
    .replace(/const RELEASE = .*; \/\/ @asound-release/, `const RELEASE = ${JSON.stringify(version)};`)
    .replace(/const ASSETS = .*; \/\/ @asound-assets/, `const ASSETS = ${JSON.stringify(manifest)};`);
  vm.runInNewContext(script, context);
  env.dispatch = async (name, data = {}) => {
    let work;
    events.get(name)({ ...data, waitUntil: (promise) => { work = promise; }, respondWith: (promise) => { work = promise; } });
    return work;
  };
  env.message = async (type, from = env.windows[0]) => {
    let reply;
    await env.dispatch("message", { data: { type }, source: from, ports: [{ postMessage: (data) => { reply = data; } }] });
    return reply;
  };
  env.get = (path) => env.dispatch("fetch", { request: new Request(new URL(path, SCOPE)) });
  return env;
}

test("a release installs atomically and pins offline resources without auto-activation", async () => {
  const w = worker("one", { "index.html": "page one", "js/main.js": "script one" });
  await w.dispatch("install");
  assert.equal(w.skipped, 0);
  assert.equal((await w.message("ASOUND_VERSION")).version, "one");
  w.files = { "index.html": "page two", "js/main.js": "script two" };
  w.fetched = [];
  assert.equal(await (await w.get("?web")).text(), "page one");
  assert.equal(await (await w.get("js/main.js?refresh=1")).text(), "script one");
  assert.deepEqual(w.fetched, []);
  assert.equal(await w.get("models/large.bin"), undefined);
  assert.equal(await w.get("api/health"), undefined);
});

test("a bad download cannot destroy the working release or model cache", async () => {
  const old = worker("one", { "index.html": "old", "js/main.js": "old script" });
  await old.dispatch("install");
  await (await old.storage.open("asound-models-v1")).put("model", new Response("AI weights"));
  const next = worker("two", { "index.html": "new", "js/main.js": "new script" }, old.storage);
  next.files["js/main.js"] = "CDN is still serving the old script";
  await assert.rejects(next.dispatch("install"), /could not be verified/);
  assert.equal(old.storage.data.has(prefix + "two"), false);
  assert.equal(await (await old.get("index.html")).text(), "old");
  assert.equal(await (await (await old.storage.open("asound-models-v1")).match("model")).text(), "AI weights");
  assert.equal(next.skipped, 0);
});

test("unchanged assets are reused from verified snapshots", async () => {
  const old = worker("one", { "index.html": "old", "runtime.wasm": "large unchanging runtime" });
  await old.dispatch("install");
  const next = worker("two", { "index.html": "new", "runtime.wasm": "large unchanging runtime" }, old.storage);
  await next.dispatch("install");
  assert.deepEqual(next.fetched, ["index.html"]);
  assert.equal(await (await next.get("runtime.wasm")).text(), "large unchanging runtime");
  assert.equal(next.skipped, 0);
});

test("on-demand assets are fetched on first use, verified, and kept for the next release", async () => {
  const files = { "index.html": "page", "vendor/runtime.wasm": "big runtime" };
  const manifest = assets(files).map((a) => (a.url.startsWith("vendor/") ? { ...a, lazy: true } : a));
  const old = worker("one", files, new CacheStorage(), manifest);
  await old.dispatch("install");
  assert.deepEqual(old.fetched, ["index.html"]);
  old.files["vendor/runtime.wasm"] = "tampered runtime";
  assert.equal((await old.get("vendor/runtime.wasm")).status, 503);
  old.files["vendor/runtime.wasm"] = "big runtime";
  assert.equal(await (await old.get("vendor/runtime.wasm")).text(), "big runtime");
  const next = worker("two", { ...files, "index.html": "page two" }, old.storage,
    assets({ ...files, "index.html": "page two" }).map((a) => (a.url.startsWith("vendor/") ? { ...a, lazy: true } : a)));
  await next.dispatch("install");
  assert.deepEqual(next.fetched, ["index.html"]);
  next.fetched = [];
  assert.equal(await (await next.get("vendor/runtime.wasm")).text(), "big runtime");
  assert.deepEqual(next.fetched, []);
});

test("an on-demand asset cached by the old release after the update was installed still works offline", async () => {
  const files = { "index.html": "page", "vendor/runtime.wasm": "big runtime" };
  const lazy = (f) => assets(f).map((a) => (a.url.startsWith("vendor/") ? { ...a, lazy: true } : a));
  const old = worker("one", files, new CacheStorage(), lazy(files));
  await old.dispatch("install");
  const next = worker("two", { ...files, "index.html": "page two" }, old.storage, lazy({ ...files, "index.html": "page two" }));
  await next.dispatch("install");
  assert.equal(await (await old.get("vendor/runtime.wasm")).text(), "big runtime"); // first use, still on the old release
  next.files = {}; // offline
  next.fetched = [];
  assert.equal(await (await next.get("vendor/runtime.wasm")).text(), "big runtime");
  assert.deepEqual(next.fetched, []);
});

test("an on-demand asset this device used is fetched at install when the update changes it", async () => {
  const lazy = (f) => assets(f).map((a) => (a.url.startsWith("vendor/") ? { ...a, lazy: true } : a));
  const files = { "index.html": "page", "vendor/runtime.js": "runtime one", "vendor/unused.wasm": "unused one" };
  const old = worker("one", files, new CacheStorage(), lazy(files));
  await old.dispatch("install");
  await old.dispatch("activate");
  assert.equal(await (await old.get("vendor/runtime.js")).text(), "runtime one"); // used online
  const changed = { "index.html": "page two", "vendor/runtime.js": "runtime two", "vendor/unused.wasm": "unused two" };
  const next = worker("two", changed, old.storage, lazy(changed));
  await next.dispatch("install");
  assert.deepEqual(next.fetched, ["index.html", "vendor/runtime.js"], "a file never used stays on demand");
  await next.dispatch("activate");
  next.files = {}; // the first launch of the update is offline
  next.fetched = [];
  assert.equal(await (await next.get("vendor/runtime.js")).text(), "runtime two");
  assert.deepEqual(next.fetched, []);
});

test("a release that cached every file keeps a changed runtime offline after the update makes it on demand", async () => {
  const files = { "index.html": "page", "kokoro/neural-tts.js": "tts one" };
  const old = worker("one", files);
  await old.dispatch("install");
  await old.dispatch("activate");
  const changed = { "index.html": "page two", "kokoro/neural-tts.js": "tts two" };
  const next = worker("two", changed, old.storage, assets(changed).map((a) => (a.url.startsWith("kokoro/") ? { ...a, lazy: true } : a)));
  await next.dispatch("install");
  await next.dispatch("activate");
  next.files = {};
  assert.equal(await (await next.get("kokoro/neural-tts.js")).text(), "tts two");
});

test("activation keeps an on-demand asset that only a deleted release had cached", async () => {
  const files = { "index.html": "page", "vendor/runtime.wasm": "big runtime" };
  const lazy = (f) => assets(f).map((a) => (a.url.startsWith("vendor/") ? { ...a, lazy: true } : a));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5)); // distinct install times
  const one = worker("one", files, new CacheStorage(), lazy(files));
  await one.dispatch("install");
  await one.dispatch("activate");
  await tick();
  const two = worker("two", { ...files, "index.html": "page two" }, one.storage, lazy({ ...files, "index.html": "page two" }));
  await two.dispatch("install"); // waits, and is then replaced by three before it ever runs
  await tick();
  const three = worker("three", { ...files, "index.html": "page three" }, one.storage, lazy({ ...files, "index.html": "page three" }));
  await three.dispatch("install");
  assert.equal(await (await one.get("vendor/runtime.wasm")).text(), "big runtime"); // first use, still on release one
  await three.dispatch("activate");
  assert.deepEqual(one.storage.deleted, [prefix + "one"]);
  three.files = {};
  three.fetched = [];
  assert.equal(await (await three.get("vendor/runtime.wasm")).text(), "big runtime");
  assert.deepEqual(three.fetched, []);
});

test("an explicit runtime cancellation aborts its owned network request without publishing an incomplete entry", async () => {
  const files = { "index.html": "page", "vendor/runtime.wasm": "runtime" };
  const w = worker("one", files, new CacheStorage(), assets(files).map(a => a.url.startsWith("vendor/") ? { ...a, lazy: true } : a));
  await w.dispatch("install");
  let networkSignal;
  w.interceptFetch = request => {
    networkSignal = request.signal;
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  };
  const id = "runtime-request-0001";
  const pending = w.dispatch("fetch", { clientId: "one", request: new Request(new URL("vendor/runtime.wasm", SCOPE), { headers: { "X-ASound-Runtime-Request": id } }) });
  while (!networkSignal) await new Promise(resolve => setImmediate(resolve));
  await w.dispatch("message", { data: { type: "ASOUND_CANCEL_RUNTIME", requestId: id }, source: { id: "two", url: SCOPE }, ports: [] });
  assert.equal(networkSignal.aborted, false, "a different client cannot cancel the request with the same ID");
  await w.dispatch("message", { data: { type: "ASOUND_CANCEL_RUNTIME", requestId: id }, source: w.windows[0], ports: [] });
  assert.equal(networkSignal.aborted, true);
  assert.equal((await pending).status, 503);
  assert.equal(await (await w.storage.open(prefix + "one")).match(SCOPE + "vendor/runtime.wasm"), undefined);
});

test("early runtime cancellations are client-scoped, bounded, and expire before a later retry", async () => {
  const files = { "index.html": "page", "vendor/runtime.wasm": "runtime" };
  const w = worker("one", files, new CacheStorage(), assets(files).map(a => a.url.startsWith("vendor/") ? { ...a, lazy: true } : a));
  await w.dispatch("install"); w.fetched.length = 0;
  const cancel = (id, source = w.windows[0]) => w.dispatch("message", { data: { type: "ASOUND_CANCEL_RUNTIME", requestId: id }, source, ports: [] });
  const get = (id, clientId = "one") => w.dispatch("fetch", { clientId, request: new Request(new URL("vendor/runtime.wasm", SCOPE), { headers: { "X-ASound-Runtime-Request": id } }) });
  const id = "early-runtime-request";
  await cancel(id);
  assert.equal((await get(id)).status, 503);
  assert.deepEqual(w.fetched, [], "cancel-before-fetch must never start a network request");
  assert.equal(await (await get(id, "two")).text(), "runtime", "another client with the same ID is unaffected");
  w.storage.data.get(prefix + "one").delete(SCOPE + "vendor/runtime.wasm");
  w.now = Date.now() + 61000;
  assert.equal(await (await get(id)).text(), "runtime", "expired records must not block later requests");
  w.storage.data.get(prefix + "one").delete(SCOPE + "vendor/runtime.wasm");
  const first = "bounded-runtime-000";
  await cancel(first);
  for (let i = 1; i <= 128; i++) await cancel(`bounded-runtime-${String(i).padStart(3, "0")}`);
  assert.equal(await (await get(first)).text(), "runtime", "oldest tombstone is evicted at the capacity bound");
});

test("activation requires one requesting app window and ignores other projects", async () => {
  const w = worker("two", { "index.html": "new" });
  await w.dispatch("install");
  w.windows.push({ id: "two", url: SCOPE + "?web" });
  assert.equal((await w.message("ASOUND_APPLY_UPDATE")).reason, "tabs");
  assert.equal(w.skipped, 0);
  w.windows.pop();
  w.windows.push({ id: "other", url: "https://example.test/OtherApp/" });
  assert.equal((await w.message("ASOUND_APPLY_UPDATE")).ok, true);
  assert.equal(w.skipped, 1);
  assert.equal((await w.message("ASOUND_APPLY_UPDATE", { id: "other", url: "https://evil.test/" })).reason, "source");
  assert.equal(w.skipped, 1);
});

test("cleanup retains the preceding complete release and every unrelated cache", async () => {
  const storage = new CacheStorage();
  const marker = SCOPE + "__asound_release__";
  for (const [version, installed] of [["ancient", 1], ["previous", 2]]) {
    await (await storage.open(prefix + version)).put(marker, new Response(JSON.stringify({ installed })));
  }
  for (const name of ["asound-models-v1", "asound-shell-legacy", "asound-shell-v2:another-scope:old"]) await storage.open(name);
  const w = worker("new", { "index.html": "new" }, storage);
  await w.dispatch("install");
  await w.dispatch("activate");
  assert.deepEqual(storage.deleted, [prefix + "ancient"]);
  assert.equal(storage.data.has(prefix + "previous"), true);
  assert.equal(w.claimed, 1);
});

test("an evicted old asset cannot be replaced with new-release bytes", async () => {
  const w = worker("one", { "index.html": "old page" });
  await w.dispatch("install");
  w.storage.data.get(prefix + "one").delete(SCOPE + "index.html");
  w.files["index.html"] = "new page";
  assert.equal((await w.get("index.html")).status, 503);
  w.files["index.html"] = "old page";
  assert.equal(await (await w.get("index.html")).text(), "old page");
});

test("source-tree workers and escaped release manifests do not install", async () => {
  await assert.rejects(worker("development", {}).dispatch("install"), /Build the web release/);
  const w = worker("bad", {}, new CacheStorage(), [{ url: "../another.js", sha256: hash("bad") }]);
  await assert.rejects(w.dispatch("install"), /Invalid release manifest/);
});
