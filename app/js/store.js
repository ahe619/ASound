// Learner data kept on this computer (localStorage): vocabulary, finished sessions, profile, test results.
import { readJSON, writeJSON, removeKey, slug, str, arr, isObj } from "./util.js";

const K = {
  vocab: "asound.vocab.v1",
  sessions: "asound.sessions.v1",
  profile: "asound.profile.v1",
  placements: "asound.placements.v1",
  checks: "asound.checks.v1",
  live: "asound.live.v1",
  drill: "asound.drill.v1",
  voiceF0: "asound.voicef0.v1",
  rehearsals: "asound.rehearsals.v1",
};

const listeners = new Set();
export const onStoreChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = (what) => listeners.forEach((fn) => { try { fn(what); } catch (e) { console.warn(e); } });

/* vocabulary */
export const vocab = {
  all: () => arr(readJSON(K.vocab, [])).filter(isObj),
  has: (term) => vocab.all().some((v) => v.id === slug(term)),
  add(item) {
    const id = slug(item.term);
    const doc = { id, term: str(item.term), ipa: str(item.ipa), meaning: str(item.meaning), example: str(item.example), source: str(item.source), createdAt: Date.now() };
    writeJSON(K.vocab, [doc, ...vocab.all().filter((v) => v.id !== id)]);
    changed("vocab");
  },
  remove(id) {
    writeJSON(K.vocab, vocab.all().filter((v) => v.id !== id));
    changed("vocab");
  },
  update(id, patch) {
    writeJSON(K.vocab, vocab.all().map((v) => (v.id === id ? { ...v, ...patch } : v)));
    changed("vocab");
  },
  // The learner used a saved expression in a real conversation; it counts once per session.
  use(id, sessionId) {
    const v = vocab.all().find((x) => x.id === id);
    if (!v) return 0;
    const used = arr(v.used).filter((x) => typeof x === "string");
    if (!used.includes(sessionId)) used.push(sessionId);
    vocab.update(id, { used: used.slice(-10) });
    return used.length;
  },
  // Spaced repetition: a word is due when its `due` time has passed (new words are due at once).
  due: () => { const now = Date.now(); return vocab.all().filter((v) => (Number(v.due) || 0) <= now); },
};

/* finished conversations (newest first, at most 50) */
export const sessions = {
  all: () => arr(readJSON(K.sessions, [])).filter(isObj),
  save(doc) {
    writeJSON(K.sessions, [doc, ...sessions.all().filter((s) => s.id !== doc.id)].slice(0, 50));
    changed("sessions");
  },
  remove(id) {
    writeJSON(K.sessions, sessions.all().filter((s) => s.id !== id));
    changed("sessions");
  },
};

/* what the learner told the profile interview */
export const profile = {
  get: () => { const p = readJSON(K.profile, null); return isObj(p) ? p : null; },
  set(p) { writeJSON(K.profile, { ...p, updatedAt: Date.now() }); changed("profile"); },
  clear() { removeKey(K.profile); changed("profile"); },
};

/* placement test results and accent checks (newest first) */
export const placements = {
  all: () => arr(readJSON(K.placements, [])).filter(isObj),
  add(r) { writeJSON(K.placements, [r, ...placements.all()].slice(0, 30)); changed("placements"); },
};
export const checks = {
  all: () => arr(readJSON(K.checks, [])).filter(isObj),
  add(r) { writeJSON(K.checks, [r, ...checks.all()].slice(0, 60)); changed("checks"); },
};

/* the conversation in progress, so a reload can resume it */
export const live = {
  get: () => readJSON(K.live, null),
  set: (s) => writeJSON(K.live, s),
  clear: () => removeKey(K.live),
};
export const drillStore = {
  get: () => readJSON(K.drill, null),
  set: (d) => writeJSON(K.drill, d),
  clear: () => removeKey(K.drill),
};
/* real conversations the learner rehearsed, waiting for a debrief (newest first) */
export const rehearsals = {
  all: () => arr(readJSON(K.rehearsals, [])).filter(isObj),
  add(r) { writeJSON(K.rehearsals, [r, ...rehearsals.all().filter((x) => x.id !== r.id)].slice(0, 20)); changed("rehearsals"); },
  update(id, patch) { writeJSON(K.rehearsals, rehearsals.all().map((x) => (x.id === id ? { ...x, ...patch } : x))); changed("rehearsals"); },
};

export const voiceF0 = {
  get: () => Number(readJSON(K.voiceF0, 0)) || 0,
  set: (hz) => writeJSON(K.voiceF0, Math.round(hz)),
};
