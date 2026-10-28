import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Real lifecycle/cache code, with controllable workers instead of downloading a model.
const source = readFileSync(new URL("../app/kokoro/neural-tts.js", import.meta.url), "utf8")
  .replaceAll("import.meta.url", JSON.stringify("https://soundoa.cn/kokoro/neural-tts.js"))
  .replace(/^export /gm, "")
  + "\nglobalThis.api = { configure, load, synthesize, status, dispose }; globalThis.workerSource = WORKER_SRC;";
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const web = version => ({ mode: "web", base: `/voice-${version}/`, cache: "voice-cache", canon: `https://cache.invalid/${version}/` });

function fixture({ autoReady = true } = {}) {
  const workers = [], revoked = [];
  const timers = new Map();
  let now = 0, nextTimer = 0;
  class FakeWorker {
    constructor() { this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(message) {
      this.messages.push(message);
      if (message.type === "init" && autoReady) queueMicrotask(() => this.deliver({ type: "ready", ms: 1 }));
    }
    deliver(message) { this.onmessage({ data: message }); }
    terminate() { this.terminated = true; }
  }
  class FakeURL extends URL {
    static createObjectURL() { return `blob:test-${workers.length}`; }
    static revokeObjectURL(value) { revoked.push(value); }
  }
  const context = vm.createContext({ URL: FakeURL, Blob, Worker: FakeWorker,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context, { filename: "neural-tts.js" });
  const generations = () => workers.flatMap(worker => worker.messages.filter(m => m.type === "gen").map(message => ({ worker, message })));
  return { ...context.api, workers, revoked, generations, timers, workerSource: context.workerSource,
    elapse(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
    respond(index, { size = 80, value = 0.25, ms = 1 } = {}) {
      const { worker, message } = generations()[index];
      const pcm = new Float32Array(size); pcm[0] = value;
      worker.deliver({ type: "audio", id: message.id, pcm, sr: 24000, ms });
    },
  };
}

test("configuration stays lazy and concurrent identical audio shares one worker and one inference", async () => {
  const f = fixture();
  f.configure(web("a"));
  assert.equal(f.workers.length, 0);
  const a = f.synthesize("apple"), b = f.synthesize("apple");
  await flush();
  assert.equal(f.workers.length, 1);
  assert.equal(f.generations().length, 1);
  f.respond(0);
  const [one, two] = await Promise.all([a, b]);
  assert.equal(one, two);
  assert.equal(await f.synthesize("apple"), one);
  assert.equal(f.generations().length, 1);
  assert.equal(f.revoked.length, 1);
});

test("different voice or speed never reuses another pronunciation", async () => {
  const f = fixture();
  const requests = [f.synthesize("apple"), f.synthesize("apple", { voice: "am_puck" }), f.synthesize("apple", { speed: 0.8 })];
  await flush();
  assert.equal(f.workers.length, 1);
  assert.equal(f.generations().length, 1, "only the active generation is submitted to the worker");
  for (let i = 0; i < 3; i++) { f.respond(i); await flush(); }
  assert.equal(f.generations().length, 3);
  await Promise.all(requests);
});

test("aborted requests never initialize a worker; cancelling shared initialization leaves other callers running", async () => {
  const f = fixture({ autoReady: false });
  const already = new AbortController(); already.abort();
  await assert.rejects(f.synthesize("never", { signal: already.signal }), { name: "AbortError" });
  assert.equal(f.workers.length, 0);
  const ctl = new AbortController();
  const cancelled = f.synthesize("old preview", { signal: ctl.signal });
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  const current = f.synthesize("current preview");
  ctl.abort(); await rejected;
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].terminated, false);
  f.workers[0].deliver({ type: "ready", ms: 123 });
  await flush();
  assert.deepEqual(f.generations().map(g => g.message.text), ["current preview"]);
  f.respond(0, { ms: 45 }); await current;
  assert.equal(f.status().initMs, 123);
  assert.equal(f.status().generationMs, 45);
  assert.equal(f.status().generating, false);
  assert.equal(f.timers.size, 0);
});

test("cancelling active and queued playback drops old work without rebuilding the model", async () => {
  const f = fixture();
  const one = new AbortController(), two = new AbortController(), three = new AbortController();
  const first = f.synthesize("first", { signal: one.signal });
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  await flush();
  const second = f.synthesize("second", { signal: two.signal });
  const secondRejected = assert.rejects(second, { name: "AbortError" });
  await flush();
  one.abort(); two.abort();
  await Promise.all([firstRejected, secondRejected]);
  const latest = f.synthesize("latest", { signal: three.signal });
  await flush();
  assert.deepEqual(f.generations().map(g => g.message.text), ["first"]);
  assert.equal(f.status().generating, true, "running ONNX still owns the single inference slot");
  f.respond(0); await flush();
  assert.deepEqual(f.generations().map(g => g.message.text), ["first", "latest"]);
  f.respond(1); await latest;
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].terminated, false);
  const retry = f.synthesize("first"); await flush();
  assert.equal(f.generations().length, 3, "discarded cancelled output is not cached");
  f.respond(2); await retry;
  assert.equal(f.timers.size, 0);
});

test("a signal subscriber cannot cancel an independent or shared subscriber for the same key", async () => {
  const f = fixture();
  const ctl = new AbortController();
  const own = f.synthesize("apple", { signal: ctl.signal });
  const rejected = assert.rejects(own, { name: "AbortError" });
  await flush();
  const a = f.synthesize("apple"), b = f.synthesize("apple");
  await flush(); ctl.abort(); await rejected;
  f.respond(0); await flush();
  assert.equal(f.generations().length, 2, "shared callers retain their one independent inference");
  f.respond(1); const [out, shared] = await Promise.all([a, b]);
  assert.equal(out, shared);
  assert.equal(await f.synthesize("apple", { signal: new AbortController().signal }), out);
  assert.equal(f.generations().length, 2, "completed cache is reused by signal callers too");
});

test("initialization watchdog rejects every caller and permits a fresh worker on retry", async () => {
  const f = fixture({ autoReady: false });
  const a = f.synthesize("first"), b = f.synthesize("second", { signal: new AbortController().signal });
  const failures = [a, b].map(p => assert.rejects(p, { code: "voice_init_timeout" }));
  f.elapse(120000); await Promise.all(failures);
  assert.equal(f.workers[0].terminated, true);
  assert.equal(f.status().state, "error");
  assert.equal(f.timers.size, 0);
  const retry = f.synthesize("retry");
  f.workers[0].deliver({ type: "ready", ms: 999 });
  assert.equal(f.status().state, "loading", "late old worker messages cannot finish the replacement");
  f.workers[1].deliver({ type: "ready", ms: 2 }); await flush();
  f.respond(0); await retry;
  assert.equal(f.status().state, "ready");
  assert.equal(f.timers.size, 0);
});

test("generation watchdog releases a silent worker and rejects its active and queued jobs", async () => {
  const f = fixture();
  const a = f.synthesize("first"), b = f.synthesize("queued", { signal: new AbortController().signal });
  const failures = [a, b].map(p => assert.rejects(p, { code: "voice_generation_timeout" }));
  await flush(); f.elapse(120000); await Promise.all(failures);
  assert.equal(f.workers[0].terminated, true);
  assert.equal(f.status().state, "error");
  assert.equal(f.status().generating, false);
  assert.equal(f.timers.size, 0);
  const retry = f.synthesize("queued"); await flush();
  assert.equal(f.workers.length, 2);
  f.respond(0, { value: 0.1 }); // late old worker reply must not enter the replacement cache
  f.respond(1, { value: 0.9 });
  assert.ok((await retry).pcm[0] > 0.8);
  assert.equal(f.timers.size, 0);
});

test("configuration changes reject old audio and isolate new pending and cached results", async () => {
  const f = fixture(); f.configure(web("a"));
  const old = f.synthesize("apple");
  const rejected = assert.rejects(old, /configuration changed/);
  await flush();
  f.configure(web("b"));
  const current = f.synthesize("apple");
  await flush();
  await rejected;
  assert.equal(f.workers.length, 2);
  assert.equal(f.workers[0].terminated, true);
  f.respond(0, { value: 0.1 }); // a late response from the terminated worker
  f.respond(1, { value: 0.9 });
  const out = await current;
  assert.ok(out.pcm[0] > 0.8);
  assert.equal(await f.synthesize("apple"), out);
  f.configure(web("c"));
  const newest = f.synthesize("apple"); await flush();
  assert.equal(f.generations().length, 3, "audio from a different configuration is not cached into the new one");
  f.respond(2); await newest;
});

test("a configuration change during initialization cannot strand or reset the replacement load", async () => {
  const f = fixture({ autoReady: false }); f.configure(web("a"));
  const old = f.load();
  const rejected = assert.rejects(old, /configuration changed/);
  f.configure(web("b"));
  const current = f.load();
  f.workers[0].deliver({ type: "ready", ms: 1 });
  f.workers[1].deliver({ type: "ready", ms: 2 });
  await rejected;
  assert.equal(await current, 2);
  assert.equal(f.status().state, "ready");
  assert.equal(f.workers[1].terminated, false);
});

test("worker failure rejects pending audio and permits a fresh retry", async () => {
  const f = fixture();
  const failed = f.synthesize("apple");
  const rejected = assert.rejects(failed, /worker crashed/);
  await flush();
  f.workers[0].onerror({ message: "worker crashed" });
  await rejected;
  assert.equal(f.status().state, "error");
  const retried = f.synthesize("apple"); await flush();
  assert.equal(f.workers.length, 2);
  f.respond(1); await retried;
  assert.equal(f.status().state, "ready");
});

test("removing a voice releases its worker and rejects any unfinished synthesis", async () => {
  const f = fixture();
  const pending = f.synthesize("apple");
  const rejected = assert.rejects(pending, /voice removed/);
  await flush();
  f.dispose(); await rejected;
  assert.equal(f.workers[0].terminated, true);
  assert.equal(f.status().state, "off");
});

test("PCM cache has a byte bound as well as an entry bound", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const pending = f.synthesize(`long sentence ${i}`); await flush();
    f.respond(i, { size: 10 * 1024 * 1024 / 4 }); await pending;
  }
  const again = f.synthesize("long sentence 0"); await flush();
  assert.equal(f.generations().length, 3, "old 10 MiB audio is evicted rather than retaining both buffers");
  f.respond(2); await again;
});

test("worker initialization does not synthesize a hidden test sentence; real output is validated and serialized", async () => {
  const f = fixture();
  const messages = [], calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const context = vm.createContext({
    URL, performance, Number,
    self: { caches: {}, fetch() {} },
    postMessage: message => messages.push(message),
    loadModelModule: async () => ({ env: {}, KokoroTTS: { from_pretrained: async () => ({
      async generate(text) {
        calls.push(text);
        if (text === "first") await gate;
        return { audio: new Float32Array([text === "invalid" ? NaN : 0.5]), sampling_rate: 24000 };
      },
    }) } }),
  });
  vm.runInContext(f.workerSource.replace('import(BASE + "kokoro.web.js")', "loadModelModule()"), context);
  await context.self.onmessage({ data: { type: "init", device: "wasm", dtype: "q8" } });
  assert.deepEqual(calls, [], "loading should not pay for a discarded Hello there inference");
  assert.equal(messages[0].type, "ready");
  for (const [id, text] of [[1, "first"], [2, "invalid"]]) {
    await context.self.onmessage({ data: { type: "gen", id, text, voice: "af_heart", speed: 1 } });
  }
  assert.deepEqual(calls, ["first"], "the shared inference session does not run two sentences concurrently");
  release(); await flush();
  assert.deepEqual(calls, ["first", "invalid"]);
  assert.equal(messages[1].type, "audio");
  assert.equal(messages[2].type, "genError");
  assert.match(messages[2].error, /invalid audio/);
});
