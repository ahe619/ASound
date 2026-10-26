"""Build app/kokoro/lexicon-us.json, the American English pronunciation lexicon used by kokoro_lite.py
and app/kokoro/g2p.js, from misaki's dictionaries (Apache-2.0, https://github.com/hexgrad/misaki).

Only misaki's us_gold.json and us_silver.json are read (plus a short list of entries written for this
project below). No espeak, phonemizer, CMUdict or other GPL/LGPL code or data is involved.

    python tools/build_lexicon.py                       # finds or downloads misaki, writes the lexicon
    python tools/build_lexicon.py --misaki path/to/misaki-0.9.4-py3-none-any.whl
    python tools/build_lexicon.py --misaki path/to/misaki/data

Output format (one JSON object, UTF-8, compact):
    "_meta"   : source, license and format notes
    "_final"  : {word: phonemes} stressed variants misaki uses when the word ends a phrase
                (before punctuation or the end of the text), e.g. "have" -> "h\u02c8\u00e6v"
    word keys : {word: phonemes}. Keys are lowercase, except
                - the single capital letters "A".."Z" (letter names, used to spell acronyms),
                - every ALL-CAPS spelling misaki lists ("NASA", "OK", "AI", and "US", "IT", "ID" ...
                  stored spelled out, since written in capitals they are acronyms), and
                - a few Capitalised spellings whose pronunciation differs from the lowercase
                  word ("August", "Polish", ...).
                Look a word up by its exact spelling first, then lowercased.
Phonemes are misaki's American set: A I O W Y (e\u026a a\u026a o\u028a a\u028a \u0254\u026a), \u02a4 \u02a7, \u1d4a (syllabic), \u1d7b, \u027e (flap), \u0294, with
stress marks \u02c8 \u02cc placed right before the stressed vowel. kokoro_lite turns \u027e into T and \u0294 into t at
the very end, as misaki does for Kokoro v1.0. Words whose misaki entry depends on the part of speech
keep misaki's DEFAULT reading, except the few in POS_OVERRIDE where another reading is far more common
in conversation.
"""

import argparse
import glob
import json
import os
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "build", "g2p-work")
OUT = os.path.join(ROOT, "app", "kokoro", "lexicon-us.json")

# misaki's American phoneme inventory (its US_VOCAB) - every entry must use only these.
US_PHONES = set("AIOWYbdfhijklmnpstuvwz\u00e6\u00f0\u014b\u0251\u0254\u0259\u025b\u025c\u0261\u026a\u0279\u027e\u0283\u028a\u028c\u0292\u02a4\u02a7\u02c8\u02cc\u03b8\u1d4a\u1d7b\u0294")
STRESSES = "\u02c8\u02cc"

# Capitalised variants dropped: sentence-initial capitals of ordinary words would pick the rare
# proper-noun reading ("Mobile phones ..." is not the city in Alabama).
DROP_CASED = {"Ok", "Recollect", "Secession", "Mobile", "Os"}

# Heteronyms whose misaki DEFAULT is the rarer reading in everyday speech (no part-of-speech tagger here).
POS_OVERRIDE = {"live": "VERB"}

# ALL-CAPS spellings misaki reads as a word except as a proper noun; in running text written in
# capitals they are nearly always acronyms, so they are stored spelled out.
CAPS_SPELL = {"US", "IT", "ID", "AD", "ER", "OS", "SAT", "ACT", "PA", "GI", "ETA", "LED", "RIP"}

# Entries written for this project (misaki's alphabet), added only when misaki has no entry.
# Modern words, chat spellings and casual reductions that a speaking coach meets often.
SUPPLEMENT = {
    "wi-fi": "w\u02c8If\u02ccI",
    "wifi": "w\u02c8If\u02ccI",
    "iphone": "\u02c8If\u02ccOn",
    "iphones": "\u02c8If\u02ccOnz",
    "ipad": "\u02c8Ip\u02cc\u00e6d",
    "ipads": "\u02c8Ip\u02cc\u00e6dz",
    "ipod": "\u02c8Ip\u02cc\u0251d",
    "imac": "\u02c8Im\u02cc\u00e6k",
    "icloud": "\u02c8Ikl\u02ccWd",
    "tiktok": "t\u02c8\u026akt\u02cc\u0251k",
    "instagram": "\u02c8\u026anst\u0259\u0261\u0279\u02cc\u00e6m",
    "whatsapp": "w\u02c8\u028cts\u02cc\u00e6p",
    "wechat": "w\u02c8i\u02a7\u02cc\u00e6t",
    "linkedin": "l\u02cc\u026a\u014bkt\u02c8\u026an",
    "chatgpt": "\u02a7\u02c8\u00e6t \u02a4\u02ccip\u02ccit\u02c8i",
    "youtuber": "j\u02c8ut\u02ccub\u0259\u0279",
    "youtubers": "j\u02c8ut\u02ccub\u0259\u0279z",
    "zoom": "z\u02c8um",
    "lowkey": "l\u02c8Ok\u02cci",
    "highkey": "h\u02c8Ik\u02cci",
    "rizz": "\u0279\u02c8\u026az",
    "til": "t\u02c8\u026al",
    "'til": "t\u02c8\u026al",
    "cos": "k\u02c8\u028cz",
    "coz": "k\u02c8\u028cz",
    "gonna": "\u0261\u02c8\u028cn\u0259",
    "wanna": "w\u02c8\u0251n\u0259",
    "gotta": "\u0261\u02c8\u0251\u027e\u0259",
    "kinda": "k\u02c8Ind\u0259",
    "sorta": "s\u02c8\u0254\u0279\u027e\u0259",
    "lemme": "l\u02c8\u025bmi",
    "gimme": "\u0261\u02c8\u026ami",
    "dunno": "d\u0259n\u02c8O",
    "outta": "\u02c8W\u027e\u0259",
    "hafta": "h\u02c8\u00e6ft\u0259",
    "oughta": "\u02c8\u0254\u027e\u0259",
    "tryna": "t\u0279\u02c8In\u0259",
    "ya": "j\u0259",
    "yall": "j\u02c8\u0254l",
    "y'all": "j\u02c8\u0254l",
    "ya'll": "j\u02c8\u0254l",
    "ain't": "\u02c8Ant",
    "alright": "\u0254l\u0279\u02c8It",
    "okay": "\u02ccOk\u02c8A",
    "email": "\u02c8im\u02ccAl",
    "emails": "\u02c8im\u02ccAlz",
    "e-mail": "\u02c8im\u02ccAl",
    "online": "\u02cc\u0254nl\u02c8In",
    "app": "\u02c8\u00e6p",
    "apps": "\u02c8\u00e6ps",
    "website": "w\u02c8\u025bbs\u02ccIt",
    "smartphone": "sm\u02c8\u0251\u0279tf\u02ccOn",
    "podcast": "p\u02c8\u0251dk\u02cc\u00e6st",
    "podcasts": "p\u02c8\u0251dk\u02cc\u00e6sts",
    "selfie": "s\u02c8\u025blfi",
    "vlog": "vl\u02c8\u0251\u0261",
    "blog": "bl\u02c8\u0251\u0261",
    "texting": "t\u02c8\u025bkst\u026a\u014b",
    "thx": "\u03b8\u02c8\u00e6\u014bks",
    "pls": "pl\u02c8iz",
    "plz": "pl\u02c8iz",
    "u": "j\u02c8u",
    "ur": "j\u028a\u0279",
    "kk": "k\u02ccAk\u02c8A",
    "ez": "\u02c8izi",
    "lmao": "l\u02c8\u00e6m\u02ccW",
    "ms.": "m\u02c8\u026az",
    "miz": "m\u02c8\u026az",
    "a.m.": "\u02ccA\u02c8\u025bm",
    "p.m.": "p\u02cci\u02c8\u025bm",
}

# Chat and campus acronyms spoken as letters; spelled with misaki's letter names at build time.
SPELLED = ["lol", "omg", "btw", "idk", "tbh", "imo", "brb", "fyi", "diy", "ceo", "faq", "gpa", "phd", "mba",
           "bbq", "dm", "dms", "hr", "ui", "ux", "pc", "cv", "tv", "cs", "usa", "nyc", "fbi", "cia", "ibm", "bmw",
           "ngl", "irl", "smh", "ttyl", "ikr", "hbu", "wyd", "nvm", "gg", "af", "atm", "aka", "asap", "eta",
           "pdf", "url", "html", "css", "api", "gpu", "cpu", "ram", "usb", "sql", "ios", "llm", "nba", "nfl",
           "ucla", "mit", "nyu", "ielts", "toefl", "gre", "gmat", "sat", "ita", "ta", "tas", "ra", "pr", "qa"]
# (letters only: an "s" ending on a few of these is part of the acronym; the letter names are joined.)
SPELLED_AS_WORD = {"ielts": "\u02c8I\u02cc\u025blts", "toefl": "t\u02c8Of\u1d4al", "asap": "\u02ccA\u02cc\u025bs\u02ccA\u02c8pi", "ram": "\u0279\u02c8\u00e6m",
                   "ios": "\u02ccI\u02ccO\u02c8\u025bs", "tas": "t\u02cci\u02c8Az", "dms": "d\u02cci\u02c8\u025bmz"}


def find_misaki(arg):
    """Return the directory holding us_gold.json, downloading misaki into build/g2p-work if needed."""
    if arg:
        if os.path.isdir(arg):
            for cand in (arg, os.path.join(arg, "misaki", "data"), os.path.join(arg, "data")):
                if os.path.isfile(os.path.join(cand, "us_gold.json")):
                    return cand
            raise SystemExit(f"no us_gold.json under {arg}")
        if arg.endswith(".whl"):
            return unzip_wheel(arg)
        raise SystemExit(f"--misaki must be a misaki wheel or data directory: {arg}")
    have = os.path.join(WORK, "misaki-src", "misaki", "data")
    if os.path.isfile(os.path.join(have, "us_gold.json")):
        return have
    wheels = sorted(glob.glob(os.path.join(WORK, "misaki-dl", "misaki-*.whl")))
    if not wheels:
        os.makedirs(os.path.join(WORK, "misaki-dl"), exist_ok=True)
        subprocess.check_call([sys.executable, "-m", "pip", "download", "misaki", "--no-deps",
                               "-d", os.path.join(WORK, "misaki-dl")])
        wheels = sorted(glob.glob(os.path.join(WORK, "misaki-dl", "misaki-*.whl")))
    return unzip_wheel(wheels[-1])


def unzip_wheel(path):
    """Extract only the US dictionaries and the dist-info (license, version) from a misaki wheel."""
    dest = os.path.join(WORK, "misaki-src")
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.startswith("misaki/data/us_") or (name.startswith("misaki-") and ".dist-info/" in name):
                z.extract(name, dest)
    return os.path.join(dest, "misaki", "data")


def misaki_version(data_dir):
    dist = glob.glob(os.path.join(os.path.dirname(os.path.dirname(data_dir)), "misaki-*.dist-info"))
    return os.path.basename(dist[0])[len("misaki-"):-len(".dist-info")] if dist else "unknown"


def spell(letters, names):
    """Spell with letter names the way misaki's get_NNP does: every letter secondary, the last primary."""
    ps = "".join(names[c.upper()] for c in letters if c.isalpha())
    ps = ps.replace("\u02c8", "\u02cc")
    head, sep, tail = ps.rpartition("\u02cc")
    return head + "\u02c8" + tail if sep else ps


def build(data_dir):
    with open(os.path.join(data_dir, "us_gold.json"), encoding="utf-8") as f:
        gold = json.load(f)
    with open(os.path.join(data_dir, "us_silver.json"), encoding="utf-8") as f:
        silver = json.load(f)

    names = {c: gold[c] for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"}
    lower, cased, caps, final = {}, {}, {}, {}
    stats = {"gold": len(gold), "silver": len(silver), "pos_keyed": 0, "caps": 0, "caps_spelled": 0}
    for source in (gold, silver):
        for key, value in source.items():
            fin = None
            if isinstance(value, dict):
                stats["pos_keyed"] += 1
                ps = value.get(POS_OVERRIDE.get(key, "DEFAULT")) or value.get("DEFAULT")
                fin = value.get("None") or value.get("DT")      # "that" is stressed as a pronoun
                if key.isupper() and len(key) > 1 and key in CAPS_SPELL:
                    ps = spell(key, names)
                    stats["caps_spelled"] += 1
            else:
                ps = value
            if not ps:
                continue
            if len(key) > 1 and key.isupper():
                caps.setdefault(key, ps)
                if not isinstance(value, dict):
                    cased.setdefault(key, ps)        # NASA -> also "nasa"
            elif key == key.lower():
                lower.setdefault(key, ps)
                if fin and fin != ps:
                    final.setdefault(key, fin)
            elif key not in DROP_CASED:
                cased.setdefault(key, ps)

    # Single capital letters are letter names; keep them under their own keys.
    letters = {c: cased.pop(c) for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if c in cased}
    missing = [c for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if c not in letters]
    assert not missing, f"letter names missing: {missing}"

    # Capitalised entries without a lowercase twin become lowercase entries (names, places, acronyms
    # said as words). Spellings that differ from their lowercase twin stay case-specific.
    keep_cased = {}
    for key in sorted(cased, key=lambda k: (k.upper() == k, k)):   # Capitalised before ALL-CAPS
        ps = cased[key]
        low = key.lower()
        if low not in lower:
            lower[low] = ps
        elif lower[low] != ps and not key.isupper():
            keep_cased[key] = ps

    for word, ps in SUPPLEMENT.items():
        lower.setdefault(word, ps)
    for word in SPELLED:
        lower.setdefault(word, SPELLED_AS_WORD.get(word) or spell(word, letters))

    entries = {}
    entries.update(lower)
    entries.update(keep_cased)
    entries.update(caps)
    entries.update(letters)
    bad = {k: v for k, v in list(entries.items()) + list(final.items()) if not set(v) <= US_PHONES | {" "}}
    assert not bad, f"phonemes outside misaki's US set: {list(bad.items())[:10]}"
    stats.update(entries=len(entries), lowercase=len(lower), cased=len(keep_cased), caps=len(caps),
                 final=len(final))
    return entries, final, stats


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--misaki", help="misaki wheel (.whl) or directory with us_gold.json / us_silver.json")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    data_dir = find_misaki(args.misaki)
    entries, final, stats = build(data_dir)
    meta = {
        "name": "ASound American English lexicon for Kokoro-82M",
        "source": f"misaki {misaki_version(data_dir)} us_gold.json + us_silver.json "
                  "(https://github.com/hexgrad/misaki), plus a few entries written for ASound",
        "license": "Apache-2.0 (misaki dictionaries, Copyright hexgrad); additions under the same terms",
        "built_by": "tools/build_lexicon.py",
        "format": "word -> misaki US phonemes (flap written \u027e). Keys lowercase except A-Z letter names, ALL-CAPS "
                  "acronyms and case-specific spellings; look up the exact spelling, then lowercase. "
                  "_final: stressed variants used before punctuation or at the end of the text. "
                  "POS-dependent words use misaki's DEFAULT reading (live: the verb).",
        "entries": stats["entries"],
    }
    out = {"_meta": meta, "_final": dict(sorted(final.items()))}
    out.update(sorted(entries.items()))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    size = os.path.getsize(args.out)
    print(f"wrote {args.out}: {stats['entries']} entries, {size / 1e6:.2f} MB")
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
