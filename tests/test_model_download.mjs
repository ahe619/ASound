import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app/js/model-download.js", import.meta.url), "utf8")
  .replace(/^export /gm, "") + "\nglobalThis.api = {downloadModelFile, discardModelPartial, modelPartialBytes};";
const CHUNK = 4 * 1024 * 1024;
const KEY = "https://models.asound.invalid/fixture/model.bin";
const URL_A = "https://first.test/model.bin", URL_B = "https://second.test/model.bin";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const data = (size = CHUNK + 517) => Uint8Array.from({ length: size }, (_, i) => i % 251);

function fixture(fetcher, existingCaches = new Map(), { wrapCacheErrors = false } = {}) {
  class Cache {
    constructor() { this.values = new Map(); }
    async match(key) {
      const item = this.values.get(typeof key === "string" ? key : key.url);
      return item ? new Response(item.bytes.slice(), { headers: item.headers }) : undefined;
    }
    async put(key, response) {
      let bytes;
      try {
        bytes = new Uint8Array(await response.arrayBuffer()); // No commit if the stream/checksum fails.
      } catch (error) {
        // Chromium hides a ReadableStream's underlying exception at the Cache.put boundary.
        if (wrapCacheErrors) throw new TypeError("Failed to execute 'put' on 'Cache': network error");
        throw error;
      }
      this.values.set(typeof key === "string" ? key : key.url, { bytes, headers: [...response.headers] });
    }
    async delete(key) { return this.values.delete(typeof key === "string" ? key : key.url); }
    async keys() { return [...this.values.keys()].map((url) => new Request(url)); }
  }
  const caches = {
    async open(name) { if (!existingCaches.has(name)) existingCaches.set(name, new Cache()); return existingCaches.get(name); },
  };
  const requests = [];
  const context = vm.createContext({
    Response, Request, Headers, ReadableStream, TransformStream, AbortController, DOMException,
    console, setTimeout, clearTimeout, navigator: {}, caches,
    fetch: async (url, options) => { requests.push({ url, ...options }); return fetcher(url, options, requests.length); },
  });
  vm.runInContext(source, context, { filename: "model-download.js" });
  const cache = new Cache();
  const file = (bytes, hashed = true) => ({ path: "model.bin", size: bytes.length, ...(hashed ? { sha256: sha(bytes) } : {}) });
  const download = (bytes, extra = {}) => context.api.downloadModelFile({ cache, key: KEY, file: file(bytes), urls: [URL_A], ...extra });
  return { ...context.api, context, cache, caches: existingCaches, requests, file, download };
}

function rangeResponse(bytes, options, etag = '"stable"') {
  const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range || "");
  if (!range) return new Response(bytes);
  const [start, end] = range.slice(1).map(Number);
  return new Response(bytes.slice(start, end + 1), { status: 206, headers: {
    "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
    ...(etag ? { ETag: etag } : {}),
  } });
}

function brokenBody(bytes) {
  let emitted = false;
  return new ReadableStream({ pull(controller) {
    if (!emitted) { emitted = true; controller.enqueue(bytes); }
    else controller.error(new Error("connection interrupted"));
  } });
}

test("small files use one full request and SHA-256 matches Node across padding boundaries", async () => {
  for (const size of [0, 3, 55, 56, 63, 64, 65, 127, 513, 1025]) {
    const bytes = data(size);
    const f = fixture(() => new Response(bytes));
    await f.download(bytes);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].headers, undefined);
    assert.deepEqual(new Uint8Array(await (await f.cache.match(KEY)).arrayBuffer()), bytes);
  }
});

test("complete chunks resume after a body interruption without downloading the first chunk again", async () => {
  const bytes = data();
  const f = fixture((_url, options, count) => {
    if (count === 2) return new Response(brokenBody(bytes.slice(CHUNK, CHUNK + 20)), { status: 206, headers: {
      "Content-Range": `bytes ${CHUNK}-${bytes.length - 1}/${bytes.length}`, ETag: '"stable"',
    } });
    return rangeResponse(bytes, options);
  });
  const progress = [];
  await f.download(bytes, { onBytes: (n) => progress.push(n) });
  assert.deepEqual(f.requests.map((request) => request.headers.Range), [
    `bytes=0-${CHUNK - 1}`, `bytes=${CHUNK}-${bytes.length - 1}`, `bytes=${CHUNK}-${bytes.length - 1}`,
  ]);
  assert.equal(f.requests[2].headers["If-Range"], undefined, "ETag checks must not add a CORS preflight header");
  assert.equal(progress.at(-1), bytes.length);
  assert.deepEqual(new Uint8Array(await (await f.cache.match(KEY)).arrayBuffer()), bytes);
  assert.equal(await f.modelPartialBytes(KEY, f.file(bytes)), 0);
});

test("saved ranges survive a module reload and resume after cancellation with no fallback request", async () => {
  const bytes = data(), ctl = new AbortController();
  const first = fixture((_url, options, count) => {
    if (count === 2) ctl.abort();
    return rangeResponse(bytes, options);
  });
  await assert.rejects(first.download(bytes, { signal: ctl.signal, urls: [URL_A, URL_B] }), { name: "AbortError" });
  assert.equal(first.requests.length, 2);
  assert.equal(await first.cache.match(KEY), undefined);
  assert.equal(await first.modelPartialBytes(KEY, first.file(bytes)), CHUNK);
  const second = fixture((_url, options) => rangeResponse(bytes, options), first.caches);
  await second.download(bytes);
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].headers.Range, `bytes=${CHUNK}-${bytes.length - 1}`);
});

test("a server that ignores Range is streamed once and validated as a full response", async () => {
  const bytes = data();
  const f = fixture(() => new Response(bytes));
  await f.download(bytes);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(new Uint8Array(await (await f.cache.match(KEY)).arrayBuffer()), bytes);
});

test("an unexposed Content-Range triggers a full request rather than unsafe assembly", async () => {
  const bytes = data();
  const f = fixture((_url, options) => options.headers?.Range
    ? new Response(bytes.slice(0, CHUNK), { status: 206 }) : new Response(bytes));
  await f.download(bytes);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].headers, undefined);
});

test("invalid 206 ranges never publish or retain an incomplete model", async () => {
  const bytes = data();
  const f = fixture(() => new Response(bytes.slice(0, CHUNK), { status: 206, headers: {
    "Content-Range": `bytes 1-${CHUNK}/${bytes.length}`, ETag: '"stable"',
  } }));
  await assert.rejects(f.download(bytes), /invalid Content-Range/);
  assert.equal(f.requests.length, 2);
  assert.equal(await f.cache.match(KEY), undefined);
  assert.equal(await f.modelPartialBytes(KEY, f.file(bytes)), 0);
});

test("a new ETag discards previous ranges before retrying, even if file size is unchanged", async () => {
  const bytes = data(), changed = bytes.map((n) => n ^ 255);
  const f = fixture((_url, options, count) => rangeResponse(count === 1 ? bytes : changed, options, count === 1 ? '"old"' : '"new"'));
  await f.download(changed);
  assert.deepEqual(f.requests.map((request) => request.headers.Range), [
    `bytes=0-${CHUNK - 1}`, `bytes=${CHUNK}-${bytes.length - 1}`, `bytes=0-${CHUNK - 1}`, `bytes=${CHUNK}-${bytes.length - 1}`,
  ]);
  assert.deepEqual(new Uint8Array(await (await f.cache.match(KEY)).arrayBuffer()), changed);
});

test("changing mirrors restarts from zero and never combines their chunks", async () => {
  const bytes = data();
  const f = fixture((url, options) => {
    if (url === URL_A && options.headers?.Range?.startsWith(`bytes=${CHUNK}-`)) throw new Error("source unavailable");
    return rangeResponse(bytes, options, url === URL_A ? '"a"' : '"b"');
  });
  await f.download(bytes, { urls: [URL_A, URL_B] });
  const second = f.requests.filter((request) => request.url === URL_B);
  assert.equal(second[0].headers.Range, `bytes=0-${CHUNK - 1}`);
  assert.equal(second.length, 2);
  assert.equal(await f.modelPartialBytes(KEY, f.file(bytes)), 0);
});

test("SHA mismatch fails before final Cache.put commits and can fall back to a healthy source", async () => {
  const bytes = data(1024), corrupt = bytes.map((n) => n ^ 1);
  const f = fixture((url) => new Response(url === URL_A ? corrupt : bytes));
  await f.download(bytes, { urls: [URL_A, URL_B] });
  assert.equal(f.requests.length, 3);
  assert.deepEqual(new Uint8Array(await (await f.cache.match(KEY)).arrayBuffer()), bytes);
  const failed = fixture(() => new Response(corrupt));
  await assert.rejects(failed.download(bytes), /SHA-256/);
  assert.equal(await failed.cache.match(KEY), undefined);
});

test("wrong whole-file sizes and body interruptions never leave a final cache entry", async () => {
  const bytes = data(1024);
  for (const response of [() => new Response(bytes.slice(0, 100)), () => new Response(data(1025)), () => new Response(brokenBody(bytes.slice(0, 20)))]) {
    const f = fixture(response);
    await assert.rejects(f.download(bytes));
    assert.equal(await f.cache.match(KEY), undefined);
    assert.equal(f.requests.length, 2);
  }
});

test("files without a digest need a strong visible ETag to use resumable ranges", async () => {
  const bytes = data();
  const f = fixture((_url, options) => rangeResponse(bytes, options, null));
  await f.download(bytes, { file: f.file(bytes, false) });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].headers, undefined);
  const etag = fixture((_url, options) => rangeResponse(bytes, options));
  await etag.download(bytes, { file: etag.file(bytes, false) });
  assert.equal(etag.requests.length, 2);
  assert.ok(etag.requests[1].headers.Range);
});

test("removing a partial download deletes its ranges and metadata but leaves unrelated downloads", async () => {
  const bytes = data();
  const f = fixture((_url, options) => {
    if (options.headers.Range.startsWith(`bytes=${CHUNK}-`)) throw new Error("offline");
    return rangeResponse(bytes, options);
  });
  await assert.rejects(f.download(bytes));
  await assert.rejects(f.download(bytes, { key: KEY + ".other" }));
  assert.equal(await f.modelPartialBytes(KEY, f.file(bytes)), CHUNK);
  await f.discardModelPartial(KEY);
  assert.equal(await f.modelPartialBytes(KEY, f.file(bytes)), 0);
  assert.equal(await f.modelPartialBytes(KEY + ".other", f.file(bytes)), CHUNK);
});

test("an already cancelled request does no network or cache work", async () => {
  const ctl = new AbortController(); ctl.abort();
  const f = fixture(() => { throw new Error("must not fetch"); });
  await assert.rejects(f.download(data(3), { signal: ctl.signal }), { name: "AbortError" });
  assert.equal(f.requests.length, 0);
  assert.equal(f.caches.size, 0);
});

test("incremental SHA-256 handles network chunks split inside hash blocks", async () => {
  const bytes = data(10003);
  const f = fixture(() => {
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + (offset % 317) + 1);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    } }));
  });
  await f.download(bytes);
  assert.deepEqual(new Uint8Array(await (await f.cache.match(KEY)).arrayBuffer()), bytes);
});

test("cancellation unblocks a stalled range body and does not try another source", async () => {
  const bytes = data(), ctl = new AbortController();
  let cancelled = false;
  const f = fixture(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.slice(0, 37)); },
    cancel() { cancelled = true; },
  }), { status: 206, headers: { "Content-Range": `bytes 0-${CHUNK - 1}/${bytes.length}`, ETag: '"stable"' } }));
  await assert.rejects(f.download(bytes, {
    signal: ctl.signal, urls: [URL_A, URL_B], onBytes: (n) => { if (n > 0) ctl.abort(); },
  }), { name: "AbortError" });
  assert.equal(cancelled, true);
  assert.equal(f.requests.length, 1);
  assert.equal(await f.cache.match(KEY), undefined);
});

test("a corrupt assembled file is discarded instead of being marked installed", async () => {
  const bytes = data(), corrupt = bytes.map((n) => n ^ 1);
  const f = fixture((_url, options) => rangeResponse(corrupt, options));
  await assert.rejects(f.download(bytes), /SHA-256/);
  assert.equal(await f.cache.match(KEY), undefined);
  assert.equal(await f.modelPartialBytes(KEY, f.file(bytes)), 0);
});

test("a reload prioritizes progress on the last fallback source", async () => {
  const bytes = data();
  const first = fixture((url, options) => {
    if (url === URL_A || options.headers.Range.startsWith(`bytes=${CHUNK}-`)) throw new Error("offline");
    return rangeResponse(bytes, options);
  });
  await assert.rejects(first.download(bytes, { urls: [URL_A, URL_B] }));
  const second = fixture((_url, options) => rangeResponse(bytes, options), first.caches);
  await second.download(bytes, { urls: [URL_A, URL_B] });
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].url, URL_B);
  assert.equal(second.requests[0].headers.Range, `bytes=${CHUNK}-${bytes.length - 1}`);
});

test("original SHA failure survives Cache.put wrapping stream exceptions in TypeError", async () => {
  const bytes = data(), corrupt = bytes.map((n) => n ^ 1);
  const f = fixture((_url, options) => rangeResponse(corrupt, options), new Map(), { wrapCacheErrors: true });
  await assert.rejects(f.download(bytes), /SHA-256/);
  assert.equal(await f.cache.match(KEY), undefined);
  assert.equal(await f.modelPartialBytes(KEY, f.file(bytes)), 0, "wrapped integrity errors must still clear corrupt ranges");
  assert.deepEqual(f.requests.map((request) => request.headers.Range), [
    `bytes=0-${CHUNK - 1}`, `bytes=${CHUNK}-${bytes.length - 1}`,
    `bytes=0-${CHUNK - 1}`, `bytes=${CHUNK}-${bytes.length - 1}`,
  ], "retry must fetch fresh data instead of revalidating the same corrupt cached ranges");
});

test("wrapped Cache.put errors preserve whole-file size and digest validation messages", async () => {
  const bytes = data(1024);
  for (const [actual, pattern] of [[bytes.slice(0, 100), /Incomplete model/], [data(1025), /larger/], [bytes.map((n) => n ^ 1), /SHA-256/]]) {
    const f = fixture(() => new Response(actual), new Map(), { wrapCacheErrors: true });
    await assert.rejects(f.download(bytes), pattern);
    assert.equal(await f.cache.match(KEY), undefined);
  }
});
