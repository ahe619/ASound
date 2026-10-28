"""tools/american_ipa.py turns misaki's American phonemes into the dictionary-style IPA shown first on word cards."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import american_ipa
from tools.american_ipa import to_ipa

ROOT = Path(__file__).resolve().parent.parent


class AmericanIpaTests(unittest.TestCase):
    def check(self, cases):
        for word, misaki, expected in cases:
            with self.subTest(word):
                self.assertEqual(to_ipa(misaki), expected)

    def test_two_syllable_words_keep_their_stress_mark(self):
        # A diphthong next to another vowel is two syllables, and so is syllabic n after a glottal stop.
        self.check([
            ("lion", "lˈIən", "ˈlaɪən"),
            ("power", "pˈWəɹ", "ˈpaʊər"),
            ("going", "ɡˈOɪŋ", "ˈɡoʊɪŋ"),
            ("being", "bˈiɪŋ", "ˈbiɪŋ"),
            ("button", "bˈʌʔn", "ˈbʌtn"),
            ("certain", "sˈɜɹʔn", "ˈsɜrtn"),
            ("apple", "ˈæpᵊl", "ˈæpəl"),
        ])

    def test_one_syllable_words_have_no_stress_mark(self):
        self.check([
            ("cat", "kˈæt", "kæt"),
            ("time", "tˈIm", "taɪm"),
            ("street", "stɹˈit", "strit"),
        ])

    def test_a_stressed_short_vowel_keeps_a_consonant_before_the_next_syllable(self):
        self.check([
            ("network", "nˈɛtwˌɜɹk", "ˈnɛtˌwɜrk"),
            ("bedroom", "bˈɛdɹˌum", "ˈbɛdˌrum"),
            ("password", "pˈæswˌɜɹd", "ˈpæsˌwɜrd"),
            ("upload", "ˈʌplˌOd", "ˈʌpˌloʊd"),
            ("backyard", "bˌækjˈɑɹd", "ˌbækˈjɑrd"),
            ("frustrate", "fɹˈʌstɹˌAt", "ˈfrʌsˌtreɪt"),
        ])

    def test_an_unstressed_vowel_keeps_the_longest_onset(self):
        self.check([
            ("extract", "ɪkstɹˈækt", "ɪkˈstrækt"),
            ("elite", "ɪlˈit", "ɪˈlit"),
            ("ballet", "bælˈA", "bæˈleɪ"),
            ("integrate", "ˈɪntəɡɹˌAt", "ˈɪntəˌɡreɪt"),
        ])

    def test_gl_and_gr_are_onsets(self):
        # misaki writes the IPA g (U+0261), not the ASCII letter
        self.check([
            ("agree", "əɡɹˈi", "əˈɡri"),
            ("neglect", "nəɡlˈɛkt", "nəˈɡlɛkt"),
            ("background", "bˈækɡɹˌWnd", "ˈbækˌɡraʊnd"),
        ])

    def test_words_read_two_ways_fall_back_to_the_dictionary_line(self):
        # One American line for "lead" would teach /lid/ beside the meaning "n. lead (the metal)".
        lexicon = {"lead": "lˈid", "cat": "kˈæt", "pencil": "pˈɛnsᵊl"}
        words = [{"id": "lead", "term": "lead"}, {"id": "cat", "term": "cat"},
                 {"id": "lead-pencil", "term": "lead pencil"}]
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            (temp / "lexicon.json").write_text(json.dumps(lexicon), encoding="utf-8")
            (temp / "words.json").write_text(json.dumps({"words": words}), encoding="utf-8")
            with patch.object(american_ipa, "LEXICON", temp / "lexicon.json"), \
                    patch.object(american_ipa, "WORDS", temp / "words.json"), \
                    patch.object(american_ipa, "OUT", temp / "ipa-us.json"), patch("builtins.print"):
                american_ipa.main()
            table = json.loads((temp / "ipa-us.json").read_text(encoding="utf-8"))["ipa"]
        self.assertEqual(table, {"cat": "kæt"})

    def test_the_shipped_table_is_what_the_tool_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "ipa-us.json"
            with patch.object(american_ipa, "OUT", out), patch("builtins.print"):
                american_ipa.main()
            fresh = out.read_bytes()
        shipped = (ROOT / "app" / "vocabulary" / "ipa-us.json").read_bytes()
        self.assertTrue(fresh.replace(b"\r\n", b"\n") == shipped.replace(b"\r\n", b"\n"),
                        "Run python tools/american_ipa.py to regenerate app/vocabulary/ipa-us.json")


if __name__ == "__main__":
    unittest.main()
