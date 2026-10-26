import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";

const source = await readFile(new URL("../app/js/updates.js", import.meta.url), "utf8");

class Events {
  listeners = new Map();
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name) { for (const fn of [...(this.listeners.get(name) || [])]) fn(); }
}

class Worker extends Events {
  state = "installed";
  version = "two";
  block = false;
  applied = 0;
  postMessage(data, ports) {
    if (data.type === "ASOUND_VERSION") ports[0].postMessage({ version: this.version });
    else {
      this.applied++;
      ports[0].postMessage(this.block ? { ok: false, reason: "tabs" } : { ok: true });
    }
    ports[0].close();
  }
}

function app({ built = true, waiting = null, secure = true } = {}) {
  const registration = new Events();
  Object.assign(registration, { waiting, installing: null, active: new Worker(), update: async () => {} });
  const serviceWorker = new Events();
  const env = { registration, serviceWorker, registered: 0, reloaded: 0, options: null, metadataError: null, metadataStatus: built ? 200 : 404 };
  serviceWorker.register = async (_url, options) => { env.registered++; env.options = options; return registration; };
  const document = new Events();
  document.visibilityState = "visible";
  const context = {
    URL, MessageChannel, console, setTimeout, clearTimeout, setInterval: () => 0,
    isSecureContext: secure, navigator: { serviceWorker }, document, window: new Events(),
    location: { reload: () => { env.reloaded++; } },
    fetch: async () => {
      if (env.metadataError) throw env.metadataError;
      return new Response(JSON.stringify({ version: "one" }), { status: env.metadataStatus });
    },
  };
  vm.runInNewContext(source.replaceAll("import.meta.url", JSON.stringify("https://example.test/ASound/js/updates.js"))
    .replace(/^export /gm, "") + "\nglobalThis.api = { initUpdates, checkForUpdates, applyUpdate, updateStatus, onUpdateStatus };", context);
  env.api = context.api;
  return env;
}

test("desktop, unbuilt and insecure apps do not register a worker", async () => {
  const local = app();
  assert.equal((await local.api.initUpdates({ enabled: false })).reason, "local");
  assert.equal(local.registered, 0);
  const source = app({ built: false });
  assert.equal((await source.api.initUpdates()).reason, "development");
  assert.equal(source.registered, 0);
  const insecure = app({ secure: false });
  assert.equal((await insecure.api.initUpdates()).reason, "unsupported");
  assert.equal(insecure.registered, 0);
});

test("waiting updates are announced without reloading a running app", async () => {
  const env = app({ waiting: new Worker() });
  const state = await env.api.initUpdates();
  assert.equal(state.state, "available");
  assert.equal(state.version, "one");
  assert.equal(state.nextVersion, "two");
  assert.equal(env.options.updateViaCache, "none");
  env.serviceWorker.emit("controllerchange");
  assert.equal(env.reloaded, 0);
});

test("practice and additional windows block activation; an accepted click reloads on activation", async () => {
  const worker = new Worker();
  const env = app({ waiting: worker });
  let busy = true;
  await env.api.initUpdates({ canApply: () => !busy });
  assert.equal((await env.api.applyUpdate()).reason, "practice");
  assert.equal(worker.applied, 0);
  busy = false;
  worker.block = true;
  assert.equal((await env.api.applyUpdate()).reason, "tabs");
  assert.equal(env.reloaded, 0);
  worker.block = false;
  assert.equal((await env.api.applyUpdate()).state, "applying");
  assert.equal(env.reloaded, 0);
  env.serviceWorker.emit("controllerchange");
  assert.equal(env.reloaded, 1);
  env.serviceWorker.emit("controllerchange");
  env.serviceWorker.emit("controllerchange");
  assert.equal(env.reloaded, 1, "duplicate activation notifications must not start additional navigations");
});

test("manual checks remain pending until the new worker finishes installing", async () => {
  const env = app();
  await env.api.initUpdates();
  const worker = new Worker();
  worker.state = "installing";
  env.registration.update = async () => {
    env.registration.installing = worker;
    env.registration.emit("updatefound");
  };
  let finished = false;
  const check = env.api.checkForUpdates().then((state) => { finished = true; return state; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.api.updateStatus().state, "downloading");
  assert.equal(finished, false);
  env.registration.installing = null;
  env.registration.waiting = worker;
  worker.state = "installed";
  worker.emit("statechange");
  assert.equal((await check).state, "available");
  assert.equal(env.reloaded, 0);
});

test("failed installs report an error and never reload", async () => {
  const env = app();
  await env.api.initUpdates();
  const worker = new Worker();
  worker.state = "installing";
  env.registration.update = async () => { env.registration.installing = worker; };
  const check = env.api.checkForUpdates();
  await new Promise((resolve) => setImmediate(resolve));
  env.registration.installing = null;
  worker.state = "redundant";
  worker.emit("statechange");
  assert.equal((await check).state, "error");
  assert.equal(env.reloaded, 0);
});

test("a temporary metadata failure is retryable instead of being labelled a development build", async () => {
  const env = app();
  env.metadataStatus = 503;
  assert.equal((await env.api.initUpdates()).state, "error");
  assert.equal(env.registered, 0);
  env.metadataStatus = 200;
  assert.equal((await env.api.checkForUpdates()).state, "current");
  assert.equal(env.registered, 1);

  const offline = app();
  offline.metadataError = new Error("offline");
  assert.equal((await offline.api.initUpdates()).state, "error");
  offline.metadataError = null;
  assert.equal((await offline.api.checkForUpdates()).state, "current");
});

test("registration retries preserve the practice guard", async () => {
  const env = app({ waiting: new Worker() });
  const register = env.serviceWorker.register;
  env.serviceWorker.register = async () => { throw new Error("temporary registration failure"); };
  assert.equal((await env.api.initUpdates({ canApply: () => false })).state, "error");
  env.serviceWorker.register = register;
  assert.equal((await env.api.checkForUpdates()).state, "available");
  assert.equal((await env.api.applyUpdate()).reason, "practice");
  assert.equal(env.reloaded, 0);
});
