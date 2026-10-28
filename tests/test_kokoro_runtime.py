import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class KokoroRuntimeTests(unittest.TestCase):
    def test_cpu_bundle_and_binary_are_the_pinned_matching_build(self):
        kokoro = ROOT / "app/kokoro"
        sources = json.loads((kokoro / "ort-cpu/sources.json").read_text(encoding="utf-8"))
        version = sources["onnxRuntime"]["version"]
        lock = json.loads((ROOT / "tools/kokoro-cpu/package-lock.json").read_text(encoding="utf-8"))
        self.assertEqual(version, lock["packages"]["node_modules/onnxruntime-web"]["version"])
        for item in sources["files"]:
            with self.subTest(file=item["path"]):
                data = (kokoro / item["path"]).read_bytes()
                # Windows checkouts may expand source line endings; WASM is binary.
                if not item["path"].endswith(".wasm"):
                    data = data.replace(b"\r\n", b"\n")
                self.assertEqual(hashlib.sha256(data).hexdigest(), item["sha256"])
        bundle = (kokoro / "kokoro.web.js").read_text(encoding="utf-8")
        self.assertNotIn("ort-wasm-simd-threaded.jsep", bundle)
        self.assertIn("ort-wasm-simd-threaded.mjs", bundle)
        worker = (kokoro / "neural-tts.js").read_text(encoding="utf-8")
        self.assertIn('mod.env.wasmPaths = BASE + "ort-cpu/"', worker)
