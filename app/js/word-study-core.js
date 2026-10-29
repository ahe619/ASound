// Local word-bank selection and spaced review. Exam membership comes only from the bundled source data.
export const TOPICS = ["travel", "food", "technology", "arts", "work", "study", "sports", "health"]
  .map(id => ({ id, key: `wstudy.topic.${id}` }));
export const SCENARIOS = ["restaurant", "shopping", "transport", "hotel", "workplace", "interview", "campus", "social"]
  .map(id => ({ id, key: `wstudy.scenario.${id}` }));
const DECKS = new Set(["general", "cet4", "cet6", "kaoyan"]);
const TOPIC_IDS = new Set(TOPICS.map(v => v.id));
const SCENARIO_IDS = new Set(SCENARIOS.map(v => v.id));
const KEY = "asound.wordstudy.v1";
export const STUDY_STATE_KEY = KEY;
const DAY = 86400000;
const INTERVALS = [0, 1, 3, 7, 14, 30];
export const PRACTICES = ["cards", "choice", "spelling", "say"];
const ANSWERED = ["choice", "spelling", "say"]; // practices checked automatically (cards are self-rated)
// Speech can be a full sentence; the microphone can return more than the typed field's 300 characters.
export const MAX_SPOKEN_RESPONSE_LENGTH = 2000;
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
    picturedOnly: value.picturedOnly === true,
  };
}

const meaningKey = value => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
export const normalizeSpelling = value => String(value ?? "").normalize("NFC").trim().toLowerCase();
export const spellingCorrect = (answer, term) => !!normalizeSpelling(answer) && normalizeSpelling(answer) === normalizeSpelling(term);

// "Say it": the recognizer's transcript must contain the word (or the phrase), allowing simple inflections of the
// last word (books, watched, making...). Speech recognition hears "ice-cream" or "ice cream" alike.
const sayWords = value => normalizeSpelling(value).replace(/[\u2019']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
// Regular English spelling rules only, so a different word is not taken for a form of the target ("scar" is not
// "scared", "be" is not "bed"). Words under three letters must be said as they are.
function inflections(base) {
  if (base.length < 3 || !/^[a-z]+$/.test(base)) return [];
  const forms = [];
  if (/[^aeiou]y$/.test(base)) {
    const y = base.slice(0, -1);
    return [y + "ies", y + "ied", base + "ing"];
  }
  forms.push(/(s|x|z|ch|sh)$/.test(base) ? base + "es" : base + "s");
  if (base.endsWith("o")) forms.push(base + "es"); // photos, potatoes
  if (base.endsWith("ie")) return forms.concat(base + "d", base.slice(0, -2) + "ying");
  if (base.endsWith("e")) return forms.concat(base + "d", /(ee|ye|oe)$/.test(base) ? base + "ing" : base.slice(0, -1) + "ing");
  // One-syllable consonant-vowel-consonant words double the last letter (stop: stopped, stopping).
  const end = /^[^aeiou]*[aeiou][bdgklmnprtvz]$/.test(base) ? base + base.slice(-1) : base;
  return forms.concat(end + "ed", end + "ing");
}
const inflected = (heard, base) => heard === base || inflections(base).includes(heard);
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

export function isAlternativeSaying(answer, word, pool) {
  if (!sayWords(answer).length || sayCorrect(answer, word.term)) return false;
  const definition = meaningKey(word.meaning);
  return !!definition && pool.some(candidate => candidate.id !== word.id
    && meaningKey(candidate.meaning) === definition && sayCorrect(answer, candidate.term));
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
  // Options that can be ruled out by their form teach nothing. Prefer up to two look-alike words (adapt: adopt,
  // adept), then words of the same part of speech, then any.
  const term = String(word.term || "").toLowerCase(), pos = partOfSpeech(word.meaning);
  const near = Math.max(1, Math.floor(term.length / 4));
  const lookAlike = [], samePos = [], rest = [];
  for (const candidate of shuffle(shuffled)) {
    if (!meaningKey(candidate.meaning) || candidate.id === word.id) continue;
    const other = String(candidate.term || "").toLowerCase();
    if (term.length >= 4 && other !== term && editDistance(term, other, near) <= near) lookAlike.push(candidate);
    else (pos && partOfSpeech(candidate.meaning) === pos ? samePos : rest).push(candidate);
  }
  const selected = [word];
  // The first line is what an option shows first: spelling variants (behaviour, behavior) share it and differ only
  // in a later line, so two options would both be right.
  const firstLine = value => "1:" + meaningKey(String(value || "").split("\n")[0]);
  const definitions = new Set([meaningKey(word.meaning), firstLine(word.meaning)]);
  const take = (rows, limit) => {
    for (const candidate of rows) {
      if (selected.length >= limit) return;
      const key = meaningKey(candidate.meaning), line = firstLine(candidate.meaning);
      if (definitions.has(key) || definitions.has(line)) continue;
      definitions.add(key); definitions.add(line); selected.push(candidate);
    }
  };
  take(lookAlike, 3);
  take(samePos, 4);
  take(rest, 4);
  return shuffle(selected);
}

// "vt. ..." -> "v"; the first part of speech in a dictionary definition.
const partOfSpeech = meaning => {
  const tag = (String(meaning || "").match(/^\s*([a-z]+)\./) || [])[1] || "";
  return /^v[ti]?$/.test(tag) ? "v" : tag;
};

// Levenshtein distance, stopping early once it is certainly above `limit`.
function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (next[j] < best) best = next[j];
    }
    if (best > limit) return limit + 1;
    row = next;
  }
  return row[b.length];
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
    next.lastPractice = ANSWERED.includes(old.lastPractice) ? old.lastPractice : "choice";
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
      || typeof value.response !== "string" || value.response.length > (value.practice === "say" ? MAX_SPOKEN_RESPONSE_LENGTH : 300)) return null;
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
      progress[id].lastPractice = ANSWERED.includes(entry.lastPractice) ? entry.lastPractice : "choice";
      progress[id].lastAnswerCorrect = entry.lastAnswerCorrect === true;
    }
  }
  const candidate = raw.session;
  let session = null;
  if (object(candidate) && Array.isArray(candidate.ids) && candidate.ids.length > 0 && candidate.ids.length <= 30
      && candidate.ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 100)
      && new Set(candidate.ids).size === candidate.ids.length
      && Number.isInteger(candidate.index) && candidate.index >= 0 && candidate.index <= candidate.ids.length) {
    const options = normalizeOptions(candidate.options);
    session = { ids: [...candidate.ids], index: candidate.index, revealed: candidate.revealed === true,
      ratings: Array.isArray(candidate.ratings) ? candidate.ratings.filter(row => object(row)
        && candidate.ids.includes(row.id) && ["good", "hard", "again"].includes(row.rating)).slice(0, candidate.ids.length)
        .map(row => ({ id: row.id, rating: row.rating, ...(cleanAttempt(row) || {}) })) : [],
      options, mode: candidate.mode === "review" ? "review" : "random",
      choices: Array.isArray(candidate.choices) ? candidate.choices.filter(id => typeof id === "string" && id.length <= 100).slice(0, 4) : [],
      draft: typeof candidate.draft === "string" ? candidate.draft.slice(0, options.practice === "say" ? MAX_SPOKEN_RESPONSE_LENGTH : 300) : "",
      attempt: cleanAttempt(candidate.attempt) };
  }
  return { options: normalizeOptions(raw.options), progress, session };
}

export function readStudyState(storage) {
  try { return cleanState(JSON.parse((storage ?? globalThis.localStorage).getItem(KEY))); }
  catch { return cleanState(null); }
}

// Keep the entry with more reviews of each word; reviewedAt only breaks a tie. Every review builds on the merged
// entry and adds one to seen, so this window's own later review wins even after the device clock moved back.
// Progress entries are never deleted, so merging cannot bring back removed work. Returns whether target changed.
export function mergeProgress(target, source) {
  let changed = false;
  for (const [id, entry] of Object.entries(source)) {
    const mine = target[id];
    if (!mine || entry.seen > mine.seen || (entry.seen === mine.seen && entry.reviewedAt > mine.reviewedAt)) {
      target[id] = entry;
      changed = true;
    }
  }
  return changed;
}

export function saveStudyState(state, storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    const next = cleanState(state);
    // Another window (a second tab, or the installed app beside a browser tab) may have saved newer progress.
    let stored = null;
    try { stored = cleanState(JSON.parse(store.getItem(KEY))); } catch { /* nothing readable stored */ }
    if (stored) mergeProgress(next.progress, stored.progress);
    store.setItem(KEY, JSON.stringify({ schemaVersion: 1, ...next }));
    if (object(state) && object(state.progress)) Object.assign(state.progress, next.progress);
    return true;
  } catch { return false; }
}

let lockDatabase = null;
function databaseLock(action, indexedDB) {
  if (!indexedDB?.open) return Promise.reject(new Error("Study storage locking is unavailable"));
  if (!lockDatabase) lockDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open("asound-study-write-lock", 1);
    let expired = false;
    const timer = setTimeout(() => fail(new Error("Study storage is busy")), 5000);
    const fail = error => { expired = true; clearTimeout(timer); reject(error); };
    request.onupgradeneeded = () => { request.result.createObjectStore("lock"); };
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new Error("Study storage is blocked"));
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) { request.result.close(); return; }
      const db = request.result;
      db.onversionchange = () => { db.close(); lockDatabase = null; };
      resolve(db);
    };
  }).catch(error => { lockDatabase = null; throw error; });
  return lockDatabase.then(db => new Promise((resolve, reject) => {
    // IndexedDB serializes readwrite transactions across tabs. Only the lock lives
    // here; all learning data remains in its existing localStorage entry.
    const tx = db.transaction("lock", "readwrite");
    let result, failure, completed = false;
    tx.oncomplete = () => resolve(result);
    // The durable write is localStorage. A later failure of this empty lock
    // transaction cannot undo it and must not invite a duplicate review retry.
    tx.onabort = tx.onerror = () => completed ? resolve(result) : reject(failure || tx.error || new Error("Study storage failed"));
    const request = tx.objectStore("lock").get("guard");
    request.onsuccess = () => {
      try { result = action(); completed = true; } catch (error) { failure = error; tx.abort(); }
    };
  }));
}

// Every UI write uses this transaction, including draft/setup saves. The optional
// mutation runs synchronously after reading current progress, so two simultaneous
// reviews each build on the preceding review instead of competing snapshots.
// true: committed; null: stale UI operation skipped; false: storage unavailable.
export async function commitStudyState(state, mutate = null, options = {}) {
  try {
    const store = options.storage ?? globalThis.localStorage;
    const action = () => {
      const next = cleanState(state);
      let stored;
      // A failed read must not be mistaken for empty data and overwrite progress.
      const raw = store.getItem(KEY);
      try { stored = cleanState(JSON.parse(raw)); } catch { stored = cleanState(null); }
      mergeProgress(next.progress, stored.progress);
      if (mutate && mutate(next) === false) return null;
      store.setItem(KEY, JSON.stringify({ schemaVersion: 1, ...next }));
      Object.assign(state.progress, next.progress);
      // Keep the live session identity: input handlers and navigation own this
      // object. Failed writes leave both the question and its answer unmodified.
      if (mutate) {
        if (state.session && next.session) Object.assign(state.session, next.session);
        else state.session = next.session;
      }
      return true;
    };
    const locks = Object.prototype.hasOwnProperty.call(options, "locks") ? options.locks : globalThis.navigator?.locks;
    if (locks?.request) return await locks.request(KEY, { mode: "exclusive" }, action);
    return await databaseLock(action, options.indexedDB ?? globalThis.indexedDB);
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
