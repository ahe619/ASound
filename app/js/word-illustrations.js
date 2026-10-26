// Optional editorial illustrations, separate from dictionary text and exam labels.
// Call only after an answer is revealed/submitted. A missing image never blocks study.
import { getLanguage } from "./i18n.js";

const manifestURL = new URL("../vocabulary/illustrations.json", import.meta.url);
let manifestPromise = null;
let illustrations = null;
let stylePromise = null;

function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(manifestURL).then(async response => {
      if (!response.ok) throw new Error("illustrations unavailable");
      const data = await response.json();
      if (data.schemaVersion !== 1 || !Array.isArray(data.illustrations)) throw new Error("invalid illustration manifest");
      illustrations = new Map(data.illustrations.filter(item => item && typeof item.wordId === "string"
        && typeof item.term === "string" && /^img\/vocabulary\/[a-z0-9-]+\.(?:webp|png)$/.test(item.src)
        && item.alt?.en && item.alt?.zh && item.sense?.en && item.sense?.zh
        && Number.isInteger(item.width) && item.width > 0 && Number.isInteger(item.height) && item.height > 0)
        .map(item => [item.wordId, item]));
      return illustrations;
    }).catch(() => { manifestPromise = null; return null; });
  }
  return manifestPromise;
}

function loadStyle() {
  if (!stylePromise) {
    stylePromise = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("../css/word-illustrations.css", import.meta.url).href;
      link.onload = resolve;
      link.onerror = () => { link.remove(); stylePromise = null; reject(new Error("illustration style unavailable")); };
      document.head.append(link);
    });
  }
  return stylePromise;
}

export function createWordIllustration(word) {
  if (!word || typeof word.id !== "string" || typeof word.term !== "string") return null;
  if (illustrations && !illustrations.has(word.id)) return null;
  const figure = document.createElement("figure");
  figure.className = "ws-illustration";
  figure.hidden = true;
  loadManifest().then(async entries => {
    const entry = entries?.get(word.id);
    if (!figure.isConnected || !entry || entry.term !== word.term) { figure.remove(); return; }
    const lang = getLanguage().startsWith("zh") ? "zh" : "en";
    const image = document.createElement("img");
    image.alt = entry.alt[lang];
    image.width = entry.width;
    image.height = entry.height;
    image.decoding = "async";
    // The image is created only for this revealed card. Do not use lazy loading
    // on a hidden figure: the browser could otherwise wait forever to load it.
    const loaded = new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("illustration image unavailable"));
    });
    const caption = document.createElement("figcaption");
    caption.textContent = lang === "zh" ? `图示含义：${entry.sense.zh}` : `Illustrated meaning: ${entry.sense.en}`;
    const label = document.createElement("span");
    label.className = "ws-illustration-label";
    label.textContent = lang === "zh" ? "AI 配图" : "AI illustration";
    caption.append(label);
    figure.append(image, caption);
    image.src = new URL(`../${entry.src}`, import.meta.url).href;
    try {
      await Promise.all([loaded, loadStyle()]);
      if (figure.isConnected && image.naturalWidth > 0) figure.hidden = false;
      else figure.remove();
    } catch { figure.remove(); }
  });
  return figure;
}
