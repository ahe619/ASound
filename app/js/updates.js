// Hosted PWA updates. Settings renders this small observable state; no model or learner data is changed.
const ROOT = new URL("../", import.meta.url);
const status = { state: "disabled", reason: "local", version: "", nextVersion: "", error: "" };
const listeners = new Set();
let registration = null;
let initPromise = null;
let initOptions = null;
let checking = null;
let requested = false;
let reloading = false;
let canApply = () => true;
let lastCheck = 0;
let observing = false;
const watched = new WeakSet();
const observedRegistrations = new WeakSet();

export const updateStatus = () => ({ ...status });
export function onUpdateStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function set(patch) {
  Object.assign(status, { reason: "", error: "" }, patch);
  for (const fn of listeners) { try { fn(updateStatus()); } catch (error) { console.warn(error); } }
  return updateStatus();
}

function message(worker, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    if (!worker) { reject(new Error("No update worker is available.")); return; }
    const channel = new MessageChannel();
    const finish = (error, data) => {
      clearTimeout(timer);
      channel.port1.close();
      if (error) reject(error); else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error("The update worker did not respond.")), timeout);
    channel.port1.onmessage = (event) => finish(null, event.data);
    try { worker.postMessage({ type }, [channel.port2]); } catch (error) { finish(error); }
  });
}

async function syncStatus() {
  if (!registration || requested) return updateStatus();
  if (registration.installing) return set({ state: "downloading" });
  if (registration.waiting) {
    const worker = registration.waiting;
    const info = await message(worker, "ASOUND_VERSION").catch(() => ({}));
    if (requested || registration.waiting !== worker) return updateStatus();
    if (registration.installing) return set({ state: "downloading" });
    return set({ state: "available", nextVersion: info.version || "" });
  }
  return set({ state: "current", nextVersion: "" });
}

function watch(worker) {
  if (!worker || watched.has(worker)) return;
  watched.add(worker);
  let succeeded = ["installed", "activating", "activated"].includes(worker.state);
  worker.addEventListener("statechange", () => {
    if (worker.state === "redundant") {
      // Replacing an older waiting (or active) worker is normal, not a failed download.
      if (!succeeded && !requested) set({ state: "error", reason: "download", error: "The update could not be installed. The previous version is still available." });
    } else if (["installed", "activating", "activated"].includes(worker.state)) {
      succeeded = true;
      syncStatus();
    }
  });
  if (worker.state === "installing") set({ state: "downloading" });
}

function installed(worker) {
  if (!worker) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", changed);
      if (error) reject(error); else resolve();
    };
    const changed = () => {
      if (["installed", "activating", "activated"].includes(worker.state)) finish();
      else if (worker.state === "redundant") finish(new Error("The downloaded update could not be verified or stored."));
    };
    const timer = setTimeout(() => finish(new Error("The update is taking too long. Try again when the connection is stable.")), 10 * 60 * 1000);
    worker.addEventListener("statechange", changed);
    changed();
  });
}

export function initUpdates({ enabled = true, canApply: allowed = () => true } = {}) {
  if (initPromise) return initPromise;
  initOptions = { enabled, canApply: allowed };
  canApply = allowed;
  initPromise = (async () => {
    if (!enabled) return set({ state: "disabled", reason: "local" });
    if (!globalThis.isSecureContext || !("serviceWorker" in navigator)) return set({ state: "disabled", reason: "unsupported" });
    // Only generated web releases register a worker. Raw source remains an ordinary online development page.
    let release;
    try {
      const response = await fetch(new URL("version.json", ROOT), { cache: "no-store" });
      if (response.status === 404) return set({ state: "disabled", reason: "development" });
      if (!response.ok) throw new Error(`The update metadata could not be loaded (${response.status}).`);
      release = await response.json();
      if (!release || typeof release.version !== "string" || !release.version) throw new Error("The update metadata is invalid.");
    } catch (error) {
      return set({ state: "error", error: String(error.message || error) });
    }
    set({ state: "checking", version: release.version });
    try {
      registration = await navigator.serviceWorker.register(new URL("sw.js", ROOT), { scope: ROOT.href, updateViaCache: "none" });
      if (!observing) {
        observing = true;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          // Only a click in this page permits a reload. First install and other windows never interrupt practice.
          // Activation and clients.claim() may emit more than one notification before navigation commits.
          if (reloading) return;
          if (requested) { reloading = true; requested = false; location.reload(); return; }
          syncStatus();
        });
        const backgroundCheck = () => {
          if (document.visibilityState === "visible" && Date.now() - lastCheck > 60 * 60 * 1000) checkForUpdates();
        };
        window.addEventListener("online", () => checkForUpdates());
        document.addEventListener("visibilitychange", backgroundCheck);
        setInterval(backgroundCheck, 60 * 60 * 1000);
      }
      if (!observedRegistrations.has(registration)) {
        observedRegistrations.add(registration);
        registration.addEventListener("updatefound", () => watch(registration.installing));
      }
      watch(registration.installing);
      await installed(registration.installing);
      await syncStatus();
      lastCheck = Date.now();
      return updateStatus();
    } catch (error) {
      return set({ state: "error", error: String(error.message || error) });
    }
  })();
  return initPromise;
}

export async function checkForUpdates() {
  if (checking) return checking;
  if (initPromise) await initPromise;
  if (checking) return checking;
  if (!registration) {
    if (status.state === "error" && initOptions) { initPromise = null; return initUpdates(initOptions); }
    return updateStatus();
  }
  if (requested) return updateStatus();
  checking = (async () => {
    lastCheck = Date.now();
    set({ state: "checking" });
    try {
      // A waiting release may itself be outdated. Check the server before offering it again.
      await registration.update();
      const worker = registration.installing;
      watch(worker);
      await installed(worker);
      return await syncStatus();
    } catch (error) {
      // A failed first installation can leave an unregistered Registration object.
      if (!registration.active && !registration.waiting && !registration.installing) registration = null;
      return set({ state: "error", error: String(error.message || error) });
    } finally { checking = null; }
  })();
  return checking;
}

export async function applyUpdate() {
  if (!registration || !registration.waiting || requested || reloading) return updateStatus();
  if (!await canApply()) return set({ state: "blocked", reason: "practice" });
  requested = true;
  set({ state: "applying" });
  try {
    const result = await message(registration.waiting, "ASOUND_APPLY_UPDATE", 15000);
    if (!result || !result.ok) {
      requested = false;
      return set({ state: "blocked", reason: result && result.reason || "tabs" });
    }
    // The controllerchange listener reloads after activation, never before the cache is ready.
    return updateStatus();
  } catch (error) {
    requested = false;
    return set({ state: "error", error: String(error.message || error) });
  }
}
