// Playback feedback is shared by lessons and settings; no inference starts here.
import { h } from "./util.js";
import { t } from "./i18n.js";
import { onSpeechStatus, speechStatus, voiceCapabilities, stopSpeaking, useBasicSpeechNow } from "./speech.js";

export function initSpeechFeedback() {
  const text = h("span", { role: "status", "aria-live": "polite" });
  const elapsed = h("span", { class: "hint-line", "aria-hidden": "true" });
  const basic = h("button", { type: "button", class: "btn", onclick: useBasicSpeechNow });
  const stop = h("button", { type: "button", class: "btn quiet", onclick: stopSpeaking });
  const notice = h("div", { class: "speech-notice", hidden: true },
    h("div", { class: "stack-sm" }, text, elapsed), h("div", { class: "row" }, basic, stop));
  document.body.append(notice);
  let timer = null;
  const paint = () => {
    clearTimeout(timer);
    const status = speechStatus();
    const waiting = ["preparing", "loading", "generating"].includes(status.phase);
    const seconds = status.waitingSince ? Math.floor((Date.now() - status.waitingSince) / 1000) : 0;
    // Fast cached speech needs no transient overlay; slower work gets visible feedback.
    notice.hidden = !((waiting && seconds >= 1) || status.phase === "error");
    const message = status.phase === "error" ? t("speech.failed") : t(`speech.${status.phase}`);
    if (text.textContent !== message) text.textContent = message;
    elapsed.textContent = waiting ? t("speech.waiting", { seconds }) : "";
    basic.hidden = !waiting || seconds < 8 || !voiceCapabilities().systemEnglish;
    basic.textContent = t("speech.useBasic");
    stop.textContent = t(status.phase === "error" ? "common.close" : "speech.stop");
    if (waiting) timer = setTimeout(paint, 1000);
  };
  onSpeechStatus(paint);
}
