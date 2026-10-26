// ASound local AI. Provides window.claude.use("sample") - the same call shape the online (claude.ai)
// version uses - backed by a local open-source LLM: Qwen3.5 (Apache-2.0) through WebLLM (Apache-2.0) on WebGPU,
// in a worker; or, where there is no WebGPU, through wllama (llama.cpp in WebAssembly, MIT) on the processor.
// Nothing leaves the device. Loaded as a classic script before the app script; the app picks the
// model with ASoundAI.configure() once it knows which model packs are installed (js/packs.js).
(() => {
  "use strict";

  let MODEL_ID = "";
  let appConfig = null;
  let configured = null;   // resolves once configure() has been called
  let setConfigured = null;
  configured = new Promise((r) => { setConfigured = r; });

  let cpuModel = null;     // {url, cache, key, ctx} for the processor engine
  function makeConfig(llm) {
    if (llm.kind === "cpu") return { cpu: true };
    return {
      model_list: [{
        model: llm.model,
        model_id: llm.model_id,
        model_lib: llm.lib,
        overrides: { context_window_size: llm.ctx || 4096, max_history_size: 1 },
      }],
      cacheBackend: "opfs",
    };
  }

  const status = { state: "off", progress: 0, error: "" };
  let enginePromise = null;
  // Interface text; the app replaces these with the current language through ASoundAI.setLabels().
  let labels = {
    loading: "Loading the AI model {pct}%",
    error: "AI could not start. Refresh the page to try again.",
    noGpu: "This conversation option could not start. Open downloads and choose the recommended option.",
  };
  const fmt = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));

  /* status pill (bottom right) */
  let pill = null;
  function render() {
    if (!document.body) return;
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "voice-pill llm-pill";
      pill.setAttribute("role", "status");
      document.body.append(pill);
    }
    const show = status.state === "loading" || status.state === "error";
    pill.hidden = !show;
    if (!show) return;
    pill.replaceChildren();
    const label = document.createElement("span");
    label.textContent = status.state === "error"
      ? fmt(labels.error, { error: status.error })
      : fmt(labels.loading, { pct: Math.floor(status.progress * 100) });
    pill.append(label);
    if (status.state === "loading") {
      const meter = document.createElement("span");
      meter.className = "meter";
      const bar = document.createElement("i");
      bar.style.width = `${Math.floor(status.progress * 100)}%`;
      meter.append(bar);
      pill.append(meter);
    }
  }

  function load() {
    if (enginePromise) return enginePromise;
    if (!appConfig) return Promise.reject(Object.assign(new Error("no language model is installed"), { code: "no_model" }));
    status.state = "loading";
    status.progress = 0;
    render();
    enginePromise = (async () => {
      if (appConfig.cpu) {
        const engine = await loadCpu();
        status.state = "ready";
        render();
        return engine;
      }
      const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
      if (!adapter) throw new Error(labels.noGpu);
      const webllm = await import(new URL("vendor/web-llm/index.js", location.href).href);
      const worker = new Worker(new URL("js/llm-worker.js", location.href), { type: "module" });
      const engine = await webllm.CreateWebWorkerMLCEngine(worker, MODEL_ID, {
        appConfig,
        initProgressCallback: (r) => { status.progress = r.progress || 0; render(); },
      });
      status.state = "ready";
      render();
      return engine;
    })().catch((e) => {
      status.state = "error";
      status.error = String((e && e.message) || e).slice(0, 160);
      enginePromise = null;
      render();
      throw e;
    });
    return enginePromise;
  }

  // The processor engine: read the GGUF file (from this computer, or the download cache on a phone), load it into
  // wllama, and give it the same chat.completions.create() shape WebLLM has.
  async function loadCpu() {
    const { Wllama } = await import(new URL("vendor/wllama/index.js", location.href).href);
    let res = null;
    if (cpuModel.cache) {
      try { res = await (await caches.open(cpuModel.cache)).match(cpuModel.key); } catch {}
    }
    if (!res) res = await fetch(cpuModel.url);
    if (!res.ok) throw new Error(`model file ${res.status}`);
    const blob = await res.blob(); // the browser keeps a large blob on disk, not in memory
    status.progress = 0.5;
    render();
    const w = new Wllama({ default: new URL("vendor/wllama/wllama.wasm", location.href).href }, { suppressNativeLog: true });
    // Keep older browsers' compatibility runtime in the same verified offline release.
    w.setCompat({
      worker: new URL("vendor/wllama/compat/wllama.js", location.href).href,
      wasm: new URL("vendor/wllama/compat/wllama.wasm", location.href).href,
    });
    await w.loadModel([blob], { n_ctx: cpuModel.ctx || 4096, n_gpu_layers: 0, jinja: true });
    status.progress = 1;
    let ctl = null;
    return {
      chat: { completions: { create: async (req) => {
        ctl = new AbortController();
        return w.createChatCompletion({
          messages: req.messages, stream: true, temperature: req.temperature, top_p: req.top_p, max_tokens: req.max_tokens,
          chat_template_kwargs: { enable_thinking: false }, abortSignal: ctl.signal,
          ...(req.response_format ? { response_format: { type: "json_object" } } : {}),
        });
      } } },
      interruptGenerate: () => { if (ctl) ctl.abort(); },
      unload: () => w.exit(),
    };
  }

  /* one generation at a time; conversation replies jump ahead of corrections and summaries */
  const queue = [];
  let running = false;
  function enqueue(job, high) {
    return new Promise((resolve, reject) => {
      const item = { job, resolve, reject, high };
      const at = high ? queue.findIndex((q) => !q.high) : -1;
      if (at >= 0) queue.splice(at, 0, item); else queue.push(item);
      pump();
    });
  }
  async function pump() {
    if (running || !queue.length) return;
    running = true;
    const it = queue.shift();
    try { it.resolve(await it.job()); } catch (e) { it.reject(e); }
    running = false;
    pump();
  }

  // The app sends [instructions as a user turn, ...conversation]; a small model follows a system message better.
  function toMessages(input) {
    if (typeof input === "string") return [{ role: "user", content: input }];
    const turns = input.map((t) => ({ role: t.role, content: String(t.content) }));
    const [first, ...rest] = turns;
    const msgs = [{ role: "system", content: first.content }, ...rest];
    if (!rest.length) msgs.push({ role: "user", content: "Begin now." });
    return msgs;
  }
  const stripThink = (t) => t.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^\s*<think>[\s\S]*$/, "");

  function generate(input, opts, json) {
    if (opts.signal && opts.signal.aborted) return Promise.reject({ code: "cancelled" });
    return enqueue(async () => {
      if (opts.signal && opts.signal.aborted) throw { code: "cancelled" };
      let engine;
      try { engine = await load(); } catch (e) { throw { code: e && e.code === "no_model" ? "unavailable" : "upstream_error", message: String((e && e.message) || e) }; }
      const messages = toMessages(input);
      const wantsObject = json && !/JSON array/i.test(messages.map((m) => m.content).join("\n"));
      const req = {
        messages,
        stream: true,
        temperature: json ? 0.3 : 0.8,
        top_p: 0.9,
        max_tokens: json ? 1600 : 400,
        extra_body: { enable_thinking: false },
      };
      // Grammar-constrained decoding guarantees parseable JSON; WebLLM wants the schema as a string.
      if (wantsObject) req.response_format = { type: "json_object", schema: '{"type":"object"}' };
      const onAbort = () => { try { engine.interruptGenerate(); } catch {} };
      if (opts.signal) opts.signal.addEventListener("abort", onAbort);
      let raw = "", shown = "", finish = "";
      try {
        const stream = await engine.chat.completions.create(req);
        for await (const chunk of stream) {
          const c = chunk.choices && chunk.choices[0];
          if (!c) continue;
          if (c.finish_reason) finish = c.finish_reason;
          const d = (c.delta && c.delta.content) || "";
          if (!d) continue;
          raw += d;
          const text = stripThink(raw).trimStart();
          if (opts.onText && text && text.length > shown.length && text.startsWith(shown)) {
            const delta = text.slice(shown.length);
            shown = text;
            try { opts.onText({ text, delta }); } catch (err) { console.warn(err); }
          }
        }
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw { code: "cancelled", text: stripThink(raw) };
        throw { code: "upstream_error", message: String((e && e.message) || e), text: stripThink(raw) || undefined };
      } finally {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      }
      if (opts.signal && opts.signal.aborted) throw { code: "cancelled", text: stripThink(raw) };
      const text = stripThink(raw).trim();
      if (!text) throw { code: "empty_completion", message: "no text" };
      return { text, truncated: finish === "length", modelTierApplied: "local" };
    }, Array.isArray(input));
  }

  function parseJSON(text) {
    try { return JSON.parse(text); } catch {}
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { try { return JSON.parse(fence[1]); } catch {} }
    const a = text.search(/[[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
    throw { code: "invalid_json", message: "reply was not JSON", text };
  }

  function sample(input, opts = {}) { return generate(input, opts, false); }
  sample.json = async (input, opts = {}) => parseJSON((await generate(input, opts, true)).text);
  sample.limits = async () => ({ maxPromptBytes: 262144 });

  // Use this model from now on ({model_id, model, lib, ctx}); start loading it unless told not to.
  function configure(llm, { start = true } = {}) {
    if (!llm) return;
    if (llm.model_id === MODEL_ID && appConfig) { if (start) load().catch(() => {}); return; }
    const old = enginePromise;
    enginePromise = null;
    if (old) old.then((e) => e.unload && e.unload()).catch(() => {});
    MODEL_ID = llm.model_id;
    appConfig = makeConfig(llm);
    cpuModel = llm.kind === "cpu" ? { url: llm.url, cache: llm.cache, key: llm.key, ctx: llm.ctx } : null;
    status.state = "off";
    render();
    setConfigured();
    if (start) load().catch((e) => console.warn("local AI failed to load", e));
  }

  // Phones and plain browsers download the model by loading it once (WebLLM stores it in the browser).
  async function download(llm, onProgress, signal) {
    configure(llm, { start: false });
    const onAbort = () => { status.state = "off"; render(); };
    if (signal) signal.addEventListener("abort", onAbort);
    const tick = setInterval(() => { if (status.state === "loading") onProgress(status.progress); }, 500);
    try {
      await load();
      onProgress(1);
    } finally {
      clearInterval(tick);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  window.ASoundAI = {
    load,
    configure,
    download,
    configured: () => configured,
    status: () => ({ ...status, model: MODEL_ID }),
    get modelId() { return MODEL_ID; },
    setLabels(next) { labels = { ...labels, ...next }; render(); },
  };
  window.claude = { use: async (name) => (name === "sample" ? sample : null) };
})();
