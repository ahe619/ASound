// Release snapshots for the hosted PWA. tools/build_web.py fills these two lines.
// An unfinished download never replaces the working release, and activation is opt-in.
const RELEASE = "development"; // @asound-release
const ASSETS = []; // @asound-assets

const SCOPE = new URL(self.registration.scope);
const PREFIX = `asound-shell-v2:${encodeURIComponent(SCOPE.href)}:`;
const CACHE = PREFIX + RELEASE;
const MARKER = new URL("__asound_release__", SCOPE).href;
const urls = new Set(ASSETS.map((a) => new URL(a.url, SCOPE).href));
const indexURL = new URL("index.html", SCOPE).href;
const runtimeRequests = new Map();
const cancelledRuntimes = new Map();
const RUNTIME_CANCEL_TTL = 60000;
const RUNTIME_REQUEST_LIMIT = 128;
const runtimeId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{16,96}$/.test(value);
// AbortSignal.throwIfAborted needs Safari 15.4 / Chromium 100; a TypeError in the fetch
// handler would answer every request with the offline 503 on older devices.
const checkAborted = (signal) => { if (signal && signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError"); };
// Releases 0.3.2-0.3.6 called throwIfAborted directly. Their snapshots have no abortSafe marker.
const ABORT_UNSAFE_RELEASE = /^0\.3\.[2-6]-/;
const MIRROR_CONNECT_MS = 10000;
const MIRROR_IDLE_MS = 20000;
const MIRROR_TOTAL_MS = 180000;
const MIRROR_RUNTIME = new Set(["kokoro/kokoro.web.js", "kokoro/neural-tts.js", "kokoro/lexicon-us.json",
  "kokoro/ort-cpu/ort-wasm-simd-threaded.mjs", "kokoro/ort-cpu/ort-wasm-simd-threaded.wasm"]);

function validMirrors(asset) {
  if (asset.mirrors === undefined) return true;
  if (!asset.lazy || !(MIRROR_RUNTIME.has(asset.url) || /^audio\/voices\/(?:af|am)_[a-z]+\.wav$/.test(asset.url)) ||
      !Number.isSafeInteger(asset.size) || asset.size < 0 || !Array.isArray(asset.mirrors) ||
      asset.mirrors.length > 3 || new Set(asset.mirrors).size !== asset.mirrors.length) return false;
  return asset.mirrors.every(value => {
    try {
      const url = new URL(value);
      const secure = url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
      return typeof value === "string" && secure && !url.username && !url.password &&
        !url.search && !url.hash && url.pathname.endsWith(`/assets/${asset.sha256}/${asset.url}`);
    } catch { return false; }
  });
}

function mediaType(asset) {
  if (/\.m?js$/.test(asset.url)) return "text/javascript";
  if (/\.wasm$/.test(asset.url)) return "application/wasm";
  if (/\.json$/.test(asset.url)) return "application/json";
  if (/\.wav$/.test(asset.url)) return "audio/wav";
  return "";
}

function validMediaType(response, expected) {
  const actual = (response.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  if (expected === "text/javascript") return /^(?:text|application)\/(?:javascript|ecmascript)$/.test(actual);
  if (expected === "audio/wav") return ["audio/wav", "audio/wave", "audio/x-wav"].includes(actual);
  return actual === expected;
}

// Mirrors are release-manifest entries, never user-supplied runtime script URLs.
// Read and verify before publishing. Reconstructing the response clears its remote
// URL, so a JS module's relative imports resolve against the original same-origin request.
async function boundedMirrorAsset(asset, url, signal, cache, mirror) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let idle = setTimeout(() => controller.abort(new Error("Asset connection timed out")), MIRROR_CONNECT_MS);
  // The final site may be slow but healthy; sustained progress must be allowed
  // to complete there even when an optional mirror's total time limit expired.
  const total = mirror ? setTimeout(() => controller.abort(new Error("Asset download timed out")), MIRROR_TOTAL_MS) : null;
  let reader;
  try {
    const response = await fetch(new Request(url, { cache, credentials: mirror ? "omit" : "same-origin",
      mode: mirror ? "cors" : "same-origin", signal: controller.signal }));
    const expected = mediaType(asset);
    if (!response.ok || response.type === "opaque" || !validMediaType(response, expected)) throw new Error("Invalid asset response");
    reader = response.body?.getReader();
    if (!reader) throw new Error("Asset response has no body");
    const chunks = []; let size = 0;
    while (true) {
      checkAborted(controller.signal);
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(new Error("Asset download stalled")), MIRROR_IDLE_MS);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > asset.size) throw new Error("Asset response exceeds its release size");
      chunks.push(value);
    }
    if (size !== asset.size) throw new Error("Asset response size mismatch");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    chunks.length = 0;
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    if (Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") !== asset.sha256) throw new Error("Asset hash mismatch");
    checkAborted(controller.signal);
    return new Response(bytes, { headers: { "Content-Type": expected, "Content-Length": String(size) } });
  } finally {
    clearTimeout(idle); clearTimeout(total);
    signal?.removeEventListener("abort", abort);
    if (reader) reader.cancel().catch(() => {});
    controller.abort();
  }
}

async function fetchAsset(asset, url, signal, cache) {
  if (!validMirrors(asset)) throw new Error("Invalid release mirrors");
  if (!asset.mirrors?.length) {
    const response = await fetch(new Request(url, { cache, credentials: "same-origin", signal }));
    if (response.ok && response.type !== "opaque" && await digest(response) === asset.sha256) {
      checkAborted(signal);
      return response;
    }
  } else {
    for (const source of [...asset.mirrors, url]) {
      checkAborted(signal);
      try { return await boundedMirrorAsset(asset, source, signal, cache, source !== url); }
      catch (error) { checkAborted(signal); }
    }
  }
  throw new Error(`The release file could not be verified: ${asset.url}`);
}

function pruneRuntimeCancellations() {
  const before = Date.now() - RUNTIME_CANCEL_TTL;
  for (const [key, time] of cancelledRuntimes) if (time <= before) cancelledRuntimes.delete(key);
  while (cancelledRuntimes.size > RUNTIME_REQUEST_LIMIT) cancelledRuntimes.delete(cancelledRuntimes.keys().next().value);
}

function runtimeRequest(event, asset) {
  const id = event.request.headers.get("X-ASound-Runtime-Request");
  if (!event.clientId || !runtimeId(id) || !asset.lazy || !/^(?:vendor|kokoro)\//.test(asset.url)) return null;
  pruneRuntimeCancellations();
  const key = `${event.clientId}\n${id}`;
  // Never let a repeated ID replace another in-flight request's controller.
  if (runtimeRequests.has(key) || runtimeRequests.size >= RUNTIME_REQUEST_LIMIT) return { rejected: true };
  const task = { key, controller: new AbortController() };
  runtimeRequests.set(key, task);
  if (cancelledRuntimes.has(key)) task.controller.abort();
  return task;
}

function inScope(url) {
  return url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname);
}

async function digest(response) {
  const bytes = await response.clone().arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function completeCaches() {
  const out = [];
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX) || name === CACHE) continue;
    const cache = await caches.open(name);
    const marker = await cache.match(MARKER);
    if (!marker) continue;
    try {
      const data = await marker.json();
      out.push({ name, cache, installed: data.installed || 0, version: String(data.version || ""), abortSafe: data.abortSafe === true });
    } catch {}
  }
  return out.sort((a, b) => b.installed - a.installed);
}

async function installRelease() {
  // Raw app/ is for online development; release snapshots must come from build_web.py.
  if (!ASSETS.length || RELEASE === "development") throw new Error("Build the web release first.");
  const seen = new Set();
  for (const asset of ASSETS) {
    const url = new URL(asset.url, SCOPE);
    if (!inScope(url) || asset.url.startsWith("/") || url.search || url.hash ||
        /^(?:models|dev|api)\//.test(asset.url) || asset.url === "sw.js" ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) || seen.has(url.href) || !validMirrors(asset)) {
      throw new Error("Invalid release manifest.");
    }
    seen.add(url.href);
  }
  if (!seen.has(indexURL)) throw new Error("The release has no index.html.");

  const previous = await completeCaches();
  const target = await caches.open(CACHE);
  try {
    for (const asset of ASSETS) {
      const url = new URL(asset.url, SCOPE).href;
      let response = null;
      // The runtimes and fonts seldom change. Reuse them without downloading them again.
      for (const old of previous) {
        const hit = await old.cache.match(url);
        if (hit && await digest(hit) === asset.sha256) { response = hit; break; }
      }
      // On-demand assets (speech runtimes, word pictures) are not downloaded up front: a first visit on a phone
      // should not fetch tens of megabytes it may never use. The fetch handler caches them, verified, on first use.
      // One this device already used (an older release holds it) changed in this release: fetch it now, so the
      // update still works offline.
      if (!response && asset.lazy) {
        let used = false;
        for (const old of previous) if (await old.cache.match(url)) { used = true; break; }
        if (!used) continue;
      }
      if (!response) {
        // no-cache: a conditional request, so files the page just loaded come back as 304 (still hash-checked)
        response = await fetchAsset(asset, url, undefined, "no-cache");
      }
      await target.put(url, response);
    }
    // Only a completely verified snapshot gets this marker.
    await target.put(MARKER, new Response(JSON.stringify({ version: RELEASE, installed: Date.now(), abortSafe: true }), {
      headers: { "Content-Type": "application/json" },
    }));
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
}

function workerVersion(worker) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let finished = false;
    const finish = (version) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(typeof version === "string" && version.length <= 96 ? version : "");
    };
    const timer = setTimeout(() => finish(""), 3000);
    channel.port1.onmessage = (event) => finish(event.data?.version);
    try { worker.postMessage({ type: "ASOUND_VERSION" }, [channel.port2]); }
    catch { channel.port2.close(); finish(""); }
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await installRelease(); // Normally activation waits for the user's explicit update request.
    if ("throwIfAborted" in AbortSignal.prototype) return;
    const active = self.registration.active;
    if (!active) return;
    // A newer complete cache can belong to a waiting worker. Ask the actual active
    // worker: even a release with a broken fetch handler can answer this message.
    const version = await workerVersion(active).catch(() => "");
    if (self.registration.active !== active || !ABORT_UNSAFE_RELEASE.test(version)) return;
    const previous = (await completeCaches()).find(release => release.name === PREFIX + version && release.version === version);
    // Missing/uncertain replies or markers keep the normal multi-window update flow.
    if (self.registration.active === active && previous && !previous.abortSafe) await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Preserve the preceding complete release. Never touch model or other projects' caches.
    const old = await completeCaches();
    const doomed = old.slice(1);
    // An on-demand file first used after this release was installed may sit only in a cache deleted below
    // (several updates arrived while one window stayed open). Keep a verified copy.
    const target = await caches.open(CACHE);
    for (const asset of doomed.length ? ASSETS.filter((a) => a.lazy) : []) {
      const url = new URL(asset.url, SCOPE).href;
      if (await target.match(url)) continue;
      for (const release of doomed) {
        const hit = await release.cache.match(url);
        if (hit && await digest(hit) === asset.sha256) { await target.put(url, hit); break; }
      }
    }
    for (const release of doomed) await caches.delete(release.name);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const reply = (data) => event.ports[0] && event.ports[0].postMessage(data);
  if (event.data && event.data.type === "ASOUND_VERSION") {
    reply({ version: RELEASE });
    return;
  }
  if (event.data?.type === "ASOUND_CANCEL_RUNTIME") {
    const source = event.source;
    if (!source?.id || !source.url || !inScope(new URL(source.url)) || !runtimeId(event.data.requestId)) return;
    const key = `${source.id}\n${event.data.requestId}`;
    // Messages can arrive before the associated fetch event. Keep bounded, short-
    // lived tombstones, scoped to the sending browser client, for that ordering.
    cancelledRuntimes.delete(key);
    cancelledRuntimes.set(key, Date.now());
    pruneRuntimeCancellations();
    runtimeRequests.get(key)?.controller.abort();
    reply({ ok: true });
    return;
  }
  if (!event.data || event.data.type !== "ASOUND_APPLY_UPDATE") return;
  event.waitUntil((async () => {
    const source = event.source;
    if (!source || !source.url || !inScope(new URL(source.url))) { reply({ ok: false, reason: "source" }); return; }
    const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .filter((client) => inScope(new URL(client.url)));
    if (windows.length !== 1 || windows[0].id !== source.id) { reply({ ok: false, reason: "tabs" }); return; }
    reply({ ok: true });
    await self.skipWaiting();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!inScope(url)) return;
  // Queries such as ?web / ?nogpu select an app mode, not another static release.
  url.search = "";
  url.hash = "";
  if (url.href === SCOPE.href) url.href = indexURL;
  if (!urls.has(url.href)) return; // Models, API calls and unrelated URLs have their own policies.
  const asset = ASSETS.find((a) => new URL(a.url, SCOPE).href === url.href);
  const runtime = runtimeRequest(event, asset);
  event.respondWith((async () => {
    try {
      if (runtime?.rejected) throw new Error("Runtime request limit or duplicate ID");
      const signal = runtime?.controller.signal || request.signal;
      checkAborted(signal);
      const cached = await (await caches.open(CACHE)).match(url.href);
      checkAborted(signal);
      if (cached) return cached;
      // A browser can evict an individual file. Recover only this exact release's bytes.
      // An on-demand file first used after this release was installed sits in the previous release's cache.
      for (const old of await completeCaches()) {
        const hit = await old.cache.match(url.href);
        if (hit && await digest(hit) === asset.sha256) {
          checkAborted(signal);
          await (await caches.open(CACHE)).put(url.href, hit.clone());
          return hit;
        }
      }
      const response = await fetchAsset(asset, url.href, signal, "no-store");
      checkAborted(signal);
      await (await caches.open(CACHE)).put(url.href, response.clone());
      return response;
    } catch {} finally {
      if (runtime?.key && runtimeRequests.get(runtime.key) === runtime) runtimeRequests.delete(runtime.key);
    }
    return new Response("This version is not available offline. Reconnect and check for an update.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  })());
});
