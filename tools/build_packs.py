"""Build app/packs.json: the downloadable model packs, with every file's path, size and checksum.

The app downloads packs itself (Settings > Models), from Hugging Face or its mirror. The file lists are written here
ahead of time, so a download only needs plain file URLs (/resolve/main/...), which every mirror serves; the listing
API is not mirrored everywhere. Re-run after changing PACKS:

    python tools/build_packs.py
"""

import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "app", "packs.json")
HF = "https://huggingface.co"
LIB_VERSION = "v0_2_86/base"  # must match the vendored WebLLM build

VOICES = ["af_heart", "af_bella", "af_sarah", "af_aoede", "af_nova", "af_sky", "af_kore", "af_nicole", "af_alloy",
          "am_eric", "am_fenrir", "am_liam", "am_michael", "am_puck", "am_echo", "am_onyx"]
CONFIGS = ("config.json", "generation_config.json", "preprocessor_config.json", "special_tokens_map.json",
           "tokenizer.json", "tokenizer_config.json")


def llm(size, quant, vram_mb, ctx, tier):
    repo = f"mlc-ai/Qwen3.5-{size}-{quant}-MLC"
    lib = f"Qwen3.5-{size}-{quant}_cs1k-webgpu.wasm"
    return {
        "id": f"llm-{size.lower()}-{'f16' if quant == 'q4f16_1' else 'f32'}",
        "group": f"llm-{size.lower()}",
        "kind": "llm",
        "name": f"Qwen3.5-{size}",
        "license": "Apache-2.0",
        "tier": tier,
        "needsF16": quant == "q4f16_1",
        "llm": {"model_id": f"Qwen3.5-{size}-{quant}-MLC", "repo": repo, "lib": f"libs/{lib}", "vram_mb": vram_mb, "ctx": ctx},
        "repos": [{"repo": repo, "keep": "all"}],
        "libs": [lib],
    }


PACKS = [
    llm("0.8B", "q4f16_1", 1630, 4096, "phone"),
    llm("0.8B", "q4f32_1", 1895, 4096, "phone"),
    llm("2B", "q4f16_1", 2246, 4096, "laptop"),
    llm("2B", "q4f32_1", 2592, 4096, "laptop"),
    llm("4B", "q4f16_1", 3868, 8192, "desktop"),
    llm("4B", "q4f32_1", 4681, 8192, "desktop"),
    {
        # for phones and browsers without WebGPU: llama.cpp in WebAssembly (wllama) on the processor
        "id": "llm-cpu", "group": "llm-cpu", "kind": "llm-cpu", "name": "Qwen3.5-0.8B (processor)", "license": "Apache-2.0",
        "tier": "phone",
        "cpu": {"repo": "ggml-org/Qwen3.5-0.8B-GGUF", "path": "Qwen3.5-0.8B-Q4_0.gguf", "ctx": 4096},
        "repos": [{"repo": "ggml-org/Qwen3.5-0.8B-GGUF", "keep": ["Qwen3.5-0.8B-Q4_0.gguf"]}],
    },
    {
        "id": "asr-tiny", "group": "asr-tiny", "kind": "asr", "name": "Moonshine tiny", "license": "MIT", "tier": "phone",
        "asr": {"model": "onnx-community/moonshine-tiny-ONNX"},
        # 8-bit only: on phones it runs on the CPU (WebAssembly)
        "repos": [{"repo": "onnx-community/moonshine-tiny-ONNX", "keep": list(CONFIGS) + [
            "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"]}],
    },
    {
        "id": "asr-base", "group": "asr-base", "kind": "asr", "name": "Moonshine base", "license": "MIT", "tier": "desktop",
        "asr": {"model": "onnx-community/moonshine-base-ONNX"},
        "repos": [{"repo": "onnx-community/moonshine-base-ONNX", "keep": list(CONFIGS) + [
            "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx",
            "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx"]}],
    },
    {
        "id": "voice", "group": "voice", "kind": "voice", "name": "Kokoro-82M", "license": "Apache-2.0", "tier": "phone",
        "repos": [{"repo": "onnx-community/Kokoro-82M-v1.0-ONNX", "keep": ["config.json", "tokenizer.json", "tokenizer_config.json",
                                                                          "onnx/model_quantized.onnx"] + [f"voices/{v}.bin" for v in VOICES]}],
    },
    {
        "id": "voice-hq", "group": "voice-hq", "kind": "voice-hq", "name": "Kokoro-82M full precision", "license": "Apache-2.0",
        "tier": "desktop", "desktopOnly": True,
        "repos": [{"repo": "onnx-community/Kokoro-82M-v1.0-ONNX", "keep": ["onnx/model.onnx"]}],
    },
    {
        "id": "help-asr", "group": "help-asr", "kind": "help-asr", "name": "Whisper base (multilingual)", "license": "MIT",
        "tier": "phone",
        "asr": {"model": "onnx-community/whisper-base"},
        "repos": [{"repo": "onnx-community/whisper-base", "keep": list(CONFIGS) + [
            "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"]}],
    },
]


def tree(repo):
    with urllib.request.urlopen(f"{HF}/api/models/{repo}/tree/main?recursive=1", timeout=60) as r:
        return {it["path"]: it for it in json.load(r) if it.get("type") == "file"}


def lib_size(name):
    url = f"https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/{LIB_VERSION}/{name}"
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers["Content-Length"])


def main():
    out = []
    for spec in PACKS:
        pack = {k: v for k, v in spec.items() if k not in ("repos", "libs")}
        files = []
        for src in spec.get("repos", []):
            items = tree(src["repo"])
            if src["keep"] == "all":
                names = [p for p in items if not p.startswith(".") and not p.endswith(".md")]
            else:
                names = [p for p in src["keep"] if p in items]
            for p in sorted(names):
                it = items[p]
                f = {"repo": src["repo"], "path": p, "size": it.get("size", 0)}
                if it.get("lfs", {}).get("oid"):
                    f["sha256"] = it["lfs"]["oid"]
                files.append(f)
        for name in spec.get("libs", []):
            files.append({"lib": name, "path": f"libs/{name}", "size": lib_size(name)})
        pack["files"] = files
        pack["size"] = sum(f["size"] for f in files)
        out.append(pack)
        print(f"{pack['id']:<14} {len(files):>3} files  {pack['size'] / 1e6:8.1f} MB")
    doc = {
        "version": 1,
        "libVersion": LIB_VERSION,
        "sources": {
            "hf": {"models": "https://huggingface.co", "libs": f"https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/{LIB_VERSION}"},
            "mirror": {"models": "https://hf-mirror.com", "libs": f"https://cdn.jsdelivr.net/gh/mlc-ai/binary-mlc-llm-libs@main/web-llm-models/{LIB_VERSION}"},
        },
        "packs": out,
    }
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    print("wrote", os.path.relpath(OUT, ROOT))


if __name__ == "__main__":
    main()
