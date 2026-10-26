"""Measure the median pitch (F0) of each Kokoro voice, used to recommend a voice close to the learner's own."""

import json
import os

import numpy as np
from kokoro_onnx import Kokoro

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = os.path.join(ROOT, "models", "kokoro-onnx")
VOICES = ["af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah", "af_nova", "af_alloy", "af_sky",
          "am_michael", "am_fenrir", "am_puck", "am_echo", "am_eric", "am_liam", "am_onyx"]
TEXT = "Hi there! I'm really glad you could make it today. How was your weekend? Did you do anything fun?"


def median_f0(x, sr):
    frame, hop = int(sr * 0.04), int(sr * 0.01)
    lo, hi = int(sr / 400), int(sr / 65)
    f0s = []
    for s in range(0, len(x) - frame - hi, hop):
        a = x[s:s + frame]
        e = float(np.dot(a, a))
        if e / frame < 2e-4:
            continue
        best, lag_best = 0.0, 0
        for lag in range(lo, hi):
            b = x[s + lag:s + lag + frame]
            r = float(np.dot(a, b)) / np.sqrt(e * float(np.dot(b, b)) + 1e-12)
            if r > best:
                best, lag_best = r, lag
        if best > 0.65 and lag_best:
            f0s.append(sr / lag_best)
    return float(np.median(f0s)) if len(f0s) >= 5 else 0.0


k = Kokoro(os.path.join(M, "kokoro-v1.0.int8.onnx"), os.path.join(M, "voices-v1.0.bin"))
out = {}
for v in VOICES:
    audio, sr = k.create(TEXT, voice=v, speed=1.0, lang="en-us")
    out[v] = round(median_f0(np.asarray(audio, dtype=np.float64), sr))
    print(v, out[v], flush=True)
print(json.dumps(out))
