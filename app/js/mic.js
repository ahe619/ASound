// Microphone controls built on window.ASoundMic (js/voice-input.js).
//   micButton({onText, onAudio, big})  tap to start, tap again to stop; the transcript goes to onText
//   handsFree                          continuous listening for live conversation
import { h, icon, toast } from "./util.js";
import { t } from "./i18n.js";
import { stopSpeaking, unlockAudio } from "./speech.js";

export const micSupported = () => !!(window.ASoundMic && window.ASoundMic.supported);

function micErrorText(e) {
  const name = e && e.name;
  if (name === "NotAllowedError" || name === "SecurityError") return t("mic.err.denied");
  if (name === "NotFoundError") return t("mic.err.none");
  return t("mic.err.generic");
}

let current = null; // one button owns capture, permission waiting, or transcription at a time
function cancelCurrent() {
  const control = current;
  if (!control) return;
  window.ASoundMic.cancel();
  if (current === control) control.reset();
}
const wasCancelled = (e) => e && (e.name === "AbortError" || e.code === "cancelled");

// lang: transcribe with the multilingual recognizer in this language (speech in the learner's own language)
export function micButton({ onText, onAudio, big = false, label, lang = "" } = {}) {
  const btn = h("button", { type: "button", class: "mic-btn" + (big ? " big" : ""), "aria-label": label || t("mic.start"), title: label || t("mic.start") }, icon("mic"));
  let state = "idle"; // idle | starting | rec | busy
  let operation = 0;
  const paint = () => {
    btn.classList.toggle("rec", state === "rec");
    btn.classList.toggle("busy", state === "busy" || state === "starting");
    const text = state === "rec" ? t("mic.stop") : state === "busy" || state === "starting" ? t("mic.busy") : label || t("mic.start");
    btn.setAttribute("aria-label", text);
    btn.title = text;
    if (state !== "rec") btn.style.setProperty("--lvl", 0);
  };
  const control = { reset() {
    ++operation;
    state = "idle";
    if (current === control) current = null;
    paint();
  } };
  btn.addEventListener("click", async () => {
    if (!micSupported()) { toast(t("mic.err.unsupported")); return; }
    unlockAudio();
    if (state === "busy") return;
    if (state === "starting") { cancelCurrent(); return; }
    if (state === "idle") {
      cancelCurrent();
      stopSpeaking();
      const id = ++operation;
      current = control;
      state = "starting";
      paint();
      try {
        await window.ASoundMic.record({
          onLevel: (v) => { if (id === operation) btn.style.setProperty("--lvl", v.toFixed(2)); },
          onCancel: () => { if (id === operation) control.reset(); },
        });
        if (id !== operation) return;
        state = "rec";
        paint();
      } catch (e) {
        if (id !== operation) return;
        control.reset();
        if (!wasCancelled(e)) toast(micErrorText(e));
      }
      return;
    }
    state = "busy";
    paint();
    const id = operation;
    try {
      let { text, audio } = await window.ASoundMic.stop({ raw: !!lang });
      if (id !== operation) return;
      if (lang && audio && audio.length >= 0.3 * window.ASoundMic.RATE) text = await window.ASoundMic.transcribeNative(audio.slice(), lang);
      if (id !== operation) return;
      if (onAudio && audio) onAudio(audio);
      if (id !== operation) return;
      if (!text) toast(t("mic.heardNothing"));
      else onText && onText(text);
    } catch (e) {
      if (id === operation && !wasCancelled(e)) {
        console.warn(e);
        toast(t("mic.err.asr"));
      }
    } finally {
      if (id === operation) control.reset();
    }
  });
  paint();
  return btn;
}

// Hands-free conversation: listen -> (utterance) -> onText -> pause while the app thinks and speaks -> resume.
let handsFreeRun = 0;
let handsFreeStarting = false;
export const handsFree = {
  on: false,
  // endMs: how long a pause ends a turn (learners need longer pauses than native speakers)
  async start({ onText, onState, onLevel, endMs }) {
    if (!micSupported()) { toast(t("mic.err.unsupported")); return false; }
    this.stop();
    cancelCurrent();
    const run = ++handsFreeRun;
    handsFreeStarting = true;
    const active = () => run === handsFreeRun;
    try {
      await window.ASoundMic.listen({
        endMs,
        onLevel: (level) => { if (active() && onLevel) onLevel(level); },
        onCancel: () => { if (active()) { ++handsFreeRun; handsFreeStarting = false; this.on = false; } },
        onSpeechStart: () => { if (active()) { stopSpeaking(); onState && onState("hearing"); } },
        onUtterance: () => { if (active()) { window.ASoundMic.pause(); onState && onState("transcribing"); } },
        onDiscard: () => { if (active() && onState) onState("listening"); },
        onText: (text) => {
          if (!active()) return;
          if (text && text.trim()) onText(text.trim());
          else { window.ASoundMic.resume(); onState && onState("listening"); }
        },
        onError: () => { if (active()) { window.ASoundMic.resume(); onState && onState("listening"); } },
      });
      if (!active()) return false;
      handsFreeStarting = false;
      this.on = true;
      onState && onState("listening");
      return true;
    } catch (e) {
      if (active()) {
        handsFreeStarting = false;
        if (!wasCancelled(e)) toast(micErrorText(e));
      }
      return false;
    }
  },
  pause() { if (this.on) window.ASoundMic.pause(); },
  resume() { if (this.on) window.ASoundMic.resume(); },
  stop() {
    const active = this.on || handsFreeStarting;
    ++handsFreeRun;
    handsFreeStarting = false;
    this.on = false;
    if (active) window.ASoundMic.cancel();
  },
};
