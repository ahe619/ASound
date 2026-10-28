import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from tools.build_web import ASSETS_LINE, RELEASE_LINE, VOICE_RUNTIME_ASSETS, build
from tools.prepare_download_mirror import NOTICES, prepare
from tools.prepare_web_voice import REPOSITORY


class DownloadMirrorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.app, self.site, self.output = [self.root / name for name in ("app", "site", "mirror")]
        self.app.mkdir()
        payload = {"config.json": b"{}", "onnx/model_quantized.onnx": b"q8-model", "voices/af_heart.bin": b"voice"}
        self.lock = {"schemaVersion": 1, "repository": REPOSITORY, "revision": "1" * 40, "license": "Apache-2.0",
                     "files": [{"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in payload.items()]}
        patcher = patch("tools.prepare_web_voice.load_manifest", return_value=self.lock)
        patcher.start()
        self.addCleanup(patcher.stop)
        catalog = {"sources": {"hf": {"models": "https://example.com"}},
                   "packs": [{"id": "voice", "kind": "voice", "files": [{"repo": REPOSITORY, **f} for f in self.lock["files"]]}]}
        for name, data in payload.items():
            self.put(f"models/{REPOSITORY}/{name}", data)
        for name in VOICE_RUNTIME_ASSETS | (NOTICES - {"voice-models.json", "LICENSES.md"}):
            self.put(name, ("fixture " + name).encode())
        self.put("audio/voices/af_heart.wav", b"preview")
        self.put("js/main.js", b"app source, must not be mirrored")
        self.put("vendor/transformers/other.wasm", b"ASR, must not be mirrored")
        self.put("audio/other.wav", b"other audio")
        self.put(".env", b"SECRET=excluded")
        self.put("index.html", b"<html>app</html>")
        self.put("manifest.webmanifest", b"{}")
        self.put("packs.json", json.dumps(catalog).encode())
        self.put("sw.js", (RELEASE_LINE + "\n" + ASSETS_LINE + "\n").encode())
        self.license = self.root / "LICENSES.md"
        self.license.write_text("License notice")
        self.build()

    def put(self, name, content):
        path = self.app / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def build(self, **kwargs):
        return build(self.app, self.site, "0.3.5", license_file=self.license, with_web_voice=True, **kwargs)

    def test_voice_only_package_has_matching_paths_hashes_and_notices_without_a_domain(self):
        result = prepare(self.site, self.output)
        receipt = json.loads((self.output / "manifest.json").read_text())
        self.assertFalse(receipt["uploaded"])
        self.assertFalse(receipt["mainlandNetworkTested"])
        self.assertNotIn("downloadBases", json.loads((self.site / "packs.json").read_text()))
        with zipfile.ZipFile(result["archive"]) as bundle:
            self.assertIsNone(bundle.testzip())
            self.assertEqual(set(bundle.namelist()), {entry["url"] for entry in receipt["files"]})
            self.assertEqual(len(bundle.namelist()), len(self.lock["files"]) + len(VOICE_RUNTIME_ASSETS) + len(NOTICES) + 1)
            for entry in receipt["files"]:
                data = bundle.read(entry["url"])
                self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"])
                self.assertEqual(len(data), entry["size"])
                self.assertEqual(data, (self.site / entry["source"]).read_bytes())
                self.assertEqual(data, (self.output / "payload" / entry["url"]).read_bytes())
                if entry["kind"] in ("runtime", "preview"):
                    self.assertEqual(entry["url"], f"assets/{entry['sha256']}/{entry['source']}")
                else:
                    self.assertEqual(entry["url"], entry["source"])
            self.assertFalse(any(name.endswith(("main.js", "other.wasm", "other.wav", ".env")) for name in bundle.namelist()))
        self.assertEqual(result["bytes"], sum(entry["size"] for entry in receipt["files"]))
        self.assertEqual(receipt["archiveSha256"], hashlib.sha256(Path(result["archive"]).read_bytes()).hexdigest())

    def test_configured_mirror_urls_point_to_the_same_upload_objects(self):
        self.build(download_bases=["https://downloads.example.com/asound"])
        prepare(self.site, self.output)
        from tools.prepare_soundoa_site import verify_site
        for asset in verify_site(self.site):
            if asset.get("mirrors"):
                relative = asset["mirrors"][0].removeprefix("https://downloads.example.com/asound/")
                self.assertTrue((self.output / "payload" / relative).is_file())
        catalog = json.loads((self.site / "packs.json").read_text())
        self.assertTrue((self.output / "payload" / catalog["voiceSource"]["models"]).is_dir())

    def test_windows_and_linux_runtime_text_produce_identical_upload_keys(self):
        text_names = {name for name in VOICE_RUNTIME_ASSETS if Path(name).suffix in {".js", ".mjs", ".json"}}
        binary_names = (VOICE_RUNTIME_ASSETS - text_names) | {"audio/voices/af_heart.wav"}
        for name in text_names:
            self.put(name, b"first line\r\nsecond line\r\n")
        for name in binary_names:
            self.put(name, b"binary\x00\r\nunchanged")
        self.build()
        prepare(self.site, self.output)
        windows = json.loads((self.output / "manifest.json").read_text())
        keys_before = {entry["source"]: entry["url"] for entry in windows["files"] if entry["kind"] != "notice"}
        for name in text_names:
            self.assertEqual((self.app / name).read_bytes(), b"first line\r\nsecond line\r\n")
            self.assertEqual((self.site / name).read_bytes(), b"first line\nsecond line\n")
            self.put(name, b"first line\nsecond line\n")
        self.build(download_bases=["https://downloads.example.com"])
        prepare(self.site, self.output)
        linux = json.loads((self.output / "manifest.json").read_text())
        keys_after = {entry["source"]: entry["url"] for entry in linux["files"] if entry["kind"] != "notice"}
        self.assertEqual(keys_before, keys_after)
        for name in binary_names:
            self.assertEqual((self.site / name).read_bytes(), b"binary\x00\r\nunchanged")

    def test_corrupt_model_or_runtime_preserves_previous_package(self):
        prepare(self.site, self.output)
        previous = (self.output / "upload.zip").read_bytes()
        for path in (next((self.site / "voice-models").rglob("*.onnx")), self.site / "kokoro/neural-tts.js"):
            original = path.read_bytes()
            path.write_bytes(b"bad")
            with self.assertRaises(ValueError):
                prepare(self.site, self.output)
            self.assertEqual((self.output / "upload.zip").read_bytes(), previous)
            path.write_bytes(original)

    def test_rejects_release_without_hosted_voice_or_missing_licenses(self):
        build(self.app, self.site, "0.3.5", license_file=self.license)
        with self.assertRaisesRegex(ValueError, "with-web-voice"):
            prepare(self.site, self.output)
        (self.app / "kokoro/KOKORO-MODEL-LICENSE.txt").unlink()
        self.build()
        with self.assertRaisesRegex(ValueError, "license"):
            prepare(self.site, self.output)

    def test_unowned_and_overlapping_outputs_are_never_replaced(self):
        self.output.mkdir()
        keep = self.output / "my.zip"
        keep.write_bytes(b"mine")
        for target in (self.output, self.root, self.site, self.site / "mirror"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                prepare(self.site, target)
        self.assertEqual(keep.read_bytes(), b"mine")

    def test_symlinked_source_or_output_is_rejected(self):
        linked = self.root / "link"
        try:
            linked.symlink_to(self.site, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("Filesystem does not permit symlink creation")
        with self.assertRaisesRegex(ValueError, "Linked"):
            prepare(linked, self.output)
        with self.assertRaisesRegex(ValueError, "Linked"):
            prepare(self.site, linked)

    def test_junction_inside_release_is_rejected(self):
        asset = self.site / "kokoro"
        with patch.object(Path, "is_junction", lambda path: path == asset, create=True):
            with self.assertRaisesRegex(ValueError, "Linked"):
                prepare(self.site, self.output)

    def test_source_changed_during_copy_is_rejected_and_old_package_survives(self):
        prepare(self.site, self.output)
        previous = (self.output / "upload.zip").read_bytes()
        from tools import prepare_download_mirror as module
        real_copy = module.shutil.copyfile
        def corrupt(original, target):
            real_copy(original, target)
            Path(target).write_bytes(b"changed during copy")
        with patch.object(module.shutil, "copyfile", side_effect=corrupt):
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                prepare(self.site, self.output)
        self.assertEqual((self.output / "upload.zip").read_bytes(), previous)

    def test_failed_final_swap_restores_previous_output(self):
        prepare(self.site, self.output)
        previous = (self.output / "upload.zip").read_bytes()
        real_rename = Path.rename
        def fail_stage(path, destination):
            if path.name.startswith(".asound-mirror-") and not path.name.startswith(".asound-mirror-backup-"):
                raise OSError("simulated final swap failure")
            return real_rename(path, destination)
        with patch.object(Path, "rename", autospec=True, side_effect=fail_stage):
            with self.assertRaisesRegex(OSError, "simulated"):
                prepare(self.site, self.output)
        self.assertEqual((self.output / "upload.zip").read_bytes(), previous)
        self.assertFalse(any(path.name.startswith(".asound-mirror-") for path in self.root.iterdir()))


if __name__ == "__main__":
    unittest.main()
