"""Publish only the pinned browser-compatible Kokoro q8 pack, on explicit request.

The lock file pins both an upstream revision and the SHA-256 of every file. Model
payloads are optional downloads, never part of the service worker's app precache.
"""

import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import time
import urllib.request

LOCK = Path(__file__).with_name("web_voice_manifest.json")
MANIFEST_NAME = "voice-models.json"
REPOSITORY = "onnx-community/Kokoro-82M-v1.0-ONNX"


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load_manifest():
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    if lock.get("repository") != REPOSITORY or not re.fullmatch(r"[a-f0-9]{40}", lock.get("revision", "")):
        raise ValueError("Invalid browser voice source lock")
    seen = set()
    for item in lock["files"]:
        name = item["path"]
        if (name not in {"config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"}
                and not re.fullmatch(r"voices/(?:af|am)_[a-z]+\.bin", name)):
            raise ValueError("Unexpected browser voice file")
        if name in seen or not re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", "")) or not isinstance(item.get("size"), int) or item["size"] <= 0:
            raise ValueError("Invalid browser voice file lock")
        seen.add(name)
    if not seen:
        raise ValueError("Empty browser voice pack")
    return lock


def version_of(lock):
    return hashlib.sha256(json.dumps(lock, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def checked_file(root, relative):
    path = root / relative
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Browser voice path escaped its directory")
    for parent in (path, *path.parents):
        if parent.is_symlink() or getattr(parent, "is_junction", lambda: False)():
            raise ValueError("Linked browser voice files are not supported")
        if parent == root:
            break
    return path


def verify_file(path, entry):
    if not path.is_file() or path.stat().st_size != entry["size"] or sha256(path) != entry["sha256"]:
        raise ValueError(f"Browser voice checksum or size mismatch: {entry['path']}")


def download_file(path, item, lock):
    path.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://huggingface.co/{lock['repository']}/resolve/{lock['revision']}/{item['path']}"
    for attempt in range(3):
        temporary = None
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "ASound-release-builder"})
            with urllib.request.urlopen(request, timeout=60) as response, tempfile.NamedTemporaryFile(dir=path.parent, prefix=".voice-", delete=False) as target:
                temporary = Path(target.name)
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > item["size"]:
                        raise ValueError("Browser voice download exceeds the pinned size")
                    target.write(chunk)
            verify_file(temporary, item)
            temporary.replace(path)
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()


def prepare_voice(catalog, model_root, site, download=False):
    """Copy verified voice files and return the only optional published filenames."""
    lock = load_manifest()
    voice = next((p for p in catalog.get("packs", []) if p["id"] == "voice"), None)
    if voice is None:
        raise ValueError("The browser voice pack must be selected when hosting its files")
    expected = {f["path"]: f for f in lock["files"]}
    if {f["path"] for f in voice["files"]} != set(expected):
        raise ValueError("Voice catalog differs from the pinned browser pack")
    for item in voice["files"]:
        locked = expected[item["path"]]
        if item.get("repo") != lock["repository"] or item["size"] != locked["size"] or item.get("sha256", locked["sha256"]) != locked["sha256"]:
            raise ValueError("Voice catalog does not match the pinned browser file")
        item["sha256"] = locked["sha256"]
    version = version_of(lock)
    base = f"voice-models/{version}"
    files = []
    for item in lock["files"]:
        original = checked_file(Path(model_root), f"{lock['repository']}/{item['path']}")
        if not original.exists() and download:
            download_file(original, item, lock)
        verify_file(original, item)
        name = f"{base}/{lock['repository']}/resolve/main/{item['path']}"
        target = site / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, target)
        files.append({"url": name, "size": item["size"], "sha256": item["sha256"]})
    manifest = {"schemaVersion": 1, "repository": lock["repository"], "revision": lock["revision"],
                "license": lock["license"], "version": version, "files": files}
    (site / MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    catalog["voiceSource"] = {"models": base, "repository": lock["repository"], "version": version, "manifest": MANIFEST_NAME}
    return {entry["url"] for entry in files}


def verify_voice_payload(site, catalog):
    """Validate the narrowly allowlisted optional payload, including every hash."""
    source = catalog.get("voiceSource")
    if not source:
        return set()
    lock = load_manifest()
    version = version_of(lock)
    base = f"voice-models/{version}"
    if source != {"models": base, "repository": lock["repository"], "version": version, "manifest": MANIFEST_NAME}:
        raise ValueError("Unexpected hosted voice source")
    manifest = json.loads((site / MANIFEST_NAME).read_text(encoding="utf-8"))
    expected = [{"url": f"{base}/{lock['repository']}/resolve/main/{entry['path']}", "size": entry["size"], "sha256": entry["sha256"]} for entry in lock["files"]]
    if manifest != {"schemaVersion": 1, "repository": lock["repository"], "revision": lock["revision"], "license": lock["license"], "version": version, "files": expected}:
        raise ValueError("Hosted voice manifest differs from its lock")
    for entry in expected:
        path = checked_file(site, entry["url"])
        verify_file(path, {**entry, "path": entry["url"]})
    return {entry["url"] for entry in expected}
