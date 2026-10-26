// ASound entry point: load the interface language, build the tabs, and resume where the learner left off.
import { prefs, state } from "./state.js";
import { $, h } from "./util.js";
import { setLanguage, applyI18n, t } from "./i18n.js";
import { registerTab, setTab, show } from "./nav.js";
import { initTalk, renderTalkHome, resumeIfRecent } from "./talk.js";
import { initAccent, renderAccent } from "./accent.js";
import { renderVocab, paintVocabCount } from "./vocab.js";
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
  await Promise.all([setLanguage(prefs.uiLang), initModes()]);
  syncLabels();
  registerTab("talk", () => { if (state.talkView === "home") renderTalkHome(); });
  registerTab("accent", renderAccent);
  registerTab("vocab", renderVocab);
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

  await startEngines(renderModels);
  // Only hosted web releases update themselves. Bundled desktop/mobile assets use package updates.
  initUpdates({
    enabled: packMode() === "web" && !inAppShell,
    canApply: () => !state.busy && state.tab !== "mode" && state.tab !== "accent"
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
    if (window.ASoundMic) window.ASoundMic.preload();
  };
  // First run (or models removed): set up the downloads before anything else.
  if (ready()) start(); else showModels({ setup: true, onReady: start });
}

// Installed as a web app (https): keep the app itself available offline.
// (Not inside the Android app shell: its files are already local, served by the app itself.)
const inAppShell = new URLSearchParams(location.search).has("app") || /; wv\)/.test(navigator.userAgent);

boot().catch((e) => {
  console.error(e);
  document.body.append(h("p", { class: "banner" }, "ASound failed to start: " + (e && e.message)));
});
