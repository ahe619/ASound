"""Build the independent lookup dictionary from the pinned ECDICT CSV.

Unlike the study decks, this keeps every nonempty entry with a definition.
Two-character shards are loaded only after a lookup; no network is used here.
"""
import csv
import json
from collections import defaultdict
from pathlib import Path
import unicodedata
from prepare_vocabulary import ROOT, REVISION, SOURCES, digest, json_bytes, write_atomic


def normalize(text):
    return ' '.join(unicodedata.normalize('NFKC', text).lower().replace('’', "'").replace('‘', "'").split())


def shard_key(text):
    return ''.join(c if 'a' <= c <= 'z' else '_' for c in (normalize(text) + '__')[:2])


def build():
    source = ROOT/'build/vocabulary-source/ecdict.csv'
    if digest(source) != SOURCES['ecdict.csv'][1]:
        raise ValueError('Dictionary source checksum differs')
    shards = defaultdict(list)
    count = phonetics = 0
    with source.open(encoding='utf-8-sig', newline='') as stream:
        for row in csv.DictReader(stream):
            term = row['word'].strip()
            translated = row['translation'].replace('\\n', '\n').strip()
            meaning = translated or row['definition'].replace('\\n', '\n').strip()
            if not term or not meaning:
                continue
            rank = int(row.get('frq') or 0) or int(row.get('bnc') or 0) or 999999
            shards[shard_key(term)].append([term, row['phonetic'].strip(), meaning, not bool(translated), row['exchange'], rank])
            count += 1
            phonetics += bool(row['phonetic'].strip())
    output = ROOT/'app/dictionary'
    index = {}
    for key, entries in sorted(shards.items()):
        entries.sort(key=lambda entry: (normalize(entry[0]), entry[0]))
        target = output/'shards'/f'{key}.json'
        write_atomic(target, json_bytes({'schemaVersion':1, 'entries':entries}))
        index[key] = {'count':len(entries), 'bytes':target.stat().st_size, 'sha256':digest(target)}
    write_atomic(output/'index.json', json_bytes({'schemaVersion':1, 'source':'ECDICT', 'revision':REVISION,
        'sourceSha256':SOURCES['ecdict.csv'][1], 'count':count, 'phonetics':phonetics, 'shards':index}))
    print(f'{count} entries, {phonetics} with phonetics, {len(index)} shards, {sum(item["bytes"] for item in index.values())/1e6:.1f} MB total')


if __name__ == '__main__':
    build()
