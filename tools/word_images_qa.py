"""Check the drawn vocabulary pictures for text (a picture with letters on it can teach the wrong word).

    .venv\\Scripts\\python.exe tools\\word_images_qa.py      # writes build/word-images/flagged.json

Uses RapidOCR (Apache-2.0, PaddleOCR models). Flags a picture when OCR reads at least two letters or digits with
confidence >= 0.75; single shapes such as an umbrella handle read as "J" are ignored. Redraw flagged ones with
tools/gen_word_images.py ... --redo (a new seed each attempt).
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DONE = ROOT / "build" / "word-images" / "done.json"
FLAGGED = ROOT / "build" / "word-images" / "flagged.json"


def main():
    from rapidocr_onnxruntime import RapidOCR
    ocr = RapidOCR()
    done = json.loads(DONE.read_text(encoding="utf-8"))
    flagged = {}
    for word_id, entry in done.items():
        if entry.get("rejected") or entry.get("qa") == entry["sha256"]:
            continue  # already checked these exact bytes
        result, _ = ocr(str(ROOT / "app" / entry["src"]))
        text = [r[1] for r in (result or []) if r[2] >= 0.75 and len(re.findall(r"[A-Za-z0-9]", r[1])) >= 2]
        if text:
            flagged[word_id] = text
        else:
            entry["qa"] = entry["sha256"]
    DONE.write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding="utf-8")
    FLAGGED.write_text(json.dumps(flagged, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"checked {len(done)}; {len(flagged)} with text: {', '.join(list(flagged)[:20])}")


if __name__ == "__main__":
    main()
