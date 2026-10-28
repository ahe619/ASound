// Local word study: optional interests/situations, sourced exam decks, and saved recall progress.
import { h, fill, icon, fmtIpa, str, toast } from "./util.js";
import { t, addStrings, getLanguage } from "./i18n.js";
import { speakBtn, stopSpeaking, speak, audioContext, prefetchSpeech } from "./speech.js";
import { micButton, cancelMicButton } from "./mic.js";
import { vocab } from "./store.js";
import { createWordIllustration, warmPictures, preparePictures, hasPicture } from "./word-illustrations.js";
import { currentRoute, navigate, goBack, registerTabDetail, restoreNavigationScroll, isNewNavigationVisit } from "./nav.js";
import {
  TOPICS, SCENARIOS, loadWordBank, normalizeOptions, filterWords, chooseWords,
  gradeProgress, readStudyState, commitStudyState, PRACTICES, meaningChoices, spellingCorrect, answerProgress, sayCorrect,
  isAlternativeSpelling, isAlternativeSaying, spellingClue, MAX_SPOKEN_RESPONSE_LENGTH, STUDY_STATE_KEY, mergeProgress,
} from "./word-study-core.js";

const DECKS = ["general", "cet4", "cet6", "kaoyan"];
const RATINGS = ["good", "hard", "again"];
let assetsPromise = null;
let stylePromise = null;
let host = null;
let generation = 0;
let paintVersion = 0;
let bank = null;
let wordsById = new Map();
let saved = null;
let showingSetup = false;
let storageFailed = false;
let resumeDiscarded = false;
let reviewPending = false;
function pendingAnswer() {
  reviewPending = true;
  const controls = [...host.querySelectorAll(".ws-option, .ws-grade, .ws-spelling-input, .ws-flashcard button[type=submit]")]
    .map(node => [node, node.disabled]);
  controls.forEach(([node]) => { node.disabled = true; });
  return () => { controls.forEach(([node, disabled]) => { node.disabled = disabled; }); reviewPending = false; };
}
const studyMics = new Set();
function studyMic(options) {
  const button = micButton(options);
  studyMics.add(button);
  return button;
}
function stopStudyCapture() {
  for (const button of studyMics) cancelMicButton(button);
  studyMics.clear();
}

registerTabDetail("vocab", (detail, { restore }) => {
  if (detail !== "practice") { stopStudyCapture(); stopCompare(); }
  if (detail === null) detail = "setup";
  if (!["setup", "practice"].includes(detail)) return;
  showingSetup = detail === "setup";
  stopSpeaking();
  paint(!restore && !showingSetup ? saved?.session?.options.practice === "spelling" ? "ws-spelling" : "ws-word" : "");
});

function openPractice() {
  showingSetup = false;
  const route = currentRoute();
  if (route.detail === "practice") {
    paint(saved.session.options.practice === "spelling" ? "ws-spelling" : "ws-word");
    return;
  }
  navigate({ tab: "vocab", detail: "practice" });
}

function backToSetup() {
  stopSpeaking();
  stopCompare();
  goBack({ tab: "vocab", detail: "setup" });
}

let draftTimer = 0;
const DRAFT_KEY = "asound.wordstudy.draft.v1";
const draftIdentity = session => JSON.stringify([session.ids, session.index, session.options, session.mode]);
function backupDraft() {
  // A page can disappear before an async lock is granted. This bounded, tab-local
  // backup preserves only unsubmitted text; it never writes shared progress.
  try {
    const session = saved?.session;
    if (session && !session.attempt && session.draft) sessionStorage.setItem(DRAFT_KEY,
      JSON.stringify({ identity: draftIdentity(session), draft: session.draft }));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {}
}
function restoreDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY)), session = saved?.session;
    if (session && !session.attempt && draft?.identity === draftIdentity(session) && typeof draft.draft === "string") {
      session.draft = draft.draft.slice(0, session.options.practice === "say" ? MAX_SPOKEN_RESPONSE_LENGTH : 300);
    }
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {}
}
function flushDraft() {
  backupDraft();
  if (!draftTimer) return;
  clearTimeout(draftTimer);
  draftTimer = 0;
  persist();
}
window.addEventListener("pagehide", () => { generation++; stopStudyCapture(); stopSpeaking(); stopCompare(); flushDraft(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) flushDraft(); }); // a phone switching apps
// Another window (a second tab, or the installed app beside a browser tab) saved progress: count it here too.
window.addEventListener("storage", event => {
  if (!saved || (event.key !== null && event.key !== STUDY_STATE_KEY)) return;
  if (!mergeProgress(saved.progress, readStudyState().progress) || !showingSetup || !host?.isConnected) return;
  // Update the counts without disturbing this window: keep the source panel, the focus and the scroll position.
  const active = host.contains(document.activeElement) ? document.activeElement : null;
  const summary = !!active?.matches(".ws-source > summary");
  const sourceOpen = !!host.querySelector(".ws-source")?.open;
  paint();
  if (sourceOpen) host.querySelector(".ws-source")?.setAttribute("open", "");
  (active?.id ? host.querySelector(`#${active.id}`) : summary ? host.querySelector(".ws-source > summary") : null)?.focus({ preventScroll: true });
});

// Keyboard on a computer: 1-4 (or A-D) pick an option or a rating, Space shows the answer, Enter goes on.
document.addEventListener("keydown", event => {
  if (!host?.isConnected || !host.getClientRects().length || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable]")) return;
  const press = button => { if (button && !button.disabled) { event.preventDefault(); button.click(); } };
  const key = event.key.toLowerCase();
  const n = /^[1-9]$/.test(key) ? Number(key) - 1 : /^[a-d]$/.test(key) ? key.charCodeAt(0) - 97 : -1;
  if (n >= 0) press(host.querySelectorAll(".ws-options button, .ws-grades button")[n]);
  else if ((key === " " || key === "enter") && !target?.closest("button, a")) press(host.querySelector("#ws-next, .ws-reveal button"));
});
window.visualViewport?.addEventListener("resize", () => {
  if (host?.isConnected && host.contains(document.activeElement) && document.activeElement?.id === "ws-spelling") {
    keepVisible(document.activeElement);
  }
});

// These also cover an unavailable feature dictionary on the first visit.
addStrings("en", { "wstudy.loading": "Loading vocabulary\u2026", "wstudy.loadFailed": "The word list could not be loaded. Check your connection and try again.", "wstudy.retry": "Try again" });
addStrings("zh", { "wstudy.loading": "\u6b63\u5728\u52a0\u8f7d\u8bcd\u5e93\u2026", "wstudy.loadFailed": "\u8bcd\u5e93\u6682\u65f6\u65e0\u6cd5\u52a0\u8f7d\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5\u3002", "wstudy.retry": "\u91cd\u8bd5" });

function loadStyle() {
  if (!stylePromise) {
    stylePromise = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("../css/word-study.css", import.meta.url).href;
      link.onload = resolve;
      link.onerror = () => { link.remove(); stylePromise = null; reject(new Error("word-study style unavailable")); };
      document.head.append(link);
    });
  }
  return stylePromise;
}

// General American transcriptions (vocabulary/ipa-us.json, from tools/american_ipa.py). The dictionary's own
// transcriptions are mostly British; ASound teaches an American accent, so the American one is shown first.
let usIpa = null;
let usIpaPromise = null;
function loadUsIpa() {
  if (!usIpaPromise) {
    usIpaPromise = fetch(new URL("../vocabulary/ipa-us.json", import.meta.url))
      .then(res => (res.ok ? res.json() : null))
      .then(doc => { usIpa = doc && doc.schemaVersion === 1 && doc.ipa ? doc.ipa : {}; })
      .catch(() => { usIpa = {}; });
  }
  return usIpaPromise;
}

function loadAssets() {
  if (!assetsPromise) {
    assetsPromise = Promise.all([
      loadStyle(),
      loadUsIpa(), // never rejects: a missing file only hides the American line
      fetch(new URL("../locales/feat/word-study.json", import.meta.url)).then(async res => {
        if (!res.ok) throw new Error("word-study strings unavailable");
        const strings = await res.json();
        for (const [lang, values] of Object.entries(strings)) addStrings(lang, values);
      }),
    ]).catch(error => { assetsPromise = null; throw error; });
  }
  return assetsPromise;
}

function validateSession(value) {
  if (!value || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 30
      || value.ids.some(id => typeof id !== "string" || !wordsById.has(id))
      || new Set(value.ids).size !== value.ids.length
      || !Number.isInteger(value.index) || value.index < 0 || value.index > value.ids.length) return null;
  const ratings = Array.isArray(value.ratings) ? value.ratings : [];
  if (ratings.length !== value.index || ratings.some((entry, index) => entry?.id !== value.ids[index] || !RATINGS.includes(entry.rating))) return null;
  const options = normalizeOptions(value.options);
  const eligible = new Set(filterWords(bank.words, options).map(word => word.id));
  if (value.ids.some(id => !eligible.has(id))) return null;
  if (ratings.some(row => row.practice && (!validAttempt(row, wordsById.get(row.id), row.practice)
      || row.rating !== (row.correct ? "good" : "again")))) return null;
  const word = wordsById.get(value.ids[value.index]);
  const choices = Array.isArray(value.choices) ? value.choices.filter(id => eligible.has(id)) : [];
  const attempt = value.attempt || null;
  if (attempt && (!word || !validAttempt(attempt, word, options.practice)
      || (options.practice === "choice" && (!validChoices(choices, word) || !choices.includes(attempt.response))))) return null;
  return {
    ids: [...value.ids], index: value.index, revealed: !!value.revealed,
    ratings: ratings.map(entry => ({ ...entry })), choices, attempt,
    draft: typeof value.draft === "string" ? value.draft.slice(0, options.practice === "say" ? MAX_SPOKEN_RESPONSE_LENGTH : 300) : "",
    options, mode: value.mode === "review" ? "review" : "random",
  };
}

function validAttempt(attempt, word, practice) {
  return !!word && ["choice", "spelling", "say"].includes(practice) && attempt.practice === practice
    && typeof attempt.response === "string" && !!attempt.response.trim()
    && typeof attempt.correct === "boolean"
    && attempt.correct === judge(practice, attempt.response, word);
}

function validChoices(ids, word) {
  if (!word || !ids.length || ids.length > 4 || !ids.includes(word.id) || new Set(ids).size !== ids.length) return false;
  const meanings = ids.map(id => wordsById.get(id)?.meaning?.trim().replace(/\s+/g, " ").toLowerCase());
  return meanings.every(Boolean) && new Set(meanings).size === ids.length;
}

function prepareQuestion() {
  const session = saved.session;
  if (!session || session.options.practice !== "choice" || session.index >= session.ids.length) return;
  const word = wordsById.get(session.ids[session.index]);
  if (!validChoices(session.choices || [], word)) {
    session.choices = meaningChoices(word, filterWords(bank.words, session.options)).map(row => row.id);
    persist();
  }
}

export async function renderWordStudy(root) {
  preparePictures();
  if (host && host !== root) stopSpeaking();
  host = root;
  const mine = ++generation;
  host.classList.add("word-study");
  if (!bank || !saved) fill(host, h("p", { class: "hint-line", role: "status" }, t("wstudy.loading")));
  try {
    const [loaded] = await Promise.all([loadWordBank(), loadAssets()]);
    if (mine !== generation || host !== root || !root.isConnected) return;
    bank = loaded;
    wordsById = new Map(bank.words.map(word => [word.id, word]));
    const resumeOnVisit = !saved && isNewNavigationVisit();
    if (!saved) {
      saved = readStudyState();
      saved.options = normalizeOptions(saved.options);
      const previous = saved.session;
      saved.session = validateSession(previous);
      resumeDiscarded = !!previous && !saved.session;
      restoreDraft();
    }
    // A saved session on a fresh visit has a real setup parent. Reloading an
    // existing practice entry reuses it instead of adding another history item.
    if (saved.session && resumeOnVisit && currentRoute().detail !== "practice") {
      openPractice();
    } else paint();
    restoreNavigationScroll();
  } catch (error) {
    if (mine !== generation || host !== root || !root.isConnected) return;
    console.warn("word study could not load", error);
    fill(root, h("p", { class: "banner", role: "alert" }, t("wstudy.loadFailed")),
      h("button", { type: "button", class: "btn", onclick: () => {
        if (host === root && mine === generation && root.isConnected) renderWordStudy(root);
      } }, t("wstudy.retry")));
  }
}

export function cleanupWordStudy() {
  generation++;
  stopStudyCapture();
  host?.classList.remove("word-study");
  host = null;
  stopSpeaking();
  stopCompare();
}

export function isWordStudyActive() {
  return !!(host?.isConnected && !showingSetup && saved?.session && saved.session.index < saved.session.ids.length);
}

function storageNotice() {
  if (!host?.isConnected) return;
  const old = host.querySelector(".ws-storage-warning");
  if (storageFailed && !old) host.prepend(h("p", { class: "banner ws-storage-warning", role: "alert" }, t("wstudy.storageFailed")));
  if (!storageFailed) old?.remove();
  const footer = host.querySelector(".ws-card-footer > .hint-line");
  if (footer) footer.textContent = t(storageFailed ? "wstudy.unsaved" : "wstudy.savedHere");
}

async function persist() {
  const result = await commitStudyState(saved);
  storageFailed = result === false;
  storageNotice();
  if (result) { try { sessionStorage.removeItem(DRAFT_KEY); } catch {} }
  return result;
}

function paint(focusId = "") {
  if (!host?.isConnected || !saved || !bank) return;
  stopStudyCapture();
  prepareQuestion();
  paintVersion++;
  const warning = storageFailed ? h("p", { class: "banner ws-storage-warning", role: "alert" }, t("wstudy.storageFailed")) : null;
  const session = saved.session;
  fill(host, warning, !showingSetup && session
    ? session.index >= session.ids.length ? finishedView() : cardView()
    : setupView());
  if (focusId) {
    const target = host.querySelector(`#${focusId}`);
    target?.focus({ preventScroll: true });
    if (target) keepVisible(target);
  }
}

function keepVisible(target) {
  requestAnimationFrame(() => {
    if (host?.isConnected && target.isConnected && host.contains(target)) target.scrollIntoView({ block: "nearest", behavior: "instant" });
  });
}

function action(callback) {
  const root = host;
  const version = paintVersion;
  return (...args) => {
    if (root !== host || !root?.isConnected || version !== paintVersion) return;
    callback(...args);
  };
}

function choices(label, options, selected, onChange, prefix, allowNone = false) {
  const list = allowNone ? [{ id: "", key: "wstudy.any" }, ...options] : options;
  return h("fieldset", { class: "ws-field" },
    h("legend", null, label),
    h("div", { class: "ws-chips" }, list.map(option => {
      const id = `${prefix}-${option.id || "any"}`;
      return h("button", {
        id, type: "button", class: "ws-chip", "aria-pressed": String(option.id === selected),
        onclick: action(() => onChange(allowNone && option.id === selected ? "" : option.id, id)),
      }, t(option.key));
    })));
}

function updateOption(key, value, focusId) {
  saved.options = normalizeOptions({ ...saved.options, [key]: value });
  persist();
  paint(focusId);
}

function setupView() {
  const options = saved.options;
  const pool = filterWords(bank.words, options);
  const now = Date.now();
  const learned = pool.filter(word => Number(saved.progress[word.id]?.seen) > 0).length;
  const due = pool.filter(word => Number(saved.progress[word.id]?.seen) > 0 && Number(saved.progress[word.id]?.due) <= now).length;
  const remaining = saved.session && saved.session.index < saved.session.ids.length;
  const selectedDeck = bank.catalog.decks.find(deck => deck.id === options.deck);
  const deckNote = getLanguage().startsWith("zh") ? selectedDeck?.notesZh : selectedDeck?.notesEn;
  const deckCards = h("div", { class: "ws-decks", role: "group", "aria-label": t("wstudy.chooseDeck") }, DECKS.map(id => {
    const count = bank.catalog.decks.find(deck => deck.id === id)?.count ?? filterWords(bank.words, { deck: id }).length;
    return h("button", { type: "button", id: `ws-deck-${id}`, class: "ws-deck", "aria-pressed": String(options.deck === id),
      onclick: action(() => updateOption("deck", id, `ws-deck-${id}`)) },
    h("strong", null, t(`wstudy.deck.${id}`)), h("span", null, t("wstudy.wordCount", { n: count })));
  }));
  return [
    h("header", { class: "ws-intro" }, h("div", null,
      h("p", { class: "eyebrow" }, t("wstudy.eyebrow")),
      h("h1", { class: "title" }, t("wstudy.title")),
      h("p", { class: "lede" }, t("wstudy.intro"))), h("span", { class: "ws-mark", "aria-hidden": "true" }, "Aa")),
    resumeDiscarded ? h("p", { class: "note-card", role: "status" }, t("wstudy.resumeDiscarded")) : null,
    remaining ? h("div", { class: "resume" }, h("p", { class: "resume-text" }, t("wstudy.resumeNote", { done: saved.session.index, total: saved.session.ids.length })),
      h("button", { type: "button", class: "btn primary", onclick: action(openPractice) }, t("wstudy.resume"))) : null,
    h("section", { class: "stack-sm", "aria-label": t("wstudy.chooseDeck") },
      h("h2", { class: "sec" }, t("wstudy.chooseDeck")), deckCards,
      options.deck !== "general" ? h("p", { class: "hint-line ws-deck-note" }, deckNote || t("wstudy.examNote")) : null),
    h("section", { class: "card ws-filters" },
      h("div", { class: "ws-filter-title" }, h("h2", { class: "sec" }, t("wstudy.filterTitle")), h("span", { class: "pill" }, t("wstudy.optional"))),
      h("p", { class: "hint-line" }, t("wstudy.filterHint")),
      choices(t("wstudy.topicLabel"), TOPICS, options.topic, (value, id) => updateOption("topic", value, id), "ws-topic", true),
      choices(t("wstudy.scenarioLabel"), SCENARIOS, options.scenario, (value, id) => updateOption("scenario", value, id), "ws-scenario", true),
      h("p", { class: "ws-filter-result", role: "status", "aria-live": "polite" }, pool.length ? t("wstudy.matching", { n: pool.length }) : t("wstudy.noMatch"))),
    h("div", { class: "ws-start card" },
      choices(t("wstudy.practiceLabel"), PRACTICES.map(id => ({ id, key: `wstudy.practice.${id}` })), options.practice,
        (value, id) => updateOption("practice", value, id), "ws-practice"),
      h("p", { class: "hint-line" }, t(`wstudy.practiceHint.${options.practice}`)),
      choices(t("wstudy.batchSize"), [10, 20, 30].map(size => ({ id: String(size), key: `wstudy.size.${size}` })), String(options.size),
        (value, id) => updateOption("size", Number(value), id), "ws-size"),
      h("p", { class: "hint-line" }, t("wstudy.stats", { learned, due })),
      h("div", { class: "ws-start-actions" },
        h("button", { type: "button", class: "btn primary big", disabled: !pool.length, onclick: action(() => begin("random")) }, icon("dice"), t("wstudy.start")),
        h("button", { type: "button", class: "btn big", disabled: !due, onclick: action(() => begin("review")) }, t("wstudy.review", { n: due }))),
      h("p", { class: "hint-line" }, t("wstudy.modelNote"))),
    sourceDetails(options.deck),
  ];
}

function sourceDetails(deck) {
  const deckInfo = bank.catalog.decks.find(item => item.id === deck) || {};
  const source = { ...(bank.catalog.source || {}), ...(deckInfo.source && typeof deckInfo.source === "object" ? deckInfo.source : {}) };
  source.name = deckInfo.sourceName || source.name;
  source.url = deckInfo.sourceUrl || source.url;
  const note = getLanguage().startsWith("zh") ? deckInfo.notesZh || source.notesZh : deckInfo.notesEn || source.notesEn;
  const sharedNote = getLanguage().startsWith("zh") ? bank.catalog.source?.notesZh : bank.catalog.source?.notesEn;
  let sourceLink = null;
  try {
    const url = new URL(source.url);
    if (["https:", "http:"].includes(url.protocol)) sourceLink = h("a", { href: url.href, target: "_blank", rel: "noopener noreferrer" }, str(source.name) || t("wstudy.sourceLink"));
  } catch {}
  return h("details", { class: "ws-source" },
    h("summary", null, t("wstudy.sourceSummary", { name: str(source.name) || t("wstudy.sourceLink") })),
    h("div", { class: "stack-xs" },
      h("p", null, note || t("wstudy.sourceNote")),
      sharedNote && sharedNote !== note ? h("p", null, sharedNote) : null,
      deck !== "general" ? h("p", null, t("wstudy.examNote")) : null,
      h("p", null, t("wstudy.tagNote")),
      sourceLink ? h("p", null, sourceLink) : null,
      h("a", { href: new URL("../vocabulary/coverage-report.json", import.meta.url).href,
        target: "_blank", rel: "noopener noreferrer" }, t("wstudy.coverage"))));
}

function begin(mode) {
  // "Say it" is built around the picture cue: draw a new round from pictured words when there are enough.
  let pool = bank.words;
  if (saved.options.practice === "say" && mode === "random") {
    const pictured = filterWords(bank.words, saved.options).filter(word => hasPicture(word));
    if (pictured.length >= saved.options.size) pool = pictured;
  }
  const selected = chooseWords(pool, saved.options, { mode, progress: saved.progress });
  if (!selected.length) { paint(); return; }
  stopSpeaking();
  saved.session = { ids: selected.map(word => word.id), index: 0, revealed: false, ratings: [], options: { ...saved.options },
    choices: [], draft: "", attempt: null, mode };
  showingSetup = false;
  resumeDiscarded = false;
  persist();
  openPractice();
}

function sessionLabel(session) {
  return [t(`wstudy.deck.${session.options.deck}`), session.options.topic ? t(`wstudy.topic.${session.options.topic}`) : "",
    session.options.scenario ? t(`wstudy.scenario.${session.options.scenario}`) : "",
    t(`wstudy.practice.${session.options.practice}`)].filter(Boolean).join(" \u00b7 ");
}

function pronunciationButton(word) {
  const root = host;
  const version = paintVersion;
  const button = speakBtn(word.term, t("wstudy.listen"), t("wstudy.listen"));
  button.addEventListener("click", event => {
    if (host !== root || !root?.isConnected || version !== paintVersion) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  return button;
}

function cardView() {
  const session = saved.session;
  const index = session.index;
  const word = wordsById.get(session.ids[index]);
  // Fetch this and the next two cards' pictures now, so a revealed card shows its picture without a wait.
  warmPictures(session.ids.slice(index, index + 3).map(id => wordsById.get(id)).filter(Boolean));
  // ...and this word's and the next word's audio, once the card is drawn, so "Listen" plays without a wait.
  const soon = window.requestIdleCallback || (fn => setTimeout(fn, 300));
  const paintedHost = host, paintedVersion = paintVersion;
  soon(() => {
    if (host !== paintedHost || !host?.isConnected || paintVersion !== paintedVersion || showingSetup
        || saved?.session !== session || session.index !== index) return;
    session.ids.slice(index, index + 2).forEach(id => wordsById.has(id) && prefetchSpeech(wordsById.get(id).term));
  }, { timeout: 1500 });
  const collected = vocab.has(word.term);
  const fallback = session.options.practice === "choice" && session.choices.length < 2;
  const practice = fallback ? "cards" : session.options.practice;
  const answered = !!session.attempt;
  const hideWord = (practice === "spelling" || practice === "say") && !answered;
  const revealed = practice === "cards" ? session.revealed : answered;
  const us = usIpa && typeof usIpa[word.id] === "string" ? usIpa[word.id] : "";
  const pronunciation = us
    ? h("p", { class: "ipa ws-ipa" }, h("span", { class: "ws-ipa-tag" }, t("wstudy.ipaUs")), fmtIpa(us),
      word.ipa ? h("span", { class: "ws-ipa-uk" }, t("wstudy.ipaUk"), " ", fmtIpa(word.ipa)) : null)
    : word.ipa ? h("p", { class: "ipa" }, fmtIpa(word.ipa)) : null;
  const reveal = () => {
    if (!host?.isConnected || saved.session !== session || session.index !== index) return;
    session.revealed = true;
    persist();
    paint("ws-meaning");
  };
  return [
    h("header", { class: "ws-study-head" },
      h("button", { type: "button", class: "btn quiet", onclick: action(backToSetup) }, icon("back"), t("wstudy.back")),
      h("p", { class: "hint-line" }, t("wstudy.cardProgress", { n: index + 1, total: session.ids.length }))),
    h("progress", { class: "ws-progress", max: session.ids.length, value: index, "aria-label": t("wstudy.progressLabel") }),
    h("p", { class: "ws-session-label" }, sessionLabel(session)),
    h("article", { class: `card ws-flashcard ws-practice-${practice}` },
      h("p", { class: "mini-label" }, t(practice === "say" ? "wstudy.sayPrompt" : practice === "spelling" ? "wstudy.spellingPrompt" : practice === "choice" ? "wstudy.choicePrompt"
        : session.mode === "review" ? "wstudy.reviewCard" : "wstudy.recallPrompt")),
      hideWord ? h("h2", { id: "ws-word", class: "ws-question-title", tabindex: "-1" }, t(practice === "say" ? "wstudy.sayTitle" : "wstudy.spellingTitle"))
        : h("h2", { id: "ws-word", class: "ws-word", lang: "en", tabindex: "-1" }, word.term),
      hideWord ? null : [pronunciation, pronunciationButton(word)],
      fallback ? h("p", { class: "note-card" }, t("wstudy.choiceFallback")) : null,
      practice === "choice" ? choiceQuestion(session, index, word) : null,
      hideWord && practice === "say" ? [createWordIllustration(word, { cue: true }), h("p", { class: "ws-meaning", lang: "zh-CN" }, spellingMeaning(word)), sayQuestion(session, index, word)] : null,
      hideWord && practice === "spelling" ? [h("p", { class: "ws-meaning", lang: "zh-CN" }, spellingMeaning(word)), spellingQuestion(session, index, word)] : null,
      answered ? answerFeedback(session, word) : null,
      revealed ? h("div", { class: "ws-answer" },
        h("p", { id: "ws-meaning", tabindex: "-1", class: "ws-meaning", lang: "zh-CN" }, word.meaning),
        word.example ? h("p", { class: "ex", lang: "en" }, word.example) : null,
        createWordIllustration(word), // after "Say it" too: the picture with the word is what is remembered
        practice === "cards" ? h("p", { class: "hint-line" }, t("wstudy.rateHint")) : null) : practice === "cards"
        ? h("div", { class: "ws-reveal" }, h("p", { class: "hint-line" }, t("wstudy.recallHint")),
          h("button", { type: "button", class: "btn primary big", onclick: action(reveal) }, t("wstudy.reveal"))) : null),
    practice === "cards" && revealed ? h("div", { class: "ws-grades", role: "group", "aria-label": t("wstudy.rateHint") }, RATINGS.map(rating =>
      h("button", { type: "button", class: `ws-grade ${rating}`, onclick: action(() => grade(session, index, word, rating)) },
        h("strong", null, t(`wstudy.rating.${rating}`)), h("small", null, t(`wstudy.ratingHint.${rating}`))))) : null,
    answered ? h("button", { type: "button", id: "ws-next", class: "btn primary big", onclick: action(() => continueAnswer(session, index, word)) },
      t(index + 1 < session.ids.length ? "wstudy.nextWord" : "wstudy.seeResults")) : null,
    h("div", { class: "ws-card-footer" },
      hideWord ? null : h("button", { type: "button", class: "btn quiet", disabled: collected,
        onclick: action(() => { if (!vocab.has(word.term)) vocab.add({ term: word.term, meaning: word.meaning, ipa: word.ipa, example: word.example || "", source: "study" }); paint(); }) },
      icon(collected ? "check" : "plus"), t(collected ? "wstudy.collected" : "wstudy.collect")),
      h("span", { class: "hint-line" }, t(storageFailed ? "wstudy.unsaved" : "wstudy.savedHere"))),
  ];
}

function spellingMeaning(word) {
  // Some dictionary definitions repeat the headword in Latin text. Do not give it away.
  const escaped = word.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return word.meaning.replace(new RegExp(escaped, "gi"), "____");
}

function choiceQuestion(session, index, word) {
  const attempt = session.attempt;
  return h("div", { class: "ws-options", role: "group", "aria-label": t("wstudy.choicePrompt") }, session.choices.map((id, position) => {
    const option = wordsById.get(id);
    const selected = attempt?.response === id;
    const correct = !!attempt && id === word.id;
    const wrong = !!attempt && selected && !correct;
    return h("button", { type: "button", class: `ws-option${correct ? " is-correct" : wrong ? " is-wrong" : ""}`,
      id: `ws-answer-${position}`, disabled: !!attempt, "aria-pressed": String(selected),
      onclick: action(() => submitAnswer(session, index, word, "choice", id)) },
    h("span", { class: "ws-option-letter", "aria-hidden": "true" }, String.fromCharCode(65 + position)),
    h("span", { class: "ws-option-meaning", lang: "zh-CN" }, option.meaning),
    correct || wrong ? h("span", { class: "ws-option-result" }, icon(correct ? "check" : "close"), t(correct ? "wstudy.correctChoice" : "wstudy.yourChoice")) : null);
  }));
}

function spellingQuestion(session, index, word) {
  let composing = false;
  const clue = spellingClue(word.term);
  const clueText = t(clue.first ? "wstudy.spellingClue" : "wstudy.spellingLength", clue);
  const alternative = h("p", { class: "note-card", role: "status", hidden: !isAlternativeSpelling(session.draft, word, bank.words) },
    t("wstudy.spellingAlternative"));
  const input = h("input", { type: "text", id: "ws-spelling", class: "ws-spelling-input", inputmode: "text", autocomplete: "off",
    autocapitalize: "none", autocorrect: "off", spellcheck: "false", enterkeyhint: "done", lang: "en", maxlength: "300", required: true,
    "aria-describedby": "ws-spelling-target ws-spelling-hint", placeholder: t("wstudy.spellingPlaceholder") });
  input.value = session.draft || "";
  const submit = h("button", { type: "submit", class: "btn primary big", disabled: !input.value.trim() }, t("wstudy.submitAnswer"));
  // Save the draft a moment after typing stops (every keystroke used to rewrite the whole study state).
  input.addEventListener("input", action(() => {
    session.draft = input.value;
    alternative.hidden = true;
    submit.disabled = !input.value.trim();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { draftTimer = 0; persist(); }, 400);
  }));
  input.addEventListener("blur", flushDraft);
  input.addEventListener("focus", () => keepVisible(input));
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
  });
  return h("form", { class: "ws-spelling-form", onsubmit: action(event => {
    event.preventDefault();
    if (composing || !input.value.trim()) return;
    input.blur();
    submitAnswer(session, index, word, "spelling", input.value);
  }) }, h("p", { id: "ws-spelling-target", class: "hint-line" }, clueText),
  h("label", { for: "ws-spelling", class: "field-label" }, t("wstudy.spellingLabel")), input,
  h("p", { id: "ws-spelling-hint", class: "hint-line" }, t("wstudy.spellingHint")), alternative, submit);
}

async function submitAnswer(session, index, word, practice, response) {
  if (reviewPending || !host?.isConnected || saved.session !== session || session.index !== index || session.attempt
      || session.options.practice !== practice || !response.trim()
      || (practice === "choice" && !session.choices.includes(response))) return;
  stopSpeaking();
  if (practice === "say" && response.length > MAX_SPOKEN_RESPONSE_LENGTH) {
    toast(t("wstudy.sayTooLong"));
    return; // Do not grade an answer that cannot be saved intact.
  }
  if (practice !== "choice") {
    // Retain recognized speech as an editable draft too. A failed save should
    // let the learner retry the same answer without another recording.
    session.draft = response;
    const input = host.querySelector(practice === "say" ? "#ws-say-input" : "#ws-spelling");
    if (input) input.value = response;
    backupDraft();
  }
  if ((practice === "spelling" && isAlternativeSpelling(response, word, bank.words))
      || (practice === "say" && isAlternativeSaying(response, word, bank.words))) {
    session.draft = response;
    persist();
    paint(practice === "say" ? "ws-say-input" : "ws-spelling");
    return;
  }
  const correct = judge(practice, response, word);
  const answeredAt = Date.now();
  const finishPending = pendingAnswer();
  try {
    const result = await commitStudyState(saved, next => {
      if (saved.session !== session || session.index !== index || session.attempt) return false;
      next.progress[word.id] = answerProgress(next.progress[word.id], correct, practice, answeredAt);
      next.session.attempt = { practice, response, correct, answeredAt };
      next.session.revealed = true;
      next.session.draft = "";
    });
    storageFailed = result === false;
    storageNotice();
    if (result && saved.session === session && session.index === index) paint(showingSetup ? "" : "ws-feedback");
  } finally { finishPending(); }
}

// How an answer is checked, per practice.
function judge(practice, response, word) {
  if (practice === "spelling") return spellingCorrect(response, word.term);
  if (practice === "say") return sayCorrect(response, word.term);
  return response === word.id;
}

// "Say it": the picture (when the word has one) and the meaning are the cue; the learner says the English word.
let lastTake = null; // {wordId, audio: Float32Array 16 kHz} of the latest spoken answer, for "compare"
function sayQuestion(session, index, word) {
  const clue = spellingClue(word.term);
  const alternative = h("p", { class: "note-card", role: "status", hidden: !isAlternativeSaying(session.draft, word, bank.words) },
    t("wstudy.sayAlternative"));
  const typed = h("input", { type: "text", id: "ws-say-input", class: "ws-spelling-input", autocomplete: "off", autocapitalize: "none", autocorrect: "off",
    spellcheck: "false", lang: "en", maxlength: String(MAX_SPOKEN_RESPONSE_LENGTH), placeholder: t("wstudy.sayTypePlaceholder"), "aria-label": t("wstudy.sayTypePlaceholder") });
  typed.value = session.draft || "";
  typed.addEventListener("input", () => {
    alternative.hidden = true;
    session.draft = typed.value;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { draftTimer = 0; persist(); }, 400);
  });
  typed.addEventListener("blur", flushDraft);
  const mic = studyMic({
    big: true, label: t("wstudy.sayMic"),
    onAudio: (audio) => { lastTake = { wordId: word.id, audio: audio.slice() }; },
    onText: (heard) => submitAnswer(session, index, word, "say", heard),
  });
  return h("div", { class: "ws-say" },
    h("p", { id: "ws-say-target", class: "hint-line" }, t(clue.first ? "wstudy.spellingClue" : "wstudy.spellingLength", clue)),
    h("div", { class: "attempt-row" }, mic, h("span", { class: "hint-line" }, t("wstudy.sayHint"))),
    alternative,
    h("form", { class: "ws-say-type", onsubmit: action((event) => {
      event.preventDefault();
      if (typed.value.trim()) { lastTake = null; submitAnswer(session, index, word, "say", typed.value); }
    }) }, typed, h("button", { type: "submit", class: "btn" }, t("wstudy.submitAnswer"))));
}

// After a wrong "Say it": say the word again right away (not scored; the answer above stands), as often as wanted.
function sayAgain(word) {
  const result = h("span", { class: "hint-line", role: "status" });
  const mic = studyMic({
    label: t("wstudy.sayAgain"),
    onAudio: (audio) => { lastTake = { wordId: word.id, audio: audio.slice() }; document.getElementById("ws-compare")?.removeAttribute("hidden"); },
    onText: (heard) => fill(result, icon(sayCorrect(heard, word.term) ? "check" : "close"), " ", t("wstudy.sayHeard"), " ",
      h("span", { lang: "en" }, heard)),
  });
  mic.addEventListener("click", stopCompare, true); // the model's voice must not play into the new take
  return h("div", { class: "attempt-row" }, mic, h("span", { class: "hint-line" }, t("wstudy.sayAgain")), result);
}

// Model, you, model: hear the American voice, your own take, then the model again.
let compareRun = 0, takeSource = null;
function stopCompare() {
  compareRun++;
  try { if (takeSource) takeSource.stop(); } catch {} // not started yet
  takeSource = null;
}
function compareTake(word) {
  const take = lastTake;
  if (!take || take.wordId !== word.id) return;
  stopCompare();
  const run = compareRun, live = () => run === compareRun;
  speak(word.term, null, 0.9, () => {
    const ctx = audioContext();
    if (!ctx || !live()) return;
    const buffer = ctx.createBuffer(1, take.audio.length, 16000);
    buffer.copyToChannel(take.audio, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => setTimeout(() => { if (live()) { takeSource = null; speak(word.term, null, 0.9); } }, 250);
    takeSource = source;
    setTimeout(() => { if (live()) source.start(); }, 250);
  });
}

function answerFeedback(session, word) {
  const attempt = session.attempt;
  return h("div", { class: `ws-feedback ${attempt.correct ? "is-correct" : "is-wrong"}`, id: "ws-feedback", role: "status", tabindex: "-1" },
    h("strong", null, icon(attempt.correct ? "check" : "close"), t(attempt.correct ? "wstudy.answerCorrect" : "wstudy.answerWrong")),
    attempt.practice === "spelling" ? h("p", null, t("wstudy.yourAnswer"), " ", h("span", { lang: "en" }, attempt.response.trim())) : null,
    attempt.practice === "say" ? h("p", null, t("wstudy.sayHeard"), " ", h("span", { lang: "en" }, attempt.response.trim())) : null,
    attempt.practice === "say" ? h("button", { type: "button", id: "ws-compare", class: "btn", hidden: !(lastTake && lastTake.wordId === word.id),
      onclick: action(() => compareTake(word)) }, icon("speaker"), t("wstudy.compare")) : null,
    attempt.practice === "say" && !attempt.correct ? sayAgain(word) : null,
    h("p", null, t("wstudy.correctAnswer"), " ", h("b", { lang: "en" }, word.term)),
    h("p", { class: "hint-line" }, t(attempt.correct ? "wstudy.correctReview" : "wstudy.wrongReview")));
}

function continueAnswer(session, index, word) {
  if (!host?.isConnected || saved.session !== session || session.index !== index || !session.attempt) return;
  session.ratings.push({ id: word.id, rating: session.attempt.correct ? "good" : "again", ...session.attempt });
  advance(session);
}

function advance(session) {
  stopSpeaking();
  stopCompare();
  session.index++;
  session.revealed = false;
  session.attempt = null;
  session.choices = [];
  session.draft = "";
  persist();
  paint(session.index < session.ids.length ? session.options.practice === "spelling" ? "ws-spelling" : "ws-word" : "ws-finished");
}

async function grade(session, index, word, rating) {
  if (reviewPending || !host?.isConnected || saved.session !== session || session.index !== index || !session.revealed) return;
  stopSpeaking();
  const reviewedAt = Date.now();
  const finishPending = pendingAnswer();
  try {
    const result = await commitStudyState(saved, next => {
      if (saved.session !== session || session.index !== index || !session.revealed) return false;
      next.progress[word.id] = gradeProgress(next.progress[word.id], rating, reviewedAt);
      next.session.ratings.push({ id: word.id, rating });
      next.session.index++;
      next.session.revealed = false;
      next.session.attempt = null;
      next.session.choices = [];
      next.session.draft = "";
    });
    storageFailed = result === false;
    storageNotice();
    if (result && saved.session === session) paint(showingSetup ? "" : session.index < session.ids.length ? "ws-word" : "ws-finished");
  } finally { finishPending(); }
}

function retry(session, words) {
  stopSpeaking();
  saved.options = { ...session.options };
  saved.session = { ids: words.map(word => word.id), index: 0, revealed: false, ratings: [], options: { ...session.options },
    choices: [], draft: "", attempt: null, mode: session.mode };
  persist();
  openPractice();
}

function finishedView() {
  const session = saved.session;
  const answers = session.ratings.filter(entry => typeof entry.correct === "boolean");
  const correct = answers.filter(entry => entry.correct).length;
  const selfRated = session.ratings.length - answers.length;
  const results = session.options.practice === "cards"
    ? RATINGS.map(rating => [session.ratings.filter(entry => entry.rating === rating).length, t(`wstudy.rating.${rating}`)])
    : [[correct, t("wstudy.resultCorrect")], [answers.length - correct, t("wstudy.resultWrong")],
      [answers.length ? `${Math.round(correct / answers.length * 100)}%` : "-", t("wstudy.accuracy")]];
  const missed = [...new Set(session.ratings.filter(entry => entry.correct === false || entry.rating === "again").map(entry => entry.id))]
    .map(id => wordsById.get(id)).filter(Boolean);
  return [
    h("section", { class: "card ws-finished" },
      h("div", { class: "ws-finished-mark", "aria-hidden": "true" }, icon("check")),
      h("h1", { id: "ws-finished", tabindex: "-1", class: "title" }, t("wstudy.finished")),
      h("p", { class: "lede" }, t("wstudy.finishedCount", { n: session.ids.length })),
      h("p", { class: "hint-line" }, sessionLabel(session)),
      h("div", { class: "ws-results" }, results.map(([count, label]) => h("div", null, h("strong", null, count), h("span", null, label)))),
      session.options.practice !== "cards" && selfRated ? h("p", { class: "hint-line" }, t("wstudy.selfRatedCount", { n: selfRated })) : null,
      h("p", { class: "hint-line" }, t("wstudy.nextReview")),
      missed.length ? h("div", { class: "ws-missed" },
        h("h2", null, t("wstudy.missedTitle")),
        h("ul", null, missed.map(word => h("li", null,
          h("b", { lang: "en" }, word.term),
          h("span", { lang: "zh-CN" }, String(word.meaning || "").split("\n")[0]),
          speakBtn(word.term, t("wstudy.listen")))))) : null),
    h("div", { class: "ws-start-actions" },
      // Missed words right away, while the mistake is fresh (they also come back in later reviews).
      missed.length ? h("button", { type: "button", class: "btn primary big", onclick: action(() => retry(session, missed)) },
        t("wstudy.retryMissed", { n: missed.length })) : null,
      h("button", { type: "button", class: `btn ${missed.length ? "" : "primary "}big`, onclick: action(() => { saved.options = { ...session.options }; begin("random"); }) }, t("wstudy.nextBatch")),
      h("button", { type: "button", class: "btn big", onclick: action(backToSetup) }, t("wstudy.changeOptions"))),
  ];
}
