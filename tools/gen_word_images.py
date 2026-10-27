"""Draw the vocabulary pictures with Z-Image-Turbo (Tongyi-MAI, Apache-2.0) on the local NVIDIA GPU.

Run with the voice environment's PyTorch and a newer diffusers kept apart from it:

    set PYTHONPATH=build\\imgdeps
    .venv-voice\\Scripts\\python.exe tools\\gen_word_images.py build\\word-images\\items.json [--limit N] [--only id,id]

items.json: [{"id", "term", "sense_zh", "sense_en", "scene", "alt_en", "alt_zh"}, ...] (picked by reviewers from the
everyday deck). Writes app/img/vocabulary/<slug>-z1.webp (480 x 360) and build/word-images/done.json with the
prompt, seed and hashes of each picture; tools/word_images_manifest.py turns that into app/vocabulary/illustrations.json.
Pictures already drawn are skipped, so the run can be stopped and resumed.
"""

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "img" / "vocabulary"
DONE = ROOT / "build" / "word-images" / "done.json"
MODEL_HOME = ROOT / "models" / "hf-img"
REPO = "Tongyi-MAI/Z-Image-Turbo"
# No "flashcard"/"card" wording: the model then draws a card with a (wrong) word on it.
STYLE = ("Flat vector illustration of {scene}. One clear subject, centered, simple shapes, soft warm colors, plain light "
         "background. A wordless picture: no writing of any kind, no labels, no captions, no signs, no logos.")
WIDTH, HEIGHT = 768, 576      # drawn size (multiple of 16)
SAVE = (480, 360)             # published size
STEPS = 9                     # the model card's recommendation (8 sampling steps)


def slug(word_id):
    return re.sub(r"[^a-z0-9]+", "-", word_id.lower()).strip("-")


def seed_for(word_id):
    return int(hashlib.sha256(word_id.encode("utf-8")).hexdigest()[:8], 16)


def main():
    args = sys.argv[1:]
    items = json.loads(Path(args[0]).read_text(encoding="utf-8"))
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    only = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
    if only:
        items = [x for x in items if x["id"] in only]
    done = json.loads(DONE.read_text(encoding="utf-8")) if DONE.exists() else {}
    # --redo: draw the pictures tools/word_images_qa.py flagged again with the next seed; after 3 tries, give up on them.
    attempts = {}
    if "--redo" in args:
        flagged = json.loads((DONE.parent / "flagged.json").read_text(encoding="utf-8"))
        for word_id in flagged:
            if word_id in done:
                attempts[word_id] = done[word_id].get("attempt", 0) + 1
                if attempts[word_id] >= 3:
                    done[word_id]["rejected"] = "text in picture"
                else:
                    del done[word_id]
        items = [x for x in items if x["id"] in attempts and attempts[x["id"]] < 3]
    todo = [x for x in items if x["id"] not in done]
    if limit:
        todo = todo[:limit]
    if not todo:
        DONE.write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding="utf-8")
        print("nothing to draw")
        return

    os.environ.setdefault("HF_HOME", str(MODEL_HOME))
    import torch
    from diffusers import ZImagePipeline
    from PIL import Image  # noqa: F401  (Pillow saves the WebP files)

    # The download skipped the model card's sample images, so use the snapshot folder directly.
    snapshots = sorted((MODEL_HOME / "hub" / "models--Tongyi-MAI--Z-Image-Turbo" / "snapshots").glob("*"))
    if not snapshots:
        sys.exit("Z-Image-Turbo is not downloaded (see the docstring)")
    path = str(snapshots[-1])
    revision = Path(path).name
    pipe = ZImagePipeline.from_pretrained(path, torch_dtype=torch.bfloat16).to("cuda")
    OUT.mkdir(parents=True, exist_ok=True)
    DONE.parent.mkdir(parents=True, exist_ok=True)
    t_start = time.time()
    for n, item in enumerate(todo, 1):
        prompt = STYLE.format(scene=item["scene"].rstrip(". "))
        attempt = attempts.get(item["id"], 0)
        seed = seed_for(item["id"]) + attempt
        t0 = time.time()
        image = pipe(prompt=prompt, height=HEIGHT, width=WIDTH, num_inference_steps=STEPS, guidance_scale=0.0,
                     generator=torch.Generator("cuda").manual_seed(seed)).images[0]
        small = image.resize(SAVE, resample=3)  # Lanczos
        name = f"{slug(item['id'])}-z1.webp"
        target = OUT / name
        small.save(target, "WEBP", quality=72, method=6)
        data = target.read_bytes()
        done[item["id"]] = {
            "src": f"img/vocabulary/{name}", "width": SAVE[0], "height": SAVE[1], "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "prompt": prompt, "seed": seed,
            "model": REPO, "revision": revision, "steps": STEPS, "drawnSize": [WIDTH, HEIGHT], "attempt": attempt,
            "term": item["term"], "sense": {"zh": item["sense_zh"], "en": item["sense_en"]},
            "alt": {"zh": item["alt_zh"], "en": item["alt_en"]},
            "date": time.strftime("%Y-%m-%d"),
        }
        if n % 10 == 0 or n == len(todo):
            DONE.write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{n}/{len(todo)} {item['id']}: {time.time() - t0:.2f}s, {len(data) // 1024} KB", flush=True)
    DONE.write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"done: {len(todo)} pictures in {time.time() - t_start:.0f}s")


if __name__ == "__main__":
    main()
