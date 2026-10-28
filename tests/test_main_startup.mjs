import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// main.js on the hosted site, with the real nav.js and stubs for everything else.
const strip = (file) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const navSource = strip("../app/js/nav.js");
const mainSource = strip("../app/js/main.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const NAV_KEY = "asound.navigation.v1";

async function boot({ hash = "", entry = null, recent = false, practicing = () => false, mobile = false } = {}) {
  let release;
  const engines = new Promise((resolve) => { release = resolve; });
  const elements = new Map();
  const el = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { hidden: false, scrollTop: 0, addEventListener() {}, setAttribute() {}, getClientRects: () => [] });
    return elements.get(selector);
  };
  const history = {
    state: entry ? { [NAV_KEY]: { version: 1, id: "landing", parent: null, route: entry, scroll: {} } } : null,
    replaceState(value) { this.state = value; },
    pushState(value) { this.state = value; },
    back() {},
  };
  const state = { tab: "talk", talkView: "home", session: null };
  const calls = { resumed: 0, preloaded: 0, errors: [] };
  const noop = () => {};
  const context = vm.createContext({
    state, history, prefs: { uiLang: "en" }, URLSearchParams,
    location: { protocol: "https:", hash, search: "" }, navigator: { userAgent: "Test browser" },
    window: { addEventListener: noop, requestIdleCallback: (fn) => fn(), ASoundMic: { preload: () => { calls.preloaded++; } } },
    document: { querySelectorAll: () => [], getElementById: (id) => el("#" + id), body: { append: (value) => calls.errors.push(value) } },
    requestAnimationFrame: noop, console: { error: (error) => calls.errors.push(error), warn: noop },
    $: el, h: (...args) => args, t: (value) => value,
    setLanguage: async () => {}, initModes: async () => {},
    startEngines: () => engines, ready: () => true, packMode: () => "web",
    isVocabPracticing: () => practicing(),
    deviceInfo: () => ({ mobile }),
  });
  // talk.js: a conversation from the last half hour reopens; the Resume button reopens an older one.
  context.resumeSession = () => { state.session = { turns: [] }; context.setTalkView("chat"); };
  context.resumeIfRecent = () => { calls.resumed++; if (recent) context.resumeSession(); };
  for (const name of ["initLayout", "initTalk", "initAccent", "initSettings", "onStoreChange", "renderTalkHome",
    "renderAccent", "cleanupAccent", "renderVocab", "cleanupVocab", "renderMe", "renderModels", "paintVocabCount", "repaintSaveButtons",
    "initUpdates", "initSpeechFeedback", "warmUp", "showModels", "applyI18n"])
    context[name] = noop;
  vm.runInContext(navSource, context);
  vm.runInContext(mainSource, context);
  await flush();
  return { state, history, calls, el, context, finish: async () => { release(); await flush(); assert.deepEqual(calls.errors, []); } };
}

test("a reload during a recent conversation reopens the chat on the hosted site", async () => {
  const app = await boot({ hash: "#talk", entry: { tab: "talk", talkView: "chat" }, recent: true });
  assert.equal(app.state.talkView, "home", "talk home while the packs are checked");
  await app.finish();
  assert.equal(app.calls.resumed, 1);
  assert.equal(app.state.talkView, "chat");
  assert.equal(app.el("#view-chat").hidden, false);
});

test("after a reload on an ended chat, the Resume button still opens the conversation", async () => {
  const app = await boot({ hash: "#talk", entry: { tab: "talk", talkView: "chat" } });
  await app.finish();
  assert.equal(app.el("#view-chat").hidden, true);
  app.context.resumeSession();
  assert.equal(app.state.talkView, "chat");
  assert.equal(app.el("#view-chat").hidden, false);
});

test("practice started during the pack check is not interrupted, even if its history entry was rejected", async () => {
  let practicing = false;
  const app = await boot({ recent: true, practicing: () => practicing });
  app.history.pushState = () => { throw new Error("SecurityError"); };
  practicing = true;
  await app.finish();
  assert.equal(app.calls.resumed, 0);
  assert.equal(app.state.tab, "vocab");
});

test("hosted desktop browsers preload speech recognition when idle, phones do not", async () => {
  const desktop = await boot();
  await desktop.finish();
  assert.equal(desktop.calls.preloaded, 1);
  const phone = await boot({ mobile: true });
  await phone.finish();
  assert.equal(phone.calls.preloaded, 0);
});

test("the Models link stays selected when model checks finish despite a recent conversation", async () => {
  const app = await boot({ hash: "#models", recent: true });
  assert.equal(app.state.tab, "models");
  await app.finish();
  assert.equal(app.state.tab, "models");
  assert.equal(app.calls.resumed, 0);
  assert.equal(app.el("#view-models").hidden, false);
});
