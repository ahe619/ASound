"""Try Chatterbox (Resemble AI, MIT) on the GPU: speed, and sample files to compare with Kokoro."""

import os
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("HF_HOME", os.path.join(ROOT, "models", "hf"))

import soundfile  # noqa: E402
import torch  # noqa: E402
from chatterbox.tts import ChatterboxTTS  # noqa: E402

OUT = os.path.join(ROOT, "branding", "voice-samples")
os.makedirs(OUT, exist_ok=True)

t0 = time.perf_counter()
model = ChatterboxTTS.from_pretrained(device="cuda")
print(f"load {time.perf_counter() - t0:.1f}s", flush=True)

texts = [
    "Hey! How's it going? I was just about to grab a coffee. Wanna come with?",
    "Honestly, I think the third question is a lot harder than the first two, but we can figure it out together.",
]
for i, text in enumerate(texts):
    t0 = time.perf_counter()
    wav = model.generate(text, exaggeration=0.5, cfg_weight=0.5)
    torch.cuda.synchronize()
    dt = time.perf_counter() - t0
    sec = wav.shape[-1] / model.sr
    soundfile.write(os.path.join(OUT, f"chatterbox-{i + 1}.wav"), wav.squeeze().cpu().numpy(), model.sr)
    print(f"sample {i + 1}: {sec:.2f}s audio in {dt:.2f}s", flush=True)
