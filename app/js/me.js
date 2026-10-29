// "Me": current level and the placement test, the learner's profile, and the voice recommendation.
import { prefs, WORD_POOL } from "./state.js";
import { $, h, fill, icon, thinkingDots } from "./util.js";
import { t } from "./i18n.js";
import { profile, placements, checks } from "./store.js";
import { startPlacement, startProfile, renderPlacementResult, levelBadge, profileFacts } from "./talk.js";
import { setTalkView } from "./nav.js";
import { confirmInline, fmtDate, levelName, voiceRecommendCard, disclosure } from "./widgets.js";
import { cancelMicButton } from "./mic.js";

let placeMode = "words"; // words | topic

export function renderMe() {
  const last = placements.all()[0];
  const p = profile.get();
  const lastCheck = checks.all()[0];
  const voiceSection = disclosure("me-voice", t("ui.voiceMatch"), voiceRecommendCard(), { note: t("ui.optional") });
  voiceSection.querySelector("summary").addEventListener("click", () => {
    // Stop immediately on pointer/keyboard activation; native toggle is queued.
    if (voiceSection.open) cancelMicButton(voiceSection.querySelector(".mic-btn"));
  });
  voiceSection.addEventListener("toggle", () => {
    if (!voiceSection.open) cancelMicButton(voiceSection.querySelector(".mic-btn"));
  });

  const profileCard = h("div", { class: "card" },
    h("h2", { class: "sec" }, t("me.profileTitle")),
    p ? h("p", { class: "overall" }, p.summary || p.field) : h("p", { class: "lede" }, t("me.profileEmpty")),
    p ? profileFacts(p) : null,
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn primary", onclick: startProfile }, p ? t("me.profileRedo") : t("me.profileStart")),
      p ? clearProfileBtn() : null),
    h("p", { class: "hint-line" }, t("me.profileWhy")));

  fill($("#me"),
    h("section", { class: "page-intro" }, h("h1", { class: "title" }, t("me.title")), h("p", { class: "lede" }, t("ui.meIntro"))),
    h("div", { class: "card" },
      h("h2", { class: "sec" }, t("me.levelTitle")),
      levelBadge(prefs.level),
      h("p", { class: "lede" }, t(`level.${prefs.level}.desc`)),
      last ? h("button", { type: "button", class: "btn quiet", onclick: () => { renderPlacementResult(last); setTalkView("summary"); } }, t("me.lastPlacement", { date: fmtDate(last.at), level: levelName(last.level) })) : null),
    disclosure("me-placement", t("me.placeTitle"), placementCard(!!last), { note: t("ui.optional") }),
    disclosure("me-profile", t("me.profileTitle"), profileCard, { note: p ? p.field || "" : t("ui.optional") }),
    voiceSection,
    lastCheck ? h("p", { class: "note-card" }, t("me.lastCheck", { date: fmtDate(lastCheck.at), score: lastCheck.score })) : null,
    h("p", { class: "hint-line app-version", "aria-label": "ASound V1.01" }, "ASound · V1.01"));
}

function placementCard(again) {
  const body = h("div", { class: "stack-sm" });
  const modes = h("div", { class: "seg", role: "group" });
  const paintModes = () => fill(modes, [["words", t("me.placeWords")], ["topic", t("me.placeTopic")]].map(([id, label]) =>
    h("button", { type: "button", "aria-pressed": String(placeMode === id), onclick: () => { placeMode = id; paintModes(); paintBody(); } }, label)));

  const wordInputs = Array.from({ length: 5 }, (_, i) => h("input", { type: "text", id: `place-word-${i}`, class: "word-input", "aria-label": t("me.placeWordN", { n: i + 1 }), placeholder: t("me.placeWordN", { n: i + 1 }) }));
  const topicInput = h("input", { type: "text", id: "place-topic", placeholder: t("me.placeTopicPlaceholder"), "aria-label": t("me.placeTopic") });
  const dice = h("button", { type: "button", class: "btn", onclick: () => {
    const pool = [...WORD_POOL].sort(() => Math.random() - 0.5);
    wordInputs.forEach((el, i) => { el.value = pool[i]; });
  } }, icon("dice"), t("me.placeRandom"));

  const go = h("button", { type: "button", class: "btn hot big" }, again ? t("me.placeAgain") : t("me.placeStart"));
  go.addEventListener("click", async () => {
    go.disabled = true;
    fill(go, t("me.placePreparing"), thinkingDots());
    const ok = placeMode === "topic"
      ? await startPlacement({ topic: topicInput.value })
      : await startPlacement({ words: wordInputs.map((el) => el.value) });
    if (!ok) { go.disabled = false; fill(go, again ? t("me.placeAgain") : t("me.placeStart")); }
  });

  const paintBody = () => fill(body,
    placeMode === "words"
      ? h("div", { class: "stack-xs field" }, h("div", { class: "word-inputs" }, wordInputs), h("div", { class: "row" }, dice, h("span", { class: "hint-line" }, t("me.placeWordsHint"))))
      : h("div", { class: "stack-xs field" }, topicInput, h("span", { class: "hint-line" }, t("me.placeTopicHint"))));

  paintModes();
  paintBody();
  return h("div", { class: "card" },
    h("h2", { class: "sec" }, icon("dice"), t("me.placeTitle")),
    h("p", { class: "lede" }, t("me.placeHow")),
    modes, body,
    h("div", { class: "row" }, go));
}

function clearProfileBtn() {
  const btn = h("button", { type: "button", class: "btn quiet" }, t("me.profileClear"));
  btn.addEventListener("click", () => confirmInline(btn, () => { profile.clear(); renderMe(); }));
  return btn;
}
