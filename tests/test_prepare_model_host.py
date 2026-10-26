import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tools.prepare_model_host import make_manifest, prepare


class ModelHostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog_path = self.root / "packs.json"
        self.output = self.root / "host"
        self.models = self.root / "models"
        self.models.mkdir()
        self.catalog = {
            "version": 1,
            "sources": {
                "hf": {"models": "https://huggingface.co", "libs": "https://raw.example.com/base"},
                "mirror": {"models": "https://hf-mirror.com", "libs": "https://cdn.example.com/base"},
            },
            "packs": [{"id": "llm-test", "files": [
                {"repo": "org/model", "path": "config.json", "size": 2},
                {"repo": "org/model", "path": "onnx/weights.bin", "size": 5, "sha256": hashlib.sha256(b"model").hexdigest()},
                {"lib": "runtime.wasm", "path": "libs/runtime.wasm", "size": 4},
            ]}],
        }
        self.write_catalog()

    def write_catalog(self):
        self.catalog_path.write_text(json.dumps(self.catalog), encoding="utf-8")

    def seed_models(self):
        for relative, body in {"org/model/config.json": b"{}", "org/model/onnx/weights.bin": b"model", "libs/runtime.wasm": b"wasm"}.items():
            file = self.models / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(body)

    def run_prepare(self, source=None, out=None):
        return prepare(self.catalog_path, out or self.output, ["llm-test"], source)

    def test_manifest_only_does_not_claim_to_include_models(self):
        result = self.run_prepare()
        self.assertFalse(result["readyForUpload"])
        self.assertEqual(result["totalBytes"], 11)
        self.assertEqual(result["verifiedBytes"], 0)
        self.assertTrue(all(f["status"] == "not_checked" for f in result["files"]))
        self.assertEqual({p.name for p in self.output.iterdir()}, {"model-manifest.json", ".asound-model-host"})
        files = {entry["path"]: entry for entry in result["files"]}
        model = files["org/model/resolve/main/onnx/weights.bin"]
        self.assertEqual(model["sourcePath"], "org/model/onnx/weights.bin")
        self.assertEqual(model["urls"]["mirror"], "https://hf-mirror.com/org/model/resolve/main/onnx/weights.bin")
        self.assertEqual(files["libs/runtime.wasm"]["urls"]["hf"], "https://raw.example.com/base/runtime.wasm")

    def test_verified_files_are_copied_to_public_layout(self):
        self.seed_models()
        result = self.run_prepare(self.models)
        self.assertTrue(result["readyForUpload"])
        self.assertTrue(all(f["status"] == "copied" for f in result["files"]))
        self.assertEqual((self.output / "org/model/resolve/main/onnx/weights.bin").read_bytes(), b"model")
        self.assertEqual((self.output / "libs/runtime.wasm").read_bytes(), b"wasm")
        for item in result["files"]:
            self.assertEqual(item["localSha256"], hashlib.sha256((self.output / item["path"]).read_bytes()).hexdigest())

    def test_missing_wrong_size_and_same_size_bad_hash_are_not_copied(self):
        self.seed_models()
        (self.models / "org/model/config.json").unlink()
        (self.models / "org/model/onnx/weights.bin").write_bytes(b"other")
        (self.models / "libs/runtime.wasm").write_bytes(b"short")
        result = self.run_prepare(self.models)
        self.assertFalse(result["readyForUpload"])
        self.assertEqual({f["status"] for f in result["files"]}, {"missing", "invalid_size", "invalid_sha256"})
        self.assertFalse((self.output / "libs").exists())

    def test_incomplete_input_preserves_previous_distribution(self):
        self.seed_models()
        self.run_prepare(self.models)
        original = (self.output / "model-manifest.json").read_bytes()
        (self.models / "org/model/config.json").unlink()
        with self.assertRaises(ValueError):
            self.run_prepare(self.models)
        self.assertEqual((self.output / "model-manifest.json").read_bytes(), original)
        self.assertEqual((self.output / "org/model/resolve/main/config.json").read_bytes(), b"{}")

    def test_manifest_only_run_preserves_prepared_model_files(self):
        self.seed_models()
        self.run_prepare(self.models)
        with self.assertRaises(ValueError):
            self.run_prepare()
        self.assertEqual((self.output / "org/model/resolve/main/config.json").read_bytes(), b"{}")

    def test_shared_paths_are_deduplicated_and_conflicts_rejected(self):
        self.catalog["packs"].append({"id": "also", "files": [dict(self.catalog["packs"][0]["files"][0])]})
        result = make_manifest(self.catalog, ["llm-test", "also"])
        self.assertEqual(result["fileCount"], 3)
        self.assertEqual(next(f for f in result["files"] if f["path"].endswith("config.json"))["packs"], ["llm-test", "also"])
        self.catalog["packs"][1]["files"][0]["size"] = 3
        with self.assertRaises(ValueError):
            make_manifest(self.catalog, ["llm-test", "also"])

    def test_unsafe_paths_and_unknown_packs_are_rejected(self):
        with self.assertRaises(ValueError):
            make_manifest(self.catalog, ["not-a-pack"])
        for path in ("../escape", "/absolute", "C:/outside", "bad\\path", "%2e%2e/escape", "normal/../escape"):
            self.catalog["packs"][0]["files"][0]["path"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                make_manifest(self.catalog, ["llm-test"])

    def test_comma_separated_selection_and_empty_selection(self):
        self.assertEqual(make_manifest(self.catalog, "llm-test,llm-test")["packs"], ["llm-test"])
        for choice in ("", [], "llm-test,"):
            with self.subTest(choice=choice), self.assertRaises(ValueError):
                make_manifest(self.catalog, choice)

    def test_unowned_output_and_source_overlap_are_preserved(self):
        self.output.mkdir()
        (self.output / "keep.txt").write_text("keep")
        with self.assertRaises(ValueError):
            self.run_prepare()
        self.assertEqual((self.output / "keep.txt").read_text(), "keep")
        for output in (self.models, self.models / "child", self.root):
            with self.assertRaises(ValueError):
                self.run_prepare(self.models, output)


if __name__ == "__main__":
    unittest.main()
