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
    try { out.push({ name, cache, installed: (await marker.json()).installed || 0 }); } catch {}
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
        !/^[a-f0-9]{64}$/.test(asset.sha256) || seen.has(url.href)) {
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
      if (!response && asset.lazy) continue;
      if (!response) {
        // no-cache: a conditional request, so files the page just loaded come back as 304 (still hash-checked)
        response = await fetch(new Request(url, { cache: "no-cache", credentials: "same-origin" }));
        if (!response.ok || response.type === "opaque" || await digest(response) !== asset.sha256) {
          throw new Error(`The release file could not be verified: ${asset.url}`);
        }
      }
      await target.put(url, response);
    }
    // Only a completely verified snapshot gets this marker.
    await target.put(MARKER, new Response(JSON.stringify({ version: RELEASE, installed: Date.now() }), {
      headers: { "Content-Type": "application/json" },
    }));
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(installRelease()); // Deliberately wait for the user or for all old windows to close.
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Preserve the preceding complete release. Never touch model or other projects' caches.
    const old = await completeCaches();
    for (const release of old.slice(1)) await caches.delete(release.name);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const reply = (data) => event.ports[0] && event.ports[0].postMessage(data);
  if (event.data && event.data.type === "ASOUND_VERSION") {
    reply({ version: RELEASE });
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
  event.respondWith((async () => {
    const cached = await (await caches.open(CACHE)).match(url.href);
    if (cached) return cached;
    // A browser can evict an individual file. Recover only this exact release's bytes.
    const asset = ASSETS.find((a) => new URL(a.url, SCOPE).href === url.href);
    try {
      const response = await fetch(new Request(url.href, { cache: "no-store", credentials: "same-origin" }));
      if (response.ok && response.type !== "opaque" && await digest(response) === asset.sha256) {
        await (await caches.open(CACHE)).put(url.href, response.clone());
        return response;
      }
    } catch {}
    return new Response("This version is not available offline. Reconnect and check for an update.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  })());
});
