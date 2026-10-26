"""Serve browser-only model download checks on loopback, without real model downloads.

    python tests/serve_download_checks.py --port 8784

Open http://127.0.0.1:8784/ and click the test button. Only this test page, its
production download module, synthetic bytes and test control endpoints are served.
"""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import socket
import threading
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parent.parent
SIZE = 5 * 1024 * 1024 + 17
PATTERN = bytes(range(251))
DATA = (PATTERN * ((SIZE + len(PATTERN) - 1) // len(PATTERN)))[:SIZE]
DIGEST = hashlib.sha256(DATA).hexdigest()
RUNS = {}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def reply(self, data, content_type="application/json", status=200, extra=None):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def request_details(self):
        parsed = urlsplit(self.path)
        run = parse_qs(parsed.query).get("run", [""])[0]
        return parsed.path, run

    def do_POST(self):
        path, run = self.request_details()
        if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", run):
            self.reply({"error": "Invalid test run"}, status=400)
            return
        # The browser sends no body. Avoid persistent-connection desync for other clients.
        if int(self.headers.get("Content-Length", 0)):
            self.reply({"error": "No request body expected"}, status=400)
            self.close_connection = True
            return
        with LOCK:
            if path == "/control/reset":
                RUNS[run] = {"recovered": False, "requests": []}
                result = {"reset": True}
            elif path == "/control/recover" and run in RUNS:
                RUNS[run]["recovered"] = True
                result = {"recovered": True}
            else:
                result = None
        self.reply(result or {"error": "Unknown test run or route"}, status=200 if result else 404)

    def do_GET(self):
        path, run = self.request_details()
        files = {
            "/": (ROOT / "tests" / "browser_downloads.html", "text/html; charset=utf-8"),
            "/tests/browser_downloads.html": (ROOT / "tests" / "browser_downloads.html", "text/html; charset=utf-8"),
            "/app/js/model-download.js": (ROOT / "app" / "js" / "model-download.js", "text/javascript; charset=utf-8"),
        }
        if path in files:
            file, mime = files[path]
            self.reply(file.read_bytes(), mime)
            return
        if path == "/fixture-info":
            self.reply({"size": SIZE, "sha256": DIGEST, "chunkBytes": 4 * 1024 * 1024})
            return
        with LOCK:
            state = RUNS.get(run)
            if path == "/control/report" and state:
                self.reply({"requests": list(state["requests"]), "recovered": state["recovered"]})
                return
        if path not in {"/fixture/resume.bin", "/fixture/full.bin", "/fixture/wrong.bin"} or state is None:
            self.reply({"error": "Not found"}, status=404)
            return
        requested = self.headers.get("Range")
        match = re.fullmatch(r"bytes=(\d+)-(\d+)", requested or "")
        use_range = bool(match) and path != "/fixture/full.bin"
        start, end = (int(match[1]), int(match[2])) if use_range else (0, SIZE - 1)
        if not (0 <= start <= end < SIZE):
            self.reply({"error": "Invalid range"}, status=416, extra={"Content-Range": f"bytes */{SIZE}"})
            return
        with LOCK:
            broken = path == "/fixture/resume.bin" and start >= 4 * 1024 * 1024 and not state["recovered"]
            state["requests"].append({
                "path": path, "range": requested, "start": start, "end": end,
                "status": 206 if use_range else 200, "broken": broken,
            })
        payload = DATA[start:end + 1]
        self.send_response(206 if use_range else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", '"fixture-v1"')
        if use_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{SIZE}")
        self.end_headers()
        try:
            self.wfile.write(payload[:8192] if broken else payload)
            self.wfile.flush()
            if broken:
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.connection.close()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8784)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"Download checks: http://127.0.0.1:{server.server_port}/", flush=True)
    print(f"Synthetic fixture: {SIZE} bytes, SHA-256 {DIGEST}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
