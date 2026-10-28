// Runs before stylesheets so saved colors apply before the first paint.
// This setting is independent of language, layout, and model capabilities.
(() => {
  "use strict";
  const KEY = "asound.theme.v1";
  const MODES = ["system", "light", "dark"];
  const root = document.documentElement;
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const labels = {
    en: { system: "Follow system", light: "Day mode", dark: "Night mode", appearance: "Appearance", next: "Switch to" },
    zh: { system: "跟随系统", light: "白天模式", dark: "黑夜模式", appearance: "外观", next: "切换为" },
  };
  const drawings = {
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
    dark: '<path d="M20.5 13A8.7 8.7 0 0 1 11 3.5 8.7 8.7 0 1 0 20.5 13Z"/>',
  };
  let button = null;
  let mode = "system";

  function savedMode() {
    try {
      const value = window.localStorage.getItem(KEY);
      return MODES.includes(value) ? value : "system";
    } catch { return "system"; }
  }

  const resolvedTheme = () => mode === "system" ? (media?.matches ? "dark" : "light") : mode;
  function labelButton() {
    if (!button) return;
    const text = labels[/^zh(?:-|$)/i.test(root.lang) ? "zh" : "en"];
    const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    const current = mode === "system" ? `${text.system} (${text[resolvedTheme()]})` : text[mode];
    const label = `${text.appearance}: ${current}. ${text.next} ${text[next]}`;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.dataset.themeMode = mode;
    // All markup is fixed app-owned SVG; no stored or user text is inserted as HTML.
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${drawings[mode]}</svg>`;
  }

  function apply() {
    root.dataset.theme = mode;
    root.dataset.resolvedTheme = resolvedTheme();
    // Native form controls follow the explicit selection even if the OS differs.
    root.style.colorScheme = resolvedTheme();
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = resolvedTheme() === "dark" ? "#121A3A" : "#FFFFFF";
    labelButton();
  }

  function setMode(value) {
    if (!MODES.includes(value)) return mode;
    mode = value;
    try { window.localStorage.setItem(KEY, mode); } catch { /* Apply for this page even if storage is unavailable. */ }
    apply();
    return mode;
  }

  mode = savedMode();
  apply();
  window.ASoundTheme = Object.freeze({ getMode: () => mode, getResolvedTheme: resolvedTheme, setMode });

  if (media?.addEventListener) media.addEventListener("change", () => { if (mode === "system") apply(); });
  else if (media?.addListener) media.addListener(() => { if (mode === "system") apply(); });
  window.addEventListener("storage", event => {
    if (event.key !== KEY && event.key !== null) return;
    // A clear() notification also resets the preference to the default.
    mode = savedMode();
    apply();
  });

  function mount() {
    button = document.getElementById("theme-toggle");
    if (button) button.addEventListener("click", () => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]));
    labelButton();
    if (typeof MutationObserver !== "undefined") {
      new MutationObserver(labelButton).observe(root, { attributes: true, attributeFilter: ["lang"] });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
