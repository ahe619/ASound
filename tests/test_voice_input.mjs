import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const voiceSource = readFileSync(new URL("../app/js/voice-input.js", import.meta.url), "utf8");
// mic.js has only these three import declarations; inject the UI helpers while executing its real logic.
const controlsSource = readFileSync(new URL("../app/js/mic.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")
  + "\nglobalThis.controls = { micButton, handsFree };";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture({ holdWorklet = false, holdResume = false } = {}) {
  const permissions = [], contexts = [], nodes = [], workers = [], toasts = [], warnings = [], revoked = [];
  const worklet = deferred(), resume = deferred();
  const element = () => {
    const classes = new Set(), handlers = {}, attributes = {}, properties = {};
    return {
      classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) },
      style: { setProperty(name, value) { properties[name] = value; } },
      setAttribute(name, value) { attributes[name] = value; },
      addEventListener(name, fn) { handlers[name] = fn; },
      click() { return handlers.click(); },
      attributes, properties,
    };
  };
  class AudioContext {
    constructor() {
      this.state = holdResume ? "suspended" : "running";
      this.closed = false;
      this.audioWorklet = { addModule: () => holdWorklet ? worklet.promise : Promise.resolve() };
      contexts.push(this);
    }
    createMediaStreamSource(stream) { return { stream, connect() {}, disconnect() {} }; }
    async resume() { if (holdResume) await resume.promise; if (!this.closed) this.state = "running"; }
    async close() { this.closed = true; this.state = "closed"; }
  }
  class AudioWorkletNode {
    constructor() { this.port = {}; nodes.push(this); }
    disconnect() { this.disconnected = true; }
  }
  class Worker {
    constructor() { this.requests = []; workers.push(this); }
    postMessage(message) {
      if (message.type === "init") queueMicrotask(() => this.onmessage({ data: { type: "ready" } }));
      else this.requests.push(message);
    }
    reply(text = "hello", error = false) {
      const request = this.requests.shift();
      assert.ok(request, "a transcription request must be pending");
      this.onmessage({ data: { type: error ? "textError" : "text", id: request.id, text, error: text } });
    }
    terminate() {}
  }
  class BrowserURL extends URL {
    static createObjectURL() { return "blob:worklet"; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const context = vm.createContext({
    navigator: { mediaDevices: { getUserMedia() { const permission = deferred(); permissions.push(permission); return permission.promise; } } },
    location: { href: "https://asound.test/" },
    AudioContext, AudioWorkletNode, Worker, URL: BrowserURL, Blob, Float32Array,
    console: { warn: (...args) => warnings.push(args) },
    h: element, icon: () => ({}), t: (key) => key, toast: (message) => toasts.push(message),
    stopSpeaking() {}, unlockAudio() {}, enginesApplied: Promise.resolve(),
  });
  vm.runInContext("globalThis.window = globalThis;", context);
  vm.runInContext(voiceSource, context, { filename: "voice-input.js" });
  vm.runInContext(controlsSource, context, { filename: "mic.js" });
  const mic = context.ASoundMic;
  mic.configure({ model: "test-english", base: "/" });
  const permit = (index = permissions.length - 1) => {
    const track = { stopped: false, stop() { this.stopped = true; } };
    const stream = { getTracks: () => [track], track };
    permissions[index].resolve(stream);
    return stream;
  };
  const frames = (count, amplitude = 0.2) => {
    const node = nodes.at(-1);
    assert.ok(node && node.port.onmessage, "microphone node must be active");
    for (let i = 0; i < count; i++) node.port.onmessage({ data: new Float32Array(512).fill(amplitude) });
  };
  const utterance = () => { frames(20); frames(25, 0); };
  return { mic, ...context.controls, permissions, contexts, nodes, workers, toasts, warnings, revoked, permit, frames, utterance, worklet, resume };
}

test("close stops a late permission result without reactivating capture", async () => {
  const f = fixture();
  const pending = f.mic.record();
  const rejected = assert.rejects(pending, { name: "AbortError" });
  f.mic.close();
  const stream = f.permit();
  await rejected;
  assert.equal(stream.track.stopped, true);
  assert.equal(f.mic.status().mic, "off");
  // The context is made inside the tap (Safari), before permission; cancelling must close it.
  assert.ok(f.contexts.every((c) => c.closed));
});

test("cancel immediately releases tracks while the worklet is still loading", async () => {
  const f = fixture({ holdWorklet: true });
  const pending = f.mic.listen();
  const rejected = assert.rejects(pending, { name: "AbortError" });
  const stream = f.permit();
  await flush();
  f.mic.cancel();
  assert.equal(stream.track.stopped, true);
  assert.equal(f.contexts[0].closed, true);
  f.worklet.resolve();
  await rejected;
  assert.equal(f.mic.status().mic, "off");
  assert.deepEqual(f.revoked, ["blob:worklet"]);
});

test("close during AudioContext.resume cannot turn recording back on", async () => {
  const f = fixture({ holdResume: true });
  const pending = f.mic.record();
  const rejected = assert.rejects(pending, { name: "AbortError" });
  const stream = f.permit();
  await flush();
  f.mic.close();
  f.resume.resolve();
  await rejected;
  assert.equal(stream.track.stopped, true);
  assert.equal(f.mic.status().mic, "off");
});

test("an older permission result cannot replace or close the newer capture", async () => {
  const f = fixture();
  const old = f.mic.record();
  const rejected = assert.rejects(old, { name: "AbortError" });
  const fresh = f.mic.listen();
  const newStream = f.permit(1);
  await fresh;
  const oldStream = f.permit(0);
  await rejected;
  assert.equal(oldStream.track.stopped, true);
  assert.equal(newStream.track.stopped, false);
  assert.equal(f.mic.status().mic, "listening");
  f.mic.close();
});

test("hands-free pause preserves the current transcript", async () => {
  const f = fixture(), texts = [], states = [];
  const start = f.handsFree.start({ onText: (text) => texts.push(text), onState: (state) => states.push(state) });
  f.permit();
  assert.equal(await start, true);
  f.utterance();
  await flush();
  assert.equal(f.mic.status().mic, "paused");
  assert.ok(states.includes("transcribing"));
  f.workers[0].reply(" still here ");
  await flush();
  assert.deepEqual(texts, ["still here"]);
  f.handsFree.stop();
});

for (const error of [false, true]) {
  test(`cancel suppresses a stale hands-free ${error ? "error" : "transcript"}`, async () => {
    const f = fixture(), events = [];
    const start = f.mic.listen({ onText: (text) => events.push(text), onError: (err) => events.push(err) });
    f.permit();
    await start;
    f.utterance();
    await flush();
    f.mic.cancel();
    f.workers[0].reply("late", error);
    await flush();
    assert.deepEqual(events, []);
    assert.equal(f.mic.status().mic, "off");
  });
}

test("manual stop rejects the result when cancelled during ASR", async () => {
  const f = fixture();
  const start = f.mic.record();
  f.permit();
  await start;
  f.frames(15);
  const stop = f.mic.stop();
  const rejected = assert.rejects(stop, { name: "AbortError" });
  await flush();
  f.mic.close();
  f.workers[0].reply();
  await rejected;
});

test("switching manual buttons cancels the first recording without submitting it", async () => {
  const f = fixture(), aTexts = [], bTexts = [];
  const a = f.micButton({ onText: (text) => aTexts.push(text) });
  const b = f.micButton({ onText: (text) => bTexts.push(text) });
  const aStart = a.click();
  const aStream = f.permit();
  await aStart;
  f.frames(15);
  const bStart = b.click();
  f.permit();
  await bStart;
  assert.equal(aStream.track.stopped, true);
  assert.equal(a.classList.contains("rec"), false);
  assert.equal(b.classList.contains("rec"), true);
  assert.equal(f.workers[0].requests.length, 0);
  assert.deepEqual(aTexts, []);
  f.frames(15);
  const bStop = b.click();
  await flush();
  f.workers[0].reply("second button");
  await bStop;
  assert.deepEqual(bTexts, ["second button"]);
  assert.deepEqual(f.toasts, []);
  f.mic.close();
});

test("external cancellation resets a pending button and it can record again", async () => {
  const f = fixture();
  const button = f.micButton();
  const first = button.click();
  assert.equal(button.classList.contains("busy"), true);
  f.mic.cancel();
  assert.equal(button.classList.contains("busy"), false);
  const second = button.click();
  f.permit(1);
  await second;
  const stale = f.permit(0);
  await first;
  assert.equal(stale.track.stopped, true);
  assert.equal(button.classList.contains("rec"), true);
  assert.deepEqual(f.toasts, []);
  f.mic.close();
  assert.equal(button.classList.contains("rec"), false);
});

test("switching buttons during ASR ignores the old result without resetting the new recording", async () => {
  const f = fixture(), texts = [];
  const a = f.micButton({ onText: (text) => texts.push(text) });
  const b = f.micButton();
  const aStart = a.click();
  f.permit();
  await aStart;
  f.frames(15);
  const aStop = a.click();
  await flush();
  const bStart = b.click();
  f.permit();
  await bStart;
  f.workers[0].reply("old page");
  await aStop;
  assert.deepEqual(texts, []);
  assert.deepEqual(f.toasts, []);
  assert.equal(a.classList.contains("busy"), false);
  assert.equal(b.classList.contains("rec"), true);
  assert.equal(f.mic.status().mic, "recording");
  f.mic.close();
});

test("cancelling native-language transcription suppresses audio and text callbacks", async () => {
  const f = fixture(), events = [];
  f.mic.configureHelp({ model: "test-native", base: "/" });
  const button = f.micButton({ lang: "zh", onText: (text) => events.push(text), onAudio: () => events.push("audio") });
  const start = button.click();
  f.permit();
  await start;
  f.frames(15);
  const stop = button.click();
  await flush();
  f.mic.close();
  f.workers[1].reply("late native text");
  await stop;
  assert.deepEqual(events, []);
  assert.deepEqual(f.toasts, []);
  assert.equal(button.classList.contains("busy"), false);
});

test("hands-free stop also cancels a pending microphone permission request", async () => {
  const f = fixture(), states = [];
  const start = f.handsFree.start({ onText() {}, onState: (state) => states.push(state) });
  f.handsFree.stop();
  const stream = f.permit();
  assert.equal(await start, false);
  assert.equal(stream.track.stopped, true);
  assert.equal(f.handsFree.on, false);
  assert.deepEqual(states, []);
  assert.deepEqual(f.toasts, []);
});
