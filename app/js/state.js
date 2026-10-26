// App-wide settings and content tables. Display text for every id lives in locales/*.json.
import { readJSON, writeJSON } from "./util.js";
import { UI_LANGS } from "./i18n.js";
import { HELP_LANGS, detectLanguages } from "./langs.js";

/* ---------- levels ---------- */
// Five learner levels. `guide` tells the partner model how to talk at that level.
export const LEVELS = [
  { id: 1, key: "beginner", cefr: "A1-A2",
    guide: "Use only very common words and very short, simple sentences (under 10 words). Speak slowly and clearly. No idioms, no phrasal verbs, no slang." },
  { id: 2, key: "foundational", cefr: "A2-B1",
    guide: "Use common everyday words and simple sentences. A few very common phrasal verbs are fine. No idioms and no slang." },
  { id: 3, key: "skilled", cefr: "B1-B2",
    guide: "Use a wider everyday vocabulary, including some less common words, and natural sentence variety. Occasional common idioms are fine." },
  { id: 4, key: "talented", cefr: "B2-C1",
    guide: "Talk like a native speaker in a relaxed conversation: contractions, phrasal verbs, colloquial expressions and common idioms at a natural pace." },
  { id: 5, key: "master", cefr: "C1-C2",
    guide: "Talk like a fast native speaker among friends: idioms, current American slang and casual expressions (gonna, kinda, lowkey, no cap), cultural references and nuance." },
];
export const levelById = (id) => LEVELS.find((l) => l.id === Number(id)) || LEVELS[1];

/* ---------- conversation scenarios ---------- */
export const SCENARIOS = [
  { id: "chat", role: "a friendly native English speaker the learner just met at a campus event. Chat casually about hobbies, weekend plans, food, travel or recent news." },
  { id: "office", role: "a friendly university professor holding office hours. The learner is a student in your course who came to ask about an assignment, a grade, or something from lecture. Let them lead and ask what they need." },
  { id: "group", role: "a classmate on the learner's group project. Together you need to divide up the tasks, pick a meeting time, and check progress before the deadline." },
  { id: "cafe", role: "a barista at a busy campus cafe. Greet the customer, take their order, and ask about size, milk, the name for the cup, and payment." },
  { id: "interview", role: "a hiring manager interviewing the learner for a summer internship. Ask one interview question at a time, including 'tell me about yourself' and behavioral questions, and react naturally to the answers." },
  { id: "doctor", role: "a nurse at the student health center. Ask about the learner's symptoms, how long they've had them and any allergies, then explain the next steps." },
  { id: "exam", role: "an IELTS speaking examiner running a mock test. Start with Part 1 questions about familiar topics, one question at a time, then give a Part 2 cue card topic. Keep a neutral, professional examiner tone and give no feedback during the test." },
  { id: "ita", role: "an undergraduate student in a class the learner teaches as a teaching assistant, during a practice ITA (International Teaching Assistant) speaking test at a US university. First ask what concept from their field they will teach today. Then, while they explain, ask what a curious but sometimes confused student asks: for an example, to define or repeat a term, how it connects to the homework or the exam, and now and then say politely that you didn't catch something. One question at a time." },
  { id: "field", special: "field" },      // generated from the learner's profile
  { id: "document", special: "document" },// talk about a file the learner provides
  { id: "rehearse", special: "rehearse" },// practise a real conversation that is coming up, then debrief it
  { id: "custom", special: "custom" },    // the learner describes the scene
];
export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];

export const DOC_MODES = ["teacher", "freetalk", "interviewer"];

/* ---------- American accent drills ---------- */
export const DRILLS = [
  { id: "flap", focus: "the American flap T: a t or d between vowels (water, better, a lot of, get it) becomes a quick, light d-like tap" },
  { id: "r", focus: "the American R, including the R after vowels (car, more, world, nurse, work), which is always pronounced" },
  { id: "th", focus: "the two TH sounds (think, three, this, mother), which Chinese speakers often turn into s, f, z or d" },
  { id: "ae", focus: "the American ae vowel (cat, bad, man, after) against the short e (bed, men), plus the open ah in hot, job, not" },
  { id: "reduce", focus: "natural reductions and the schwa in casual American speech: gonna, wanna, gotta, kinda, lemme, 'n for and, ta for to, ya for you" },
  { id: "link", focus: "linking between words: consonant to vowel (pick it up), vowel to vowel with y or w glides (go on, I am), and same-sound linking (bad day)" },
  { id: "l", focus: "the dark L at the end of syllables (feel, milk, people) and clear final consonants and -ed / -s endings (wanted, asked, cats), which Chinese speakers often drop" },
  { id: "rhythm", focus: "word stress, sentence stress on content words with weak function words, and natural American intonation (falling for statements, rising for yes/no questions)" },
];
export const drillById = (id) => DRILLS.find((d) => d.id === id) || DRILLS[0];

/* ---------- placement test topics (rolled at random) ---------- */
export const TOPICS = [
  "travel", "food and cooking", "technology", "sports", "movies and TV", "campus life", "jobs and careers",
  "the weather", "shopping", "health and fitness", "music", "pets", "social media", "cities and hometowns",
  "money and saving", "friendship", "video games", "the environment", "holidays", "cars and driving",
];

// Everyday words for the placement test's "pick 5 at random" button.
export const WORD_POOL = [
  "coffee", "airport", "birthday", "umbrella", "library", "deadline", "guitar", "beach", "interview", "recipe",
  "subway", "sunset", "laptop", "marathon", "museum", "neighbor", "weekend", "budget", "festival", "camera",
  "homework", "pizza", "hiking", "traffic", "concert", "garden", "passport", "volunteer", "podcast", "snow",
  "roommate", "elevator", "breakfast", "scholarship", "basketball", "thunderstorm", "grocery", "bicycle", "puppy", "mirror",
  "hospital", "map", "battery", "cookie", "ocean", "wallet", "exam", "movie", "dentist", "rocket",
];

/* ---------- built-in reading passages, used when the local model is unavailable ---------- */
export const PASSAGES = [
  "Last Thursday, I was supposed to meet my roommate at the library at three. I got there a little late because the bus was packed, and by the time I found her, she'd already started working on our water project. We ended up staying until it got dark outside.",
  "Honestly, I think the best part of living in a new city is trying all the little restaurants around the corner. Every weekend my friends and I pick a different place. Sometimes it's amazing, and sometimes it's a total letdown, but it's always worth a try.",
  "My brother works as a civil engineer, so he spends a lot of time on construction sites. He told me the hardest part of his job isn't the math. It's getting everyone, from the workers to the city officials, to agree on what needs to happen first.",
  "If you're planning a road trip this summer, make sure you check the weather before you leave. Pack a few extra bottles of water, a phone charger, and some snacks. Trust me, a long drive feels a lot shorter when you've got good music and better company.",
  "I wasn't really into running at first, but a friend talked me into signing up for a five K. We trained three mornings a week, and by the end of the month, I could actually finish the whole thing without stopping. Now I'm kind of hooked.",
  "The professor asked us to write about a person who changed the way we think. I chose my high school math teacher. She never gave us the answers right away. Instead, she'd ask another question, and somehow that made everything click.",
];

/* ---------- settings (this computer) ---------- */
const K_PREFS = "asound.prefs.v1";
const AUTO = detectLanguages(UI_LANGS.map(([code]) => code)); // first start: follow the device language
export const prefs = Object.assign(
  {
    uiLang: AUTO.ui,       // interface language (i18n.js UI_LANGS)
    helpLang: AUTO.help,   // the learner's own language, for explanations and help (langs.js HELP_LANGS)
    scenario: "chat",
    custom: "",
    rehearse: "",          // the real conversation to rehearse
    rehearseWhen: "",      // its date (yyyy-mm-dd), for the debrief
    docMode: "teacher",
    level: 2,
    strictness: "normal",
    voice: "af_heart",
    voiceEngine: "standard", // standard (Kokoro) | natural (Chatterbox on an NVIDIA GPU)
    rate: 1,
    autoplay: true,
    drill: "flap",
    showIpa: false,
    handsFree: false,
    inputMode: "voice",    // voice | type
    llm: "",               // model pack group: llm-0.8b | llm-2b | llm-4b ("" = recommended for this device)
    asr: "",               // asr-tiny | asr-base
    source: "auto",        // where models download from: auto | hf | mirror
  },
  readJSON(K_PREFS, {}),
);
if (!LEVELS.some((l) => l.id === Number(prefs.level))) prefs.level = 2;
prefs.level = Number(prefs.level);
if (!["gentle", "normal", "strict"].includes(prefs.strictness)) prefs.strictness = "normal";
if (!SCENARIOS.some((s) => s.id === prefs.scenario)) prefs.scenario = "chat";
if (!DRILLS.some((d) => d.id === prefs.drill)) prefs.drill = "flap";
if (!DOC_MODES.includes(prefs.docMode)) prefs.docMode = "teacher";
if (!["standard", "natural"].includes(prefs.voiceEngine)) prefs.voiceEngine = "standard";
prefs.rate = Math.min(1.3, Math.max(0.6, Number(prefs.rate) || 1));
if (prefs.rate === 0.95) prefs.rate = 1; // the old default sounded a little dragged
if (!["auto", "hf", "mirror"].includes(prefs.source)) prefs.source = "auto";
if (!HELP_LANGS.some((l) => l.id === prefs.helpLang)) prefs.helpLang = AUTO.help;
export const savePrefs = () => writeJSON(K_PREFS, prefs);

/* ---------- running state ---------- */
export const state = {
  tab: "talk",          // talk | accent | vocab | me | models
  talkView: "home",     // home | chat | summary
  session: null,        // live conversation
  summaryOf: null,
  summaryCtl: null,
  busy: false,
  doc: null,            // {name, text} picked for the document scenario
};
