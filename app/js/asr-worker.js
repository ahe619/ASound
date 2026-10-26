// Speech recognition worker: Moonshine (MIT, English) or Whisper (MIT, multilingual) through transformers.js (Apache-2.0).
// Desktop: files come from this computer (app/models). Phone / plain browser: from the download source, kept in the
// browser's Cache Storage under keys that do not depend on the source (js/packs.js downloads them up front).
import { pipeline, env } from "../vendor/transformers/transformers.min.js";

env.backends.onnx.wasm.wasmPaths = new URL("../vendor/transformers/", import.meta.url).href;

let asr = null;

// "https://hf-mirror.com/onnx-community/x/resolve/main/onnx/a.onnx" -> "<canon>onnx-community/x/onnx/a.onnx"
function canonCache(cacheName, canon) {
  const key = (req) => {
    const u = new URL(typeof req === "string" ? req : req.url);
    return canon + u.pathname.replace(/^\//, "").replace("/resolve/main/", "/");
  };
  return {
    match: async (req) => (await caches.open(cacheName)).match(key(req)),
    put: async (req, res) => (await caches.open(cacheName)).put(key(req), res),
  };
}

function setup(m) {
  if (m.mode === "web") {
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.remoteHost = m.base;
    env.remotePathTemplate = "{model}/resolve/{revision}/";
    env.useBrowserCache = false;
    env.useCustomCache = true;
    env.customCache = canonCache(m.cache, m.canon);
  } else {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useBrowserCache = false; // the files are already on this computer
    env.localModelPath = m.base || new URL("../models/", import.meta.url).href;
  }
}

async function init(m) {
  setup(m);
  const opts = m.device === "webgpu"
    ? { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } }
    : { device: "wasm", dtype: { encoder_model: "q8", decoder_model_merged: "q8" } };
  asr = await pipeline("automatic-speech-recognition", m.model || "onnx-community/moonshine-base-ONNX", opts);
  await asr(new Float32Array(16000)); // warm up (compiles GPU shaders)
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    try {
      await init(m);
      postMessage({ type: "ready", device: m.device });
    } catch (err) {
      postMessage({ type: "error", error: String((err && err.message) || err) });
    }
  } else if (m.type === "transcribe") {
    try {
      const t0 = performance.now();
      const out = await asr(m.audio, m.lang ? { language: m.lang, task: "transcribe" } : undefined);
      postMessage({ type: "text", id: m.id, text: String(out.text || "").trim(), ms: Math.round(performance.now() - t0) });
    } catch (err) {
      postMessage({ type: "textError", id: m.id, error: String((err && err.message) || err) });
    }
  }
};
