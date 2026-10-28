"""Prepare a verified voice-only OSS/COS upload package without network access.

    python tools/prepare_download_mirror.py --site dist/soundoa-site/site

Upload the contents of payload/, or extract upload.zip at the chosen public
download root. manifest.json is an operator receipt, not an upload credential.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import uuid
import zipfile

try:
    from .build_web import VOICE_RUNTIME_ASSETS, voice_download_asset
    from .prepare_soundoa_site import checked_path, verify_site
except ImportError:
    from build_web import VOICE_RUNTIME_ASSETS, voice_download_asset
    from prepare_soundoa_site import checked_path, verify_site


ROOT = Path(__file__).resolve().parents[1]
MARKER = ".asound-download-mirror"
MARKER_TEXT = "ASound voice download mirror v1\n"
NOTICES = frozenset({
    "LICENSES.md", "kokoro/KOKORO-MODEL-LICENSE.txt", "kokoro/LICENSE-kokoro-js.txt",
    "kokoro/ort-cpu/LICENSE.txt", "kokoro/ort-cpu/sources.json", "voice-models.json",
})
CONTENT_TYPES = {
    ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
    ".json": "application/json", ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8", ".onnx": "application/octet-stream", ".bin": "application/octet-stream",
}


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def reject_links(directory):
    """Do not follow even an otherwise harmless link in a release or old output."""
    checked_path(directory)
    for path in directory.rglob("*"):
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise ValueError(f"Linked mirror content is not supported: {path}")
        if not path.resolve().is_relative_to(directory):
            raise ValueError(f"Mirror content escaped its directory: {path}")


def check_owned(output):
    if not output.exists():
        return
    token = output / MARKER
    if (not output.is_dir() or not token.is_file() or token.is_symlink()
            or token.read_text(encoding="utf-8") != MARKER_TEXT):
        raise ValueError(f"Refusing to replace an unowned mirror directory: {output}")
    reject_links(output)


def prepare(site=ROOT / "dist/soundoa-site/site", output=ROOT / "dist/domestic-downloads"):
    site, output = checked_path(site), checked_path(output)
    if not site.is_dir():
        raise ValueError("Build a local web release with --with-web-voice first")
    if site == output or site.is_relative_to(output) or output.is_relative_to(site):
        raise ValueError("Mirror output must be separate from the input website")
    if output == ROOT or ROOT.is_relative_to(output) or output.is_relative_to(ROOT / "app"):
        raise ValueError("Mirror output cannot replace the project or enter app/")
    check_owned(output)
    reject_links(site)
    assets = {entry["url"]: entry for entry in verify_site(site)}
    catalog = json.loads((site / "packs.json").read_text(encoding="utf-8"))
    if not catalog.get("voiceSource"):
        raise ValueError("The verified release must include --with-web-voice")
    missing = (VOICE_RUNTIME_ASSETS | NOTICES) - assets.keys()
    if missing:
        raise ValueError("Missing voice runtime or license: " + ", ".join(sorted(missing)))
    previews = {name for name in assets if name.startswith("audio/voices/") and voice_download_asset(name)}
    if not previews:
        raise ValueError("The release has no voice preview audio")
    voice = json.loads((site / "voice-models.json").read_text(encoding="utf-8"))
    version = json.loads((site / "version.json").read_text(encoding="utf-8"))
    entries = []
    # verify_site already checked these model paths, sizes, hashes and revision against the source lock.
    for entry in voice["files"]:
        entries.append({**entry, "source": entry["url"], "kind": "voice-model"})
    for name in sorted(VOICE_RUNTIME_ASSETS | previews | NOTICES):
        asset = assets[name]
        mirrored = voice_download_asset(name)
        entries.append({
            "source": name, "url": f"assets/{asset['sha256']}/{name}" if mirrored else name,
            "sha256": asset["sha256"], "size": (site / name).stat().st_size,
            "kind": "preview" if name in previews else "runtime" if mirrored else "notice",
        })
    entries.sort(key=lambda entry: entry["url"])
    if len({entry["url"] for entry in entries}) != len(entries):
        raise ValueError("Duplicate mirror object path")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".asound-mirror-", dir=output.parent)).resolve()
    backup = None
    try:
        (stage / MARKER).write_text(MARKER_TEXT, encoding="utf-8")
        payload = stage / "payload"
        for entry in entries:
            original = checked_path(site / entry["source"])
            target = payload / entry["url"]
            if not original.is_relative_to(site) or not target.resolve().is_relative_to(payload.resolve()):
                raise ValueError("Unsafe mirror object path")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            if target.stat().st_size != entry["size"] or file_hash(target) != entry["sha256"]:
                raise ValueError(f"Mirror source changed or checksum mismatch: {entry['source']}")
            entry["contentType"] = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
            entry["cacheControl"] = ("public, max-age=31536000, immutable" if entry["kind"] != "notice"
                                     else "public, max-age=3600")
        manifest = {
            "schemaVersion": 1, "status": "prepared_only", "uploaded": False,
            "mainlandNetworkTested": False, "release": version["version"],
            "voiceSource": catalog["voiceSource"], "voiceRevision": voice["revision"],
            "files": entries, "bytes": sum(entry["size"] for entry in entries),
        }
        with zipfile.ZipFile(stage / "upload.zip", "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for entry in entries:
                bundle.write(payload / entry["url"], entry["url"])
        with zipfile.ZipFile(stage / "upload.zip") as bundle:
            if bundle.testzip() is not None:
                raise ValueError("Mirror ZIP failed validation")
        manifest["archiveSha256"] = file_hash(stage / "upload.zip")
        (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        # Stage completely before replacing only our own output, and roll back a failed final rename.
        check_owned(output)
        if output.exists():
            backup = output.with_name(".asound-mirror-backup-" + uuid.uuid4().hex)
            output.rename(backup)
        try:
            stage.rename(output)
        except BaseException:
            if backup:
                backup.rename(output)
                backup = None
            raise
        if backup:
            shutil.rmtree(backup)
            backup = None
        return {"output": str(output), "archive": str(output / "upload.zip"),
                "files": len(entries), "bytes": manifest["bytes"], "release": manifest["release"]}
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", type=Path, default=ROOT / "dist/soundoa-site/site")
    parser.add_argument("--out", type=Path, default=ROOT / "dist/domestic-downloads")
    args = parser.parse_args()
    result = prepare(args.site, args.out)
    print(f"Prepared only: {result['files']} verified voice files, {result['bytes'] / 1_000_000:.1f} MB -> {result['archive']}")
    print("No cloud service configured, no upload performed, no speed improvement verified.")


if __name__ == "__main__":
    main()
