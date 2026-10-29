import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent


class WordRelationsTests(unittest.TestCase):
    def test_relations_have_pinned_provenance_and_real_bank_keys(self):
        data = json.loads((ROOT/'app/vocabulary/relations.json').read_text(encoding='utf-8'))
        words = json.loads((ROOT/'app/vocabulary/words.json').read_text(encoding='utf-8'))['words']
        self.assertEqual(data['schemaVersion'], 1)
        self.assertEqual(data['sources']['dictionaryRevision'], 'ab22ad36302cafc6349a050e2b60894855208055')
        self.assertEqual(data['sources']['cetIndexSha256'], '47878fc7718efb864c6ff9767f1b5c82b0c7774d5257f2aae25a0fec573a87da')
        ids = {word['id'] for word in words}
        for word, row in data['relations'].items():
            self.assertIn(word, ids)
            self.assertEqual(len(row['family']), len({item['term'] for item in row['family']}))
            for item in row['family']:
                self.assertTrue(item['meaning'].strip())
                self.assertNotEqual(item['term'].casefold(), word)
            for item in row['forms']:
                self.assertIn(item['kind'], {'p','d','i','3','s','r','t','0'})
                self.assertTrue(item['term'].strip())
        act = data['relations']['act']
        self.assertIn('action', [item['term'] for item in act['family']])
        self.assertIn({'kind':'p','term':'acted'}, act['forms'])
        # Irregular forms come from the dictionary, not a suffix generator.
        self.assertIn({'kind':'p','term':'went'}, data['relations']['go']['forms'])
