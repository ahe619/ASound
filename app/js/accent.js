// American accent training: shadowing drills by sound, and an accent check that rolls a fresh paragraph,
// listens to the learner read it, and reports which sounds were unclear.
import { prefs, savePrefs, DRILLS, drillById, levelById, PASSAGES, TOPICS } from "./state.js";
import { $, h, fill, icon, str, isObj, arr, pick, toast, thinkingDots, meter, fmtIpa } from "./util.js";
import { t, getLanguage } from "./i18n.js";
import { askJSON, aiErrorText } from "./ai.js";
import * as P from "./prompts.js";
import { readingMatch } from "./diff.js";
import { speakBtn, stopSpeaking, unlockAudio } from "./speech.js";
import { micButton } from "./mic.js";
import { checks, drillStore } from "./store.js";
import { saveBtn, fmtDate, levelName } from "./widgets.js";
import { modeCards } from "./modes.js";
import { DRILL_BANK } from "./drill-bank.js";

let view = "home";        // home | drill | check
let drill = null;         // {drillId, level, items, idx}
let check = null;         // {text, meaning, attempt}

const root = () => $("#accent");
const scrollTop = () => { $("#view-accent").scrollTop = 0; };

export function renderAccent() {
  if (view === "drill" && drill) renderDrill();
  else if (view === "check" && check) renderCheck();
  else renderHome();
}

export function initAccent() {
  const saved = drillStore.get();
  if (isObj(saved) && Array.isArray(saved.items) && saved.items.length && Number.isInteger(saved.idx)) { drill = saved; view = "drill"; }
}

/* ---------- home ---------- */

function renderHome() {
  view = "home";
  const zh = getLanguage() !== "en"; // show the localized name under the English one
  const grid = h("div", { class: "grid", role: "group", "aria-label": t("accent.drills") }, DRILLS.map((d) => h("button", {
    type: "button", class: "opt", "aria-pressed": String(prefs.drill === d.id),
    onclick: () => { prefs.drill = d.id; savePrefs(); renderHome(); },
  }, h("span", { class: "opt-en", lang: "en" }, t(`drill.${d.id}.en`)), zh ? h("span", { class: "opt-zh" }, t(`drill.${d.id}.name`)) : null, h("span", { class: "opt-desc" }, t(`drill.${d.id}.desc`)))));
  const history = checks.all().slice(0, 12).reverse();
  fill(root(),
    h("section", { class: "stack-xs" }, h("h1", { class: "title" }, t("accent.title")), h("p", { class: "lede" }, t("accent.lede"))),
    h("div", { class: "card" },
      h("h2", { class: "sec" }, icon("dice"), t("check.title")),
      h("p", { class: "lede" }, t("check.lede")),
      history.length ? h("div", { class: "stack-xs" },
        h("span", { class: "mini-label" }, t("check.trend")),
        h("div", { class: "trend", "aria-label": t("check.trend") }, history.map((c) => { const bar = h("i", { title: `${fmtDate(c.at)} \u00b7 ${c.score}%` }); bar.style.height = `${Math.max(4, c.score)}%`; return bar; })),
        h("span", { class: "hint-line" }, t("check.last", { score: history[history.length - 1].score }))) : null,
      h("div", { class: "row" }, h("button", { type: "button", class: "btn hot big", id: "check-start", onclick: startCheck }, icon("dice"), t("check.roll")))),
    h("section", { class: "stack-sm" },
      h("h2", { class: "sec" }, t("accent.drills")),
      grid,
      h("div", { class: "start-row" },
        h("p", { class: "lede" }, t("accent.levelNote", { level: levelName(prefs.level) })),
        h("button", { type: "button", class: "btn primary big", id: "drill-start", onclick: startDrill }, t("accent.start")))),
    modeCards("accent"),
    h("p", { class: "note-card" }, t("accent.howNote")));
}

/* ---------- drills ---------- */

// A drill starts at once with hand-written sentences; sentences the local model writes for the learner's level
// are added behind them when they arrive (on a phone that can take a while), so nobody waits on a spinner.
let drillCtl = null;
function bankItems(d, count, skip = new Set()) {
  return [...(DRILL_BANK[d.id] || [])].filter((s) => !skip.has(s.toLowerCase())).sort(() => Math.random() - 0.5)
    .slice(0, count).map((text) => ({ text, meaning: "", sounds: "", ipa: "", tips: [], attempt: null }));
}

function startDrill() {
  unlockAudio();
  stopSpeaking();
  const d = drillById(prefs.drill), level = prefs.level;
  if (drillCtl) drillCtl.abort();
  const items = bankItems(d, 3);
  if (!items.length) { toast(aiErrorText({ code: "invalid_json" })); renderHome(); return; }
  const mine = { drillId: d.id, level, items, idx: 0 };
  drill = mine;
  drillStore.set(drill);
  view = "drill";
  renderDrill();
  scrollTop();
  const ctl = new AbortController();
  drillCtl = ctl;
  askJSON(P.drillPrompt(d, level), { cache: false, signal: ctl.signal }).then((raw) => {
    if (drill !== mine || ctl.signal.aborted) return;
    // Keep real sentences only: not the prompt's own example, 5 to 20 words, not already in the drill.
    const words = (x) => x.split(/\s+/).filter(Boolean).length;
    const have = new Set(mine.items.map((x) => x.text.toLowerCase()));
    const extra = arr(raw && raw.sentences).filter(isObj).map((x) => ({
      text: str(x.text), meaning: str(x.meaning), sounds: str(x.sounds), ipa: str(x.ipa),
      tips: arr(x.tips).filter(isObj).map((tp) => ({ part: str(tp.part), tip: str(tp.tip) })).filter((tp) => tp.tip).slice(0, 3),
      attempt: null,
    })).filter((x) => {
      const key = x.text.toLowerCase();
      // drop copies of the prompt's own wording (the small models echo the example lists), and repeats
      const copied = /gonna grab a cup/i.test(x.text) || d.focus.toLowerCase().includes(key.replace(/[.!?]+$/, ""));
      if (!x.text || copied || words(x.text) < 5 || words(x.text) > 20 || have.has(key)) return false;
      have.add(key);
      return true;
    }).slice(0, 5);
    // Too few from the model (common with the small ones): top up from the bank so a drill has about five.
    const more = extra.length >= 2 ? extra : [...extra, ...bankItems(d, 2 - extra.length, new Set([...have, ...extra.map((x) => x.text.toLowerCase())]))];
    grow(mine, more);
  }).catch((e) => {
    if (!(e && e.code === "cancelled")) console.warn("drill sentences", e);
    // Failed, or stopped so the model could explain a reading (see analyze): finish the drill from the bank.
    if (drill === mine && (!ctl.signal.aborted || ctl.signal.reason === "yield")) grow(mine, bankItems(d, 2, new Set(mine.items.map((x) => x.text.toLowerCase()))));
  }).finally(() => { if (drillCtl === ctl) drillCtl = null; });
}

// New sentences arrived: update the count and, if the learner is on what was the last one, turn "More" into "Next".
function grow(mine, more) {
  mine.items.push(...more);
  drillStore.set(mine);
  if (view !== "drill" || drill !== mine) return;
  const progress = root().querySelector(".drill-card .progress"), nav = root().querySelector(".drill-nav");
  if (progress) progress.textContent = t("accent.progress", { n: mine.idx + 1, total: mine.items.length });
  if (nav) nav.replaceWith(drillNav());
}

function leaveDrill() {
  stopSpeaking();
  if (drillCtl) { drillCtl.abort(); drillCtl = null; }
  drill = null;
  drillStore.clear();
  renderHome();
  scrollTop();
}

function moveDrill(step) {
  stopSpeaking();
  drill.idx = Math.min(drill.items.length - 1, Math.max(0, drill.idx + step));
  drillStore.set(drill);
  renderDrill();
  scrollTop();
}

function renderDrill() {
  const d = drillById(drill.drillId), it = drill.items[drill.idx];
  const result = h("div", { class: "stack-sm" });
  if (it.attempt) paintAttempt(result, it.text, it.attempt, () => drillStore.set(drill));
  const ipaLine = it.ipa ? h("p", { class: "ipa-line", hidden: !prefs.showIpa }, fmtIpa(it.ipa)) : null;
  const ipaBtn = it.ipa ? h("button", { type: "button", class: "mini" }, prefs.showIpa ? t("accent.hideIpa") : t("accent.showIpa")) : null;
  if (ipaBtn) ipaBtn.addEventListener("click", () => {
    prefs.showIpa = !prefs.showIpa;
    savePrefs();
    ipaLine.hidden = !prefs.showIpa;
    ipaBtn.textContent = prefs.showIpa ? t("accent.hideIpa") : t("accent.showIpa");
  });
  fill(root(),
    h("header", { class: "sum-head" },
      h("button", { type: "button", class: "btn quiet back", onclick: leaveDrill }, icon("back"), t("accent.change")),
      h("p", { class: "eyebrow" }, t("accent.eyebrow", { name: t(`drill.${d.id}.name`) })),
      h("h1", { class: "sum-title", lang: "en" }, t(`drill.${d.id}.en`))),
    h("div", { class: "drill-card" },
      h("p", { class: "progress" }, t("accent.progress", { n: drill.idx + 1, total: drill.items.length })),
      h("p", { class: "drill-text", lang: "en" }, it.text),
      it.meaning ? h("p", { class: "drill-native" }, it.meaning) : null,
      h("div", { class: "row" },
        speakBtn(it.text, t("accent.listen"), t("accent.listen")),
        speakBtn(it.text, t("speech.slow"), t("speech.slowShort"), 0.7),
        ipaBtn,
        saveBtn({ term: it.text, meaning: it.meaning, source: "accent" })),
      ipaLine,
      it.sounds ? h("div", { class: "stack-xs" }, h("p", { class: "mini-label" }, t("accent.soundsLike")), h("p", { class: "sounds", lang: "en" }, it.sounds.replace(/_/g, "\u203f"))) : null,
      it.tips.length ? h("div", { class: "stack-xs" }, h("p", { class: "mini-label" }, t("accent.tips")),
        h("ul", { class: "tips" }, it.tips.map((tp) => h("li", null, tp.part ? h("span", { class: "term", lang: "en" }, tp.part) : null, h("span", null, tp.tip))))) : null,
      h("div", { class: "stack-xs" },
        h("span", { class: "mini-label" }, t("accent.yourTurn")),
        h("div", { class: "attempt-row" },
          micButton({ big: true, label: t("accent.record"), onText: (heard) => { it.attempt = { heard, analysis: null }; drillStore.set(drill); paintAttempt(result, it.text, it.attempt, () => drillStore.set(drill)); } }),
          h("span", { class: "hint-line" }, t("accent.recordHint")))),
      result),
    drillNav());
}

function drillNav() {
  return h("div", { class: "drill-nav" },
    h("button", { type: "button", class: "btn", disabled: drill.idx === 0, onclick: () => moveDrill(-1) }, t("accent.prev")),
    drill.idx < drill.items.length - 1
      ? h("button", { type: "button", class: "btn primary", onclick: () => moveDrill(1) }, t("accent.next"))
      : h("button", { type: "button", class: "btn primary", onclick: startDrill }, t("accent.more")));
}

// Score one reading of `target`; if words were missed, ask the model why.
function paintAttempt(box, target, attempt, persist) {
  const m = readingMatch(target, attempt.heard);
  const band = m.score >= 90 ? "high" : m.score >= 60 ? "mid" : "low";
  const verdict = m.hit === m.total ? t("accent.perfect") : m.score >= 80 ? t("accent.close") : t("accent.retry");
  const an = h("div", { class: "stack-xs" });
  fill(box,
    h("div", { class: "score " + band }, h("span", null, t("say.score", { hit: m.hit, total: m.total })), meter(m.score / 100), h("span", null, m.score + "%")),
    h("p", null, verdict),
    m.hit < m.total ? h("p", { class: "drill-text small", lang: "en" }, m.frag) : null,
    h("p", { class: "heard" }, t("say.heard"), " ", h("span", { lang: "en" }, attempt.heard)),
    an);
  if (attempt.analysis) paintAnalysis(an, attempt.analysis);
  else if (m.hit < m.total) analyze(an, target, attempt, persist);
}

async function analyze(box, target, attempt, persist) {
  fill(box, h("p", { class: "hint-line" }, t("accent.analyzing"), thinkingDots()));
  // The model runs one request at a time: the learner is waiting on this, not on extra drill sentences.
  if (drillCtl) drillCtl.abort("yield");
  try {
    const o = await askJSON(P.analyzePrompt(target, attempt.heard));
    attempt.analysis = {
      points: arr(o && o.points).filter(isObj).map((p) => ({ word: str(p.word), heard: str(p.heard), fix: str(p.fix || p.zh) })).filter((p) => p.fix).slice(0, 4),
      encourage: str(o && o.encourage),
    };
    persist && persist();
    if (box.isConnected) paintAnalysis(box, attempt.analysis);
  } catch (e) {
    if (box.isConnected) fill(box, h("p", { class: "hint-line" }, aiErrorText(e)), h("button", { type: "button", class: "mini", onclick: () => analyze(box, target, attempt, persist) }, t("chat.retry")));
  }
}
function paintAnalysis(box, an) {
  fill(box,
    h("p", { class: "mini-label" }, t("accent.problems")),
    an.points.length ? h("ul", { class: "tips" }, an.points.map((p) => h("li", null,
      p.word ? h("span", { class: "term", lang: "en" }, p.word) : null,
      p.heard ? h("span", { class: "hint-line" }, t("accent.heardAs", { heard: p.heard })) : null,
      h("span", null, p.fix)))) : null,
    an.encourage ? h("p", { class: "fb-praise" }, an.encourage) : null);
}

/* ---------- accent check (random paragraph) ---------- */

async function startCheck() {
  unlockAudio();
  stopSpeaking();
  const topic = pick(TOPICS);
  fill(root(), h("div", { class: "loading-card" }, h("p", null, t("check.rolling", { topic }), thinkingDots())));
  scrollTop();
  let text = "", meaning = "";
  try {
    const o = await askJSON(P.passagePrompt(prefs.level, topic), { cache: false });
    text = str(o && o.text);
    meaning = str(o && o.meaning);
  } catch (e) { console.warn(e); }
  if (text.split(/\s+/).length < 25) { text = pick(PASSAGES); meaning = ""; }
  check = { topic, text, meaning, attempt: null, saved: false };
  view = "check";
  renderCheck();
}

function renderCheck() {
  const result = h("div", { class: "stack-sm" });
  if (check.attempt) paintCheckResult(result);
  fill(root(),
    h("header", { class: "sum-head" },
      h("button", { type: "button", class: "btn quiet back", onclick: () => { stopSpeaking(); check = null; renderHome(); scrollTop(); } }, icon("back"), t("accent.backHome")),
      h("p", { class: "eyebrow" }, t("check.eyebrow")),
      h("h1", { class: "sum-title" }, t("check.readThis"))),
    h("div", { class: "drill-card" },
      h("p", { class: "drill-text para", lang: "en" }, check.text),
      check.meaning ? h("details", null, h("summary", { class: "hint-line" }, t("check.showMeaning")), h("p", { class: "drill-native" }, check.meaning)) : null,
      h("div", { class: "row" },
        speakBtn(check.text, t("accent.listen"), t("check.listenFirst")),
        speakBtn(check.text, t("speech.slow"), t("speech.slowShort"), 0.75)),
      h("div", { class: "attempt-row" },
        micButton({ big: true, label: t("check.record"), onText: (heard) => { check.attempt = { heard, report: null }; check.saved = false; paintCheckResult(result); } }),
        h("span", { class: "hint-line" }, t("check.recordHint"))),
      result),
    h("div", { class: "drill-nav" },
      h("button", { type: "button", class: "btn", onclick: () => { check.attempt = null; renderCheck(); } }, t("check.again")),
      h("button", { type: "button", class: "btn primary", onclick: startCheck }, icon("dice"), t("check.newOne"))));
}

function paintCheckResult(box) {
  const a = check.attempt;
  const m = readingMatch(check.text, a.heard);
  const band = m.score >= 90 ? "high" : m.score >= 70 ? "mid" : "low";
  const reportBox = h("div", { class: "stack-sm" });
  fill(box,
    h("div", { class: "score " + band }, h("span", null, t("check.score")), meter(m.score / 100), h("b", null, m.score + "%")),
    h("p", { class: "hint-line" }, t("say.score", { hit: m.hit, total: m.total })),
    h("p", { class: "hint-line" }, t("check.scoreNote")),
    m.hit < m.total ? h("p", { class: "drill-text small", lang: "en" }, m.frag) : h("p", { class: "fb-praise" }, t("say.perfect")),
    h("p", { class: "heard" }, t("say.heard"), " ", h("span", { lang: "en" }, a.heard)),
    reportBox);
  if (!check.saved) {
    checks.add({ at: Date.now(), score: m.score, missed: m.missed.slice(0, 20), level: prefs.level });
    check.saved = true;
  }
  if (a.report) paintReport(reportBox, a.report);
  else if (m.missed.length) requestReport(reportBox, m.missed); // nothing missed: nothing to diagnose
}

// Which drills fit the words the recognizer missed, by spelling alone (used when the model's report fails).
function guessDrills(missed) {
  const found = [];
  const add = (id) => { if (!found.includes(id)) found.push(id); };
  for (const raw of missed) {
    const w = String(raw).toLowerCase();
    if (/th/.test(w)) add("th");
    if (/[aeiou][td]+(er|y|le|ing|ed|a|o)\b/.test(w)) add("flap");
    if (/[aeiou]r/.test(w)) add("r");
    if (/(l|ed|ld|lt)$/.test(w)) add("l");
  }
  return found.slice(0, 2);
}

async function requestReport(box, missed) {
  const a = check.attempt;
  fill(box, h("p", { class: "hint-line" }, t("check.diagnosing"), thinkingDots()));
  try {
    const o = await askJSON(P.assessPrompt(check.text, a.heard, missed));
    a.report = {
      summary: str(o && o.summary),
      problems: arr(o && o.problems).filter(isObj).map((p) => ({ sound: str(p.sound), words: arr(p.words).map(str).filter(Boolean).slice(0, 6), tip: str(p.tip) })).filter((p) => p.tip).slice(0, 3),
      drills: arr(o && o.drills).map(str).filter((id) => DRILLS.some((d) => d.id === id)).slice(0, 2),
      encourage: str(o && o.encourage),
    };
    if (box.isConnected) paintReport(box, a.report);
  } catch (e) {
    if (e && e.code === "cancelled") return;
    // No usable report (small models often fail here): point to drills for the missed words instead of an error.
    a.report = { summary: t("check.fallback"), problems: [], drills: guessDrills(missed), encourage: "" };
    if (box.isConnected) paintReport(box, a.report);
  }
}

function paintReport(box, r) {
  fill(box,
    r.summary ? h("p", { class: "overall" }, r.summary) : null,
    r.problems.length ? h("div", { class: "stack-xs" }, h("p", { class: "mini-label" }, t("accent.problems")),
      h("ul", { class: "tips" }, r.problems.map((p) => h("li", null,
        h("span", { class: "tag tag-pronunciation" }, p.sound || "?"),
        p.words.length ? h("span", { lang: "en" }, p.words.join(", ")) : null,
        h("span", null, p.tip))))) : null,
    r.drills.length ? h("div", { class: "row" }, h("span", { class: "hint-line" }, t("check.tryDrills")),
      r.drills.map((id) => h("button", { type: "button", class: "mini", onclick: () => { prefs.drill = id; savePrefs(); check = null; startDrill(); } }, t(`drill.${id}.name`)))) : null,
    r.encourage ? h("p", { class: "fb-praise" }, r.encourage) : null);
}

export { levelById };
