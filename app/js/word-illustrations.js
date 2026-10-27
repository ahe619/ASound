// Optional editorial illustrations, separate from dictionary text and exam labels.
// Reads the small run-time index vocabulary/pictures.json (the full provenance stays in illustrations.json).
// A missing index, image or stylesheet never blocks study.
import { getLanguage } from "./i18n.js";

const indexURL = new URL("../vocabulary/pictures.json", import.meta.url);
let indexPromise = null;
let pictures = null; // Map wordId -> {src, width, height, term, sense: {zh, en}, alt: {zh, en}}
let stylePromise = null;
const warmed = new Set();

function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch(indexURL).then(async (response) => {
      if (!response.ok) throw new Error("pictures unavailable");
      const data = await response.json();
      if (data.schemaVersion !== 1 || !data.pictures || typeof data.pictures !== "object") throw new Error("invalid picture index");
      pictures = new Map();
      for (const [id, row] of Object.entries(data.pictures)) {
        const [src, width, height, term, senseZh, senseEn, altZh, altEn] = Array.isArray(row) ? row : [];
        if (typeof src !== "string" || !/^img\/vocabulary\/[a-z0-9-]+\.(?:webp|png)$/.test(src)
          || !(width > 0) || !(height > 0) || typeof term !== "string" || !senseZh || !senseEn || !altZh || !altEn) continue;
        pictures.set(id, { src, width, height, term, sense: { zh: senseZh, en: senseEn }, alt: { zh: altZh, en: altEn } });
      }
      return pictures;
    }).catch(() => { indexPromise = null; return null; });
  }
  return indexPromise;
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

const imageURL = (entry) => new URL(`../${entry.src}`, import.meta.url).href;

// The picture for a word, or null (resolves after the index loads).
export async function pictureFor(word) {
  if (!word || typeof word.id !== "string") return null;
  const entries = await loadIndex();
  const entry = entries?.get(word.id);
  return entry && entry.term === word.term ? { ...entry, url: imageURL(entry) } : null;
}

// Whether a word has a picture, without waiting (false until the index has loaded).
export const hasPicture = (word) => !!(pictures && word && pictures.get(word.id)?.term === word.term);

// Start loading the index (cheap) so later checks are instant.
export const preparePictures = () => { loadIndex(); };

// Fetch the next cards' pictures in the background so they appear without a wait.
export async function warmPictures(words) {
  const entries = await loadIndex();
  if (!entries) return;
  for (const word of words || []) {
    const entry = entries.get(word?.id);
    if (!entry || entry.term !== word.term || warmed.has(entry.src)) continue;
    warmed.add(entry.src);
    const image = new Image();
    image.decoding = "async";
    image.src = imageURL(entry);
  }
}

// A captioned figure for a revealed card; removes itself when the word has no picture.
export function createWordIllustration(word) {
  if (!word || typeof word.id !== "string" || typeof word.term !== "string") return null;
  if (pictures && !pictures.has(word.id)) return null;
  const figure = document.createElement("figure");
  figure.className = "ws-illustration";
  figure.hidden = true;
  loadIndex().then(async (entries) => {
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
    image.src = imageURL(entry);
    try {
      await Promise.all([loaded, loadStyle()]);
      if (figure.isConnected && image.naturalWidth > 0) figure.hidden = false;
      else figure.remove();
    } catch { figure.remove(); }
  });
  return figure;
}
