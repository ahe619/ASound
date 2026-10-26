// Shrinking Retell: say the same content three times with less time each round (Nation's 4/3/2 fluency activity),
// so the learner stops planning sentences and starts retrieving them. Each round is a timed recording; words,
// speed, pauses, fillers and key-point coverage are measured here without the language model. Between rounds one
// optional model call on a prepared desktop suggests a tighter phrase. Other sessions use measured feedback.
import { prefs, levelById, TOPICS } from "./state.js";
import { h, fill, icon, str, isObj, arr, pick, thinkingDots, readJSON, writeJSON } from "./util.js";
import { t } from "./i18n.js";
import { askJSON, aiErrorText } from "./ai.js";
import { helpLangName } from "./prompts.js";
import { speakBtn, stopSpeaking, unlockAudio, audioContext } from "./speech.js";
import { micSupported } from "./mic.js";
import { activePacks } from "./packs.js";
import { deviceInfo } from "./device.js";
import { tokens, normTok, looseEqual } from "./diff.js";
import { saveBtn, fmtDate, levelName } from "./widgets.js";

export const meta = { id: "retell", where: "talk", icon: "wave" };

const KEY = "asound.retell.v1";
const RATE = 16000;
const LIMITS = { 1: [60, 45, 30], 2: [75, 55, 40], 3: [90, 60, 45], 4: [120, 90, 60], 5: [180, 120, 90] };

// "Talk about you" topics: the question is read in English; the label lives in the locale (retell.topic.<id>).
const PROMPTS = [
  { id: "commute", en: "How did you get here today? Walk me through it, from the moment you left." },
  { id: "major", en: "What do you study or do for work, and how did you end up choosing it?" },
  { id: "weekend", en: "Tell me about a recent weekend. What did you do, and what was the best part?" },
  { id: "place", en: "Describe a place you love. What is it like, and why does it matter to you?" },
  { id: "skill", en: "What skill are you learning right now? How is it going so far?" },
  { id: "meal", en: "Tell me about a meal you really enjoyed. Where were you, and who were you with?" },
  { id: "hometown", en: "Describe your hometown to someone who has never been there." },
  { id: "person", en: "Tell me about someone who helped you a lot. What did they do?" },
  { id: "trip", en: "Tell me about a trip you took. What happened along the way?" },
  { id: "routine", en: "Walk me through a normal weekday for you, from morning to night." },
  { id: "problem", en: "Tell me about a small problem you solved recently. What happened?" },
  { id: "plan", en: "What are you looking forward to this year, and why?" },
];

// Ready-to-use stories also keep mobile practice independent of inference engines.
const STORIES = [
  { title: "The Lost Umbrella", points: ["the bus", "the blue umbrella", "a funny message", "the lost and found", "a coffee for the driver"],
    text: "On Monday morning, Mia took the bus to work. It was raining hard, so she carried her big blue umbrella. She was reading a funny message from her sister and almost missed her stop. She jumped off the bus just in time, but the umbrella stayed on the seat. All day she felt bad about it. After work, she went back to the bus station and asked at the lost and found. A kind driver had found it and kept it safe. Mia thanked him and bought him a coffee." },
  { title: "The Birthday Cake", points: ["a chocolate cake", "a video online", "the timer", "the burnt top", "fruit and cream"],
    text: "Last Saturday was my friend Leo's birthday, and I wanted to bake him a chocolate cake. I had never baked a cake before, so I watched a short video online. Everything went well until I forgot to set the timer. The kitchen started to smell like smoke, and the top of the cake was black. I almost gave up, but my roommate had an idea. We cut off the burnt top and covered the cake with fruit and cream. Leo said it was the best cake he ever had." },
  { title: "The Wrong Classroom", points: ["the front row", "chemistry", "his schedule", "the next building", "the notes"],
    text: "On the first day of the semester, Sam walked into a big classroom and sat in the front row. The professor started talking about chemistry, and Sam felt confused, because he was taking a history class. He was too shy to leave, so he stayed for twenty minutes and took notes. At the break, he finally checked his schedule. His class was in the next building. He ran over and arrived just as it ended. The history professor laughed and gave him the notes." },
  { title: "The Morning Run", points: ["the alarm", "the park", "an older man", "the lake", "a new friend"],
    text: "Nina wanted to get healthier, so she decided to run every morning before work. On the first day, her alarm rang at six, and she almost turned it off. She put on her shoes and went to the park near her apartment. After ten minutes she was tired, but an older man running next to her smiled and told her to keep going. They ran together all the way to the lake. Now they meet at the park every Tuesday and Thursday, and Nina has a new friend." },
];

let M = null; // the mounted mode: {root, onExit, gen, ctl, rec, tick, clip}
let S = null; // the drill in progress: {kind, content, level, limits, rounds, saved}
let generation = 0;
const current = (gen) => !!M && M.gen === gen;
const canGenerate = () => !deviceInfo().mobile && !!activePacks().llm && !!window.claude;
const canRecognize = () => micSupported() && !!activePacks().asr;

/* ====================== mount / exit ====================== */

export function mount(root, { onExit } = {}) {
  unmount();
  const mounted = M = { root, onExit: onExit || (() => {}), gen: ++generation, ctl: null, rec: null, tick: 0, clip: null };
  S = null;
  renderHome();
  return () => { if (M === mounted) unmount(); };
}

function exit() {
  const done = M.onExit;
  unmount();
  done();
}

function unmount() {
  stopAll();
  S = null;
  M = null;
}

// Stop everything that could still talk, record or call the model; async work checks M.gen afterwards.
function stopAll() {
  if (!M) return;
  M.gen = ++generation;
  if (M.ctl) { M.ctl.abort(); M.ctl = null; }
  stopSpeaking();
  stopClip();
  if (M.rec) { M.rec.cancel(); M.rec = null; }
  clearInterval(M.tick);
  M.tick = 0;
}

function show(...kids) {
  fill(M.root, ...kids);
  const v = M.root.closest(".view");
  if (v) v.scrollTop = 0;
}

const backBtn = (label, fn) => h("button", { type: "button", class: "btn quiet back", onclick: fn }, icon("back"), label);
function head(onBack, eyebrow, title, en) {
  return h("header", { class: "sum-head" },
    backBtn(t("retell.back"), onBack),
    h("p", { class: "eyebrow" }, eyebrow),
    h("h1", { class: en ? "sum-title" : "title", lang: en ? "en" : null }, title));
}

const limits = (level) => LIMITS[level] || LIMITS[2];
const history = () => arr(readJSON(KEY, [])).filter((x) => isObj(x) && Array.isArray(x.rounds) && x.rounds.length === 3);

/* ====================== home ====================== */

function renderHome() {
  stopAll();
  S = null;
  const lim = limits(prefs.level);
  show(
    h("header", { class: "sum-head" },
      backBtn(t("retell.exit"), exit),
      h("p", { class: "eyebrow" }, t("retell.eyebrow")),
      h("h1", { class: "title" }, t("retell.title"))),
    h("p", { class: "lede" }, t("retell.lede")),
    h("div", { class: "rt-choices grid" },
      choice("speaker", t("retell.story"), t("retell.storyDesc"), startStory),
      choice("mic", t("retell.self"), t("retell.selfDesc"), renderTopics)),
    h("p", { class: "pill" }, t("retell.limits", { level: levelName(prefs.level), a: lim[0], b: lim[1], c: lim[2] })),
    h("section", { class: "stack-sm" }, h("h2", { class: "sec" }, t("retell.recent")), historyList()));
}

function choice(ic, title, desc, fn) {
  return h("button", { type: "button", class: "opt rt-choice", onclick: fn },
    h("span", { class: "rt-choice-ic" }, icon(ic)),
    h("span", { class: "rt-opt-title" }, title),
    h("span", { class: "opt-desc" }, desc));
}

function historyList() {
  const items = history().slice(0, 8);
  if (!items.length) return h("p", { class: "empty" }, t("retell.noHistory"));
  return h("ul", { class: "plain rt-hist" }, items.map((x) => {
    const [a, , b] = x.rounds;
    const name = x.kind === "self" ? t(`retell.topic.${x.topic}`) : str(x.title);
    const bits = [];
    if (a.wpm != null && b.wpm != null) bits.push(t("retell.h.wpm", { a: a.wpm, b: b.wpm }));
    else bits.push(t("retell.h.words", { a: a.words, b: b.words }));
    if (a.pauses != null && b.pauses != null) bits.push(t("retell.h.pauses", { a: a.pauses, b: b.pauses }));
    if (x.total) bits.push(t("retell.h.points", { n: b.points, total: x.total }));
    return h("li", { class: "rt-hist-row" },
      h("span", { class: "rt-hist-title" }, h("span", { lang: x.kind === "story" ? "en" : null }, name), h("span", { class: "hint-line" }, ` \u00b7 ${t(x.kind === "self" ? "retell.h.self" : "retell.h.story")}`)),
      h("span", { class: "hint-line" }, [fmtDate(x.at), ...bits].filter(Boolean).join(" \u00b7 ")));
  }));
}

/* ====================== content ====================== */

function newDrill(kind, content) {
  return { kind, content, level: prefs.level, limits: limits(prefs.level), rounds: [], saved: false };
}

async function startStory() {
  stopAll();
  if (!canGenerate()) {
    S = newDrill("story", { ...pick(STORIES) });
    renderPrep();
    return;
  }
  const g = M.gen;
  const ctl = (M.ctl = new AbortController());
  show(
    head(renderHome, t("retell.storyEyebrow"), t("retell.story")),
    h("div", { class: "loading-card" }, h("p", null, t("retell.writing"), thinkingDots()), h("p", { class: "hint-line" }, t("retell.writingHint"))));
  let story = null, note = "";
  try {
    story = parseStory(await askJSON(storyPrompt(prefs.level, pick(TOPICS)), { signal: ctl.signal }));
    if (!story) note = t("retell.builtInPlain");
  } catch (e) {
    if (!current(g)) return;
    console.warn("retell story", e);
    note = t("retell.builtIn", { err: aiErrorText(e) });
  }
  if (!current(g)) return;
  M.ctl = null;
  if (!story) story = { ...pick(STORIES) };
  S = newDrill("story", story);
  S.note = note;
  renderPrep();
}

function storyPrompt(levelId, topic) {
  const l = levelById(levelId);
  return [
    "Write a short everyday story for an English learner to listen to and then retell from memory.",
    `Learner: level ${l.id} of 5 (about CEFR ${l.cefr}). ${l.guide}`,
    `Topic idea: ${topic}.`,
    "Rules:",
    "- 80 to 120 words, past tense, one simple storyline with a clear beginning, middle and end.",
    "- Natural American English in plain sentences. No dialogue, no lists, no markdown.",
    "- title: 2 to 5 English words.",
    "- points: 4 to 6 key points in story order. Each is a short noun phrase of 1 to 4 words taken from the story.",
    'Reply with only this JSON: {"title": string, "story": string, "points": [string]}',
  ].join("\n");
}

function parseStory(o) {
  if (!isObj(o)) return null;
  const text = str(o.story || o.text).replace(/\s+/g, " ");
  const n = tokens(text).length;
  if (n < 50 || n > 220) return null;
  const said = contentStems(text);
  const points = [...new Set(arr(o.points).map((p) => str(p).replace(/[.,;:!?]+$/, "")))]
    .filter((p) => p && tokens(p).length <= 6 && pointHit(p, said)).slice(0, 6);
  if (points.length < 3) return null;
  return { title: str(o.title).replace(/^["']|["']$/g, "").slice(0, 60) || "A Short Story", text, points };
}

function renderTopics() {
  stopAll();
  show(
    head(renderHome, t("retell.selfEyebrow"), t("retell.pickTitle")),
    h("p", { class: "lede" }, t("retell.pickLede")),
    h("div", { class: "grid rt-topics" }, PROMPTS.map((p) => h("button", { type: "button", class: "opt", onclick: () => startSelf(p) },
      h("span", { class: "rt-opt-title" }, t(`retell.topic.${p.id}`)),
      h("span", { class: "opt-desc", lang: "en" }, p.en)))),
    h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => startSelf(pick(PROMPTS)) }, icon("dice"), t("retell.surprise"))));
}

function startSelf(p) {
  S = newDrill("self", { topic: p.id, title: p.en, text: p.en, points: [] });
  renderPrep();
}

/* ====================== before round 1 ====================== */

function renderPrep() {
  stopAll();
  const c = S.content, story = S.kind === "story";
  const start = h("button", { type: "button", class: "btn primary big", onclick: () => renderRound(0) }, t("retell.startRound", { n: 1, s: S.limits[0] }));
  if (!story) {
    show(
      head(renderTopics, t("retell.selfEyebrow"), t(`retell.topic.${c.topic}`)),
      h("div", { class: "drill-card" },
        h("p", { class: "drill-text small", lang: "en" }, c.text),
        h("div", { class: "row" }, speakBtn(c.text, t("retell.listen"), t("retell.listen"))),
        h("p", { class: "hint-line" }, t("retell.selfHint"))),
      roundPlan(),
      h("div", { class: "actions" }, start));
    return;
  }
  const textEl = h("p", { class: "drill-text para", lang: "en", hidden: true }, c.text);
  const toggle = h("button", { type: "button", class: "mini", "aria-expanded": "false" }, t("retell.showText"));
  toggle.addEventListener("click", () => {
    textEl.hidden = !textEl.hidden;
    toggle.textContent = textEl.hidden ? t("retell.showText") : t("retell.hideText");
    toggle.setAttribute("aria-expanded", String(!textEl.hidden));
  });
  show(
    head(renderHome, t("retell.storyEyebrow"), c.title, true),
    S.note ? h("p", { class: "note-card" }, S.note) : null,
    h("div", { class: "drill-card" },
      h("p", { class: "lede" }, t("retell.listenFirst")),
      h("div", { class: "row" },
        speakBtn(c.text, t("retell.listen"), t("retell.listen")),
        speakBtn(c.text, t("retell.slow"), t("retell.slow"), 0.8),
        toggle),
      textEl,
      h("div", { class: "stack-xs" }, h("p", { class: "mini-label" }, t("retell.points")), chips(c.points)),
      h("p", { class: "hint-line" }, t("retell.planHint"))),
    roundPlan(),
    h("div", { class: "actions" }, start));
}

function roundPlan() {
  return h("p", { class: "pill" }, t("retell.limits", { level: levelName(S.level), a: S.limits[0], b: S.limits[1], c: S.limits[2] }));
}

function chips(points, flags) {
  return h("div", { class: "words" }, points.map((p, k) => {
    const on = flags && flags[k];
    return h("span", { class: "word-chip" + (on ? " used" : ""), lang: "en" }, on ? `\u2713 ${p}` : p);
  }));
}

/* ====================== a round ====================== */

function renderRound(i, preferTyping = false) {
  stopAll();
  const g = M.gen, limit = S.limits[i], story = S.kind === "story";
  const speechReady = canRecognize();
  const ring = ringEl(limit);
  const status = h("p", { class: "hint-line rt-status", "aria-live": "polite" }, t(speechReady ? "retell.ready" : micSupported() ? "retell.noRecognition" : "retell.noMic"));
  const startB = h("button", { type: "button", class: "btn hot big", hidden: !speechReady }, icon("mic"), t("retell.startSpeaking"));
  const doneB = h("button", { type: "button", class: "btn primary big", hidden: true }, icon("check"), t("retell.done"));
  const typed = typeBox((text) => saveRound(i, { text, audio: null, typed: true }));
  typed.hidden = speechReady && !preferTyping;
  const typeB = h("button", { type: "button", class: "btn quiet", hidden: !speechReady }, icon("keyboard"), t("retell.typeInstead"));
  typeB.addEventListener("click", () => {
    if (M.rec) { renderRound(i, true); return; }
    typed.hidden = !typed.hidden;
    if (!typed.hidden) typed.querySelector("textarea").focus();
  });
  const ui = { ring, status, startB, doneB, typed, typeB };
  startB.addEventListener("click", () => record(i, g, ui));
  show(
    head(renderHome, t("retell.round", { n: i + 1 }), t("retell.roundTitle", { s: limit })),
    h("div", { class: "drill-card rt-stage" },
      story ? h("div", { class: "stack-xs" }, h("p", { class: "mini-label" }, t("retell.points")), chips(S.content.points))
        : h("p", { class: "drill-text small", lang: "en" }, S.content.text),
      ring.el,
      status,
      h("div", { class: "actions rt-center" }, startB, doneB, typeB)),
    typed);
}

async function record(i, g, ui) {
  if (!current(g) || M.rec) return;
  if (!canRecognize()) { ui.status.textContent = t("retell.noRecognition"); ui.startB.hidden = true; ui.typed.hidden = false; return; }
  unlockAudio();
  stopSpeaking();
  ui.startB.disabled = true;
  ui.status.textContent = t("retell.preparingMic");
  const rec = startRecorder((v) => { if (current(g)) ui.ring.level(v); });
  // Own cancellation before asking permission; an exit can precede record() resolving.
  M.rec = rec;
  try {
    await rec.start();
  } catch (e) {
    if (!current(g) || M.rec !== rec) return;
    M.rec = null;
    rec.cancel();
    ui.startB.disabled = false;
    ui.status.textContent = micErrorText(e);
    ui.typed.hidden = false;
    return;
  }
  if (!current(g) || M.rec !== rec) return;
  const limit = S.limits[i], t0 = performance.now();
  ui.startB.hidden = true;
  ui.typeB.hidden = true;
  ui.typed.hidden = true;
  ui.doneB.hidden = false;
  ui.ring.el.classList.add("rec");
  ui.status.textContent = t("retell.recording");
  let finishing = false;
  const finish = async () => {
    if (!current(g) || M.rec !== rec || finishing) return;
    finishing = true;
    clearInterval(M.tick);
    M.tick = 0;
    ui.ring.el.classList.remove("rec");
    ui.ring.level(0);
    ui.doneB.hidden = true;
    ui.typeB.hidden = false;
    fill(ui.status, t("retell.recognizing"), thinkingDots());
    let res;
    try { res = await rec.finish(); }
    catch (error) { res = { text: "", audio: null, error }; }
    if (!current(g) || M.rec !== rec) return;
    M.rec = null;
    if (res.text) { saveRound(i, { text: res.text, audio: res.audio, typed: false }); return; }
    if (res.error) console.warn("retell asr", res.error);
    ui.ring.set(limit);
    ui.status.textContent = res.error ? t("retell.asrFailed") : t("retell.heardNothing");
    ui.startB.hidden = false;
    ui.startB.disabled = false;
    ui.typeB.hidden = false;
    if (res.error) ui.typed.hidden = false;
  };
  ui.doneB.onclick = finish;
  M.tick = setInterval(() => {
    if (!current(g)) return;
    if (!ui.ring.el.isConnected) { stopAll(); return; } // the host replaced the screen
    const left = limit - (performance.now() - t0) / 1000;
    ui.ring.set(left);
    if (left <= 0) finish();
  }, 100);
}

function micErrorText(e) {
  const name = e && e.name;
  if (name === "NotAllowedError" || name === "SecurityError") return t("mic.err.denied");
  if (name === "NotFoundError") return t("mic.err.none");
  return t("retell.asrFailed");
}

// Capture short raw segments, then recognize them in sequence. Starting another capture invalidates
// ASoundMic.stop()'s in-flight transcript, so recognition must not race the next recording segment.
function startRecorder(onLevel) {
  const mic = window.ASoundMic;
  const parts = [];
  let frames = 0, quiet = 0, recording = true, closed = false, ownsCapture = false, rolling = null;
  let rejectCancel;
  const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
  cancelled.catch(() => {});
  const aborted = () => Object.assign(new Error("retell recording cancelled"), { code: "cancelled", name: "AbortError" });
  const ensureOpen = () => { if (closed) throw aborted(); };
  const releaseCapture = () => { if (ownsCapture) { ownsCapture = false; mic.cancel(); } };
  const cancel = () => {
    if (closed) return;
    closed = true;
    recording = false;
    rejectCancel(aborted());
    releaseCapture();
  };
  const wait = async (job, ms = 60000) => {
    let timer;
    try {
      return await Promise.race([job, cancelled, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("retell recognition timed out"), { code: "timeout" })), ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  const take = async () => {
    const res = await wait(mic.stop({ raw: true }));
    ensureOpen();
    if (res?.audio?.length) parts.push(res.audio);
  };
  const roll = async () => {
    ensureOpen();
    await take();
    if (!recording) return;
    await wait(mic.record(handlers), 30000);
    ensureOpen();
  };
  const handlers = {
    onLevel(v) { // once per 32 ms frame
      if (closed || !recording) return;
      onLevel(v);
      frames++;
      quiet = v < 0.08 ? quiet + 1 : 0;
      if (!rolling && (frames >= 840 || (frames >= 560 && quiet >= 6))) {
        frames = 0; quiet = 0;
        rolling = roll();
        // Keep rejection observable by finish() without an unhandled promise rejection.
        rolling.then(() => { rolling = null; }, () => { recording = false; releaseCapture(); });
      }
    },
  };
  return {
    async start() {
      try {
        ensureOpen();
        ownsCapture = true;
        await wait(mic.record(handlers), 30000);
        ensureOpen();
      } catch (error) { cancel(); throw error; }
    },
    async finish() {
      try {
        ensureOpen();
        recording = false;
        if (rolling) await rolling;
        await take();
        releaseCapture();
        const text = [];
        for (const audio of parts) {
          ensureOpen();
          if (audio.length >= 0.3 * RATE) text.push(str(await wait(mic.transcribe(audio.slice()))));
        }
        ensureOpen();
        return { text: text.filter(Boolean).join(" "), audio: joinAudio(parts), error: null };
      } finally { cancel(); }
    },
    cancel,
  };
}

function joinAudio(list) {
  const out = new Float32Array(list.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of list) { out.set(a, at); at += a.length; }
  return out;
}

function typeBox(onSubmit) {
  const ta = h("textarea", { rows: "5", lang: "en", spellcheck: "false", placeholder: t("retell.typePlaceholder"), "aria-label": t("retell.typeLabel") });
  const send = h("button", { type: "button", class: "btn primary" }, icon("send"), t("retell.typeSubmit"));
  send.addEventListener("click", () => { const v = str(ta.value); if (v) onSubmit(v); else ta.focus(); });
  return h("div", { class: "card attempt rt-type" }, h("p", { class: "hint-line" }, t("retell.typeHint")), ta, h("div", { class: "row" }, send));
}

// Countdown ring: the arc shrinks with the time left; the halo follows the microphone level.
function ringEl(limit) {
  const C = 2 * Math.PI * 52;
  const el = h("div", { class: "rt-ring", role: "timer" });
  el.innerHTML = '<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="rt-ring-bg" cx="60" cy="60" r="52"/><circle class="rt-ring-fg" cx="60" cy="60" r="52"/></svg>';
  const num = h("b", null, String(limit));
  el.append(h("div", { class: "rt-ring-num" }, num, h("small", null, t("retell.secShort"))));
  const fg = el.querySelector(".rt-ring-fg");
  fg.style.strokeDasharray = String(C);
  fg.style.strokeDashoffset = "0";
  const set = (left) => {
    const l = Math.max(0, Math.min(limit, left));
    fg.style.strokeDashoffset = String(C * (1 - l / limit));
    num.textContent = String(Math.ceil(l));
    el.classList.toggle("low", l <= 10);
    el.setAttribute("aria-label", t("retell.left", { s: Math.ceil(l) }));
  };
  set(limit);
  return { el, set, level: (v) => el.style.setProperty("--lvl", Number(v).toFixed(2)) };
}

/* ====================== measuring ====================== */

function saveRound(i, r) {
  r.m = measure(r, S.content.points);
  S.rounds[i] = r;
  S.rounds.length = i + 1;
  if (i >= 2) renderEnd(); else renderBetween(i);
}

const round1 = (x) => Math.round(x * 10) / 10;

function measure(r, points) {
  const words = tokens(r.text).map(normTok).filter(Boolean).length;
  const f = fillerCount(r.text);
  const cov = points.length ? coverage(points, r.text) : null;
  const m = {
    words, wpm: null, pauses: null, longest: null, start: 0,
    fillers: f.n, filler: f.top, andThen: (r.text.match(/\band then\b/gi) || []).length,
    points: cov ? cov.hit : null, total: points.length, flags: cov ? cov.flags : [], missed: cov ? cov.missed : [],
  };
  if (!r.typed && r.audio && r.audio.length) {
    const p = pauseStats(r.audio);
    m.pauses = p.count;
    m.longest = round1(p.longest);
    m.start = p.start;
    if (p.speak >= 3) m.wpm = Math.round(words / (p.speak / 60));
  }
  return m;
}

// 20 ms frames above an energy threshold are speech; quiet runs longer than 0.4 s between speech are pauses.
// Speaking time runs from the first to the last speech frame.
function pauseStats(audio) {
  const N = RATE / 50, n = Math.floor(audio.length / N);
  const none = { count: 0, longest: 0, speak: 0, start: 0 };
  if (n < 10) return none;
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * N; j < (i + 1) * N; j++) s += audio[j] * audio[j];
    rms[i] = Math.sqrt(s / N);
  }
  const sorted = Float32Array.from(rms).sort();
  const noise = sorted[Math.floor(n * 0.05)], loud = sorted[Math.floor(n * 0.95)];
  const thr = Math.max(0.005, loud * 0.05, Math.min(noise * 3, loud * 0.2));
  const on = Array.from(rms, (v) => v > thr);
  for (let i = 0; i < n;) { // a click shorter than 60 ms is not speech
    if (!on[i]) { i++; continue; }
    let j = i;
    while (j < n && on[j]) j++;
    if (j - i < 3) for (let k = i; k < j; k++) on[k] = false;
    i = j;
  }
  const first = on.indexOf(true), last = on.lastIndexOf(true);
  if (first < 0) return none;
  let count = 0, longest = 0, run = 0;
  for (let i = first; i <= last; i++) {
    if (!on[i]) { run++; continue; }
    if (run) { const s = run / 50; if (s > 0.4) count++; longest = Math.max(longest, s); run = 0; }
  }
  return { count, longest, speak: (last - first + 1) / 50, start: first * N };
}

// [pattern, label]; a null label uses the matched text (um, uh, ...).
const FILLERS = [
  [/\b(?:u+m+|u+h+m*|e+r+m*|h+m+|m{2,}|a+h+)\b/gi, null],
  [/(?<!\b(?:do|did|dont|don't)\s)\byou know\b/gi, "you know"],
  [/(?<!\bwhat\s)\bi mean\b/gi, "I mean"],
  [/(?:^|[,.;!?]\s*)like\b(?!\s+to\b)|\b(?:and|but|so|um|uh|was|were)\s+like\b(?!\s+to\b)|\blike\s*,/gi, "like"],
  [/\bso\s*(?:,|\.{2,}|\u2026)|\bso+\s+(?=(?:um|uh|like)\b)/gi, "so"],
  [/[\u55ef\u5443\u989d]|\u90a3\u4e2a|\u5c31\u662f\u8bf4/g, null],
];
function fillerCount(text) {
  const counts = {};
  let n = 0;
  for (const [re, label] of FILLERS) {
    for (const m of String(text).matchAll(re)) {
      const k = label || m[0].toLowerCase();
      counts[k] = (counts[k] || 0) + 1;
      n++;
    }
  }
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "";
  return { n, top };
}

// Key points: a point counts when its head word, or at least half of its content words, appear (by stem).
const STOP = new Set(("a an the of to in on at for with and or but my his her their our your its this that these those some any " +
  "one from by up into over out about as is was were be been not no very just too it he she they we you i me him them us").split(" "));
function stem(w) {
  for (const suf of ["ies", "ing", "ed", "es", "s", "ly", "e"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length) + (suf === "ies" ? "y" : "");
  }
  return w;
}
const contentStems = (s) => tokens(s).map(normTok).filter((w) => w && !STOP.has(w)).map(stem);
const sameStem = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
function pointHit(point, said) {
  const keys = contentStems(point);
  if (!keys.length) return false;
  const hit = keys.map((k) => said.some((s) => sameStem(k, s)));
  return hit[hit.length - 1] || hit.filter(Boolean).length >= Math.ceil(keys.length / 2);
}
function coverage(points, text) {
  const said = contentStems(text);
  const flags = points.map((p) => pointHit(p, said));
  return { hit: flags.filter(Boolean).length, flags, missed: points.filter((_, k) => !flags[k]) };
}

/* ====================== between rounds ====================== */

function tiles(m) {
  const items = [
    ["retell.m.words", m.words],
    ["retell.m.wpm", m.wpm],
    ["retell.m.pauses", m.pauses],
    ["retell.m.longest", m.longest == null ? null : `${m.longest} s`],
    ["retell.m.fillers", m.fillers],
    m.total ? ["retell.m.points", `${m.points}/${m.total}`] : null,
  ].filter(Boolean);
  return h("div", { class: "rt-tiles" }, items.map(([k, v]) => h("div", { class: "score-tile" },
    h("span", { class: "hint-line" }, t(k)), h("b", null, v == null ? "\u2013" : String(v)))));
}

function renderBetween(i) {
  stopAll();
  const r = S.rounds[i], m = r.m;
  const tipBox = h("div", { class: "stack-sm" });
  show(
    head(renderHome, t("retell.roundDone", { n: i + 1 }), t("retell.betweenTitle")),
    h("div", { class: "card" },
      tiles(m),
      r.typed ? h("p", { class: "hint-line" }, t("retell.typedNote")) : null,
      m.total ? h("div", { class: "stack-xs" }, h("p", { class: "mini-label" }, t("retell.pointsHit", { n: m.points, total: m.total })), chips(S.content.points, m.flags)) : null,
      h("p", { class: "heard" }, t(r.typed ? "retell.youTyped" : "retell.youSaid"), " ", h("span", { lang: "en" }, r.text))),
    tipBox,
    h("div", { class: "rt-next" },
      h("p", null, t("retell.next", { a: S.limits[i], b: S.limits[i + 1] })),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn primary big", onclick: () => renderRound(i + 1) }, t("retell.startRound", { n: i + 2, s: S.limits[i + 1] })),
        h("button", { type: "button", class: "btn quiet", onclick: () => renderRound(i) }, t("retell.redo")))));
  requestTip(i, tipBox);
}

function tipPrompt(r, round) {
  return [
    `An English learner (level ${S.level} of 5) just ${S.kind === "story" ? "retold a short story" : "talked about their own life"} in English. This was round ${round} of 3.`,
    r.typed ? "They typed:" : "Speech recognition wrote down their words (it may contain small recognition errors):",
    `"""${r.text.slice(0, 1200)}"""`,
    "Pick ONE short phrase of 2 to 8 words that they actually said and that sounds clumsy, wordy or unnatural. Copy it exactly.",
    "If nothing sounds clumsy, pick a phrase that could be said in fewer words.",
    "Then give a tighter, more natural way an American would say the same thing.",
    'Reply with only this JSON: {"chunk": string, "better": string, "note": string}',
    `- note: one short sentence in ${helpLangName()} explaining why "better" sounds better.`,
  ].join("\n");
}

function parseTip(o, said) {
  if (!isObj(o)) return null;
  const clean = (s) => str(s).replace(/^["'\u201c]+|["'\u201d]+$/g, "").trim();
  const chunk = clean(o.chunk), better = clean(o.better), note = str(o.note).slice(0, 240);
  const n = tokens(chunk).length, k = tokens(better).length;
  if (!n || n > 14 || !k || k > 24 || looseEqual(chunk, better) || !saidIt(chunk, said)) return null;
  return { chunk, better, note };
}

// The model must quote the learner: the chunk appears in what they said, or nearly all of its words do.
function saidIt(chunk, said) {
  const a = tokens(chunk).map(normTok).filter(Boolean), b = tokens(said).map(normTok).filter(Boolean);
  if (!a.length) return false;
  if (` ${b.join(" ")} `.includes(` ${a.join(" ")} `)) return true;
  const set = new Set(b);
  return a.filter((w) => set.has(w)).length / a.length >= 0.75;
}

function ruleTip(m, last) {
  let note;
  if (m.fillers >= 2) note = t("retell.tip.fillers", { n: m.fillers, word: m.filler });
  else if (m.longest != null && (m.pauses >= 3 || m.longest >= 2)) note = t("retell.tip.pauses", { s: m.longest });
  else if (m.missed.length) note = t("retell.tip.points", { list: m.missed.join(", ") });
  else if (m.andThen >= 3) note = t("retell.tip.andThen", { n: m.andThen });
  else note = t(last ? "retell.tip.end" : "retell.tip.default");
  return { chunk: "", better: "", note, rule: true, last };
}

async function requestTip(i, box) {
  const r = S.rounds[i];
  if (r.tip) { paintTip(box, r); return; }
  if (!canGenerate()) {
    r.tip = ruleTip(r.m, i === 2);
    paintTip(box, r);
    return;
  }
  const g = M.gen;
  const ctl = (M.ctl = new AbortController());
  fill(box, h("p", { class: "hint-line" }, t("retell.tipLoading"), thinkingDots()));
  let tip = null, err = "";
  try {
    tip = parseTip(await askJSON(tipPrompt(r, i + 1), { signal: ctl.signal }), r.text);
  } catch (e) {
    if (!current(g) || (e && e.code === "cancelled")) return;
    console.warn("retell tip", e);
    err = aiErrorText(e);
  }
  if (!current(g)) return;
  M.ctl = null;
  r.tip = tip || ruleTip(r.m, i === 2);
  r.tipErr = err;
  if (box.isConnected) paintTip(box, r, () => { r.tip = null; requestTip(i, box); });
}

function paintTip(box, r, retry) {
  const tip = r.tip;
  if (!tip.rule) { fill(box, phraseCard(tip)); return; }
  fill(box, h("div", { class: "note-card rt-rule" },
    h("p", { class: "mini-label" }, icon("bulb"), t(tip.last ? "retell.tipLast" : "retell.tipRule")),
    h("p", null, tip.note),
    r.tipErr ? h("div", { class: "row" }, h("span", { class: "hint-line" }, t("retell.tipErr", { err: r.tipErr })),
      retry ? h("button", { type: "button", class: "mini", onclick: retry }, t("chat.retry")) : null) : null));
}

function phraseCard(tip) {
  return h("div", { class: "card rt-tip" },
    h("p", { class: "mini-label" }, t("retell.tipTitle")),
    h("p", { class: "pair", lang: "en" }, h("s", null, tip.chunk), " \u2192 ", h("b", null, tip.better)),
    tip.note ? h("p", null, tip.note) : null,
    h("div", { class: "row" },
      speakBtn(tip.better, t("retell.listen")),
      saveBtn({ term: tip.better, meaning: tip.note, source: "talk" })));
}

/* ====================== the end ====================== */

const METRICS = [
  { key: "words", label: "retell.m.words" },
  { key: "wpm", label: "retell.m.wpm", better: "up" },
  { key: "pauses", label: "retell.m.pauses", better: "down" },
  { key: "longest", label: "retell.m.longest", better: "down", unit: " s" },
  { key: "fillers", label: "retell.m.fillers", better: "down" },
  { key: "points", label: "retell.m.points", better: "up", story: true },
];

function renderEnd() {
  stopAll();
  saveHistory();
  const [a, , c] = S.rounds;
  const tipBox = h("div", { class: "stack-sm" });
  const earlier = S.rounds.slice(0, 2).filter((r) => r.tip && !r.tip.rule).map((r) => phraseCard(r.tip));
  show(
    head(renderHome, t("retell.endEyebrow"), t("retell.endTitle")),
    h("div", { class: "card" },
      h("p", { class: "overall" }, verdict(a.m, c.m)),
      extraLine(a.m, c.m),
      bars()),
    a.audio && c.audio && !a.typed && !c.typed ? abCard(a, c) : null,
    h("section", { class: "stack-sm" }, h("h2", { class: "sec" }, t("retell.phrases")), earlier, tipBox),
    h("details", { class: "transcript" }, h("summary", null, t("retell.transcripts")),
      h("ol", { class: "plain" }, S.rounds.map((r, k) => h("li", { class: "tline" }, h("span", { class: "who" }, t("retell.r", { n: k + 1 })), h("span", { lang: "en" }, r.text))))),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary big", onclick: () => { S = newDrill(S.kind, S.content); renderPrep(); } }, t("retell.again")),
      h("button", { type: "button", class: "btn", onclick: renderHome }, t("retell.newContent")),
      h("button", { type: "button", class: "btn quiet", onclick: exit }, t("retell.finish"))));
  requestTip(2, tipBox);
}

function verdict(a, b) {
  if (a.wpm == null || b.wpm == null || a.pauses == null || b.pauses == null) return t("retell.v.noTiming");
  const pct = Math.round((b.wpm / a.wpm - 1) * 100);
  const speed = Math.abs(pct) < 5 ? t("retell.v.same") : pct > 0 ? t("retell.v.faster", { pct }) : t("retell.v.slower", { pct: -pct });
  const p1 = a.pauses, p3 = b.pauses;
  let pause;
  if (!p1 && !p3) pause = t("retell.v.pNone");
  else if (p3 === 0) pause = t("retell.v.pGone");
  else if (p3 < p1) { const r = p3 / p1; pause = r >= 0.4 && r <= 0.6 ? t("retell.v.pHalf") : t("retell.v.pFewer", { pct: Math.round((1 - r) * 100) }); }
  else if (p3 === p1) pause = t("retell.v.pSame");
  else pause = t("retell.v.pMore");
  return t("retell.v.line", { speed, pause });
}

function extraLine(a, b) {
  const bits = [t("retell.v.fillers", { a: a.fillers, b: b.fillers })];
  if (b.total) bits.push(t("retell.v.points", { n: b.points, total: b.total }));
  return h("p", { class: "hint-line" }, bits.join(" \u00b7 "));
}

function bars() {
  const story = S.kind === "story";
  return h("div", { class: "rt-bars" }, METRICS.filter((d) => (!d.story || story) && S.rounds.some((r) => r.m[d.key] != null)).map((d) => {
    const vals = S.rounds.map((r) => r.m[d.key]);
    const max = d.key === "points" ? S.content.points.length || 1 : Math.max(0.001, ...vals.filter((v) => v != null));
    return h("div", { class: "rt-metric" },
      h("p", { class: "mini-label" }, t(d.label)),
      h("div", { class: "rt-cols" }, vals.map((v, k) => {
        const bar = h("i");
        bar.style.height = v == null ? "0" : `${Math.max(3, Math.round((100 * v) / max))}%`;
        return h("div", { class: "rt-col" + (k === 2 ? " last" : "") },
          h("b", null, v == null ? "\u2013" : `${v}${d.unit || ""}`),
          h("span", { class: "rt-track" }, bar),
          h("small", null, t("retell.r", { n: k + 1 })));
      })),
      d.better ? h("p", { class: "hint-line" }, t(d.better === "up" ? "retell.higher" : "retell.lower")) : null);
  }));
}

function saveHistory() {
  if (S.saved) return;
  S.saved = true;
  const rounds = S.rounds.map(({ m, typed }) => ({ words: m.words, wpm: m.wpm, pauses: m.pauses, longest: m.longest, fillers: m.fillers, points: m.points, typed: !!typed }));
  const item = { at: Date.now(), kind: S.kind, title: S.content.title, topic: S.content.topic || "", level: S.level, limits: S.limits, total: S.content.points.length, rounds };
  writeJSON(KEY, [item, ...history()].slice(0, 20));
}

/* A/B: the first 10 seconds of round 1 and round 3, from where the speech starts, at matched loudness. */
function abCard(a, c) {
  return h("div", { class: "card" },
    h("h2", { class: "sec" }, icon("wave"), t("retell.abTitle")),
    h("p", { class: "lede" }, t("retell.abLede")),
    h("div", { class: "row" }, clipBtn(a, t("retell.ab1")), clipBtn(c, t("retell.ab3"))));
}

function clipBtn(r, label) {
  const b = h("button", { type: "button", class: "btn" }, icon("speaker"), label);
  b.addEventListener("click", () => {
    if (M.clip && M.clip.btn === b) { stopClip(); return; }
    playClip(r, b, label);
  });
  return b;
}

function playClip(r, btn, label) {
  stopClip();
  stopSpeaking();
  unlockAudio();
  const ctx = audioContext();
  if (!ctx) return;
  const from = Math.max(0, (r.m.start || 0) - Math.round(0.15 * RATE));
  const seg = r.audio.subarray(from, from + 10 * RATE);
  if (!seg.length) return;
  let peak = 0;
  for (let i = 0; i < seg.length; i++) peak = Math.max(peak, Math.abs(seg[i]));
  const buf = ctx.createBuffer(1, seg.length, RATE);
  buf.copyToChannel(seg, 0);
  const gain = ctx.createGain();
  gain.gain.value = peak > 0.001 ? Math.min(6, 0.8 / peak) : 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(gain).connect(ctx.destination);
  src.onended = () => { if (M && M.clip && M.clip.src === src) stopClip(); };
  src.start();
  M.clip = { src, btn, label };
  btn.classList.add("on");
  btn.replaceChildren(icon("stop"), label);
}

function stopClip() {
  const c = M && M.clip;
  if (!c) return;
  M.clip = null;
  try { c.src.onended = null; c.src.stop(); } catch {}
  c.btn.classList.remove("on");
  c.btn.replaceChildren(icon("speaker"), c.label);
}
