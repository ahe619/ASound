// Models & downloads: the first-run setup and the place to add, switch or remove local AI models.
import { prefs, savePrefs, state } from "./state.js";
import { $, h, fill, icon, meter } from "./util.js";
import { t } from "./i18n.js";
import { show, setTab } from "./nav.js";
import { confirmInline } from "./widgets.js";
import {
  packList, packById, packStatus, packMode, recommended, variant, activePacks, ready, install, cancel, remove,
  freeSpace, resolvedSource, setSource, gpuInfo,
} from "./packs.js";

const SECTIONS = [
  { key: "llm", groups: ["llm-0.8b", "llm-2b", "llm-4b", "llm-cpu"], choose: "llm" },
  { key: "asr", groups: ["asr-tiny", "asr-base"], choose: "asr" },
  { key: "voice", groups: ["voice", "voice-hq"] },
  { key: "help", groups: ["help-asr"] },
];

let setupMode = false;
let afterSetup = null;

export function showModels({ setup = false, onReady = null } = {}) {
  setupMode = setup;
  afterSetup = onReady;
  state.tab = "models";
  renderModels();
  show();
  $("#view-models").scrollTop = 0;
}

const gb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

function groupSize(group) {
  const p = packById(variant(group));
  return p ? p.size : 0;
}

export function renderModels() {
  if (state.tab !== "models") return;
  const rec = recommended();
  const active = activePacks();
  const isReady = ready();
  const web = packMode() === "web";
  const recGroups = [rec.llm, rec.asr, "voice"];
  const missing = recGroups.filter((g) => packStatus(variant(g)).state !== "installed");
  const missingSize = missing.reduce((n, g) => n + groupSize(g), 0);
  const busy = packList().some((p) => ["downloading", "queued"].includes(packStatus(p.id).state));

  const head = setupMode
    ? [h("p", { class: "eyebrow" }, t("models.setupEyebrow")), h("h1", { class: "title" }, t("models.setupTitle")), h("p", { class: "lede" }, t(web ? "models.setupLedeWeb" : "models.setupLede"))]
    : [h("button", { type: "button", class: "btn quiet back", onclick: leave }, icon("back"), t("models.back")), h("h1", { class: "title" }, t("models.title")), h("p", { class: "lede" }, t(web ? "models.ledeWeb" : "models.lede"))];

  const quick = setupMode && !isReady
    ? h("div", { class: "card setup-card" },
      h("strong", null, t("models.quickTitle")),
      h("p", { class: "hint-line" }, t("models.quickList", { list: recGroups.map((g) => t(`pack.${g}.name`)).join(" + "), size: gb(missingSize) })),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn hot", disabled: !missing.length || busy, onclick: () => missing.forEach((g) => install(variant(g))) }, icon("download"), t("models.quickGo", { size: gb(missingSize) }))))
    : null;

  const startRow = () => (setupMode
    ? h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", disabled: !isReady, onclick: finishSetup }, t("models.start")),
      isReady ? null : h("span", { class: "hint-line" }, t("models.needAll")))
    : null);

  const sourceBox = h("div", { class: "stack-xs" },
    h("span", { class: "field-label" }, t("models.source")),
    seg([["auto", t("models.source.auto")], ["hf", t("models.source.hf")], ["mirror", t("models.source.mirror")]], prefs.source, (id) => { setSource(id); renderModels(); }),
    h("p", { class: "hint-line" }, prefs.source === "auto" && resolvedSource() ? t("models.sourcePicked", { name: t(`models.source.${resolvedSource()}`) }) : t("models.sourceNote")));

  const free = freeSpace();
  fill($("#models"),
    h("header", { class: "sum-head" }, head),
    quick,
    startRow(),
    SECTIONS.map((sec) => section(sec, rec, active, web)),
    sourceBox,
    h("p", { class: "hint-line" }, [free != null ? t(web ? "models.freeWeb" : "models.free", { size: gb(free) }) : "", t("models.licenses")].filter(Boolean).join(" ")),
    isReady ? startRow() : null);
}

function section(sec, rec, active, web) {
  const gpu = gpuInfo().webgpu;
  // without WebGPU only the processor model can run; with it, the faster GPU models are the ones to offer
  const groups = sec.groups.filter((g) => !(web && (packById(variant(g)) || {}).desktopOnly) && (sec.key !== "llm" || (g === "llm-cpu") !== gpu));
  if (!groups.length) return null;
  const noGpu = sec.key === "llm" && !gpuInfo().webgpu;
  return h("section", { class: "stack-sm" },
    h("div", { class: "stack-xs" }, h("h2", { class: "sec-title" }, t(`models.sec.${sec.key}`)), h("p", { class: "hint-line" }, t(`models.sec.${sec.key}.note`))),
    noGpu ? h("p", { class: "note-card warn" }, t("models.noGpu")) : null,
    h("ul", { class: "pack-list" }, groups.map((g) => packRow(g, sec, rec, active))));
}

function packRow(group, sec, rec, active) {
  const id = variant(group);
  const p = packById(id);
  if (!p) return null;
  const st = packStatus(id);
  const inUse = sec.choose ? active[sec.choose] === group : st.state === "installed";
  const isRec = sec.choose && rec[sec.choose] === group;
  const pct = st.total ? Math.floor((st.done / st.total) * 100) : 0;

  const badges = [
    isRec ? h("span", { class: "tag rec" }, t("models.recommended")) : null,
    sec.choose && inUse && st.state === "installed" ? h("span", { class: "tag on" }, t("models.inUse")) : null,
  ];
  const actions = [];
  if (st.state === "installed") {
    if (sec.choose && !inUse) actions.push(h("button", { type: "button", class: "btn", onclick: () => choose(sec.choose, group) }, t("models.use")));
    const del = h("button", { type: "button", class: "icon-btn sm", "aria-label": t("models.remove"), title: t("models.remove") }, icon("trash"));
    del.addEventListener("click", () => confirmInline(del, () => remove(id)));
    actions.push(del);
  } else if (st.state === "downloading" || st.state === "queued") {
    actions.push(h("button", { type: "button", class: "btn quiet", onclick: () => cancel(id) }, t("models.cancel")));
  } else {
    actions.push(h("button", { type: "button", class: "btn primary", onclick: () => { if (sec.choose && !active[sec.choose]) choose(sec.choose, group, false); install(id); } },
      icon("download"), st.state === "partial" ? t("models.resume") : t("models.download")));
  }

  let line;
  if (st.state === "downloading") {
    line = h("div", { class: "row pack-progress" }, meter(pct / 100), h("span", { class: "pill" }, `${pct}%`),
      h("span", { class: "pill" }, `${gb(st.done)} / ${gb(st.total)}`), st.rate ? h("span", { class: "pill" }, `${gb(st.rate)}/s`) : null);
  } else if (st.state === "queued") {
    line = h("span", { class: "pill" }, t("models.queued"));
  } else if (st.error) {
    line = h("span", { class: "pack-error" }, st.error === "disk" ? t("models.diskFull") : t("models.failed", { error: st.error }));
  } else if (st.state === "partial") {
    line = h("span", { class: "pill" }, t("models.partial", { pct }));
  } else if (st.state === "installed") {
    line = h("span", { class: "pill ok" }, icon("check"), t("models.installed"));
  }

  return h("li", { class: "pack" + (inUse && st.state === "installed" ? " in-use" : "") },
    h("div", { class: "pack-main" },
      h("div", { class: "row" }, h("strong", null, t(`pack.${group}.name`)), h("span", { class: "pill" }, gb(p.size)), badges),
      h("p", { class: "hint-line" }, t(`pack.${group}.desc`), " ", h("span", { class: "license" }, `${p.name} \u00b7 ${p.license}`)),
      line),
    h("div", { class: "pack-actions" }, actions));
}

function choose(kind, group, reload = true) {
  prefs[kind] = group;
  savePrefs();
  // Switching the language model needs a fresh page: the old one occupies the GPU memory.
  if (reload && kind === "llm" && window.ASoundAI && window.ASoundAI.status().state !== "off") { location.reload(); return; }
  document.dispatchEvent(new CustomEvent("asound:packs-chosen"));
  renderModels();
}

function seg(options, current, onPick) {
  return h("div", { class: "seg", role: "group" }, options.map(([id, label]) =>
    h("button", { type: "button", "aria-pressed": String(current === id), onclick: () => onPick(id) }, label)));
}

function finishSetup() {
  if (!ready()) return;
  setupMode = false;
  const fn = afterSetup;
  afterSetup = null;
  setTab("talk");
  if (fn) fn();
}

function leave() {
  setTab("talk");
}
