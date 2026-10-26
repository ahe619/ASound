"""Prepare a model upload manifest, optionally copying verified local model files.

No network requests are made. Without --source-dir the output contains a manifest
only. With --source-dir, the input is an ASound desktop models directory (repo/path
and libs/name.wasm); the output uses the public /resolve/main/ directory layout.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
MARKER = ".asound-model-host"
DEFAULT_PACKS = ("llm-0.8b-f16", "llm-0.8b-f32", "llm-cpu", "asr-tiny", "voice")


def safe_relative(value):
    if (not isinstance(value, str) or not value or value.startswith("/")
            or any(c in value for c in "\\:%?#")
            or any(ord(c) < 32 for c in value)
            or any(part in ("", ".", "..") or part.endswith((" ", ".")) for part in value.split("/"))):
        raise ValueError(f"Unsafe model path: {value!r}")
    return value


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def make_manifest(catalog, pack_ids=None):
    values = DEFAULT_PACKS if pack_ids is None else ([pack_ids] if isinstance(pack_ids, str) else pack_ids)
    wanted = list(dict.fromkeys(name.strip() for value in values for name in value.split(",")))
    if not wanted or "" in wanted:
        raise ValueError("Model pack selection cannot be empty")
    packs = {pack["id"]: pack for pack in catalog["packs"]}
    unknown = set(wanted) - packs.keys()
    if unknown:
        raise ValueError("Unknown packs: " + ", ".join(sorted(unknown)))
    files = {}
    for pack_id in wanted:
        for item in packs[pack_id]["files"]:
            path = safe_relative(item["path"])
            if item.get("repo"):
                repo = safe_relative(item["repo"])
                target = f"{repo}/resolve/main/{path}"
                local = f"{repo}/{path}"
                urls = {name: source["models"].rstrip("/") + "/" + quote(target, safe="/")
                        for name, source in catalog["sources"].items()}
            elif item.get("lib"):
                library = safe_relative(item["lib"].removeprefix("libs/"))
                target = local = f"libs/{library}"
                urls = {name: source["libs"].rstrip("/") + "/" + quote(library, safe="/")
                        for name, source in catalog["sources"].items()}
            else:
                raise ValueError(f"Model file has no repository or library: {path}")
            size = item["size"]
            checksum = item.get("sha256")
            if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                raise ValueError(f"Invalid model file size: {target}")
            if checksum is not None and not re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
                raise ValueError(f"Invalid SHA-256: {target}")
            entry = {"path": target, "sourcePath": local, "size": size,
                     "sha256": checksum.lower() if checksum else None,
                     "urls": urls, "packs": [pack_id], "status": "not_checked"}
            if target in files:
                old = files[target]
                if any(old[key] != entry[key] for key in ("sourcePath", "size", "sha256", "urls")):
                    raise ValueError(f"Conflicting model entries: {target}")
                old["packs"].append(pack_id)
            else:
                files[target] = entry
    ordered = [files[key] for key in sorted(files)]
    return {"schemaVersion": 1, "catalogVersion": catalog.get("version"),
            "packs": wanted, "readyForUpload": False, "totalBytes": sum(f["size"] for f in ordered),
            "fileCount": len(ordered), "files": ordered}


def contained_file(root, relative):
    target = root / safe_relative(relative)
    if not target.resolve().is_relative_to(root):
        raise ValueError(f"Model file escapes its directory: {relative}")
    if target.is_symlink() or any(parent.is_symlink() for parent in target.parents if parent != root and parent.is_relative_to(root)):
        raise ValueError(f"Linked model files are not supported: {relative}")
    return target


def prepare(catalog_path, output, pack_ids=None, source_dir=None):
    catalog_path = Path(catalog_path).resolve()
    output_arg = Path(output)
    if output_arg.is_symlink():
        raise ValueError("Model host output cannot be a symbolic link")
    output = output_arg.resolve()
    source = Path(source_dir).resolve() if source_dir is not None else None
    if source is not None and not source.is_dir():
        raise ValueError("Source models directory does not exist")
    if source is not None and (source == output or source.is_relative_to(output) or output.is_relative_to(source)):
        raise ValueError("Model host output must be outside the source models directory")
    if catalog_path.is_relative_to(output):
        raise ValueError("Model host output cannot contain the input catalog")
    if output.exists() and (not output.is_dir() or not (output / MARKER).is_file()):
        raise ValueError(f"Refusing to replace an unowned model host directory: {output}")
    if output.exists() and source is None:
        previous = output / "model-manifest.json"
        if previous.is_file() and json.loads(previous.read_text(encoding="utf-8")).get("readyForUpload"):
            raise ValueError("A manifest-only run cannot replace a complete model distribution; use a new --out")
    manifest = make_manifest(json.loads(catalog_path.read_text(encoding="utf-8")), pack_ids)
    if source is not None:
        for entry in manifest["files"]:
            local = contained_file(source, entry["sourcePath"])
            if not local.is_file():
                entry["status"] = "missing"
                continue
            if local.stat().st_size != entry["size"]:
                entry["status"] = "invalid_size"
                continue
            actual = sha256_file(local)
            entry["localSha256"] = actual
            entry["status"] = "verified" if not entry["sha256"] or actual == entry["sha256"] else "invalid_sha256"
    manifest["readyForUpload"] = bool(manifest["files"]) and all(f["status"] == "verified" for f in manifest["files"])
    manifest["verifiedBytes"] = sum(f["size"] for f in manifest["files"] if f["status"] == "verified")
    # An incomplete audit must not erase a previously prepared model distribution.
    if output.exists() and source is not None and not manifest["readyForUpload"]:
        raise ValueError("Local models are incomplete or invalid; previous model host output was preserved. Use a new --out to save the audit.")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".asound-model-host-", dir=output.parent)).resolve()
    try:
        if source is not None:
            for entry in manifest["files"]:
                if entry["status"] != "verified":
                    continue
                target = contained_file(stage, entry["path"])
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(contained_file(source, entry["sourcePath"]), target)
                if target.stat().st_size != entry["size"] or sha256_file(target) != entry["localSha256"]:
                    raise ValueError(f"Model changed while copying: {entry['sourcePath']}")
                entry["status"] = "copied"
        (stage / "model-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        (stage / MARKER).write_text("ASound model host layout v1\n", encoding="utf-8")
        if output.exists():
            if output.is_symlink() or not (output / MARKER).is_file():
                raise ValueError("Model host output changed while preparing")
            shutil.rmtree(output)
        stage.rename(output)
    finally:
        if stage.exists() and stage.parent == output.parent and stage.name.startswith(".asound-model-host-"):
            shutil.rmtree(stage)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=ROOT / "app" / "packs.json")
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "model-host")
    parser.add_argument("--packs", nargs="+", default=list(DEFAULT_PACKS), help="Exact model pack IDs to prepare")
    parser.add_argument("--source-dir", type=Path, help="Existing local models directory; no files are downloaded")
    args = parser.parse_args()
    result = prepare(args.catalog, args.out, args.packs, args.source_dir)
    print(f"{result['fileCount']} files, {result['totalBytes'] / 1_000_000:.1f} MB -> {args.out.resolve()}")
    if args.source_dir is None:
        print("Manifest only: model weights are not included; readyForUpload=false.")
    elif result["readyForUpload"]:
        print("All selected model files were verified and copied; readyForUpload=true.")
    else:
        missing = [f for f in result["files"] if f["status"] != "copied"]
        print(f"NOT READY: {len(missing)} model files are missing or invalid. See model-manifest.json.")
        raise SystemExit(2)


if __name__ == "__main__":
    main()
