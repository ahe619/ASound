import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const stripModule = text => text.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const enginesSource = stripModule(readFileSync(new URL("../app/js/engines.js", import.meta.url), "utf8"))
  + "\nglobalThis.engines = { startEngines, applyEngines };";
const aiSource = stripModule(readFileSync(new URL("../app/js/ai.js", import.meta.url), "utf8"))
  + "\nglobalThis.askModel = ask;";
const localSource = readFileSync(new URL("../app/js/local-ai.js", import.meta.url), "utf8")
  .replace('import(new URL("vendor/wllama/index.js", location.href).href)', "loadWllama()");
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture({ mode = "web", mobile = true } = {}) {
  const requests = [];
  let imports = 0, loads = 0, generations = 0;
  class Wllama {
    setCompat() {}
    async loadModel() { loads++; }
    async *createChatCompletion() {
      generations++;
      yield { choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] };
    }
  }
  const context = vm.createContext({
    URL, AbortController, location: { href: "https://soundoa.cn/" },
    console: { warn() {} }, document: { body: null, addEventListener() {} },
    initPacks: async () => {}, onPacks() {},
    activePacks: () => ({ llm: "llm-cpu", asr: null, voice: null, helpAsr: false }),
    variant: group => group, packMode: () => mode, deviceInfo: () => ({ mobile }),
    engineConfig: async () => ({ llm: { kind: "cpu", model_id: "test-cpu", url: "/test.gguf", ctx: 512 } }),
    configureVoice() {}, recheckSpeech() {}, t: key => key,
    loadWllama: async () => { imports++; return { Wllama }; },
    fetch: async url => { requests.push(url); return { ok: true, blob: async () => ({}) }; },
  });
  vm.runInContext("globalThis.window = globalThis;", context);
  vm.runInContext(localSource, context, { filename: "local-ai.js" });
  vm.runInContext(aiSource, context, { filename: "ai.js" });
  vm.runInContext(enginesSource, context, { filename: "engines.js" });
  return { context, ...context.engines, requests, counts: () => ({ imports, loads, generations }) };
}

test("web boot configures installed LLMs without loading, on phones and desktop browsers", async () => {
  for (const mobile of [true, false]) {
    const f = fixture({ mode: "web", mobile });
    await f.startEngines(); await flush();
    assert.equal(f.context.ASoundAI.modelId, "test-cpu");
    assert.equal(f.context.ASoundAI.status().state, "off");
    assert.deepEqual(f.counts(), { imports: 0, loads: 0, generations: 0 });
    assert.deepEqual(f.requests, []);
    assert.equal(await f.context.askModel("Hello"), "Hello.", "the first real ask loads and runs the model");
    assert.equal(await f.context.askModel("Again"), "Hello.");
    assert.deepEqual(f.counts(), { imports: 1, loads: 1, generations: 2 });
    assert.deepEqual(f.requests, ["/test.gguf"]);
  }
});

test("actual mobile devices stay lazy even when connected to a local desktop server", async () => {
  const f = fixture({ mode: "desktop", mobile: true });
  await f.startEngines(); await f.applyEngines(); await flush();
  assert.deepEqual(f.counts(), { imports: 0, loads: 0, generations: 0 });
  assert.equal(await f.context.askModel("Hello"), "Hello.");
  assert.deepEqual(f.counts(), { imports: 1, loads: 1, generations: 1 });
});

test("native desktop startup preserves existing eager loading", async () => {
  const f = fixture({ mode: "desktop", mobile: false });
  await f.startEngines(); await flush();
  assert.equal(f.context.ASoundAI.status().state, "ready");
  assert.deepEqual(f.counts(), { imports: 1, loads: 1, generations: 0 });
  assert.equal(await f.context.askModel("Hello"), "Hello.");
  assert.deepEqual(f.counts(), { imports: 1, loads: 1, generations: 1 });
});
