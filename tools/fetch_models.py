"""Download the open-source models ASound runs locally, into app/models/.

Run once with an internet connection; after that ASound works fully offline.
Only the Python standard library is used.

    python tools/fetch_models.py            # everything
    python tools/fetch_models.py llm        # just one group: llm | asr
"""

import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "app", "models")

HF = "https://huggingface.co"
MLC_LIBS = "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base"

# group -> list of (Hugging Face repo, file filter) and extra single files (url, relative destination)
GROUPS = {
    "llm": {
        "repos": [("mlc-ai/Qwen3.5-4B-q4f16_1-MLC", None)],
        "files": [(f"{MLC_LIBS}/Qwen3.5-4B-q4f16_1_cs1k-webgpu.wasm", "libs/Qwen3.5-4B-q4f16_1_cs1k-webgpu.wasm")],
    },
    "asr": {
        "repos": [(
            "onnx-community/moonshine-base-ONNX",
            # GPU: fp32 encoder + q4 decoder (as in the Moonshine web demo); CPU fallback: int8 quantized
            lambda p: not p.startswith("onnx/") or p in (
                "onnx/encoder_model.onnx",
                "onnx/decoder_model_merged_q4.onnx",
                "onnx/encoder_model_quantized.onnx",
                "onnx/decoder_model_merged_quantized.onnx",
            ),
        )],
        "files": [],
    },
}


def list_repo(repo):
    url = f"{HF}/api/models/{repo}/tree/main?recursive=1"
    with urllib.request.urlopen(url, timeout=60) as r:
        items = json.load(r)
    return [(it["path"], it.get("size", 0)) for it in items if it.get("type") == "file"]


def download(url, dest, size=None):
    if os.path.exists(dest) and (size is None or os.path.getsize(dest) == size):
        print(f"  ok      {os.path.relpath(dest, MODELS)}")
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    print(f"  fetch   {os.path.relpath(dest, MODELS)}" + (f"  ({size / 1e6:.1f} MB)" if size else ""), flush=True)
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    if size is not None and os.path.getsize(tmp) != size:
        raise RuntimeError(f"size mismatch for {dest}")
    os.replace(tmp, dest)


def fetch(group):
    spec = GROUPS[group]
    print(f"[{group}]")
    for repo, keep in spec["repos"]:
        for path, size in list_repo(repo):
            if path.startswith(".") or path.endswith(".md") or (keep and not keep(path)):
                continue
            download(f"{HF}/{repo}/resolve/main/{path}", os.path.join(MODELS, repo, path), size or None)
    for url, rel in spec["files"]:
        download(url, os.path.join(MODELS, rel))


if __name__ == "__main__":
    for g in sys.argv[1:] or list(GROUPS):
        fetch(g)
    print("done")
