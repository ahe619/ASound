// Display preferences never grant device capabilities. A phone using the desktop
// layout is still a phone when choosing models or local speech services.
const STORAGE_KEY = "asound.layout.v1";
const MODES = new Set(["auto", "phone", "tablet", "desktop"]);
let mode = "auto";
let initialized = false;
let last = "";
const listeners = new Set();

export function deviceInfo(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || "");
  const ipad = /iPad/i.test(ua) || (/Macintosh|MacIntel/i.test(`${ua} ${nav?.platform || ""}`) && Number(nav?.maxTouchPoints) > 1);
  const tablet = ipad || /Tablet|Kindle|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const phone = !tablet && (/iPhone|iPod|Mobile|Windows Phone/i.test(ua) || !!nav?.userAgentData?.mobile);
  return { kind: tablet ? "tablet" : phone ? "phone" : "desktop", mobile: tablet || phone };
}

export function layoutForWidth(width) {
  const value = Number(width);
  if (!Number.isFinite(value) || value <= 0) return "desktop";
  return value <= 600 ? "phone" : value <= 1024 ? "tablet" : "desktop";
}

function loadMode() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    mode = MODES.has(saved) ? saved : "auto";
  } catch { mode = "auto"; }
}

export const getLayoutMode = () => mode;
export const layoutInfo = () => ({
  mode,
  layout: mode === "auto" ? layoutForWidth(globalThis.window?.innerWidth) : mode,
});

function applyLayout() {
  const info = layoutInfo();
  const root = globalThis.document?.documentElement;
  if (root) {
    root.dataset.layout = info.layout;
    root.dataset.layoutMode = info.mode;
    root.dataset.device = deviceInfo().kind;
    const viewport = globalThis.window?.visualViewport;
    // Do not shrink the whole app while the user pinch-zooms. At normal zoom,
    // the visible height follows mobile browser bars and the on-screen keyboard.
    const height = viewport && Math.abs(viewport.scale - 1) < 0.01
      ? viewport.height : globalThis.window?.innerHeight;
    if (Number.isFinite(height) && height > 0) root.style.setProperty("--app-viewport-height", `${Math.round(height)}px`);
  }
  const signature = `${info.mode}:${info.layout}`;
  if (signature !== last) {
    last = signature;
    listeners.forEach(fn => { try { fn(info); } catch (error) { console.warn("layout listener", error); } });
  }
  return info;
}

export function initLayout() {
  if (!initialized) {
    initialized = true;
    loadMode();
    globalThis.window?.addEventListener("resize", applyLayout);
    globalThis.window?.visualViewport?.addEventListener("resize", applyLayout);
    globalThis.window?.addEventListener("storage", event => {
      if (event.key === STORAGE_KEY || event.key === null) { loadMode(); applyLayout(); }
    });
  }
  return applyLayout();
}

export function setLayoutMode(value) {
  if (!MODES.has(value)) return layoutInfo();
  mode = value;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, mode); } catch { /* Keep the selection for this page when storage is unavailable. */ }
  return applyLayout();
}

export function onLayoutChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
