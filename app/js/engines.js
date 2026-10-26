// Start the local engines on the installed model packs, and follow changes (downloads, removals, a new choice).
import { initPacks, onPacks, activePacks, variant, engineConfig } from "./packs.js";
import { configureVoice, recheckSpeech } from "./speech.js";

let sig = "";
export async function applyEngines() {
  const a = activePacks();
  const next = JSON.stringify(a);
  if (next === sig) return;
  sig = next;
  if (a.llm && window.ASoundAI) window.ASoundAI.configure((await engineConfig(variant(a.llm))).llm);
  if (a.asr && window.ASoundMic) {
    const c = await engineConfig(a.asr);
    window.ASoundMic.configure({ model: c.asr.model, mode: c.mode, base: c.base, cache: c.cache, canon: c.canon, gpu: a.asr === "asr-base" });
  }
  if (a.voice) { configureVoice(await engineConfig("voice")); recheckSpeech(); }
  else configureVoice(null);
  if (a.helpAsr && window.ASoundMic) {
    const c = await engineConfig("help-asr");
    window.ASoundMic.configureHelp({ model: c.asr.model, mode: c.mode, base: c.base, cache: c.cache, canon: c.canon, gpu: false });
  }
}

export async function startEngines(onChange) {
  await initPacks().catch((e) => console.warn("model packs", e));
  await applyEngines();
  onPacks(() => { applyEngines(); if (onChange) onChange(); });
  document.addEventListener("asound:packs-chosen", applyEngines);
}
