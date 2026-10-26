"""Build an offline-capable, versioned web release for any static HTTPS host.

    python tools/build_web.py
    python -m http.server 8782 --directory dist/web

The output excludes downloaded models and development pages. Every shipped asset
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

ROOT = Path(__file__).resolve().parent.parent
MARKER = ".asound-web-build"
DIRECTORIES = {"css", "fonts", "img", "js", "kokoro", "locales", "vendor", "vocabulary"}
ROOT_FILES = {"index.html", "manifest.webmanifest", "packs.json"}
RELEASE_LINE = 'const RELEASE = "development"; // @asound-release'
ASSETS_LINE = 'const ASSETS = []; // @asound-assets'


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
        if relative.parts[0] not in DIRECTORIES and relative.as_posix() not in ROOT_FILES:
            continue
        if any(part.startswith(".") or part == "__pycache__" for part in relative.parts):
            continue
        if path.is_symlink() or not path.resolve().is_relative_to(source.resolve()):
            raise ValueError(f"Do not publish linked assets: {relative}")
        if path.is_file():
            yield relative, path


def build(source, output, version, license_file=None, model_base_url=None, model_packs=None):
    source, output = Path(source).resolve(), Path(output).resolve()
    model_base_url = validate_model_base_url(model_base_url) if model_base_url is not None else None
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
            shutil.copyfile(path, target)
        for name in ROOT_FILES:
            if not (stage / name).is_file():
                raise ValueError(f"Missing required web asset: {name}")
        if model_base_url or model_packs is not None:
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
            catalog_path.write_text(encode(catalog) + "\n", encoding="utf-8", newline="\n")
        if license_file:
            shutil.copyfile(license_file, stage / "LICENSES.md")
        (stage / ".nojekyll").write_text("", encoding="utf-8")
        assets = [{"url": p.relative_to(stage).as_posix(), "sha256": digest(p.read_bytes())}
                  for p in sorted(stage.rglob("*")) if p.is_file() and p.name != ".nojekyll"]
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
        return {"version": release, "files": len(assets), "bytes": size, "output": str(output)}
    finally:
        if stage.exists() and stage.parent == output.parent and stage.name.startswith(".asound-web-"):
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "web")
    parser.add_argument("--version", default=(ROOT / "VERSION").read_text(encoding="utf-8").strip())
    parser.add_argument("--model-base-url", help="Public HTTPS model root; omit to keep the existing model sources")
    parser.add_argument("--packs", help="Comma-separated model pack IDs to expose; omit to include all packs")
    args = parser.parse_args()
    result = build(ROOT / "app", args.out, args.version, ROOT / "LICENSES.md", args.model_base_url, args.packs)
    print(f"{result['version']}: {result['files']} assets, {result['bytes'] / 1_000_000:.1f} MB -> {result['output']}")


if __name__ == "__main__":
    main()
