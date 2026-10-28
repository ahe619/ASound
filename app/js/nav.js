// Which view is on screen. Tabs register a render function that runs when they are opened.
import { state } from "./state.js";
import { $ } from "./util.js";

export const TABS = ["talk", "accent", "vocab", "voices", "models", "me"];
const renderers = {};
const cleanups = {};
const details = {};
const overlays = {};
const viewCleanups = {};
const NAV_KEY = "asound.navigation.v1";
const initialEntry = readEntry(history.state);
const scrollPositions = new Map();
let entry = null;
let pendingRoute = null;
let started = false;
let backPending = false;
let restoration = 0;
let visibleTab = state.tab;

export function registerTab(tab, fn) { renderers[tab] = fn; }
export function registerTabCleanup(tab, fn) { cleanups[tab] = fn; }
export function registerTabDetail(tab, fn) { (details[tab] ||= []).push(fn); }
export function registerOverlay(name, fn) { overlays[name] = fn; }
export function registerViewCleanup(tab, view, fn) { viewCleanups[`${tab}:${view}`] = fn; }
export const isNewNavigationVisit = () => !initialEntry;

function readEntry(value) {
  const item = value?.[NAV_KEY];
  return item?.version === 1 && typeof item.id === "string"
    && [...TABS, "mode"].includes(item.route?.tab) ? item : null;
}

function routeKey(route) { return JSON.stringify(route); }
function entryId() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`; }
export function currentRoute() {
  return { ...(entry?.route || pendingRoute || { tab: state.tab, ...(state.tab === "talk" ? { talkView: state.talkView } : {}) }) };
}

function captureScroll() {
  const positions = {};
  for (const el of document.querySelectorAll(".view:not([hidden]), #settings-panel, #thread-scroll")) {
    if (el.id && el.getClientRects().length) positions[el.id] = el.scrollTop;
  }
  return positions;
}

function rememberScroll(write = true) {
  if (!entry) return;
  entry.scroll = captureScroll();
  scrollPositions.set(entry.id, entry.scroll);
  if (write && readEntry(history.state)?.id === entry.id) writeEntry(true);
}

function writeEntry(replace) {
  try {
    history[replace ? "replaceState" : "pushState"](
      { ...history.state, [NAV_KEY]: entry }, "", `#${entry.route.tab}`);
  } catch { /* Navigation still works if a restricted webview rejects history writes. */ }
}

export function restoreNavigationScroll() {
  const expected = entry?.id;
  const revision = ++restoration;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (revision !== restoration || entry?.id !== expected) return;
    const positions = scrollPositions.get(expected) || entry?.scroll || {};
    for (const [id, top] of Object.entries(positions)) {
      const el = document.getElementById(id);
      if (el?.getClientRects().length) el.scrollTop = top;
    }
  }));
}

function applyRoute(route, { force = false, restore = false, previousRoute = null } = {}) {
  const changedTab = state.tab !== route.tab;
  const previousView = `${state.tab}:${state.tab === "talk" ? state.talkView : ""}`;
  state.tab = route.tab;
  if (route.tab === "talk") {
    state.talkView = route.talkView || "home";
    // Finished conversations no longer have a live session to accept messages.
    if (state.talkView === "chat" && !state.session) state.talkView = "home";
  }
  const nextView = `${state.tab}:${state.tab === "talk" ? state.talkView : ""}`;
  if (previousView !== nextView || route.overlay) viewCleanups[previousView]?.();
  show(); // Dispose the old view before mounting the destination.
  if (changedTab || force || !started || previousRoute?.detail !== route.detail) {
    for (const fn of details[route.tab] || []) fn(route.detail || null, { restore });
  }
  if (changedTab || previousView !== nextView || force || !started) renderers[route.tab]?.(route);
  for (const [name, fn] of Object.entries(overlays)) fn(route.overlay === name, { restore });
  restoreNavigationScroll();
}

// Called once after boot selected its real landing page. Reload reuses this entry,
// while a new visit has one root entry and can leave normally with browser Back.
export function initNavigation() {
  if (started) return;
  started = true;
  if (initialEntry) {
    entry = initialEntry;
    applyRoute(entry.route, { force: true, restore: true });
  } else {
    entry = { version: 1, id: entryId(), parent: null, route: currentRoute(), scroll: captureScroll() };
    writeEntry(true);
  }
}

export function navigate(route, { replace = false } = {}) {
  if (![...TABS, "mode"].includes(route.tab)) route = { tab: "talk" };
  route = { ...route };
  if (!started) {
    pendingRoute = route;
    applyRoute(route, { force: true });
    return;
  }
  if (routeKey(route) === routeKey(entry.route)) return;
  rememberScroll();
  const previous = entry;
  entry = { version: 1, id: replace ? previous.id : entryId(),
    parent: replace ? previous.parent : previous.id, route, scroll: {} };
  scrollPositions.delete(entry.id);
  writeEntry(replace);
  applyRoute(route, { previousRoute: previous.route,
    force: previous.route.tab !== route.tab || (route.tab === "models" && previous.route.setup !== route.setup)
      || (route.tab === "mode" && previous.route.mode !== route.mode) });
}

export function goBack(fallback = { tab: "talk" }) {
  if (backPending) return;
  if (started && entry?.parent && readEntry(history.state)?.id === entry.id) {
    backPending = true;
    history.back();
  } else navigate(fallback, { replace: true });
}

window.addEventListener("popstate", () => {
  backPending = false;
  const destination = readEntry(history.state);
  if (!started || !destination) return;
  rememberScroll(false);
  entry = destination;
  applyRoute(entry.route, { force: true, restore: true });
});
window.addEventListener("pagehide", () => rememberScroll());

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
  for (const tab of [...TABS.slice(1), "mode"]) $("#view-" + tab).hidden = state.tab !== tab;
  for (const tab of TABS) $("#tab-" + tab).setAttribute("aria-selected", String(state.tab === tab));
}

export function setTab(tab, options) {
  navigate({ tab: TABS.includes(tab) ? tab : "talk", ...(tab === "vocab" ? { detail: "setup" } : {}) }, options);
}

export function setTalkView(view) {
  navigate({ tab: "talk", talkView: view });
  const scroller = { home: "#view-talk-home", summary: "#view-summary" }[view];
  if (scroller) $(scroller).scrollTop = 0;
}
