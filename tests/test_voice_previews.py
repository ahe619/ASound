import hashlib
import json
from pathlib import Path
import re
import unittest
import wave

ROOT = Path(__file__).resolve().parents[1]


class VoicePreviewTests(unittest.TestCase):
    def test_named_voices_have_small_valid_recordings_with_pinned_hashes(self):
        source = (ROOT / "app/js/speech.js").read_text(encoding="utf-8")
        voices = set(re.findall(r'\bid: "((?:af|am)_[a-z]+)"', source))
        manifest = json.loads((ROOT / "tools/voice_previews_manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(voices, {item["voice"] for item in manifest["files"]})
        for item in manifest["files"]:
            with self.subTest(voice=item["voice"]):
                path = ROOT / "app/audio/voices" / (item["voice"] + ".wav")
                data = path.read_bytes()
                self.assertLess(len(data), 200_000)
                self.assertEqual(hashlib.sha256(data).hexdigest(), item["sha256"])
                with wave.open(str(path), "rb") as audio:
                    self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate()), (1, 2, 24000))
                    self.assertGreater(audio.getnframes(), 24000)
                    self.assertLess(audio.getnframes(), 5 * 24000)
                    self.assertTrue(any(audio.readframes(audio.getnframes())), "preview must contain sound")
