// ASound voice input: microphone capture, a simple energy-based voice-activity detector, and local speech
// recognition (Moonshine in js/asr-worker.js). Classic script; exposes window.ASoundMic.
//
//   ASoundMic.record()                 start a manual recording (tap-to-talk)
//   ASoundMic.stop()  -> {text}        stop it and transcribe
//   ASoundMic.listen({onSpeechStart, onText, onLevel})   hands-free: each finished utterance -> onText(text)
//   ASoundMic.pause() / resume()       ignore the microphone (e.g. while the app is speaking)
//   ASoundMic.close()                  release the microphone
(() => {
  "use strict";

  const RATE = 16000;
  const FRAME = 512;                 // 32 ms per frame at 16 kHz
  const START_FRAMES = 3;            // ~100 ms above threshold starts an utterance
  const END_FRAMES = 25;             // ~800 ms of quiet ends it (listen({endMs}) can wait longer)
  const PREROLL = 10;                // keep ~320 ms before the start
  const MAX_FRAMES = Math.ceil((30 * RATE) / FRAME);

  /* ---------- recognition workers ---------- */
  // One worker per model: the English recognizer (Moonshine) and, optionally, a multilingual one (Whisper) for
  // learners who say something in their own language. configure() picks the files (see js/packs.js).
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => { try { fn(status()); } catch {} });
  function status() { return { asr: asr.state, error: asr.error, mic: mic.state, help: help.state }; }

  function recognizer() {
    const r = { worker: null, ready: null, seq: 0, pending: new Map(), state: "off", error: "", config: null };
    r.configure = (cfg) => {
      const same = r.config && cfg && r.config.model === cfg.model && r.config.base === cfg.base;
      r.config = cfg;
      if (!same && r.worker) {
        try { r.worker.terminate(); } catch {}
        Object.assign(r, { worker: null, ready: null, state: "off" });
        emit();
      }
    };
    r.load = () => {
      if (r.ready) return r.ready;
      if (!r.config) return Promise.reject(Object.assign(new Error("no speech recognition model is installed"), { code: "no_model" }));
      r.state = "loading";
      emit();
      r.ready = (async () => {
        const gpu = r.config.gpu && navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null));
        r.worker = new Worker(new URL("js/asr-worker.js", location.href), { type: "module" });
        await new Promise((resolve, reject) => {
          r.worker.onmessage = (e) => {
            const m = e.data;
            if (m.type === "ready") resolve();
            else if (m.type === "error") reject(new Error(m.error));
            else if (m.type === "text" || m.type === "textError") {
              const p = r.pending.get(m.id);
              if (!p) return;
              r.pending.delete(m.id);
              m.type === "text" ? p.resolve(m.text) : p.reject(new Error(m.error));
            }
          };
          r.worker.onerror = (e) => reject(new Error(e.message || "speech recognition failed to start"));
          r.worker.postMessage({ type: "init", device: gpu ? "webgpu" : "wasm", ...r.config });
        });
        r.state = "ready";
        emit();
      })().catch((e) => {
        r.state = "error";
        r.error = String((e && e.message) || e);
        r.ready = null;
        try { r.worker && r.worker.terminate(); } catch {}
        r.worker = null;
        emit();
        throw e;
      });
      return r.ready;
    };
    r.transcribe = async (audio, lang) => {
      await r.load();
      const id = ++r.seq;
      return new Promise((resolve, reject) => {
        r.pending.set(id, { resolve, reject });
        r.worker.postMessage({ type: "transcribe", id, audio, lang }, [audio.buffer]);
      });
    };
    return r;
  }
  const asr = recognizer();
  const help = recognizer();
  const loadASR = () => asr.load();
  const transcribe = (audio) => asr.transcribe(audio);

  /* ---------- microphone ---------- */
  const mic = {
    state: "off",            // off | recording | listening | paused
    stream: null, ctx: null, node: null, src: null,
    frames: [], preroll: [], speaking: false, above: 0, below: 0, noise: 0.004, endFrames: END_FRAMES,
    handlers: null,
  };
  let capture = 0; // close/cancel/new capture invalidate permission requests and old transcripts
  const opening = new Set();
  const aborted = () => Object.assign(new Error("microphone capture cancelled"), { name: "AbortError", code: "cancelled" });
  const requireCapture = (id) => { if (id !== capture) throw aborted(); };
  const clearFrames = () => Object.assign(mic, { frames: [], preroll: [], speaking: false, above: 0, below: 0 });
  const notifyCancel = (handlers) => { try { if (handlers && handlers.onCancel) handlers.onCancel(); } catch {} };

  // The context runs at the device's own rate (44.1/48 kHz, 8 kHz on some headsets); the tap converts to 16 kHz:
  // each output sample is the average of the input samples in its step (a simple low-pass), repeated when the
  // device rate is lower.
  const WORKLET = `
    class Tap extends AudioWorkletProcessor {
      constructor() {
        super();
        this.buf = new Float32Array(${FRAME}); this.n = 0;
        this.step = sampleRate / ${RATE}; this.pos = 0; this.acc = 0; this.cnt = 0;
      }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) for (let i = 0; i < ch.length; i++) {
          this.acc += ch[i]; this.cnt++; this.pos += 1;
          if (this.pos < this.step) continue;
          const v = this.acc / this.cnt;
          this.acc = 0; this.cnt = 0;
          while (this.pos >= this.step) {
            this.pos -= this.step;
            this.buf[this.n++] = v;
            if (this.n === ${FRAME}) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
          }
        }
        return true;
      }
    }
    registerProcessor("asound-tap", Tap);`;

  async function open(id) {
    requireCapture(id);
    if (mic.stream) return;
    let stream = null, ctx = null, src = null, node = null;
    const resources = { stream, ctx, src, node };
    opening.add(resources);
    try {
      // Create and wake the audio context first, still inside the tap that started recording: Safari keeps a context
      // made after the permission prompt suspended (silent recordings). Keep the device's own rate: Firefox cannot
      // connect a microphone to a context with a different rate.
      resources.ctx = ctx = new AudioContext();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      // Keep pending resources local: a late permission result must not overwrite a newer capture.
      resources.stream = stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      requireCapture(id);
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      requireCapture(id);
      resources.src = src = ctx.createMediaStreamSource(stream);
      resources.node = node = new AudioWorkletNode(ctx, "asound-tap");
      node.port.onmessage = (e) => { if (mic.node === node) onFrame(e.data); };
      src.connect(node);
      Object.assign(mic, { stream, ctx, src, node });
    } catch (err) {
      release({ stream, ctx, src, node });
      if (id !== capture) throw aborted();
      throw err;
    } finally {
      opening.delete(resources);
    }
  }
  function release({ stream, ctx, src, node }) {
    try { if (node) { node.port.onmessage = null; node.disconnect(); } } catch {}
    try { if (src) src.disconnect(); } catch {}
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (ctx) Promise.resolve(ctx.close()).catch(() => {}); } catch {}
  }
  function close() {
    ++capture;
    const handlers = mic.handlers;
    opening.forEach(release);
    opening.clear();
    release(mic);
    Object.assign(mic, { stream: null, ctx: null, node: null, src: null, state: "off", handlers: null });
    clearFrames();
    notifyCancel(handlers);
    emit();
  }

  async function startCapture(handlers, state) {
    const id = ++capture;
    opening.forEach(release);
    opening.clear();
    const oldHandlers = mic.handlers;
    mic.handlers = handlers;
    mic.state = mic.stream ? "paused" : "off";
    clearFrames();
    notifyCancel(oldHandlers);
    try {
      await open(id);
      requireCapture(id);
      if (mic.ctx.state === "suspended") await mic.ctx.resume();
      requireCapture(id);
      mic.endFrames = handlers.endMs ? Math.max(END_FRAMES, Math.round(handlers.endMs / 32)) : END_FRAMES;
      mic.state = state;
      emit();
      requireCapture(id);
      loadASR().catch(() => {});
    } catch (err) {
      if (id !== capture) throw aborted();
      release(mic);
      Object.assign(mic, { stream: null, ctx: null, node: null, src: null, state: "off", handlers: null });
      clearFrames();
      emit();
      throw err;
    }
  }

  const rmsOf = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / f.length); };
  const joinFrames = (frames) => {
    const out = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => out.set(f, i * FRAME));
    return out;
  };
  // Keep the part with speech, plus 250 ms each side. "Speech" = at least 60 ms (three 20 ms windows) louder than
  // four times the background level (the quietest fifth of the recording), so one click cannot decide the cut.
  function trimSilence(audio) {
    const win = Math.round(0.02 * RATE), pad = Math.round(0.25 * RATE), run = 3;
    const levels = [];
    for (let i = 0; i + win <= audio.length; i += win) levels.push(rmsOf(audio.subarray(i, i + win)));
    if (levels.length < 10) return audio;
    const floor = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.2)];
    const limit = Math.max(0.008, floor * 4);
    const sustained = (i) => levels[i] > limit && levels[i + 1] > limit && levels[i + 2] > limit;
    let first = -1, last = -1;
    for (let i = 0; i + run <= levels.length; i++) if (sustained(i)) { first = i; break; }
    for (let i = levels.length - run; i >= 0; i--) if (sustained(i)) { last = i + run - 1; break; }
    if (first < 0) return audio; // nothing clearly spoken: let the recognizer decide
    // Hysteresis: soft words at either end ("well...", "...I think") stay in while above a lower level.
    const soft = Math.max(0.006, floor * 2);
    while (first > 0 && levels[first - 1] > soft) first--;
    while (last < levels.length - 1 && levels[last + 1] > soft) last++;
    const start = Math.max(0, first * win - pad), end = Math.min(audio.length, (last + 1) * win + pad);
    return end - start >= 0.5 * RATE ? audio.slice(start, end) : audio;
  }

  function onFrame(f) {
    const rms = rmsOf(f);
    const h = mic.handlers;
    if (h && h.onLevel) { try { h.onLevel(Math.min(1, rms * 12)); } catch {} }
    if (mic.state === "recording") {
      if (mic.frames.length < MAX_FRAMES) mic.frames.push(f);
      return;
    }
    if (mic.state !== "listening") return;
    const thr = Math.max(0.012, mic.noise * 3);
    if (!mic.speaking) {
      mic.preroll.push(f);
      if (mic.preroll.length > PREROLL) mic.preroll.shift();
      if (rms > thr) {
        if (++mic.above >= START_FRAMES) {
          mic.speaking = true;
          mic.below = 0;
          mic.frames = mic.preroll.slice();
          mic.preroll = [];
          if (h && h.onSpeechStart) { try { h.onSpeechStart(); } catch {} }
        }
      } else {
        mic.above = 0;
        mic.noise = mic.noise * 0.95 + Math.min(rms, 0.05) * 0.05;
      }
      return;
    }
    mic.frames.push(f);
    mic.below = rms < thr * 0.7 ? mic.below + 1 : 0;
    if (mic.below >= mic.endFrames || mic.frames.length >= MAX_FRAMES) finishUtterance();
  }

  function finishUtterance() {
    const id = capture;
    const frames = mic.frames;
    mic.frames = [];
    mic.speaking = false;
    mic.above = 0;
    mic.below = 0;
    const h = mic.handlers;
    if (frames.length * FRAME < 0.45 * RATE) { if (h && h.onDiscard) h.onDiscard(); return; }   // a cough or a click
    const audio = joinFrames(frames.slice(0, frames.length - Math.floor(mic.endFrames / 2)));
    if (h && h.onUtterance) { try { h.onUtterance(); } catch {} }
    if (id !== capture) return;
    transcribe(audio).then(
      (text) => { if (id === capture && h && h.onText) h.onText(text); },
      (err) => { if (id === capture && h && h.onError) h.onError(err); },
    );
  }

  const ASoundMic = {
    supported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioWorkletNode),
    status,
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    configure: (cfg) => asr.configure(cfg),
    // the multilingual recognizer: transcribeNative(f32, "zh") for speech in the learner's own language
    configureHelp: (cfg) => help.configure(cfg),
    hasNative: () => !!help.config,
    hasModel: () => !!asr.config, // false until a speech recognition pack is installed
    transcribeNative: (audio, lang) => help.transcribe(audio, lang),
    preload: () => loadASR().catch(() => {}),
    record: (handlers = {}) => startCapture(handlers, "recording"),
    // Stop a manual recording; resolves {text, audio} (audio: 16 kHz Float32Array, kept for pitch analysis).
    // stop({raw: true}) skips the English transcription (for transcribeNative).
    async stop({ raw = false } = {}) {
      if (mic.state !== "recording") return { text: "", audio: null };
      const id = capture;
      let audio = joinFrames(mic.frames);
      mic.frames = [];
      mic.state = "paused";
      emit();
      requireCapture(id);
      if (audio.length < 0.3 * RATE || raw) return { text: "", audio }; // raw: the whole recording (timed segments)
      const copy = audio.slice();
      // Tap-to-talk records the pauses before and after speaking; the small recognizer often returns nothing for
      // a short phrase surrounded by silence, so it first hears only the speech, then the whole clip if that is empty.
      const speech = trimSilence(audio);
      const kept = speech === audio ? copy : speech.slice(); // what is played back ("compare"): the speech only
      try {
        let text = await transcribe(speech);
        requireCapture(id);
        if (!text && speech !== audio) text = await transcribe(copy.slice());
        requireCapture(id);
        return { text, audio: kept };
      } catch (err) {
        if (id !== capture) throw aborted();
        throw err;
      }
    },
    cancel: close,
    RATE,
    listen: (handlers = {}) => startCapture(handlers, "listening"),
    pause() {
      if (mic.state === "listening" || mic.state === "recording") {
        Object.assign(mic, { state: "paused", frames: [], preroll: [], speaking: false, above: 0, below: 0 });
        emit();
      }
    },
    resume() {
      if (mic.state === "paused" && mic.handlers) {
        Object.assign(mic, { state: "listening", frames: [], preroll: [], speaking: false, above: 0, below: 0 });
        emit();
      }
    },
    close,
    transcribe,
  };
  window.ASoundMic = ASoundMic;
})();
