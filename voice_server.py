"""ASound natural voice: Chatterbox (Resemble AI, MIT) on an NVIDIA GPU, as a small local service.

Started by server.py when the optional .venv-voice environment exists. Listens on 127.0.0.1:8771.

    POST /tts  {"text", "ref"}  -> audio/wav     ref: path of a short reference clip whose voice to follow
    GET  /health               {"ready": bool}
"""

import http.server
import io
import json
import os
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("HF_HOME", os.path.join(ROOT, "models", "hf"))
PORT = 8771

import numpy as np  # noqa: E402
import soundfile  # noqa: E402
import torch  # noqa: E402
from chatterbox.tts import ChatterboxTTS  # noqa: E402

LOCK = threading.Lock()
MODEL = None
READY = threading.Event()


def load():
    global MODEL
    MODEL = ChatterboxTTS.from_pretrained(device="cuda")
    MODEL.generate("Hello there.")  # warm-up: the first call is slow
    READY.set()


CURRENT_REF = [None]


def synth(text, ref):
    with LOCK:
        # Analyse a reference voice once and keep it until another voice is asked for.
        if ref and os.path.exists(ref) and ref != CURRENT_REF[0]:
            MODEL.prepare_conditionals(ref, exaggeration=0.5)
            CURRENT_REF[0] = ref
        wav = MODEL.generate(text, exaggeration=0.5, cfg_weight=0.5)
    audio = np.clip(wav.squeeze().detach().cpu().numpy(), -1.0, 1.0)
    buf = io.BytesIO()
    soundfile.write(buf, audio, MODEL.sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, json.dumps({"ready": READY.is_set()}).encode(), "application/json")
        self._send(404, b"{}", "application/json")

    def do_POST(self):
        if not self.path.startswith("/tts"):
            return self._send(404, b"{}", "application/json")
        if not READY.wait(timeout=120):
            return self._send(503, b'{"error": "still loading"}', "application/json")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(min(length, 20000)) or b"{}")
            text = str(req.get("text", "")).strip()[:600]
            if not text:
                return self._send(400, b'{"error": "empty text"}', "application/json")
            data = synth(text, str(req.get("ref", "")))
        except Exception as e:
            return self._send(500, json.dumps({"error": str(e)[:300]}).encode(), "application/json")
        self._send(200, data, "audio/wav")

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    if not torch.cuda.is_available():
        raise SystemExit("natural voice needs an NVIDIA GPU with CUDA")
    threading.Thread(target=load, daemon=True).start()
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
