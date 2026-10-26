"""Quick check of native Kokoro speed and output on this computer."""

import os
import time

import numpy as np
from kokoro_onnx import Kokoro

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = os.path.join(ROOT, "models", "kokoro-onnx")

t0 = time.perf_counter()
k = Kokoro(os.path.join(M, "kokoro-v1.0.int8.onnx"), os.path.join(M, "voices-v1.0.bin"))
print(f"load {time.perf_counter() - t0:.2f}s")
for text, voice in [
    ("Hey! How's it going?", "af_heart"),
    ("Could you put the water bottle in the car? I'm gonna grab a cup of coffee.", "am_michael"),
    ("I think the third question is a lot harder than the first two.", "af_heart"),
]:
    t0 = time.perf_counter()
    audio, sr = k.create(text, voice=voice, speed=1.0, lang="en-us")
    dt = time.perf_counter() - t0
    print(f"{voice}: {len(audio) / sr:.2f}s audio in {dt:.2f}s  nan={int(np.isnan(audio).sum())} peak={float(np.abs(audio).max()):.3f}")
