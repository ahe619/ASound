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
  };
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
  return { box, due: now + interval, seen: integer(old.seen, 0, 1000000) + 1, reviewedAt: now };
}

function cleanState(value) {
  const raw = object(value) ? value : {};
  const progress = Object.create(null);
  if (object(raw.progress)) for (const [id, entry] of Object.entries(raw.progress)) {
    if (!id || id.length > 100 || !object(entry) || !(entry.seen > 0)) continue;
    progress[id] = { box: integer(entry.box, 0, 5), due: Math.max(0, finite(entry.due)),
      seen: integer(entry.seen, 1, 1000000), reviewedAt: Math.max(0, finite(entry.reviewedAt)) };
  }
  const candidate = raw.session;
  let session = null;
  if (object(candidate) && Array.isArray(candidate.ids) && candidate.ids.length > 0 && candidate.ids.length <= 30
      && candidate.ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 100)
      && new Set(candidate.ids).size === candidate.ids.length
      && Number.isInteger(candidate.index) && candidate.index >= 0 && candidate.index <= candidate.ids.length) {
    session = { ids: [...candidate.ids], index: candidate.index, revealed: candidate.revealed === true,
      ratings: Array.isArray(candidate.ratings) ? candidate.ratings.filter(row => object(row)
        && candidate.ids.includes(row.id) && ["good", "hard", "again"].includes(row.rating)).slice(0, candidate.ids.length) : [],
      options: normalizeOptions(candidate.options), mode: candidate.mode === "review" ? "review" : "random" };
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
