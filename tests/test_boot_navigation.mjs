import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../app/js/main.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(hash = "") {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const calls = { resumed: 0, errors: [] };
  const noop = () => {};
  const state = { tab: "talk", talkView: "home" };
  const history = { state: null };
  const context = {
    state, history, prefs: { uiLang: "en" }, URLSearchParams,
    TABS: ["talk", "accent", "vocab", "voices", "models", "me"],
    location: { protocol: "https:", hash, search: "" }, navigator: { userAgent: "Test browser" },
    window: { addEventListener: noop, requestIdleCallback: noop },
    document: { body: { append: value => calls.errors.push(value) } },
    console: { error: error => calls.errors.push(error), warn: noop },
    $: () => ({ addEventListener: noop }), h: (...args) => args, t: value => value,
    setTab: tab => { state.tab = tab; },
    initNavigation: () => { history.state = { route: { tab: state.tab } }; },
    setLanguage: async () => {}, initModes: async () => {},
    startEngines: () => waiting, ready: () => true, packMode: () => "web",
    resumeIfRecent: () => { calls.resumed++; state.tab = "talk"; state.talkView = "chat"; },
    deviceInfo: () => ({ mobile: true }),
  };
  for (const name of ["initLayout", "registerTab", "registerTabCleanup", "initTalk", "initAccent", "initSettings",
    "onStoreChange", "renderTalkHome", "renderAccent", "cleanupAccent", "renderVocab", "cleanupVocab", "renderMe", "renderModels",
    "paintVocabCount", "repaintSaveButtons", "initUpdates", "initSpeechFeedback", "warmUp", "stopSpeaking", "renderVoices", "show", "showModels", "applyI18n", "isVocabPracticing"])
    context[name] = noop;
  vm.runInNewContext(source, context);
  await flush();
  assert.ok(history.state, "the landing page is interactive while packs are checked");
  return { state, history, calls, finish: async () => { release(); await flush(); assert.deepEqual(calls.errors, []); } };
}

test("background pack checks do not interrupt a lesson or settings within the landing tab", async () => {
  for (const route of [{ tab: "vocab", detail: "practice" }, { tab: "vocab", detail: "setup", overlay: "settings" }]) {
    const f = await fixture();
    f.history.state = { route };
    await f.finish();
    assert.equal(f.calls.resumed, 0);
    assert.equal(f.state.tab, "vocab");
  }
});

test("returning to the landing tab while packs load still preserves the user's navigation", async () => {
  const f = await fixture();
  f.history.state = { route: { tab: "vocab", detail: "setup" } };
  await f.finish();
  assert.equal(f.calls.resumed, 0);
});

test("an untouched landing page can resume a recent conversation, but an explicit vocabulary link cannot", async () => {
  const fresh = await fixture();
  await fresh.finish();
  assert.equal(fresh.calls.resumed, 1);
  const linked = await fixture("#vocab");
  await linked.finish();
  assert.equal(linked.calls.resumed, 0);
});
