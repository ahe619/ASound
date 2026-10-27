"""Publish the drawn vocabulary pictures: merge build/word-images/done.json into app/vocabulary/illustrations.json.

    .venv\\Scripts\\python.exe tools\\word_images_manifest.py

Keeps the existing hand-checked entries (bridge, harvest, balance) as they are. A drawn picture is published only if
its word exists, its chosen sense occurs in the dictionary definition, the OCR check passed for these exact bytes,
and the file on disk still has the recorded hash. Unpublished leftovers in app/img/vocabulary are deleted.
"""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
MANIFEST = APP / "vocabulary" / "illustrations.json"
DONE = ROOT / "build" / "word-images" / "done.json"
LICENSE = "Apache-2.0"


def main():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    words = {w["id"]: w for w in json.loads((APP / "vocabulary" / "words.json").read_text(encoding="utf-8"))["words"]}
    done = json.loads(DONE.read_text(encoding="utf-8")) if DONE.exists() else {}
    kept = [e for e in manifest["illustrations"] if e["generation"].get("tool") != "Z-Image-Turbo"]
    taken = {e["wordId"] for e in kept}
    published, skipped = [], {}
    for word_id, d in sorted(done.items()):
        word = words.get(word_id)
        path = APP / d["src"]
        reason = None
        if word_id in taken:
            reason = "has a hand-checked picture"
        elif d.get("rejected"):
            reason = d["rejected"]
        elif not word or word["term"] != d.get("term"):
            reason = "word not in dictionary"
        elif d["sense"]["zh"] not in word["meaning"]:
            reason = "sense not in definition"
        elif d.get("qa") != d["sha256"]:
            reason = "text check not passed"
        elif not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != d["sha256"]:
            reason = "file missing or changed"
        if reason:
            skipped[reason] = skipped.get(reason, 0) + 1
            continue
        published.append({
            "wordId": word_id, "term": d["term"], "sense": d["sense"], "alt": d["alt"], "src": d["src"],
            "width": d["width"], "height": d["height"], "bytes": d["bytes"], "sha256": d["sha256"],
            "generation": {
                "tool": "Z-Image-Turbo", "mode": "local", "model": d["model"], "modelLicense": LICENSE,
                "revision": d["revision"], "date": d["date"], "inputImages": [], "prompt": d["prompt"],
                "seed": d["seed"], "steps": d["steps"], "drawnSize": d["drawnSize"],
                "publicationEncoding": {"format": "webp", "quality": 72, "width": d["width"], "preserveFullFrame": True},
                "textCheck": "RapidOCR: no text",
            },
        })
    manifest["batch"] = "initial-three-words + everyday-deck-z1"
    manifest["notes"] = {
        "en": f"Optional visual memory aids for picturable everyday words. The first three were generated with image_gen and visually checked; {len(published)} additional pictures were generated locally with Z-Image-Turbo from written scenes and screened for text by OCR. Definitions and exam membership are unchanged. New random Say it rounds use pictured words when enough match the selected filters; other study modes keep their normal selection.",
        "zh": f"\u65e5\u5e38\u8bcd\u6c47\u4e2d\u53ef\u914d\u56fe\u8bcd\u7684\u53ef\u9009\u8bb0\u5fc6\u914d\u56fe\u3002\u9996\u6279\u4e09\u5f20\u901a\u8fc7 image_gen \u751f\u6210\u5e76\u4eba\u5de5\u68c0\u67e5\uff1b\u53e6\u6709 {len(published)} \u5f20\u901a\u8fc7\u672c\u5730 Z-Image-Turbo \u6309\u573a\u666f\u63cf\u8ff0\u751f\u6210\uff0c\u5e76\u7531 OCR \u7b5b\u67e5\u6587\u5b57\u3002\u8bcd\u4e49\u4e0e\u8003\u8bd5\u5f52\u5c5e\u4fdd\u6301\u4e0d\u53d8\u3002\u53e3\u8ff0\u6a21\u5f0f\u65b0\u5efa\u968f\u673a\u7ec3\u4e60\u65f6\uff0c\u82e5\u5f53\u524d\u7b5b\u9009\u4e0b\u6709\u8db3\u591f\u7684\u914d\u56fe\u8bcd\uff0c\u4f1a\u4ece\u914d\u56fe\u8bcd\u4e2d\u62bd\u53d6\uff1b\u5176\u4ed6\u6a21\u5f0f\u4fdd\u6301\u539f\u6709\u62bd\u8bcd\u65b9\u5f0f\u3002"
    }
    manifest["illustrations"] = kept + published
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    # What the app loads at run time: only what a card needs (the full manifest keeps the provenance).
    compact = {"schemaVersion": 1, "pictures": {e["wordId"]: [e["src"], e["width"], e["height"], e["term"],
               e["sense"]["zh"], e["sense"]["en"], e["alt"]["zh"], e["alt"]["en"]] for e in manifest["illustrations"]}}
    (APP / "vocabulary" / "pictures.json").write_text(json.dumps(compact, ensure_ascii=False, separators=(",", ":")) + "\n",
                                                     encoding="utf-8", newline="\n")
    listed = {e["src"] for e in manifest["illustrations"]}
    removed = 0
    for f in (APP / "img" / "vocabulary").glob("*-z1.webp"):
        if f"img/vocabulary/{f.name}" not in listed:
            f.unlink()
            removed += 1
    size = sum(e["bytes"] for e in published)
    print(f"published {len(published)} drawn pictures ({size / 1e6:.1f} MB) + {len(kept)} hand-checked; "
          f"skipped {skipped}; removed {removed} unlisted files")


if __name__ == "__main__":
    main()
