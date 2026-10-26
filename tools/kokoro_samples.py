"""Kokoro (full precision) samples of the same lines used in natural_bench.py, for an A/B listen."""

import os

import soundfile
from kokoro_onnx import Kokoro

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = os.path.join(ROOT, "models", "kokoro-onnx")
OUT = os.path.join(ROOT, "branding", "voice-samples")
os.makedirs(OUT, exist_ok=True)

k = Kokoro(os.path.join(M, "kokoro-v1.0.onnx"), os.path.join(M, "voices-v1.0.bin"))
texts = [
    "Hey! How's it going? I was just about to grab a coffee. Wanna come with?",
    "Honestly, I think the third question is a lot harder than the first two, but we can figure it out together.",
]
for i, text in enumerate(texts):
    audio, sr = k.create(text, voice="af_heart", speed=1.0, lang="en-us")
    soundfile.write(os.path.join(OUT, f"kokoro-{i + 1}.wav"), audio, sr)
    print("saved", i + 1)
