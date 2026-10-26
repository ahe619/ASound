"""Model packs for the desktop app: what is installed, and downloading the rest in the background.

The catalog is app/packs.json (made by tools/build_packs.py): each pack lists its files with exact sizes and, for
large files, SHA-256 checksums. Files land in app/models/<repo>/<path> (the Hugging Face layout the app already
reads) and app/models/libs/<lib>. Downloads resume after an interruption (.part files + HTTP Range), are verified,
and come from Hugging Face or its mirror (hf-mirror.com and jsDelivr), whichever answers faster.
"""

import hashlib
import json
import os
import shutil
import threading
import time
import urllib.request

UA = {"User-Agent": "ASound/1.0 (model download)"}
PROBE = "onnx-community/moonshine-tiny-ONNX/resolve/main/config.json"


class Cancelled(Exception):
    pass


class Packs:
    def __init__(self, app_dir):
        self.models = os.path.join(app_dir, "models")
        self._catalog = os.path.join(app_dir, "packs.json")
        self._mtime = None
        self.reload()
        self._lock = threading.Lock()
        self._queue = []          # pack ids waiting
        self._current = None      # {"id", "done", "total", "rate"}
        self._cancel = None       # id being cancelled
        self._errors = {}         # id -> message
        self._source = "auto"
        self._resolved = None     # "hf" | "mirror" after a probe
        self._thread = None

    def reload(self):
        """Read app/packs.json again if it changed (an update may add packs while ASound is running)."""
        mtime = os.path.getmtime(self._catalog)
        if mtime == self._mtime:
            return
        with open(self._catalog, encoding="utf-8") as f:
            doc = json.load(f)
        self.sources = doc["sources"]
        self.packs = {p["id"]: p for p in doc["packs"]}
        self._mtime = mtime

    # ---- what is on disk

    def path(self, f):
        if "repo" in f:
            return os.path.join(self.models, *f["repo"].split("/"), *f["path"].split("/"))
        return os.path.join(self.models, *f["path"].split("/"))

    def _file_ok(self, f):
        try:
            return os.path.getsize(self.path(f)) == f["size"]
        except OSError:
            return False

    def installed(self, pid):
        p = self.packs.get(pid)
        return bool(p) and all(self._file_ok(f) for f in p["files"])

    def _have(self, p):
        n = 0
        for f in p["files"]:
            if self._file_ok(f):
                n += f["size"]
            else:
                try:
                    n += os.path.getsize(self.path(f) + ".part")
                except OSError:
                    pass
        return n

    def status(self):
        self.reload()
        with self._lock:
            cur = dict(self._current) if self._current else None
            queue = list(self._queue)
            errors = dict(self._errors)
        out = {}
        for pid, p in self.packs.items():
            if cur and cur["id"] == pid:
                st = {"state": "downloading", "done": cur["done"], "total": p["size"], "rate": cur["rate"]}
            elif pid in queue:
                st = {"state": "queued", "done": self._have(p), "total": p["size"]}
            else:
                have = self._have(p)
                state = "installed" if self.installed(pid) else "partial" if have else "absent"
                st = {"state": state, "done": have if state != "installed" else p["size"], "total": p["size"]}
            if pid in errors and st["state"] in ("partial", "absent"):
                st["error"] = errors[pid]
            out[pid] = st
        try:
            os.makedirs(self.models, exist_ok=True)
            free = shutil.disk_usage(self.models).free
        except OSError:
            free = None
        return {"source": self._source, "resolved": self._resolved, "free": free, "packs": out}

    # ---- actions

    def install(self, pid, source="auto"):
        self.reload()
        if pid not in self.packs:
            raise KeyError(pid)
        with self._lock:
            if source in ("auto", "hf", "mirror") and source != self._source:
                self._source = source
                self._resolved = None
            self._errors.pop(pid, None)
            busy = self._current and self._current["id"] == pid
            if not busy and pid not in self._queue and not self.installed(pid):
                self._queue.append(pid)
            if not self._thread or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, daemon=True)
                self._thread.start()

    def cancel(self, pid):
        with self._lock:
            if pid in self._queue:
                self._queue.remove(pid)
            if self._current and self._current["id"] == pid:
                self._cancel = pid

    def remove(self, pid):
        self.cancel(pid)
        p = self.packs[pid]
        # keep files another installed pack also uses
        keep = {self.path(f) for q in self.packs.values() if q["id"] != pid and self.installed(q["id"]) for f in q["files"]}
        for f in p["files"]:
            for path in (self.path(f), self.path(f) + ".part"):
                if path not in keep and os.path.exists(path):
                    os.remove(path)
        self._prune(self.models)

    def _prune(self, top):
        for d, _, _ in sorted(os.walk(top), key=lambda x: -len(x[0])):
            if d != top:
                try:
                    os.rmdir(d)  # only removes empty folders
                except OSError:
                    pass

    # ---- downloading

    def _probe(self):
        if self._source in ("hf", "mirror"):
            return self._source
        if self._resolved:
            return self._resolved
        best, best_t = "hf", None
        for name, src in self.sources.items():
            t0 = time.time()
            try:
                req = urllib.request.Request(f"{src['models']}/{PROBE}", headers=UA)
                with urllib.request.urlopen(req, timeout=6) as r:
                    r.read()
            except Exception:
                continue
            dt = time.time() - t0
            if best_t is None or dt < best_t:
                best, best_t = name, dt
        self._resolved = best
        return best

    def _url(self, f, source):
        src = self.sources[source]
        if "repo" in f:
            return f"{src['models']}/{f['repo']}/resolve/main/{f['path']}"
        return f"{src['libs']}/{f['lib']}"

    def _run(self):
        while True:
            with self._lock:
                if not self._queue:
                    self._current = None
                    return
                pid = self._queue.pop(0)
                p = self.packs[pid]
                have = self._have(p)
                self._current = {"id": pid, "done": have, "total": p["size"], "rate": 0, "t0": time.time(), "n0": have}
                self._cancel = None
            try:
                need = sum(f["size"] for f in p["files"] if not self._file_ok(f))
                os.makedirs(self.models, exist_ok=True)
                if shutil.disk_usage(self.models).free < need + 200 * 1024 * 1024:
                    raise RuntimeError("disk")
                source = self._probe()
                for f in p["files"]:
                    if self._file_ok(f):
                        continue
                    try:
                        self._fetch(f, self._url(f, source), pid)
                    except Cancelled:
                        raise
                    except Exception:
                        other = "mirror" if source == "hf" else "hf"
                        self._fetch(f, self._url(f, other), pid)  # one retry from the other source
            except Cancelled:
                pass
            except Exception as e:
                with self._lock:
                    self._errors[pid] = str(e)[:200] or e.__class__.__name__
            with self._lock:
                self._current = None

    def _fetch(self, f, url, pid):
        dest = self.path(f)
        part = dest + ".part"
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        have = os.path.getsize(part) if os.path.exists(part) else 0
        if have > f["size"]:
            os.remove(part)
            have = 0
        digest = hashlib.sha256() if f.get("sha256") else None
        if digest and have:
            with open(part, "rb") as old:
                for block in iter(lambda: old.read(1 << 20), b""):
                    digest.update(block)
        headers = dict(UA)
        if have:
            headers["Range"] = f"bytes={have}-"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            if have and r.status != 206:  # the server ignored Range: start this file over
                have = 0
                digest = hashlib.sha256() if f.get("sha256") else None
            others = self._have(self.packs[pid]) - (os.path.getsize(part) if os.path.exists(part) else 0)
            with open(part, "ab" if have else "wb") as out:
                while True:
                    if self._cancel == pid:
                        raise Cancelled()
                    block = r.read(1 << 18)
                    if not block:
                        break
                    out.write(block)
                    if digest:
                        digest.update(block)
                    have += len(block)
                    with self._lock:
                        if self._current:
                            cur = self._current
                            cur["done"] = others + have
                            dt = time.time() - cur["t0"]
                            if dt > 1:
                                cur["rate"] = int((cur["done"] - cur["n0"]) / dt)
        if os.path.getsize(part) != f["size"]:
            raise RuntimeError(f"incomplete download: {f['path']}")
        if digest and digest.hexdigest() != f["sha256"]:
            os.remove(part)
            raise RuntimeError(f"checksum mismatch: {f['path']}")
        os.replace(part, dest)
