// Interface language. All interface text lives in locales/<lang>.json; code only refers to keys.
//   t("talk.start")                -> "Start practice" / the Chinese string
//   t("sum.lines", {n: 3})         -> fills {n}
// Markup can carry data-i18n="key", data-i18n-placeholder="key" or data-i18n-label="key" (aria-label + title).

// Interface languages with a locale file. Explanations (prefs.helpLang) can use more languages than this.
export const UI_LANGS = [
  ["en", "English"], ["zh", "\u7b80\u4f53\u4e2d\u6587"], ["zh-Hant", "\u7e41\u9ad4\u4e2d\u6587"], ["ja", "\u65e5\u672c\u8a9e"],
  ["ko", "\ud55c\uad6d\uc5b4"], ["vi", "Ti\u1ebfng Vi\u1ec7t"], ["th", "\u0e44\u0e17\u0e22"], ["id", "Bahasa Indonesia"],
  ["hi", "\u0939\u093f\u0928\u094d\u0926\u0940"], ["ar", "\u0627\u0644\u0639\u0631\u0628\u064a\u0629"], ["tr", "T\u00fcrk\u00e7e"],
  ["ru", "\u0420\u0443\u0441\u0441\u043a\u0438\u0439"], ["es", "Espa\u00f1ol"], ["pt", "Portugu\u00eas"], ["fr", "Fran\u00e7ais"], ["de", "Deutsch"],
];
const HTML_LANG = { zh: "zh-CN", "zh-Hant": "zh-TW" };
const RTL = new Set(["ar", "fa", "he", "ur"]);

let lang = "zh";
let dict = {};
let fallback = {};
const extra = {}; // lang -> strings added by feature modules (addStrings)

async function loadLocale(code) {
  const res = await fetch(`locales/${code}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`missing locale ${code}`);
  return res.json();
}

export async function setLanguage(code) {
  if (!Object.keys(fallback).length) fallback = await loadLocale("en");
  lang = UI_LANGS.some(([c]) => c === code) ? code : "en";
  dict = lang === "en" ? fallback : await loadLocale(lang).catch(() => ({}));
  document.documentElement.lang = HTML_LANG[lang] || lang;
  document.documentElement.dir = RTL.has(lang) ? "rtl" : "ltr";
  applyI18n(document);
}

// Feature modules can bring their own strings: addStrings("en", {...}).
export function addStrings(code, strings) {
  extra[code] = { ...(extra[code] || {}), ...strings };
}

export const getLanguage = () => lang;

export function t(key, vars) {
  let s = dict[key] ?? (extra[lang] && extra[lang][key]) ?? fallback[key] ?? (extra.en && extra.en[key]) ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
  return s;
}

export function applyI18n(root) {
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll("[data-i18n-label]").forEach((el) => {
    const v = t(el.dataset.i18nLabel);
    el.setAttribute("aria-label", v);
    el.title = v;
  });
}
