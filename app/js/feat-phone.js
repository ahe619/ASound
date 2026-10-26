// Phone Line: the phone calls international students dread - a pharmacy refill, a clinic appointment, a broken
// heater, an internet outage, a flight change, a delivery driver who can't find the building. The other side is
// the local model, heard through a telephone-sounding filter with no transcript; the learner gets a card of
// made-up details and has to get each one across. Afterwards the model writes down what it understood and the app
// checks every detail against the card here (spoken numbers, spelling and dates are normalized locally).
import { prefs, savePrefs, LEVELS, levelById } from "./state.js";
import { h, fill, icon, str, isObj, arr, pick, clamp, toast, thinkingDots, meter, readJSON, writeJSON, sentences, cleanReply } from "./util.js";
import { t, getLanguage } from "./i18n.js";
import { ask, askJSON, aiErrorText } from "./ai.js";
import { helpLangName } from "./prompts.js";
import { renderSpeech, audioContext, unlockAudio, stopSpeaking, speakBtn } from "./speech.js";
import { micButton } from "./mic.js";
import { saveBtn, fmtDate } from "./widgets.js";

export const meta = { id: "phone", where: "talk", icon: "live" };

const KEY = "asound.phone.v1";
const MAX_TURNS = 10;                                  // learner turns before the other side wraps up
const LEVEL_RATE = [0.86, 0.92, 1, 1.05, 1.1];         // how fast the other side talks, by level
const LEVEL_NOISE = [0.004, 0.006, 0.009, 0.012, 0.016]; // line hiss, by level

/* ---------- the calls ---------- */
// dir: "out" = the learner calls, "in" = they call the learner. need: what the other side must collect, in order
// ("spell" = the spelling of the name). first: what to ask before the details. wrap: how the call resolves.
const SCEN = [
  { id: "pharmacy", dir: "out", voice: "af_sarah", org: "Campus Care Pharmacy",
    role: "Dana, a pharmacy technician at Campus Care Pharmacy",
    situation: "A student is calling to refill a prescription.",
    wrap: "tell them the refill will be ready tomorrow after 2 p.m.",
    open: "Thank you for calling Campus Care Pharmacy, this is Dana. How can I help you today?",
    need: ["name", "spell", "dob", "code", "phone"], code: "prescription number", codeRe: /prescription|\brx\b|refill number/i },
  { id: "clinic", dir: "out", voice: "af_nicole", org: "Student Health Center",
    role: "Pat, a receptionist at the Student Health Center",
    situation: "A student is calling to book an appointment.",
    first: "react kindly and ask briefly what the visit is for",
    wrap: "offer an appointment on Thursday at 10:30 a.m.",
    open: "Student Health Center, this is Pat speaking. How can I help you?",
    need: ["name", "spell", "dob", "code", "phone"], code: "insurance member ID", codeRe: /member|insurance|\bid\b/i },
  { id: "heater", dir: "out", voice: "am_michael", org: "Oakwood Apartments",
    role: "Greg, the maintenance manager at Oakwood Apartments",
    situation: "A tenant is calling because the heater in their apartment is broken.",
    first: "ask briefly what is wrong with the heater",
    wrap: "promise that a technician will come tomorrow morning between 9 and 11",
    open: "Oakwood Apartments maintenance, this is Greg. What can I do for you?",
    need: ["name", "spell", "address", "zip", "phone"], code: "lease number", codeRe: /lease/i },
  { id: "internet", dir: "out", voice: "am_eric", org: "SwiftNet Internet",
    role: "Jordan, a support agent at SwiftNet Internet",
    situation: "A customer is calling because their home internet is down. Verify the account before you help.",
    wrap: "say there is an outage in their area and it should be fixed in about three hours",
    open: "Thanks for calling SwiftNet, my name is Jordan. Can I start with your account number?",
    need: ["code", "name", "spell", "address", "zip"], code: "account number", codeRe: /account/i },
  { id: "flight", dir: "out", voice: "af_bella", org: "Blue Sky Airlines",
    role: "Morgan, a reservations agent at Blue Sky Airlines",
    situation: "A passenger is calling to change their flight to a later date.",
    first: "ask briefly which flight they want to change and to when",
    wrap: "move them to the same flight two days later, with a 75 dollar change fee",
    open: "Blue Sky Airlines, this is Morgan. How can I help you today?",
    need: ["code", "name", "spell", "dob", "phone"], code: "confirmation code", codeRe: /confirmation|booking|reservation/i, short: true },
  { id: "delivery", dir: "in", voice: "am_liam", org: "QuickDrop",
    role: "Mike, a delivery driver for QuickDrop who is calling the customer",
    situation: "You have a package for the customer, but you cannot find their building.",
    wrap: "say you can find it now and will be there in five minutes",
    open: "Hi, this is Mike with QuickDrop delivery. I've got a package for you, but I can't find your building. Who am I speaking with?",
    need: ["name", "address", "zip", "code"], code: "gate code", codeRe: /gate|door code|access code|\bcode\b/i },
];

// Static phrases for the "phone phrases" card; meanings live in the locale (phone.ph.<i>).
const PHRASES = [
  "Could you spell that for me?",
  "Sure. It's Z as in zebra, H as in hotel, A, N, G.",
  "Sorry, could you repeat that a little slower?",
  "My date of birth is March fifth, two thousand three.",
  "The ZIP code is three-two-six-oh-eight.",
  "My number is three-five-two, eight-four-six, two-oh-seven-one.",
  "Let me read that back to you.",
  "Sorry, you're breaking up. Could you say that again?",
];

/* ---------- made-up details (generated here, never by the model) ---------- */

const SURNAMES = [
  ["Wang", "Li", "Liu", "Chen", "Yang", "Lin", "Ma", "Sun", "Tang", "Gao", "Luo", "Song", "Fan", "Hu"],
  ["Zhang", "Huang", "Zhao", "Wu", "Zhou", "Guo", "He", "Zheng", "Liang", "Deng", "Feng", "Peng"],
  ["Xu", "Xie", "Qian", "Qiu", "Cui", "Zhuang", "Xiong", "Jiang", "Cao", "Zeng", "Cai", "Xue"],
];
const GIVEN = [
  ["Lei", "Na", "Fang", "Jing", "Ming", "Tao", "Bo", "Lan", "Hong", "Ping", "Yan", "Hui", "Kai", "Min"],
  ["Xinyi", "Haoran", "Yuxuan", "Zihan", "Jiaqi", "Siyu", "Yichen", "Mengyao", "Junjie", "Tianyu", "Wenjing", "Kaiwen"],
  ["Xueqing", "Qiaoxuan", "Zhixuan", "Ruoxi", "Xiaoqian", "Jingxuan", "Shuqi", "Zhenyu", "Qianru", "Xuanzhi", "Cuiying", "Zhuoran"],
];
const STREETS = ["Maple", "Oak Hill", "Cedar", "Willow", "Archer", "University", "Hawthorne", "Magnolia", "Lakeview", "Sunset", "Highland", "Mill Creek", "Pine Ridge", "Brookside", "Juniper", "Elm"];
const ROAD_TYPES = [["Street", "St"], ["Avenue", "Ave"], ["Road", "Rd"], ["Drive", "Dr"], ["Lane", "Ln"], ["Boulevard", "Blvd"], ["Court", "Ct"]];
const CITIES = [["Gainesville", "FL"], ["Austin", "TX"], ["Ann Arbor", "MI"], ["Madison", "WI"], ["Columbus", "OH"], ["Berkeley", "CA"], ["Boston", "MA"], ["Seattle", "WA"], ["Champaign", "IL"], ["Durham", "NC"]];
const AREAS = ["352", "512", "734", "608", "614", "510", "617", "206", "217", "919", "415", "312"];
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O: they look like 1 and 0
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const digitRun = (n) => Array.from({ length: n }, () => rnd(0, 9)).join("");
const letter = () => LETTERS[rnd(0, LETTERS.length - 1)];
const tierOf = (level) => (level <= 2 ? 0 : level === 3 ? 1 : 2);

function makeCard(sc, level) {
  const tier = tierOf(level);
  const surname = pick(SURNAMES[tier]), given = pick(GIVEN[tier]);
  const [city, state] = pick(CITIES);
  const road = pick(ROAD_TYPES);
  const unit = Math.random() < 0.5 ? `${rnd(1, 4)}${pick(["A", "B", "C", "D"])}` : String(rnd(101, 450));
  const code = sc.short
    ? [letter(), letter(), rnd(2, 9), letter(), rnd(2, 9), letter()].join("")
    : `${letter()}${rnd(2, 9)}${letter()}-${digitRun(4)}`;
  return {
    surname, given, name: `${surname} ${given}`,
    dob: { y: rnd(1996, 2006), m: rnd(1, 12), d: rnd(1, 28) },
    street: { num: String(rnd(100, 9899)), name: pick(STREETS), type: road[0], abbr: road[1], unit },
    city, state, zip: String(rnd(10000, 99999)),
    phone: pick(AREAS) + rnd(200, 989) + digitRun(4),
    code,
  };
}

const fmtPhone = (p) => `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`;
const fmtDob = (d) => `${MONTHS[d.m - 1]} ${d.d}, ${d.y}`;
const fmtDobNum = (d) => `${String(d.m).padStart(2, "0")}/${String(d.d).padStart(2, "0")}/${d.y}`;
const fmtStreet = (s) => `${s.num} ${s.name} ${s.abbr}, Apt ${s.unit}`;
const valueOf = (f, card) => ({ name: card.name, dob: fmtDob(card.dob), address: fmtStreet(card.street), zip: card.zip, phone: fmtPhone(card.phone), code: card.code })[f];
const fieldLabel = (f, sc) => (f === "code" ? t(`phone.code.${sc.id}`) : t(`phone.f.${f}`));
const scored = (sc) => sc.need.filter((f) => f !== "spell");

/* ---------- what was said: spoken numbers, spelling, dates ---------- */

const UNITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SOUNDS_LIKE = { to: "two", too: "two", for: "four", won: "one", ate: "eight" }; // only between other numbers
const NATO = { alpha: "a", alfa: "a", bravo: "b", charlie: "c", delta: "d", echo: "e", foxtrot: "f", golf: "g", hotel: "h", india: "i", juliet: "j", kilo: "k", lima: "l", mike: "m", november: "n", oscar: "o", papa: "p", quebec: "q", romeo: "r", sierra: "s", tango: "t", uniform: "u", victor: "v", whiskey: "w", xray: "x", yankee: "y", zulu: "z" };
const ORDINALS = { first: "one", second: "two", third: "three", fourth: "four", fifth: "five", sixth: "six", seventh: "seven", eighth: "eight", ninth: "nine", tenth: "ten", eleventh: "eleven", twelfth: "twelve", thirteenth: "thirteen", fourteenth: "fourteen", fifteenth: "fifteen", sixteenth: "sixteen", seventeenth: "seventeen", eighteenth: "eighteen", nineteenth: "nineteen", twentieth: "twenty", thirtieth: "thirty" };
const FILLER = new Set(["dash", "hyphen", "minus", "space", "slash", "dot", "and"]);
const isNumWord = (w) => w in UNITS || w in TEENS || w in TENS || /^\d+$/.test(w);

// Lowercase words; "Z as in zebra" / "Z for zebra" -> "z".
function rawWords(text) {
  return str(text).toLowerCase().replace(/[\u2018\u2019']/g, "").replace(/\bx-ray\b/g, "xray")
    .replace(/\b([a-z])\s*,?\s+(?:as in|for)\s+[a-z]+/g, "$1")
    .split(/[^a-z0-9]+/).filter(Boolean);
}

// Spoken numbers -> digit strings, the way people say them on the phone:
// "three five two" -> 3 5 2, "forty-one twenty-seven" -> 41 27, "two thousand three" -> 2003, "double five" -> 55.
function numberize(words) {
  const out = [];
  let g = null, rep = 1;
  const flush = () => { if (g) { out.push(String(g.total + g.cur)); g = null; } };
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    const prev = words[i - 1] || "", next = words[i + 1] || "";
    if (SOUNDS_LIKE[w] && isNumWord(prev) && isNumWord(next)) w = SOUNDS_LIKE[w];
    if ((w === "oh" || w === "o") && !isNumWord(prev) && !isNumWord(next)) { flush(); out.push(w); continue; }
    if (w === "o") w = "oh";
    if ((w === "double" || w === "triple") && (next in UNITS || /^\d$/.test(next))) { flush(); rep = w === "double" ? 2 : 3; continue; }
    if (/^\d+$/.test(w)) { flush(); out.push(rep > 1 && w.length === 1 ? w.repeat(rep) : w); rep = 1; continue; }
    if (w in UNITS) {
      const v = UNITS[w];
      if (rep > 1) { flush(); out.push(String(v).repeat(rep)); rep = 1; continue; }
      if (v && g && (g.last === "tens" || g.last === "big")) { g.cur += v; g.last = "unit+"; continue; }
      flush();
      if (!v) out.push("0"); else g = { total: 0, cur: v, last: "unit" };
      continue;
    }
    if (w in TEENS || w in TENS) {
      const v = w in TEENS ? TEENS[w] : TENS[w], last = w in TENS ? "tens" : "teen";
      if (g && g.last === "big" && g.cur % 100 === 0) { g.cur += v; g.last = last; continue; }
      flush();
      g = { total: 0, cur: v, last };
      continue;
    }
    if (w === "hundred" && g && g.cur > 0 && g.cur < 100) { g.cur *= 100; g.last = "big"; continue; }
    if (w === "thousand" && g && g.cur > 0 && g.cur < 1000 && !g.total) { g.total = g.cur * 1000; g.cur = 0; g.last = "big"; continue; }
    if (w === "and" && g && g.last === "big") continue;
    flush();
    rep = 1;
    out.push(w);
  }
  flush();
  return out;
}

const digitsOf = (text) => numberize(rawWords(text)).join("").replace(/\D/g, "");
const compactOf = (text) => numberize(rawWords(text)).filter((w) => !FILLER.has(w)).map((w) => NATO[w] || w).join("").toUpperCase();

// Words with spelled-out runs joined ("z h a n g" -> "zhang"), plus adjacent pairs ("xin yi" -> "xinyi").
function nameWords(text) {
  const out = [];
  let run = "";
  for (const w of rawWords(text).map((x) => NATO[x] || x)) {
    if (w.length === 1) { run += w; continue; }
    if (run) out.push(run);
    run = "";
    out.push(w);
  }
  if (run) out.push(run);
  const all = new Set(out);
  for (let i = 0; i + 1 < out.length; i++) all.add(out[i] + out[i + 1]);
  return all;
}

function monthOf(w) {
  if (w.length < 3) return 0;
  const i = MONTHS.findIndex((m) => m.toLowerCase().startsWith(w));
  return i >= 0 ? i + 1 : 0;
}
function mkDate(y, m, d) {
  let yy = Number(y);
  if (String(y).length <= 2) yy += yy < 30 ? 2000 : 1900;
  const mm = Number(m), dd = Number(d);
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yy >= 1900 && yy <= 2099 ? { y: yy, m: mm, d: dd } : null;
}
// Every date in the text: "March 5th, 2003", "the fifth of March two thousand three", "03/05/2003", "oh three oh five 2003".
function datesOf(text) {
  const s = str(text).toLowerCase(), found = [];
  for (const m of s.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) found.push(mkDate(m[3], m[1], m[2]));
  for (const m of s.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) found.push(mkDate(m[1], m[2], m[3]));
  const words = numberize(rawWords(s).map((w) => ORDINALS[w] || w.replace(/^(\d+)(st|nd|rd|th)$/, "$1")));
  const isN = (w) => /^\d+$/.test(w || "");
  words.forEach((w, i) => {
    const mo = monthOf(w);
    if (!mo) return;
    const nums = [];
    for (let j = i + 1; j < words.length && nums.length < 5; j++) {
      if (isN(words[j])) nums.push(words[j]);
      else if (!["the", "of", "in"].includes(words[j])) break;
    }
    let day = nums[0], rest = nums.slice(1);
    if (day && day.length >= 3) { // "the fifth of March, 2003": the day comes first
      rest = nums;
      day = [words[i - 1], words[i - 2], words[i - 3]].find((x) => isN(x) && x.length <= 2);
    }
    let y = "";
    for (const n of rest) { y += n; if (y.length >= 4) break; }
    if (day && (y.length === 4 || y.length === 2)) found.push(mkDate(y, mo, day));
  });
  const dg = digitsOf(s);
  if (!found.some(Boolean) && dg.length === 8) found.push(mkDate(dg.slice(4), dg.slice(0, 2), dg.slice(2, 4)));
  return found.filter(Boolean);
}

// Does this text carry the detail on the card?
const MATCH = {
  name: (x, c) => { const w = nameWords(x), s = c.surname.toLowerCase(), g = c.given.toLowerCase(); return (w.has(s) && w.has(g)) || w.has(s + g) || w.has(g + s); },
  dob: (x, c) => datesOf(x).some((d) => d.y === c.dob.y && d.m === c.dob.m && d.d === c.dob.d),
  address: (x, c) => {
    const a = c.street, words = new Set(numberize(rawWords(x)));
    return digitsOf(x).includes(a.num) && a.name.toLowerCase().split(" ").every((w) => words.has(w)) && compactOf(x).includes(a.unit.toUpperCase());
  },
  zip: (x, c) => digitsOf(x).includes(c.zip),
  phone: (x, c) => digitsOf(x).includes(c.phone),
  code: (x, c) => compactOf(x).includes(c.code.replace(/[^A-Z0-9]/g, "")),
};
// Does an answer look like the kind of detail that was asked for (right or wrong)?
const LOOKS = {
  name: (x) => !/\?|\b(repeat|pardon|sorry|again|slow)/i.test(x),
  spell: (x) => /\bas in\b/i.test(x) || /(\b[a-z]\b[\s,.-]*){3,}/i.test(x),
  dob: (x) => datesOf(x).length > 0 || digitsOf(x).length >= 4,
  address: (x) => digitsOf(x).length > 0 && rawWords(x).length >= 2,
  zip: (x) => digitsOf(x).length >= 5,
  phone: (x) => digitsOf(x).length >= 7,
  code: (x) => digitsOf(x).length > 0,
};
// Which details a line from the other side asks for.
const ASKS = {
  name: /\bname\b|who am i (speaking|talking) (with|to)|who is this|who's this/i,
  spell: /\bspell/i,
  dob: /birth|birthday|\bborn\b|\bdob\b/i,
  address: /address|street|apartment|\bunit\b|where (do you|are you) (live|located)/i,
  zip: /\bzip\b|postal/i,
  phone: /phone|\bcell\b|call you back|callback|reach you|contact number/i,
};
function asksFor(sc, line) {
  const plain = str(line).replace(/\b(zip|postal) code\b|\bstreet name\b/gi, " ");
  return sc.need.filter((f) => (f === "code" ? sc.codeRe.test(plain) : f === "name" ? ASKS.name.test(plain) : ASKS[f].test(line)));
}

/* ---------- the phone line: telephone band, a little grit, quiet hiss, ring tones ---------- */

const A = { line: null, src: null, resolve: null, gen: 0, tones: [], noise: null };

function lineGraph() {
  const ctx = audioContext();
  if (!ctx) return null;
  if (A.line && A.line.ctx === ctx) return A.line;
  const biquad = (type, freq, q, gain) => {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    if (gain) f.gain.value = gain;
    return f;
  };
  const input = ctx.createGain();
  input.gain.value = 1.2;
  const shaper = ctx.createWaveShaper(); // soft clipping: a slightly overdriven handset
  const n = 1024, curve = new Float32Array(n), k = 2.2;
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
  shaper.curve = curve;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -26; comp.knee.value = 8; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.2;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  const chain = [input, biquad("highpass", 300, 0.7), biquad("highpass", 300, 0.7), biquad("lowpass", 3400, 0.7), biquad("lowpass", 3400, 0.7), biquad("peaking", 1700, 1, 5), shaper, comp, out];
  for (let i = 0; i + 1 < chain.length; i++) chain[i].connect(chain[i + 1]);
  out.connect(ctx.destination);
  A.line = { ctx, input };
  return A.line;
}

// Quiet band-limited hiss with a rare crackle while the line is open.
function lineOn(level) {
  const g = lineGraph();
  if (!g || A.noise) return;
  const ctx = g.ctx, len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.0006 ? 5 : 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = 1400; bp.Q.value = 0.4;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(bp); bp.connect(gain); gain.connect(ctx.destination);
  gain.gain.setTargetAtTime(level, ctx.currentTime, 0.08);
  src.start();
  A.noise = { src, gain, ctx };
}
function lineOff() {
  const n = A.noise;
  A.noise = null;
  if (!n) return;
  try { n.gain.gain.setTargetAtTime(0, n.ctx.currentTime, 0.05); n.src.stop(n.ctx.currentTime + 0.3); } catch {}
}

// One tone burst of mixed sine waves; warble = the 20 Hz flutter of a phone bell.
function tone(freqs, at, dur, vol, dest, warble) {
  const ctx = A.line.ctx;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(vol, at + 0.02);
  env.gain.setValueAtTime(vol, at + dur - 0.03);
  env.gain.linearRampToValueAtTime(0, at + dur);
  env.connect(dest);
  let head = env;
  if (warble) {
    const am = ctx.createGain(), lfo = ctx.createOscillator(), depth = ctx.createGain();
    am.gain.value = 0.5; depth.gain.value = 0.5; lfo.frequency.value = 20;
    lfo.connect(depth); depth.connect(am.gain); am.connect(env);
    lfo.start(at); lfo.stop(at + dur);
    A.tones.push(lfo);
    head = am;
  }
  for (const f of freqs) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(head);
    o.start(at); o.stop(at + dur);
    A.tones.push(o);
  }
}
function stopTones() {
  for (const o of A.tones) { try { o.stop(); } catch {} }
  A.tones = [];
}
// US ringback heard down the line while dialing; resolves when the other side picks up (~5 s).
function ringback() {
  const g = lineGraph();
  if (!g) return Promise.resolve();
  const at = g.ctx.currentTime + 0.3;
  tone([440, 480], at, 1.6, 0.16, g.input);
  tone([440, 480], at + 3.0, 1.6, 0.16, g.input);
  return new Promise((resolve) => schedule(resolve, 5200, resolve));
}
// The learner's own phone ringing (not through the line): double rings for about 25 s.
function ringIncoming() {
  const g = lineGraph();
  if (!g) return;
  const at = g.ctx.currentTime + 0.1;
  for (let k = 0; k < 8; k++) {
    tone([440, 480], at + k * 3.2, 0.9, 0.12, g.ctx.destination, true);
    tone([440, 480], at + k * 3.2 + 1.15, 0.9, 0.12, g.ctx.destination, true);
  }
}
function hangupBeeps() {
  const g = lineGraph();
  if (!g) return;
  const at = g.ctx.currentTime + 0.05;
  for (let k = 0; k < 3; k++) tone([480, 620], at + k * 0.28, 0.18, 0.12, g.input);
}

function playOnLine(buf) {
  const g = lineGraph();
  if (!g) return Promise.resolve();
  return new Promise((resolve) => {
    const src = g.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(g.input);
    const finish = () => { if (A.src === src) A.src = null; if (A.resolve === finish) A.resolve = null; resolve(); };
    src.onended = finish;
    A.src = src;
    A.resolve = finish;
    src.start(g.ctx.currentTime + 0.05);
  });
}
// Cut the other side off mid-sentence; anything waiting on that line gives up (A.gen changes).
function hush() {
  A.gen++;
  const s = A.src, r = A.resolve;
  A.src = null;
  A.resolve = null;
  if (s) { s.onended = null; try { s.stop(); } catch {} }
  if (r) r();
}
function silenceAll() { hush(); stopTones(); lineOff(); }

/* ---------- the other side (local model) ---------- */

const ASK_LABEL = {
  name: "their full name", spell: "the spelling of their last name, letter by letter", dob: "their date of birth",
  address: "their street address with the apartment number", zip: "their ZIP code", phone: "a phone number where you can reach them",
};
const askLabel = (f, sc) => (f === "code" ? `their ${sc.code}` : ASK_LABEL[f]);
const FALLBACK_Q = {
  name: "Can I get your full name, please?", spell: "Could you spell your last name for me?", dob: "And what's your date of birth?",
  address: "What's the street address, with the apartment number?", zip: "And what's the ZIP code there?", phone: "What's the best phone number to reach you?",
};
const BYE = /\b(good ?bye|bye|have a (good|great|nice) (day|one|night|evening|afternoon)|take care)\b/i;
const allGot = (c) => c.sc.need.every((f) => c.got[f]);

function agentPrompt(c, closing) {
  const sc = c.sc, left = sc.need.filter((f) => !c.got[f]);
  let next;
  if (closing) next = left.length
    ? "You are out of time. In at most 2 short sentences, thank them, say someone will call back, and say goodbye."
    : `You have everything you need. In at most 2 short sentences, ${sc.wrap}, then say goodbye.`;
  else if (sc.first && c.learnerTurns === 1) next = `First, ${sc.first}.`;
  else next = `Next, ask for ${askLabel(left[0], sc)}.`;
  return [
    `Role-play a phone call. You are ${sc.role}. ${sc.situation}`,
    `You are talking with a Chinese student who is practicing English on the phone. Their level: ${levelById(c.level).guide}`,
    `You need these details from them: ${sc.need.map((f) => askLabel(f, sc)).join("; ")}.`,
    next,
    "Rules:",
    "- You are on the phone: say at most 2 short sentences, plain spoken English. No lists, no emoji, no stage directions.",
    "- Ask for one detail at a time. If a detail sounds incomplete or unclear, politely ask them to repeat or spell it.",
    "- Never make up their details and never say a detail before they do.",
    "- Their words come from speech recognition and may contain misheard words.",
  ].join("\n");
}

// Keep one short spoken line: no role labels, stage directions or extra turns; at most 2 sentences.
function tidyReply(text) {
  let s = cleanReply(text).split(/\n\s*(?:student|learner|caller|customer|user|you)\s*:/i)[0];
  s = s.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ").replace(/^\s*[A-Za-z]+\s*:\s*/, "").replace(/\s+/g, " ").trim();
  s = s.replace(/^["\u201c]+|["\u201d]+$/g, "").trim();
  const parts = sentences(s);
  if (parts.length > 2) s = /\?$/.test(parts[parts.length - 1]) ? `${parts[0]} ${parts[parts.length - 1]}` : `${parts[0]} ${parts[1]}`;
  return s;
}
function fallbackLine(c, closing) {
  if (closing) return "Okay, I've got everything I need. Thanks, and have a good day!";
  const f = c.sc.need.find((x) => !c.got[x]);
  return f === "code" ? `Can I have your ${c.sc.code}, please?` : FALLBACK_Q[f] || "Sorry, could you say that again?";
}

/* ---------- mounting ---------- */

let M = null; // {root, onExit, call, ctl, timer, scen, card}

export function mount(root, { onExit } = {}) {
  unmount();
  const mounted = M = { root, onExit: onExit || (() => {}), call: null, ctl: null, timer: 0, tasks: new Set(), scen: null, card: null };
  M.timer = setInterval(tick, 1000);
  renderHome();
  return () => { if (M === mounted) unmount(); };
}

function leave() {
  if (!M) return;
  const done = M.onExit;
  unmount();
  done();
}

function unmount() {
  teardown();
  M = null;
}

// Own every delayed call transition so leaving also cancels ringing and result timers.
function schedule(fn, ms, onCancel) {
  const mounted = M;
  const task = { timer: 0, onCancel };
  task.timer = setTimeout(() => {
    mounted.tasks.delete(task);
    if (M === mounted) fn();
  }, ms);
  mounted.tasks.add(task);
}

function clearTasks() {
  for (const task of M.tasks) {
    clearTimeout(task.timer);
    if (task.onCancel) task.onCancel();
  }
  M.tasks.clear();
}

function teardown() {
  if (!M) return;
  clearInterval(M.timer);
  dropCall();
  stopSpeaking();
  try { if (window.ASoundMic) window.ASoundMic.cancel(); } catch {}
}
// Stop the call in progress (and any model call) without leaving the mode.
function dropCall() {
  if (M.ctl) { M.ctl.abort(); M.ctl = null; }
  if (M.call) M.call.over = true;
  M.call = null;
  clearTasks();
  silenceAll();
}

// Once a second: the call clock, and a check that the mode is still on screen.
function tick() {
  if (!M) return;
  if (!M.root.isConnected || (M.head && !M.root.contains(M.head))) { unmount(); return; }
  const c = M.call;
  if (c && !c.over && !M.root.getClientRects().length) { unmount(); return; } // the host switched tabs
  if (c && c.ui && c.startedAt && !c.endedAt) c.ui.timer.textContent = clock(Date.now() - c.startedAt);
}
const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const alive = (c) => !!M && M.call === c && !c.over;

function show(...kids) {
  fill(M.root, ...kids);
  M.head = M.root.firstElementChild;
  const v = M.root.closest(".view");
  if (v) v.scrollTop = 0;
}
function head(eyebrow, title, back) {
  return h("header", { class: "sum-head" },
    back ? h("button", { type: "button", class: "btn quiet back", onclick: back.fn }, icon("back"), back.label) : null,
    h("p", { class: "eyebrow" }, eyebrow),
    h("h1", { class: "sum-title", lang: "en" }, title));
}

/* ---------- home ---------- */

function renderHome() {
  dropCall();
  const zh = getLanguage() === "zh";
  show(
    h("header", { class: "sum-head" },
      h("button", { type: "button", class: "btn quiet back", onclick: leave }, icon("back"), t("phone.back")),
      h("h1", { class: "title" }, t("phone.title")),
      h("p", { class: "lede" }, t("phone.lede"))),
    h("section", { class: "stack-sm" },
      h("h2", { class: "sec" }, t("phone.pick")),
      h("div", { class: "grid ph-grid" }, SCEN.map((sc) => h("button", { type: "button", class: "opt ph-opt", "data-scen": sc.id, onclick: () => openSetup(sc) },
        h("span", { class: "ph-dir" + (sc.dir === "in" ? " in" : "") }, t(`phone.dir.${sc.dir}`)),
        h("span", { class: "opt-en", lang: "en" }, t(`phone.s.${sc.id}.en`)),
        zh ? h("span", { class: "opt-zh" }, t(`phone.s.${sc.id}.name`)) : null,
        h("span", { class: "opt-desc" }, t(`phone.s.${sc.id}.desc`))))),
      levelPicker()),
    phrasesCard(),
    historySection());
}

function levelPicker() {
  const seg = h("div", { class: "seg", role: "group", "aria-label": t("phone.level") }, LEVELS.map((l) => h("button", {
    type: "button", "data-id": l.id, "aria-pressed": String(prefs.level === l.id),
    onclick: () => { prefs.level = l.id; savePrefs(); for (const b of seg.children) b.setAttribute("aria-pressed", String(Number(b.dataset.id) === l.id)); },
  }, String(l.id), h("small", null, t(`level.${l.id}.name`)))));
  return h("div", { class: "stack-xs" }, h("span", { class: "field-label" }, t("phone.level")), seg, h("span", { class: "hint-line" }, t("phone.levelNote")));
}

function phrasesCard() {
  return h("section", { class: "card" },
    h("h2", { class: "sec" }, icon("bulb"), t("phone.phrasesTitle")),
    h("p", { class: "hint-line" }, t("phone.phrasesLede")),
    h("ul", { class: "plain" }, PHRASES.map((en, i) => h("li", { class: "better-row" },
      h("div", { class: "better-text" }, h("p", { class: "better-en", lang: "en" }, en), h("p", { class: "hint-line" }, t(`phone.ph.${i}`))),
      speakBtn(en, t("speech.play")),
      saveBtn({ term: en, meaning: t(`phone.ph.${i}`), source: "phone" })))));
}

function pastCalls() { return arr(readJSON(KEY, [])).filter((x) => isObj(x) && SCEN.some((s) => s.id === x.scen)); }
function historySection() {
  const items = pastCalls().slice(0, 8);
  return h("section", { class: "stack-sm" },
    h("h2", { class: "sec" }, t("phone.historyTitle")),
    items.length
      ? h("ol", { class: "history" }, items.map((x) => h("li", { class: "hist-row" }, h("div", { class: "hist" },
        h("span", { class: "hist-title", lang: "en" }, t(`phone.s.${x.scen}.en`)),
        h("span", { class: "hist-meta" }, t("phone.historyMeta", { date: fmtDate(x.at), right: x.right, total: x.total }))),
        h("span", { class: "ph-mini-score " + scoreClass(x.right / (x.total || 1)) }, `${x.right}/${x.total}`))))
      : h("p", { class: "empty-line" }, t("phone.historyEmpty")));
}
const scoreClass = (p) => (p >= 0.8 ? "high" : p >= 0.5 ? "mid" : "low");

/* ---------- before the call: the details card ---------- */

function openSetup(sc) {
  unlockAudio();
  M.scen = sc;
  M.card = makeCard(sc, prefs.level);
  renderSetup();
}

function renderSetup() {
  dropCall();
  const sc = M.scen;
  show(
    head(t("phone.title"), t(`phone.s.${sc.id}.en`), { label: t("phone.otherCalls"), fn: renderHome }),
    h("p", { class: "lede" }, t(`phone.s.${sc.id}.goal`)),
    detailsCard(M.card, sc, true),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary big", id: "ph-start", onclick: () => startCall(sc, M.card) },
        icon("live"), sc.dir === "out" ? t("phone.call", { org: sc.org }) : t("phone.wait"))),
    h("p", { class: "note-card" }, t(`phone.setupNote.${sc.dir}`)));
}

function detailsCard(card, sc, canReroll) {
  const en = (x) => h("span", { lang: "en" }, x);
  const rows = [
    ["name", [en(card.name), h("small", { class: "ph-sub" }, t("phone.card.nameParts", { last: card.surname, first: card.given }))]],
    ["dob", [en(fmtDob(card.dob)), h("small", { class: "ph-sub", lang: "en" }, fmtDobNum(card.dob))]],
    ["address", [en(fmtStreet(card.street)), h("small", { class: "ph-sub", lang: "en" }, `${card.city}, ${card.state}`)]],
    ["zip", [en(card.zip)]],
    ["phone", [en(fmtPhone(card.phone))]],
    ["code", [en(card.code)]],
  ];
  const reroll = () => { M.card = makeCard(sc, prefs.level); renderSetup(); };
  return h("section", { class: "card ph-card", "aria-label": t("phone.card.title") },
    h("div", { class: "ph-card-head" },
      h("h2", { class: "sec" }, t("phone.card.title")),
      h("span", { class: "ph-fake" }, t("phone.card.fake")),
      canReroll ? h("button", { type: "button", class: "mini", onclick: reroll }, icon("dice"), t("phone.card.reroll")) : null),
    h("dl", { class: "ph-details" }, rows.map(([f, v]) => [
      h("dt", { class: sc.need.includes(f) ? "" : "ph-dim" }, fieldLabel(f, sc)),
      h("dd", { class: sc.need.includes(f) ? "" : "ph-dim" }, v)])));
}

/* ---------- the call ---------- */

function startCall(sc, card) {
  unlockAudio();
  stopSpeaking();
  dropCall();
  const level = clamp(Number(prefs.level) || 2, 1, 5);
  const c = {
    sc, card, level, voice: sc.voice, rate: clamp(prefs.rate * LEVEL_RATE[level - 1], 0.6, 1.4), noise: LEVEL_NOISE[level - 1],
    callerId: `(${pick(AREAS)}) 555-01${rnd(10, 99)}`,
    turns: [], got: {}, said: {}, lastAgent: "", learnerTurns: 0, repeats: 0, peeked: false, showText: false,
    state: "", startedAt: 0, endedAt: 0, over: false, voiceWarned: false,
  };
  M.call = c;
  renderCall(c);
  if (sc.dir === "out") dialOut(c);
  else waitIncoming(c);
}

const speechFor = (c, text, slow) => renderSpeech(text, { voice: c.voice, rate: c.rate * (slow ? 0.85 : 1) }).catch((e) => { console.warn("phone voice", e); return null; });

async function dialOut(c) {
  setState(c, "dialing");
  lineOn(c.noise * 0.6);
  const buf = speechFor(c, c.sc.open);
  await ringback();
  if (!alive(c)) return;
  connect(c);
  agentSay(c, c.sc.open, buf);
}

function waitIncoming(c) {
  setState(c, "waiting");
  c.openBuf = speechFor(c, c.sc.open);
  schedule(() => {
    if (!alive(c)) return;
    setState(c, "ringing");
    ringIncoming();
  }, 1800);
}

function answer(c) {
  if (!alive(c) || c.state !== "ringing") return;
  unlockAudio();
  stopTones();
  connect(c);
  agentSay(c, c.sc.open, c.openBuf);
}

function connect(c) {
  lineOff();
  lineOn(c.noise);
  c.startedAt = Date.now();
  c.ui.timer.textContent = clock(0);
  c.turns.push({ who: "them", text: c.sc.open });
  c.lastAgent = c.sc.open;
  paintTranscript(c);
}

// Play one line from the other side through the phone filter.
async function agentSay(c, text, bufP, slow) {
  hush();
  const gen = A.gen;
  setState(c, "thinking");
  const buf = await (bufP || speechFor(c, text, slow));
  if (!alive(c) || A.gen !== gen) return;
  if (!buf) { voiceFailed(c); setState(c, "turn"); return; }
  setState(c, "speaking");
  await playOnLine(buf);
  if (!alive(c) || A.gen !== gen) return;
  setState(c, "turn");
}
function voiceFailed(c) {
  if (!c.voiceWarned) toast(t("phone.err.voice"));
  c.voiceWarned = true;
  if (!c.showText) toggleText(c);
}

function submit(c, text) {
  const said = str(text);
  if (!alive(c) || !said || !(c.state === "turn" || c.state === "speaking")) return;
  hush();
  unlockAudio();
  noteTurn(c, said);
  c.turns.push({ who: "you", text: said });
  c.learnerTurns++;
  c.ui.heard.hidden = false;
  fill(c.ui.heard, t("phone.youSaid"), " ", h("span", { lang: "en" }, `\u201c${said}\u201d`));
  paintTranscript(c);
  agentTurn(c);
}
function sendTyped(c) {
  const v = str(c.ui.ta.value);
  if (!v) { toast(t("phone.err.empty")); return; }
  if (!(c.state === "turn" || c.state === "speaking")) return;
  c.ui.ta.value = "";
  submit(c, v);
}

// Track which details the other side now has: the answer to what it just asked, or a correct detail volunteered.
function noteTurn(c, said) {
  const asked = asksFor(c.sc, c.lastAgent);
  for (const f of c.sc.need) {
    const hit = f === "spell"
      ? (asked.includes("spell") || c.got.name) && LOOKS.spell(said)
      : (asked.includes(f) && LOOKS[f](said)) || MATCH[f](said, c.card);
    if (!hit) continue;
    c.got[f] = true;
    const key = f === "spell" ? "name" : f;
    c.said[key] = [...arr(c.said[key]), said].slice(-3);
  }
}

async function agentTurn(c) {
  const closing = allGot(c) || c.learnerTurns >= MAX_TURNS;
  c.ui.err.hidden = true;
  setState(c, "thinking");
  const ctl = new AbortController();
  M.ctl = ctl;
  const input = [{ role: "user", content: agentPrompt(c, closing) }, ...c.turns.map((x) => ({ role: x.who === "you" ? "user" : "assistant", content: x.text }))];
  let raw = "";
  try {
    raw = await ask(input, { signal: ctl.signal });
  } catch (e) {
    if (!alive(c) || (e && e.code === "cancelled")) return;
    fill(c.ui.err, h("span", { class: "err" }, aiErrorText(e)), h("button", { type: "button", class: "mini", onclick: () => agentTurn(c) }, t("phone.retry")));
    c.ui.err.hidden = false;
    setState(c, "turn");
    return;
  } finally {
    if (M && M.ctl === ctl) M.ctl = null;
  }
  if (!alive(c)) return;
  const line = tidyReply(raw) || fallbackLine(c, closing);
  const bye = closing || ((/\[end\]/i.test(raw) || BYE.test(line)) && c.learnerTurns >= 4);
  c.turns.push({ who: "them", text: line });
  c.lastAgent = line;
  paintTranscript(c);
  await agentSay(c, line);
  if (bye && alive(c) && c.state === "turn") endCall(c);
}

function repeatLast(c) {
  if (!alive(c) || !c.lastAgent || !(c.state === "turn" || c.state === "speaking")) return;
  unlockAudio();
  c.repeats++;
  agentSay(c, c.lastAgent, null, true);
}

function toggleText(c) {
  c.showText = !c.showText;
  if (c.showText) c.peeked = true;
  c.ui.transcript.hidden = !c.showText;
  c.ui.text.setAttribute("aria-pressed", String(c.showText));
  c.ui.text.textContent = t(c.showText ? "phone.hideText" : "phone.showText");
}
function paintTranscript(c) {
  fill(c.ui.transcript, c.turns.map((x) => h("li", { class: "tline" },
    h("span", { class: "who" }, t(x.who === "you" ? "phone.you" : "phone.them")), h("span", { lang: "en" }, x.text))));
}

function endCall(c) {
  if (!alive(c)) return;
  const connected = !!c.startedAt;
  if (M.ctl) { M.ctl.abort(); M.ctl = null; }
  hush();
  stopTones();
  try { if (window.ASoundMic) window.ASoundMic.cancel(); } catch {}
  c.endedAt = Date.now();
  setState(c, "ended");
  c.over = true;
  if (!connected) { renderSetup(); return; }
  hangupBeeps();
  schedule(() => { if (M.call === c) lineOff(); }, 900);
  schedule(() => { if (M.call === c) showResult(c); }, 1100);
}

function setState(c, s) {
  c.state = s;
  const ui = c.ui;
  if (!ui) return;
  fill(ui.status, t(`phone.st.${s}`, { org: c.sc.org }), s === "thinking" || s === "dialing" || s === "waiting" ? thinkingDots() : null);
  ui.wave.classList.toggle("on", s === "speaking");
  ui.line.classList.toggle("ringing", s === "ringing");
  ui.answer.hidden = s !== "ringing";
  const live = s === "turn" || s === "speaking";
  ui.repeat.disabled = !(live && c.lastAgent);
  ui.text.disabled = !c.startedAt;
  ui.send.disabled = !live;
  ui.mic.disabled = !live;
  ui.hang.disabled = s === "ended";
  fill(ui.hang, icon("close"), t(s === "ringing" ? "phone.decline" : "phone.hangup"));
}

function renderCall(c) {
  const sc = c.sc;
  const ui = (c.ui = {});
  ui.status = h("span", { class: "ph-status", role: "status" });
  ui.timer = h("span", { class: "ph-timer" }, "");
  ui.wave = h("span", { class: "ph-wave", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i"));
  ui.err = h("div", { class: "row ph-err", hidden: true });
  ui.answer = h("button", { type: "button", class: "btn big ph-answer", hidden: true, onclick: () => answer(c) }, icon("live"), t("phone.answer"));
  ui.repeat = h("button", { type: "button", class: "btn", title: t("phone.repeatHint"), onclick: () => repeatLast(c) }, icon("speaker"), h("span", { lang: "en" }, t("phone.repeat")));
  ui.text = h("button", { type: "button", class: "btn", "aria-pressed": "false", onclick: () => toggleText(c) }, t("phone.showText"));
  ui.hang = h("button", { type: "button", class: "btn ph-hang", onclick: () => endCall(c) });
  ui.transcript = h("ol", { class: "plain ph-transcript", hidden: true });
  ui.ta = h("textarea", { id: "ph-type", rows: "2", placeholder: t("phone.typePlaceholder"), lang: "en" });
  ui.ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendTyped(c); } });
  ui.send = h("button", { type: "button", class: "btn primary", id: "ph-send", onclick: () => sendTyped(c) }, icon("send"), t("phone.send"));
  ui.mic = micButton({ big: true, label: t("phone.speak"), onText: (x) => submit(c, x) });
  ui.mic.addEventListener("click", () => { if (c.state === "speaking") { hush(); setState(c, "turn"); } });
  ui.heard = h("p", { class: "heard", hidden: true });
  const who = sc.dir === "in"
    ? h("span", { class: "ph-who" }, h("strong", null, t("phone.unknown")), h("span", { class: "ph-sub", lang: "en" }, c.callerId))
    : h("span", { class: "ph-who" }, h("strong", { lang: "en" }, sc.org), h("span", { class: "ph-sub", lang: "en" }, t(`phone.s.${sc.id}.en`)));
  ui.line = h("section", { class: "card ph-line", "aria-label": t("phone.lineLabel") },
    h("div", { class: "ph-top" }, h("span", { class: "ph-icon" }, icon("live")), who, ui.timer),
    h("div", { class: "ph-state" }, ui.wave, ui.status),
    ui.err,
    h("div", { class: "row ph-controls" }, ui.answer, ui.repeat, ui.text, ui.hang),
    ui.transcript);
  show(
    head(t("phone.title"), t(`phone.s.${sc.id}.en`)),
    ui.line,
    detailsCard(c.card, sc, false),
    h("section", { class: "card" },
      h("span", { class: "mini-label" }, t("phone.yourTurn")),
      h("div", { class: "attempt-row" }, ui.mic, h("span", { class: "hint-line" }, t("phone.micHint"))),
      h("div", { class: "field stack-xs" }, h("label", { class: "field-label", for: "ph-type" }, t("phone.typeLabel")), ui.ta),
      h("div", { class: "actions" }, ui.send),
      ui.heard));
}

/* ---------- after the call: what got through ---------- */

function extractPrompt(c, fields) {
  const desc = {
    name: "full name; join spelled letters into words (Z-H-A-N-G -> Zhang)", dob: "date of birth, like March 5, 2003",
    address: "street address with the apartment number", zip: "ZIP code, digits only", phone: "phone number, digits only",
    code: `${c.sc.code}, letters and digits`,
  };
  return [
    "Below is a phone call. The agent needed some details from the student.",
    "Write down each detail exactly as the student gave it, the way the agent would type it into a form. Write numbers as digits.",
    'If the student never gave a detail, use "". Do not guess and do not fix mistakes.',
    ...fields.map((f) => `- ${f}: ${desc[f]}`),
    `Reply with only this JSON: {${fields.map((f) => `"${f}": ""`).join(", ")}}`,
    "",
    "Call:",
    ...c.turns.map((x) => (x.who === "you" ? "Student: " : "Agent: ") + x.text),
  ].join("\n");
}

function tipsPrompt(c, rows) {
  return [
    "A Chinese-speaking student practiced an English phone call and had to give these details:",
    ...rows.map((r) => (r.ok ? `- ${r.f}: correct` : `- ${r.f}: ${r.status === "miss" ? "never given" : "wrong"}. Correct: ${r.value}.${r.said ? ` The student said: ${JSON.stringify(r.said)}` : ""}`)),
    `Write 2 or 3 short, practical tips in ${helpLangName()} for giving details clearly on the phone, focused on the wrong or missing ones.`,
    'Good ideas: say ZIP codes and phone numbers digit by digit in groups ("three-five-two, eight-four-six"), spell names with words ("Z as in zebra"), say dates like "March fifth, two thousand three", read codes slowly, ask them to read it back.',
    "Keep English examples in English. One or two sentences per tip.",
    'Reply with only this JSON: {"tips": [string]}',
  ].join("\n");
}

function judge(c, f, heard) {
  const test = MATCH[f], card = c.card;
  const lines = c.turns.filter((x) => x.who === "you").map((x) => x.text);
  const ev = arr(c.said[f]);
  const hitLine = lines.find((x) => test(x, card));
  const ok = !!((heard && test(heard, card)) || hitLine || (ev.length && test(ev.join(" "), card)) || (f !== "zip" && test(lines.join(" "), card)));
  const status = ok ? "ok" : heard || ev.length ? "bad" : "miss";
  return { f, ok, status, value: valueOf(f, card), heard, said: hitLine || ev[ev.length - 1] || "" };
}

function localTips(rows) {
  const keys = rows.filter((r) => !r.ok).map((r) => r.f);
  return [...keys, "general", "repeat"].slice(0, 3).map((k) => t(`phone.tip.${k}`));
}

async function showResult(c) {
  const sc = c.sc, fields = scored(sc);
  const scoreBox = h("div", { class: "stack-xs" });
  const list = h("div", { class: "stack-sm" }, h("p", { class: "hint-line" }, t("phone.scoring"), thinkingDots()));
  const tipsBox = h("div", { class: "stack-xs" });
  const again = () => { M.card = makeCard(sc, prefs.level); renderSetup(); };
  show(
    head(t("phone.res.eyebrow"), t(`phone.s.${sc.id}.en`), { label: t("phone.otherCalls"), fn: renderHome }),
    scoreBox,
    h("section", { class: "card" }, h("h2", { class: "sec" }, t("phone.res.checklist")), list),
    h("section", { class: "card" }, h("h2", { class: "sec" }, icon("bulb"), t("phone.res.tips")), tipsBox),
    h("details", { class: "transcript" }, h("summary", null, t("phone.res.transcript")),
      h("ol", { class: "plain" }, c.turns.map((x) => h("li", { class: "tline" }, h("span", { class: "who" }, t(x.who === "you" ? "phone.you" : "phone.them")), h("span", { lang: "en" }, x.text))))),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", id: "ph-again", onclick: again }, icon("dice"), t("phone.res.again")),
      h("button", { type: "button", class: "btn", onclick: renderHome }, t("phone.res.other"))));
  if (!c.learnerTurns) {
    fill(list, h("p", { class: "empty-line" }, t("phone.res.noTurns")));
    fill(tipsBox, h("ul", { class: "tips" }, localTips([]).map((x) => h("li", null, x))));
    return;
  }
  const ctl = new AbortController();
  M.ctl = ctl;
  const heard = {};
  let note = "";
  try {
    const o = await askJSON(extractPrompt(c, fields), { signal: ctl.signal });
    if (isObj(o)) for (const f of fields) heard[f] = str(o[f]).slice(0, 160);
  } catch (e) {
    if (e && e.code === "cancelled") return;
    note = aiErrorText(e);
  }
  if (!M || M.call !== c) return;
  const rows = fields.map((f) => judge(c, f, heard[f]));
  const right = rows.filter((r) => r.ok).length;
  saveResult(c, rows, right);
  const secs = Math.round((c.endedAt - c.startedAt) / 1000);
  fill(scoreBox,
    h("div", { class: "score " + scoreClass(right / rows.length) }, meter(right / rows.length), t("phone.res.score", { right, total: rows.length })),
    h("p", { class: "hint-line" }, t("phone.res.stats", { time: clock(secs * 1000), turns: c.learnerTurns, repeats: c.repeats }), c.peeked ? ` \u00b7 ${t("phone.res.peeked")}` : ""));
  fill(list, h("ul", { class: "plain ph-checks" }, rows.map((r) => resultRow(r, sc))), note ? h("p", { class: "hint-line" }, note) : null);
  fill(tipsBox, h("p", { class: "hint-line" }, t("phone.res.tipsLoading"), thinkingDots()));
  let tips = [];
  if (!note) {
    try {
      const o = await askJSON(tipsPrompt(c, rows), { signal: ctl.signal });
      tips = arr(o && o.tips).map(str).filter((x) => x && x.length <= 400).slice(0, 3);
    } catch (e) {
      if (e && e.code === "cancelled") return;
      console.warn("phone tips", e);
    }
  }
  if (!M || M.call !== c) return;
  if (M.ctl === ctl) M.ctl = null;
  if (!tips.length) tips = localTips(rows);
  fill(tipsBox, h("ul", { class: "tips ph-tips" }, tips.map((x) => h("li", null, x))));
}

function resultRow(r, sc) {
  return h("li", { class: `ph-item ${r.status}` },
    h("span", { class: "ph-mark" }, icon(r.ok ? "check" : "close")),
    h("div", { class: "ph-item-body" },
      h("div", { class: "ph-item-top" },
        h("strong", null, fieldLabel(r.f, sc)),
        h("span", { class: "ph-badge" }, t(`phone.res.${r.status}`))),
      h("p", { class: "ph-val", lang: "en" }, r.value),
      r.said ? h("p", { class: "heard" }, t("phone.res.yourWords"), " ", h("span", { lang: "en" }, `\u201c${r.said}\u201d`)) : null,
      !r.ok && r.heard ? h("p", { class: "heard" }, t("phone.res.noted"), " ", h("span", { lang: "en" }, r.heard)) : null));
}

function saveResult(c, rows, right) {
  const doc = {
    id: "p-" + Date.now(), at: Date.now(), scen: c.sc.id, level: c.level, right, total: rows.length,
    turns: c.learnerTurns, repeats: c.repeats, peeked: c.peeked, secs: Math.round((c.endedAt - c.startedAt) / 1000),
    fields: Object.fromEntries(rows.map((r) => [r.f, r.status])),
  };
  writeJSON(KEY, [doc, ...pastCalls()].slice(0, 40));
}
