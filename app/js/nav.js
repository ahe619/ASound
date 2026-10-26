// Which view is on screen. Tabs register a render function that runs when they are opened.
import { state } from "./state.js";
import { $ } from "./util.js";

const TABS = ["talk", "accent", "vocab", "me"];
const renderers = {};
const cleanups = {};
let visibleTab = state.tab;

export function registerTab(tab, fn) { renderers[tab] = fn; }
export function registerTabCleanup(tab, fn) { cleanups[tab] = fn; }

export function show() {
  if (visibleTab !== state.tab) {
    const cleanup = cleanups[visibleTab];
    visibleTab = state.tab;
    if (cleanup) cleanup();
  }
  const talk = state.tab === "talk";
  $("#view-talk-home").hidden = !(talk && state.talkView === "home");
  $("#view-chat").hidden = !(talk && state.talkView === "chat");
  $("#view-summary").hidden = !(talk && state.talkView === "summary");
  for (const tab of [...TABS.slice(1), "models", "mode"]) $("#view-" + tab).hidden = state.tab !== tab;
  for (const tab of TABS) $("#tab-" + tab).setAttribute("aria-selected", String(state.tab === tab));
}

export function setTab(tab) {
  state.tab = TABS.includes(tab) ? tab : "talk";
  const fn = renderers[state.tab];
  if (fn) fn();
  show();
}

export function setTalkView(view) {
  state.tab = "talk";
  state.talkView = view;
  show();
  const scroller = { home: "#view-talk-home", summary: "#view-summary" }[view];
  if (scroller) $(scroller).scrollTop = 0;
}
