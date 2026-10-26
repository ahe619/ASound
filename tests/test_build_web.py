import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tools.build_web import ASSETS_LINE, RELEASE_LINE, build


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
        self.put(".env", "never publish secrets")
        result = build(self.app, self.out, "0.2.0")
        worker = (self.out / "sw.js").read_text(encoding="utf-8")
        line = next(line for line in worker.splitlines() if line.startswith("const ASSETS = "))
        assets = json.loads(line.removeprefix("const ASSETS = ").split("; // @asound-assets")[0])
        urls = {item["url"] for item in assets}
        self.assertIn("vendor/engine.wasm", urls)
        self.assertIn("locales/feat/phone.json", urls)
        self.assertIn("version.json", urls)
        self.assertNotIn("sw.js", urls)
        self.assertFalse((self.out / "models").exists())
        self.assertFalse((self.out / "dev").exists())
        self.assertFalse((self.out / ".env").exists())
        for item in assets:
            self.assertEqual(item["sha256"], hashlib.sha256((self.out / item["url"]).read_bytes()).hexdigest())
        self.assertEqual(json.loads((self.out / "version.json").read_text())["version"], result["version"])

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


if __name__ == "__main__":
    unittest.main()
