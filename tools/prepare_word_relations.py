"""Build word families and inflections using the already pinned CET/ECDICT sources."""
import csv
import json
from pathlib import Path

from prepare_vocabulary import ROOT, SOURCES, CET_INDEX_HASH, REVISION, digest, expand_form, json_bytes, write_atomic


def build():
    source = ROOT / "build/vocabulary-source/ecdict.csv"
    index = ROOT / "app/vocabulary/cet-2016-index.json"
    if digest(source) != SOURCES["ecdict.csv"][1] or digest(index) != CET_INDEX_HASH:
        raise ValueError("Pinned dictionary or syllabus differs")
    bank = json.loads((ROOT / "app/vocabulary/words.json").read_text(encoding="utf-8"))
    ids = {word["id"] for word in bank["words"]}
    with source.open(encoding="utf-8-sig", newline="") as stream:
        dictionary = {r["word"].casefold(): r for r in csv.DictReader(stream)}
    families = {}
    for row in json.loads(index.read_text(encoding="utf-8"))["rows"]:
        tokens = []
        for token in [row["head"], *row["derivatives"]]:
            if tokens and tokens[-1].endswith("/"):
                tokens[-1] += token
            else:
                tokens.append(token)
        members = set(term for token in tokens for term in expand_form(token) if term in dictionary)
        for term in members & ids:
            families.setdefault(term, set()).update(members - {term})
    relations = {}
    for term in sorted(ids):
        row = dictionary.get(term, {})
        related = []
        for other in sorted(families.get(term, [])):
            entry = dictionary[other]
            meaning = entry["translation"].replace("\\n", "\n").strip()
            if meaning:
                related.append({"term": entry["word"], "meaning": meaning, "ipa": entry["phonetic"]})
        forms = []
        for raw in row.get("exchange", "").split("/"):
            tag, _, values = raw.partition(":")
            if tag not in {"p", "d", "i", "3", "s", "r", "t", "0"}:
                continue
            for value in values.split(","):
                if value and value.casefold() != term:
                    forms.append({"kind": tag, "term": value})
        if related or forms:
            relations[term] = {"family": related, "forms": forms}
    result = {"schemaVersion": 1, "sources": {"dictionaryRevision": REVISION, "cetIndexSha256": CET_INDEX_HASH}, "relations": relations}
    write_atomic(ROOT / "app/vocabulary/relations.json", json_bytes(result))
    print(f"Built sourced relations for {len(relations)} words")


if __name__ == "__main__":
    build()
