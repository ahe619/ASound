// ASound entry point: load the interface language, build the tabs, and resume where the learner left off.
import { prefs, state } from "./state.js";
import { $, h } from "./util.js";
import { setLanguage, applyI18n, t } from "./i18n.js";
import { registerTab, registerTabCleanup, setTab, show, initNavigation } from "./nav.js";
import { initTalk, renderTalkHome, resumeIfRecent } from "./talk.js";
import { initAccent, renderAccent } from "./accent.js";
import { renderVocab, paintVocabCount, cleanupVocab, isVocabPracticing } from "./vocab.js";
import { renderMe } from "./me.js";
import { initSettings } from "./settings.js";
import { onStoreChange } from "./store.js";
import { repaintSaveButtons } from "./widgets.js";
import { warmUp } from "./speech.js";
import { ready, packMode } from "./packs.js";
import { initUpdates } from "./updates.js";
import { startEngines } from "./engines.js";
import { showModels, renderModels } from "./models.js";
import { initModes } from "./modes.js";
import { initLayout, deviceInfo } from "./device.js";

function syncLabels() {
  if (window.ASoundAI) window.ASoundAI.setLabels({ loading: t("llm.loading"), error: t("llm.error"), noGpu: t("llm.noGpu") });
}

function renderAll() {
  applyI18n(document);
  syncLabels();
  if (state.talkView === "home") renderTalkHome();
  if (state.tab === "accent") renderAccent();
  if (state.tab === "vocab") renderVocab();
  if (state.tab === "me") renderMe();
  if (state.tab === "models") renderModels();
  paintVocabCount();
}

async function boot() {
  initLayout();
  await Promise.all([setLanguage(prefs.uiLang), initModes()]);
  syncLabels();
  registerTab("talk", () => { if (state.talkView === "home") renderTalkHome(); });
  registerTab("accent", renderAccent);
  registerTab("vocab", renderVocab);
  registerTabCleanup("vocab", cleanupVocab);
  window.addEventListener("pagehide", cleanupVocab);
  window.addEventListener("pageshow", event => {
    if (event.persisted && state.tab === "vocab") renderVocab();
  });
  registerTab("me", renderMe);
  for (const tab of ["talk", "accent", "vocab", "me"]) $("#tab-" + tab).addEventListener("click", () => setTab(tab));

  initTalk();
  initAccent();
  initSettings({ languageChanged: renderAll });
  onStoreChange((what) => {
    if (what === "vocab") { paintVocabCount(); repaintSaveButtons(); if (state.tab === "vocab") renderVocab(); }
    if (what === "sessions" && state.tab === "talk" && state.talkView === "home") renderTalkHome();
    if ((what === "profile" || what === "placements") && state.tab === "me") renderMe();
  });

  // A hosted (https) web visit lands on word study, which needs no models: show it now and look at the model
  // packs in the background. The desktop app (local http server) decides between setup and practice first.
  const hosted = location.protocol === "https:" && !inAppShell;
  const engines = startEngines(renderModels);
  if (hosted) {
    const hash = location.hash.slice(1);
    setTab(["talk", "accent", "vocab", "me"].includes(hash) ? hash : "vocab");
    initNavigation();
  }
  await engines;
  // Only hosted web releases update themselves. Bundled desktop/mobile assets use package updates.
  initUpdates({
    enabled: packMode() === "web" && !inAppShell,
    canApply: () => !state.busy && state.tab !== "mode" && state.tab !== "accent"
      && !(state.tab === "vocab" && isVocabPracticing())
      && !(state.tab === "talk" && state.talkView === "chat")
      && !["recording", "listening"].includes(window.ASoundMic?.status().mic),
  });

  renderTalkHome();
  paintVocabCount();
  const start = () => {
    resumeIfRecent();
    const hash = location.hash.slice(1);
    if (["accent", "vocab", "me"].includes(hash)) setTab(hash);
    show();
    warmUp();
    // Load speech recognition once the first screen is up, not in the middle of it.
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    if (window.ASoundMic && !deviceInfo().mobile) idle(() => window.ASoundMic.preload(), { timeout: 4000 });
  };
  // Web visitors can study words and use available system voices immediately.
  // Optional conversation resources remain accessible from the settings screen.
  if (hosted) {
    if (ready()) {
      resumeIfRecent(); // a conversation from the last half hour comes back, as before
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
      idle(() => warmUp(), { timeout: 4000 });
    }
  }
  else if (ready()) start();
  else if (packMode() === "web") {
    const hash = location.hash.slice(1);
    setTab(["talk", "accent", "vocab", "me"].includes(hash) ? hash : "vocab");
  }
  else {
    showModels({ setup: true, onReady: start });
    // Text vocabulary study does not require downloading or starting any AI model.
    if (location.hash.slice(1) === "vocab") setTab("vocab");
  }
  if (!hosted) initNavigation();
}

// Installed as a web app (https): keep the app itself available offline.
// (Not inside the Android app shell: its files are already local, served by the app itself.)
const inAppShell = new URLSearchParams(location.search).has("app") || /; wv\)/.test(navigator.userAgent);

boot().catch((e) => {
  console.error(e);
  document.body.append(h("p", { class: "banner" }, "ASound failed to start: " + (e && e.message)));
});
