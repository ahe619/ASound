import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app/js/theme.js", import.meta.url), "utf8");
const KEY = "asound.theme.v1";

function fixture({ saved = null, dark = false, blocked = false, loading = false, lang = "zh-CN" } = {}) {
  const storage = new Map(saved === null ? [] : [[KEY, saved]]);
  const windowEvents = {}, documentEvents = {}, mediaEvents = {}, buttonEvents = {};
  const root = { dataset: {}, style: {}, lang };
  const button = { dataset: {}, attributes: {}, innerHTML: "", title: "",
    setAttribute: (key, value) => { button.attributes[key] = value; },
    addEventListener: (name, fn) => { buttonEvents[name] = fn; },
  };
  const themeColor = { content: "#0021A5" };
  const media = { matches: dark, addEventListener: (name, fn) => { mediaEvents[name] = fn; } };
  let onLanguageChange = () => {};
  const context = vm.createContext({
    window: {
      matchMedia: () => media,
      localStorage: {
        getItem(key) { if (blocked) throw new Error("blocked"); return storage.get(key) ?? null; },
        setItem(key, value) { if (blocked) throw new Error("quota"); storage.set(key, value); },
      },
      addEventListener: (name, fn) => { windowEvents[name] = fn; },
    },
    document: {
      documentElement: root, readyState: loading ? "loading" : "complete",
      getElementById: () => button, querySelector: () => themeColor,
      addEventListener: (name, fn) => { documentEvents[name] = fn; },
    },
    MutationObserver: class { constructor(fn) { onLanguageChange = fn; } observe() {} },
  });
  vm.runInContext(source, context, { filename: "theme.js" });
  return { api: context.window.ASoundTheme, root, button, themeColor, storage,
    click: () => buttonEvents.click(), mount: () => documentEvents.DOMContentLoaded(),
    system(value) { media.matches = value; mediaEvents.change(); },
    external(value) { if (value === null) storage.delete(KEY); else storage.set(KEY, value); windowEvents.storage({ key: KEY }); },
    clear() { storage.clear(); windowEvents.storage({ key: null }); },
    unrelated() { windowEvents.storage({ key: "asound.prefs.v1" }); },
    language(value) { root.lang = value; onLanguageChange(); },
  };
}

test("default follows the system before the body is parsed", () => {
  const f = fixture({ dark: true, loading: true });
  assert.equal(f.root.dataset.theme, "system");
  assert.equal(f.root.dataset.resolvedTheme, "dark");
  assert.equal(f.root.style.colorScheme, "dark");
  assert.equal(f.button.innerHTML, "");
  f.mount();
  assert.match(f.button.attributes["aria-label"], /跟随系统.*黑夜模式/);
});

test("saved manual day mode overrides a dark OS on first paint", () => {
  const f = fixture({ saved: "light", dark: true });
  assert.equal(f.api.getMode(), "light");
  assert.equal(f.root.dataset.theme, "light");
  assert.equal(f.api.getResolvedTheme(), "light");
  f.system(false); f.system(true);
  assert.equal(f.root.style.colorScheme, "light");
});

test("button cycles through system, day, night and persists only its own setting", () => {
  const f = fixture();
  f.storage.set("asound.prefs.v1", "existing");
  for (const next of ["light", "dark", "system"]) {
    f.click();
    assert.equal(f.api.getMode(), next);
    assert.equal(f.storage.get(KEY), next);
    assert.equal(f.button.dataset.themeMode, next);
  }
  assert.equal(f.storage.get("asound.prefs.v1"), "existing");
});

test("system changes update system mode but never manual night mode", () => {
  const f = fixture();
  f.system(true);
  assert.equal(f.api.getResolvedTheme(), "dark");
  f.api.setMode("dark"); f.system(false);
  assert.equal(f.api.getResolvedTheme(), "dark");
  f.api.setMode("system");
  assert.equal(f.api.getResolvedTheme(), "light");
});

test("unavailable storage does not prevent changing the current page", () => {
  const f = fixture({ blocked: true, dark: true });
  assert.equal(f.api.getMode(), "system");
  f.api.setMode("light");
  assert.equal(f.api.getResolvedTheme(), "light");
  f.api.setMode("dark");
  assert.equal(f.api.getResolvedTheme(), "dark");
});

test("cross-tab changes and clear are reflected without rewriting storage", () => {
  const f = fixture();
  f.external("dark");
  assert.equal(f.api.getMode(), "dark");
  f.unrelated();
  assert.equal(f.api.getMode(), "dark");
  f.external("light");
  assert.equal(f.api.getResolvedTheme(), "light");
  f.clear();
  assert.equal(f.api.getMode(), "system");
  assert.equal(f.storage.size, 0);
});

test("corrupt saved values and unsupported API choices cannot inject markup", () => {
  const f = fixture({ saved: '<img src=x onerror="alert(1)">' });
  assert.equal(f.api.getMode(), "system");
  f.api.setMode("anything");
  assert.equal(f.api.getMode(), "system");
  assert.doesNotMatch(f.button.innerHTML, /onerror|<img/);
});

test("accessible theme labels track app language changes", () => {
  const f = fixture({ lang: "en" });
  assert.match(f.button.attributes["aria-label"], /Appearance: Follow system.*Switch to Day mode/);
  f.language("zh-CN");
  assert.match(f.button.attributes["aria-label"], /外观.*跟随系统.*切换为 白天模式/);
  f.api.setMode("dark");
  assert.match(f.button.title, /黑夜模式.*跟随系统/);
});

test("theme bootstrap is loaded synchronously before stylesheets", () => {
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const script = '<script src="js/theme.js"></script>';
  assert.ok(html.includes(script));
  assert.ok(html.indexOf(script) < html.indexOf('<link rel="stylesheet"'));
});
