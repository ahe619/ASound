// General settings sheet and the dedicated voice-selection page.
import { prefs, savePrefs, state } from "./state.js";
import { $, h, fill, icon, toast } from "./util.js";
import { t, setLanguage, UI_LANGS } from "./i18n.js";
import { HELP_LANGS } from "./langs.js";
import { speak, speakBtn, voicePreviewBtn, unlockAudio, speechStatus, onSpeechStatus, startNatural, voiceCapabilities, stopSpeaking } from "./speech.js";
import { aiStatus } from "./ai.js";
import { voicePicker, disclosure } from "./widgets.js";
import { activePacks, packById, packStatus, variant, onPacks } from "./packs.js";
import { voiceDownloadCard } from "./models.js";
import { getLayoutMode, setLayoutMode, layoutInfo, onLayoutChange } from "./device.js";
import { updateStatus, onUpdateStatus, checkForUpdates, applyUpdate } from "./updates.js";
import { currentRoute, navigate, goBack, registerOverlay } from "./nav.js";

let onLanguageChange = null;
let announcedVersion = "";
let voiceSignature = "";
export function initSettings({ languageChanged }) {
  onLanguageChange = languageChanged;
  registerOverlay("settings", (visible, { restore }) => {
    if (visible) {
      if ($("#settings").hidden) render();
      $("#settings").hidden = false;
      if (!restore) $("#settings-close").focus({ preventScroll: true });
    } else {
      const hadFocus = $("#settings").contains(document.activeElement);
      $("#settings").hidden = true;
      if (hadFocus) $("#settings-open").focus({ preventScroll: true });
    }
  });
  $("#settings-open").append(icon("gear"));
  $("#settings-open").addEventListener("click", openSettings);
  $("#settings").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSettings(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#settings").hidden) closeSettings(); });
  const paintStatus = () => {
    if (state.tab === "voices") { paintVoiceOptions(); paintNatural(); }
    if (!$("#settings").hidden) paintEngines();
  };
  onSpeechStatus(paintStatus);
  onPacks(paintStatus);
  onLayoutChange(paintLayout);
  if (window.ASoundMic) window.ASoundMic.onStatus(() => { if (!$("#settings").hidden) paintEngines(); });
  onUpdateStatus((status) => {
    paintUpdates();
    if (status.state === "available" && status.nextVersion !== announcedVersion) {
      announcedVersion = status.nextVersion;
      toast(t("updates.found"));
    }
  });
}

export function openSettings() {
  navigate({ ...currentRoute(), overlay: "settings" });
}
function closeSettings() {
  const route = currentRoute();
  delete route.overlay;
  goBack(route);
}

function select(id, options, current, onPick) {
  const el = h("select", { id }, options.map(([value, label]) => h("option", { value }, label)));
  el.value = current;
  el.addEventListener("change", () => onPick(el.value));
  return h("div", { class: "row" }, el);
}

function seg(options, current, onPick) {
  const box = h("div", { class: "seg", role: "group" });
  const paint = (cur) => fill(box, options.map(([id, label]) => h("button", { type: "button", "aria-pressed": String(cur === id), onclick: () => { onPick(id); paint(id); } }, label)));
  paint(current);
  return box;
}

export function renderVoices() {
  voiceSignature = "";
  const rateOut = h("output", { for: "rate" }, `${prefs.rate.toFixed(2)}\u00d7`);
  const rate = h("input", { type: "range", id: "rate", min: "0.6", max: "1.3", step: "0.05" });
  rate.value = String(prefs.rate);
  rate.addEventListener("input", () => { prefs.rate = Number(rate.value); rateOut.textContent = `${prefs.rate.toFixed(2)}\u00d7`; savePrefs(); });
  rate.addEventListener("change", () => { unlockAudio(); speak("This is how fast I'll talk.", null); });
  const autoplay = h("input", { type: "checkbox", id: "autoplay" });
  autoplay.checked = !!prefs.autoplay;
  autoplay.addEventListener("change", () => { prefs.autoplay = autoplay.checked; savePrefs(); });

  fill($("#voices"),
    h("section", { class: "page-intro" }, h("h1", { class: "title" }, t("tab.voices")), h("p", { class: "lede" }, t("ui.voicesIntro"))),
    disclosure("voice-playback", t("ui.voicePlayback"), [
      h("div", { class: "stack-xs" }, h("label", { class: "field-label", for: "rate" }, t("settings.rate"), " ", rateOut), rate),
      h("label", { class: "check" }, autoplay, t("settings.autoplay"))
    ]),
    h("section", { class: "card", id: "voice-options" }));
  paintVoiceOptions();
  paintNatural();
}

function render() {
  fill($("#settings-panel"),
    h("div", { class: "sheet-head" }, h("h2", { id: "settings-title" }, t("settings.title")),
      h("button", { type: "button", class: "icon-btn", id: "settings-close", "aria-label": t("settings.close"), onclick: closeSettings }, icon("close"))),
    h("p", { class: "hint-line settings-intro" }, t("ui.settingsIntro")),
    disclosure("settings-learning", t("ui.learningSettings"), [
    h("div", { class: "stack-xs" },
      h("label", { class: "field-label", for: "ui-lang" }, t("settings.uiLang")),
      select("ui-lang", UI_LANGS, prefs.uiLang, async (id) => {
        prefs.uiLang = id;
        savePrefs();
        await setLanguage(id);
        onLanguageChange && onLanguageChange();
        const scrollTop = $("#settings-panel").scrollTop;
        render();
        $("#settings-panel").scrollTop = scrollTop;
        $("#ui-lang").focus({ preventScroll: true });
      })),
    h("div", { class: "stack-xs" },
      h("label", { class: "field-label", for: "help-lang" }, t("settings.helpLang")),
      select("help-lang", HELP_LANGS.map((l) => [l.id, l.label]), prefs.helpLang, (id) => { prefs.helpLang = id; savePrefs(); }),
      h("p", { class: "hint-line" }, t("settings.helpLangNote"))),
    h("div", { class: "stack-xs" },
      h("span", { class: "field-label" }, t("settings.strict")),
      seg([["gentle", t("settings.strict.gentle")], ["normal", t("settings.strict.normal")], ["strict", t("settings.strict.strict")]], prefs.strictness, (id) => { prefs.strictness = id; savePrefs(); }))
    ], { note: t("ui.learningSettingsNote") }),
    disclosure("settings-appearance", t("ui.appearanceSettings"), [
      h("div", { class: "stack-xs" }, h("span", { class: "field-label" }, t("ui.theme")),
        seg(["system", "light", "dark"].map(id => [id, t(`ui.theme.${id}`)]), window.ASoundTheme?.getMode() || "system", id => window.ASoundTheme?.setMode(id))),
      h("div", { class: "stack-xs" },
        h("label", { class: "field-label", for: "layout-mode" }, t("settings.layout")),
        select("layout-mode", ["auto", "phone", "tablet", "desktop"].map(id => [id, t(`settings.layout.${id}`)]), getLayoutMode(), setLayoutMode),
        h("p", { class: "hint-line", id: "layout-status" }))
    ], { note: t("ui.appearanceSettingsNote") }),
    disclosure("settings-app", t("updates.title"), [
      h("section", { class: "stack-xs", id: "app-updates", "aria-live": "polite" }),
      disclosure("settings-status", t("settings.engines"), [
      h("ul", { class: "engine-list", id: "engine-list" }),
      h("p", { class: "hint-line" }, t("settings.offline"))]),
      h("p", { class: "hint-line" }, t("settings.licenses"))
    ], { note: updateStatus().version || "ASound" }));
  paintEngines();
  paintLayout();
  paintUpdates();
}

function paintLayout() {
  const el = $("#layout-status");
  if (el) el.textContent = t("settings.layout.note", { layout: t(`settings.layout.${layoutInfo().layout}`) });
  const select = $("#layout-mode");
  if (select) select.value = getLayoutMode();
}

function paintVoiceOptions() {
  if (state.tab !== "voices") return;
  const el = $("#voice-options");
  if (!el) return;
  const cap = voiceCapabilities();
  const pack = packStatus("voice");
  const next = JSON.stringify([cap.browser, cap.native, cap.canNatural, cap.system, cap.systemEnglish,
    prefs.voiceEngine, pack.state, pack.done, pack.error]);
  if (next === voiceSignature) return;
  voiceSignature = next;
  const options = [["auto", t("settings.voiceStyle.auto")], ["standard", t("settings.voiceStyle.standard")]];
  if (cap.system || prefs.voiceEngine === "system") options.push(["system", t("settings.voiceStyle.system")]);
  if (cap.canNatural) options.push(["natural", t("settings.voiceStyle.natural")]);
  const selected = options.some(([id]) => id === prefs.voiceEngine) ? prefs.voiceEngine : "auto";
  const useSystem = selected === "system" || (!cap.browser && !cap.native && !cap.canNatural);
  const sample = selected === "system" || selected === "natural" ? speakBtn("Hello! Let's practice English together.", t("voice.preview"), t("voice.preview"))
    : voicePreviewBtn(null, t("voice.preview"));
  sample.disabled = (selected === "system" || selected === "natural") && !cap.effective;
  fill(el,
    h("span", { class: "field-label" }, t("settings.voiceStyle")),
    seg(options, selected, id => {
      stopSpeaking();
      prefs.voiceEngine = id; savePrefs();
      if (id === "natural") startNatural();
      paintVoiceOptions(); paintNatural();
    }),
    h("p", { class: "hint-line", id: "natural-status" }),
    sample,
    useSystem || cap.effective === "system" ? h("p", { class: "hint-line" }, t(cap.effective ? "ui.voicesSystemNote" : "ui.voicesNeedsPack")) : null,
    h("div", { class: "stack-xs" }, voicePicker(), h("p", { class: "hint-line" }, t("settings.voiceNote"))),
    disclosure("voice-download", t("ui.voiceDownloads"), voiceDownloadCard()));
}

function paintUpdates() {
  const section = $("#app-updates");
  if (!section) return;
  const status = updateStatus();
  const summary = $("#settings-app > summary .ui-disclosure-note");
  if (summary) summary.textContent = status.nextVersion ? t("updates.available") : status.version || "ASound";
  const busy = ["checking", "downloading", "applying"].includes(status.state);
  const available = !!status.nextVersion && ["available", "blocked", "error"].includes(status.state);
  const disabledText = status.reason === "development" ? t("updates.development")
    : status.reason === "unsupported" ? t("updates.unsupported") : t("updates.local");
  const messages = {
    disabled: disabledText,
    checking: t("updates.checking"), downloading: t("updates.downloading"),
    current: t("updates.current"), available: t("updates.available"),
    applying: t("updates.applying"), error: t("updates.error"),
    blocked: status.reason === "practice" ? t("updates.practice") : t("updates.tabs"),
  };
  fill(section,
    h("h3", { class: "field-label" }, t("updates.title")),
    status.version ? h("p", { class: "hint-line" }, t("updates.version", { version: status.version })) : null,
    h("p", { class: "hint-line" }, messages[status.state] || t("updates.checking")),
    status.state !== "disabled" ? h("div", { class: "row" },
      h("button", { type: "button", class: "btn", disabled: busy, onclick: () => checkForUpdates() }, t("updates.check")),
      available ? h("button", { type: "button", class: "btn primary", disabled: busy, onclick: () => applyUpdate() }, t("updates.apply")) : null) : null,
    status.state !== "disabled" ? h("p", { class: "hint-line" }, t("updates.data")) : null);
}

function paintNatural() {
  if (state.tab !== "voices") return;
  const el = $("#natural-status");
  if (!el) return;
  const st = speechStatus().natural;
  const cap = voiceCapabilities();
  const phase = speechStatus().phase;
  el.textContent = ["loading", "generating"].includes(phase) ? t(`speech.${phase}`)
    : prefs.voiceEngine === "natural" && cap.canNatural ? t(`natural.${st}`)
    : t("settings.voiceStyle.note");
}

function paintEngines() {
  const list = $("#engine-list");
  if (!list) return;
  const ai = aiStatus();
  const mic = window.ASoundMic ? window.ASoundMic.status() : { asr: "off" };
  const aiText = ai.state === "ready" ? t("engine.ready") : ai.state === "loading" ? t("engine.loading", { pct: Math.floor((ai.progress || 0) * 100) }) : ai.state === "error" ? t("engine.error", { error: ai.error }) : t("engine.idle");
  const cap = voiceCapabilities();
  const spText = cap.effective === "system" ? t("engine.voiceSystem") : cap.effective === "native" ? t("engine.voiceNative")
    : cap.effective === "natural" ? t("natural.ready") : cap.browser ? t("engine.voiceBrowser") : t("engine.none");
  const asrText = mic.asr === "ready" ? t("engine.ready") : mic.asr === "loading" ? t("engine.loadingShort") : mic.asr === "error" ? t("engine.error", { error: mic.error }) : t("engine.idle");
  const a = activePacks();
  const name = (g) => (g && packById(variant(g)) ? t(`pack.${g}.name`) : t("engine.none"));
  fill(list,
    h("li", null, h("b", null, t("engine.llm")), h("span", null, `${name(a.llm)} \u00b7 ${aiText}`)),
    h("li", null, h("b", null, t("engine.voice")), h("span", null, spText)),
    h("li", null, h("b", null, t("engine.asr")), h("span", null, `${name(a.asr)} \u00b7 ${asrText}`)));
}
