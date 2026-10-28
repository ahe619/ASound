"""Build the 16 short Kokoro voice previews using only the existing local voice pack.

From the repository root:
    .venv/Scripts/python.exe tools/generate_voice_previews.py
    .venv/Scripts/python.exe tools/generate_voice_previews.py --verify-only

Uses the same quantized ONNX model, individual voice tables, and KokoroLite
American-English phonemizer already shipped by ASound. No download or API call.
The generated WAVs are ordinary playback assets, not models. Source hashes,
runtime versions, parameters, and output checksums are kept in the adjacent
voice_previews_manifest.json. Regeneration replaces the listed preview WAVs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import sys
import wave

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "app/models/onnx-community/Kokoro-82M-v1.0-ONNX"
MODEL = PACK / "onnx/model_quantized.onnx"
OUTPUT = ROOT / "app/audio/voices"
MANIFEST = Path(__file__).with_name("voice_previews_manifest.json")
TEXT = "Hello! Let's practice English together."
RATE = 24000
SPEED = 1.0
THREADS = 4


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def voice_ids() -> list[str]:
    source = (ROOT / "app/js/speech.js").read_text(encoding="utf-8")
    block = re.search(r"export const VOICES\s*=\s*\[(.*?)\];", source, re.S)
    if not block:
        raise ValueError("Speech voice list is missing")
    ids = re.findall(r'\bid:\s*"((?:af|am)_[a-z]+)"', block[1])
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("Speech voice list is empty or contains duplicate IDs")
    return ids


def audio_stats(audio: np.ndarray, rate: int) -> dict:
    if rate != RATE or audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
        raise ValueError("Audio must be finite, nonempty, mono, and 24 kHz")
    duration = len(audio) / rate
    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
    peak = float(np.max(np.abs(audio)))
    if not 1 <= duration <= 10 or rms < 0.001 or peak < 0.01:
        raise ValueError(f"Unexpected or silent preview: duration={duration}, rms={rms}, peak={peak}")
    return {"frames": len(audio), "durationSeconds": round(duration, 6),
            "rms": round(rms, 8), "peak": round(peak, 8)}


def read_wav(path: Path) -> dict:
    with wave.open(str(path), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, RATE, "NONE"):
            raise ValueError(f"Unexpected WAV format: {path}")
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    return audio_stats(pcm.astype(np.float64) / 32768, RATE)


def verify() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if [row["voice"] for row in manifest["files"]] != voice_ids():
        raise ValueError("Preview manifest does not match the current speech voice list")
    if manifest["text"] != TEXT or manifest["speed"] != SPEED:
        raise ValueError("Preview text/speed differs from the generator")
    total = 0
    for row in manifest["files"]:
        expected = f'app/audio/voices/{row["voice"]}.wav'
        if row["path"] != expected:
            raise ValueError("Unexpected preview output path")
        path = ROOT / expected
        stats = read_wav(path)
        if path.stat().st_size != row["bytes"] or digest(path) != row["sha256"] or stats != row["pcm"]:
            raise ValueError(f"Preview validation failed: {row['voice']}")
        total += row["bytes"]
    print(f"Verified {len(manifest['files'])} PCM16 mono 24 kHz previews; {total:,} bytes", flush=True)


def generate() -> None:
    sys.path.insert(0, str(ROOT))
    from kokoro_lite import KokoroLite, phonemize
    import onnxruntime as ort

    voices = voice_ids()
    lock = json.loads((ROOT / "tools/web_voice_manifest.json").read_text(encoding="utf-8"))
    pinned = {item["path"]: item for item in lock["files"]}
    needed = ["onnx/model_quantized.onnx", *(f"voices/{voice}.bin" for voice in voices)]
    for name in needed:
        item, file = pinned[name], PACK / name
        if file.stat().st_size != item["size"] or digest(file) != item["sha256"]:
            raise ValueError(f"Local model source differs from the pinned voice pack: {name}")
    tts = KokoroLite(str(MODEL), str(PACK / "voices"), providers=["CPUExecutionProvider"], threads=THREADS)
    manifest = {
        "schemaVersion": 1,
        "text": TEXT, "speed": SPEED, "format": "WAV / PCM signed 16-bit little-endian / mono / 24000 Hz",
        "source": {"repository": lock["repository"], "revision": lock["revision"], "license": lock["license"],
                   "model": "onnx/model_quantized.onnx", "modelSha256": digest(MODEL),
                   "lock": "tools/web_voice_manifest.json"},
        "generation": {"runner": "kokoro_lite.KokoroLite", "provider": "CPUExecutionProvider", "threads": THREADS,
                       "python": platform.python_version(), "numpy": np.__version__, "onnxruntime": ort.__version__,
                       "phonemes": phonemize(TEXT), "runnerSha256": digest(ROOT / "kokoro_lite.py"),
                       "lexiconSha256": digest(ROOT / "app/kokoro/lexicon-us.json"),
                       "encoding": "Clip to [-1, 1], multiply by 32767, convert to little-endian int16; no gain normalization or resampling."},
        "notes": "Synthetic previews from the existing Kokoro voice pack; no external API. Speech starts and ends use the existing KokoroLite trimming/pause behavior. These clips preview each named voice, not a recording of a person.",
        "files": [],
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for voice in voices:
        audio, rate = tts.create(TEXT, voice=voice, speed=SPEED)
        audio = np.asarray(audio, dtype=np.float32)
        generated = audio_stats(audio, rate)
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
        target = OUTPUT / f"{voice}.wav"
        with wave.open(str(target), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(RATE)
            wav.writeframes(pcm.tobytes())
        manifest["files"].append({"voice": voice, "path": target.relative_to(ROOT).as_posix(),
                                  "bytes": target.stat().st_size, "sha256": digest(target),
                                  "voiceTableSha256": digest(PACK / f"voices/{voice}.bin"),
                                  "generated": generated, "pcm": read_wav(target),
                                  "clippedSamples": int(np.count_nonzero(np.abs(audio) > 1))})
        print(f"{voice}: {generated['durationSeconds']:.2f}s, {target.stat().st_size:,} bytes", flush=True)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    verify()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="Validate the existing WAVs without running the model")
    args = parser.parse_args()
    verify() if args.verify_only else generate()
