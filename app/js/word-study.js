// Local word study: optional interests/situations, sourced exam decks, and saved recall progress.
import { h, fill, icon, fmtIpa, str } from "./util.js";
import { t, addStrings, getLanguage } from "./i18n.js";
import { speakBtn, stopSpeaking } from "./speech.js";
import { vocab } from "./store.js";
import { createWordIllustration, warmPictures, preparePictures } from "./word-illustrations.js";
import { currentRoute, navigate, goBack, registerTabDetail, restoreNavigationScroll, isNewNavigationVisit } from "./nav.js";
import {
  TOPICS, SCENARIOS, loadWordBank, normalizeOptions, filterWords, chooseWords,
  gradeProgress, readStudyState, saveStudyState, PRACTICES, meaningChoices, spellingCorrect, answerProgress,
  isAlternativeSpelling, spellingClue,
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

registerTabDetail("vocab", (detail, { restore }) => {
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
  goBack({ tab: "vocab", detail: "setup" });
}

window.addEventListener("pagehide", () => { generation++; stopSpeaking(); });
window.visualViewport?.addEventListener("resize", () => {
  if (host?.isConnected && host.contains(document.activeElement) && document.activeElement?.id === "ws-spelling") {
    keepVisible(document.activeElement);
  }
});

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
    draft: typeof value.draft === "string" ? value.draft.slice(0, 300) : "",
    options, mode: value.mode === "review" ? "review" : "random",
  };
}

function validAttempt(attempt, word, practice) {
  return !!word && ["choice", "spelling"].includes(practice) && attempt.practice === practice
    && typeof attempt.response === "string" && !!attempt.response.trim()
    && typeof attempt.correct === "boolean"
    && attempt.correct === (practice === "spelling" ? spellingCorrect(attempt.response, word.term) : attempt.response === word.id);
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
  prepareQuestion();
  paintVersion++;
  const warning = storageFailed ? h("p", { class: "banner", role: "alert" }, t("wstudy.storageFailed")) : null;
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
  const selected = chooseWords(bank.words, saved.options, { mode, progress: saved.progress });
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
    t(`wstudy.practice.${session.options.practice}`)].filter(Boolean).join(" · ");
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
  const collected = vocab.has(word.term);
  const fallback = session.options.practice === "choice" && session.choices.length < 2;
  const practice = fallback ? "cards" : session.options.practice;
  const answered = !!session.attempt;
  const hideWord = practice === "spelling" && !answered;
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
      h("p", { class: "mini-label" }, t(practice === "spelling" ? "wstudy.spellingPrompt" : practice === "choice" ? "wstudy.choicePrompt"
        : session.mode === "review" ? "wstudy.reviewCard" : "wstudy.recallPrompt")),
      hideWord ? h("h2", { id: "ws-word", class: "ws-question-title", tabindex: "-1" }, t("wstudy.spellingTitle"))
        : h("h2", { id: "ws-word", class: "ws-word", lang: "en", tabindex: "-1" }, word.term),
      hideWord ? null : [pronunciation, pronunciationButton(word)],
      fallback ? h("p", { class: "note-card" }, t("wstudy.choiceFallback")) : null,
      practice === "choice" ? choiceQuestion(session, index, word) : null,
      hideWord ? [h("p", { class: "ws-meaning", lang: "zh-CN" }, spellingMeaning(word)), spellingQuestion(session, index, word)] : null,
      answered ? answerFeedback(session, word) : null,
      revealed ? h("div", { class: "ws-answer" },
        h("p", { id: "ws-meaning", tabindex: "-1", class: "ws-meaning", lang: "zh-CN" }, word.meaning),
        word.example ? h("p", { class: "ex", lang: "en" }, word.example) : null,
        createWordIllustration(word),
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
  input.addEventListener("input", action(() => {
    session.draft = input.value;
    alternative.hidden = true;
    submit.disabled = !input.value.trim();
    persist();
  }));
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

function submitAnswer(session, index, word, practice, response) {
  if (!host?.isConnected || saved.session !== session || session.index !== index || session.attempt
      || session.options.practice !== practice || !response.trim()
      || (practice === "choice" && !session.choices.includes(response))) return;
  stopSpeaking();
  if (practice === "spelling" && isAlternativeSpelling(response, word, bank.words)) {
    session.draft = response;
    persist();
    paint("ws-spelling");
    return;
  }
  const correct = practice === "spelling" ? spellingCorrect(response, word.term) : response === word.id;
  const answeredAt = Date.now();
  saved.progress[word.id] = answerProgress(saved.progress[word.id], correct, practice, answeredAt);
  session.attempt = { practice, response, correct, answeredAt };
  session.revealed = true;
  session.draft = "";
  persist();
  paint("ws-feedback");
}

function answerFeedback(session, word) {
  const attempt = session.attempt;
  return h("div", { class: `ws-feedback ${attempt.correct ? "is-correct" : "is-wrong"}`, id: "ws-feedback", role: "status", tabindex: "-1" },
    h("strong", null, icon(attempt.correct ? "check" : "close"), t(attempt.correct ? "wstudy.answerCorrect" : "wstudy.answerWrong")),
    attempt.practice === "spelling" ? h("p", null, t("wstudy.yourAnswer"), " ", h("span", { lang: "en" }, attempt.response.trim())) : null,
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
  session.index++;
  session.revealed = false;
  session.attempt = null;
  session.choices = [];
  session.draft = "";
  persist();
  paint(session.index < session.ids.length ? session.options.practice === "spelling" ? "ws-spelling" : "ws-word" : "ws-finished");
}

function grade(session, index, word, rating) {
  if (!host?.isConnected || saved.session !== session || session.index !== index || !session.revealed) return;
  stopSpeaking();
  saved.progress[word.id] = gradeProgress(saved.progress[word.id], rating);
  session.ratings.push({ id: word.id, rating });
  advance(session);
}

function finishedView() {
  const session = saved.session;
  const answers = session.ratings.filter(entry => typeof entry.correct === "boolean");
  const correct = answers.filter(entry => entry.correct).length;
  const selfRated = session.ratings.length - answers.length;
  const results = session.options.practice === "cards"
    ? RATINGS.map(rating => [session.ratings.filter(entry => entry.rating === rating).length, t(`wstudy.rating.${rating}`)])
    : [[correct, t("wstudy.resultCorrect")], [answers.length - correct, t("wstudy.resultWrong")],
      [answers.length ? `${Math.round(correct / answers.length * 100)}%` : "—", t("wstudy.accuracy")]];
  return [
    h("section", { class: "card ws-finished" },
      h("div", { class: "ws-finished-mark", "aria-hidden": "true" }, icon("check")),
      h("h1", { id: "ws-finished", tabindex: "-1", class: "title" }, t("wstudy.finished")),
      h("p", { class: "lede" }, t("wstudy.finishedCount", { n: session.ids.length })),
      h("p", { class: "hint-line" }, sessionLabel(session)),
      h("div", { class: "ws-results" }, results.map(([count, label]) => h("div", null, h("strong", null, count), h("span", null, label)))),
      session.options.practice !== "cards" && selfRated ? h("p", { class: "hint-line" }, t("wstudy.selfRatedCount", { n: selfRated })) : null,
      h("p", { class: "hint-line" }, t("wstudy.nextReview"))),
    h("div", { class: "ws-start-actions" },
      h("button", { type: "button", class: "btn primary big", onclick: action(() => { saved.options = { ...session.options }; begin("random"); }) }, t("wstudy.nextBatch")),
      h("button", { type: "button", class: "btn big", onclick: action(backToSetup) }, t("wstudy.changeOptions"))),
  ];
}
