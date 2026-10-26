// Local word study: optional interests/situations, sourced exam decks, and saved recall progress.
import { h, fill, icon, fmtIpa, str } from "./util.js";
import { t, addStrings, getLanguage } from "./i18n.js";
import { speakBtn, stopSpeaking } from "./speech.js";
import { vocab } from "./store.js";
import {
  TOPICS, SCENARIOS, loadWordBank, normalizeOptions, filterWords, chooseWords,
  gradeProgress, readStudyState, saveStudyState,
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

window.addEventListener("pagehide", () => { generation++; stopSpeaking(); });

// These also cover an unavailable feature dictionary on the first visit.
addStrings("en", { "wstudy.loading": "Loading vocabulary…", "wstudy.loadFailed": "The word list could not be loaded. Check your connection and try again.", "wstudy.retry": "Try again" });
addStrings("zh", { "wstudy.loading": "正在加载词库…", "wstudy.loadFailed": "词库暂时无法加载，请检查网络后重试。", "wstudy.retry": "重试" });

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

function loadAssets() {
  if (!assetsPromise) {
    assetsPromise = Promise.all([
      loadStyle(),
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
  return {
    ids: [...value.ids], index: value.index, revealed: !!value.revealed,
    ratings: ratings.map(entry => ({ id: entry.id, rating: entry.rating })),
    options, mode: value.mode === "review" ? "review" : "random",
  };
}

export async function renderWordStudy(root) {
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
    if (!saved) {
      saved = readStudyState();
      saved.options = normalizeOptions(saved.options);
      const previous = saved.session;
      saved.session = validateSession(previous);
      resumeDiscarded = !!previous && !saved.session;
    }
    paint();
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
  host?.classList.remove("word-study");
  host = null;
  stopSpeaking();
}

export function isWordStudyActive() {
  return !!(host?.isConnected && !showingSetup && saved?.session && saved.session.index < saved.session.ids.length);
}

function persist() {
  storageFailed = !saveStudyState(saved);
}

function paint(focusId = "") {
  if (!host?.isConnected || !saved || !bank) return;
  paintVersion++;
  const warning = storageFailed ? h("p", { class: "banner", role: "alert" }, t("wstudy.storageFailed")) : null;
  const session = saved.session;
  fill(host, warning, !showingSetup && session
    ? session.index >= session.ids.length ? finishedView() : cardView()
    : setupView());
  if (focusId) host.querySelector(`#${focusId}`)?.focus({ preventScroll: true });
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
      h("button", { type: "button", class: "btn primary", onclick: action(() => { showingSetup = false; paint("ws-word"); }) }, t("wstudy.resume"))) : null,
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
  const selected = chooseWords(bank.words, saved.options, { mode, progress: saved.progress });
  if (!selected.length) { paint(); return; }
  stopSpeaking();
  saved.session = { ids: selected.map(word => word.id), index: 0, revealed: false, ratings: [], options: { ...saved.options }, mode };
  showingSetup = false;
  resumeDiscarded = false;
  persist();
  paint("ws-word");
}

function sessionLabel(session) {
  return [t(`wstudy.deck.${session.options.deck}`), session.options.topic ? t(`wstudy.topic.${session.options.topic}`) : "",
    session.options.scenario ? t(`wstudy.scenario.${session.options.scenario}`) : ""].filter(Boolean).join(" · ");
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
  const collected = vocab.has(word.term);
  const pronunciation = word.ipa ? h("p", { class: "ipa" }, fmtIpa(word.ipa)) : null;
  const reveal = () => {
    if (!host?.isConnected || saved.session !== session || session.index !== index) return;
    session.revealed = true;
    persist();
    paint("ws-meaning");
  };
  return [
    h("header", { class: "ws-study-head" },
      h("button", { type: "button", class: "btn quiet", onclick: action(() => { stopSpeaking(); showingSetup = true; paint(); }) }, icon("back"), t("wstudy.back")),
      h("p", { class: "hint-line" }, t("wstudy.cardProgress", { n: index + 1, total: session.ids.length }))),
    h("progress", { class: "ws-progress", max: session.ids.length, value: index, "aria-label": t("wstudy.progressLabel") }),
    h("p", { class: "ws-session-label" }, sessionLabel(session)),
    h("article", { class: "card ws-flashcard" },
      h("p", { class: "mini-label" }, t(session.mode === "review" ? "wstudy.reviewCard" : "wstudy.recallPrompt")),
      h("h2", { id: "ws-word", class: "ws-word", lang: "en", tabindex: "-1" }, word.term), pronunciation,
      pronunciationButton(word),
      session.revealed ? h("div", { class: "ws-answer" },
        h("p", { id: "ws-meaning", tabindex: "-1", class: "ws-meaning", lang: "zh-CN" }, word.meaning),
        word.example ? h("p", { class: "ex", lang: "en" }, word.example) : null,
        h("p", { class: "hint-line" }, t("wstudy.rateHint"))) :
        h("div", { class: "ws-reveal" }, h("p", { class: "hint-line" }, t("wstudy.recallHint")),
          h("button", { type: "button", class: "btn primary big", onclick: action(reveal) }, t("wstudy.reveal")))),
    session.revealed ? h("div", { class: "ws-grades", role: "group", "aria-label": t("wstudy.rateHint") }, RATINGS.map(rating =>
      h("button", { type: "button", class: `ws-grade ${rating}`, onclick: action(() => grade(session, index, word, rating)) },
        h("strong", null, t(`wstudy.rating.${rating}`)), h("small", null, t(`wstudy.ratingHint.${rating}`))))) : null,
    h("div", { class: "ws-card-footer" },
      h("button", { type: "button", class: "btn quiet", disabled: collected,
        onclick: action(() => { if (!vocab.has(word.term)) vocab.add({ term: word.term, meaning: word.meaning, ipa: word.ipa, example: word.example || "", source: "study" }); paint(); }) },
      icon(collected ? "check" : "plus"), t(collected ? "wstudy.collected" : "wstudy.collect")),
      h("span", { class: "hint-line" }, t(storageFailed ? "wstudy.unsaved" : "wstudy.savedHere"))),
  ];
}

function grade(session, index, word, rating) {
  if (!host?.isConnected || saved.session !== session || session.index !== index || !session.revealed) return;
  stopSpeaking();
  saved.progress[word.id] = gradeProgress(saved.progress[word.id], rating);
  session.ratings.push({ id: word.id, rating });
  session.index++;
  session.revealed = false;
  persist();
  paint(session.index < session.ids.length ? "ws-word" : "ws-finished");
}

function finishedView() {
  const session = saved.session;
  return [
    h("section", { class: "card ws-finished" },
      h("div", { class: "ws-finished-mark", "aria-hidden": "true" }, icon("check")),
      h("h1", { id: "ws-finished", tabindex: "-1", class: "title" }, t("wstudy.finished")),
      h("p", { class: "lede" }, t("wstudy.finishedCount", { n: session.ids.length })),
      h("p", { class: "hint-line" }, sessionLabel(session)),
      h("div", { class: "ws-results" }, RATINGS.map(rating => h("div", null,
        h("strong", null, session.ratings.filter(entry => entry.rating === rating).length), h("span", null, t(`wstudy.rating.${rating}`))))),
      h("p", { class: "hint-line" }, t("wstudy.nextReview"))),
    h("div", { class: "ws-start-actions" },
      h("button", { type: "button", class: "btn primary big", onclick: action(() => { saved.options = { ...session.options }; begin("random"); }) }, t("wstudy.nextBatch")),
      h("button", { type: "button", class: "btn big", onclick: action(() => { showingSetup = true; paint(); }) }, t("wstudy.changeOptions"))),
  ];
}
