import hashlib
import json
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parent.parent

class DictionaryDataTests(unittest.TestCase):
    def test_complete_shard_manifest_and_pinned_source(self):
        root=ROOT/'app/dictionary'
        index=json.loads((root/'index.json').read_text(encoding='utf-8'))
        self.assertEqual(index['sourceSha256'],'d1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc')
        self.assertGreater(index['count'],700000)
        self.assertEqual(set(index['shards']),{p.stem for p in (root/'shards').glob('*.json')})
        total=0
        for key, item in index['shards'].items():
            data=(root/'shards'/f'{key}.json').read_bytes()
            self.assertEqual(len(data),item['bytes'])
            self.assertEqual(hashlib.sha256(data).hexdigest(),item['sha256'])
            self.assertEqual(len(json.loads(data)['entries']),item['count'])
            total+=item['count']
        self.assertEqual(total,index['count'])
