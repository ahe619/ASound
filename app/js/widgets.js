// Small interface pieces shared by several tabs.
import { prefs, savePrefs } from "./state.js";
import { h, fill, icon, toast } from "./util.js";
import { t, getLanguage } from "./i18n.js";
import { vocab, voiceF0 } from "./store.js";
import { VOICES, recommendVoices, speak, unlockAudio, voiceById } from "./speech.js";
// (paintSpeak handles the play/stop icon on preview buttons through speak())
import { micButton } from "./mic.js";
import { medianF0 } from "./pitch.js";

export function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString(document.documentElement.lang || "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}
export function fmtDay(ts) {
  try { return new Date(ts).toLocaleDateString(document.documentElement.lang || "en-US", { month: "short", day: "numeric" }); } catch { return ""; }
}
export const levelName = (id) => `${id} \u00b7 ${t(`level.${id}.name`)}`;

// Replace a delete button with "Delete / Cancel" until the learner decides.
export function confirmInline(btn, onYes) {
  const yes = h("button", { type: "button", class: "mini danger" }, t("common.confirmDelete"));
  const no = h("button", { type: "button", class: "mini" }, t("common.cancel"));
  const box = h("span", { class: "row" }, yes, no);
  btn.replaceWith(box);
  yes.addEventListener("click", () => { yes.disabled = true; onYes(); });
  no.addEventListener("click", () => box.replaceWith(btn));
  yes.focus();
}

/* "+ Vocab" button that knows whether the term is already saved */
export function saveBtn(item) {
  const btn = h("button", { type: "button", class: "mini save-btn", "data-term": item.term });
  paintSave(btn);
  btn.addEventListener("click", () => {
    if (vocab.has(item.term)) { toast(t("vocab.already")); return; }
    vocab.add(item);
    toast(t("vocab.saved"));
  });
  return btn;
}
export function paintSave(btn) {
  const has = vocab.has(btn.dataset.term);
  btn.classList.toggle("done", has);
  btn.replaceChildren(icon(has ? "check" : "plus"), has ? t("vocab.inBook") : t("vocab.save"));
}
export const repaintSaveButtons = () => document.querySelectorAll(".save-btn").forEach(paintSave);

/* voice picker: every voice with a preview, the chosen one marked */
export function voicePicker(onPick) {
  const sample = "Hey! I'm gonna help you practice your American accent. Let's get started.";
  const grid = h("div", { class: "grid voice-grid" });
  const paint = () => {
    fill(grid, VOICES.map((v) => {
      const chosen = v.id === prefs.voice;
      const play = h("button", { type: "button", class: "icon-btn sm", "aria-label": t("voice.preview"), title: t("voice.preview") }, icon("speaker"));
      play.addEventListener("click", (e) => { e.stopPropagation(); unlockAudio(); speak(sample, play, 1, null, v.id); });
      const card = h("div", { class: "opt voice-opt", role: "button", tabindex: "0", "aria-pressed": String(chosen) },
        h("div", { class: "row" }, h("span", { class: "opt-en", lang: "en" }, v.name), play),
        h("span", { class: "opt-desc" }, t(`voice.${v.id}`)),
        h("span", { class: "opt-desc" }, `${t(v.gender === "f" ? "voice.female" : "voice.male")} \u00b7 ${v.f0} Hz`));
      const choose = () => { prefs.voice = v.id; savePrefs(); paint(); onPick && onPick(v); };
      card.addEventListener("click", choose);
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
      return card;
    }));
  };
  paint();
  return grid;
}

/* Record a sentence, measure the learner's pitch, and suggest the closest voices. */
export function voiceRecommendCard() {
  const out = h("div", { class: "stack-sm" });
  const prompt = "I'd like to practice my English every day so I can speak naturally and confidently.";
  const showRecs = (f0) => {
    const recs = recommendVoices(f0, 3);
    if (!recs.length) { fill(out, h("p", { class: "hint-line" }, t("voice.recNoPitch"))); return; }
    fill(out,
      h("p", null, t("voice.recYourPitch", { hz: Math.round(f0) })),
      h("ul", { class: "plain" }, recs.map((v, i) => {
        const use = h("button", { type: "button", class: "mini" + (prefs.voice === v.id ? " done" : "") }, prefs.voice === v.id ? t("voice.inUse") : t("voice.use"));
        use.addEventListener("click", () => { prefs.voice = v.id; savePrefs(); toast(t("voice.switched", { name: v.name })); showRecs(f0); });
        const play = h("button", { type: "button", class: "icon-btn sm", "aria-label": t("voice.preview") }, icon("speaker"));
        play.addEventListener("click", () => { unlockAudio(); speak(prompt, play, 1, null, v.id); });
        return h("li", { class: "row" }, h("strong", { lang: "en" }, `${i + 1}. ${v.name}`), h("span", { class: "hint-line" }, `${t(`voice.${v.id}`)} \u00b7 ${v.f0} Hz`), play, use);
      })),
      h("p", { class: "hint-line" }, t("voice.recWhy")));
  };
  const mic = micButton({
    label: t("voice.recRecord"),
    onAudio: (audio) => {
      const f0 = medianF0(audio, window.ASoundMic.RATE);
      if (f0) { voiceF0.set(f0); showRecs(f0); } else fill(out, h("p", { class: "hint-line" }, t("voice.recNoPitch")));
    },
  });
  const saved = voiceF0.get();
  if (saved) showRecs(saved);
  return h("div", { class: "card" },
    h("h2", { class: "sec" }, t("voice.recTitle")),
    h("p", { class: "lede" }, t("voice.recLede")),
    h("p", { class: "drill-text small", lang: "en" }, prompt),
    h("div", { class: "attempt-row" }, mic, h("span", { class: "hint-line" }, t("voice.recHint"))),
    out);
}

export const currentVoiceName = () => voiceById(prefs.voice).name;
