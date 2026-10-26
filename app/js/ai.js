// Calls to the local language model (js/local-ai.js provides window.claude.use("sample")).
//   ask(input, opts)      -> text           input: prompt string or [{role, content}] ending on "user"
//   askJSON(input, opts)  -> parsed JSON
// Errors are plain objects {code, message}; aiErrorText(e) turns one into interface text.
import { t } from "./i18n.js";

let samplePromise = null;
function sampler() {
  if (!samplePromise) samplePromise = window.claude ? window.claude.use("sample") : Promise.resolve(null);
  return samplePromise;
}

export async function ask(input, opts = {}) {
  const s = await sampler();
  if (!s) throw { code: "unavailable", message: "local model missing" };
  const { text } = await s(input, opts);
  return text;
}

export async function askJSON(input, opts = {}) {
  const s = await sampler();
  if (!s) throw { code: "unavailable", message: "local model missing" };
  return s.json(input, opts);
}

export function aiErrorText(e) {
  const code = e && e.code;
  if (code === "invalid_json") return t("ai.err.json");
  if (code === "empty_completion") return t("ai.err.empty");
  if (code === "unavailable") return t("ai.err.unavailable");
  return t("ai.err.generic");
}

export const aiStatus = () => (window.ASoundAI ? window.ASoundAI.status() : { state: "error", error: "missing" });
