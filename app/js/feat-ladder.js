// Reduction Ladder: hear one everyday sentence the way Americans say it fast, type the full words you caught,
// then step down a 4-rung ladder of the same sentence in the same voice (fast casual, reduced, linked, careful),
// climb back up until you catch it at full speed, and finally say the fast version yourself.
// The reductions are plain text rewrite rules (no AI). A per-rule profile picks the next sentences.
import { prefs, levelById } from "./state.js";
import { h, fill, icon, str, isObj, arr, toast, thinkingDots, meter, readJSON, writeJSON } from "./util.js";
import { t } from "./i18n.js";
import { askJSON, aiErrorText } from "./ai.js";
import { helpLangName } from "./prompts.js";
import { tokens, normTok, diffOps, readingMatch } from "./diff.js";
import { renderSpeech, audioContext, unlockAudio, stopSpeaking, paintSpeak } from "./speech.js";
import { micButton } from "./mic.js";
import { saveBtn, confirmInline, levelName } from "./widgets.js";

export const meta = { id: "ladder", where: "accent", icon: "wave" };

const KEY = "asound.ladder.v1";

/* ====================== reduction rules ====================== */

// Words a reduction may follow ("tell 'em", "see ya") and -ing verbs that drop the g.
const VERBS = new Set(("tell told call called ask asked give gave get got let see saw help show take took bring put send sent "
  + "meet text invite like love need find keep make buy try check grab leave pick throw thank pay owe miss bet hear catch hold "
  + "stop follow wake drop join trust remind teach email").split(" "));
// (no comin', makin', takin': the voice reads them "common", "mac and", "tacking" - see the voice check below)
const ING = new Set(("going doing getting trying looking talking thinking working kidding saying waiting "
  + "running playing telling feeling sitting leaving").split(" "));
const DET = new Set("the a an my your his her our their its this that these those".split(" "));
const PLACE = new Set("school work bed class church college town".split(" "));
const WH = new Set("what why how if where who when whether about".split(" "));
const AND_SKIP = new Set("i you he she we they it the a an then so but or".split(" "));

const toVerb = (c) => !!c.next && !DET.has(c.next);              // "want to + verb", not "to the ..."
const toAction = (c) => toVerb(c) && !PLACE.has(c.next);           // "going to work" is a place, not a plan
const afterVerb = (c) => VERBS.has(c.prev) && !endsPunct(c.prevRaw);
const dunnoOk = (c) => !c.next || WH.has(c.next);                  // "I dunno." / "I dunno what ..."
const shortWord = (w) => /^[a-z]{2,6}$/.test(w) && !AND_SKIP.has(w);
const shortPair = (c) => shortWord(c.prev) && shortWord(c.next) && !endsPunct(c.prevRaw); // rock 'n' roll

// out: how the fast form is written for the learner. say: the spelling sent to the voice, when `out` reads badly.
// Voice check (Kokoro af_heart through the local server at rates 1.0 and 1.2, read back by the Moonshine
// recognizer with half a second of silence around the clip; done with renderSpeech + ASoundMic.transcribe):
//   kept as written: wanna, gonna, gotta, hafta, kinda, sorta, a lotta, outta, lemme, gimme, dunno, didja, wouldja,
//     couldja, whaddaya, gotcha, prob'ly, 'cause, 'n', ya, and the -in' forms in ING (goin', doin', talkin', tryin',
//     lookin', thinkin', workin', kiddin', sayin', waitin', runnin', playin', tellin', feelin', sittin', leavin',
//     gettin'): the recognizer heard the intended words (or the same reduced spelling) back.
//   whatcha: heard back as "what you're" / "watch a" - those are the right sounds (the lexicon has whatcha as
//     "wuh-chuh"); the recognizer just cannot spell it, so it stays.
//   'em: heard back as "M" / "him" / "them" - the right sound (a weak "um"; the lexicon reads 'em as /schwa-m/), so it stays.
//   dropped from ING: comin' ("common"), makin' ("mac and"), takin' ("tacking") - the voice guesses the wrong vowel.
//   hasta: read as "haste-a" (wrong vowel), so the voice gets "hassta", which was heard back as "has to".
//   whaddya (rejected spelling): came back as "Wadia" / "why do you", so the rule uses whaddaya.
export const RULES = [
  { id: "whaddaya", seq: "what do you", out: "whaddaya" },
  { id: "whatcha", seq: "what are you", out: "whatcha" },
  { id: "lotta", seq: "a lot of", out: "a lotta" },
  { id: "wanna", seq: "want to", out: "wanna", when: toVerb },
  { id: "gonna", seq: "going to", out: "gonna", when: toAction },
  { id: "gotta", seq: "got to", out: "gotta", when: toAction },
  { id: "hafta", seq: "have to", out: "hafta", when: toVerb },
  { id: "hasta", seq: "has to", out: "hasta", say: "hassta", when: toVerb },
  { id: "kinda", seq: "kind of", out: "kinda" },
  { id: "sorta", seq: "sort of", out: "sorta" },
  { id: "outta", seq: "out of", out: "outta" },
  { id: "lemme", seq: "let me", out: "lemme" },
  { id: "gimme", seq: "give me", out: "gimme" },
  { id: "dunno", seq: "don't know", out: "dunno", when: dunnoOk },
  { id: "didja", seq: "did you", out: "didja" },
  { id: "wouldja", seq: "would you", out: "wouldja" },
  { id: "couldja", seq: "could you", out: "couldja" },
  { id: "gotcha", seq: "got you", out: "gotcha" },
  { id: "em", seq: "them", out: "'em", when: afterVerb },
  { id: "cause", seq: "because", out: "'cause" },
  { id: "probly", seq: "probably", out: "prob'ly" },
  { id: "n", seq: "and", out: "'n'", when: shortPair },
  { id: "ya", seq: "you", out: "ya", when: afterVerb },
  { id: "in", test: (w) => ING.has(w), out: (w) => w.slice(0, -1) + "'", label: "-ing \u2192 -in'" },
].map((r) => ({ ...r, seq: r.seq ? r.seq.split(" ") : null }));
const ruleById = (id) => RULES.find((r) => r.id === id);
export const ruleLabel = (r) => r.label || `${r.seq.join(" ")} \u2192 ${r.out}`;

// What the local model is asked to include, per rule.
const HINT = {
  wanna: "want to", gonna: "going to (+ verb)", gotta: "have got to", hafta: "have to", hasta: "has to", kinda: "kind of",
  sorta: "sort of", lotta: "a lot of", outta: "out of", lemme: "let me", gimme: "give me", dunno: "I don't know",
  didja: "did you", wouldja: "would you", couldja: "could you", whaddaya: "what do you", whatcha: "what are you",
  gotcha: "got you", em: "them right after a verb (tell them)", cause: "because", probly: "probably",
  n: "and between two short words (salt and pepper)", ya: "you right after a verb (see you)", in: "an -ing verb (doing, trying)",
};

const norm = (w) => w.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
const endsPunct = (w) => /[^A-Za-z0-9'\u2019]$/.test(w || "");
const lead = (w) => w.match(/^[^A-Za-z0-9]*/)[0];
const trail = (w) => w.match(/[^A-Za-z0-9']*$/)[0];

// reduce(text) -> {text, raw: tokens, spans: [{id, from, to}], rules: [ids]}. Longer rules win; a word is used once.
export function reduce(text) {
  const raw = tokens(text), low = raw.map(norm), used = raw.map(() => false), spans = [];
  for (const r of RULES) {
    const n = r.seq ? r.seq.length : 1;
    for (let i = 0; i + n <= raw.length; i++) {
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        const w = low[i + k];
        ok = !used[i + k] && (r.seq ? w === r.seq[k] : r.test(w)) && (k === n - 1 || !endsPunct(raw[i + k]));
      }
      if (!ok) continue;
      const last = raw[i + n - 1];
      const c = { prev: low[i - 1] || "", prevRaw: raw[i - 1] || "", next: endsPunct(last) ? "" : low[i + n] || "" };
      if (r.when && !r.when(c)) continue;
      for (let k = 0; k < n; k++) used[i + k] = true;
      spans.push({ id: r.id, from: i, to: i + n - 1 });
    }
  }
  spans.sort((a, b) => a.from - b.from);
  return { text, raw, spans, rules: [...new Set(spans.map((s) => s.id))] };
}

// The sentence as parts [{text, span?}]: "written" keeps the words, "out" / "say" use the fast spellings.
function parts(red, how) {
  const out = [];
  for (let i = 0; i < red.raw.length; i++) {
    const sp = red.spans.find((s) => s.from === i);
    if (!sp) { out.push({ text: red.raw[i] }); continue; }
    i = sp.to;
    if (how === "written") { out.push({ text: red.raw.slice(sp.from, sp.to + 1).join(" "), span: sp }); continue; }
    const r = ruleById(sp.id), first = red.raw[sp.from], last = red.raw[sp.to];
    let w = how === "say" && r.say ? r.say : r.out;
    if (typeof w === "function") w = w(norm(first));
    if (/^[^A-Za-z]*[A-Z]/.test(first)) w = w.replace(/[a-z]/, (ch) => ch.toUpperCase());
    out.push({ text: lead(first) + w + trail(last), span: sp });
  }
  return out;
}
export const fastText = (text, how = "out") => parts(reduce(text), how).map((p) => p.text).join(" ");

/* ---------- scoring ---------- */

// Reduced spellings a learner (or the recognizer) may write, expanded only when the sentence has the full words.
const EXPAND = {
  wanna: "want to", gonna: "going to", gotta: "got to", hafta: "have to", hasta: "has to", kinda: "kind of", sorta: "sort of",
  lotta: "lot of", outta: "out of", lemme: "let me", gimme: "give me", dunno: "don't know", didja: "did you", didya: "did you",
  wouldja: "would you", wouldya: "would you", couldja: "could you", couldya: "could you", whaddaya: "what do you",
  whaddya: "what do you", whadaya: "what do you", whatcha: "what are you", watcha: "what are you", gotcha: "got you",
  em: "them", cause: "because", cuz: "because", coz: "because", probly: "probably", n: "and", ya: "you",
};
export function expandFor(said, target) {
  const tgt = ` ${tokens(target).map(normTok).filter(Boolean).join(" ")} `;
  const has = (full) => tgt.includes(` ${full.split(" ").map(normTok).join(" ")} `);
  return tokens(said).map((w) => {
    const k = normTok(w);
    let full = EXPAND[k];
    if (!full && /in$/.test(k) && has(k + "g")) full = k + "g";   // goin' -> going
    return full && has(full) ? full + trail(w) : w;
  }).join(" ");
}

// Compare what the learner wrote with the sentence: per-word hits, and which rules were caught.
export function score(red, said) {
  const ops = diffOps(expandFor(said, red.text), red.text);
  const hits = ops.filter(([k]) => k !== "del").map(([k]) => k === "eq");
  const counts = red.raw.map((w) => !!normTok(w));
  const total = counts.filter(Boolean).length || 1;
  const hit = hits.filter((x, i) => x && counts[i]).length;
  const caught = [], missed = [];
  for (const id of red.rules) {
    const ok = red.spans.filter((s) => s.id === id).every((s) => hits.slice(s.from, s.to + 1).every(Boolean));
    (ok ? caught : missed).push(id);
  }
  return { hit, total, pct: Math.round((100 * hit) / total), hits, caught, missed, all: hit === total };
}

/* ====================== sentences ====================== */

// Built-in sentences, tagged with the rules reduce() finds in them (checked by checkBank()).
export const BANK = [
  ["I don't know what you want to do tonight.", "dunno wanna"],
  ["What do you want to eat? I'm kind of hungry.", "whaddaya wanna kinda"],
  ["Let me know if you want to grab lunch.", "lemme wanna"],
  ["I'm going to call them after class.", "gonna em"],
  ["We've got to leave in five minutes, so let me grab my coat.", "gotta lemme"],
  ["Could you give me a hand with these boxes?", "couldja gimme"],
  ["Did you see what they're going to do?", "didja gonna"],
  ["What are you doing this weekend?", "whatcha in"],
  ["I have to finish this, because it's due tomorrow.", "hafta cause"],
  ["She has to work late, so she's probably going to miss it.", "hasta probly gonna"],
  ["There's a lot of traffic, so we're kind of late.", "lotta kinda"],
  ["Get out of here, you're kidding me!", "outta in"],
  ["Would you mind if I sit here? I'm just waiting for a friend.", "wouldja in"],
  ["I told you, it's sort of complicated.", "ya sorta"],
  ["Give me a second, I'm trying to find my keys.", "gimme in"],
  ["I don't know, it's probably nothing.", "dunno probly"],
  ["Did you tell them about the party?", "didja em"],
  ["Got you. I'll see you tomorrow then.", "gotcha ya"],
  ["What do you think? I kind of like it.", "whaddaya kinda"],
  ["I want to try the mac and cheese.", "wanna n"],
  ["We're going to need a lot of coffee.", "gonna lotta"],
  ["Let me get you some water.", "lemme ya"],
  ["You've got to see this, it's kind of amazing.", "gotta kinda"],
  ["Could you help me move this couch? It's sort of heavy.", "couldja sorta"],
  ["I have to admit, I'm probably wrong.", "hafta probly"],
  ["What are you looking at?", "whatcha in"],
  ["He has to leave early because his car is in the shop.", "hasta cause"],
  ["I'm not going to lie, that was kind of scary.", "gonna kinda"],
  ["Do you want to go out of town this weekend?", "wanna outta"],
  ["I owe you one. Let me buy you a coffee.", "ya lemme"],
  ["Did you get a lot of sleep last night?", "didja lotta"],
  ["Would you give me a call when you land?", "wouldja gimme"],
  ["I'm just sort of tired, and I don't know why.", "sorta dunno"],
  ["What are you going to do about it?", "whatcha gonna"],
  ["We have to get out of here before it rains.", "hafta outta"],
  ["Let me think about it, and I'll tell you tomorrow.", "lemme ya"],
  ["Rock and roll is kind of my thing.", "n kinda"],
  ["I'm going to be honest with you, I don't know.", "gonna dunno"],
  ["Could you tell them we're running late?", "couldja em in"],
  ["Give me five minutes, I'm probably going to be late.", "gimme probly gonna"],
  ["Did you want to come with us? We've got a lot of room.", "didja wanna lotta"],
  ["What do you mean you have to work Saturday?", "whaddaya hafta"],
  ["I've got to say, that was kind of fun.", "gotta kinda"],
  ["Oh, got you. Let me write that down.", "gotcha lemme"],
  ["She has to be home by ten, so let me drive.", "hasta lemme"],
  ["I want to watch that black and white movie.", "wanna n"],
  ["I'm staying in because I have to study.", "cause hafta"],
].map(([text, tags]) => ({ text, tags: tags.split(" "), src: "bank" }));

// Dev check: sentences whose tags differ from what the rules find.
export function checkBank() {
  return BANK.map((s) => ({ text: s.text, tags: s.tags, found: reduce(s.text).rules }))
    .filter((x) => x.tags.slice().sort().join() !== x.found.slice().sort().join());
}

/* ====================== learner data ====================== */

let data = null; // {profile: {ruleId: {seen, caught}}, history: [...], src: "bank" | "ai"}

function load() {
  const d = readJSON(KEY, null);
  const profile = {};
  if (isObj(d) && isObj(d.profile)) for (const r of RULES) {
    const p = d.profile[r.id];
    if (isObj(p)) profile[r.id] = { seen: Math.max(0, Number(p.seen) || 0), caught: Math.max(0, Number(p.caught) || 0) };
  }
  return { profile, history: arr(isObj(d) ? d.history : null).filter(isObj).slice(0, 40), src: isObj(d) && d.src === "ai" ? "ai" : "bank" };
}
const save = () => writeJSON(KEY, data);
const stat = (id) => data.profile[id] || { seen: 0, caught: 0 };
const weakness = (id) => { const p = stat(id); return 1 - (p.caught + 1) / (p.seen + 2); };   // unseen = 0.5

function record(red, res) {
  for (const id of red.rules) {
    const p = { ...stat(id) };
    p.seen++;
    if (res.caught.includes(id)) p.caught++;
    data.profile[id] = p;
  }
}

// Rules ordered weakest first (ties at random).
function weakestRules() {
  return RULES.map((r) => ({ id: r.id, v: weakness(r.id) + Math.random() * 0.05 })).sort((a, b) => b.v - a.v).map((x) => x.id);
}

// The built-in sentence that best trains the weakest rules, skipping recent ones.
function bankPick() {
  const recent = new Set(data.history.slice(0, 15).map((x) => x.text));
  let pool = BANK.filter((s) => !recent.has(s.text));
  if (pool.length < 5) pool = BANK;
  const rated = pool.map((s) => {
    const w = reduce(s.text).rules.map(weakness);
    return { s, v: Math.max(...w) + (0.3 * w.reduce((a, b) => a + b, 0)) / w.length + Math.random() * 0.12 };
  });
  rated.sort((a, b) => b.v - a.v);
  return { ...rated[0].s, meaning: "" };
}

/* ---------- a fresh sentence from the local model ---------- */

function aiPrompt(levelId, targets) {
  const l = levelById(levelId);
  return [
    `Write 3 different sentences that an American might say in a casual everyday conversation, for an English learner at level ${l.id} of 5 (${l.key}). ${l.guide}`,
    `Each sentence must contain at least two of these phrases, written out in full: ${targets.map((x) => JSON.stringify(HINT[x])).join(", ")}.`,
    "Each sentence: 6 to 16 words, standard spelling only (write going to, never gonna), no names, no digits, no quotation marks.",
    `Reply with only this JSON: {"sentences": [{"text": string, "meaning": string}]} where meaning is the translation in ${helpLangName()}.`,
  ].join("\n");
}

const REDUCED_SPELLING = /\b(gonna|wanna|gotta|kinda|sorta|lemme|gimme|dunno|outta|lotta|hafta|hasta|gotcha|whatcha|ya|cuz)\b|'em\b|'cause\b/i;
function validSentence(x) {
  const text = str(isObj(x) ? x.text : x).replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");
  const n = tokens(text).length;
  if (!/^[A-Za-z][A-Za-z ,.'?!-]*$/.test(text) || n < 5 || n > 18 || REDUCED_SPELLING.test(text)) return null;
  if (reduce(text).rules.length < 2) return null;
  return { text, meaning: isObj(x) ? str(x.meaning).slice(0, 240) : "", src: "ai" };
}

// Resolves when the promise does, or rejects {code: "cancelled"} as soon as the signal aborts.
function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject({ code: "cancelled" });
    if (signal.aborted) { stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

async function aiSentence(signal) {
  const weak = weakestRules().slice(0, 4);
  const o = await withAbort(askJSON(aiPrompt(prefs.level, weak), { signal, cache: false }), signal);
  const list = arr(o && o.sentences).map(validSentence).filter(Boolean);
  if (!list.length) return null;
  const v = (s) => reduce(s.text).rules.reduce((a, id) => a + weakness(id), 0);
  return list.sort((a, b) => v(b) - v(a))[0];
}

/* ====================== the mode ====================== */

const RUNGS = [
  { n: 1, fast: true, rate: 1.2 },   // fast casual: reduced text, quick
  { n: 2, fast: true, rate: 1.0 },   // reduced: same sounds, normal speed
  { n: 3, fast: false, rate: 1.0 },  // linked: full words, normal speed
  { n: 4, fast: false, rate: 0.8 },  // careful: full words, slow
];

let M = null; // the mounted mode: {root, onExit, alive, count, round, ctl}

export function mount(root, { onExit } = {}) {
  if (M) cleanup();
  data = load();
  const mounted = M = { root, onExit, alive: true, count: 0, round: null, ctl: null };
  renderHome();
  return () => { if (M === mounted) cleanup(); };
}

const alive = () => !!(M && M.alive && M.root.isConnected);
function scrollTop() { const v = M.root.closest(".view"); if (v) v.scrollTop = 0; }
// Stop a recording in progress before the screen is rebuilt; its transcript is then ignored.
function stopRec() { if (window.ASoundMic) window.ASoundMic.cancel(); }

function cleanup() {
  if (!M) return;
  M.alive = false;
  stopRec();
  stopAudio();
  stopSpeaking();
  if (M.ctl) M.ctl.abort();
  M = null;
  audioCache.clear();
}
function leave() {
  const done = M.onExit;
  cleanup();
  if (done) done();
}

/* ---------- audio: every rung in the same voice ---------- */

const audioCache = new Map();
let src = null, srcBtn = null, playSeq = 0;

const rungText = (round, n) => (RUNGS[n - 1].fast ? round.say : round.item.text);
function rungAudio(round, n) {
  const rate = RUNGS[n - 1].rate, text = rungText(round, n);
  const key = `${round.voice}|${rate}|${text}`;
  if (!audioCache.has(key)) {
    audioCache.set(key, renderSpeech(text, { voice: round.voice, rate }).catch((e) => { audioCache.delete(key); throw e; }));
  }
  return audioCache.get(key);
}
// Render all four rungs in the background, fastest first, so stepping down plays at once.
async function prefetch(round) {
  for (const r of RUNGS) {
    if (!M || M.round !== round || !M.alive) return;
    await rungAudio(round, r.n).catch(() => {});
  }
}

function stopAudio() {
  playSeq++;
  if (src) { try { src.onended = null; src.stop(); } catch {} src = null; }
  if (srcBtn) paintSpeak(srcBtn, false);
  srcBtn = null;
}

async function playRung(n, btn) {
  if (btn && btn === srcBtn) { stopAudio(); return; }
  unlockAudio();
  stopSpeaking();
  stopAudio();
  const mine = playSeq, round = M.round;
  srcBtn = btn || null;
  if (btn) paintSpeak(btn, true);
  try {
    const buf = await rungAudio(round, n);
    if (mine !== playSeq || !alive() || M.round !== round) return;
    const a = audioContext();
    const s = a.createBufferSource();
    s.buffer = buf;
    s.connect(a.destination);
    s.onended = () => { if (src === s) { src = null; if (srcBtn) paintSpeak(srcBtn, false); srcBtn = null; } };
    s.start();
    src = s;
  } catch (e) {
    console.warn(e);
    if (mine !== playSeq) return;
    if (btn) paintSpeak(btn, false);
    srcBtn = null;
    toast(t("ladder.err.voice"));
  }
}

function playBtn(n, caption) {
  const b = h("button", { type: "button", class: caption ? "btn speak" : "icon-btn sm speak", "data-label": t("ladder.playRung", { n }), "data-caption": caption || null });
  paintSpeak(b, false);
  b.addEventListener("click", () => playRung(n, b));
  return b;
}

/* ---------- home ---------- */

function renderHome() {
  if (!M.alive) return;
  stopRec();
  stopAudio();
  M.round = null;
  const seg = h("div", { class: "seg", role: "group", "aria-label": t("ladder.source") }, ["bank", "ai"].map((k) => h("button", {
    type: "button", "aria-pressed": String(data.src === k),
    onclick: () => { data.src = k; save(); renderHome(); },
  }, t(`ladder.src.${k}`))));
  fill(M.root,
    h("header", { class: "sum-head" },
      h("button", { type: "button", class: "btn quiet back", onclick: leave }, icon("back"), t("ladder.back")),
      h("p", { class: "eyebrow" }, t("ladder.eyebrow")),
      h("h1", { class: "title" }, t("ladder.title"))),
    h("p", { class: "lede" }, t("ladder.lede")),
    h("div", { class: "card" },
      rungList(null),
      h("div", { class: "stack-xs" },
        h("span", { class: "field-label" }, t("ladder.source")),
        seg,
        h("p", { class: "hint-line" }, data.src === "ai" ? t("ladder.srcHint.ai", { level: levelName(prefs.level) }) : t("ladder.srcHint.bank", { n: BANK.length }))),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn primary big", id: "ladder-start", onclick: startRound }, t("ladder.start")))),
    profileCard());
  scrollTop();
}

function profileCard() {
  const seen = RULES.filter((r) => stat(r.id).seen > 0);
  const order = [...seen.sort((a, b) => weakness(b.id) - weakness(a.id)), ...RULES.filter((r) => !stat(r.id).seen)];
  const reset = h("button", { type: "button", class: "mini" }, t("ladder.reset"));
  reset.addEventListener("click", () => confirmInline(reset, () => { data.profile = {}; data.history = []; save(); renderHome(); }));
  return h("section", { class: "card" },
    h("div", { class: "row" }, h("h2", { class: "sec" }, t("ladder.profile")), seen.length ? h("span", { class: "sec-tools" }, reset) : null),
    h("p", { class: "hint-line" }, seen.length ? t("ladder.profileLede", { n: data.history.length }) : t("ladder.profileEmpty")),
    h("ul", { class: "lad-prof" }, order.map((r) => {
      const p = stat(r.id), frac = p.seen ? p.caught / p.seen : 0;
      const band = !p.seen ? "new" : frac >= 0.8 ? "high" : frac >= 0.5 ? "mid" : "low";
      return h("li", { class: band, "data-rule": r.id },
        h("div", { class: "lad-prof-top" },
          h("span", { class: "lad-rule", lang: "en" }, ruleLabel(r)),
          p.seen ? meter(frac) : null,
          h("span", { class: "pill" }, p.seen ? t("ladder.caughtOf", { caught: p.caught, seen: p.seen }) : t("ladder.new"))),
        h("span", { class: "hint-line" }, t(`ladder.rule.${r.id}`)));
    })));
}

/* ---------- a round ---------- */

async function startRound() {
  const mounted = M;
  unlockAudio();
  stopSpeaking();
  stopRec();
  let item = null;
  if (data.src === "ai") {
    const ctl = (M.ctl = new AbortController());
    fill(M.root, h("div", { class: "loading-card" },
      h("p", null, t("ladder.writing"), thinkingDots()),
      h("button", { type: "button", class: "btn", onclick: () => ctl.abort() }, t("ladder.cancel"))));
    scrollTop();
    try {
      item = await aiSentence(ctl.signal);
      if (!item) toast(t("ladder.aiFallback"));
    } catch (e) {
      if (M !== mounted || !M.alive) return;
      if (e && e.code === "cancelled") { if (M.ctl === ctl) { M.ctl = null; renderHome(); } return; }
      console.warn(e);
      toast(`${aiErrorText(e)} ${t("ladder.aiFallback")}`);
    }
    if (M !== mounted || M.ctl !== ctl || !M.alive) return;
    M.ctl = null;
  }
  newRound(item || bankPick());
}

function newRound(item) {
  audioCache.clear();
  const red = reduce(item.text);
  const round = {
    n: ++M.count, item, red, voice: prefs.voice,
    say: parts(red, "say").map((p) => p.text).join(" "),
    phase: "listen",   // listen (rung 1 cold) | down | reveal | up | say
    rung: 1, deepest: 1, tries: 0, last: null, first: null, caughtAt: 0, upTries: 0, top: false, said: null, draft: "", entry: null,
  };
  M.round = round;
  prefetch(round);
  renderRound(true);
}

function goPhase(phase, rung) {
  const r = M.round;
  r.phase = phase;
  if (rung) r.rung = rung;
  r.last = null;
  renderRound(phase !== "reveal");
  scrollTop();
}

function phaseTitle(r) {
  if (r.phase === "reveal") return t("ladder.q.reveal");
  if (r.phase === "up") return r.rung === 1 ? t("ladder.q.top") : t("ladder.q.up");
  if (r.phase === "say") return t("ladder.q.say");
  return t("ladder.q.listen");
}

function renderRound(autoplay) {
  if (!alive()) return;
  stopRec();
  stopAudio();
  const r = M.round;
  const body = r.phase === "reveal" ? revealBody(r) : r.phase === "up" ? upBody(r) : r.phase === "say" ? sayBody(r) : downBody(r);
  fill(M.root,
    h("header", { class: "sum-head" },
      h("button", { type: "button", class: "btn quiet back", onclick: renderHome }, icon("back"), t("ladder.toHome")),
      h("p", { class: "eyebrow" }, t("ladder.sentenceN", { n: r.n })),
      h("h1", { class: "sum-title" }, phaseTitle(r))),
    h("div", { class: "drill-card" }, r.phase === "say" ? null : rungList(r), body.el),
    body.nav || null);
  if (autoplay && body.play) playRung(body.play.n, body.play.btn);
}

// The ladder: rung 1 (fast) on top, rung 4 (careful) at the bottom, each with its own play button.
function rungList(r) {
  return h("ol", { class: "lad-ladder", "aria-label": t("ladder.rungs") }, RUNGS.map((g) => {
    const open = r && (r.phase !== "listen" && r.phase !== "down" ? true : g.n <= r.deepest);
    const cls = "lad-rung" + (r && g.n === r.rung && r.phase !== "reveal" ? " on" : "") + (r && !open ? " locked" : "") + (r && r.caughtAt === g.n ? " caught" : "");
    const li = h("li", { class: cls, style: `--i:${g.n - 1}` },
      h("span", { class: "lad-n" }, r && r.caughtAt === g.n ? icon("check") : String(g.n)),
      h("span", { class: "lad-name" }, h("b", null, t(`ladder.rung.${g.n}`)), h("small", null, t(`ladder.rungSub.${g.n}`))),
      r && open ? playBtn(g.n) : null);
    return li;
  }));
}

// Typed answer (always available) plus the microphone; onCheck(text).
function answerBox(placeholder, onCheck, value = "") {
  const ta = h("textarea", { rows: "2", lang: "en", placeholder, autocomplete: "off", autocapitalize: "sentences", spellcheck: "false", "aria-label": placeholder });
  ta.value = value;
  const go = () => { const v = str(ta.value); if (!v) { ta.focus(); return; } onCheck(v); };
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } });
  const mic = micButton({ label: t("ladder.sayHeard"), onText: (x) => { if (!mic.isConnected || !alive()) return; ta.value = x; go(); } });
  return {
    ta,
    el: h("div", { class: "attempt stack-xs" }, ta,
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn primary lad-check", onclick: go }, icon("check"), t("ladder.check")),
        mic, h("span", { class: "hint-line" }, t("ladder.micHint")))),
  };
}

// What the learner caught: their words in place, blanks for the missed ones.
function cloze(red, res) {
  return red.raw.flatMap((w, i) => [i ? " " : null,
    res.hits[i] || !normTok(w) ? w : h("span", { class: "lad-blank", "aria-label": t("ladder.blank") }, "\u00a0".repeat(Math.min(8, Math.max(2, w.length))))]);
}

function scoreLine(res) {
  const band = res.pct >= 90 ? "high" : res.pct >= 60 ? "mid" : "low";
  return h("div", { class: "score " + band }, h("span", null, t("ladder.score", { hit: res.hit, total: res.total })), meter(res.pct / 100), h("span", null, res.pct + "%"));
}

/* listen at rung 1, then step down rung by rung */
function downBody(r) {
  const result = h("div", { class: "stack-sm", "aria-live": "polite" });
  const main = playBtn(r.rung, r.rung === 1 && !r.tries ? t("ladder.listen") : t("ladder.listenRung", { n: r.rung }));
  const box = answerBox(t("ladder.typePh"), (text) => check(text), r.draft);
  box.ta.addEventListener("input", () => { r.draft = box.ta.value; });
  const check = (text) => {
    r.draft = text;
    const res = score(r.red, text);
    r.tries++;
    r.last = res;
    if (!r.first) firstAttempt(r, res, text);
    if (res.all) { r.caughtAt = r.rung; if (r.entry) { r.entry.caughtAt = r.rung; save(); } goPhase("reveal"); return; }
    paintTry(result, r, res);
  };
  if (r.last) paintTry(result, r, r.last);
  const nav = h("div", { class: "drill-nav" },
    r.rung < 4
      ? h("button", { type: "button", class: "btn", onclick: () => stepDown(r) }, t("ladder.stepDown", { n: r.rung + 1 }))
      : h("span"),
    h("button", { type: "button", class: "btn quiet", onclick: () => { passIfCold(r); goPhase("reveal"); } }, t("ladder.showMe")));
  return {
    el: h("div", { class: "stack-sm" },
      h("p", { class: "lede" }, r.rung === 1 && !r.tries ? t("ladder.listenLede") : t(`ladder.rungLede.${r.rung}`)),
      h("div", { class: "row" }, main),
      h("p", { class: "hint-line" }, t("ladder.typeHint")),
      box.el, result),
    nav,
    play: { n: r.rung, btn: main },
  };
}

function paintTry(box, r, res) {
  const rulesOk = !res.missed.length;
  fill(box,
    scoreLine(res),
    h("p", { class: "mini-label" }, t("ladder.youCaught")),
    h("p", { class: "drill-text small lad-cloze", lang: "en" }, cloze(r.red, res)),
    h("p", { class: "hint-line" }, rulesOk ? t("ladder.rulesOk") : r.rung < 4 ? t("ladder.tryOrDown") : t("ladder.bottom")));
}

// The first answer at full speed is the honest test: it goes into the profile.
function firstAttempt(r, res, text) {
  r.first = res;
  record(r.red, res);
  r.entry = { at: Date.now(), text: r.item.text, src: r.item.src, rules: r.red.rules, caught: res.caught, missed: res.missed, first: res.pct, heard: text.slice(0, 200), caughtAt: 0, top: false, said: null };
  data.history.unshift(r.entry);
  data.history = data.history.slice(0, 40);
  save();
}
// Leaving rung 1 without an answer counts as not caught.
function passIfCold(r) { if (!r.first) firstAttempt(r, score(r.red, ""), ""); }

function stepDown(r) {
  passIfCold(r);
  r.rung = Math.min(4, r.rung + 1);
  r.deepest = Math.max(r.deepest, r.rung);
  r.last = null;
  renderRound(true);
}

/* the sentence, its fast form and the rules in it */
function marked(list, missed) {
  return list.flatMap((p, k) => [k ? " " : null, p.span ? h("mark", { class: "lad-hl" + (missed.includes(p.span.id) ? " miss" : "") }, p.text) : p.text]);
}

function revealBody(r) {
  const missed = r.first ? r.first.missed : r.red.rules;
  const perfect = r.first && r.first.all;
  const msg = perfect ? t("ladder.perfectFirst") : r.caughtAt ? t("ladder.caughtAt", { n: r.caughtAt, name: t(`ladder.rung.${r.caughtAt}`) }) : t("ladder.revealLede");
  const next = perfect
    ? h("button", { type: "button", class: "btn primary", onclick: () => goPhase("say", 2) }, t("ladder.toSay"))
    : h("button", { type: "button", class: "btn primary", onclick: () => goPhase("up", r.deepest > 1 ? r.deepest : 4) }, t("ladder.climb"));
  return {
    el: h("div", { class: "stack-sm" },
      h("p", { class: r.caughtAt || perfect ? "fb-praise" : "lede" }, msg),
      h("div", { class: "stack-xs" }, h("span", { class: "mini-label" }, t("ladder.written")),
        h("p", { class: "drill-text small", lang: "en" }, marked(parts(r.red, "written"), missed))),
      h("div", { class: "stack-xs" }, h("span", { class: "mini-label" }, t("ladder.spoken")),
        h("p", { class: "sounds", lang: "en" }, marked(parts(r.red, "out"), missed))),
      r.item.meaning ? h("p", { class: "drill-native" }, r.item.meaning) : null,
      h("div", { class: "stack-xs" }, h("span", { class: "mini-label" }, t("ladder.rulesHere")),
        h("ul", { class: "tips" }, r.red.rules.map((id) => {
          const ok = r.first && !r.first.missed.includes(id);
          return h("li", { "data-rule": id },
            h("span", { class: "term", lang: "en" }, ruleLabel(ruleById(id))),
            h("span", { class: "tag " + (ok ? "lad-ok" : "lad-miss") }, t(ok ? "ladder.ruleCaught" : "ladder.ruleMissed")),
            h("span", null, t(`ladder.rule.${id}`)));
        }))),
      h("div", { class: "row" }, saveBtn({ term: r.item.text, meaning: r.item.meaning, example: fastText(r.item.text), source: "ladder" }))),
    nav: h("div", { class: "drill-nav" }, h("span"), next),
  };
}

/* climb back up: read and listen on the lower rungs, then catch it at rung 1 with the text hidden */
function upBody(r) {
  if (r.rung > 1) {
    const main = playBtn(r.rung, t("ladder.listenRung", { n: r.rung }));
    const text = parts(r.red, RUNGS[r.rung - 1].fast ? "out" : "written");
    return {
      el: h("div", { class: "stack-sm" },
        h("p", { class: "lede" }, t("ladder.upLede")),
        h("p", { class: RUNGS[r.rung - 1].fast ? "sounds" : "drill-text small", lang: "en" }, marked(text, [])),
        h("div", { class: "row" }, main)),
      nav: h("div", { class: "drill-nav" }, h("span"),
        h("button", { type: "button", class: "btn primary", onclick: () => { r.rung--; renderRound(true); } }, t("ladder.upNext", { n: r.rung - 1 }))),
      play: { n: r.rung, btn: main },
    };
  }
  const result = h("div", { class: "stack-sm", "aria-live": "polite" });
  const main = playBtn(1, t("ladder.listenRung", { n: 1 }));
  const next = h("div", { class: "drill-nav" }, h("span"));
  const paintNext = () => fill(next, h("span"), r.top
    ? h("button", { type: "button", class: "btn primary", onclick: () => goPhase("say", 2) }, t("ladder.toSay"))
    : r.upTries >= 2 ? h("button", { type: "button", class: "btn quiet", onclick: () => goPhase("say", 2) }, t("ladder.moveOn")) : null);
  const box = answerBox(t("ladder.typePh"), (text) => {
    const res = score(r.red, text);
    r.upTries++;
    if (res.all) { r.top = true; if (r.entry) { r.entry.top = true; save(); } }
    fill(result,
      scoreLine(res),
      res.all ? h("p", { class: "fb-praise" }, t("ladder.topOk")) : h("p", { class: "drill-text small lad-cloze", lang: "en" }, cloze(r.red, res)),
      res.all ? null : h("p", { class: "hint-line" }, t("ladder.topMiss", { n: res.total - res.hit })));
    paintNext();
  });
  paintNext();
  return {
    el: h("div", { class: "stack-sm" },
      h("p", { class: "lede" }, t("ladder.topLede")),
      h("div", { class: "row" }, main),
      box.el, result),
    nav: next,
    play: { n: 1, btn: main },
  };
}

/* say the reduced version yourself */
function sayBody(r) {
  const result = h("div", { class: "stack-sm", "aria-live": "polite" });
  const judge = (heard) => {
    const m = readingMatch(r.item.text, expandFor(heard, r.item.text));
    r.said = m.score;
    if (r.entry) { r.entry.said = m.score; save(); }
    const band = m.score >= 90 ? "high" : m.score >= 60 ? "mid" : "low";
    fill(result,
      h("div", { class: "score " + band }, h("span", null, t("ladder.score", { hit: m.hit, total: m.total })), meter(m.score / 100), h("span", null, m.score + "%")),
      m.hit < m.total ? h("p", { class: "drill-text small", lang: "en" }, m.frag) : h("p", { class: "fb-praise" }, t("ladder.sayPerfect")),
      h("p", { class: "heard" }, t("ladder.heard"), " ", h("span", { lang: "en" }, heard)));
  };
  const mic = micButton({ big: true, label: t("ladder.sayRecord"), onText: (x) => { if (mic.isConnected && alive()) judge(x); } });
  const ta = h("textarea", { rows: "2", lang: "en", placeholder: t("ladder.sayTypePh"), "aria-label": t("ladder.sayTypePh"), spellcheck: "false" });
  const typed = () => { const v = str(ta.value); if (v) judge(v); else ta.focus(); };
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); typed(); } });
  const listen = playBtn(2, t("ladder.hearFast"));
  return {
    el: h("div", { class: "stack-sm" },
      h("p", { class: "lede" }, t("ladder.sayLede")),
      h("p", { class: "sounds lad-say", lang: "en" }, marked(parts(r.red, "out"), [])),
      h("p", { class: "hint-line", lang: "en" }, r.item.text),
      h("div", { class: "row" }, listen),
      h("div", { class: "attempt-row" }, mic, h("span", { class: "hint-line" }, t("ladder.sayHint"))),
      h("details", { class: "lad-typed" },
        h("summary", { class: "hint-line" }, t("ladder.sayType")),
        h("div", { class: "attempt stack-xs" }, ta,
          h("div", { class: "row" }, h("button", { type: "button", class: "btn lad-say-check", onclick: typed }, icon("check"), t("ladder.check"))))),
      result),
    nav: h("div", { class: "drill-nav" },
      h("button", { type: "button", class: "btn", onclick: renderHome }, t("ladder.finish")),
      h("button", { type: "button", class: "btn primary", id: "ladder-next", onclick: startRound }, t("ladder.next"))),
  };
}
