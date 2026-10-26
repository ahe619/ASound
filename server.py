"""ASound local server.

Serves app/ at http://127.0.0.1:8770 and a small local API. A real http://localhost origin (not file://)
is what lets the browser use the microphone, WebGPU and its storage. Everything stays on this computer.

    python server.py              # start and open ASound in the default browser
    python server.py --no-browser

API
    GET  /api/health              {"tts": bool, "natural": "absent" | "off" | "loading" | "ready"}
    POST /api/tts                 {"text", "voice", "speed", "engine": "standard" | "natural"} -> audio/wav
    POST /api/natural/start       start the natural-voice service (Chatterbox on the GPU) if installed
    GET  /api/packs               model packs: installed / downloading (see packs.py)
    POST /api/packs/install       {"id", "source": "auto" | "hf" | "mirror"}; also /cancel and /remove with {"id"}
"""

import http.server
import io
import json
import os
import subprocess
import sys
import threading
import urllib.request
import wave
import webbrowser

from packs import Packs

PORT = 8770  # keep fixed: the browser keeps app data per origin (host + port)
# In the packaged ASound.exe the app and model folders sit next to the executable.
ROOT = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(ROOT, "app")
KOKORO_DIR = os.path.join(ROOT, "models", "kokoro-onnx")
KOKORO_PACK = os.path.join(APP, "models", "onnx-community", "Kokoro-82M-v1.0-ONNX")
REF_DIR = os.path.join(ROOT, "models", "voice-refs")
VOICE_PY = os.path.join(ROOT, ".venv-voice", "Scripts", "python.exe")
NATURAL_URL = "http://127.0.0.1:8771"
REF_TEXT = ("Hi there! I'm really glad you could make it today. So, how was your weekend? "
            "Did you get up to anything fun, or did you just take it easy?")


class Speech:
    """Native Kokoro text-to-speech (onnxruntime on the CPU), loaded on first use.

    Model files come from the downloadable packs (app/models/onnx-community/Kokoro-82M-v1.0-ONNX: the 8-bit model,
    the full-precision one and one file per voice); models/kokoro-onnx/ is the older layout and still works.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._kokoro = None
        self._key = None
        self.error = None

    @staticmethod
    def _model_path():
        # Full precision sounds a little smoother; the 8-bit model is the smaller fallback.
        for path in (os.path.join(KOKORO_PACK, "onnx", "model.onnx"), os.path.join(KOKORO_DIR, "kokoro-v1.0.onnx"),
                     os.path.join(KOKORO_PACK, "onnx", "model_quantized.onnx"), os.path.join(KOKORO_DIR, "kokoro-v1.0.int8.onnx")):
            if os.path.exists(path):
                return path
        return None

    @staticmethod
    def _voices():
        if os.path.isdir(os.path.join(KOKORO_PACK, "voices")) and os.listdir(os.path.join(KOKORO_PACK, "voices")):
            return os.path.join(KOKORO_PACK, "voices")
        legacy = os.path.join(KOKORO_DIR, "voices-v1.0.bin")
        return legacy if os.path.exists(legacy) else None

    def available(self):
        try:
            import onnxruntime  # noqa: F401
        except Exception:
            return False
        return self._model_path() is not None and self._voices() is not None

    def _load(self):
        key = (self._model_path(), self._voices())
        if self._kokoro is None or key != self._key:  # a pack was added or removed since
            try:
                from kokoro_lite import KokoroLite  # our own phonemizer: no GPL code
                self._kokoro = KokoroLite(*key)
            except ImportError:
                from kokoro_onnx import Kokoro
                self._kokoro = Kokoro(key[0], _voices_archive(key[1]))
            self._key = key
        return self._kokoro

    def wav(self, text, voice, speed):
        import numpy as np
        with self._lock:  # the phonemizer is not thread-safe
            k = self._load()
            if k.__class__.__name__ == "KokoroLite":
                audio, sr = k.create(text, voice=voice, speed=speed)
            else:
                audio, sr = k.create(text, voice=voice, speed=speed, lang="en-us")
        pcm = (np.clip(np.nan_to_num(audio), -1.0, 1.0) * 32767).astype("<i2").tobytes()
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm)
        return buf.getvalue()

    def reference(self, voice):
        """A short clip of a Kokoro voice, which the natural engine imitates."""
        path = os.path.join(REF_DIR, f"{voice}.wav")
        if not os.path.exists(path):
            os.makedirs(REF_DIR, exist_ok=True)
            with open(path, "wb") as f:
                f.write(self.wav(REF_TEXT, voice, 1.0))
        return path


def _voices_archive(voices):
    """kokoro-onnx wants all voices in one .npz file; build it from the per-voice files of the pack once."""
    if os.path.isfile(voices):
        return voices
    import numpy as np
    out = os.path.join(KOKORO_DIR, "voices-pack.npz")
    names = sorted(n for n in os.listdir(voices) if n.endswith(".bin"))
    if not os.path.exists(out) or os.path.getmtime(out) < max(os.path.getmtime(os.path.join(voices, n)) for n in names):
        os.makedirs(KOKORO_DIR, exist_ok=True)
        arrays = {n[:-4]: np.fromfile(os.path.join(voices, n), dtype=np.float32).reshape(-1, 1, 256) for n in names}
        with open(out, "wb") as f:
            np.savez(f, **arrays)
    return out


SPEECH = Speech()
PACKS = Packs(APP)


class Natural:
    """Chatterbox runs in its own Python environment (.venv-voice, CUDA PyTorch) as voice_server.py."""

    def __init__(self):
        self._proc = None
        self._lock = threading.Lock()

    def installed(self):
        return os.path.exists(VOICE_PY)

    def _ready(self):
        try:
            with urllib.request.urlopen(NATURAL_URL + "/health", timeout=1) as r:
                return bool(json.load(r).get("ready"))
        except Exception:
            return False

    def state(self):
        if not self.installed():
            return "absent"
        if self._proc is None or self._proc.poll() is not None:
            return "ready" if self._ready() else "off"
        return "ready" if self._ready() else "loading"

    def start(self):
        with self._lock:
            if not self.installed() or (self._proc is not None and self._proc.poll() is None):
                return
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self._proc = subprocess.Popen([VOICE_PY, os.path.join(ROOT, "voice_server.py")], cwd=ROOT,
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)

    def wav(self, text, voice):
        body = json.dumps({"text": text, "ref": SPEECH.reference(voice)}).encode("utf-8")
        req = urllib.request.Request(NATURAL_URL + "/tts", data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.read()

    def stop(self):
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()


NATURAL = Natural()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".onnx": "application/octet-stream",
        ".bin": "application/octet-stream",
        ".woff2": "font/woff2",
        ".webmanifest": "application/manifest+json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP, **kwargs)

    def translate_path(self, path):
        # WebLLM asks for <model>/resolve/main/<file>, the Hugging Face URL layout; files sit in <model>/<file>.
        return super().translate_path(path.replace("/resolve/main/", "/"))

    def send_response(self, code, message=None):
        self._status = code
        super().send_response(code, message)

    def end_headers(self):
        # No cross-origin isolation on purpose: with it, ONNX Runtime starts thread workers that hang inside the
        # Kokoro bundle used as the in-browser fallback.
        big = "/models/" in self.path or "/kokoro/" in self.path
        ok = getattr(self, "_status", 200) == 200
        self.send_header("Cache-Control", "public, max-age=86400" if big and ok else "no-store" if not ok else "no-cache")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self, limit=20000):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(min(length, limit)) or b"{}")

    def do_GET(self):
        if self.path.startswith("/api/health"):
            return self._json(200, {"tts": SPEECH.available(), "natural": NATURAL.state(), "packs": True})
        if self.path.startswith("/api/packs"):
            return self._json(200, PACKS.status())
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/natural/start"):
            NATURAL.start()
            return self._json(200, {"natural": NATURAL.state()})
        if self.path.startswith("/api/packs/"):
            try:
                req = self._body()
                pid = str(req.get("id", ""))
                PACKS.reload()
                if pid not in PACKS.packs:
                    return self._json(404, {"error": "unknown pack"})
                action = self.path.split("?")[0].rsplit("/", 1)[-1]
                if action == "install":
                    PACKS.install(pid, str(req.get("source", "auto")))
                elif action == "cancel":
                    PACKS.cancel(pid)
                elif action == "remove":
                    PACKS.remove(pid)
                else:
                    return self._json(404, {"error": "not found"})
                return self._json(200, PACKS.status())
            except Exception as e:
                return self._json(500, {"error": str(e)[:300]})
        if not self.path.startswith("/api/tts"):
            return self._json(404, {"error": "not found"})
        if not SPEECH.available():
            return self._json(503, {"error": "native speech is not installed"})
        try:
            req = self._body()
            text = str(req.get("text", "")).strip()[:1000]
            voice = str(req.get("voice", "af_heart"))
            if not voice.replace("_", "").isalnum():
                return self._json(400, {"error": "bad voice"})
            speed = min(2.0, max(0.5, float(req.get("speed", 1.0))))
            if not text:
                return self._json(400, {"error": "empty text"})
            if req.get("engine") == "natural":
                if NATURAL.state() != "ready":
                    NATURAL.start()
                    return self._json(503, {"error": "natural voice is starting", "natural": NATURAL.state()})
                data = NATURAL.wav(text, voice)
            else:
                data = SPEECH.wav(text, voice, speed)
        except Exception as e:  # report instead of dropping the connection
            return self._json(500, {"error": str(e)[:300]})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


def make_server():
    return http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)


def main():
    server = make_server()
    url = f"http://127.0.0.1:{PORT}/"
    print(f"ASound is running at {url}  (close this window to stop)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        NATURAL.stop()


if __name__ == "__main__":
    main()
