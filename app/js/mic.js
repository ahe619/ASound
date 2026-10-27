// Microphone controls built on window.ASoundMic (js/voice-input.js).
//   micButton({onText, onAudio, big})  tap to start, tap again to stop; the transcript goes to onText
//   handsFree                          continuous listening for live conversation
import { h, icon, toast } from "./util.js";
import { t } from "./i18n.js";
import { stopSpeaking, unlockAudio } from "./speech.js";
import { enginesApplied } from "./engines.js";

export const micSupported = () => !!(window.ASoundMic && window.ASoundMic.supported);

function micErrorText(e) {
  const name = e && e.name;
  if (name === "NotAllowedError" || name === "SecurityError") return t("mic.err.denied");
  if (name === "NotFoundError") return t("mic.err.none");
  return t("mic.err.generic");
}

// Speech needs the listening model (a downloadable pack). Without it, say so and open the downloads.
// false, or a promise of true when there is no speech model (the learner is sent to the models page). The hosted
// page is usable before the model packs are checked: a tap in that moment waits for the check, not "no model".
function needModel(active, cancel) {
  if (!window.ASoundMic.hasModel || window.ASoundMic.hasModel()) return false;
  // No capture exists yet to deliver onCancel. An external close/cancel still emits
  // an off status, so include this preparation stage in the same cancellation chain.
  const unlisten = window.ASoundMic.onStatus?.(status => {
    if (status.mic === "off" && active()) cancel();
  });
  return enginesApplied.then(async () => {
    if (!active() || window.ASoundMic.hasModel()) return false;
    const models = await import("./models.js").catch(() => null);
    if (!active() || window.ASoundMic.hasModel()) return false;
    toast(t("mic.err.noModel"));
    if (active()) models?.showModels();
    return true;
  }).finally(() => unlisten?.());
}
function asrErrorText(e) {
  if (e && e.code === "no_model") return t("mic.err.noModel");
  if (window.ASoundMic.status().asr === "error") return t("mic.err.asrLoad");
  return t("mic.err.asr");
}

let current = null; // one button owns capture, permission waiting, or transcription at a time
function cancelCurrent() {
  const control = current;
  if (!control) return;
  window.ASoundMic.cancel();
  if (current === control) control.reset();
}
export function cancelMicButton(button) {
  if (current?.button === button) cancelCurrent();
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
  const control = { button: btn, reset() {
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
      // false when the model is there: no await, the tap records at once. Otherwise the packs are still being
      // checked (hosted start) or there is no model: the button shows busy meanwhile and the next tap records
      // (a microphone opened after a wait is outside the tap, and Safari keeps it silent).
      const active = () => id === operation && current === control && btn.isConnected !== false;
      const missing = !lang && needModel(active, () => control.reset());
      if (missing) {
        await missing;
        if (id === operation) control.reset();
        return;
      }
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
        toast(asrErrorText(e));
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
    const waiting = { handsFree: true, reset: () => {
      if (active()) { ++handsFreeRun; handsFreeStarting = false; this.on = false; }
      if (current === waiting) current = null;
    } };
    const missing = needModel(active, waiting.reset);
    if (missing) {
      current = waiting;
      try { await missing; } finally { waiting.reset(); }
      return false; // after a wait, the learner starts again inside a fresh tap
    }
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
    const waiting = current?.handsFree;
    if (waiting) cancelCurrent();
    ++handsFreeRun;
    handsFreeStarting = false;
    this.on = false;
    if (active && !waiting) window.ASoundMic.cancel();
  },
};
