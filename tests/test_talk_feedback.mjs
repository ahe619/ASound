import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const strip = (file) => readFileSync(new URL(`../app/js/${file}`, import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const source = [strip("util.js"), strip("diff.js"), strip("talk.js")].join("\n")
  + "\nglobalThis.talkTest = { normFeedback, normSummary, sendText, finishSession, requestFeedback, renderTurn, backToChat };";
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tagName: tag, children: [], attrs: {}, style: {}, hidden: false, className: "", textContent: "", handlers: {} });
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  click() { return this.handlers.click?.({ currentTarget: this }); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  replaceWith() {}
  remove() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  cloneNode() { return new FakeEl(this.tagName); }
  get content() { return { firstChild: new FakeEl("svg") }; }
}
const text = (n) => (n instanceof FakeEl ? n.children.map(text).join(" ") : String(n));

function fixture() {
  const calls = { asked: [], summaries: [] };
  const reply = deferred(), feedback = deferred();
  const storage = new Map();
  const els = {};
  const noop = () => {};
  const state = { tab: "talk", talkView: "chat", busy: false, session: null };
  const prefs = { level: 2, autoplay: false, helpLang: "zh" };
  const P = {
    partnerPrompt: () => "partner",
    feedbackPrompt: () => "feedback",
    summaryPrompt: (doc) => { calls.summaries.push(JSON.parse(JSON.stringify(doc))); return "summary"; },
  };
  const context = vm.createContext({
    window: {}, Node: FakeNode, AbortController, setTimeout, clearTimeout, setInterval: noop, console,
    localStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) },
    document: {
      createElement: (tag) => new FakeEl(tag),
      createDocumentFragment: () => new FakeEl("#fragment"),
      querySelector: (sel) => (els[sel] ||= new FakeEl("div")),
      querySelectorAll: () => [],
    },
    state, prefs, savePrefs: noop, LEVELS: [], SCENARIOS: [], scenarioById: noop, DOC_MODES: [], TOPICS: [],
    helpLang: () => ({}), isOtherScript: () => false, t: (k) => k, getLanguage: () => "en", P,
    ask: (input) => { calls.asked.push("reply"); return reply.promise; },
    askJSON: (prompt) => { calls.asked.push(prompt); return prompt === "feedback" ? (calls.nextFeedback || feedback.promise) : new Promise(noop); },
    aiErrorText: (e) => `error ${e && e.code}`,
    speak: noop, speakBtn: () => new FakeEl("button"), stopSpeaking: noop, unlockAudio: noop, isSpeaking: () => false,
    micButton: () => new FakeEl("button"), micSupported: () => false,
    handsFree: { on: false, stop: noop, pause: noop, resume: noop },
    vocab: { all: () => [] }, sessions: { all: () => [], save: noop }, profile: {}, placements: {}, rehearsals: {},
    live: { set: value => context.writeJSON("live", value), get: () => null, clear: noop },
    setTalkView: (v) => { state.talkView = v; }, currentRoute: () => ({}), registerViewCleanup: noop,
    saveBtn: () => new FakeEl("button"), confirmInline: noop, fmtDate: () => "today", levelName: () => "level 2",
    voiceRecommendCard: noop, modeCards: noop,
  });
  vm.runInContext(source, context, { filename: "talk.js" });
  const session = { id: "s1", kind: "talk", scenario: "chat", level: 2, startedAt: 1, turns: [{ role: "assistant", text: "Hi! How was your weekend?" }] };
  state.session = session;
  return { talk: context.talkTest, state, calls, reply, feedback, session, storage, summaryText: () => text(els["#summary"] || "") };
}

test("ending right after the reply waits for the last line's correction before summarizing", async () => {
  const f = fixture();
  const sent = f.talk.sendText("I goed to the park yesterday");
  await flush();
  assert.deepEqual(f.calls.asked, ["reply", "feedback"], "the partner's reply is queued before the correction");
  f.reply.resolve("Oh nice! What did you do there?");
  assert.equal(await sent, true);
  f.talk.finishSession();
  await flush();
  assert.equal(f.calls.summaries.length, 0, "the summary waits for the correction still running");
  assert.equal(f.state.talkView, "summary");
  assert.match(f.summaryText(), /sum\.loading/);
  f.feedback.resolve({ ok: false, corrected: "I went to the park yesterday.",
    issues: [{ type: "grammar", wrong: "goed", right: "went", explain: "past tense" }] });
  await flush();
  assert.equal(f.calls.summaries.length, 1);
  const doc = f.calls.summaries[0];
  assert.equal(doc.fixes, 1);
  assert.equal(doc.lines, 1);
  assert.deepEqual(doc.turns[1].fb, { ok: false, corrected: "I went to the park yesterday." });
});

test("going back to the chat while the last correction runs does not start a summary", async () => {
  const f = fixture();
  const sent = f.talk.sendText("I goed to the park yesterday");
  f.reply.resolve("Oh nice! What did you do there?");
  await sent;
  f.talk.finishSession();
  await flush();
  f.talk.backToChat();
  f.feedback.resolve({ ok: true });
  await flush();
  assert.equal(f.calls.summaries.length, 0);
});

test("a correction already in hand does not delay the summary", async () => {
  const f = fixture();
  const sent = f.talk.sendText("I went to the park yesterday");
  f.reply.resolve("Oh nice! What did you do there?");
  await sent;
  f.feedback.resolve({ ok: true });
  await flush();
  f.talk.finishSession();
  assert.equal(f.calls.summaries.length, 1, "summarized at once");
  assert.equal(f.calls.summaries[0].turns[1].fb.ok, true);
});

test("a mistake whose wrong words skip some of what was said is kept", () => {
  const { talk } = fixture();
  const said = "I very like this movie because it is so interesting";
  for (const wrong of ["I very like ... movie", "I very like … movie", "very like...movie"]) {
    const fb = talk.normFeedback({ ok: false, corrected: "I really like this movie because it is so interesting.",
      issues: [{ type: "grammar", wrong, right: "I really like this movie", explain: "very cannot describe like" }] }, said);
    assert.equal(fb.issues.length, 1, wrong);
  }
  const made = talk.normFeedback({ ok: false, corrected: said,
    issues: [{ type: "grammar", wrong: "I goes ... cinema", right: "I go to the cinema", explain: "made up" }] }, said);
  assert.equal(made.issues.length, 0, "words the learner never said are still dropped");
});

test("ellipsis requires every fragment in order, while existing candidate separators still allow alternatives", () => {
  const { talk } = fixture();
  const feedback = (wrong, said) => talk.normFeedback({ ok: false, corrected: said,
    issues: [{ type: "grammar", wrong, right: "a correction", explain: "Check these words" }] }, said);
  for (const wrong of ["I goes ... cinema", "I goes … cinema", "cinema ... I went"]) {
    assert.equal(feedback(wrong, "I went to the cinema.").issues.length, 0, wrong);
  }
  for (const wrong of ["I went ... cinema", "I went … cinema", "go, went", "go; went", "go / went"]) {
    assert.equal(feedback(wrong, "I went to the cinema.").issues.length, 1, wrong);
  }
});

test("ending waits for a failed correction's Retry button and its latest correction reaches the summary", async () => {
  const f = fixture();
  const sent = f.talk.sendText("I goed home");
  f.reply.resolve("Tell me more."); await sent;
  f.feedback.reject({ code: "unavailable" }); await flush();
  const turn = f.session.turns[1], retry = deferred();
  assert.equal(turn._fbP, undefined, "a finished request is no longer pending");
  f.calls.nextFeedback = retry.promise;
  turn._fb.children.at(-1).click(); // actual Retry handler rendered by requestFeedback
  f.talk.finishSession(); await flush();
  assert.equal(f.calls.summaries.length, 0);
  retry.resolve({ ok: false, corrected: "I went home", issues: [{ wrong: "goed", right: "went", explain: "past tense" }] });
  await flush();
  assert.equal(f.calls.summaries[0].fixes, 1);
  assert.equal(f.calls.summaries[0].turns[1].fb.corrected, "I went home");
});

test("the View correction button on a restored turn also participates in the finish wait", async () => {
  const f = fixture();
  const turn = { role: "user", text: "I goed home", fb: null };
  f.session.turns.push(turn);
  f.talk.renderTurn(turn);
  turn._fb.children[0].click(); // the restored turn's View correction button
  f.talk.finishSession(); await flush();
  assert.equal(f.calls.summaries.length, 0);
  f.feedback.resolve({ ok: false, corrected: "I went home", issues: [{ wrong: "goed", right: "went", explain: "past tense" }] });
  await flush();
  assert.equal(f.calls.summaries[0].fixes, 1);
});

test("a superseded check cannot overwrite the latest check and pending promises stay out of live storage", async () => {
  const f = fixture();
  const sent = f.talk.sendText("I goed home");
  f.reply.resolve("Tell me more."); await sent; await flush();
  const stored = JSON.parse(f.storage.get("live"));
  assert.equal(Object.keys(stored.turns[1]).some(key => key.startsWith("_")), false);
  const turn = f.session.turns[1], latest = deferred();
  f.calls.nextFeedback = latest.promise;
  f.talk.requestFeedback(turn);
  f.talk.finishSession(); await flush();
  f.feedback.resolve({ ok: true }); await flush();
  assert.equal(turn.fb, null, "older result cannot win");
  assert.equal(f.calls.summaries.length, 0);
  latest.resolve({ ok: false, corrected: "I went home", issues: [{ wrong: "goed", right: "went", explain: "past tense" }] });
  await flush();
  assert.equal(f.calls.summaries[0].fixes, 1);
  assert.equal(turn._fbP, undefined);
});

test("strengths quoting the partner are dropped in every help language's quote marks", () => {
  const { talk } = fixture();
  const opener = "Hi! What brings you to this event?";
  const doc = { turns: [{ role: "assistant", text: opener }, { role: "user", text: "My friend invited me, she works here." }] };
  const quoting = [
    "「What brings you to this event?」という質問が自然でした",
    "『What brings you to this event?』が自然",
    "Du hast „What brings you to this event?“ natürlich gesagt.",
    "Ты сказал «What brings you to this event?» естественно.",
    "Tu as dit « What brings you to this event? » naturellement.",
    "你用了'what brings you to this event'很自然",
    "你用了‘What brings you to this event’很自然",
    "You asked “What brings you to this event?” naturally.",
  ];
  const kept = [
    "You explained who invited you: 'My friend invited me' is natural.",
    "你说的‘My friend invited me’很自然",
    "l'expression 'she works here' est naturelle, and you didn't hesitate",
  ];
  const sum = talk.normSummary({ strengths: [...quoting, ...kept] }, doc);
  assert.deepEqual([...sum.strengths], kept.slice(0, 4));
});

test("strengths quoting the learner's own words survive when the partner echoed them", () => {
  const { talk } = fixture();
  const doc = { turns: [
    { role: "assistant", text: "Nice to meet you. What do you do?" },
    { role: "user", text: "I'm studying computer science at UF and it is a lot of fun." },
    { role: "assistant", text: "Oh nice, so you're studying computer science! That sounds like a lot of fun." },
  ] };
  const sum = talk.normSummary({ strengths: [
    "You described your major clearly: 'studying computer science'",
    "Natural phrase: \"a lot of fun\"",
    "You answered 'Nice to meet you. What do you do?' well",
  ] }, doc);
  assert.deepEqual([...sum.strengths], [
    "You described your major clearly: 'studying computer science'",
    "Natural phrase: \"a lot of fun\"",
  ]);
});
