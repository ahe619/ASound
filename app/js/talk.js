// Conversation practice: scenarios, the live chat (typed or spoken, with a hands-free mode), per-sentence
// corrections, help when the learner falls back to Chinese, and end-of-session summaries. The placement test
// and the profile interview reuse the same chat with their own rules (session.kind).
import { prefs, savePrefs, state, LEVELS, SCENARIOS, scenarioById, DOC_MODES, TOPICS } from "./state.js";
import { $, h, fill, icon, str, isObj, arr, pick, toast, thinkingDots, meter, cleanReply } from "./util.js";
import { helpLang, isOtherScript } from "./langs.js";
import { t, getLanguage } from "./i18n.js";
import { ask, askJSON, aiErrorText } from "./ai.js";
import * as P from "./prompts.js";
import { diffFragment, sameWords, looseEqual, readingMatch, normTok, tokens } from "./diff.js";
import { speak, speakBtn, stopSpeaking, unlockAudio, isSpeaking } from "./speech.js";
import { micButton, micSupported, handsFree } from "./mic.js";
import { vocab, sessions, profile, placements, live, rehearsals } from "./store.js";
import { setTalkView, currentRoute, registerViewCleanup } from "./nav.js";
import { saveBtn, confirmInline, fmtDate, levelName, voiceRecommendCard } from "./widgets.js";
import { modeCards } from "./modes.js";

const MAX_TURNS = 40;
const PLACEMENT_TURNS = 6;
const PROFILE_TURNS = 7;
const RESUME_WINDOW = 30 * 60 * 1000;
const FIELD_ANGLES = [
  "a team meeting", "explaining something to a non-expert", "solving a problem together",
  "a short presentation with questions", "a job interview in this field", "networking at a conference",
  "asking a senior colleague or professor for advice",
];

const thread = () => $("#thread");
const userTurns = (s) => s.turns.filter((x) => x.role === "user").length;
const lastAssistant = (s, before) => s.turns.slice(0, before).reverse().find((x) => x.role === "assistant")?.text || "";
const chatVisible = () => state.tab === "talk" && state.talkView === "chat" && !currentRoute().overlay;

/* ====================== home ====================== */

export function renderTalkHome() {
  const saved = state.session || live.get();
  fill($("#talk-home"),
    resumeCard(saved),
    debriefCard(),
    h("section", { class: "stack-xs" }, h("h1", { class: "title" }, t("talk.title")), h("p", { class: "lede" }, t("talk.lede"))),
    h("div", { class: "stack-sm" }, scenarioGrid(), scenarioExtras()),
    h("div", { class: "start-row" }, levelPicker(), h("button", { type: "button", class: "btn primary big", id: "start-btn", onclick: startTalk }, t("talk.start"))),
    modeCards("talk"),
    h("section", { class: "stack-sm" }, h("h2", { class: "sec" }, t("talk.sampleTitle")), sampleCard()),
    h("section", { class: "stack-sm" }, h("h2", { class: "sec" }, t("talk.historyTitle")), historyList()),
  );
}

function scenarioGrid() {
  const zh = getLanguage() !== "en"; // show the localized name under the English one
  return h("div", { class: "grid", role: "group", "aria-label": t("talk.scenarios") }, SCENARIOS.map((sc) => h("button", {
    type: "button", class: "opt", "aria-pressed": String(prefs.scenario === sc.id),
    onclick: () => { prefs.scenario = sc.id; savePrefs(); renderTalkHome(); },
  },
  h("span", { class: "opt-en", lang: "en" }, t(`scen.${sc.id}.en`)),
  zh ? h("span", { class: "opt-zh" }, t(`scen.${sc.id}.name`)) : null,
  h("span", { class: "opt-desc" }, t(`scen.${sc.id}.desc`)))));
}

function scenarioExtras() {
  const id = prefs.scenario;
  if (id === "custom") {
    const ta = h("textarea", { id: "custom-text", rows: "2", placeholder: t("talk.customPlaceholder") });
    ta.value = prefs.custom;
    ta.addEventListener("input", () => { prefs.custom = ta.value; savePrefs(); });
    return h("div", { class: "field stack-xs" }, h("label", { class: "field-label", for: "custom-text" }, t("talk.customLabel")), ta);
  }
  if (id === "document") return documentPicker();
  if (id === "rehearse") return rehearsePicker();
  if (id === "field") {
    const p = profile.get();
    if (!p || !p.field) return h("div", { class: "note-card row" }, h("span", null, t("talk.fieldNeedProfile")), h("button", { type: "button", class: "btn", onclick: startProfile }, t("talk.fieldGo")));
    return h("p", { class: "note-card" }, t("talk.fieldUsing", { summary: p.summary || p.field }));
  }
  return null;
}

function documentPicker() {
  const status = h("span", { class: "hint-line" }, state.doc && state.doc.fromFile ? t("talk.docLoaded", { name: state.doc.name }) : "");
  const file = h("input", { type: "file", id: "doc-file", accept: ".txt,.md,.markdown,.text", hidden: true });
  const ta = h("textarea", { id: "doc-text", rows: "6", placeholder: t("talk.docPaste") });
  ta.value = (state.doc && state.doc.text) || "";
  ta.addEventListener("input", () => { state.doc = { name: t("talk.docPasted"), text: ta.value, fromFile: false }; status.textContent = ""; });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    if (f.size > 2e6) { toast(t("talk.docTooBig")); return; }
    const text = await f.text();
    state.doc = { name: f.name, text, fromFile: true };
    ta.value = text;
    status.textContent = t("talk.docLoaded", { name: f.name });
  });
  const modes = h("div", { class: "seg", role: "group" }, DOC_MODES.map((m) => h("button", {
    type: "button", "data-m": m, "aria-pressed": String(prefs.docMode === m),
    onclick: () => { prefs.docMode = m; savePrefs(); for (const b of modes.children) b.setAttribute("aria-pressed", String(b.dataset.m === m)); },
  }, t(`talk.docMode.${m}`))));
  return h("div", { class: "field stack-xs" },
    h("span", { class: "field-label" }, t("talk.docLabel")),
    h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => file.click() }, icon("upload"), t("talk.docPick")), status),
    file, ta,
    h("span", { class: "field-label" }, t("talk.docModeLabel")), modes);
}

/* dress rehearsal: practise a real conversation that is coming up, then tell ASound how it went */

function rehearsePicker() {
  const ta = h("textarea", { id: "rehearse-text", rows: "2", placeholder: t("talk.rehearsePlaceholder") });
  ta.value = prefs.rehearse;
  ta.addEventListener("input", () => { prefs.rehearse = ta.value; savePrefs(); });
  const when = h("input", { type: "date", id: "rehearse-when" });
  when.value = prefs.rehearseWhen || "";
  when.addEventListener("change", () => { prefs.rehearseWhen = when.value; savePrefs(); });
  return h("div", { class: "field stack-xs" },
    h("label", { class: "field-label", for: "rehearse-text" }, t("talk.rehearseLabel")), ta,
    h("div", { class: "row" }, h("label", { class: "field-label", for: "rehearse-when" }, t("talk.rehearseWhen")), when),
    h("p", { class: "hint-line" }, t("talk.rehearseNote")));
}

// A rehearsal whose day has come (or half a day later, without a date) asks for a debrief.
function dueRehearsal() {
  const now = Date.now();
  return rehearsals.all().find((r) => {
    if (r.done) return false;
    const day = r.when ? Date.parse(r.when + "T23:59:59") : NaN;
    return Number.isFinite(day) ? now > day - 6 * 3600 * 1000 : now - (Number(r.createdAt) || now) > 12 * 3600 * 1000;
  }) || null;
}

function debriefCard() {
  const r = dueRehearsal();
  if (!r) return null;
  const card = h("div", { class: "card debrief" });
  const close = (patch) => { rehearsals.update(r.id, patch); renderTalkHome(); };
  const ask = () => {
    const ta = h("textarea", { rows: "3", placeholder: t("debrief.placeholder") });
    const out = h("div", { class: "stack-sm" });
    const send = async (text) => {
      const said = str(text);
      if (!said) return;
      fill(out, h("p", null, t("debrief.thinking"), thinkingDots()));
      try {
        const o = await askJSON(P.debriefPrompt(r, said));
        const lines = arr(o && o.lines).filter(isObj).map((x) => ({ en: str(x.en), meaning: str(x.meaning) })).filter((x) => x.en).slice(0, 2);
        fill(out,
          str(o && o.reply) ? h("p", null, str(o.reply)) : null,
          arr(o && o.tips).map(str).filter(Boolean).slice(0, 2).map((x) => h("p", { class: "hint-line" }, "\u2022 ", x)),
          lines.map((x) => h("div", { class: "better-row" },
            h("div", { class: "better-text" }, h("p", { class: "better-en", lang: "en" }, x.en), x.meaning ? h("p", { class: "hint-line" }, x.meaning) : null),
            speakBtn(x.en, t("chat.read")), saveBtn({ term: x.en, meaning: x.meaning, source: "talk" }))),
          h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => close({ done: true, debrief: said, debriefAt: Date.now() }) }, t("debrief.done"))));
      } catch (e) {
        fill(out, h("p", { class: "err" }, aiErrorText(e)));
      }
    };
    fill(card,
      h("strong", null, t("debrief.title", { title: r.title })),
      h("div", { class: "attempt-row" }, micButton({ label: t("debrief.say"), onText: (x) => { ta.value = x; send(x); } }), h("span", { class: "hint-line" }, t("debrief.sayHint"))),
      ta,
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn primary", onclick: () => send(ta.value) }, t("debrief.send"))),
      out);
  };
  fill(card,
    h("p", { class: "eyebrow" }, t("debrief.eyebrow")),
    h("strong", null, t("debrief.title", { title: r.title })),
    h("p", { class: "hint-line" }, t("debrief.lede")),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: ask }, t("debrief.tell")),
      h("button", { type: "button", class: "btn", onclick: () => close({ when: "", createdAt: Date.now() }) }, t("debrief.notYet")),
      h("button", { type: "button", class: "btn quiet", onclick: () => close({ done: true }) }, t("debrief.skip"))));
  return card;
}

// Run a preparation step with the start button showing "Preparing..."; null when it failed.
async function withStartButton(fn) {
  const btn = $("#start-btn");
  btn.disabled = true;
  btn.textContent = t("talk.preparing");
  try {
    return await fn();
  } catch (e) {
    toast(aiErrorText(e));
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = t("talk.start");
  }
}

/* saved expressions count as "owned" once the learner uses them in three different conversations */

const OWNED = 3;
const PLACEHOLDER = /\b(sb|sth|someone|something|somebody|one's|\.\.\.)\b|\u2026|\//i;
const phraseKey = (s) => tokens(s).map(normTok).filter(Boolean).join(" ");
export const usedCount = (v) => arr(v.used).length;
export function pendingExpressions() {
  return vocab.all().filter((v) => usedCount(v) < OWNED && !PLACEHOLDER.test(v.term) && tokens(v.term).length <= 7);
}
function creditExpressions(s, turn) {
  if (s.kind !== "talk" || arr(s.hinted).includes(phraseKey(turn.text))) return []; // picked from hints: not unprompted
  const said = " " + phraseKey(turn.text) + " ";
  const hits = [];
  for (const v of pendingExpressions()) {
    const key = phraseKey(v.term);
    if (!key || arr(v.used).includes(s.id) || !said.includes(" " + key + " ")) continue;
    hits.push({ term: v.term, n: vocab.use(v.id, s.id) });
  }
  return hits;
}
function usedChips(hits) {
  return h("div", { class: "used-chips" }, hits.map((x) => h("span", { class: "used-chip" + (x.n >= OWNED ? " owned" : "") },
    icon("check"), x.n >= OWNED ? t("used.owned", { term: x.term }) : t("used.count", { term: x.term, n: x.n, total: OWNED }))));
}

function levelPicker() {
  const seg = h("div", { class: "seg", role: "group", "aria-labelledby": "level-label" }, LEVELS.map((l) => h("button", {
    type: "button", "data-id": l.id, "aria-pressed": String(prefs.level === l.id), title: t(`level.${l.id}.desc`),
    onclick: () => { prefs.level = l.id; savePrefs(); for (const b of seg.children) b.setAttribute("aria-pressed", String(Number(b.dataset.id) === l.id)); },
  }, String(l.id), h("small", null, t(`level.${l.id}.name`)))));
  return h("div", { class: "stack-xs" }, h("span", { class: "field-label", id: "level-label" }, t("talk.levelLabel")), seg);
}

function sampleCard() {
  const said = "yesterday I go to library and borrow two book";
  const fb = {
    ok: false,
    corrected: "Yesterday I went to the library and borrowed two books.",
    issues: [
      { type: "grammar", wrong: "go, borrow", right: "went, borrowed", explain: t("sample.i1") },
      { type: "grammar", wrong: "library", right: "the library", explain: t("sample.i2") },
      { type: "grammar", wrong: "two book", right: "two books", explain: t("sample.i3") },
    ],
    better: [{ en: "I swung by the library yesterday and picked up two books.", meaning: t("sample.better") }],
    praise: "",
  };
  const box = h("div", { class: "fb" });
  renderFeedback(box, fb, said, { demo: true });
  return h("div", { class: "sample-card" }, h("div", { class: "msg me" }, h("div", { class: "bubble", lang: "en" }, said), box));
}

function historyList() {
  const items = sessions.all().slice(0, 15);
  if (!items.length) return h("p", { class: "empty-line" }, t("talk.historyEmpty"));
  return h("ol", { class: "history" }, items.map((doc) => {
    const del = h("button", { type: "button", class: "icon-btn sm", "aria-label": t("common.delete"), title: t("common.delete") }, icon("trash"));
    del.addEventListener("click", () => confirmInline(del, () => { sessions.remove(doc.id); renderTalkHome(); }));
    return h("li", { class: "hist-row" },
      h("button", { type: "button", class: "hist", onclick: () => openSummary(doc) },
        h("span", { class: "hist-title", lang: "en" }, str(doc.title)),
        h("span", { class: "hist-meta" }, t("talk.historyMeta", { date: fmtDate(doc.endedAt), level: levelName(doc.level), lines: doc.lines || 0, fixes: doc.fixes || 0 }))),
      del);
  }));
}

function validLive(s) {
  return isObj(s) && Array.isArray(s.turns) && s.turns.length > 0
    && s.turns.every((x) => isObj(x) && (x.role === "user" || x.role === "assistant") && typeof x.text === "string");
}
function resumeCard(saved) {
  if (!validLive(saved)) return null;
  return h("div", { class: "resume" },
    h("div", { class: "resume-text" }, h("strong", null, t("talk.resumeTitle")), h("span", null, t("talk.resumeMeta", { title: sessionTitle(saved), n: userTurns(saved) }))),
    h("button", { type: "button", class: "btn primary", onclick: () => resumeSession(saved) }, t("talk.resume")),
    h("button", { type: "button", class: "btn quiet", onclick: () => {
      if (state.session === saved) closeSession();
      else live.clear();
      renderTalkHome();
    } }, t("talk.discard")));
}

export function sessionTitle(s) {
  if (s.kind === "placement") return `${t("place.title")} \u00b7 ${s.topic}`;
  if (s.kind === "profile") return t("profile.title");
  if (s.scenario === "field" && s.scene) return s.scene.title;
  if (s.scenario === "document" && s.doc) return s.doc.name;
  if (s.scenario === "custom") { const c = str(s.custom); return c.length > 28 ? c.slice(0, 28) + "\u2026" : c || t("scen.custom.en"); }
  return t(`scen.${s.scenario}.en`);
}

/* ====================== starting ====================== */

function newSession(extra) {
  const now = Date.now();
  const s = { id: "s-" + now, kind: "talk", scenario: prefs.scenario, level: prefs.level, startedAt: now, updatedAt: now, turns: [], ...extra };
  if (s.kind === "talk" && s.scenario !== "exam") s.openings = pendingExpressions().slice(0, 3).map((v) => v.term);
  return s;
}

async function startTalk() {
  unlockAudio();
  const sc = scenarioById(prefs.scenario);
  const extra = {};
  if (sc.id === "custom") {
    if (!str(prefs.custom)) { toast(t("talk.needCustom")); return; }
    extra.custom = str(prefs.custom);
  }
  if (sc.id === "document") {
    if (!state.doc || !str(state.doc.text)) { toast(t("talk.needDoc")); return; }
    extra.doc = { name: state.doc.name, text: String(state.doc.text).slice(0, 12000) };
    extra.docMode = prefs.docMode;
  }
  if (sc.id === "rehearse") {
    if (!str(prefs.rehearse)) { toast(t("talk.needRehearse")); return; }
    const plan = await withStartButton(async () => {
      const o = await askJSON(P.rehearsePlanPrompt(str(prefs.rehearse), prefs.level));
      const scene = { title: str(o && o.title), role: str(o && o.role), setting: str(o && o.setting), goal: str(o && o.goal) };
      if (!scene.title || !scene.role) throw { code: "invalid_json" };
      const lines = arr(o.lines).filter(isObj).map((x) => ({ en: str(x.en), meaning: str(x.meaning) })).filter((x) => x.en).slice(0, 6);
      return { scene, lines, curveball: str(o.curveball) };
    });
    if (!plan) return;
    const id = "r-" + Date.now();
    rehearsals.add({ id, title: plan.scene.title, goal: plan.scene.goal, desc: str(prefs.rehearse), when: prefs.rehearseWhen || "", createdAt: Date.now(), done: false });
    beginSession(newSession({ ...plan, rehearsal: id, stage: 1 }));
    return;
  }
  if (sc.id === "field") {
    const p = profile.get();
    if (!p || !p.field) { toast(t("talk.fieldNeedProfile")); return; }
    const btn = $("#start-btn");
    btn.disabled = true;
    btn.textContent = t("talk.preparing");
    try {
      const raw = await askJSON(P.fieldScenePrompt(p, prefs.level, pick(FIELD_ANGLES)));
      const o = isObj(raw) ? raw : {};
      const scene = { title: str(o.title), role: str(o.role), setting: str(o.setting), goal: str(o.goal) };
      if (!scene.title || !scene.role) throw { code: "invalid_json" };
      extra.scene = scene;
    } catch (e) {
      toast(aiErrorText(e));
      btn.disabled = false;
      btn.textContent = t("talk.start");
      return;
    }
  }
  beginSession(newSession(extra));
}

// Placement test: the learner's own words (English or Chinese), or a topic they name, become a short graded chat.
// startPlacement({words: [...]}) or startPlacement({topic: "..."})
export async function startPlacement({ words: chosen, topic: wanted } = {}) {
  unlockAudio();
  const given = arr(chosen).map(str).filter(Boolean).slice(0, 8);
  const topicIn = str(wanted);
  if (!topicIn && given.length < 3) { toast(t("place.needWords")); return false; }
  let topic = "", words = [];
  try {
    const raw = await askJSON(topicIn ? P.placementTopicPrompt(topicIn) : P.placementSetupPrompt(given));
    topic = str(raw && raw.topic);
    words = arr(raw && raw.words).filter(isObj).map((w) => ({ en: str(w.en), meaning: str(w.meaning), added: w.added === true })).filter((w) => w.en).slice(0, 7);
  } catch (e) { console.warn(e); }
  if (!words.length) {
    if (!given.length) { toast(t("ai.err.generic")); return false; }
    words = given.map((w) => ({ en: w, meaning: "", added: false }));
  }
  if (!topic) topic = topicIn || pick(TOPICS);
  beginSession(newSession({ kind: "placement", scenario: "chat", topic, words, level: 3 }));
  return true;
}

export function startProfile() {
  unlockAudio();
  beginSession(newSession({ kind: "profile", scenario: "chat", level: prefs.level }));
}

// Scripted first lines for the built-in scenes, used with the small phone models (their own openers often go off track).
const OPENERS = {
  chat: ["Hey, I don't think we've met. I'm Alex. What brings you to this event?", "Hi there! I'm Alex. How's your week been so far?"],
  office: ["Hi, come on in! What can I help you with today?", "Hey, good to see you. What did you want to talk about?"],
  group: ["Okay, we need to split up the work for this project. Which part do you want to take?", "Hey! The deadline's next Friday. Where are you at with your part?"],
  cafe: ["Hi, welcome in! What can I get started for you today?", "Hey there! What are you in the mood for today?"],
  interview: ["Thanks for coming in today. So, tell me a little about yourself.", "Nice to meet you. To start, what made you apply for this internship?"],
  doctor: ["Hi, I'm the nurse on duty today. What brings you in?", "Hello, have a seat. So, what's been going on?"],
  exam: ["Good morning. Could you tell me your full name, please?", "Let's begin. Could you tell me where you're from?"],
  ita: ["Hi! So what are we learning about in today's class?", "Hey, I'm in your section. What concept are you teaching us today?"],
};

function beginSession(s) {
  stopSpeaking();
  state.session = s;
  if (s.kind === "talk" && !s.turns.length && OPENERS[s.scenario] && P.smallModel()) {
    const turn = { role: "assistant", text: pick(OPENERS[s.scenario]) };
    s.turns.push(turn);
    persistLive();
    renderChat();
    setTalkView("chat");
    const el = thread().lastElementChild;
    if (el) afterReply(turn, el);
    return;
  }
  persistLive();
  renderChat();
  setTalkView("chat");
  requestReply();
}

export function resumeSession(saved) {
  // The live object owns its pending reply and existing chat nodes. Returning
  // from Home must not clone it or reset the busy composer while it is replying.
  if (state.session === saved) { setTalkView("chat"); return; }
  state.session = { ...saved, turns: saved.turns.map((x) => ({ ...x })) };
  renderChat();
  setTalkView("chat");
}

function persistLive() {
  if (!state.session) return;
  state.session.updatedAt = Date.now();
  live.set(state.session);
}

export function resumeIfRecent() {
  const saved = live.get();
  if (validLive(saved) && Date.now() - (Number(saved.updatedAt) || 0) < RESUME_WINDOW) resumeSession(saved);
}

/* ====================== chat ====================== */

function scrollThread(force) {
  const sc = $("#thread-scroll");
  if (force || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight;
}
function setBusy(b) {
  state.busy = b;
  $("#send-btn").disabled = b;
  for (const el of document.querySelectorAll(".hint-btn, .native-btn")) el.disabled = b;
  voiceMic.disabled = b;
}

function renderChat() {
  const s = state.session;
  $("#chat-title").textContent = sessionTitle(s);
  paintChatLevel();
  $("#end-bar").hidden = true;
  $("#hints").hidden = true;
  renderSceneCard();
  fill(thread(), s.turns.map(renderTurn));
  const last = s.turns[s.turns.length - 1];
  if (last && last.role === "user") thread().append(h("li", { class: "msg ai" }, h("button", { type: "button", class: "btn", onclick: (e) => { e.currentTarget.closest("li").remove(); requestReply(); } }, t("chat.continue"))));
  paintInputMode();
  paintLive();
  setBusy(false);
  requestAnimationFrame(() => scrollThread(true));
}

function paintChatLevel() {
  const s = state.session;
  $("#chat-level").textContent = s.kind === "placement"
    ? t("place.progress", { n: Math.min(userTurns(s), PLACEMENT_TURNS), total: PLACEMENT_TURNS })
    : levelName(s.level);
}

function renderSceneCard() {
  renderSceneBody();
  // Saved expressions to try in this conversation; the ones already used here drop off.
  const s = state.session, card = $("#scene-card");
  const left = s.kind === "talk" ? (s.openings || []).filter((term) => !vocab.all().some((v) => v.term === term && arr(v.used).includes(s.id))) : [];
  if (!left.length) return;
  if (card.hidden) { card.hidden = false; fill(card); }
  card.append(h("div", { class: "try-use" }, h("span", { class: "mini-label" }, t("used.try")), left.map((term) => h("span", { class: "word-chip", lang: "en" }, term))));
}
function renderSceneBody() {
  const s = state.session, card = $("#scene-card");
  if (s.kind === "placement") {
    card.hidden = false;
    fill(card,
      h("span", { class: "mini-label" }, t("place.wordsTitle")),
      h("div", { class: "words" }, s.words.map((w) => h("span", { class: "word-chip" + (usedWord(s, w.en) ? " used" : "") + (w.added ? " added" : ""), lang: "en", title: w.meaning || (w.added ? t("place.addedWord") : "") }, w.en))),
      h("span", { class: "hint-line" }, t("place.wordsHint")));
    return;
  }
  if (s.kind === "profile") { card.hidden = false; fill(card, h("span", null, t("profile.intro"))); return; }
  if (s.scene && s.scenario === "rehearse") { card.hidden = false; rehearsalCard(card, s); return; }
  if (s.scene) {
    card.hidden = false;
    fill(card, h("strong", { lang: "en" }, s.scene.title), h("span", { lang: "en" }, s.scene.setting), s.scene.goal ? h("span", null, t("scene.goal", { goal: s.scene.goal })) : null);
    return;
  }
  if (s.doc) { card.hidden = false; fill(card, h("strong", null, s.doc.name), h("span", null, t(`talk.docMode.${s.docMode}`))); return; }
  card.hidden = true;
}

// Rehearsal: the plan and the key lines, with less support at each stage (script -> keywords -> live).
function rehearsalCard(card, s) {
  const stage = s.stage || 1;
  const seg = h("div", { class: "seg", role: "group" }, [1, 2, 3].map((n) => h("button", {
    type: "button", "aria-pressed": String(stage === n),
    onclick: () => {
      if (n === stage) return;
      s.stage = n;
      persistLive();
      renderSceneCard();
      if (n === 3) toast(t("rehearse.liveToast"));
    },
  }, t(`rehearse.stage${n}`))));
  const keywords = (en) => tokens(en).filter((w) => normTok(w).length > 3).slice(0, 3).join(" \u2026 ");
  fill(card,
    h("strong", { lang: "en" }, s.scene.title),
    h("span", { lang: "en" }, s.scene.setting),
    s.scene.goal ? h("span", null, t("scene.goal", { goal: s.scene.goal })) : null,
    seg,
    stage < 3 && s.lines && s.lines.length
      ? h("ol", { class: "pocket" }, s.lines.map((x) => h("li", null,
        h("span", { class: "pocket-en", lang: "en" }, stage === 1 ? x.en : keywords(x.en)),
        stage === 1 && x.meaning ? h("span", { class: "hint-line" }, x.meaning) : null,
        stage === 1 ? speakBtn(x.en, t("chat.read")) : null)))
      : h("span", { class: "hint-line" }, t("rehearse.liveNote")),
    h("span", { class: "hint-line" }, t(`rehearse.stage${stage}.note`)));
}
function usedWord(s, word) {
  const w = tokens(word).map(normTok).join(" ");
  return s.turns.some((x) => x.role === "user" && (" " + tokens(x.text).map(normTok).join(" ") + " ").includes(" " + w + " "));
}

function renderTurn(turn) {
  if (turn.role === "assistant") {
    const native = h("p", { class: "msg-native", hidden: !turn.translation }, turn.translation || "");
    const tr = h("button", { type: "button", class: "mini" }, t("chat.translate"));
    tr.addEventListener("click", () => toggleTranslation(turn, native, tr));
    return h("li", { class: "msg ai" },
      h("div", { class: "bubble", lang: "en" }, turn.text),
      h("div", { class: "msg-tools" }, speakBtn(turn.text, t("chat.read")), tr),
      native);
  }
  if (turn.native) return renderHelpTurn(turn);
  const box = h("div", { class: "fb" });
  turn._fb = box;
  if (turn.fb) renderFeedback(box, turn.fb, turn.text);
  else if (state.session && state.session.kind === "placement") box.hidden = true;
  else {
    box.className = "fb pending";
    box.append(h("button", { type: "button", class: "mini", onclick: () => requestFeedback(turn) }, t("fb.view")));
  }
  return h("li", { class: "msg me" }, h("div", { class: "bubble", lang: "en" }, turn.text), box);
}

/* corrections */

const TYPES = ["grammar", "word", "natural", "pronunciation"];
function normFeedback(raw, said) {
  const o = isObj(raw) ? raw : {};
  // A "mistake" whose wrong words the learner never said is the model making things up: drop it.
  const saidKey = ` ${tokens(said).map(normTok).filter(Boolean).join(" ")} `;
  // Commas/semicolons/slashes list alternatives. An ellipsis instead skips words:
  // every quoted fragment must occur in order, not just a shared noun at the end.
  const inSaid = (w) => !w || w.split(/[,;/]/).some((candidate) => {
    const parts = candidate.split(/\.{2,}|…/).map(phraseKey).filter(Boolean);
    let cursor = 0;
    return parts.length > 0 && parts.every((key) => {
      const at = saidKey.indexOf(` ${key} `, cursor);
      if (at < 0) return false;
      cursor = at + key.length + 1;
      return true;
    });
  });
  const issues = arr(o.issues).filter(isObj)
    .map((x) => ({ type: TYPES.includes(str(x.type)) ? str(x.type) : "grammar", wrong: str(x.wrong), right: str(x.right), explain: str(x.explain) }))
    .filter((x) => (x.explain || x.right) && !(x.wrong && x.right && looseEqual(x.wrong, x.right)) && inSaid(x.wrong))
    .slice(0, 4);
  // A "more natural" version that only swaps one word is noise (small models do this often).
  const saidWords = tokens(said).map(normTok).filter(Boolean);
  const barelyDifferent = (en) => {
    const words = tokens(en).map(normTok).filter(Boolean);
    return Math.abs(words.length - saidWords.length) <= 1 && words.filter((w, i) => w !== saidWords[i]).length <= 1;
  };
  const better = arr(o.better).filter(isObj).map((x) => ({ en: str(x.en), meaning: str(x.meaning || x.zh) }))
    .filter((x) => x.en && !sameWords(x.en, said) && !barelyDifferent(x.en)).slice(0, 2);
  let corrected = str(o.corrected) || said;
  if (looseEqual(corrected, said)) corrected = said;
  const ok = issues.length === 0 && (o.ok !== false || sameWords(corrected, said));
  return { ok, corrected: ok ? said : corrected, issues: ok ? [] : issues, better, praise: str(o.praise) };
}

function renderFeedback(box, fb, said, opts = {}) {
  box.className = "fb " + (fb.ok ? "fb-ok" : "fb-fix");
  const kids = [];
  if (fb.ok) kids.push(h("p", { class: "fb-head" }, icon("check"), fb.praise || t("fb.okDefault")));
  else {
    kids.push(h("p", { class: "fb-head" }, t("fb.title")));
    kids.push(h("p", { class: "fb-corrected", lang: "en" }, diffFragment(said, fb.corrected), " ", speakBtn(fb.corrected, t("fb.listenRight"))));
    if (fb.issues.length) kids.push(h("ul", { class: "fb-issues" }, fb.issues.map(issueItem)));
    if (fb.praise) kids.push(h("p", { class: "fb-praise" }, fb.praise));
  }
  if (fb.better.length) {
    kids.push(h("div", { class: "fb-better" }, h("p", { class: "fb-label" }, t("fb.better")),
      fb.better.map((b) => h("div", { class: "better-row" },
        h("div", { class: "better-text" }, h("p", { class: "better-en", lang: "en" }, b.en), b.meaning ? h("p", { class: "hint-line" }, b.meaning) : null),
        speakBtn(b.en, t("chat.read")),
        opts.demo ? null : saveBtn({ term: b.en, meaning: b.meaning, source: "talk" })))));
  }
  fill(box, kids);
}
function issueItem(it) {
  return h("li", null,
    h("span", { class: "tag tag-" + it.type }, t(`type.${it.type}`)),
    h("div", { class: "issue-body" },
      it.wrong || it.right ? h("span", { class: "pair", lang: "en" }, it.wrong ? h("s", null, it.wrong) : null, it.wrong && it.right ? " \u2192 " : "", it.right ? h("b", null, it.right) : null) : null,
      it.explain ? h("span", null, it.explain) : null));
}

function requestFeedback(turn) {
  const s = state.session, box = turn._fb;
  if (!s || !box) return Promise.resolve();
  box.hidden = false;
  box.className = "fb pending";
  fill(box, h("span", null, t("fb.checking")), thinkingDots());
  const idx = s.turns.indexOf(turn);
  // All entry points (automatic, View, and Retry) own the current request. A
  // superseded check must not overwrite the latest one or disappear from End's wait.
  const pending = Promise.resolve().then(async () => {
    try {
      const raw = await askJSON(P.feedbackPrompt(s, lastAssistant(s, idx), turn.text));
      if (turn._fbP !== pending) return;
      turn.fb = normFeedback(raw, turn.text);
      if (state.session === s) persistLive();
      renderFeedback(box, turn.fb, turn.text);
      scrollThread();
    } catch (e) {
      if (turn._fbP !== pending || (e && e.code === "cancelled")) return;
      box.className = "fb failed";
      fill(box, h("span", null, aiErrorText(e)), h("button", { type: "button", class: "mini", onclick: () => requestFeedback(turn) }, t("chat.retry")));
    }
  }).finally(() => { if (turn._fbP === pending) delete turn._fbP; });
  turn._fbP = pending;
  return pending;
}

/* help: the learner said it in Chinese */

function renderHelpTurn(turn) {
  const card = h("div", { class: "fb fb-help" });
  turn._fb = card;
  paintHelp(card, turn);
  return h("li", { class: "msg me" }, h("div", { class: "bubble native" }, turn.native), card);
}
function paintHelp(card, turn) {
  if (!turn.help) {
    card.className = turn.helpError ? "fb failed" : "fb pending";
    fill(card, h("span", null, turn.helpError || t("help.loading")), turn.helpError ? null : thinkingDots());
    return;
  }
  const hp = turn.help;
  const check = h("div", { class: "say-check" });
  card.className = "fb fb-help";
  fill(card,
    h("p", { class: "fb-head" }, t("help.title")),
    h("div", { class: "better-row" }, h("p", { class: "help-en better-text", lang: "en" }, hp.en), speakBtn(hp.en, t("chat.read")), speakBtn(hp.en, t("speech.slow"), t("speech.slowShort"), 0.75)),
    hp.alt ? h("p", { class: "hint-line" }, t("help.alt"), " ", h("span", { lang: "en" }, hp.alt)) : null,
    hp.note ? h("p", null, hp.note) : null,
    h("div", { class: "attempt-row" },
      micButton({ label: t("help.trySay"), onText: (heard) => paintSayCheck(check, hp.en, heard) }),
      h("span", { class: "hint-line" }, t("help.trySayHint")),
      saveBtn({ term: hp.en, meaning: turn.native, source: "help" })),
    check);
}
export function paintSayCheck(box, target, heard) {
  const m = readingMatch(target, heard);
  const band = m.score >= 90 ? "high" : m.score >= 60 ? "mid" : "low";
  fill(box,
    h("div", { class: "score " + band }, h("span", null, t("say.score", { hit: m.hit, total: m.total })), meter(m.score / 100), h("span", null, m.score + "%")),
    m.hit < m.total ? h("p", { class: "drill-text small", lang: "en" }, m.frag) : h("p", { class: "fb-praise" }, t("say.perfect")),
    h("p", { class: "heard" }, t("say.heard"), " ", h("span", { lang: "en" }, heard)));
}

/* sending */

async function sendText(raw) {
  const s = state.session;
  const text = str(raw);
  if (!s || !text || state.busy || !chatVisible()) return false;
  stopSpeaking();
  $("#hints").hidden = true;
  if (isOtherScript(text)) { await sendHelp(s, text); return true; }
  const turn = { role: "user", text, fb: null };
  s.turns.push(turn);
  persistLive();
  const el = renderTurn(turn);
  const used = creditExpressions(s, turn);
  if (used.length) { el.append(usedChips(used)); renderSceneCard(); }
  thread().append(el);
  scrollThread(true);
  // The partner's reply goes into the model queue first; the red-pen check runs after it, so the conversation
  // never waits for a correction (on the small phone models a check can take 5-15 s).
  const reply = requestReply();
  if (s.kind === "placement") { renderSceneCard(); paintChatLevel(); }
  else requestFeedback(turn);
  await reply;
  return true;
}

async function sendHelp(s, native) {
  const turn = { role: "user", text: "", native, help: null };
  s.turns.push(turn);
  thread().append(renderTurn(turn));
  scrollThread(true);
  setBusy(true);
  setLive("thinking");
  try {
    const raw = await askJSON(P.helpPrompt(s, native, lastAssistant(s, s.turns.length - 1)));
    const o = isObj(raw) ? raw : {};
    turn.help = { en: str(o.en), alt: str(o.alt), note: str(o.note) };
    if (!turn.help.en) throw { code: "invalid_json" };
    turn.text = turn.help.en;
  } catch (e) {
    turn.help = null;
    turn.helpError = aiErrorText(e);
    turn.text = native;
  }
  persistLive();
  paintHelp(turn._fb, turn);
  scrollThread();
  setBusy(false);
  if (s.kind === "placement") paintChatLevel();
  await requestReply();
}

function sendFromBox() {
  const box = $("#composer-input");
  const text = box.value;
  if (!str(text) || state.busy) return;
  unlockAudio();
  box.value = "";
  autosize();
  sendText(text);
}

async function requestReply() {
  const s = state.session;
  if (!s || !chatVisible()) return;
  const bubble = h("div", { class: "bubble thinking" }, t("chat.thinking"), thinkingDots());
  const li = h("li", { class: "msg ai" }, bubble);
  thread().append(li);
  scrollThread(true);
  setBusy(true);
  setLive("thinking");
  handsFree.pause();
  const ctl = new AbortController();
  s._ctl = ctl;
  const input = [{ role: "user", content: P.partnerPrompt(s) }, ...s.turns.slice(-MAX_TURNS).filter((x) => x.text).map((x) => ({ role: x.role, content: x.text }))];
  let latest = "", frame = 0;
  try {
    const text = await ask(input, {
      signal: ctl.signal,
      // Tokens stream faster than the screen refreshes: draw the latest text once per frame.
      onText: ({ text }) => {
        latest = text;
        if (frame) return;
        frame = (window.requestAnimationFrame || ((fn) => setTimeout(fn, 16)))(() => {
          frame = 0;
          bubble.classList.remove("thinking");
          bubble.setAttribute("lang", "en");
          bubble.textContent = latest;
          scrollThread();
        });
      },
    });
    if (state.session !== s) return;
    const turn = { role: "assistant", text: cleanReply(text) };
    s.turns.push(turn);
    persistLive();
    const el = renderTurn(turn);
    li.replaceWith(el);
    scrollThread();
    afterReply(turn, el);
  } catch (e) {
    if ((e && e.code === "cancelled") || state.session !== s) { li.remove(); return; }
    bubble.className = "bubble";
    fill(bubble, h("span", { class: "err" }, aiErrorText(e)));
    li.append(h("div", { class: "msg-tools" }, h("button", { type: "button", class: "mini", onclick: () => { li.remove(); requestReply(); } }, t("chat.retry"))));
    if (chatVisible()) { setLive("listening"); handsFree.resume(); }
  } finally {
    // A frame still pending would paint streamed text over the error message.
    if (frame) (window.cancelAnimationFrame || clearTimeout)(frame);
    if (s._ctl === ctl) s._ctl = null;
    if (state.session === s) setBusy(false);
  }
}

function afterReply(turn, el) {
  const s = state.session;
  if (!s || !chatVisible()) return;
  const done = (s.kind === "placement" && userTurns(s) >= PLACEMENT_TURNS) || (s.kind === "profile" && userTurns(s) >= PROFILE_TURNS);
  const next = () => {
    if (state.session !== s || !chatVisible()) return;
    if (done) { finishSession(); return; }
    if (handsFree.on) { setLive("listening"); handsFree.resume(); }
  };
  if (prefs.autoplay || handsFree.on) { setLive("speaking"); speak(turn.text, el.querySelector(".speak"), 1, next); }
  else next();
}

async function toggleTranslation(turn, el, btn) {
  if (turn.translation) { el.hidden = !el.hidden; return; }
  btn.disabled = true;
  el.hidden = false;
  fill(el, t("chat.translating"), thinkingDots());
  try {
    turn.translation = str(await ask(P.translatePrompt(turn.text)));
    el.textContent = turn.translation;
    if (state.session) persistLive();
  } catch (e) {
    el.textContent = aiErrorText(e);
  } finally { btn.disabled = false; }
}

async function requestHints() {
  const s = state.session;
  if (!s || state.busy) return;
  const box = $("#hints");
  const close = () => h("button", { type: "button", class: "icon-btn sm", "aria-label": t("hints.close"), onclick: () => { box.hidden = true; } }, icon("close"));
  box.hidden = false;
  fill(box, h("p", { class: "hints-head" }, h("span", null, t("hints.loading"), thinkingDots())));
  try {
    const raw = await askJSON(P.hintsPrompt(s));
    const list = arr(raw && raw.suggestions).filter(isObj).map((x) => ({ en: str(x.en), meaning: str(x.meaning) })).filter((x) => x.en).slice(0, 3);
    if (!list.length) throw { code: "invalid_json" };
    fill(box,
      h("div", { class: "hints-head" }, h("span", null, t("hints.title")), close()),
      list.map((x) => h("div", { class: "hint" },
        h("button", { type: "button", class: "hint-pick", onclick: () => { s.hinted = [...arr(s.hinted), phraseKey(x.en)].slice(-20); const i = $("#composer-input"); i.value = x.en; autosize(); prefs.inputMode = "type"; savePrefs(); paintInputMode(); i.focus(); box.hidden = true; } },
          h("span", { class: "hint-en", lang: "en" }, x.en), x.meaning ? h("span", { class: "hint-zh" }, x.meaning) : null),
        speakBtn(x.en, t("chat.read")))));
  } catch (e) {
    fill(box, h("div", { class: "hints-head" }, h("span", null, aiErrorText(e)), close()));
  }
}

/* "I don't know how to say it": say or type it in your own language */

function toggleNative() {
  const box = $("#native-box");
  if (!box.hidden) { box.hidden = true; return; }
  $("#hints").hidden = true;
  const lang = helpLang(prefs.helpLang);
  const ta = h("textarea", { rows: "2", placeholder: t("native.placeholder", { lang: lang.label }) });
  const go = (text) => {
    const said = str(text);
    if (!said || !state.session || state.busy) return;
    box.hidden = true;
    stopSpeaking();
    sendHelp(state.session, said);
  };
  const voice = window.ASoundMic && window.ASoundMic.hasNative() && micSupported()
    ? h("div", { class: "attempt-row" }, micButton({ lang: lang.whisper, label: t("native.mic", { lang: lang.label }), onText: go }), h("span", { class: "hint-line" }, t("native.mic", { lang: lang.label })))
    : h("p", { class: "hint-line" }, t("native.needPack"), " ", h("button", { type: "button", class: "mini", onclick: () => import("./models.js").then((m) => m.showModels()) }, t("settings.models")));
  fill(box,
    h("div", { class: "hints-head" }, h("span", null, t("native.title", { lang: lang.label })),
      h("button", { type: "button", class: "icon-btn sm", "aria-label": t("hints.close"), onclick: () => { box.hidden = true; } }, icon("close"))),
    voice,
    h("div", { class: "row native-type" }, ta, h("button", { type: "button", class: "btn primary", onclick: () => go(ta.value) }, t("native.send"))));
  box.hidden = false;
  ta.focus();
}

/* typing vs. speaking, and hands-free */

let voiceMic = h("button");
const liveBar = h("i");
const liveMeter = h("span", { class: "meter" }, liveBar);
let liveState = "off";

function paintInputMode() {
  const voice = prefs.inputMode !== "type" && micSupported();
  $("#row-type").hidden = voice;
  $("#row-voice").hidden = !voice;
}
function setLive(st) { liveState = st; paintLive(); }
function paintLive() {
  const on = handsFree.on;
  const btn = $("#live-toggle");
  btn.classList.toggle("on", on);
  const label = on ? t("chat.liveOn") : t("chat.liveOff");
  fill(btn, icon("live"), h("span", { class: "btn-text" }, label));
  btn.setAttribute("aria-label", label);
  btn.title = label;
  const line = $("#live-line");
  line.hidden = !on;
  if (on) fill(line, h("span", null, t(`live.${liveState === "off" ? "listening" : liveState}`)), liveMeter);
}
// Turn-taking made for learners: a longer pause ends a turn at lower levels, and floor-holders keep the turn.
const END_MS = { 1: 1400, 2: 1200, 3: 1000, 4: 900, 5: 800 };
const FLOOR = /(\b(u+m+|u+h+|e+r+m*|h+m+|well|so|and|but|because|like|let me think|let me see|how do i put (it|this)|what's the word|what is the word|how do you say( it)?|give me a (second|sec|moment)|(that's a )?good question|i mean)|\.\.\.|\u2026)\s*[.,!?-]*\s*$/i;
let held = "";
let holdTimer = 0;
function armHold() {
  clearTimeout(holdTimer);
  holdTimer = setTimeout(async () => {
    if (!held || !handsFree.on) return;
    if (liveState === "hearing" || liveState === "transcribing") { armHold(); return; } // still talking
    const text = held;
    held = "";
    handsFree.pause();
    setLive("thinking");
    const sent = await sendText(text);
    if (!sent) { handsFree.resume(); setLive("listening"); }
  }, 8000);
}

async function toggleLive() {
  unlockAudio();
  if (handsFree.on) { handsFree.stop(); prefs.handsFree = false; savePrefs(); held = ""; clearTimeout(holdTimer); setLive("off"); return; }
  const level = state.session ? state.session.level : prefs.level;
  const ok = await handsFree.start({
    endMs: END_MS[level] || 1000,
    onText: async (text) => {
      const all = held ? `${held} ${text}` : text;
      clearTimeout(holdTimer);
      // "Let me think..." / "um" / a trailing "because": the learner is holding the floor, so keep listening.
      if (FLOOR.test(text) && tokens(all).length < 150) {
        held = all;
        setLive("holding");
        handsFree.resume();
        armHold();
        return;
      }
      held = "";
      setLive("thinking");
      const sent = await sendText(all);
      if (!sent) { handsFree.resume(); setLive("listening"); }
    },
    onState: (st) => setLive(st === "listening" && held ? "holding" : st),
    onLevel: (v) => { liveBar.style.transform = `scaleX(${v.toFixed(2)})`; }, // compositor-only, no layout per frame
  });
  if (ok) {
    prefs.handsFree = true;
    savePrefs();
    // Turned on while the partner is still talking or thinking: wait, and say so (the check below resumes after).
    if (state.busy || isSpeaking()) { handsFree.pause(); setLive(isSpeaking() ? "speaking" : "thinking"); }
    paintLive();
  }
}
// Hands-free must never sit paused while nothing else is going on (speech stopped by hand, or turned on mid-reply).
setInterval(() => {
  if (!chatVisible() || !handsFree.on || !state.session || state.busy || isSpeaking()) return;
  const paused = window.ASoundMic && window.ASoundMic.status().mic === "paused";
  if (liveState === "speaking" || liveState === "thinking" || (paused && (liveState === "listening" || liveState === "holding"))) {
    setLive(held ? "holding" : "listening");
    handsFree.resume();
  }
}, 1500);

/* ====================== ending & summaries ====================== */

function finishedDoc(s) {
  const turns = s.turns.map((x) => ({ role: x.role, text: x.text, native: x.native || "", fb: x.fb ? { ok: !!x.fb.ok, corrected: str(x.fb.corrected) } : null }));
  return {
    id: s.id, kind: s.kind, scenario: s.scenario, title: sessionTitle(s), level: s.level,
    startedAt: s.startedAt, endedAt: Date.now(),
    lines: turns.filter((x) => x.role === "user").length,
    fixes: turns.filter((x) => x.fb && !x.fb.ok).length,
    turns, summary: null,
  };
}
function closeSession() {
  if (state.session && state.session._ctl) state.session._ctl.abort();
  held = "";
  clearTimeout(holdTimer);
  state.session = null;
  live.clear();
  handsFree.stop();
  liveState = "off";
  setBusy(false);
}

async function finishSession() {
  const s = state.session;
  if (!s) return;
  stopSpeaking();
  handsFree.stop();
  setLive("off");
  if (!s.turns.some((x) => x.role === "user")) { closeSession(); renderTalkHome(); setTalkView("home"); return; }
  if (s.kind === "placement") { finishPlacement(s); return; }
  if (s.kind === "profile") { finishProfile(s); return; }
  const doc = finishedDoc(s);
  state.summaryOf = doc;
  setTalkView("summary");
  // The last line's correction runs after the partner's reply. Let it land so the summary and the saved talk
  // include it (the summary request would wait behind it in the model queue anyway).
  let checking = s.turns.filter((x) => x._fbP).map((x) => x._fbP);
  if (checking.length) {
    paintSummaryLoading(doc);
    while (checking.length) {
      await Promise.allSettled(checking);
      if (state.summaryOf !== doc || state.session !== s) return;
      checking = s.turns.filter((x) => x._fbP).map((x) => x._fbP);
    }
    Object.assign(doc, finishedDoc(s), { endedAt: doc.endedAt });
  }
  summarize(doc, s);
}

function summaryHeader(doc, withBack = true) {
  return h("header", { class: "sum-head" },
    withBack ? h("button", { type: "button", class: "btn quiet back", onclick: goHome }, icon("back"), t("sum.home")) : null,
    h("p", { class: "eyebrow" }, t("sum.eyebrow")),
    h("h1", { class: "sum-title", lang: "en" }, str(doc.title)),
    h("p", { class: "sum-meta" }, [levelName(doc.level), fmtDate(doc.endedAt), t("sum.lines", { n: doc.lines || 0 }), t("sum.fixes", { n: doc.fixes || 0 })].join(" \u00b7 ")));
}
function goHome() {
  cancelSummary();
  renderTalkHome();
  setTalkView("home");
}

function cancelSummary() {
  const doc = state.summaryOf;
  state.summaryOf = null;
  if (state.summaryCtl) state.summaryCtl.abort();
  state.summaryCtl = null;
  // Forward can revisit this history entry. Show the available transcript, not
  // an abandoned loading spinner; the live conversation remains resumable.
  if (doc && !doc.summary) renderSummary(doc);
}

function paintSummaryLoading(doc) {
  fill($("#summary"), summaryHeader(doc, false), h("div", { class: "loading-card" },
    h("p", null, t("sum.loading"), thinkingDots()), h("p", { class: "lede" }, t("sum.wait")),
    h("button", { type: "button", class: "btn", onclick: backToChat }, t("sum.backToChat"))));
}

async function summarize(doc, owner = state.session) {
  if (!owner || state.session !== owner || state.summaryOf !== doc) return;
  if (state.summaryCtl) state.summaryCtl.abort();
  const ctl = new AbortController();
  state.summaryCtl = ctl;
  paintSummaryLoading(doc);
  try {
    const raw = await askJSON(P.summaryPrompt(doc), { signal: ctl.signal });
    if (state.summaryOf !== doc || state.session !== owner || state.summaryCtl !== ctl || ctl.signal.aborted) return;
    doc.summary = normSummary(raw, doc);
    closeSession();
    sessions.save(doc);
    renderSummary(doc);
  } catch (e) {
    if ((e && e.code === "cancelled") || state.summaryOf !== doc || state.session !== owner || ctl.signal.aborted) return;
    fill($("#summary"), summaryHeader(doc, false), h("div", { class: "loading-card" },
      h("p", null, aiErrorText(e)),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn primary", onclick: () => summarize(doc, owner) }, t("sum.regen")),
        h("button", { type: "button", class: "btn", onclick: () => { closeSession(); sessions.save(doc); toast(t("sum.saved")); goHome(); } }, t("sum.saveOnly")),
        h("button", { type: "button", class: "btn quiet", onclick: backToChat }, t("sum.backToChat")))));
  } finally {
    if (state.summaryCtl === ctl) state.summaryCtl = null;
  }
}
function backToChat() {
  cancelSummary();
  if (!state.session) { goHome(); return; }
  setTalkView("chat");
}

function normSummary(raw, doc = null) {
  const o = isObj(raw) ? raw : {};
  // Small models sometimes praise the learner for the partner's lines: drop strengths that quote one
  // (but not words the learner said too: partners often echo the learner, and learners echo the question).
  const lines = (role) => (doc ? arr(doc.turns).filter((x) => x.role === role).map((x) => phraseKey(x.text)) : []);
  const partner = lines("assistant"), learner = lines("user");
  // Quoted text: "...", a curly pair, '...' whose apostrophes (don't, I'd) stay inside the quote and which may
  // touch Chinese or Japanese text, and the marks other help languages use: corner brackets, guillemets, German low-high.
  // (No lookbehind: this module loads at startup and older iPhone Safari cannot parse one.)
  const QUOTED = /"([^"]{12,})"|\u201c([^\u201d]{12,})\u201d|(?:^|[^\p{Script=Latin}])['\u2018]((?:[^'\u2019]|['\u2019](?=\p{L})){12,}?)['\u2019](?!\p{Script=Latin})|\u300c([^\u300d]{12,})\u300d|\u300e([^\u300f]{12,})\u300f|\u00ab\s*([^\u00bb]{12,}?)\s*\u00bb|\u201e([^\u201c\u201d]{12,})[\u201c\u201d]/gu;
  const quotesPartner = (s) => {
    QUOTED.lastIndex = 0;
    for (let m; (m = QUOTED.exec(String(s)));) {
      const key = phraseKey(m.slice(1).find(Boolean)); // the quoted words only (a single quote's match starts one character early)
      if (key && partner.some((p) => p.includes(key)) && !learner.some((l) => l.includes(key))) return true;
    }
    return false;
  };
  return {
    overall: str(o.overall),
    strengths: arr(o.strengths).map(str).filter((s) => s && !quotesPartner(s)).slice(0, 4),
    focus: arr(o.focus).filter(isObj).map((x) => ({ wrong: str(x.wrong), right: str(x.right), explain: str(x.explain) }))
      .filter((x) => (x.right || x.explain) && !(x.wrong && x.right && looseEqual(x.wrong, x.right))).slice(0, 5),
    expressions: arr(o.expressions).filter(isObj).map((x) => ({ term: str(x.term), ipa: str(x.ipa), meaning: str(x.meaning || x.zh), example: str(x.example) })).filter((x) => x.term).slice(0, 10),
    next: str(o.next),
  };
}

export function openSummary(doc) {
  cancelSummary();
  state.summaryOf = doc;
  renderSummary(doc);
  setTalkView("summary");
}

function section(title, body, tool) {
  return h("section", { class: "stack-sm" }, h("h2", { class: "sec" }, title, tool ? h("span", { class: "sec-tools" }, tool) : null), body);
}

function renderSummary(doc) {
  const s = isObj(doc.summary) ? normSummary(doc.summary) : null;
  const parts = [summaryHeader(doc)];
  if (!s) parts.push(h("p", { class: "lede" }, t("sum.none")));
  else {
    if (s.overall) parts.push(h("p", { class: "overall" }, s.overall));
    if (s.strengths.length) parts.push(section(t("sum.strengths"), h("ul", { class: "plain good" }, s.strengths.map((x) => h("li", null, icon("check"), h("span", null, x))))));
    if (s.focus.length) parts.push(section(t("sum.focus"), h("ul", { class: "plain focus" }, s.focus.map((f) => h("li", null,
      h("p", { class: "fb-corrected", lang: "en" }, f.wrong ? diffFragment(f.wrong, f.right || f.wrong) : f.right, " ", f.right ? speakBtn(f.right, t("fb.listenRight")) : null),
      f.explain ? h("p", null, f.explain) : null)))));
    if (s.expressions.length) {
      const addAll = h("button", { type: "button", class: "mini" }, icon("plus"), t("sum.addAll"));
      addAll.addEventListener("click", () => {
        let n = 0;
        for (const x of s.expressions) if (!vocab.has(x.term)) { vocab.add({ ...x, source: "summary" }); n++; }
        toast(n ? t("sum.added", { n }) : t("sum.allIn"));
      });
      parts.push(section(t("sum.expressions"), h("ul", { class: "plain exprs" }, s.expressions.map(exprItem)), addAll));
    }
    if (s.next) parts.push(h("div", { class: "next stack-xs" }, h("p", { class: "mini-label" }, t("sum.next")), h("p", null, s.next)));
  }
  parts.push(h("details", { class: "transcript" }, h("summary", null, t("sum.transcript")),
    h("ol", { class: "plain" }, arr(doc.turns).filter(isObj).map((x) => h("li", { class: "tline" },
      h("span", { class: "who" }, x.role === "user" ? t("sum.you") : t("sum.partner")),
      h("span", { lang: "en" }, x.native ? `${x.native} \u2192 ${str(x.text)}` : str(x.text)))))));
  parts.push(h("div", { class: "actions" },
    h("button", { type: "button", class: "btn primary", onclick: () => { goHome(); if (doc.kind === "talk" || !doc.kind) { prefs.scenario = doc.scenario; prefs.level = doc.level; savePrefs(); renderTalkHome(); } } }, t("sum.again")),
    h("button", { type: "button", class: "btn", onclick: goHome }, t("sum.home"))));
  fill($("#summary"), parts);
}

function exprItem(x) {
  return h("li", { class: "expr" },
    h("div", { class: "expr-main" },
      h("p", { class: "expr-top" }, h("span", { class: "term", lang: "en" }, x.term), x.ipa ? h("span", { class: "ipa" }, x.ipa.startsWith("/") ? x.ipa : `/${x.ipa}/`) : null),
      x.meaning ? h("p", { class: "expr-native" }, x.meaning) : null,
      x.example ? h("p", { class: "ex", lang: "en" }, x.example) : null),
    h("div", { class: "expr-tools" }, speakBtn(x.term, t("chat.read")), saveBtn({ ...x, source: "summary" })));
}

/* placement test result */

async function finishPlacement(s) {
  setTalkView("summary");
  fill($("#summary"),
    h("header", { class: "sum-head" }, h("p", { class: "eyebrow" }, t("place.eyebrow")), h("h1", { class: "sum-title", lang: "en" }, s.topic)),
    h("div", { class: "loading-card" }, h("p", null, t("place.loading"), thinkingDots())));
  try {
    const raw = await askJSON(P.placementEvalPrompt(s));
    const o = isObj(raw) ? raw : {};
    const level = Math.round(Number(o.level));
    if (!(level >= 1 && level <= 5)) throw { code: "invalid_json" };
    const sc = isObj(o.scores) ? o.scores : {};
    const n = (v) => { const x = Math.round(Number(v)); return x >= 1 && x <= 5 ? x : null; };
    const result = {
      id: s.id, at: Date.now(), topic: s.topic, words: s.words.map((w) => w.en), level,
      scores: { vocabulary: n(sc.vocabulary), grammar: n(sc.grammar), fluency: n(sc.fluency), naturalness: n(sc.naturalness) },
      summary: str(o.summary), reasons: arr(o.reasons).map(str).filter(Boolean).slice(0, 4), focus: arr(o.focus).map(str).filter(Boolean).slice(0, 4),
    };
    placements.add(result);
    prefs.level = level;
    savePrefs();
    closeSession();
    renderPlacementResult(result);
  } catch (e) {
    fill($("#summary"), h("div", { class: "loading-card" }, h("p", null, aiErrorText(e)), h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => finishPlacement(s) }, t("sum.regen")),
      h("button", { type: "button", class: "btn", onclick: () => { closeSession(); goHome(); } }, t("sum.home")))));
  }
}

export function levelBadge(level) {
  return h("div", { class: "level-badge" },
    h("div", { class: "level-pips", "aria-hidden": "true" }, LEVELS.map((l) => h("i", { class: l.id <= level ? "on" : "" }))),
    h("span", { class: "level-name" }, levelName(level)));
}

export function renderPlacementResult(r) {
  const tiles = ["vocabulary", "grammar", "fluency", "naturalness"].filter((k) => r.scores && r.scores[k]).map((k) =>
    h("div", { class: "score-tile" }, h("span", { class: "hint-line" }, t(`place.score.${k}`)), h("b", null, `${r.scores[k]}/5`)));
  fill($("#summary"),
    h("header", { class: "sum-head" },
      h("button", { type: "button", class: "btn quiet back", onclick: goHome }, icon("back"), t("sum.home")),
      h("p", { class: "eyebrow" }, t("place.eyebrow")),
      h("h1", { class: "sum-title" }, t("place.yourLevel")),
      h("p", { class: "sum-meta" }, `${r.topic} \u00b7 ${fmtDate(r.at)}`)),
    levelBadge(r.level),
    h("p", { class: "lede" }, t(`level.${r.level}.desc`)),
    tiles.length ? h("div", { class: "scores" }, tiles) : null,
    r.summary ? h("p", { class: "overall" }, r.summary) : null,
    r.reasons.length ? section(t("place.reasons"), h("ul", { class: "plain good" }, r.reasons.map((x) => h("li", null, icon("check"), h("span", null, x))))) : null,
    r.focus.length ? section(t("place.focus"), h("ul", { class: "plain focus" }, r.focus.map((x) => h("li", null, x)))) : null,
    h("p", { class: "note-card" }, t("place.applied", { level: levelName(r.level) })),
    voiceRecommendCard(),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => { goHome(); } }, t("place.startTalk")),
      h("button", { type: "button", class: "btn", onclick: () => { goHome(); document.querySelector("#tab-me").click(); } }, t("place.again"))));
}

/* profile interview result */

async function finishProfile(s) {
  setTalkView("summary");
  fill($("#summary"), h("div", { class: "loading-card" }, h("p", null, t("profile.loading"), thinkingDots())));
  try {
    const o = await askJSON(P.profileExtractPrompt(s));
    const p = {
      status: ["student", "working", "other"].includes(str(o && o.status)) ? str(o.status) : "other",
      field: str(o && o.field), detail: str(o && o.detail), current: str(o && o.current),
      interests: arr(o && o.interests).map(str).filter(Boolean).slice(0, 6), summary: str(o && o.summary),
    };
    if (!p.field && !p.summary) throw { code: "invalid_json" };
    profile.set(p);
    sessions.save({ ...finishedDoc(s), summary: null });
    closeSession();
    renderProfileResult(p);
  } catch (e) {
    fill($("#summary"), h("div", { class: "loading-card" }, h("p", null, aiErrorText(e)), h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => finishProfile(s) }, t("sum.regen")),
      h("button", { type: "button", class: "btn", onclick: () => { closeSession(); goHome(); } }, t("sum.home")))));
  }
}

export function profileFacts(p) {
  return h("ul", { class: "plain" },
    p.field ? h("li", null, h("strong", null, t("profile.field")), " ", h("span", { lang: "en" }, p.field)) : null,
    p.detail ? h("li", null, h("strong", null, t("profile.detail")), " ", h("span", { lang: "en" }, p.detail)) : null,
    p.current ? h("li", null, h("strong", null, t("profile.current")), " ", h("span", { lang: "en" }, p.current)) : null,
    p.interests && p.interests.length ? h("li", null, h("strong", null, t("profile.interests")), " ", h("span", { lang: "en" }, p.interests.join(", "))) : null);
}

function renderProfileResult(p) {
  fill($("#summary"),
    h("header", { class: "sum-head" },
      h("button", { type: "button", class: "btn quiet back", onclick: goHome }, icon("back"), t("sum.home")),
      h("p", { class: "eyebrow" }, t("profile.eyebrow")),
      h("h1", { class: "sum-title" }, t("profile.saved"))),
    p.summary ? h("p", { class: "overall" }, p.summary) : null,
    profileFacts(p),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => { prefs.scenario = "field"; savePrefs(); goHome(); startTalk(); } }, t("profile.startField")),
      h("button", { type: "button", class: "btn", onclick: goHome }, t("sum.home"))));
}

/* ====================== wiring ====================== */

function autosize() {
  const i = $("#composer-input");
  i.style.height = "auto";
  i.style.height = Math.min(i.scrollHeight + 2, 160) + "px";
}

export function initTalk() {
  registerViewCleanup("talk", "summary", () => {
    // Browser/system Back and tab changes must invalidate both the feedback
    // wait and the summary request, just like the explicit Back to chat button.
    if (state.tab !== "talk" || state.talkView !== "summary") cancelSummary();
    window.ASoundMic?.cancel?.(); // the placement result's voice card can be recording
  });
  // The debrief card on talk home has a microphone too.
  registerViewCleanup("talk", "home", () => { window.ASoundMic?.cancel?.(); });
  registerViewCleanup("talk", "chat", () => {
    // Returning home or opening another page pauses the microphone without
    // erasing the conversation. A late model reply may save text, never autoplay.
    handsFree.stop();
    window.ASoundMic?.cancel?.();
    stopSpeaking();
    held = "";
    clearTimeout(holdTimer);
    setLive("off");
  });
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); sendFromBox(); });
  const box = $("#composer-input");
  const coarse = window.matchMedia && matchMedia("(pointer: coarse)").matches;
  box.addEventListener("input", autosize);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !coarse && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendFromBox(); }
  });
  $("#send-btn").append(icon("send"));
  for (const b of document.querySelectorAll(".hint-btn")) { b.append(icon("bulb")); b.addEventListener("click", requestHints); }
  for (const b of document.querySelectorAll(".native-btn")) { b.append(icon("globe")); b.addEventListener("click", toggleNative); }
  const toVoice = $("#mode-voice"), toType = $("#mode-type");
  toVoice.append(icon("mic"));
  toType.append(icon("keyboard"));
  toVoice.addEventListener("click", () => { prefs.inputMode = "voice"; savePrefs(); paintInputMode(); });
  toType.addEventListener("click", () => { prefs.inputMode = "type"; savePrefs(); paintInputMode(); $("#composer-input").focus(); });
  voiceMic = micButton({ big: true, onText: (text) => sendText(text) });
  $("#voice-mic-slot").replaceWith(voiceMic);
  $("#live-toggle").addEventListener("click", toggleLive);
  $("#end-open").addEventListener("click", () => { $("#end-bar").hidden = false; $("#end-confirm").focus(); });
  $("#end-cancel").addEventListener("click", () => { $("#end-bar").hidden = true; });
  $("#end-confirm").addEventListener("click", finishSession);
  if (!["voice", "type"].includes(prefs.inputMode)) prefs.inputMode = "voice";
  paintInputMode();
  paintLive();
}
