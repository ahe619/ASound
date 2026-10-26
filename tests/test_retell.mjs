import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app/js/feat-retell.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")
  + "\nglobalThis.retellTest = { startRecorder };";
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture() {
  const calls = { records: 0, cancels: 0, rawStops: 0, transcribes: [] };
  const timers = new Map();
  let timerId = 0;
  let handlers, active = false;
  const mic = {
    async record(h) { ++calls.records; handlers = h; active = true; },
    async stop({ raw }) {
      assert.equal(raw, true, "capture segments must not race recognition with the next capture");
      ++calls.rawStops;
      if (!active) return { audio: null };
      active = false;
      return { audio: new Float32Array(16000).fill(calls.rawStops) };
    },
    async transcribe(audio) { calls.transcribes.push(audio[0]); return `segment ${audio[0]}`; },
    cancel() { ++calls.cancels; active = false; },
  };
  const context = vm.createContext({ window: { ASoundMic: mic },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    Float32Array, str: value => String(value ?? "") });
  vm.runInContext(source, context, { filename: "feat-retell.js" });
  return { mic, calls, create: () => context.retellTest.startRecorder(() => {}),
    expire(delay) { const timer = [...timers.values()].find(t => t.delay === delay); assert.ok(timer); timer.fn(); },
    frames: count => { for (let i = 0; i < count; i++) handlers.onLevel(0.3); } };
}

test("long recordings retain raw segments and recognize them in order only after finishing", async () => {
  const f = fixture(), rec = f.create();
  await rec.start();
  f.frames(840);
  await flush();
  assert.equal(f.calls.records, 2);
  assert.equal(f.calls.transcribes.length, 0);
  const result = await rec.finish();
  assert.equal(result.text, "segment 1 segment 2");
  assert.deepEqual(f.calls.transcribes, [1, 2]);
  assert.equal(result.audio.length, 32000);
  assert.equal(f.calls.cancels, 1, "finishing releases microphone capture");
});

test("leaving while permission is pending cancels promptly and cannot close a newer recording", async () => {
  const f = fixture(), permission = deferred();
  f.mic.record = () => permission.promise;
  const rec = f.create(), started = rec.start();
  const rejected = assert.rejects(started, { code: "cancelled" });
  rec.cancel();
  await rejected;
  assert.equal(f.calls.cancels, 1);
  permission.resolve();
  await flush();
  rec.cancel();
  assert.equal(f.calls.cancels, 1, "a stale controller never closes subsequent capture");
});

test("leaving during recognition settles the wait and ignores the late result", async () => {
  const f = fixture(), recognition = deferred();
  f.mic.transcribe = () => recognition.promise;
  const rec = f.create();
  await rec.start();
  const finishing = rec.finish();
  const rejected = assert.rejects(finishing, { code: "cancelled" });
  await flush();
  assert.equal(f.calls.cancels, 1, "the microphone is released before recognition begins");
  rec.cancel();
  await rejected;
  recognition.resolve("late words");
  await flush();
  assert.equal(f.calls.cancels, 1);
});

test("recognition failure releases capture and never returns an incomplete transcript as a scored round", async () => {
  const f = fixture();
  f.mic.transcribe = async () => { throw new Error("unavailable"); };
  const rec = f.create();
  await rec.start();
  await assert.rejects(rec.finish(), /unavailable/);
  assert.equal(f.calls.cancels, 1);
});

test("permission preparation times out and releases its capture ownership", async () => {
  const f = fixture();
  f.mic.record = () => new Promise(() => {});
  const rec = f.create(), started = rec.start();
  const rejected = assert.rejects(started, { code: "timeout" });
  f.expire(30000);
  await rejected;
  assert.equal(f.calls.cancels, 1);
});

test("unresponsive recognition times out instead of holding the round forever", async () => {
  const f = fixture();
  f.mic.transcribe = () => new Promise(() => {});
  const rec = f.create();
  await rec.start();
  const finishing = rec.finish(), rejected = assert.rejects(finishing, { code: "timeout" });
  await flush();
  f.expire(60000);
  await rejected;
  assert.equal(f.calls.cancels, 1);
});
