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
        "en": ("Optional visual memory aids for picturable everyday words. Three were drawn and checked by hand; the "
               "rest were drawn locally with Z-Image-Turbo (Tongyi-MAI, Apache-2.0) from a written scene per word, "
               "checked for text by OCR. Images do not change definitions, exam membership or random selection."),
        "zh": ("\u65e5\u5e38\u8bcd\u6c47\u4e2d\u53ef\u914d\u56fe\u8bcd\u7684\u53ef\u9009\u8bb0\u5fc6\u914d\u56fe\u3002\u5176\u4e2d\u4e09\u5f20\u4e3a\u4eba\u5de5\u751f\u6210\u5e76\u68c0\u67e5\uff1b\u5176\u4f59\u7531 Z-Image-Turbo\uff08\u901a\u4e49 Tongyi-MAI\uff0c"
               "Apache-2.0\uff09\u5728\u672c\u5730\u6309\u6bcf\u4e2a\u8bcd\u7684\u573a\u666f\u63cf\u8ff0\u751f\u6210\uff0c\u5e76\u7ecf OCR \u68c0\u67e5\u4e0d\u542b\u6587\u5b57\u3002\u914d\u56fe\u4e0d\u6539\u53d8\u91ca\u4e49\u3001\u8003\u8bd5\u5f52\u5c5e\u6216\u968f\u673a\u62bd\u8bcd\u3002"),
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
