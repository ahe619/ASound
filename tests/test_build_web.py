import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tools.build_web import ASSETS_LINE, RELEASE_LINE, build, validate_model_base_url


class WebBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / "app"
        self.app.mkdir()
        self.out = self.root / "web"
        self.put("index.html", '<script src="js/main.js"></script>')
        self.put("manifest.webmanifest", "{}")
        self.put("packs.json", "{}")
        self.put("js/main.js", "console.log('one');")
        self.put("locales/feat/phone.json", '{"en": {}, "zh": {}}')
        self.put("sw.js", RELEASE_LINE + "\n" + ASSETS_LINE + "\n// worker\n")

    def put(self, name, text):
        path = self.app / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_manifest_is_complete_and_hashes_published_bytes(self):
        self.put("models/weights.bin", "never publish weights")
        self.put("dev/demo.html", "never publish test pages")
        self.put("vendor/engine.wasm", "wasm bytes")
        self.put("vendor/LICENSE.txt", "license notice")
        self.put("audio/voices/af_heart.wav", "audio bytes")
        self.put("repair.html", "<!doctype html><title>Check updates</title>")
        self.put("voice-check.html", "<!doctype html><title>Check speech</title>")
        self.put("vocabulary/words.json", '{"schemaVersion":1,"words":[]}')
        self.put("vocabulary/LICENSE-ECDICT.txt", "dictionary license")
        self.put(".env", "never publish secrets")
        result = build(self.app, self.out, "0.2.0")
        worker = (self.out / "sw.js").read_text(encoding="utf-8")
        line = next(line for line in worker.splitlines() if line.startswith("const ASSETS = "))
        assets = json.loads(line.removeprefix("const ASSETS = ").split("; // @asound-assets")[0])
        urls = {item["url"] for item in assets}
        self.assertIn("vendor/engine.wasm", urls)
        self.assertIn("locales/feat/phone.json", urls)
        self.assertIn("vocabulary/words.json", urls)
        self.assertIn("vocabulary/LICENSE-ECDICT.txt", urls)
        self.assertIn("version.json", urls)
        self.assertIn("audio/voices/af_heart.wav", urls)
        self.assertIn("repair.html", urls)
        self.assertIn("voice-check.html", urls)
        self.assertNotIn("sw.js", urls)
        self.assertFalse((self.out / "models").exists())
        self.assertFalse((self.out / "dev").exists())
        self.assertFalse((self.out / ".env").exists())
        for item in assets:
            self.assertEqual(item["sha256"], hashlib.sha256((self.out / item["url"]).read_bytes()).hexdigest())
        self.assertEqual(json.loads((self.out / "version.json").read_text())["version"], result["version"])
        # Runtimes are cached on first use; the app shell and word lists are installed up front.
        lazy = {item["url"] for item in assets if item.get("lazy")}
        self.assertIn("vendor/engine.wasm", lazy)
        self.assertIn("audio/voices/af_heart.wav", lazy)
        self.assertNotIn("js/main.js", lazy)
        self.assertNotIn("vocabulary/words.json", lazy)

    def test_reproducible_and_changes_version_for_asset_or_worker_edits(self):
        first = build(self.app, self.out, "0.2.0")["version"]
        self.assertEqual(first, build(self.app, self.out, "0.2.0")["version"])
        self.put("js/main.js", "console.log('two');")
        second = build(self.app, self.out, "0.2.0")["version"]
        self.assertNotEqual(first, second)
        self.put("sw.js", RELEASE_LINE + "\n" + ASSETS_LINE + "\n// changed worker\n")
        self.assertNotEqual(second, build(self.app, self.out, "0.2.0")["version"])

    def test_refuses_source_or_unowned_output(self):
        for output in (self.app, self.app / "dist", self.root):
            with self.assertRaises(ValueError):
                build(self.app, output, "0.2.0")
        self.out.mkdir()
        keep = self.out / "user.txt"
        keep.write_text("keep")
        with self.assertRaises(ValueError):
            build(self.app, self.out, "0.2.0")
        self.assertEqual(keep.read_text(), "keep")

    def test_failed_build_preserves_previous_output(self):
        first = build(self.app, self.out, "0.2.0")["version"]
        (self.app / "packs.json").unlink()
        with self.assertRaises(ValueError):
            build(self.app, self.out, "0.2.1")
        self.assertEqual(json.loads((self.out / "version.json").read_text())["version"], first)

    def test_missing_worker_marker_or_invalid_version_rejected(self):
        with self.assertRaises(ValueError):
            build(self.app, self.out, "bad/version")
        self.put("sw.js", "// no markers")
        with self.assertRaises(ValueError):
            build(self.app, self.out, "0.2.0")

    def test_self_hosted_model_configuration_is_hashed_without_editing_source(self):
        original = {"sources": {"hf": {"models": "https://huggingface.co", "libs": "https://example.com/libs"}}, "packs": [{"id": "example"}]}
        self.put("packs.json", json.dumps(original))
        original_version = build(self.app, self.out, "0.2.0")["version"]
        result = build(self.app, self.out, "0.2.0", model_base_url="https://models.example.com/asound/v1/")
        published = json.loads((self.out / "packs.json").read_text())
        self.assertEqual(published["sources"], {"deployment": {"models": "https://models.example.com/asound/v1", "libs": "https://models.example.com/asound/v1/libs"}})
        self.assertEqual(published["defaultSource"], "deployment")
        self.assertEqual(published["packs"], original["packs"])
        self.assertEqual(json.loads((self.app / "packs.json").read_text()), original)
        self.assertNotEqual(original_version, result["version"])
        worker = (self.out / "sw.js").read_text()
        self.assertIn(hashlib.sha256((self.out / "packs.json").read_bytes()).hexdigest(), worker)
        self.assertEqual(result["version"], build(self.app, self.out, "0.2.0", model_base_url="https://models.example.com/asound/v1")["version"])

    def test_invalid_model_url_preserves_previous_build(self):
        first = build(self.app, self.out, "0.2.0")["version"]
        urls = ["", "http://models.example.com", "file:///models", "https://user:secret@example.com/models",
                "https://example.com/models?token=secret", "https://example.com/models#part",
                "https://example.com/../models", "https://example.com/%2e%2e/models", "https://example.com/%252e%252e/models",
                "https://example.com/models\\bad", "https://example.com/model%5cbad", "https://example.com/bad%0aheader",
                " https://example.com", "https://", "https://example.com:bad", "http://localhost.example.com/models"]
        for url in urls:
            with self.subTest(url=url), self.assertRaises(ValueError):
                build(self.app, self.out, "0.2.1", model_base_url=url)
        self.assertEqual(json.loads((self.out / "version.json").read_text())["version"], first)

    def test_local_http_model_host_is_allowed_for_preview(self):
        for url in ("http://localhost:8783/models", "http://127.0.0.1:8783", "http://[::1]:8783/models"):
            self.assertEqual(validate_model_base_url(url + "/"), url)

    def test_pack_selection_hides_models_that_are_not_uploaded(self):
        original = {"sources": {"hf": {"models": "https://huggingface.co", "libs": "https://example.com/libs"}}, "packs": [{"id": "small"}, {"id": "large"}, {"id": "voice"}]}
        self.put("packs.json", json.dumps(original))
        build(self.app, self.out, "0.2.0", model_base_url="https://models.example.com", model_packs="small, voice")
        published = json.loads((self.out / "packs.json").read_text())
        self.assertEqual([p["id"] for p in published["packs"]], ["small", "voice"])
        self.assertEqual(published["defaultSource"], "deployment")
        self.assertEqual(json.loads((self.app / "packs.json").read_text()), original)
        version = json.loads((self.out / "version.json").read_text())["version"]
        for choice in ("", "small,", "unknown", []):
            with self.subTest(choice=choice), self.assertRaises(ValueError):
                build(self.app, self.out, "0.2.1", model_packs=choice)
        self.assertEqual(json.loads((self.out / "version.json").read_text())["version"], version)

    def test_pack_selection_without_host_keeps_original_sources(self):
        original = {"sources": {"hf": {"models": "https://huggingface.co", "libs": "https://example.com/libs"}}, "packs": [{"id": "small"}, {"id": "large"}]}
        self.put("packs.json", json.dumps(original))
        build(self.app, self.out, "0.2.0", model_packs=["small"])
        published = json.loads((self.out / "packs.json").read_text())
        self.assertEqual(published["sources"], original["sources"])
        self.assertNotIn("defaultSource", published)


if __name__ == "__main__":
    unittest.main()
