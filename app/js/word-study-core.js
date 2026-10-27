// Local word-bank selection and spaced review. Exam membership comes only from the bundled source data.
export const TOPICS = ["travel", "food", "technology", "arts", "work", "study", "sports", "health"]
  .map(id => ({ id, key: `wstudy.topic.${id}` }));
export const SCENARIOS = ["restaurant", "shopping", "transport", "hotel", "workplace", "interview", "campus", "social"]
  .map(id => ({ id, key: `wstudy.scenario.${id}` }));
const DECKS = new Set(["general", "cet4", "cet6", "kaoyan"]);
const TOPIC_IDS = new Set(TOPICS.map(v => v.id));
const SCENARIO_IDS = new Set(SCENARIOS.map(v => v.id));
const KEY = "asound.wordstudy.v1";
const DAY = 86400000;
const INTERVALS = [0, 1, 3, 7, 14, 30];
export const PRACTICES = ["cards", "choice", "spelling", "say"];
const ANSWERED = ["choice", "spelling", "say"]; // practices checked automatically (cards are self-rated)
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const integer = (value, min, max) => Math.max(min, Math.min(max, Math.trunc(finite(value))));

export function normalizeOptions(value = {}) {
  if (!object(value)) value = {};
  return {
    deck: DECKS.has(value.deck) ? value.deck : "general",
    topic: TOPIC_IDS.has(value.topic) ? value.topic : "",
    scenario: SCENARIO_IDS.has(value.scenario) ? value.scenario : "",
    size: [10, 20, 30].includes(Number(value.size)) ? Number(value.size) : 20,
    practice: PRACTICES.includes(value.practice) ? value.practice : "cards",
  };
}

const meaningKey = value => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
export const normalizeSpelling = value => String(value ?? "").normalize("NFC").trim().toLowerCase();
export const spellingCorrect = (answer, term) => !!normalizeSpelling(answer) && normalizeSpelling(answer) === normalizeSpelling(term);

// "Say it": the recognizer's transcript must contain the word (or the phrase), allowing simple inflections of the
// last word (books, watched, making...). Speech recognition hears "ice-cream" or "ice cream" alike.
const sayWords = value => normalizeSpelling(value).replace(/[\u2019']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
function inflected(heard, base) {
  if (heard === base) return true;
  const stem = base.endsWith("e") ? base.slice(0, -1) : base;
  return [base + "s", base + "es", base + "ed", base + "d", base + "ing", stem + "ing", stem + "ed",
    base.replace(/y$/, "ies"), base.replace(/y$/, "ied")].includes(heard);
}
export function sayCorrect(heard, term) {
  const said = sayWords(heard), target = sayWords(term);
  if (!said.length || !target.length) return false;
  for (let i = 0; i + target.length <= said.length; i++) {
    if (target.every((w, k) => (k === target.length - 1 ? inflected(said[i + k], w) : said[i + k] === w))) return true;
  }
  return false;
}

// A dictionary-backed alternative is a valid answer to an ambiguous definition,
// but does not establish recall of the target word. Let the learner try again.
export function isAlternativeSpelling(answer, word, pool) {
  const response = normalizeSpelling(answer);
  if (!response || spellingCorrect(response, word.term)) return false;
  const definition = meaningKey(word.meaning);
  return !!definition && pool.some(candidate => candidate.id !== word.id
    && spellingCorrect(response, candidate.term) && meaningKey(candidate.meaning) === definition);
}

export function spellingClue(term) {
  const letters = String(term ?? "").normalize("NFC").match(/\p{L}/gu) || [];
  // A one-letter word must not be revealed by its first-letter clue.
  return { first: letters.length > 1 ? letters[0] : "", count: letters.length };
}

// Distractors come from the selected real word pool. Equal definitions appear only once.
export function meaningChoices(word, pool, rng = Math.random) {
  const shuffled = [...pool];
  const shuffle = rows => {
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.max(0, Math.min(1 - Number.EPSILON, finite(rng()))) * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    return rows;
  };
  const selected = [word];
  const definitions = new Set([meaningKey(word.meaning)]);
  for (const candidate of shuffle(shuffled)) {
    const key = meaningKey(candidate.meaning);
    if (!key || candidate.id === word.id || definitions.has(key)) continue;
    definitions.add(key); selected.push(candidate);
    if (selected.length === 4) break;
  }
  return shuffle(selected);
}

export function filterWords(words, options = {}) {
  const { deck, topic, scenario } = normalizeOptions(options);
  return words.filter(word => (deck === "general" ? word.general : word.exams?.includes(deck))
    && (!topic || word.topics?.includes(topic)) && (!scenario || word.scenarios?.includes(scenario)));
}

export function chooseWords(words, options, { mode = "random", progress = {}, now = Date.now(), rng = Math.random } = {}) {
  const settings = normalizeOptions(options);
  const seen = new Set();
  const pool = filterWords(words, settings).filter(word => {
    if (seen.has(word.id)) return false;
    seen.add(word.id);
    if (mode !== "review") return true;
    const previous = Object.hasOwn(progress, word.id) ? progress[word.id] : null;
    return object(previous) && previous.seen > 0 && finite(previous.due, Infinity) <= now;
  });
  // Fisher-Yates gives an unbiased batch without mutating the shared word bank.
  for (let i = pool.length - 1; i > 0; i--) {
    const random = Math.max(0, Math.min(1 - Number.EPSILON, finite(rng())));
    const j = Math.floor(random * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, settings.size);
}

export function gradeProgress(previous, rating, now = Date.now()) {
  if (!["good", "hard", "again"].includes(rating)) throw new Error("Unknown word-study rating");
  const old = object(previous) ? previous : {};
  const before = integer(old.box, 0, 5);
  const box = rating === "good" ? Math.min(5, before + 1) : rating === "hard" ? Math.max(1, before - 1) : 0;
  const interval = rating === "good" ? INTERVALS[box] * DAY : rating === "hard" ? DAY : 600000;
  const next = { box, due: now + interval, seen: integer(old.seen, 0, 1000000) + 1, reviewedAt: now };
  if (Number.isInteger(old.answers) && old.answers > 0) {
    next.answers = integer(old.answers, 1, 1000000);
    next.correctAnswers = integer(old.correctAnswers, 0, next.answers);
    next.lastPractice = ["choice", "spelling"].includes(old.lastPractice) ? old.lastPractice : "choice";
    next.lastAnswerCorrect = old.lastAnswerCorrect === true;
  }
  return next;
}

export function answerProgress(previous, correct, practice, now = Date.now()) {
  if (typeof correct !== "boolean" || !ANSWERED.includes(practice)) throw new Error("Invalid exercise answer");
  const old = object(previous) ? previous : {};
  const next = gradeProgress(old, correct ? "good" : "again", now);
  next.answers = integer(old.answers, 0, 999999) + 1;
  next.correctAnswers = Math.min(next.answers, integer(old.correctAnswers, 0, next.answers - 1) + Number(correct));
  next.lastPractice = practice;
  next.lastAnswerCorrect = correct;
  return next;
}

function cleanAttempt(value) {
  if (!object(value) || !ANSWERED.includes(value.practice) || typeof value.correct !== "boolean"
      || typeof value.response !== "string" || value.response.length > 300) return null;
  return { practice: value.practice, response: value.response, correct: value.correct, answeredAt: Math.max(0, finite(value.answeredAt)) };
}

function cleanState(value) {
  const raw = object(value) ? value : {};
  const progress = Object.create(null);
  if (object(raw.progress)) for (const [id, entry] of Object.entries(raw.progress)) {
    if (!id || id.length > 100 || !object(entry) || !(entry.seen > 0)) continue;
    progress[id] = { box: integer(entry.box, 0, 5), due: Math.max(0, finite(entry.due)),
      seen: integer(entry.seen, 1, 1000000), reviewedAt: Math.max(0, finite(entry.reviewedAt)) };
    if (Number.isInteger(entry.answers) && entry.answers > 0) {
      progress[id].answers = integer(entry.answers, 1, 1000000);
      progress[id].correctAnswers = integer(entry.correctAnswers, 0, progress[id].answers);
      progress[id].lastPractice = ["choice", "spelling"].includes(entry.lastPractice) ? entry.lastPractice : "choice";
      progress[id].lastAnswerCorrect = entry.lastAnswerCorrect === true;
    }
  }
  const candidate = raw.session;
  let session = null;
  if (object(candidate) && Array.isArray(candidate.ids) && candidate.ids.length > 0 && candidate.ids.length <= 30
      && candidate.ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 100)
      && new Set(candidate.ids).size === candidate.ids.length
      && Number.isInteger(candidate.index) && candidate.index >= 0 && candidate.index <= candidate.ids.length) {
    session = { ids: [...candidate.ids], index: candidate.index, revealed: candidate.revealed === true,
      ratings: Array.isArray(candidate.ratings) ? candidate.ratings.filter(row => object(row)
        && candidate.ids.includes(row.id) && ["good", "hard", "again"].includes(row.rating)).slice(0, candidate.ids.length)
        .map(row => ({ id: row.id, rating: row.rating, ...(cleanAttempt(row) || {}) })) : [],
      options: normalizeOptions(candidate.options), mode: candidate.mode === "review" ? "review" : "random",
      choices: Array.isArray(candidate.choices) ? candidate.choices.filter(id => typeof id === "string" && id.length <= 100).slice(0, 4) : [],
      draft: typeof candidate.draft === "string" ? candidate.draft.slice(0, 300) : "",
      attempt: cleanAttempt(candidate.attempt) };
  }
  return { options: normalizeOptions(raw.options), progress, session };
}

export function readStudyState(storage) {
  try { return cleanState(JSON.parse((storage ?? globalThis.localStorage).getItem(KEY))); }
  catch { return cleanState(null); }
}

export function saveStudyState(state, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(KEY, JSON.stringify({ schemaVersion: 1, ...cleanState(state) }));
    return true;
  } catch { return false; }
}

let bankPromise = null;
export function loadWordBank() {
  if (!bankPromise) bankPromise = (async () => {
    const [catalog, bank, contexts] = await Promise.all(["catalog.json", "words.json", "contexts.json"].map(async file => {
      const response = await fetch(new URL(`../vocabulary/${file}`, import.meta.url));
      if (!response.ok) throw new Error(`Word bank unavailable: ${file}`);
      return response.json();
    }));
    if (catalog.schemaVersion !== 1 || bank.schemaVersion !== 1 || !Array.isArray(bank.words)
        || contexts.schemaVersion !== 1 || !object(contexts.topics) || !object(contexts.scenarios)) {
      throw new Error("Unsupported word-bank format");
    }
    const topicSets = TOPICS.map(({ id }) => [id, new Set(contexts.topics[id] || [])]);
    const sceneSets = SCENARIOS.map(({ id }) => [id, new Set(contexts.scenarios[id] || [])]);
    const ids = new Set();
    const words = bank.words.map(word => {
      if (!object(word) || typeof word.id !== "string" || !word.id || ids.has(word.id)
          || typeof word.term !== "string" || !word.term.trim() || typeof word.meaning !== "string" || !word.meaning.trim()
          || !Array.isArray(word.exams) || word.exams.some(id => !DECKS.has(id) || id === "general")) {
        throw new Error("Invalid or duplicate word-bank entry");
      }
      ids.add(word.id);
      const term = word.term.toLowerCase();
      return { ...word, ipa: typeof word.ipa === "string" ? word.ipa : "",
        general: word.general === true,
        topics: topicSets.filter(([, set]) => set.has(term)).map(([id]) => id),
        scenarios: sceneSets.filter(([, set]) => set.has(term)).map(([id]) => id) };
    });
    if (!words.length) throw new Error("Word bank is empty");
    return { catalog, words };
  })().catch(error => { bankPromise = null; throw error; });
  return bankPromise;
}
