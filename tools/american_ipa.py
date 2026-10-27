"""Write app/vocabulary/ipa-us.json: General American IPA for the study words, from ASound's American lexicon.

    .venv\\Scripts\\python.exe tools\\american_ipa.py

The dictionary's own transcriptions (ECDICT) are mostly British. ASound teaches an American accent, so the cards show
this American reading first. Source: app/kokoro/lexicon-us.json (misaki us_gold/us_silver, Apache-2.0; built by
tools/build_lexicon.py). misaki's compact phonemes become ordinary dictionary IPA: A I O W Y -> e\u026a a\u026a o\u028a a\u028a \u0254\u026a,
\u02a4 \u02a7 -> d\u0292 t\u0283, \u0279 -> r, \u1d4a -> \u0259, \u1d7b -> \u026a, the flap \u027e -> t, and stress marks move from the vowel to the start of
the syllable. Phrases are read word by word; a word missing from the lexicon leaves the whole entry out.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEXICON = ROOT / "app" / "kokoro" / "lexicon-us.json"
WORDS = ROOT / "app" / "vocabulary" / "words.json"
OUT = ROOT / "app" / "vocabulary" / "ipa-us.json"

SWAP = {"A": "e\u026a", "I": "a\u026a", "O": "o\u028a", "W": "a\u028a", "Y": "\u0254\u026a", "\u02a4": "d\u0292", "\u02a7": "t\u0283",
        "\u0279": "r", "\u1d4a": "\u0259", "\u1d7b": "\u026a", "\u027e": "t", "\u0294": "t"}
VOWELS = set("aeiou\u00e6\u0251\u0252\u0254\u0259\u025a\u025b\u025c\u026a\u028a\u028cAIOWY\u1d4a\u1d7b")
ONSETS = {"pl", "pr", "bl", "br", "tr", "dr", "kl", "kr", "gl", "gr", "fl", "fr", "\u03b8r", "\u0283r", "sp", "st", "sk",
          "sm", "sn", "sl", "sw", "tw", "kw", "dw", "pj", "bj", "kj", "mj", "fj", "vj", "hj", "spl", "spr", "str", "skr", "skw"}
ONSETS = {o.replace("r", "\u0279") for o in ONSETS}  # compared before r is rewritten


def move_stress(ph):
    """misaki puts \u02c8/\u02cc right before the stressed vowel; dictionaries put it before the syllable's onset."""
    out = list(ph)
    i = 0
    while i < len(out):
        if out[i] in "\u02c8\u02cc":
            mark = out.pop(i)
            j = i
            while j > 0 and out[j - 1] not in VOWELS and out[j - 1] not in "\u02c8\u02cc ":
                j -= 1
            cluster = "".join(out[j:i])
            # keep the longest legal onset; the rest of the consonants close the previous syllable
            k = j
            while k < i and not (len(cluster) - (k - j) <= 1 or cluster[k - j:] in ONSETS):
                k += 1
            if j == 0:
                k = 0
            out.insert(k, mark)
            i += 1
        i += 1
    return "".join(out)


def to_ipa(ph):
    # one syllable: no stress mark (as in dictionaries); syllabic \u1d4a (apple, little) counts as a syllable
    if len(re.findall("[aeiou\u00e6\u0251\u0254\u0259\u025b\u025c\u026a\u028a\u028cAIOWY\u1d4a\u1d7b]+", ph)) <= 1:
        ph = ph.replace("\u02c8", "").replace("\u02cc", "")
    ph = move_stress(ph)
    return "".join(SWAP.get(c, c) for c in ph)


def lookup(lexicon, term):
    parts = re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", term)
    if not parts:
        return None
    out = []
    for word in parts:
        ph = lexicon.get(word) or lexicon.get(word.lower())
        if not ph:
            return None
        out.append(to_ipa(ph))
    return " ".join(out)


def main():
    lexicon = json.loads(LEXICON.read_text(encoding="utf-8"))
    words = json.loads(WORDS.read_text(encoding="utf-8"))["words"]
    table, missing = {}, 0
    for w in words:
        ipa = lookup(lexicon, w["term"])
        if ipa:
            table[w["id"]] = ipa
        else:
            missing += 1
    doc = {"schemaVersion": 1, "source": "misaki us_gold/us_silver via app/kokoro/lexicon-us.json (Apache-2.0)",
           "ipa": table}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    print(f"{len(table)} words with American IPA, {missing} without; {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
