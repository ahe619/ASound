import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from tools.build_web import ASSETS_LINE, RELEASE_LINE
from tools.prepare_model_host import DEFAULT_PACKS
from tools.prepare_soundoa_site import prepare, verify_site, publication_files, SITE_MARKER


class SoundoaPreparationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "app"
        self.source.mkdir()
        (self.root / "VERSION").write_text("0.2.1", encoding="utf-8")
        (self.root / "LICENSES.md").write_text("License notices", encoding="utf-8")
        self.put("index.html", '<script src="js/main.js"></script>')
        self.put("manifest.webmanifest", "{}")
        self.put("js/main.js", "console.log('pilot');")
        self.put("sw.js", RELEASE_LINE + "\n" + ASSETS_LINE + "\n")
        self.put("packs.json", json.dumps({"sources": {"hf": {"models": "https://hf.test", "libs": "https://libs.test"},
                                                    "mirror": {"models": "https://mirror.test", "libs": "https://mirror-libs.test"}},
                                             "packs": [{"id": name, "files": []} for name in [*DEFAULT_PACKS, "llm-4b-f16"]]}))

    def put(self, name, text):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def run_prepare(self, **kwargs):
        return prepare(project_root=self.root, **kwargs)

    def test_bundle_separates_public_assets_from_operator_instructions_and_secrets(self):
        self.put("models/weights.bin", "private weights")
        self.put(".env", "private-key")
        self.put("dev/notes.html", "private development")
        (self.root / "server.py").write_text("private source", encoding="utf-8")
        (self.root / ".venv").mkdir()
        (self.root / ".venv" / "secret.txt").write_text("private", encoding="utf-8")
        (self.root / "docs").mkdir()
        (self.root / "docs" / "SOUNDOA_LAUNCH.md").write_text("Operator launch guide", encoding="utf-8")
        result = self.run_prepare()
        with zipfile.ZipFile(result["archive"]) as archive:
            names = set(archive.namelist())
            self.assertIsNone(archive.testzip())
            self.assertIn("soundoa-site/site/index.html", names)
            self.assertIn("soundoa-site/.github/workflows/pages.yml", names)
            self.assertIn("instructions/SOUNDOA_LAUNCH.md", names)
            self.assertIn("instructions/launch-status.json", names)
            self.assertFalse(any("CNAME" in name or "models/" in name or ".env" in name or "server.py" in name
                                 or ".venv" in name or "dev/" in name or ".asound-web-build" in name
                                 or SITE_MARKER in name for name in names))
            self.assertEqual({name.split("/")[0] for name in names}, {"soundoa-site", "instructions"})
            receipt = json.loads(archive.read("instructions/launch-status.json"))
            self.assertEqual(receipt["domain"], "soundoa.cn")
            self.assertEqual(receipt["repository"], "ahe619/ASound")
            self.assertEqual(receipt["repositoryStatus"], "existing")
            self.assertEqual(receipt["statusScope"], "local_preparation_only")
            public_entries = [info for info in archive.infolist() if info.filename.startswith("soundoa-site/")]
            self.assertEqual(receipt["files"], len(public_entries))
            self.assertEqual(receipt["bytes"], sum(info.file_size for info in public_entries))
            for key in ("published", "dnsConfigured", "weightsIncluded", "customDomainConfigured", "httpsVerified"):
                self.assertFalse(receipt[key])
            version = json.loads(archive.read("soundoa-site/site/version.json"))
            self.assertEqual(receipt["release"], version["version"])
            catalogue = json.loads(archive.read("soundoa-site/site/packs.json"))
            self.assertEqual({p["id"] for p in catalogue["packs"]}, set(DEFAULT_PACKS))
            self.assertEqual(set(catalogue["sources"]), {"hf", "mirror"})
            self.assertNotIn("defaultSource", catalogue)
            workflow = archive.read("soundoa-site/.github/workflows/pages.yml").decode()
            self.assertIn("path: site\n", workflow)
            self.assertNotIn("path: .\n", workflow)
            self.assertIn("name: github-pages", workflow)
            self.assertIn("pages: write", workflow)
            self.assertIn("id-token: write", workflow)
            self.assertNotIn("soundoa.cn", workflow)
        self.assertEqual(result["files"], len(list(publication_files(Path(result["output"])))))
        self.assertEqual(result["verifiedAssets"], len(verify_site(Path(result["output"]) / "site")))

    def test_unowned_output_or_instructions_are_never_replaced(self):
        for name, parameter in (("custom-site", "output"), ("custom-notes", "release_dir")):
            with self.subTest(name=name):
                target = self.root / name
                target.mkdir()
                keep = target / "user.txt"
                keep.write_text("keep", encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.run_prepare(**{parameter: target})
                self.assertEqual(keep.read_text(), "keep")

    def test_unsafe_or_overlapping_targets_are_rejected(self):
        for target in (self.root, self.root.parent, self.source, self.source / "release"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                self.run_prepare(output=target)
        output = self.root / "dist" / "output"
        with self.assertRaises(ValueError):
            self.run_prepare(output=output, release_dir=output / "instructions")
        with self.assertRaises(ValueError):
            self.run_prepare(output=output, archive_path=output / "release.zip")

    def test_unowned_archive_is_not_replaced(self):
        archive = self.root / "existing.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("original.txt", "keep this existing archive")
        previous = archive.read_bytes()
        with self.assertRaisesRegex(ValueError, "unowned ZIP"):
            self.run_prepare(archive_path=archive)
        self.assertEqual(archive.read_bytes(), previous)

    def test_previous_standalone_preparation_can_be_rebuilt_for_existing_repository(self):
        first = self.run_prepare()
        archive_path = Path(first["archive"])
        with zipfile.ZipFile(archive_path) as archive:
            entries = {name: archive.read(name) for name in archive.namelist()}
        receipt = json.loads(entries["instructions/launch-status.json"])
        receipt["repository"] = "ahe619/soundoa-site"
        receipt["repositoryStatus"] = "planned"
        entries["instructions/launch-status.json"] = json.dumps(receipt).encode()
        with zipfile.ZipFile(archive_path, "w") as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        rebuilt = self.run_prepare()
        self.assertEqual(rebuilt["repository"], "ahe619/ASound")
        self.assertEqual(rebuilt["repositoryStatus"], "existing")
        self.assertFalse(rebuilt["published"])

    def test_symlinked_output_is_rejected(self):
        target = self.root / "linked-output"
        outside = self.root / "outside"
        outside.mkdir()
        try:
            target.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("Filesystem does not permit symlink creation")
        with self.assertRaisesRegex(ValueError, "Linked"):
            self.run_prepare(output=target)
        self.assertEqual(list(outside.iterdir()), [])

    def test_junction_output_detection(self):
        target = self.root / "junction-output"
        with patch.object(Path, "is_junction", lambda path: path == target, create=True), self.assertRaisesRegex(ValueError, "Linked"):
            self.run_prepare(output=target)

    def test_failed_build_preserves_previous_release_and_zip(self):
        first = self.run_prepare()
        archive = Path(first["archive"])
        original_zip = archive.read_bytes()
        original_receipt = (Path(first["instructions"]) / "launch-status.json").read_bytes()
        (self.source / "packs.json").unlink()
        with self.assertRaises(ValueError):
            self.run_prepare()
        self.assertEqual(archive.read_bytes(), original_zip)
        self.assertEqual((Path(first["instructions"]) / "launch-status.json").read_bytes(), original_receipt)
        self.assertEqual(json.loads((Path(first["output"]) / "site" / "version.json").read_text())["version"], first["release"])

    def test_failed_final_swap_rolls_back_site_instructions_and_zip(self):
        first = self.run_prepare()
        previous = Path(first["archive"]).read_bytes()
        self.put("js/main.js", "console.log('new release');")
        real_rename = Path.rename

        def fail_archive_swap(path, destination):
            if path.name.startswith(".soundoa-zip-"):
                raise OSError("simulated archive move failure")
            return real_rename(path, destination)

        with patch.object(Path, "rename", autospec=True, side_effect=fail_archive_swap), self.assertRaisesRegex(OSError, "simulated"):
            self.run_prepare()
        self.assertEqual(Path(first["archive"]).read_bytes(), previous)
        version = json.loads((Path(first["output"]) / "site" / "version.json").read_text())
        receipt = json.loads((Path(first["instructions"]) / "launch-status.json").read_text())
        self.assertEqual(version["version"], first["release"])
        self.assertEqual(receipt["release"], first["release"])
        self.assertFalse(any(path.name.startswith(".soundoa-") for path in (self.root / "dist").iterdir()))

    def test_secret_shaped_files_in_allowed_source_directories_block_publication(self):
        self.put("vendor/credentials.json", '{"token":"do-not-publish"}')
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            self.run_prepare()
        self.assertFalse((self.root / "dist" / "soundoa-site").exists())

    def test_test_payloads_are_not_accepted_in_vendor_tree(self):
        self.put("vendor/tests/fixture.json", '{"test":"private"}')
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            self.run_prepare()

    def test_generated_manifest_tampering_is_rejected_before_replacing_previous_release(self):
        first = self.run_prepare()
        original = Path(first["archive"]).read_bytes()
        from tools import prepare_soundoa_site as module
        real_build = module.build

        def corrupt(*args, **kwargs):
            result = real_build(*args, **kwargs)
            (Path(args[1]) / "js" / "main.js").write_text("corrupt", encoding="utf-8")
            return result

        with patch.object(module, "build", side_effect=corrupt), self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.run_prepare()
        self.assertEqual(Path(first["archive"]).read_bytes(), original)

    def test_service_worker_tampering_is_rejected(self):
        from tools import prepare_soundoa_site as module
        real_build = module.build

        def corrupt(*args, **kwargs):
            result = real_build(*args, **kwargs)
            worker = Path(args[1]) / "sw.js"
            worker.write_text(worker.read_text(encoding="utf-8") + "\n// tampered\n", encoding="utf-8")
            return result

        with patch.object(module, "build", side_effect=corrupt), self.assertRaisesRegex(ValueError, "release hash mismatch"):
            self.run_prepare()

    def test_rebuild_refreshes_artifacts_and_retains_web_marker_locally_only(self):
        first = self.run_prepare()
        self.put("js/main.js", "console.log('updated');")
        second = self.run_prepare()
        self.assertNotEqual(first["release"], second["release"])
        self.assertTrue((Path(second["output"]) / "site" / ".asound-web-build").is_file())
        self.assertFalse(any(path.name.startswith(".soundoa-") for path in (self.root / "dist").iterdir()))


if __name__ == "__main__":
    unittest.main()
