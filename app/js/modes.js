// Extra practice modes (app/js/feat-*.js). Each exports meta {id, where: "talk" | "accent", icon} and
// mount(root, {onExit}) returns a cleanup function; its text keys are "<id>.*".
import { state } from "./state.js";
import { $, h, icon } from "./util.js";
import { t, addStrings } from "./i18n.js";
import { show, setTab, registerTabCleanup } from "./nav.js";
import { stopSpeaking } from "./speech.js";
import { handsFree } from "./mic.js";

const MODES = [
  { id: "retell", where: "talk", icon: "wave", load: () => import("./feat-retell.js") },
  { id: "phone", where: "talk", icon: "mic", load: () => import("./feat-phone.js") },
  { id: "ladder", where: "accent", icon: "speaker", load: () => import("./feat-ladder.js") },
];

let back = "talk";
let version = 0;
let dispose = null;
const styles = new Map();
let initialized = null;

// Titles are needed by the cards before a mode is opened. Keep both languages available
// so changing the interface language does not need another download.
export function initModes() {
  if (!initialized) {
    registerTabCleanup("mode", disposeMode);
    // Return to the parent tab before a page enters the back/forward cache, so restoring
    // it never revives an empty mode view or a recording that was already cancelled.
    window.addEventListener("pagehide", () => { if (state.tab === "mode") closeMode(); });
    initialized = Promise.all(MODES.map(async (m) => {
      const res = await fetch(`locales/feat/${m.id}.json`);
      if (!res.ok) throw new Error(`missing practice strings: ${m.id}`);
      const strings = await res.json();
      for (const [lang, dict] of Object.entries(strings)) addStrings(lang, dict);
    }));
  }
  return initialized;
}

function loadStyle(id) {
  if (!styles.has(id)) {
    styles.set(id, new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `css/feat/${id}.css`;
      link.onload = resolve;
      link.onerror = () => {
        link.remove();
        styles.delete(id);
        reject(new Error(`missing practice styles: ${id}`));
      };
      document.head.append(link);
    }));
  }
  return styles.get(id);
}

// Cards for the modes that belong on a tab ("talk" or "accent").
export function modeCards(where) {
  const list = MODES.filter((m) => m.where === where);
  if (!list.length) return null;
  return h("section", { class: "stack-sm" },
    h("h2", { class: "sec" }, t("modes.title")),
    h("div", { class: "mode-grid" }, list.map((m) => h("button", { type: "button", class: "mode-card", onclick: () => openMode(m) },
      h("span", { class: "mode-icon" }, icon(m.icon)),
      h("span", { class: "mode-text" }, h("strong", null, t(`${m.id}.title`)), h("span", { class: "hint-line" }, t(`${m.id}.pitch`)))))));
}

async function openMode(m) {
  back = state.tab;
  disposeMode();
  handsFree.stop();
  const mine = version;
  const root = $("#mode");
  root.replaceChildren(h("button", { type: "button", class: "btn quiet back", onclick: closeMode }, icon("back"), t("models.back")),
    h("h1", { class: "title" }, t(`${m.id}.title`)));
  root.setAttribute("aria-busy", "true");
  state.tab = "mode";
  show();
  $("#view-mode").scrollTop = 0;
  try {
    const [mod] = await Promise.all([m.load(), loadStyle(m.id), initModes()]);
    if (mine !== version || state.tab !== "mode") return;
    dispose = mod.mount(root, { onExit: closeMode });
  } catch (e) {
    if (mine !== version || state.tab !== "mode") return;
    console.error(e);
    root.append(h("p", { class: "banner" }, t("modes.failed")), h("button", { type: "button", class: "btn", onclick: closeMode }, t("models.back")));
  } finally {
    if (mine === version) root.removeAttribute("aria-busy");
  }
}

function disposeMode() {
  version++;
  const cleanup = dispose;
  dispose = null;
  if (typeof cleanup === "function") cleanup();
  stopSpeaking();
  if (window.ASoundMic && window.ASoundMic.cancel) window.ASoundMic.cancel();
  const root = $("#mode");
  if (root) { root.replaceChildren(); root.removeAttribute("aria-busy"); }
}

function closeMode() {
  setTab(back === "mode" ? "talk" : back);
}
