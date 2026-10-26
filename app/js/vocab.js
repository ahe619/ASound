// The vocabulary book: everything the learner saved, searchable, with audio, plus spoken review:
// see the meaning, say the English out loud, then rate yourself (spaced repetition, Leitner boxes).
import { $, h, fill, icon, str, fmtIpa, meter } from "./util.js";
import { t } from "./i18n.js";
import { vocab } from "./store.js";
import { speakBtn, speak, unlockAudio, stopSpeaking } from "./speech.js";
import { micButton } from "./mic.js";
import { readingMatch } from "./diff.js";
import { confirmInline, fmtDay } from "./widgets.js";
import { renderWordStudy, cleanupWordStudy, isWordStudyActive } from "./word-study.js";

const DAY = 24 * 60 * 60 * 1000;
const INTERVALS = [0, 1 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY]; // by box 0..5
let query = "";
let review = null; // {ids, idx, revealed, heard}
let section = "study";

function sections() {
  return h("nav", { class: "seg", "aria-label": t("vocab.sections") }, ["study", "saved"].map(id =>
    h("button", { type: "button", "aria-pressed": String(section === id), onclick: () => {
      if (section === id) return;
      cleanupVocab();
      review = null;
      section = id;
      renderVocab();
    } }, t(`vocab.section.${id}`))));
}

export function cleanupVocab() {
  cleanupWordStudy();
  stopSpeaking();
  window.ASoundMic?.cancel?.();
}

export const isVocabPracticing = () => Boolean(review) || isWordStudyActive();

export function renderVocab() {
  if (section === "study") {
    const root = h("section", { class: "stack-sm", id: "word-study" });
    fill($("#vocab"), sections(), root);
    renderWordStudy(root);
    return;
  }
  if (review) { renderReview(); return; }
  const all = vocab.all();
  const due = vocab.due();
  const q = query.toLowerCase();
  const list = q ? all.filter((v) => [v.term, v.meaning, v.example].map(str).join(" ").toLowerCase().includes(q)) : all;
  const search = h("input", { type: "search", class: "search", id: "vocab-search", placeholder: t("vocab.search"), "aria-label": t("vocab.search") });
  search.value = query;
  search.addEventListener("input", () => {
    query = search.value;
    const pos = search.selectionStart;
    renderVocab();
    const again = $("#vocab-search");
    again.focus();
    try { again.setSelectionRange(pos, pos); } catch {}
  });
  fill($("#vocab"),
    sections(),
    h("div", { class: "vocab-head" }, h("h1", { class: "title" }, t("vocab.title")), h("span", { class: "pill" }, t("vocab.count", { n: all.length }))),
    h("p", { class: "lede" }, t("vocab.note")),
    all.length ? h("div", { class: "card review-card" },
      h("div", { class: "row" },
        h("div", { class: "stack-xs", style: "flex:1;min-width:200px" }, h("strong", null, due.length ? t("review.due", { n: due.length }) : t("review.none")), h("span", { class: "hint-line" }, t("review.how"))),
        h("button", { type: "button", class: "btn hot", disabled: !due.length, onclick: startReview }, icon("mic"), t("review.start")))) : null,
    search,
    list.length
      ? h("ol", { class: "vocab-list" }, list.map(item))
      : h("div", { class: "empty" }, all.length ? t("vocab.noMatch") : t("vocab.empty")));
}

function item(v) {
  const del = h("button", { type: "button", class: "icon-btn sm", "aria-label": t("common.delete"), title: t("common.delete") }, icon("trash"));
  del.addEventListener("click", () => confirmInline(del, () => { vocab.remove(v.id); renderVocab(); }));
  const box = Number(v.box) || 0;
  const used = Array.isArray(v.used) ? v.used.length : 0;
  return h("li", { class: "word" },
    h("div", { class: "word-top" }, h("span", { class: "term", lang: "en" }, str(v.term)), v.ipa ? h("span", { class: "ipa" }, fmtIpa(v.ipa)) : null, speakBtn(str(v.term), t("chat.read"))),
    v.meaning ? h("p", { class: "expr-native" }, str(v.meaning)) : null,
    v.example ? h("p", { class: "ex", lang: "en" }, str(v.example), " ", speakBtn(str(v.example), t("vocab.readExample"))) : null,
    h("div", { class: "word-meta" },
      h("span", null, [v.source ? t(`vocab.source.${v.source}`) : "", v.createdAt ? fmtDay(v.createdAt) : "", box ? t("review.box", { n: box }) : "", used >= 3 ? t("vocab.owned") : used ? t("vocab.used", { n: used }) : ""].filter(Boolean).join(" \u00b7 ")),
      del));
}

/* ---------- spoken review ---------- */

function startReview() {
  unlockAudio();
  const ids = vocab.due().sort(() => Math.random() - 0.5).slice(0, 20).map((v) => v.id);
  if (!ids.length) return;
  review = { ids, idx: 0, revealed: false, heard: "", done: 0 };
  renderReview();
}

function current() {
  const id = review.ids[review.idx];
  return vocab.all().find((v) => v.id === id);
}

function renderReview() {
  const v = current();
  if (!v) { finishReview(); return; }
  const check = h("div", { class: "say-check" });
  const reveal = () => { review.revealed = true; renderReview(); };
  const front = v.meaning ? v.meaning : t("review.listenFront");
  const mic = micButton({ big: true, label: t("review.sayIt"), onText: (heard) => { review.heard = heard; review.revealed = true; renderReview(); } });
  const parts = [
    h("header", { class: "sum-head" },
      h("button", { type: "button", class: "btn quiet back", onclick: () => { review = null; renderVocab(); } }, icon("back"), t("review.stop")),
      h("p", { class: "eyebrow" }, t("review.eyebrow")),
      h("p", { class: "progress" }, t("review.progress", { n: review.idx + 1, total: review.ids.length }))),
  ];
  const card = h("div", { class: "drill-card" });
  if (!review.revealed) {
    fill(card,
      h("p", { class: "mini-label" }, t("review.prompt")),
      h("p", { class: "drill-text" }, front),
      v.meaning ? null : speakBtn(str(v.term), t("accent.listen"), t("accent.listen")),
      h("div", { class: "attempt-row" }, mic, h("span", { class: "hint-line" }, t("review.sayHint"))),
      h("button", { type: "button", class: "btn quiet", onclick: reveal }, t("review.show")));
  } else {
    const kids = [
      h("p", { class: "drill-native" }, front),
      h("div", { class: "word-top" }, h("span", { class: "term", lang: "en" }, str(v.term)), v.ipa ? h("span", { class: "ipa" }, fmtIpa(v.ipa)) : null, speakBtn(str(v.term), t("chat.read"))),
      v.example ? h("p", { class: "ex", lang: "en" }, str(v.example)) : null,
    ];
    if (review.heard) {
      const m = readingMatch(str(v.term), review.heard);
      const band = m.score >= 80 ? "high" : m.score >= 50 ? "mid" : "low";
      kids.push(h("div", { class: "score " + band }, h("span", null, t("review.match")), meter(m.score / 100), h("span", null, m.score + "%")));
      kids.push(h("p", { class: "heard" }, t("say.heard"), " ", h("span", { lang: "en" }, review.heard)));
    }
    kids.push(h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => grade(v, "good") }, t("review.good")),
      h("button", { type: "button", class: "btn", onclick: () => grade(v, "hard") }, t("review.hard")),
      h("button", { type: "button", class: "btn", onclick: () => grade(v, "again") }, t("review.again"))));
    fill(card, kids, check);
    speak(str(v.term), null);
  }
  fill($("#vocab"), parts, card);
}

function grade(v, how) {
  const box = Number(v.box) || 0;
  const now = Date.now();
  let next = box;
  let due = now;
  if (how === "good") { next = Math.min(5, box + 1); due = now + INTERVALS[next]; }
  else if (how === "hard") { next = Math.max(1, box); due = now + DAY; }
  else { next = 0; due = now + 10 * 60 * 1000; }
  vocab.update(v.id, { box: next, due, reviewedAt: now });
  review.done++;
  review.idx++;
  review.revealed = false;
  review.heard = "";
  if (review.idx >= review.ids.length) finishReview(); else renderReview();
}

function finishReview() {
  const n = review ? review.done : 0;
  review = null;
  renderVocab();
  if (n) {
    const banner = h("p", { class: "note-card" }, t("review.finished", { n }));
    $("#vocab").prepend(banner);
  }
}

export function paintVocabCount() {
  const n = vocab.all().length;
  const el = $("#vocab-count");
  el.hidden = !n;
  el.textContent = String(n);
}
