// Relations are extracted from the pinned syllabus and dictionary, never guessed from spelling.
import { h, fill } from "./util.js";
import { t } from "./i18n.js";
let pending;
const kinds = { p: "past", d: "participle", i: "ing", "3": "third", s: "plural", r: "comparative", t: "superlative", "0": "base" };

export function wordRelations(word) {
  const section = h("section", { class: "ws-relations stack-xs", hidden: true });
  if (!pending) pending = fetch(new URL("../vocabulary/relations.json", import.meta.url))
    .then(response => { if (!response.ok) throw new Error("relations unavailable"); return response.json(); })
    .then(data => data.schemaVersion === 1 ? data.relations : null)
    .catch(() => { pending = null; return null; });
  pending.then(data => {
    if (!section.isConnected) return;
    const row = data?.[word.id];
    if (!row || (!row.family?.length && !row.forms?.length)) { section.remove(); return; }
    const family = (row.family || []).filter(item => typeof item.term === "string" && typeof item.meaning === "string");
    const forms = (row.forms || []).filter(item => kinds[item.kind] && typeof item.term === "string");
    fill(section,
      family.length ? h("details", { class: "ws-family", open: true },
        h("summary", null, t("wstudy.family")),
        h("ul", { class: "ws-family-list" }, family.map(item => h("li", null,
          h("strong", { lang: "en" }, item.term), h("p", { lang: "zh-CN" }, item.meaning))))) : null,
      forms.length ? h("details", { class: "ws-forms" }, h("summary", null, t("wstudy.forms")),
        h("dl", null, forms.map(item => [h("dt", null, t(`wstudy.form.${kinds[item.kind]}`)), h("dd", { lang: "en" }, item.term)]))) : null,
      h("small", { class: "hint-line" }, t("wstudy.relationsSource")));
    section.hidden = false;
  });
  return section;
}
