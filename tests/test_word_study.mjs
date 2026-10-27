import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TOPICS, SCENARIOS, normalizeOptions, filterWords, chooseWords, gradeProgress, readStudyState, saveStudyState,
  meaningChoices, spellingCorrect, answerProgress, isAlternativeSpelling, spellingClue, isAlternativeSaying,
  sayCorrect, MAX_SPOKEN_RESPONSE_LENGTH } from "../app/js/word-study-core.js";

const words = [
  { id: "ticket", term: "ticket", general: true, exams: ["cet4", "cet6"], topics: ["travel"], scenarios: ["transport"] },
  { id: "menu", term: "menu", general: true, exams: ["cet4", "cet6"], topics: ["food"], scenarios: ["restaurant"] },
  { id: "reservation", term: "reservation", general: true, exams: ["cet6", "kaoyan"], topics: ["travel"], scenarios: ["hotel", "restaurant"] },
  { id: "abstract", term: "abstract", general: false, exams: ["kaoyan"], topics: ["study"], scenarios: ["campus"] },
];
const ids = rows => rows.map(row => row.id).sort();
const memory = () => { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }; };

test("empty topic and scene allow all words in the chosen deck; either optional filter works independently", () => {
  assert.deepEqual(ids(filterWords(words, {})), ["menu", "reservation", "ticket"]);
  assert.deepEqual(ids(filterWords(words, { topic: "travel" })), ["reservation", "ticket"]);
  assert.deepEqual(ids(filterWords(words, { scenario: "restaurant" })), ["menu", "reservation"]);
});

test("combined filters are intersected and exam membership is never broadened", () => {
  assert.deepEqual(ids(filterWords(words, { topic: "travel", scenario: "restaurant" })), ["reservation"]);
  assert.deepEqual(filterWords(words, { topic: "travel", scenario: "campus" }), []);
  assert.deepEqual(ids(filterWords(words, { deck: "kaoyan" })), ["abstract", "reservation"]);
  assert.deepEqual(filterWords(words, { deck: "cet4", topic: "travel", scenario: "restaurant" }), []);
});

test("random batches are shuffled without duplicates or mutation, including a small or empty pool", () => {
  const large = Array.from({ length: 50 }, (_, n) => ({ ...words[0], id: `word${n}` }));
  const original = [...large];
  const batch = chooseWords([...large, large[0]], { size: 10 }, { rng: () => 0.15 });
  assert.equal(batch.length, 10);
  assert.equal(new Set(batch.map(row => row.id)).size, 10);
  assert.notDeepEqual(batch, large.slice(0, 10));
  assert.deepEqual(large, original);
  assert.equal(chooseWords(words, {}, { rng: () => 0 }).length, 3);
  assert.deepEqual(chooseWords(words, { topic: "sports" }), []);
});

test("review selects only studied words whose due time has arrived within the chosen filters", () => {
  const progress = { ticket: { seen: 1, due: 100 }, menu: { seen: 2, due: 201 }, reservation: { seen: 3, due: 0 } };
  assert.deepEqual(ids(chooseWords(words, {}, { mode: "review", progress, now: 200 })), ["reservation", "ticket"]);
  assert.deepEqual(chooseWords(words, { deck: "cet4", scenario: "restaurant" }, { mode: "review", progress, now: 200 }), []);
  assert.deepEqual(chooseWords(words, {}, { mode: "review", progress: {}, now: 200 }), []);
});

test("spaced review separates good, hard and again and caps the longest interval", () => {
  const now = 1000;
  const good = gradeProgress(null, "good", now);
  assert.deepEqual(good, { box: 1, due: now + 86400000, seen: 1, reviewedAt: now });
  const again = gradeProgress({ box: 5, seen: 8 }, "again", now);
  assert.equal(again.box, 0);
  assert.equal(again.due, now + 600000);
  assert.equal(again.seen, 9);
  assert.equal(gradeProgress({ box: 4 }, "hard", now).due, now + 86400000);
  assert.equal(gradeProgress({ box: 5 }, "good", now).due, now + 30 * 86400000);
  assert.throws(() => gradeProgress({}, "invalid"));
});

test("session and review progress survive one atomic storage write without touching the old vocabulary book", () => {
  const storage = memory();
  storage.setItem("asound.vocab.v1", "existing-book");
  const state = { options: { deck: "cet6", topic: "travel", size: 10 }, progress: { ticket: gradeProgress(null, "good", 100) },
    session: { ids: ["ticket", "reservation"], index: 1, revealed: true, ratings: [{ id: "ticket", rating: "good" }],
      options: { deck: "cet6", topic: "travel", size: 10 }, mode: "random" } };
  assert.equal(saveStudyState(state, storage), true);
  const restored = readStudyState(storage);
  assert.deepEqual(restored.session.ids, state.session.ids);
  assert.equal(restored.session.index, 1);
  assert.equal(restored.session.revealed, true);
  assert.deepEqual(restored.session.ratings, state.session.ratings);
  assert.equal(restored.progress.ticket.due, state.progress.ticket.due);
  assert.equal(storage.getItem("asound.vocab.v1"), "existing-book");
});

test("malformed saved data recovers safely and blocked/full storage reports failure", () => {
  assert.deepEqual(normalizeOptions({ deck: "invented", topic: "unknown", scenario: "unknown", size: -5 }), normalizeOptions());
  assert.equal(readStudyState({ getItem: () => "broken json" }).session, null);
  assert.equal(readStudyState({ getItem: () => JSON.stringify({ session: { ids: ["ticket", "ticket"], index: 1 } }) }).session, null);
  assert.equal(saveStudyState({}, { setItem: () => { throw new Error("QuotaExceededError"); } }), false);
  assert.equal(readStudyState({ getItem: () => { throw new Error("SecurityError"); } }).session, null);
});

test("word bank loading retries a failed request and joins editorial topics without altering exam labels", async () => {
  const { loadWordBank } = await import(`../app/js/word-study-core.js?loader-test=${Date.now()}`);
  const realFetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async url => {
    if (fail) return new Response("unavailable", { status: 503 });
    const filename = new URL(url).pathname.split("/").pop();
    const data = filename === "catalog.json" ? { schemaVersion: 1, source: { name: "Fixture" } }
      : filename === "words.json" ? { schemaVersion: 1, words: [{ ...words[0], meaning: "票" }] }
        : { schemaVersion: 1, topics: { travel: ["ticket"] }, scenarios: { hotel: ["ticket"] } };
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  };
  try {
    await assert.rejects(loadWordBank(), /unavailable/);
    fail = false;
    const bank = await loadWordBank();
    assert.deepEqual(bank.words[0].topics, ["travel"]);
    assert.deepEqual(bank.words[0].scenarios, ["hotel"]);
    assert.deepEqual(bank.words[0].exams, ["cet4", "cet6"]);
  } finally { globalThis.fetch = realFetch; }
});

test("real bundled word bank has unique entries, documented sources and correct declared deck totals", async () => {
  const read = async name => JSON.parse(await readFile(new URL(`../app/vocabulary/${name}`, import.meta.url), "utf8"));
  const [bank, catalog, contexts] = await Promise.all([read("words.json"), read("catalog.json"), read("contexts.json")]);
  const strings = JSON.parse(await readFile(new URL("../app/locales/feat/word-study.json", import.meta.url), "utf8"));
  assert.equal(new Set(bank.words.map(word => word.id)).size, bank.words.length);
  assert.ok(bank.words.every(word => word.term && word.meaning && Array.isArray(word.exams)));
  assert.ok(catalog.source.url.startsWith("https://"));
  for (const [file, expected] of [["words.json", catalog.wordsSha256], ["contexts.json", catalog.contextsSha256],
    ["cet-2016-index.json", catalog.cetPDF.indexSha256]]) {
    const bytes = await readFile(new URL(`../app/vocabulary/${file}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `${file} provenance hash`);
  }
  assert.equal(bank.words.find(word => word.id === "philip")?.general ?? false, false);
  assert.ok(bank.words.find(word => word.term === "appropriation")?.exams.includes("cet6"));
  assert.equal(bank.words.find(word => word.term === "appropriation")?.exams.includes("cet4"), false);
  assert.ok(bank.words.find(word => word.term === "cheque")?.exams.includes("cet4"));
  for (const deck of catalog.decks) {
    assert.equal(filterWords(bank.words, { deck: deck.id }).length, deck.count, `${deck.id} count`);
    assert.ok(deck.count > 1000, `${deck.id} must be a real word bank, not a short generated sample`);
  }
  for (const rows of Object.values(contexts.topics)) assert.ok(rows.length >= 30);
  for (const rows of Object.values(contexts.scenarios)) assert.ok(rows.length >= 30);
  for (const entry of [...TOPICS, ...SCENARIOS]) {
    assert.ok(strings.en[entry.key] && strings.zh[entry.key], `Missing label: ${entry.key}`);
    assert.ok((contexts.topics[entry.id] || contexts.scenarios[entry.id])?.length, `Missing context: ${entry.id}`);
  }
});

test("multiple choice keeps one correct definition and up to three unique real distractors", () => {
  const target = { id: "bridge", term: "bridge", meaning: "n. 桥" };
  const pool = [target, { id: "same", meaning: " n. 桥 " }, { id: "harvest", meaning: "n. 收获" },
    { id: "balance", meaning: "n. 平衡" }, { id: "ticket", meaning: "n. 票" }, { id: "empty", meaning: "" }];
  const result = meaningChoices(target, pool, () => 0.3);
  assert.equal(result.length, 4);
  assert.equal(result.filter(row => row.id === target.id).length, 1);
  assert.equal(new Set(result.map(row => row.meaning.trim())).size, 4);
  assert.ok(result.every(row => pool.includes(row)));
  assert.equal(meaningChoices(target, pool.slice(0, 2)).length, 1, "do not fabricate distractors for a tiny pool");
  assert.equal(meaningChoices(target, pool.slice(0, 3)).length, 2);
});

test("distractors favour look-alike words and the same part of speech", () => {
  const target = { id: "adapt", term: "adapt", meaning: "vt. 使适应" };
  const pool = [target,
    { id: "adopt", term: "adopt", meaning: "vt. 采纳" },
    { id: "adept", term: "adept", meaning: "adj. 熟练的" },
    { id: "run", term: "run", meaning: "vi. 跑" },
    { id: "table", term: "table", meaning: "n. 桌子" },
    { id: "happy", term: "happy", meaning: "adj. 快乐的" },
    { id: "apple", term: "apple", meaning: "n. 苹果" }];
  for (let seed = 0; seed < 5; seed++) {
    let n = seed;
    const result = ids(meaningChoices(target, pool, () => ((n = (n * 9301 + 49297) % 233280) / 233280)));
    assert.ok(result.includes("adopt") && result.includes("adept"), result.join());
    assert.ok(result.includes("run"), "a verb is preferred over nouns and adjectives: " + result.join());
  }
});

test("spelling accepts case and boundary whitespace, without forgiving wrong letters or punctuation", () => {
  for (const answer of ["bridge", "BRIDGE", " BrIdGe  ", "\tbridge\n"]) assert.equal(spellingCorrect(answer, "bridge"), true);
  for (const answer of ["", "bridg", "bridges", "br idge", "bridge!", "bridge road"]) assert.equal(spellingCorrect(answer, "bridge"), false);
  assert.equal(spellingCorrect("ice  cream", "ice cream"), false);
  assert.equal(spellingCorrect("reenter", "re-enter"), false);
  assert.equal(spellingCorrect("cafe", "café"), false);
  assert.equal(spellingCorrect("cafe\u0301", "café"), true, "canonical Unicode form is not a misspelling");
});

test("objective correctness is recorded separately from self-ratings and survives storage", () => {
  const correct = answerProgress(null, true, "choice", 100);
  assert.equal(correct.answers, 1); assert.equal(correct.correctAnswers, 1);
  const incorrect = answerProgress(correct, false, "spelling", 200);
  assert.equal(incorrect.answers, 2); assert.equal(incorrect.correctAnswers, 1);
  assert.equal(incorrect.lastAnswerCorrect, false); assert.equal(incorrect.due, 600200);
  const recalled = gradeProgress(incorrect, "good", 300);
  assert.equal(recalled.answers, 2); assert.equal(recalled.correctAnswers, 1);
  const storage = memory();
  saveStudyState({ progress: { bridge: recalled } }, storage);
  assert.deepEqual(readStudyState(storage).progress.bridge, recalled);
  assert.throws(() => answerProgress(null, true, "invented"));
});

test("real dictionary alternatives are recognized without declaring target spelling correct", async () => {
  const bank = JSON.parse(await readFile(new URL("../app/vocabulary/words.json", import.meta.url), "utf8")).words;
  for (const [target, alternative] of [["clothes", "clothing"], ["color", "colour"], ["eventually", "finally"]]) {
    const word = bank.find(row => row.term === target);
    assert.equal(isAlternativeSpelling(alternative, word, bank), true);
    assert.equal(isAlternativeSpelling(` ${alternative.toUpperCase()} `, word, bank), true);
    assert.equal(spellingCorrect(alternative, target), false, "accepting a different valid word must not establish target recall");
    assert.equal(isAlternativeSpelling(target, word, bank), false);
    assert.equal(isAlternativeSpelling(`${alternative}!`, word, bank), false);
    assert.equal(isAlternativeSpelling("bridge", word, bank), false);
    assert.equal(isAlternativeSaying(`I think the word is ${alternative}.`, word, bank), true);
    assert.equal(isAlternativeSaying(`I think the word is ${target}.`, word, bank), false);
    assert.equal(isAlternativeSaying("I think the word is bridge.", word, bank), false);
  }
  assert.deepEqual(spellingClue("clothes"), { first: "c", count: 7 });
  assert.deepEqual(spellingClue("colour"), { first: "c", count: 6 });
  assert.deepEqual(spellingClue("café"), { first: "c", count: 4 });
  assert.deepEqual(spellingClue("ice cream"), { first: "i", count: 8 });
  assert.deepEqual(spellingClue("I"), { first: "", count: 1 }, "a clue must not reveal a complete one-letter target");
});

test("spoken responses longer than typed spelling fields survive feedback and completed-session reloads", () => {
  const storage = memory(), options = normalizeOptions({ practice: "say", deck: "cet4" });
  const response = "I can see a bridge over the river and people who are enjoying a walk in the park. ".repeat(5);
  assert.ok(response.length > 300 && response.length < MAX_SPOKEN_RESPONSE_LENGTH);
  const attempt = { practice: "say", response, correct: sayCorrect(response, "bridge"), answeredAt: 100 };
  const state = { options, progress: { bridge: answerProgress(null, attempt.correct, "say", 100) },
    session: { ids: ["bridge"], index: 0, revealed: true, ratings: [], options, attempt, draft: "" } };
  saveStudyState(state, storage);
  assert.deepEqual(readStudyState(storage).session.attempt, attempt);
  assert.equal(readStudyState(storage).progress.bridge.answers, 1);
  state.session.index = 1; state.session.attempt = null;
  state.session.ratings = [{ id: "bridge", rating: "good", ...attempt }];
  saveStudyState(state, storage);
  assert.equal(readStudyState(storage).session.ratings[0].response, response);
  assert.equal(readStudyState(storage).session.ratings[0].correct, true);
  state.session.draft = response;
  saveStudyState(state, storage);
  assert.equal(readStudyState(storage).session.draft, response);
});

test("quiz choices, typing draft and already-graded feedback restore atomically", () => {
  const storage = memory();
  const options = normalizeOptions({ practice: "spelling" });
  const attempt = { practice: "spelling", response: " BrIdGe ", correct: true, answeredAt: 100 };
  const state = { options, progress: { bridge: answerProgress(null, true, "spelling", 100) },
    session: { ids: ["bridge", "ticket"], index: 0, revealed: true, ratings: [], options, choices: [], draft: "", attempt } };
  saveStudyState(state, storage);
  const loaded = readStudyState(storage);
  assert.deepEqual(loaded.session.attempt, attempt);
  assert.equal(loaded.session.index, 0);
  assert.equal(loaded.progress.bridge.answers, 1);
  state.session.attempt = null; state.session.revealed = false; state.session.draft = " br";
  saveStudyState(state, storage);
  assert.equal(readStudyState(storage).session.draft, " br");
  state.session.options.practice = "choice"; state.session.choices = ["ticket", "bridge"];
  saveStudyState(state, storage);
  assert.deepEqual(readStudyState(storage).session.choices, ["ticket", "bridge"]);
});

test("legacy options still default to flashcards and objective fields are bounded", () => {
  assert.equal(normalizeOptions({ deck: "cet4" }).practice, "cards");
  assert.equal(normalizeOptions({ practice: "invented" }).practice, "cards");
  const storage = memory();
  saveStudyState({ progress: { bridge: { seen: 2, answers: 2, correctAnswers: 999 } } }, storage);
  assert.equal(readStudyState(storage).progress.bridge.correctAnswers, 2);
});

test("say-it accepts the word inside a sentence and simple inflections, but not a different word", async () => {
  const { sayCorrect, answerProgress } = await import("../app/js/word-study-core.js");
  assert.equal(sayCorrect("Apple.", "apple"), true);
  assert.equal(sayCorrect("I think it's an apple", "apple"), true);
  assert.equal(sayCorrect("apples", "apple"), true);
  assert.equal(sayCorrect("baking", "bake"), true);
  assert.equal(sayCorrect("studied", "study"), true);
  assert.equal(sayCorrect("ice cream", "ice cream"), true);
  assert.equal(sayCorrect("ice-cream", "ice cream"), true);
  assert.equal(sayCorrect("a pineapple", "apple"), false);
  assert.equal(sayCorrect("map", "mop"), false);
  assert.equal(sayCorrect("stopped", "stop"), true);
  assert.equal(sayCorrect("boxes", "box"), true);
  assert.equal(sayCorrect("photos", "photo"), true);
  assert.equal(sayCorrect("potatoes", "potato"), true);
  assert.equal(sayCorrect("dying", "die"), true);
  assert.equal(sayCorrect("agreeing", "agree"), true);
  assert.equal(sayCorrect("scared", "scar"), false);
  assert.equal(sayCorrect("hoped", "hop"), false);
  assert.equal(sayCorrect("bed", "be"), false);
  assert.equal(sayCorrect("cares", "car"), false);
  assert.equal(sayCorrect("", "apple"), false);
  const progress = answerProgress({}, true, "say", 1000);
  assert.equal(progress.lastPractice, "say");
  assert.equal(progress.lastAnswerCorrect, true);
});
