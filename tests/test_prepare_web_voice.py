import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from tools.build_web import ASSETS_LINE, RELEASE_LINE, build
from tools.prepare_model_host import DEFAULT_PACKS
from tools.prepare_soundoa_site import prepare, verify_site
from tools.prepare_web_voice import REPOSITORY, load_manifest, version_of


class BrowserVoiceHostingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.app = self.root / "app"
        self.app.mkdir()
        self.site = self.root / "site"
        self.payload = {"config.json": b'{"model_type":"kokoro"}', "onnx/model_quantized.onnx": b"q8-model", "voices/af_heart.bin": b"voice-vector"}
        self.lock = {"schemaVersion": 1, "repository": REPOSITORY, "revision": "1" * 40, "license": "Apache-2.0",
                     "files": [{"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in self.payload.items()]}
        self.patch = patch("tools.prepare_web_voice.load_manifest", return_value=self.lock)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.catalog = {"sources": {"hf": {"models": "https://example.test/models", "libs": "https://example.test/libs"}},
                        "packs": [{"id": name, "files": []} for name in DEFAULT_PACKS if name != "voice"] +
                        [{"id": "voice", "kind": "voice", "files": [{"repo": REPOSITORY, **entry} for entry in self.lock["files"]]}]}
        for name, data in self.payload.items():
            self.write(f"models/{REPOSITORY}/{name}", data)
        self.write("index.html", b"<html>ASound</html>")
        self.write("manifest.webmanifest", b"{}")
        self.write("packs.json", json.dumps(self.catalog).encode())
        self.write("sw.js", (RELEASE_LINE + "\n" + ASSETS_LINE + "\n").encode())
        (self.root / "VERSION").write_text("0.3.0")
        (self.root / "LICENSES.md").write_text("Kokoro weights: Apache-2.0")

    def write(self, name, data):
        target = self.app / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def test_optional_voice_is_hashed_but_not_precached_and_other_models_are_excluded(self):
        self.write(f"models/{REPOSITORY}/onnx/model.onnx", b"large desktop-only model")
        self.write("models/private/secret.bin", b"not allowed")
        result = build(self.app, self.site, "0.3.0", with_web_voice=True)
        assets = verify_site(self.site)
        names = {asset["url"] for asset in assets}
        self.assertIn("voice-models.json", names)
        self.assertFalse(any(name.startswith("voice-models/") for name in names))
        self.assertEqual(result["optionalVoiceFiles"], 3)
        catalog = json.loads((self.site / "packs.json").read_text())
        self.assertEqual(catalog["sources"], self.catalog["sources"])
        self.assertEqual(catalog["voiceSource"]["version"], version_of(self.lock))
        self.assertEqual(len(list((self.site / "voice-models").rglob("*.onnx"))), 1)
        self.assertFalse((self.site / "models").exists())
        self.assertFalse(any(p.name == "secret.bin" for p in self.site.rglob("*")))

    def test_verifier_rejects_tampered_optional_payload_and_unlisted_files(self):
        build(self.app, self.site, "0.3.0", with_web_voice=True)
        model = next((self.site / "voice-models").rglob("*.onnx"))
        model.write_bytes(b"bad-data")
        with self.assertRaisesRegex(ValueError, "checksum"):
            verify_site(self.site)
        model.write_bytes(self.payload["onnx/model_quantized.onnx"])
        (model.parent / "model.onnx").write_bytes(b"extra")
        with self.assertRaisesRegex(ValueError, "outside"):
            verify_site(self.site)

    def test_bad_local_model_leaves_previous_release_intact(self):
        baseline = build(self.app, self.site, "0.3.0")
        self.write(f"models/{REPOSITORY}/onnx/model_quantized.onnx", b"corrupted")
        with self.assertRaisesRegex(ValueError, "checksum"):
            build(self.app, self.site, "0.3.1", with_web_voice=True)
        self.assertEqual(json.loads((self.site / "version.json").read_text())["version"], baseline["version"])

    def test_missing_files_require_explicit_download_and_downloads_are_verified(self):
        model = self.app / "models" / REPOSITORY / "onnx/model_quantized.onnx"
        model.unlink()
        with patch("tools.prepare_web_voice.download_file") as download:
            with self.assertRaisesRegex(ValueError, "checksum"):
                build(self.app, self.site, "0.3.0", with_web_voice=True)
            download.assert_not_called()
        def fetch(target, item, lock):
            self.assertEqual(lock["revision"], self.lock["revision"])
            target.write_bytes(b"invalid")
        with patch("tools.prepare_web_voice.download_file", side_effect=fetch):
            with self.assertRaisesRegex(ValueError, "checksum"):
                build(self.app, self.site, "0.3.0", download_web_voice=True)

    def test_zip_includes_only_verified_optional_voice_and_records_its_presence(self):
        result = prepare(project_root=self.root, with_web_voice=True)
        self.assertTrue(result["weightsIncluded"])
        self.assertEqual(result["optionalVoiceFiles"], 3)
        with zipfile.ZipFile(result["archive"]) as bundle:
            names = bundle.namelist()
            models = [name for name in names if "/voice-models/" in name]
            self.assertEqual(len(models), 3)
            self.assertIn("optional", bundle.read("soundoa-site/README.md").decode())
            self.assertIn("101 MB", bundle.read("instructions/README.txt").decode())

    def test_mirror_configuration_keeps_voice_identity_and_model_hashes(self):
        baseline = build(self.app, self.site, "0.3.0", with_web_voice=True)
        previous = json.loads((self.site / "packs.json").read_text())
        manifest = (self.site / "voice-models.json").read_bytes()
        result = prepare(project_root=self.root, with_web_voice=True,
                         download_bases=["https://downloads.example.com/voice/"])
        hosted = Path(result["output"]) / "site"
        published = json.loads((hosted / "packs.json").read_text())
        self.assertEqual(published["voiceSource"], previous["voiceSource"])
        self.assertEqual(published["packs"], previous["packs"])
        self.assertEqual((hosted / "voice-models.json").read_bytes(), manifest)
        self.assertEqual(published["downloadBases"], ["https://downloads.example.com/voice"])
        self.assertNotEqual(result["release"], baseline["version"])
        verify_site(hosted)


class VoiceLockTests(unittest.TestCase):
    def test_checked_in_lock_covers_real_mobile_catalog_exactly(self):
        lock = load_manifest()
        root = Path(__file__).resolve().parents[1]
        voice = next(p for p in json.loads((root / "app/packs.json").read_text(encoding="utf-8"))["packs"] if p["id"] == "voice")
        self.assertEqual(len(lock["files"]), 20)
        self.assertEqual(sum(f["size"] for f in lock["files"]), voice["size"])
        self.assertEqual({f["path"] for f in lock["files"]}, {f["path"] for f in voice["files"]})
        self.assertTrue(all("model.onnx" != f["path"].split("/")[-1] for f in lock["files"]))


if __name__ == "__main__":
    unittest.main()
