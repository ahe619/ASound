// Languages a learner can get explanations and help in (prefs.helpLang), and the interface language to start with.
//   id: our code; label: the language's own name; prompt: what the model is asked to write in;
//   speaker: for "a ...-speaking learner"; whisper: the speech-recognition language code.
export const HELP_LANGS = [
  { id: "zh", label: "\u7b80\u4f53\u4e2d\u6587", prompt: "Simplified Chinese", speaker: "Chinese", whisper: "zh" },
  { id: "zh-Hant", label: "\u7e41\u9ad4\u4e2d\u6587", prompt: "Traditional Chinese", speaker: "Chinese", whisper: "zh" },
  { id: "ja", label: "\u65e5\u672c\u8a9e", prompt: "Japanese", speaker: "Japanese", whisper: "ja" },
  { id: "ko", label: "\ud55c\uad6d\uc5b4", prompt: "Korean", speaker: "Korean", whisper: "ko" },
  { id: "vi", label: "Ti\u1ebfng Vi\u1ec7t", prompt: "Vietnamese", speaker: "Vietnamese", whisper: "vi" },
  { id: "th", label: "\u0e44\u0e17\u0e22", prompt: "Thai", speaker: "Thai", whisper: "th" },
  { id: "id", label: "Bahasa Indonesia", prompt: "Indonesian", speaker: "Indonesian", whisper: "id" },
  { id: "hi", label: "\u0939\u093f\u0928\u094d\u0926\u0940", prompt: "Hindi", speaker: "Hindi", whisper: "hi" },
  { id: "ar", label: "\u0627\u0644\u0639\u0631\u0628\u064a\u0629", prompt: "Arabic", speaker: "Arabic", whisper: "ar" },
  { id: "tr", label: "T\u00fcrk\u00e7e", prompt: "Turkish", speaker: "Turkish", whisper: "tr" },
  { id: "ru", label: "\u0420\u0443\u0441\u0441\u043a\u0438\u0439", prompt: "Russian", speaker: "Russian", whisper: "ru" },
  { id: "es", label: "Espa\u00f1ol", prompt: "Spanish", speaker: "Spanish", whisper: "es" },
  { id: "pt", label: "Portugu\u00eas", prompt: "Brazilian Portuguese", speaker: "Portuguese", whisper: "pt" },
  { id: "fr", label: "Fran\u00e7ais", prompt: "French", speaker: "French", whisper: "fr" },
  { id: "de", label: "Deutsch", prompt: "German", speaker: "German", whisper: "de" },
  { id: "en", label: "English", prompt: "simple English", speaker: "English", whisper: "en" },
];
export const helpLang = (id) => HELP_LANGS.find((l) => l.id === id) || HELP_LANGS[0];

// Text the learner typed in a non-Latin script (CJK, kana, Hangul, Cyrillic, Arabic, Devanagari, Thai...) is a request
// for help; Latin-script languages go through the "say it in my language" button.
const OTHER_SCRIPT = /[\u0400-\u04ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
export const isOtherScript = (text) => OTHER_SCRIPT.test(String(text || ""));

// The browser's language -> our language codes (interface and help).
export function detectLanguages(uiLangs) {
  const prefsList = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"]).map((x) => String(x));
  const toHelp = (tag) => {
    const low = tag.toLowerCase();
    if (low.startsWith("zh")) return /hant|tw|hk|mo/.test(low) ? "zh-Hant" : "zh";
    const base = low.split("-")[0];
    return HELP_LANGS.some((l) => l.id === base) ? base : "";
  };
  const help = prefsList.map(toHelp).find(Boolean) || "en";
  const ui = uiLangs.includes(help) ? help : help === "zh-Hant" && uiLangs.includes("zh") ? "zh" : "en";
  return { ui, help };
}
