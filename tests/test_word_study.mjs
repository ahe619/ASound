import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TOPICS, SCENARIOS, normalizeOptions, filterWords, chooseWords, gradeProgress, readStudyState, saveStudyState } from "../app/js/word-study-core.js";

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
