// Browser downloads for ASR, TTS and CPU model files. WebLLM owns its own download/cache path.
// Completed 4 MiB ranges survive refreshes; only a verified complete response enters the model cache.
const PARTIAL_CACHE = "asound-model-partials-v1";
const CHUNK_BYTES = 4 * 1024 * 1024;
const IDLE_MS = 30000;
const PREFIX = "https://models.asound.invalid/__partial__/";
const flights = new Map();
const baseKey = (key) => PREFIX + encodeURIComponent(key) + "/";
const strongEtag = (response) => {
  const value = response.headers.get("etag");
  return value && /^"[^\r\n]*"$/.test(value) ? value : null;
};
const expectedHash = (file) => String(file.sha256 || "").toLowerCase();
const abortError = () => new DOMException("Download cancelled", "AbortError");
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
class InvalidDownload extends Error {}

async function clearPartial(cache, key) {
  const prefix = baseKey(key);
  for (const request of await cache.keys()) if (request.url.startsWith(prefix)) await cache.delete(request);
}

export async function discardModelPartial(key) {
  return exclusive(key, undefined, async () => {
    const cache = await caches.open(PARTIAL_CACHE);
    await clearPartial(cache, key);
  });
}

async function metadata(cache, key, file) {
  try {
    const response = await cache.match(baseKey(key) + "meta");
    if (!response) return null;
    const meta = await response.json();
    if (meta.version !== 1 || meta.size !== file.size || meta.sha256 !== expectedHash(file)
      || meta.chunkBytes !== CHUNK_BYTES || !Number.isSafeInteger(meta.done) || meta.done < 0 || meta.done > file.size
      || (meta.done !== file.size && meta.done % CHUNK_BYTES !== 0)
      || typeof meta.url !== "string" || (!meta.sha256 && !meta.etag)) return null;
    return meta;
  } catch { return null; }
}

async function partialBytes(cache, key, meta) {
  if (!meta) return 0;
  let done = 0;
  while (done < meta.done) {
    const response = await cache.match(baseKey(key) + done);
    const length = Math.min(CHUNK_BYTES, meta.size - done);
    if (!response || Number(response.headers.get("content-length")) !== length) break;
    done += length;
  }
  return done;
}

export async function modelPartialBytes(key, file) {
  try {
    const cache = await caches.open(PARTIAL_CACHE);
    return await partialBytes(cache, key, await metadata(cache, key, file));
  } catch { return 0; }
}

function requestScope(signal) {
  const ctl = new AbortController();
  let timer;
  const abort = () => ctl.abort(abortError());
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new Error("Model download stalled; try again")), IDLE_MS);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort(); else touch();
  return {
    signal: ctl.signal, touch,
    close() { clearTimeout(timer); signal?.removeEventListener("abort", abort); ctl.abort(); },
  };
}

function verifiedStream(body, file, signal, onBytes, touch = () => {}) {
  let count = 0;
  const hash = expectedHash(file) ? new Sha256() : null;
  const reader = body.getReader();
  let failure = null, controller;
  const cleanup = () => signal?.removeEventListener("abort", abort);
  const fail = (error) => {
    // Chromium's Cache.put may replace stream exceptions with TypeError. Keep the original
    // validation error so the caller can discard corrupt ranges instead of retrying them forever.
    if (!failure) failure = error;
    cleanup();
    try { controller.error(error); } catch {}
    reader.cancel(error).catch(() => {});
  };
  const abort = () => fail(signal.reason || abortError());
  const stream = new ReadableStream({
    start(value) {
      controller = value;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(value) {
      try {
        checkAbort(signal);
        const { done, value: chunk } = await reader.read();
        checkAbort(signal);
        if (done) {
          if (count !== file.size) throw new InvalidDownload("Incomplete model file; try again");
          if (hash && hash.hex() !== expectedHash(file)) throw new InvalidDownload("Model SHA-256 check failed; try another source");
          cleanup();
          value.close();
          reader.releaseLock();
          return;
        }
        count += chunk.byteLength;
        if (count > file.size) throw new InvalidDownload("Model file is larger than its published size");
        hash?.update(chunk);
        touch();
        onBytes?.(count);
        checkAbort(signal);
        value.enqueue(chunk);
      } catch (error) { fail(error); }
    },
    cancel(reason) { cleanup(); return reader.cancel(reason); },
  });
  return { stream, error: () => failure, cancel: fail };
}

async function commit(cache, key, body, file, signal, onBytes, touch) {
  const checked = verifiedStream(body, file, signal, onBytes, touch);
  try {
    // Cache.put consumes this stream before committing. The stream closes only after validation.
    await cache.put(key, new Response(checked.stream, {
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(file.size) },
    }));
    checkAbort(signal);
  } catch (error) {
    checked.cancel(error);
    await cache.delete(key);
    throw checked.error() || error;
  }
}

async function fullDownload(cache, key, file, url, signal, onBytes) {
  const scope = requestScope(signal);
  try {
    const response = await fetch(url, { signal: scope.signal, cache: "no-store" });
    if (response.status !== 200 || !response.body) throw new Error(`Model download HTTP ${response.status}`);
    await commit(cache, key, response.body, file, scope.signal, onBytes, scope.touch);
  } finally { scope.close(); }
}

async function chunkBytes(response, length, scope, onBytes) {
  const bytes = new Uint8Array(length);
  const reader = response.body.getReader();
  let count = 0;
  const abort = () => { reader.cancel(scope.signal.reason).catch(() => {}); };
  scope.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      checkAbort(scope.signal);
      const { done, value } = await reader.read();
      checkAbort(scope.signal);
      if (done) break;
      count += value.byteLength;
      if (count > length) throw new InvalidDownload("Model range is larger than requested");
      bytes.set(value, count - value.byteLength);
      scope.touch();
      onBytes(count);
    }
    if (count !== length) throw new Error("Model range ended early; retrying");
    return bytes;
  } finally {
    scope.signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function rangeDownload(cache, partial, key, file, url, signal, onBytes) {
  let meta = await metadata(partial, key, file);
  if (!meta || meta.url !== url) {
    await clearPartial(partial, key);
    meta = null;
  }
  let offset = await partialBytes(partial, key, meta);
  onBytes?.(offset);
  while (offset < file.size) {
    checkAbort(signal);
    const end = Math.min(offset + CHUNK_BYTES, file.size) - 1;
    const headers = { Range: `bytes=${offset}-${end}` };
    // Compare ETags on each response instead of adding If-Range, which forces a CORS preflight on mirrors.
    const scope = requestScope(signal);
    try {
      const response = await fetch(url, { headers, signal: scope.signal, cache: "no-store" });
      if (response.status === 200) {
        await clearPartial(partial, key);
        if (!response.body) throw new Error("Model response has no body");
        await commit(cache, key, response.body, file, scope.signal, onBytes, scope.touch);
        return;
      }
      if (response.status !== 206 || !response.body) throw new Error(`Model range HTTP ${response.status}`);
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
      if (!range || +range[1] !== offset || +range[2] !== end || +range[3] !== file.size) {
        // Some CORS servers do not expose Content-Range. Restart as one verified full response.
        if (!response.headers.get("content-range")) {
          await clearPartial(partial, key);
          scope.close();
          await fullDownload(cache, key, file, url, signal, onBytes);
          return;
        }
        throw new InvalidDownload("Model server returned an invalid Content-Range");
      }
      const etag = strongEtag(response);
      if (meta && meta.etag !== etag) throw new InvalidDownload("Model changed during download; restarting");
      if (!expectedHash(file) && !etag) {
        await clearPartial(partial, key);
        scope.close();
        await fullDownload(cache, key, file, url, signal, onBytes);
        return;
      }
      if (!meta) {
        meta = { version: 1, size: file.size, sha256: expectedHash(file), url, etag, chunkBytes: CHUNK_BYTES, done: 0 };
      }
      const data = await chunkBytes(response, end - offset + 1, scope, (n) => onBytes?.(offset + n));
      checkAbort(signal);
      await partial.put(baseKey(key) + offset, new Response(data, { headers: { "Content-Length": String(data.byteLength) } }));
      offset += data.byteLength;
      meta.done = offset;
      await partial.put(baseKey(key) + "meta", new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
    } finally { scope.close(); }
  }
  let next = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        checkAbort(signal);
        if (next >= file.size) { controller.close(); return; }
        const response = await partial.match(baseKey(key) + next);
        if (!response) throw new InvalidDownload("A saved model range is missing; retry download");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== Math.min(CHUNK_BYTES, file.size - next)) throw new InvalidDownload("A saved model range is incomplete");
        next += bytes.byteLength;
        controller.enqueue(bytes);
      } catch (error) { controller.error(error); }
    },
  });
  await commit(cache, key, body, file, signal);
}

async function download({ cache, key, file, urls, signal, onBytes }) {
  checkAbort(signal);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || (file.sha256 && !/^[a-f0-9]{64}$/i.test(file.sha256))) {
    throw new Error("Invalid model file size or SHA-256 in catalogue");
  }
  const sources = [...new Set(urls)];
  if (!sources.length) throw new Error("No model download source configured");
  const partial = await caches.open(PARTIAL_CACHE);
  const saved = await metadata(partial, key, file);
  // A fallback source may have made progress on the previous visit; resume it before starting over.
  const resumeAt = saved?.done > 0 ? sources.indexOf(saved.url) : -1;
  if (resumeAt > 0) sources.unshift(...sources.splice(resumeAt, 1));
  let lastError;
  for (const url of sources) {
    for (let attempt = 0; attempt < 2; attempt++) {
      checkAbort(signal);
      try {
        if (file.size <= CHUNK_BYTES) await fullDownload(cache, key, file, url, signal, onBytes);
        else await rangeDownload(cache, partial, key, file, url, signal, onBytes);
        checkAbort(signal);
        await clearPartial(partial, key);
        onBytes?.(file.size);
        return;
      } catch (error) {
        checkAbort(signal);
        if (error instanceof InvalidDownload) await clearPartial(partial, key);
        lastError = error;
      }
    }
  }
  throw lastError;
}

async function exclusive(key, signal, action) {
  // Web Locks coordinate tabs when available. The promise queue also covers browsers without it in this tab.
  const previous = flights.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => {
    checkAbort(signal);
    const locks = globalThis.navigator?.locks;
    return locks
      ? locks.request(`${PARTIAL_CACHE}:${key}`, { mode: "exclusive", ...(signal ? { signal } : {}) }, action)
      : action();
  });
  flights.set(key, run);
  try { return await run; } finally { if (flights.get(key) === run) flights.delete(key); }
}

export async function downloadModelFile(options) {
  return exclusive(options.key, options.signal, () => download(options));
}

// Incremental SHA-256 (FIPS 180-4). At most one network chunk and a 64-byte tail are hashed at a time.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (n, bits) => (n >>> bits) | (n << (32 - bits));
class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.w = new Uint32Array(64);
    this.tail = new Uint8Array(64);
    this.used = 0;
    this.length = 0;
  }
  block(bytes, offset) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      w[i] = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = w[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = this.h;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.h[0] += a; this.h[1] += b; this.h[2] += c; this.h[3] += d;
    this.h[4] += e; this.h[5] += f; this.h[6] += g; this.h[7] += h;
  }
  update(bytes) {
    this.length += bytes.byteLength;
    let at = 0;
    if (this.used) {
      const count = Math.min(64 - this.used, bytes.byteLength);
      this.tail.set(bytes.subarray(0, count), this.used);
      this.used += count; at += count;
      if (this.used === 64) { this.block(this.tail, 0); this.used = 0; }
    }
    for (; at + 64 <= bytes.byteLength; at += 64) this.block(bytes, at);
    if (at < bytes.byteLength) { this.tail.set(bytes.subarray(at), 0); this.used = bytes.byteLength - at; }
  }
  hex() {
    const tail = new Uint8Array(this.used < 56 ? 64 : 128);
    tail.set(this.tail.subarray(0, this.used));
    tail[this.used] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(this.length / 0x20000000));
    view.setUint32(tail.length - 4, (this.length * 8) >>> 0);
    for (let at = 0; at < tail.length; at += 64) this.block(tail, at);
    return Array.from(this.h, (n) => n.toString(16).padStart(8, "0")).join("");
  }
}
