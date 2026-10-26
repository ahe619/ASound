"""Local-only CPU runtime smoke test against the prepared release (no model weights).

Open http://127.0.0.1:8785/soundoa-site/__cpu_compat_check__.html in a browser.
The same route without /soundoa-site/ checks root-domain relative paths.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "dist" / "soundoa-site" / "site"
HARNESS = ROOT / "tests" / "browser_cpu_compat.html"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def translate_path(self, path):
        route = urlsplit(path).path
        if route.startswith("/soundoa-site/"):
            route = route[len("/soundoa-site"):]
        if route == "/__cpu_compat_check__.html":
            return str(HARNESS)
        return super().translate_path(route)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    if not (SITE / "index.html").is_file():
        raise SystemExit("Run tools/prepare_soundoa_site.py first")
    print("CPU runtime checks: http://127.0.0.1:8785/soundoa-site/__cpu_compat_check__.html", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8785), Handler).serve_forever()
