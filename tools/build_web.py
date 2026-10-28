"""Build an offline-capable, versioned web release for any static HTTPS host.

    python tools/build_web.py
    python -m http.server 8782 --directory dist/web

The output excludes downloaded models unless the verified browser voice is opted
in with --with-web-voice. Development pages are always excluded. Every app asset
has a SHA-256 digest in the generated worker so a partial deployment cannot replace
a working installed release. No third-party Python dependencies are required.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import unquote, urlsplit

try:
    from .prepare_web_voice import prepare_voice
except ImportError:
    from prepare_web_voice import prepare_voice

ROOT = Path(__file__).resolve().parent.parent
MARKER = ".asound-web-build"
DIRECTORIES = {"audio", "css", "fonts", "img", "js", "kokoro", "locales", "vendor", "vocabulary"}
ROOT_FILES = {"index.html", "manifest.webmanifest", "packs.json"}
OPTIONAL_ROOT_FILES = {"repair.html", "voice-check.html"}
LAZY_PREFIXES = ("audio/", "vendor/", "kokoro/", "img/vocabulary/",
                 "vocabulary/illustrations.json", "vocabulary/cet-2016-index.json")  # provenance/reference, not read at run time
RELEASE_LINE = 'const RELEASE = "development"; // @asound-release'
ASSETS_LINE = 'const ASSETS = []; // @asound-assets'
VOICE_RUNTIME_ASSETS = frozenset({
    "kokoro/kokoro.web.js", "kokoro/neural-tts.js", "kokoro/lexicon-us.json",
    "kokoro/ort-cpu/ort-wasm-simd-threaded.mjs",
    "kokoro/ort-cpu/ort-wasm-simd-threaded.wasm",
})


def voice_download_asset(name):
    """Only the current browser voice runtime and individual voice previews."""
    return name in VOICE_RUNTIME_ASSETS or bool(re.fullmatch(r"audio/voices/(?:af|am)_[a-z]+\.wav", name))


def normalize_download_bases(values):
    if values is None:
        return []
    if isinstance(values, str) or not isinstance(values, (list, tuple)) or len(values) > 3:
        raise ValueError("Download bases must be a list of at most three public HTTPS roots")
    normalized = [validate_model_base_url(value) for value in values]
    if len(set(normalized)) != len(normalized):
        raise ValueError("Download bases must be distinct")
    return normalized


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_model_base_url(value):
    """Return a stable public model root, allowing HTTP only for local previews."""
    if not isinstance(value, str) or not value or any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError("Model base URL must be a nonempty URL without whitespace")
    if "\\" in value:
        raise ValueError("Model base URL cannot contain backslashes")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid model base URL") from exc
    if (not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or "?" in value or "#" in value):
        raise ValueError("Model base URL must not contain credentials, a query or a fragment")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("Model base URL must use HTTPS (HTTP is allowed only on localhost)")
    if port == 0 or not re.fullmatch(r"[A-Za-z0-9.:-]+", parsed.hostname):
        raise ValueError("Invalid model base URL host or port")
    decoded = parsed.path
    for _ in range(8):
        previous = decoded
        decoded = unquote(decoded)
        if decoded == previous:
            break
    else:
        raise ValueError("Model base URL has excessive URL encoding")
    if (any(part in (".", "..") for part in decoded.split("/")) or "\\" in decoded
            or any(c.isspace() or ord(c) < 32 for c in decoded) or "?" in decoded or "#" in decoded):
        raise ValueError("Model base URL cannot contain traversal or ambiguous path segments")
    return value.rstrip("/")


def source_files(source):
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if relative.parts[0] not in DIRECTORIES and relative.as_posix() not in ROOT_FILES | OPTIONAL_ROOT_FILES:
            continue
        if any(part.startswith(".") or part == "__pycache__" for part in relative.parts):
            continue
        if path.is_symlink() or not path.resolve().is_relative_to(source.resolve()):
            raise ValueError(f"Do not publish linked assets: {relative}")
        if path.is_file():
            yield relative, path


def build(source, output, version, license_file=None, model_base_url=None, model_packs=None,
          with_web_voice=False, download_web_voice=False, download_bases=None):
    source, output = Path(source).resolve(), Path(output).resolve()
    with_web_voice = with_web_voice or download_web_voice
    model_base_url = validate_model_base_url(model_base_url) if model_base_url is not None else None
    download_bases = normalize_download_bases(download_bases)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", version):
        raise ValueError("Version must contain 1-64 letters, digits, dots, underscores or hyphens")
    if source == output or output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError("Output must be outside the source app directory")
    if output.exists() and (not output.is_dir() or not (output / MARKER).is_file()):
        raise ValueError(f"Refusing to replace a directory not created by build_web: {output}")
    worker = (source / "sw.js").read_text(encoding="utf-8-sig")
    if worker.count(RELEASE_LINE) != 1 or worker.count(ASSETS_LINE) != 1:
        raise ValueError("sw.js is missing the unique release/assets build markers")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".asound-web-", dir=output.parent)).resolve()
    try:
        for relative, path in source_files(source):
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if relative.as_posix() in VOICE_RUNTIME_ASSETS and relative.suffix in {".js", ".mjs", ".json"}:
                # Match Linux CI when this checkout uses Windows CRLF. Mirror object
                # keys must remain usable when prepared locally before a URL is set.
                target.write_bytes(path.read_bytes().replace(b"\r\n", b"\n"))
            else:
                shutil.copyfile(path, target)
        for name in ROOT_FILES:
            if not (stage / name).is_file():
                raise ValueError(f"Missing required web asset: {name}")
        optional_files = set()
        if model_base_url or model_packs is not None or with_web_voice or download_bases:
            catalog_path = stage / "packs.json"
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            if model_packs is not None:
                values = [model_packs] if isinstance(model_packs, str) else model_packs
                selected = {name.strip() for value in values for name in value.split(",")}
                available = {pack["id"] for pack in catalog.get("packs", [])}
                if not selected or "" in selected or selected - available:
                    raise ValueError("Model pack selection is empty or contains unknown IDs: " + ", ".join(sorted(selected - available)))
                catalog["packs"] = [pack for pack in catalog["packs"] if pack["id"] in selected]
            if model_base_url:
                # A self-hosted build must not silently send model requests to third parties.
                catalog["sources"] = {"deployment": {"models": model_base_url, "libs": model_base_url + "/libs"}}
                catalog["defaultSource"] = "deployment"
            if with_web_voice:
                optional_files = prepare_voice(catalog, source / "models", stage, download=download_web_voice)
            if download_bases:
                catalog["downloadBases"] = download_bases
            catalog_path.write_text(encode(catalog) + "\n", encoding="utf-8", newline="\n")
        if license_file:
            shutil.copyfile(license_file, stage / "LICENSES.md")
        (stage / ".nojekyll").write_text("", encoding="utf-8")
        assets = [{"url": p.relative_to(stage).as_posix(), "sha256": digest(p.read_bytes())}
                  for p in sorted(stage.rglob("*")) if p.is_file() and p.name != ".nojekyll"
                  and p.relative_to(stage).as_posix() not in optional_files]
        # Speech runtimes and word pictures are cached on first use, not on install (see sw.js).
        for asset in assets:
            if asset["url"].startswith(LAZY_PREFIXES):
                asset["lazy"] = True
            if download_bases and voice_download_asset(asset["url"]):
                asset["mirrors"] = [f"{base}/assets/{asset['sha256']}/{asset['url']}" for base in download_bases]
                asset["size"] = (stage / asset["url"]).stat().st_size
                if asset["size"] <= 0:
                    raise ValueError(f"Cannot mirror an empty voice asset: {asset['url']}")
        # Include the worker template: changing only its logic must get a fresh cache.
        release = version + "-" + digest((worker + encode(assets) + version).encode("utf-8"))[:12]
        metadata = encode({"version": release, "appVersion": version}) + "\n"
        (stage / "version.json").write_text(metadata, encoding="utf-8", newline="\n")
        assets.append({"url": "version.json", "sha256": digest(metadata.encode("utf-8"))})
        assets.sort(key=lambda item: item["url"])
        worker = worker.replace(RELEASE_LINE, f"const RELEASE = {encode(release)}; // @asound-release")
        worker = worker.replace(ASSETS_LINE, f"const ASSETS = {encode(assets)}; // @asound-assets")
        (stage / "sw.js").write_text(worker, encoding="utf-8", newline="\n")
        (stage / MARKER).write_text(release + "\n", encoding="utf-8")
        size = sum(p.stat().st_size for p in stage.rglob("*") if p.is_file())
        if size > 1_000_000_000:
            raise ValueError("Web release exceeds GitHub Pages' 1 GB site limit")
        # Only ever remove a verified build directory; never app/, models/ or arbitrary outputs.
        if output.exists():
            if not (output / MARKER).is_file() or output.is_relative_to(source):
                raise ValueError("Output changed while building; refusing to replace it")
            shutil.rmtree(output)
        stage.rename(output)
        return {"version": release, "files": len(assets), "bytes": size, "output": str(output),
                "optionalVoiceFiles": len(optional_files)}
    finally:
        if stage.exists() and stage.parent == output.parent and stage.name.startswith(".asound-web-"):
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "web")
    parser.add_argument("--version", default=(ROOT / "VERSION").read_text(encoding="utf-8").strip())
    parser.add_argument("--model-base-url", help="Public HTTPS model root; omit to keep the existing model sources")
    parser.add_argument("--packs", help="Comma-separated model pack IDs to expose; omit to include all packs")
    parser.add_argument("--with-web-voice", action="store_true", help="Host the verified q8 phone/browser voice as an optional same-origin download")
    parser.add_argument("--download-web-voice", action="store_true", help="Fetch missing pinned voice files before building (implies --with-web-voice)")
    parser.add_argument("--download-base-url", action="append", help="Optional public HTTPS voice mirror root; repeat up to three times")
    args = parser.parse_args()
    result = build(ROOT / "app", args.out, args.version, ROOT / "LICENSES.md", args.model_base_url, args.packs,
                   with_web_voice=args.with_web_voice or args.download_web_voice, download_web_voice=args.download_web_voice,
                   download_bases=args.download_base_url)
    print(f"{result['version']}: {result['files']} assets, {result['bytes'] / 1_000_000:.1f} MB -> {result['output']}")


if __name__ == "__main__":
    main()
