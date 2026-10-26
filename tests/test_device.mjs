import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { deviceInfo, layoutForWidth } from "../app/js/device.js";

test("device classification handles iPad desktop user agents without treating touch PCs as iPads", () => {
  assert.deepEqual(deviceInfo({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", platform: "MacIntel", maxTouchPoints: 5 }), { kind: "tablet", mobile: true });
  assert.deepEqual(deviceInfo({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 10 }), { kind: "desktop", mobile: false });
  assert.deepEqual(deviceInfo({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel", maxTouchPoints: 0 }), { kind: "desktop", mobile: false });
});

test("Android tablets and phones keep distinct actual device kinds", () => {
  assert.deepEqual(deviceInfo({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36" }), { kind: "phone", mobile: true });
  assert.deepEqual(deviceInfo({ userAgent: "Mozilla/5.0 (Linux; Android 14; Tablet) Safari/537.36" }), { kind: "tablet", mobile: true });
  assert.deepEqual(deviceInfo({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18)" }), { kind: "phone", mobile: true });
  assert.deepEqual(deviceInfo({ userAgent: "", userAgentData: { mobile: true } }), { kind: "phone", mobile: true });
});

test("automatic layout has inclusive breakpoints and safe handling for absent dimensions", () => {
  assert.equal(layoutForWidth(320), "phone");
  assert.equal(layoutForWidth(600), "phone");
  assert.equal(layoutForWidth(601), "tablet");
  assert.equal(layoutForWidth(1024), "tablet");
  assert.equal(layoutForWidth(1025), "desktop");
  for (const invalid of [undefined, NaN, 0, -1, Infinity]) assert.equal(layoutForWidth(invalid), "desktop");
});

const source = (await readFile(new URL("../app/js/device.js", import.meta.url), "utf8"))
  .replace(/^export /gm, "") + "\nglobalThis.api = { deviceInfo, initLayout, setLayoutMode, getLayoutMode, layoutInfo, onLayoutChange };";
function fixture(saved = "auto", { brokenStorage = false } = {}) {
  const events = {}, viewportEvents = {}, stored = new Map([["asound.layout.v1", saved]]);
  const root = { dataset: {}, style: { setProperty(k, v) { this[k] = v; } } };
  const win = { innerWidth: 390, innerHeight: 844, addEventListener(name, fn) { (events[name] ||= []).push(fn); },
    visualViewport: { height: 844, scale: 1, addEventListener(name, fn) { (viewportEvents[name] ||= []).push(fn); } } };
  const context = vm.createContext({ console, window: win, document: { documentElement: root },
    navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18)" },
    localStorage: { getItem: k => { if (brokenStorage) throw new Error("blocked"); return stored.get(k) || null; }, setItem: (k, v) => { if (brokenStorage) throw new Error("blocked"); stored.set(k, v); } } });
  vm.runInContext(source, context);
  return { api: context.api, root, win, stored, events, viewportEvents };
}

test("manual desktop presentation never changes physical phone capabilities and persists", () => {
  const f = fixture();
  f.api.initLayout();
  assert.equal(f.root.dataset.layout, "phone");
  f.api.setLayoutMode("desktop");
  assert.equal(f.root.dataset.layout, "desktop");
  assert.equal(f.root.dataset.device, "phone");
  assert.equal(f.api.deviceInfo().mobile, true);
  assert.equal(f.stored.get("asound.layout.v1"), "desktop");
  const restored = fixture(f.stored.get("asound.layout.v1"));
  restored.api.initLayout();
  assert.equal(restored.root.dataset.layout, "desktop");
});

test("resize, mobile keyboard and storage changes update layout without duplicate listeners", () => {
  const f = fixture();
  const changes = [];
  const off = f.api.onLayoutChange(info => changes.push(info.layout));
  f.api.initLayout(); f.api.initLayout();
  assert.equal(f.events.resize.length, 1);
  f.win.innerWidth = 820;
  f.events.resize[0]();
  assert.equal(f.root.dataset.layout, "tablet");
  f.win.visualViewport.height = 390;
  f.viewportEvents.resize[0]();
  assert.equal(f.root.style["--app-viewport-height"], "390px");
  assert.deepEqual(changes, ["phone", "tablet"]);
  f.win.visualViewport.scale = 2;
  f.viewportEvents.resize[0]();
  assert.equal(f.root.style["--app-viewport-height"], "844px");
  f.stored.set("asound.layout.v1", "phone");
  f.events.storage[0]({ key: "asound.layout.v1" });
  assert.equal(f.api.getLayoutMode(), "phone");
  off();
  f.api.setLayoutMode("desktop");
  assert.deepEqual(changes, ["phone", "tablet", "phone"]);
});

test("invalid or unavailable storage cannot prevent layout switching", () => {
  const invalid = fixture("unsafe-mode");
  invalid.api.initLayout();
  assert.equal(invalid.api.getLayoutMode(), "auto");
  invalid.api.setLayoutMode("tablet");
  invalid.api.setLayoutMode("invalid");
  assert.equal(invalid.api.getLayoutMode(), "tablet");
  const blocked = fixture("desktop", { brokenStorage: true });
  assert.doesNotThrow(() => blocked.api.initLayout());
  assert.doesNotThrow(() => blocked.api.setLayoutMode("phone"));
  assert.equal(blocked.root.dataset.layout, "phone");
});
