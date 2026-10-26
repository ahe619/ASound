"""kokoro_lite: Kokoro-82M text-to-speech with no GPL code or data.

An American English grapheme-to-phoneme converter (G2P) that writes the phoneme strings Kokoro v1.0
was trained on (misaki's alphabet), plus a small onnxruntime runner for the Kokoro ONNX exports.

    from kokoro_lite import phonemize, KokoroLite
    phonemize("I could've gone at 3:30.")          # -> 'ˌI kˈʊdəv ɡˈɔn æt θɹˈi θˈɜɹɾi.'
    tts = KokoroLite("models/kokoro-onnx/kokoro-v1.0.onnx", "models/kokoro-onnx/voices-v1.0.bin")
    audio, sr = tts.create("Hello there!", voice="af_heart", speed=1.0)

Pronunciations come from app/kokoro/lexicon-us.json, built by tools/build_lexicon.py from misaki's
us_gold / us_silver dictionaries (Apache-2.0, https://github.com/hexgrad/misaki). The lookup order,
the -s / -ed / -ing stemming, the stress helper and the context rules for a / an / the / to / in
follow misaki's en.py (Apache-2.0, Copyright hexgrad). Number reading, abbreviations, contractions,
compounds and the letter-to-sound rules for unknown words are written for ASound.
No espeak, phonemizer or other GPL/LGPL code or data is used. Needs only numpy + onnxruntime (and
neither for phonemize()).

app/kokoro/g2p.js is a JavaScript port of the G2P part; keep the two in step.

Command line:  python kokoro_lite.py "Some text."                 (prints phonemes)
               python kokoro_lite.py "Some text." --wav out.wav   (synthesizes with the default model)
"""

import json
import os
import re
import sys
import unicodedata

__all__ = ["phonemize", "tokenize", "word_phonemes", "letter_to_sound", "split_phonemes",
           "KokoroLite", "VOCAB", "SAMPLE_RATE", "MAX_TOKENS", "lexicon_path"]

SAMPLE_RATE = 24000
MAX_TOKENS = 510

# Kokoro-82M v1.0 vocabulary (the model's config.json "vocab" / tokenizer.json); id 0 is the pad "$".
_VOCAB_SYMBOLS = (';:,.!?—…"()“” ̃ʣʥʦʨᵝꭧAIOQSTWYᵊ'
                  'abcdefhijklmnopqrstuvwxyzɑɐɒ\xe6βɔɕ\xe7ɖ\xf0ʤ'
                  'əɚɛɜɟɡɥɨɪʝɯɰŋɳɲ'
                  'ɴ\xf8ɸθœɹɾɻʁɽʂʃʈʧʊ'
                  'ʋʌɣɤχʎʒʔˈˌːʰʲ↓→'
                  '↗↘ᵻ')
_VOCAB_IDS = (1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 31, 33, 35, 36,
              39, 41, 42, 43, 44, 45, 46, 47, 48, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65,
              66, 67, 68, 69, 70, 71, 72, 75, 76, 77, 78, 80, 81, 82, 83, 85, 86, 87, 90, 92, 99, 101, 102, 103,
              110, 111, 112, 113, 114, 115, 116, 118, 119, 120, 123, 125, 126, 128, 129, 130, 131, 132, 133, 135,
              136, 138, 139, 140, 142, 143, 147, 148, 156, 157, 158, 162, 164, 169, 171, 172, 173, 177)
VOCAB = dict(zip(_VOCAB_SYMBOLS, _VOCAB_IDS))

# ----------------------------------------------------------------------------------------------------
# Lexicon
# ----------------------------------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_LEX_REL = os.path.join("app", "kokoro", "lexicon-us.json")
_lexicon = None
_lexicon_file = None


def lexicon_path(path=None):
    """Get, or set before first use, the lexicon file (default: app/kokoro/lexicon-us.json next to this file)."""
    global _lexicon_file, _lexicon
    if path:
        _lexicon_file, _lexicon = path, None
    if _lexicon_file:
        return _lexicon_file
    cands = [os.environ.get("ASOUND_LEXICON"), os.path.join(_HERE, _LEX_REL)]
    if getattr(sys, "_MEIPASS", None):
        cands.append(os.path.join(sys._MEIPASS, _LEX_REL))
    cands.append(os.path.join(os.path.dirname(os.path.abspath(sys.executable)), _LEX_REL))
    for c in cands:
        if c and os.path.isfile(c):
            return c
    raise FileNotFoundError("lexicon-us.json not found; run tools/build_lexicon.py or set ASOUND_LEXICON")


class _Lexicon:
    def __init__(self, path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self.meta = data.pop("_meta", {})
        self.final = data.pop("_final", {})
        self.words = data


def _lex():
    global _lexicon
    if _lexicon is None:
        _lexicon = _Lexicon(lexicon_path())
    return _lexicon


# ----------------------------------------------------------------------------------------------------
# Phoneme sets and stress (after misaki en.py)
# ----------------------------------------------------------------------------------------------------

PRIMARY, SECONDARY = "ˈ", "ˌ"
STRESSES = SECONDARY + PRIMARY
VOWELS = frozenset("AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ")
CONSONANTS = frozenset("bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ")
US_TAUS = frozenset("AIOWYiuæɑəɛɪɹʊʌ")          # sounds after which t flaps
DIPHTHONGS = frozenset("AIOQWYʤʧ")
PUNCTS = frozenset(';:,.!?—…"“”()')
NON_QUOTE_PUNCTS = frozenset(';:,.!?—…()')


def apply_stress(ps, stress):
    """misaki's apply_stress: None keeps, < -1 strips, -1/-0.5/0 demote, 0.5/1 add secondary, 2 add primary."""
    def restress(p):
        ips = list(enumerate(p))
        stresses = {}
        for i, c in ips:
            if c in STRESSES:
                stresses[i] = next((j for j, v in ips[i:] if v in VOWELS), i)
        for i, j in stresses.items():
            ips[i] = (j - 0.5, ips[i][1])
        return "".join(c for _, c in sorted(ips, key=lambda t: t[0]))
    if stress is None or not ps:
        return ps
    if stress < -1:
        return ps.replace(PRIMARY, "").replace(SECONDARY, "")
    if stress == -1 or (stress in (0, -0.5) and PRIMARY in ps):
        return ps.replace(SECONDARY, "").replace(PRIMARY, SECONDARY)
    if stress in (0, 0.5, 1) and all(s not in ps for s in STRESSES):
        if all(v not in ps for v in VOWELS):
            return ps
        return restress(SECONDARY + ps)
    if stress >= 1 and PRIMARY not in ps and SECONDARY in ps:
        return ps.replace(SECONDARY, PRIMARY)
    if stress > 1 and all(s not in ps for s in STRESSES):
        if all(v not in ps for v in VOWELS):
            return ps
        return restress(PRIMARY + ps)
    return ps


def stress_weight(ps):
    return sum(2 if c in DIPHTHONGS else 1 for c in ps) if ps else 0


def _suffix_s(ps):
    """Add a plural / possessive / 3rd-person -s to a pronunciation."""
    if not ps:
        return ps
    last = ps.rstrip(STRESSES)[-1:]
    if last in "ptkfθ":
        return ps + "s"
    if last in "szʃʒʧʤ":
        return ps + "ᵻz"
    return ps + "z"


def _suffix_ed(ps):
    if not ps:
        return ps
    if ps[-1] in "pkfθʃsʧ":
        return ps + "t"
    if ps[-1] == "d":
        return ps + "ᵻd"
    if ps[-1] != "t":
        return ps + "d"
    if len(ps) > 1 and ps[-2] in US_TAUS:
        return ps[:-1] + "ɾᵻd"
    return ps + "ᵻd"


def _suffix_ing(ps):
    if not ps:
        return ps
    if len(ps) > 1 and ps[-1] == "t" and ps[-2] in US_TAUS:
        return ps[:-1] + "ɾɪŋ"
    return ps + "ɪŋ"


def _ends_vowel(ps):
    for c in reversed(ps):
        if c in STRESSES:
            continue
        return c in VOWELS or c == "ᵊ"
    return False


def _spell(letters):
    """Letter names, every letter secondary and the last one primary (misaki's get_NNP)."""
    W = _lex().words
    parts = []
    for c in letters:
        c = _strip_accents(c).upper()
        if c in W and len(c) == 1 and c.isalpha():
            parts.append(W[c])
    if not parts:
        return None
    ps = apply_stress("".join(parts), 0)
    head, sep, tail = ps.rpartition(SECONDARY)
    return head + PRIMARY + tail if sep else ps


def _strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


# ----------------------------------------------------------------------------------------------------
# Numbers -> words
# ----------------------------------------------------------------------------------------------------

_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
         "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_SCALES = [(10 ** 12, "trillion"), (10 ** 9, "billion"), (10 ** 6, "million"), (1000, "thousand")]
_ORD_WORDS = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
              "nine": "ninth", "twelve": "twelfth"}


def _under_100(n):
    if n < 20:
        return [_ONES[n]]
    t, o = divmod(n, 10)
    return [_TENS[t]] + ([_ONES[o]] if o else [])


def _under_1000(n):
    h, r = divmod(n, 100)
    out = [_ONES[h], "hundred"] if h else []
    return out + (_under_100(r) if r or not h else [])


def cardinal_words(n):
    """1234 -> ['one', 'thousand', 'two', 'hundred', 'thirty', 'four'] (American: no 'and')."""
    if n < 0:
        return ["minus"] + cardinal_words(-n)
    if n < 1000:
        return _under_1000(n)
    if n >= 10 ** 15:
        return digit_words(str(n))
    out = []
    for value, name in _SCALES:
        if n >= value:
            q, n = divmod(n, value)
            out += _under_1000(q) + [name]
    if n:
        out += _under_1000(n)
    return out


def ordinal_words(n):
    words = cardinal_words(n)
    last = words[-1]
    if last in _ORD_WORDS:
        words[-1] = _ORD_WORDS[last]
    elif last.endswith("y"):
        words[-1] = last[:-1] + "ieth"
    else:
        words[-1] = last + "th"
    return words


def year_words(n):
    """Years the American way: 1999 nineteen ninety-nine, 2005 two thousand five, 2010 twenty ten."""
    high, low = divmod(n, 100)
    if high == 0 or (high % 10 == 0 and low < 10) or high >= 100:
        return cardinal_words(n)
    out = _under_100(high)
    if low == 0:
        return out + ["hundred"]
    if low < 10:
        return out + ["oh", _ONES[low]]
    return out + _under_100(low)


def digit_words(s):
    return [_ONES[int(c)] for c in s if c.isdigit()]


# ----------------------------------------------------------------------------------------------------
# Letter-to-sound rules for words the lexicon does not know (written for ASound)
# ----------------------------------------------------------------------------------------------------
# A word is scanned left to right; at each letter the first matching rule wins. Patterns run on the word
# padded with '#' at both ends. Placeholders: C consonant letter, V vowel letter, K one consonant sound
# (single letter or th/sh/ch/ph), E an ending after a silent e. Outputs are phonemes, where a vowel is
# written <full|reduced>: the full form is used when the syllable is stressed, the reduced one otherwise.

_LTS_CLASSES = {
    "C": "[bcdfghjklmnpqrstvwxz]",
    "V": "[aeiouy]",
    "K": "(?:th|sh|ch|ph|[bcdfgjklmnpqrstvz])",
    "E": "(?:#|s#|d#|ly#|ment#|ments#|ful#|less#|ness#|r#|rs#)",
    "Q": "(?:ic|ics|ical|id|it|its|ish|ity|ities|el|els|et|ets|age|ad|ol|il|ent|ents|ence|ance|ure|y#)",
}

_LTS_RULES_SRC = [
    # --- endings (checked first, as they span several letters) ---
    ("tion(?=s?#)", "ʃ<ə|ə>n"), ("(?<=[aeiou])sion(?=s?#)", "ʒ<ə|ə>n"), ("sion(?=s?#)", "ʃ<ə|ə>n"),
    ("(?<=[cts])ian(?=s?#)", "<ə|ə>n"),
    ("cious", "ʃ<ə|ə>s"), ("tious", "ʃ<ə|ə>s"), ("cial", "ʃ<ə|ə>l"), ("tial", "ʃ<ə|ə>l"),
    ("cient", "ʃ<ə|ə>nt"), ("tient", "ʃ<ə|ə>nt"), ("geous", "ʤ<ə|ə>s"), ("gious", "ʤ<ə|ə>s"),
    ("(?<=[aeiou])sure(?=[sd]?#)", "ʒ<ə|ə>ɹ"), ("sure(?=[sd]?#)", "ʃ<ə|ə>ɹ"),
    ("ture(?=[sd]?#|r)", "ʧ<ə|ə>ɹ"), ("ous(?=#)", "<ə|ə>s"), ("ism(?=s?#)", "<ɪ|ɪ>z<ə|ə>m"),
    ("(?<=[bcdfgkptz])le(?=s?#)", "ᵊl"), ("(?<=[bcdfgkptz])led(?=#)", "ᵊld"),
    ("ology", "<ɑ|ə>l<ə|ə>ʤ<i|i>"), ("ogy(?=#)", "<ə|ə>ʤ<i|i>"),
    ("ph", "f"), ("tch", "ʧ"), ("dge", "ʤ"), ("sch", "ʃ"), ("chr", "kɹ"), ("ch(?=l)", "k"), ("ch", "ʧ"),
    ("ck", "k"), ("sh", "ʃ"), ("(?<=[aeiouy])th(?=er)", "ð"), ("th(?=e#)", "ð"), ("th", "θ"), ("wh", "w"),
    ("#gh", "ɡ"), ("gh", ""), ("qu", "kw"), ("(?<=#)kn", "n"), ("(?<=#)gn", "n"), ("gn(?=#)", "n"),
    ("(?<=#)wr", "ɹ"), ("(?<=#)ps", "s"), ("(?<=#)pn", "n"), ("mb(?=#)", "m"), ("mn(?=#)", "m"),
    ("ng(?=#)", "ŋ"), ("ng(?=[sd]#|ly#|er#)", "ŋ"), ("ng(?=V)", "ŋɡ"), ("ng", "ŋ"), ("nk", "ŋk"),
    ("nc(?=[kq])", "ŋ"), ("zh", "ʒ"), ("kh", "k"), ("dj", "ʤ"), ("tz", "ts"),
    # --- vowel groups ---
    ("augh", "<ɔ|ɔ>"), ("ought", "<ɔ|ɔ>t"), ("ough(?=#)", "<O|O>"), ("eigh", "<A|A>"), ("aigh", "<A|A>"),
    ("igh", "<I|I>"), ("eau", "<O|O>"), ("ieu", "<u|u>"),
    ("oor", "<ɔɹ|əɹ>"), ("oo(?=k)", "<ʊ|ʊ>"), ("oo(?=d#)", "<ʊ|ʊ>"), ("oo", "<u|u>"),
    ("our(?=#|s#)", "<W|W><ə|ə>ɹ"), ("our", "<ɔɹ|əɹ>"), ("oul(?=d)", "<ʊ|ʊ>"), ("ou", "<W|W>"),
    ("ower", "<W|W><ə|ə>ɹ"), ("(?<=[lrn])ow(?=#|s#)", "<O|O>"), ("ow(?=#|s#)", "<W|W>"), ("ow", "<W|W>"),
    ("oi", "<Y|Y>"), ("oy", "<Y|Y>"), ("au", "<ɔ|ɔ>"), ("aw", "<ɔ|ɔ>"),
    ("air", "<ɛɹ|əɹ>"), ("ai", "<A|A>"), ("ay", "<A|A>"),
    ("ear(?=#|s#)", "<ɪɹ|ɪɹ>"), ("ear(?=C)", "<ɜɹ|əɹ>"), ("ea(?=d#|th|ther)", "<ɛ|ɛ>"),
    ("(?<=C)ea(?=#)", "<i|i><ə|ə>"), ("ea", "<i|i>"), ("eer", "<ɪɹ|ɪɹ>"), ("ee", "<i|i>"),
    ("eir", "<ɛɹ|əɹ>"), ("(?<=c)ei", "<i|i>"), ("ei", "<A|A>"), ("ey(?=#|s#)", "<i|i>"), ("ey", "<A|A>"),
    ("eu", "<u|u>"), ("ew", "<u|u>"),
    ("(?<=#C)ie(?=#)", "<I|I>"), ("(?<=#CC)ie(?=#)", "<I|I>"), ("ie(?=#|s#)", "<i|i>"), ("ie(?=r#)", "<i|i><ə|ə>"),
    ("ie", "<i|i>"), ("oar", "<ɔɹ|əɹ>"), ("oa", "<O|O>"), ("oe(?=#|s#)", "<O|O>"), ("oe", "<O|O>"),
    ("(?<=[gq])ue(?=#)", ""), ("ue", "<u|u>"), ("(?<=g)u(?=[eiy])", ""), ("ui", "<u|u>"), ("uy", "<I|I>"),
    ("ye(?=#)", "<I|I>"),
    # --- a ---
    ("(?<=w)ar(?!V)", "<ɔɹ|əɹ>"), ("(?<=[wq])a(?=[^kgxr])", "<ɑ|ə>"), ("are(?=E)", "<ɛɹ|əɹ>"),
    ("ar(?=V)", "<ɛɹ|əɹ>"), ("ar", "<ɑɹ|əɹ>"), ("al(?=l|k|t#|ts#|d#|m)", "<ɔ|ɔ>"), ("ange", "<A|A>nʤ"),
    ("a(?=ste)", "<A|A>"), ("a(?=t[eu]E)", "<A|A>"), ("a(?=geE)", "<A|ɪ>"), ("a(?=KE)", "<A|ə>"),
    ("a(?=KQ)", "<æ|ə>"), ("a(?=KV)", "<A|ə>"), ("a(?=#)", "<ɑ|ə>"), ("a(?=[aeiou])", "<A|ə>"),
    ("a", "<æ|ə>"),
    # --- e ---
    ("(?<=V.)e(?=#)", ""), ("(?<=VC.)e(?=#)", ""), ("(?<=V)e(?=[sd]#)", ""), ("(?<=VC[^lr])e(?=s#)", ""),
    ("e(?=#)", "<i|i>"), ("ere(?=#)", "<ɪɹ|ɪɹ>"), ("er(?=V)", "<ɛɹ|əɹ>"), ("er", "<ɜɹ|əɹ>"),
    ("e(?=KE)", "<i|ə>"), ("e(?=[aiou])", "<i|i>"), ("e", "<ɛ|ə>"),
    # --- i ---
    ("ire(?=E)", "<I|I><ə|ə>ɹ"), ("ir(?=V)", "<ɪɹ|əɹ>"), ("ir", "<ɜɹ|əɹ>"), ("i(?=n?d#|ld#|gn)", "<I|I>"),
    ("i(?=t[eu]E)", "<I|ə>"), ("i(?=v[e]E)", "<I|ɪ>"), ("i(?=KE)", "<I|ɪ>"), ("i(?=#)", "<i|i>"),
    ("i(?=[aeou])", "<I|i>"), ("i", "<ɪ|ɪ>"),
    # --- o ---
    ("ore(?=E)", "<ɔɹ|əɹ>"), ("or", "<ɔɹ|əɹ>"), ("o(?=ll#|ld|lt)", "<O|O>"), ("o(?=ng#)", "<ɔ|ɔ>"),
    ("o(?=KE)", "<O|O>"), ("o(?=KQ)", "<ɑ|ə>"), ("o(?=KV)", "<O|ə>"), ("o(?=#|s#)", "<O|O>"),
    ("o(?=[aeiu])", "<O|O>"), ("o", "<ɑ|ə>"),
    # --- u ---
    ("(?<=#)u(?=KV)", "j<u|u>"), ("(?<=[bcfghkmpv])ure(?=E)", "j<ʊɹ|əɹ>"), ("ure(?=E)", "<ʊɹ|əɹ>"),
    ("ur", "<ɜɹ|əɹ>"), ("(?<=[pbf])u(?=ll|sh|sh|t#)", "<ʊ|ʊ>"),
    ("(?<=[bcfghkmpv])u(?=KE)", "j<u|u>"), ("u(?=KE)", "<u|u>"), ("u(?=KQ)", "<ʌ|ə>"),
    ("(?<=[bcfghkmpv])u(?=KV)", "j<u|ə>"), ("u(?=KV)", "<u|ə>"), ("u(?=#)", "<u|u>"), ("u(?=[aeio])", "<u|u>"),
    ("u", "<ʌ|ə>"),
    # --- y ---
    ("(?<=#)y(?=V)", "j"), ("(?<=V)y(?=V)", "j"), ("(?<=#C)y(?=#)", "<I|I>"), ("(?<=#CC)y(?=#)", "<I|I>"),
    ("y(?=#|s#)", "<i|i>"), ("y(?=KE)", "<I|I>"), ("y(?=V)", "<I|I>"), ("y", "<ɪ|ɪ>"),
    # --- consonants ---
    ("cc(?=[eiy])", "ks"), ("c(?=[eiy])", "s"), ("cc", "k"), ("c", "k"), ("gg", "ɡ"),
    ("g(?=e#|es#|ed#|[eiy])", "ʤ"), ("g", "ɡ"), ("(?<=#)x", "z"), ("(?<=#e)x(?=V)", "ɡz"), ("x", "ks"),
    ("(?<=V)s(?=[aeiouy]C)", "z"), ("(?<=V)s(?=m)", "z"), ("ss", "s"), ("s", "s"), ("zz", "z"), ("z", "z"),
    ("j", "ʤ"), ("(?<=#)w", "w"), ("w(?=V)", "w"), ("w", ""), ("h(?=#)", ""), ("(?<=[aeiou])h(?=C)", ""),
    ("h", "h"), ("rr", "ɹ"), ("r", "ɹ"), ("ll", "l"), ("l", "l"), ("mm", "m"), ("m", "m"), ("nn", "n"),
    ("n", "n"), ("pp", "p"), ("p", "p"), ("bb", "b"), ("b", "b"), ("dd", "d"), ("d", "d"), ("ff", "f"),
    ("f", "f"), ("vv", "v"), ("v", "v"), ("kk", "k"), ("k", "k"), ("tt", "t"), ("t", "t"), ("q", "k"),
]


def _compile_lts():
    rules = []
    for pat, out in _LTS_RULES_SRC:
        src = pat
        for k, v in _LTS_CLASSES.items():
            src = src.replace(k, v)
        units = re.findall(r"<([^|>]*)\|([^>]*)>|(.)", out)
        rules.append((re.compile(src), [(a, b) if not c else c for a, b, c in units]))
    return rules


_LTS_RULES = None

# Stress: (ending, which syllable) - 0 = the first syllable of the ending, -1 = the syllable before it,
# -2 = two syllables before it. The first ending that matches decides.
_STRESS_ENDINGS = [
    ("ology", 0), ("ologist", 0), ("ologists", 0), ("ography", 0), ("ometer", 0), ("ometry", 0),
    ("onomy", 0), ("osis", 0), ("itis", 0), ("ation", 0), ("ations", 0), ("ition", 0), ("itions", 0),
    ("ution", 0), ("etic", 0), ("atic", 0), ("itic", 0), ("eer", 0), ("eers", 0), ("ese", 0), ("ette", 0),
    ("ettes", 0), ("esque", 0), ("ique", 0), ("oon", 0), ("oons", 0), ("aire", 0), ("ee", 0), ("ees", 0),
    ("ical", -1), ("ically", -1), ("ic", -1), ("ics", -1), ("tion", -1), ("tions", -1), ("sion", -1),
    ("sions", -1), ("ity", -1), ("ities", -1), ("ian", -1), ("ians", -1), ("ial", -1), ("ious", -1),
    ("ient", -1), ("ience", -1), ("ia", -1), ("ify", -1), ("ual", -1), ("uous", -1), ("ible", -1),
    ("cian", -1), ("cial", -1), ("tial", -1), ("cious", -1), ("tious", -1), ("ior", -1),
    ("ary", -2), ("ery", -2), ("ory", -2), ("ate", -2), ("ates", -2), ("ize", -2), ("izes", -2), ("ise", -2),
    ("ous", -2),
]
_LONG = frozenset("AIOWYiu")


def letter_to_sound(word):
    """Phonemes (with stress) for a word not in the lexicon, from spelling rules alone."""
    w = re.sub(r"[^a-z]", "", _strip_accents(word).lower())
    if not w:
        return ""
    # inflections: say the stem, then add the ending the way the lexicon rules do
    if len(w) > 4 and w.endswith("ing") and re.search(r"[aeiouy]", w[:-3]):
        stem = w[:-3]
        if len(stem) > 2 and stem[-1] == stem[-2] and stem[-1] not in "lsz":
            stem = stem[:-1]
        elif re.fullmatch(r"[^aeiouy]*[aeiou][bcdfgkmnprstvz]", stem):
            stem += "e"
        return _suffix_ing(letter_to_sound(stem))
    if len(w) > 4 and w.endswith("ed") and re.search(r"[aeiouy]", w[:-2]):
        stem = w[:-2]
        if stem.endswith("i"):
            stem = stem[:-1] + "y"
        elif len(stem) > 2 and stem[-1] == stem[-2] and stem[-1] not in "lsz":
            stem = stem[:-1]
        elif re.fullmatch(r"[^aeiouy]*[aeiou][bcdfgkmnprstvz]", stem) or re.search(r"[^aeiou][aeiou][cgsvz]$", stem):
            stem += "e"
        return _suffix_ed(letter_to_sound(stem))
    if len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is", "ous")):
        if w.endswith("ies") and len(w) > 4:
            return _suffix_s(letter_to_sound(w[:-3] + "y"))
        if re.search(r"(?:s|x|z|ch|sh)es$", w):
            return _suffix_s(letter_to_sound(w[:-2]))
        return _suffix_s(letter_to_sound(w[:-1]))
    return _lts_core(w)


def _lts_core(w):
    global _LTS_RULES
    if _LTS_RULES is None:
        _LTS_RULES = _compile_lts()
    padded = "#" + w + "#"
    units = []          # consonant strings, or [full, reduced, letter_index] for vowels
    i = 1
    end = len(padded) - 1
    while i < end:
        for rx, out in _LTS_RULES:
            m = rx.match(padded, i)
            if m and m.end() > i:
                for u in out:
                    if isinstance(u, tuple):
                        units.append([u[0], u[1], i - 1])
                    elif u:
                        units.append(u)
                i = m.end()
                break
        else:
            i += 1
    vowels = [k for k, u in enumerate(units) if isinstance(u, list)]
    if not vowels:
        return "".join(units)
    # choose the stressed syllable
    n = len(vowels)
    primary = None
    for ending, where in _STRESS_ENDINGS:
        if w.endswith(ending) and len(w) > len(ending):
            start = len(w) - len(ending)
            first = next((s for s, k in enumerate(vowels) if units[k][2] >= start), None)
            before = sum(1 for k in vowels if units[k][2] < start)
            if where == 0 and first is not None and before > 0:
                primary = first
            elif where < 0 and before > 0:
                primary = max(0, before + where) if before + where >= 0 else 0
            if primary is not None:
                break
    if primary is None:
        if n == 1:
            primary = 0
        elif n == 2:
            primary = 0
        else:
            # Latin rule: a heavy second-to-last syllable takes the stress, else the one before it
            k = vowels[-2]
            nxt = vowels[-1]
            cons = sum(1 for u in units[k + 1:nxt] if isinstance(u, str) for _ in u)
            heavy = units[k][0][:1] in _LONG or cons >= 2
            if w[-1] in "aoi" and not w.endswith("ia"):
                heavy = True
            primary = n - 2 if heavy else n - 3
    secondary = set()
    if primary >= 2:
        secondary.add(0 if primary % 2 == 0 else 1)
    for s in range(primary + 2, n):
        full = units[vowels[s]][0]
        if full[:1] in _LONG and full == units[vowels[s]][1] and s != n - 1 or (s == n - 1 and full[:1] in "AIW" and full == units[vowels[s]][1] and len(full) == 1 and not w.endswith(("y", "ie"))):
            if s - 1 not in secondary:
                secondary.add(s)
    out = []
    for s_idx, k in enumerate(vowels):
        units[k].append(s_idx)
    for u in units:
        if isinstance(u, str):
            out.append(u)
            continue
        full, reduced, _, s = u
        if s == primary:
            out.append(PRIMARY + full)
        elif s in secondary:
            out.append(SECONDARY + full)
        else:
            out.append(reduced)
    ps = "".join(out)
    # American flap: t between a vowel (or r) and an unstressed vowel
    ps = re.sub(r"(?<=[AIOWYiuæɑəɛɪɹʊʌɔɜ])t(?=[əɪiᵊOAI]|ɚ)", "ɾ", ps)
    ps = ps.replace("ɾᵊl", "ɾᵊl")
    return ps


# ----------------------------------------------------------------------------------------------------
# Word lookup
# ----------------------------------------------------------------------------------------------------

class _Ctx:
    """What follows the word being read: future_vowel True / False / None (None = punctuation or end)."""
    __slots__ = ("future_vowel", "future_to")

    def __init__(self, future_vowel=None, future_to=False):
        self.future_vowel = future_vowel
        self.future_to = future_to


_END = _Ctx()

# Small all-caps words that are far more often an emphasized word than an acronym ("I said NO").
_CAPS_WORDS = frozenset("""A I AM AN AND ARE AS AT BAD BE BIG BUT BUY BY CAN DAY DID DO DOG FOR FUN GET GO GOD GOT
HAD HAS HE HER HEY HIM HIS HOT HOW IF IN IS IT'S LET LOT MAY ME MY NEW NO NOT NOW OF OFF OH OK OLD ON ONE OR OUR OUT
OWN PUT RUN SAY SEE SHE SO THE TOO TRY TWO WAS WAY WE WHO WHY WIN WON YES YET YOU""".split())


def _known(w):
    W = _lex().words
    return w in W or w.lower() in W or (len(w) == 1 and w.isalpha())


def _lookup(w, stress, ctx):
    """Lexicon lookup: exact spelling, then lowercase; phrase-final variants; then the cap stress."""
    lex = _lex()
    W = lex.words
    low = w.lower()
    ps = None
    if ctx is not None and ctx.future_vowel is None:
        ps = lex.final.get(w) or lex.final.get(low)
    if ps is None:
        ps = W.get(w)
    if ps is None:
        ps = W.get(low)
    if ps is None and len(w) == 1 and w.isalpha():
        ps = W.get(w.upper())
    if ps is None:
        return None
    return apply_stress(ps, stress)


def _stem_s(w, stress, ctx):
    if len(w) < 3 or not w.endswith("s"):
        return None
    if not w.endswith("ss") and _known(w[:-1]):
        stem = w[:-1]
    elif (w.endswith("'s") or (len(w) > 4 and w.endswith("es") and not w.endswith("ies"))) and _known(w[:-2]):
        stem = w[:-2]
    elif len(w) > 4 and w.endswith("ies") and _known(w[:-3] + "y"):
        stem = w[:-3] + "y"
    else:
        return None
    return _suffix_s(_lookup(stem, stress, ctx))


def _stem_ed(w, stress, ctx):
    if len(w) < 4 or not w.endswith("d"):
        return None
    if not w.endswith("dd") and _known(w[:-1]):
        stem = w[:-1]
    elif len(w) > 4 and w.endswith("ed") and not w.endswith("eed") and _known(w[:-2]):
        stem = w[:-2]
    elif len(w) > 5 and w.endswith("ied") and _known(w[:-3] + "y"):
        stem = w[:-3] + "y"
    elif len(w) > 5 and w.endswith("ed") and w[-3] == w[-4] and w[-3] not in "aeiouy" and _known(w[:-3]):
        stem = w[:-3]
    else:
        return None
    return _suffix_ed(_lookup(stem, stress, ctx))


def _stem_ing(w, stress, ctx):
    if len(w) < 5 or not w.endswith("ing"):
        return None
    if len(w) > 5 and _known(w[:-3]):
        stem = w[:-3]
    elif _known(w[:-3] + "e"):
        stem = w[:-3] + "e"
    elif len(w) > 5 and re.search(r"([bcdgklmnprstvxz])\1ing$|cking$", w) and _known(w[:-4]):
        stem = w[:-4]
    elif w.endswith("ying") and len(w) > 5 and _known(w[:-4] + "ie"):
        stem = w[:-4] + "ie"
    else:
        return None
    return _suffix_ing(_lookup(stem, stress, ctx))


def _get_word(w, stress, ctx):
    """misaki's get_word without part-of-speech: lexicon, then -s / -ed / -ing on a known stem."""
    if _known(w):
        return _lookup(w, stress, ctx)
    if w.endswith("s'") and _known(w[:-2] + "'s"):
        return _lookup(w[:-2] + "'s", stress, ctx)
    if w.endswith("'") and _known(w[:-1]):
        return _lookup(w[:-1], stress, ctx)
    for fn in (_stem_s, _stem_ed):
        ps = fn(w, stress, ctx)
        if ps:
            return ps
    return _stem_ing(w, 0.5 if stress is None else stress, ctx)


# endings added to a known word: (ending, phonemes, ending starts with a vowel sound)
_SUFFIXES = [
    ("fully", "fəli", False), ("ingly", "ɪŋli", True), ("ments", "mənts", False), ("ness", "nəs", False),
    ("less", "ləs", False), ("ment", "mənt", False), ("ful", "fəl", False), ("ably", "əbli", True),
    ("able", "əbᵊl", True), ("ers", "əɹz", True), ("er", "əɹ", True), ("est", "əst", True),
    ("ly", "li", False), ("ish", "ɪʃ", True), ("isms", "ˌɪzəmz", True), ("ism", "ˌɪzəm", True),
    ("ists", "ɪsts", True), ("ist", "ɪst", True), ("ships", "ʃˌɪps", False), ("ship", "ʃˌɪp", False),
    ("hood", "hˌʊd", False), ("dom", "dəm", False), ("wise", "wˌIz", False), ("like", "lˌIk", False),
    ("wards", "wəɹdz", False), ("ward", "wəɹd", False), ("y", "i", True), ("ings", "ɪŋz", True),
    ("ize", "ˌIz", True), ("izes", "ˌIzᵻz", True), ("ized", "ˌIzd", True), ("izing", "ˌIzɪŋ", True),
    ("ers'", "əɹz", True), ("er's", "əɹz", True),
]
_PREFIXES = [
    ("under", "ˌʌndəɹ"), ("over", "ˌOvəɹ"), ("inter", "ˌɪntəɹ"), ("super", "sˌupəɹ"), ("counter", "kˌWntəɹ"),
    ("micro", "mˌIkɹO"), ("multi", "mˌʌlti"), ("cyber", "sˌIbəɹ"), ("hyper", "hˌIpəɹ"), ("anti", "ˌænti"),
    ("semi", "sˌɛmi"), ("mega", "mˌɛɡə"), ("mini", "mˌɪni"), ("auto", "ˌɔɾO"), ("tele", "tˌɛlə"),
    ("trans", "tɹˌænz"), ("self", "sˌɛlf"), ("post", "pˌOst"), ("non", "nˌɑn"), ("out", "ˌWt"),
    ("dis", "dˌɪs"), ("mis", "mˌɪs"), ("pre", "pɹˌi"), ("un", "ˌʌn"), ("re", "ɹˌi"), ("co", "kˌO"),
    ("de", "dˌi"), ("up", "ˌʌp"), ("bio", "bˌIO"), ("eco", "ˌikO"), ("sub", "sˌʌb"), ("ex", "ˌɛks"),
]


def _with_suffix(w, stress, ctx, depth):
    for suf, sps, vowel_start in _SUFFIXES:
        if not w.endswith(suf) or len(w) - len(suf) < 2:
            continue
        stem = w[:-len(suf)]
        cands = [stem]
        if suf.startswith(("e", "i", "a", "y")):
            cands.append(stem + "e")
        if len(stem) > 2 and stem[-1] == stem[-2] and stem[-1] not in "aeiouls":
            cands.append(stem[:-1])
        if stem.endswith("i"):
            cands.append(stem[:-1] + "y")
        if suf == "ly" and not stem.endswith("l"):
            cands.append(stem + "le")
        if suf in ("ly", "ness") and stem.endswith("al"):
            cands.append(stem)
        for c in cands:
            if len(c) < 2:
                continue
            ps = _core(c, stress, None, depth + 1, allow_lts=False)
            if not ps:
                continue
            if suf == "ly" and c.endswith("le") and c not in (stem,):
                ps = re.sub(r"[ᵊə]l$", "", ps)
            if vowel_start and len(ps) > 1 and ps[-1] == "t" and ps[-2] in US_TAUS and ps[-2] != "ɹ" or \
                    (vowel_start and len(ps) > 1 and ps[-1] == "t" and ps[-2] == "ɹ"):
                ps = ps[:-1] + "ɾ"
            if c.endswith("y") and stem.endswith("i") and ps.endswith("i") and suf in ("er", "est", "ers"):
                ps = ps + ""
            return ps + sps
    return None


def _with_prefix(w, stress, ctx, depth):
    for pre, pps in _PREFIXES:
        rest = w[len(pre):]
        if w.startswith(pre) and len(rest) >= 3:
            ps = _core(rest, None, ctx, depth + 1, allow_lts=False)
            if ps:
                return pps + ps
    return None


def _compound(w, ctx, depth):
    """Two (or three) known words written together: first part primary, the rest secondary."""
    n = len(w)
    for i in range(n - 3, 2, -1):
        a, b = w[:i], w[i:]
        if not (_known(a) and len(a) >= 3):
            continue
        pb = _lookup(b, None, ctx) if _known(b) else (_compound(b, ctx, depth + 1) if depth < 2 else None)
        if not pb:
            continue
        pa = _lookup(a, None, None)
        return _join_parts([pa, pb], [a, b])
    return None


def _join_parts(pss, texts):
    """misaki's resolve_tokens for pieces of one word: when every piece carries a primary stress,
    the lighter half is demoted to secondary."""
    pss = list(pss)
    idx = [(PRIMARY in p, stress_weight(p), i) for i, p in enumerate(pss) if p]
    if len(idx) == 2 and len(texts[idx[0][2]]) == 1:
        i = idx[1][2]
        pss[i] = apply_stress(pss[i], -0.5)
    elif len(idx) >= 2 and sum(b for b, _, _ in idx) > (len(idx) + 1) // 2:
        for _, _, i in sorted(idx)[:len(idx) // 2]:
            pss[i] = apply_stress(pss[i], -0.5)
    return "".join(p for p in pss if p)


def _core(w, stress, ctx, depth=0, allow_lts=True):
    """Lexicon + morphology for one alphabetic word (may contain apostrophes)."""
    ps = _get_word(w, stress, ctx)
    if ps:
        return ps
    low = w.lower()
    if low != w:
        ps = _get_word(low, stress, ctx)
        if ps:
            return ps
    if depth > 2:
        return None
    m = re.fullmatch(r"(.+?)(n't|'ll|'re|'ve|'d|'m|'s|s')", low)
    if m:
        base, suf = m.groups()
        bps = _core(base, stress, None, depth + 1, allow_lts)
        if bps:
            v = _ends_vowel(bps)
            if suf == "n't":
                return bps + ("nt" if v else "ᵊnt")
            if suf == "'ll":
                return bps + ("l" if v else "ᵊl")
            if suf == "'re":
                return bps + ("ɹ" if v else "əɹ")
            if suf == "'ve":
                return bps + ("v" if v else "əv")
            if suf == "'d":
                return bps + ("d" if v else "ᵻd")
            if suf == "'m":
                return bps + "m"
            return _suffix_s(bps)
    low = low.replace("'", "")
    ps = _with_suffix(low, stress, ctx, depth) or _with_prefix(low, stress, ctx, depth) or _compound(low, ctx, depth)
    if ps:
        return ps
    if allow_lts:
        return apply_stress(letter_to_sound(low), stress)
    return None


def _special(w, ctx):
    """Function words whose reading depends on what follows (misaki's get_special_case, without tags)."""
    if w in ("a", "A"):
        return "ɐ" if (w == "a" or ctx.future_vowel is not None) else "ˈA"
    if w in ("an", "An", "AN"):
        return "ɐn"
    if w == "I":
        return SECONDARY + "I"
    if w in ("am", "Am", "AM"):
        return "ɐm" if (w == "am" and ctx.future_vowel is not None) else _lex().words.get("am", "æm")
    if w in ("to", "To", "TO"):
        return {None: _lex().words.get("to", "tu"), False: "tə", True: "tʊ"}[ctx.future_vowel]
    if w in ("in", "In", "IN"):
        return (PRIMARY if ctx.future_vowel is None else "") + "ɪn"
    if w in ("the", "The", "THE"):
        return "ði" if ctx.future_vowel is True else "ðə"
    if w.lower() in ("vs", "vs."):
        return _lookup("versus", None, ctx)
    if w in ("used", "Used", "USED"):
        return "jˈust" if ctx.future_to else "jˈuzd"
    return None


def word_phonemes(word, ctx=None, shout=False):
    """Phonemes for one written word (letters, apostrophes, hyphens, digits mixed in)."""
    ctx = ctx or _END
    word = word.replace("’", "'").replace("‘", "'")
    if not word:
        return ""
    sp = _special(word, ctx)
    if sp is not None:
        return sp
    W = _lex().words
    if any(c.isdigit() for c in word):
        return _alnum(word, ctx)
    if "-" in word.strip("-"):
        parts = [p for p in word.split("-") if p]
        whole = _get_word(word, None, ctx) or _get_word(word.lower(), None, ctx)
        if whole:
            return whole
        pss = []
        for k, p in enumerate(parts):
            c = ctx if k == len(parts) - 1 else _Ctx(True)
            pss.append(word_phonemes(p, c, shout))
        return _join_parts(pss, parts)
    word = word.strip("-")
    letters = word.replace("'", "")
    if not letters:
        return ""
    if not letters.isascii():
        if word in W or word.lower() in W:
            return _lookup(word, None, ctx)
        word = _strip_accents(word)
        letters = word.replace("'", "")
    stress = None if word == word.lower() else (2 if word == word.upper() else 0.5)
    if len(letters) > 1 and letters.isupper():
        return _caps(word, ctx, shout)
    if len(letters) == 1:
        if word in W and word != word.upper():
            return W[word]
        return W.get(letters.upper(), "")
    ps = _get_word(word, stress, ctx)
    if ps:
        return ps
    # mixed case: iPhone, YouTube, McDonald, COFfee -> the lowercase word, or its pieces
    if word != word.lower() and word[1:] != word[1:].lower():
        ps = _get_word(word.lower(), stress, ctx)
        if ps:
            return ps
        pieces = re.findall(r"[A-Z]?[a-z']+|[A-Z]+(?![a-z])", word)
        if len(pieces) > 1:
            return _join_parts([word_phonemes(p, ctx, shout) for p in pieces], pieces)
    return _core(word, stress, ctx)


def _caps(word, ctx, shout):
    """ALL-CAPS: a listed acronym, an emphasized word, or letters spelled out."""
    W = _lex().words
    letters = word.replace("'", "")
    if word in W:
        return apply_stress(W[word], 2)
    low = word.lower()
    if "'" in word or shout or len(letters) >= 4 or word in _CAPS_WORDS:
        ps = _get_word(low, 2, ctx)
        if ps:
            return ps
        if "'" in word:
            return _core(low, 2, ctx)
        if shout and re.search(r"[AEIOUY]", word) and len(letters) >= 4:
            return apply_stress(letter_to_sound(low), 2)
    m = re.fullmatch(r"([A-Z]{2,})(s|'s)", word)
    if m:
        return _suffix_s(_spell(m.group(1)))
    return _spell(letters)


def _alnum(word, ctx):
    """Letters and digits mixed: MP3, B2B, COVID-19, 4G."""
    pieces = re.findall(r"\d+|[^\W\d_]+(?:'[^\W\d_]+)*", word)
    out = []
    for k, p in enumerate(pieces):
        if p.isdigit():
            if p == "2" and 0 < k < len(pieces) - 1 and not pieces[k - 1].isdigit() and not pieces[k + 1].isdigit():
                out.append(_words_ps(["to"]))
            elif len(p) == 4 and k > 0:
                out.append(_words_ps(year_words(int(p)) if p[0] != "0" else digit_words(p)))
            elif len(p) > 1 and p[0] == "0":
                out.append(_words_ps(digit_words(p)))
            else:
                out.append(_words_ps(cardinal_words(int(p))))
        else:
            out.append(word_phonemes(p, ctx))
    return " ".join(o for o in out if o)


def _words_ps(words, ctx=None):
    """Phonemes of plain English words (number words, expansions), joined by spaces."""
    out = []
    for k, w in enumerate(words):
        c = ctx if k == len(words) - 1 else None
        if c is None:
            c = _Ctx(_starts_vowel(_lookup(words[k + 1], None, None) or "")) if k + 1 < len(words) else (ctx or _END)
        ps = _special(w, c)
        if ps is None:
            ps = _lookup(w, -2 if w == "point" else None, c if k == len(words) - 1 else None)
        if ps is None:
            ps = word_phonemes(w, c)
        out.append(ps)
    return " ".join(p for p in out if p)


def _starts_vowel(ps):
    for c in ps:
        if c in VOWELS:
            return True
        if c in CONSONANTS:
            return False
        if c in NON_QUOTE_PUNCTS:
            return None
    return None


# ----------------------------------------------------------------------------------------------------
# Text -> tokens
# ----------------------------------------------------------------------------------------------------

_ABBREV = {   # with the period; lowercase keys
    "mr.": ["mister"], "mrs.": ["missus"], "ms.": ["miz"], "dr.": ["doctor"], "prof.": ["professor"],
    "jr.": ["junior"], "sr.": ["senior"], "mt.": ["mount"], "ave.": ["avenue"], "blvd.": ["boulevard"],
    "rd.": ["road"], "etc.": ["etc."], "vs.": ["versus"], "e.g.": ["for", "example"], "i.e.": ["that", "is"],
    "approx.": ["approximately"], "dept.": ["department"], "govt.": ["government"], "inc.": ["incorporated"],
    "ltd.": ["limited"], "corp.": ["corporation"], "est.": ["established"], "fig.": ["figure"],
    "a.m.": ["a.m."], "p.m.": ["p.m."], "gen.": ["general"], "gov.": ["governor"], "sen.": ["senator"],
    "rep.": ["representative"], "capt.": ["captain"], "lt.": ["lieutenant"], "sgt.": ["sergeant"],
    "col.": ["colonel"], "min.": ["minutes"], "hr.": ["hour"], "hrs.": ["hours"], "sec.": ["seconds"],
    "jan.": ["january"], "feb.": ["february"], "mar.": ["march"], "apr.": ["april"], "jun.": ["june"],
    "jul.": ["july"], "aug.": ["august"], "sep.": ["september"], "sept.": ["september"], "oct.": ["october"],
    "nov.": ["november"], "dec.": ["december"], "no.": ["number"], "st.": ["saint"], "co.": ["company"],
    "w/": ["with"], "w/o": ["without"], "a.k.a.": ["a.k.a."],
}
_TITLES = {"mr.", "mrs.", "ms.", "dr.", "prof.", "st.", "mt.", "gen.", "gov.", "sen.", "rep.", "capt.", "lt.",
           "sgt.", "col.", "no."}
_NEED_DIGIT = {"no.", "jan.", "feb.", "mar.", "apr.", "jun.", "jul.", "aug.", "sep.", "sept.", "oct.", "nov.",
               "dec.", "min.", "hr.", "hrs.", "sec.", "fig."}
_UNITS = {
    "km": "kilometers", "kg": "kilograms", "cm": "centimeters", "mm": "millimeters", "mph": "miles per hour",
    "kph": "kilometers per hour", "lbs": "pounds", "lb": "pounds", "oz": "ounces", "ft": "feet",
    "gb": "gigabytes", "mb": "megabytes", "tb": "terabytes", "kb": "kilobytes", "ghz": "gigahertz",
    "mhz": "megahertz", "hz": "hertz", "mins": "minutes", "min": "minutes", "hrs": "hours", "hr": "hours",
    "sec": "seconds", "secs": "seconds", "ms": "milliseconds", "ml": "milliliters", "mg": "milligrams",
    "k": "thousand", "m": "million", "bn": "billion", "x": "times",
}
_SINGULAR_UNIT = {"kilometers": "kilometer", "kilograms": "kilogram", "centimeters": "centimeter",
                  "millimeters": "millimeter", "pounds": "pound", "ounces": "ounce", "feet": "foot",
                  "gigabytes": "gigabyte", "megabytes": "megabyte", "terabytes": "terabyte",
                  "kilobytes": "kilobyte", "minutes": "minute", "hours": "hour", "seconds": "second",
                  "milliseconds": "millisecond", "milliliters": "milliliter", "milligrams": "milligram",
                  "dollars": "dollar", "cents": "cent", "euros": "euro", "pounds sterling": "pound"}
_CURRENCY = {"$": ("dollars", "cents"), "£": ("pounds", "pence"), "€": ("euros", "cents"),
             "¥": ("yen", "sen"), "₹": ("rupees", "paise")}
_SCALE_WORDS = {"thousand", "million", "billion", "trillion", "k", "m", "bn"}

_TOKEN_RE = re.compile(r"""
   (?P<url>(?:https?://|www\.)[^\s"“”()<>]+[^\s"“”()<>.,!?;:]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)
  |(?P<money>[$£€¥₹]\s?\d[\d,]*(?:\.\d+)?)
  |(?P<time>\d{1,2}:\d{2}(?::\d{2})?)
  |(?P<decade>'\d0s)
  |(?P<num>\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th|s|'s)?(?![\w])|\.\d+)
  |(?P<abbr>(?:[A-Za-z]\.){2,}|(?:Mrs|Mr|Ms|Dr|Prof|Jr|Sr|Mt|Ave|Blvd|Rd|etc|vs|approx|Dept|Govt|Inc|Ltd|Corp|Est|Fig
     |Gen|Gov|Sen|Rep|Capt|Lt|Sgt|Col|Min|Hrs|Hr|Sec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec|No|St|Co)\.
     (?=\s|$|[,;:!?)"”])|w/o|w/(?=\s))
  |(?P<word>(?:'(?:cause|em|til|bout|round|tis|twas|n|kay|cuz|sup|nother)(?![\w']))
     |[^\W_](?:[\w]|'(?=[^\W\d_]))*(?:-[^\W_](?:[\w]|'(?=[^\W\d_]))*)*'?)
  |(?P<punct>\.\.\.|[.,!?;:—…"“”()\[\]{}«»¡¿]|--+|-|–)
  |(?P<sym>[&%+=@#/*°×])
""", re.X | re.I)


class Token:
    __slots__ = ("text", "kind", "ws", "ps", "words")

    def __init__(self, text, kind, ws="", words=None):
        self.text, self.kind, self.ws, self.ps, self.words = text, kind, ws, None, words

    def __repr__(self):
        return f"Token({self.text!r}, {self.kind}, ws={self.ws!r}, ps={self.ps!r})"


def _normalize(text):
    text = unicodedata.normalize("NFKC", text)
    text = (text.replace("’", "'").replace("‘", "'").replace("ʼ", "'").replace("`", "'")
            .replace("。", ". ").replace("、", ", ").replace("«", "“").replace("»", "”")
            .replace(" ", " ").replace("−", "-").replace("_", " "))
    text = re.sub(r"(?<=\d)\s*[–—-]\s*(?=\d)", "-", text)     # ranges keep a plain hyphen
    text = text.replace("–", "—")
    # straight double quotes become curly ones: opening after a space or start, closing otherwise
    out, opened = [], False
    for k, ch in enumerate(text):
        if ch == '"':
            prev = text[k - 1] if k else " "
            opening = prev.isspace() or prev in "([{—" or not opened
            if opened and not (prev.isspace() or prev in "([{—"):
                opening = False
            out.append("“" if opening else "”")
            opened = opening
        else:
            out.append(ch)
    return "".join(out)


def tokenize(text):
    """Split text into Token objects (kind: word, num, money, time, decade, abbr, url, punct, sym)."""
    text = _normalize(text)
    toks = []
    pos = 0
    for m in _TOKEN_RE.finditer(text):
        gap = text[pos:m.start()]
        if toks and gap:
            if "\n" in gap and toks[-1].kind not in ("punct",):
                toks.append(Token(".", "punct"))
            if gap.strip() == "" or True:
                toks[-1].ws = toks[-1].ws or (" " if any(c.isspace() for c in gap) else "")
        kind = m.lastgroup
        toks.append(Token(m.group(), kind))
        pos = m.end()
    return toks


def _num_value(s):
    return s.replace(",", "")


def _expand_number(tok, nxt, prev):
    """Words for a number token; may mark the following token as consumed (units, %)."""
    t = tok.text
    suffix = ""
    m = re.fullmatch(r"(.*?)(st|nd|rd|th|'s|s)", t, re.I)
    if m and m.group(1) and m.group(1)[-1].isdigit():
        t, suffix = m.group(1), m.group(2).lower()
    raw = _num_value(t)
    if suffix in ("st", "nd", "rd", "th"):
        return ordinal_words(int(raw)), ""
    if raw.startswith("."):
        words = ["point"] + digit_words(raw[1:])
    elif "." in raw:
        whole, frac = raw.split(".", 1)
        words = cardinal_words(int(whole)) + ["point"] + digit_words(frac)
    elif len(raw) == 4 and "," not in t and not (nxt and nxt.text == "%") and raw[0] != "0":
        words = year_words(int(raw))
    elif len(raw) > 1 and raw[0] == "0":
        words = digit_words(raw)
    else:
        words = cardinal_words(int(raw))
    return words, suffix


def _say_s(words_ps):
    return _suffix_s(words_ps)


def _phrase(tokens):
    """Turn tokens into (phonemes, whitespace) pieces, reading right to left for the context rules."""
    n = len(tokens)
    alpha = [t.text for t in tokens if t.kind == "word" and sum(c.isalpha() for c in t.text) >= 2]
    shout = len(alpha) >= 3 and sum(1 for a in alpha if a.replace("'", "").isupper()) >= 0.6 * len(alpha)
    # pass 1 (left to right): expand numbers, abbreviations and symbols into words
    items = []        # [kind, payload, ws]; kind: 'w' word text, 'ws' plain words list, 'ps' phonemes, 'p' punct
    skip = 0
    for k, tok in enumerate(tokens):
        if skip:
            skip -= 1
            if skip == 0 and items:
                items[-1][2] = tok.ws
            continue
        nxt = tokens[k + 1] if k + 1 < n else None
        nxt2 = tokens[k + 2] if k + 2 < n else None
        prev = tokens[k - 1] if k else None
        kind, text, ws = tok.kind, tok.text, tok.ws
        if kind == "word":
            items.append(["w", text, ws])
        elif kind == "punct":
            if text in ("...", "…"):
                items.append(["p", "…", ws])
            elif text in ("-", "--", "---", "–") or text.startswith("--"):
                if (prev and prev.kind in ("num", "money") and nxt and nxt.kind in ("num", "money")
                        and not prev.ws and not ws):
                    items.append(["ws", ["to"], ws])
                elif prev and prev.ws == "" and ws == "" and text == "-":
                    items.append(["p", "", ws])
                else:
                    items.append(["p", "—", " "])
                    if items and len(items) > 1 and items[-2][2] == "":
                        items[-2][2] = " "
            elif text in "[{":
                items.append(["p", "(", ws])
            elif text in "]}":
                items.append(["p", ")", ws])
            elif text in "¡¿":
                continue
            else:
                items.append(["p", text, ws])
        elif kind == "sym":
            if text == "%":
                items.append(["ws", ["percent"], ws])
            elif text == "&":
                items.append(["ws", ["and"], ws])
            elif text == "+":
                items.append(["ws", ["plus"], ws])
            elif text == "=":
                items.append(["ws", ["equals"], ws])
            elif text == "@":
                items.append(["ws", ["at"], ws])
            elif text == "×":
                items.append(["ws", ["times"], ws])
            elif text == "°":
                items.append(["ws", ["degrees"], ws])
            elif text == "#":
                if nxt and nxt.kind == "num":
                    items.append(["ws", ["number"], " "])
            elif text == "/":
                if prev and nxt and prev.kind == "word" and nxt.kind == "word":
                    items.append(["ws", ["or"], " "])
                    if items and len(items) > 1:
                        items[-2][2] = " "
                elif prev and nxt and prev.kind == "num" and nxt.kind == "num":
                    items.append(["ws", ["slash"] if not ws and not prev.ws else [], " "])
                    if len(items) > 1:
                        items[-2][2] = " "
            continue_flag = True
        elif kind == "url":
            items.append(["ws", _url_words(text), ws])
        elif kind == "abbr":
            low = text.lower()
            if low in _NEED_DIGIT and not (nxt and nxt.kind in ("num", "time")):
                items.append(["w", text[:-1], ""])
                items.append(["p", ".", ws])
                continue
            if low == "st." and nxt and nxt.kind == "word" and not nxt.text[:1].isupper():
                words = ["street"]
            elif low == "st." and prev and prev.kind == "word" and prev.text[:1].isupper() and not (nxt and nxt.kind == "word" and nxt.text[:1].isupper()):
                words = ["street"]
            elif low in _ABBREV:
                words = _ABBREV[low]
            elif re.fullmatch(r"(?:[a-z]\.){2,}", low):
                words = None
            else:
                words = [low]
            if words is None:
                items.append(["ps", _spell(text.replace(".", "")), ws])
            elif words in (["a.m."], ["p.m."], ["etc."], ["a.k.a."]):
                items.append(["ps", _lookup(words[0], None, None) or _spell(words[0].replace(".", "")), ws])
            else:
                items.append(["ws", list(words), ws])
            # an abbreviation that ends the sentence also ends it in speech
            ends = nxt is None or (nxt.kind == "word" and nxt.text[:1].isupper() and low not in _TITLES and ws)
            if ends and low not in _TITLES and low not in ("e.g.", "i.e.", "vs."):
                items.append(["p", ".", ws])
                items[-2][2] = ""
        elif kind == "money":
            cur = text[0]
            amount = _num_value(text[1:].strip())
            unit, sub = _CURRENCY.get(cur, ("dollars", "cents"))
            scale = nxt.text.lower() if nxt and nxt.kind == "word" and nxt.text.lower() in _SCALE_WORDS else None
            if scale:
                sw = {"k": "thousand", "m": "million", "bn": "billion"}.get(scale, scale)
                if "." in amount:
                    w0, f0 = amount.split(".", 1)
                    words = cardinal_words(int(w0)) + ["point"] + digit_words(f0)
                else:
                    words = cardinal_words(int(amount))
                items.append(["ws", words + [sw, unit], nxt.ws])
                skip = 1
                continue
            if "." in amount:
                w0, f0 = amount.split(".", 1)
                w0 = int(w0 or 0)
                cents = int((f0 + "0")[:2]) if len(f0) <= 2 else None
            else:
                w0, cents = int(amount), 0
            if cents is None:
                words = cardinal_words(w0) + ["point"] + digit_words(f0) + [unit]
            else:
                words = []
                if w0 or not cents:
                    words += cardinal_words(w0) + [_SINGULAR_UNIT.get(unit, unit) if w0 == 1 else unit]
                if cents:
                    if words:
                        words.append("and")
                    words += cardinal_words(cents) + [_SINGULAR_UNIT.get(sub, sub) if cents == 1 else sub]
            items.append(["ws", words, ws])
        elif kind == "time":
            parts = text.split(":")
            h, mnt = int(parts[0]), parts[1]
            words = cardinal_words(h)
            ampm = None
            if nxt and nxt.kind in ("word", "abbr") and nxt.text.lower().replace(".", "") in ("am", "pm"):
                ampm = nxt.text.lower().replace(".", "")
            if mnt == "00":
                if not ampm:
                    words = words + ["o'clock"]
            elif mnt[0] == "0":
                words = words + ["oh", _ONES[int(mnt[1])]]
            else:
                words = words + _under_100(int(mnt))
            if len(parts) > 2 and parts[2] != "00":
                words = words + ["and"] + cardinal_words(int(parts[2])) + ["seconds"]
            if ampm:
                items.append(["ws", words, " "])
                items.append(["ps", _lookup(ampm[0] + ".m.", None, None), nxt.ws])
                skip = 1
                if nxt.text.endswith(".") and (nxt2 is None or nxt2.text[:1].isupper()):
                    items.append(["p", ".", nxt.ws])
                    items[-2][2] = ""
                continue
            items.append(["ws", words, ws])
        elif kind == "decade":
            items.append(["ps", _suffix_s(_words_ps(_under_100(int(text[1:3]))).replace("i", "i")), ws])
            items[-1][1] = _decade(text[1:3])
        elif kind == "num":
            words, suffix = _expand_number(tok, nxt, prev)
            if nxt and nxt.kind == "sym" and nxt.text == "%":
                items.append(["ws", words + ["percent"], nxt.ws])
                skip = 1
                continue
            if nxt and nxt.kind == "word" and not ws and nxt.text.lower() in ("am", "pm") or (
                    nxt and nxt.kind == "abbr" and nxt.text.lower() in ("a.m.", "p.m.")):
                items.append(["ws", words, " "])
                ap = nxt.text.lower().replace(".", "")
                items.append(["ps", _lookup(ap[0] + ".m.", None, None), nxt.ws])
                skip = 1
                if nxt.text.endswith(".") and (nxt2 is None or nxt2.text[:1].isupper()):
                    items.append(["p", ".", nxt.ws])
                    items[-2][2] = ""
                continue
            unit = None
            if nxt and nxt.kind == "word" and nxt.text.lower() in _UNITS and (not ws or nxt.text.lower() in ("mph", "kph", "km", "kg", "cm", "mm", "lbs", "ft", "gb", "mb", "tb")):
                unit = _UNITS[nxt.text.lower()]
                if unit in _SINGULAR_UNIT and words == ["one"]:
                    unit = _SINGULAR_UNIT[unit]
            if nxt and nxt.kind == "sym" and nxt.text == "°":
                unit = "degrees"
            if unit:
                items.append(["ws", words + unit.split(), nxt.ws])
                skip = 1
                continue
            if suffix in ("s", "'s"):
                items.append(["ps", _suffix_s(_words_ps(words)), ws])
            else:
                items.append(["ws", words, ws])
        else:
            items.append(["w", text, ws])

    # pass 2 (right to left): phonemes with context
    ctx = _END
    out = [None] * len(items)
    for k in range(len(items) - 1, -1, -1):
        kind, payload, ws = items[k]
        if kind == "p":
            out[k] = (payload, ws)
            if payload and payload not in "\"“”":
                ctx = _Ctx(None, False)
            continue
        if kind == "w":
            ps = word_phonemes(payload, ctx, shout)
            future_to = payload in ("to", "To") or payload == "TO"
        elif kind == "ws":
            ps = _words_ps(payload, ctx) if payload else ""
            future_to = bool(payload) and payload[0] == "to"
        else:
            ps = payload or ""
            future_to = False
        out[k] = (ps, ws)
        if ps:
            v = _starts_vowel(ps)
            ctx = _Ctx(v if v is not None else ctx.future_vowel, future_to)
    return out


def _decade(two):
    """'90s -> nineties"""
    words = _under_100(int(two))
    ps = _words_ps(words)
    return _suffix_s(ps)


def _url_words(text):
    t = re.sub(r"^https?://", "", text)
    words = []
    for part in re.split(r"([./@:_-])", t):
        if not part:
            continue
        words.append({".": "dot", "/": "slash", "@": "at", ":": "colon", "_": "underscore", "-": "dash"}.get(part, part))
    return words


def phonemize(text, flap="T"):
    """American English text -> Kokoro/misaki phoneme string (stress marks and punctuation kept).

    flap: how to write the American flap; "T" is what Kokoro v1.0 was trained on (misaki writes ɾ in its
    dictionaries and switches to T for Kokoro v1.0, along with ʔ -> t). Pass "ɾ" to keep misaki's spelling.
    """
    if not text or not text.strip():
        return ""
    pieces = _phrase(tokenize(text))
    s = []
    for ps, ws in pieces:
        if ps is None:
            continue
        if ps and ps[0] in ",.!?;:…)”" and s and s[-1] == " ":
            s.pop()
        s.append(ps)
        if ws:
            s.append(" ")
    out = "".join(s)
    out = re.sub(r"\s+", " ", out).strip()
    out = re.sub(r"\s+([,.!?;:…])", r"\1", out)
    out = re.sub(r"([,.!?;:])(?=[^\s,.!?;:…”)\"])", r"\1 ", out)
    if flap == "T":
        out = out.replace("ɾ", "T").replace("ʔ", "t")
    return "".join(c for c in out if c in VOCAB)


# ----------------------------------------------------------------------------------------------------
# Synthesis
# ----------------------------------------------------------------------------------------------------

def split_phonemes(ps, limit=MAX_TOKENS):
    """Split a phoneme string into chunks of at most `limit` symbols, at sentence ends if possible,
    then clause marks, then spaces. Returns [(chunk, pause_seconds_after)]."""
    ps = ps.strip()
    if not ps:
        return []
    sentences = [s.strip() for s in re.split(r"(?<=[.!?…])\s+", ps) if s.strip()]
    atoms = []
    for s in sentences:
        if len(s) <= limit:
            atoms.append(s)
            continue
        for c in re.split(r"(?<=[,;:—])\s+", s):
            while len(c) > limit:
                cut = c.rfind(" ", 0, limit)
                cut = cut if cut > 0 else limit
                atoms.append(c[:cut].strip())
                c = c[cut:].strip()
            if c:
                atoms.append(c)
    chunks = []
    cur = ""
    for a in atoms:
        if cur and len(cur) + 1 + len(a) > limit:
            chunks.append(cur)
            cur = a
        else:
            cur = (cur + " " + a) if cur else a
    if cur:
        chunks.append(cur)
    out = []
    for c in chunks:
        last = c.rstrip()[-1:]
        pause = 0.3 if last in ".!?…" else 0.15 if last in ",;:—" else 0.05
        out.append((c, pause))
    return out


class KokoroLite:
    """Kokoro-82M on onnxruntime. Works with the kokoro-onnx export (input "tokens") and the
    onnx-community export (input "input_ids"); voices from voices-v1.0.bin (an npz archive) or a
    directory of <voice>.bin files (float32 [510, 1, 256])."""

    def __init__(self, model_path, voices_path_or_dir, providers=None, threads=None):
        import numpy as np
        import onnxruntime as ort
        self._np = np
        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = int(threads)
        self.sess = ort.InferenceSession(model_path, sess_options=opts,
                                         providers=providers or ["CPUExecutionProvider"])
        types = {"tensor(float)": np.float32, "tensor(float16)": np.float16, "tensor(double)": np.float64,
                 "tensor(int32)": np.int32, "tensor(int64)": np.int64}
        self._inputs = {i.name: types.get(i.type, np.float32) for i in self.sess.get_inputs()}
        self._tok_name = "input_ids" if "input_ids" in self._inputs else "tokens"
        if self._tok_name not in self._inputs:
            raise ValueError(f"unexpected model inputs: {list(self._inputs)}")
        self._voices_src = voices_path_or_dir
        self._voices = {}
        self._npz = None
        if os.path.isdir(voices_path_or_dir):
            self._dir = voices_path_or_dir
        else:
            self._dir = None
            self._npz = np.load(voices_path_or_dir)

    def voices(self):
        if self._dir:
            return sorted(f[:-4] for f in os.listdir(self._dir) if f.endswith(".bin"))
        return sorted(self._npz.keys())

    def voice(self, name):
        """Style table [510, 1, 256] for a voice name; 'a,b' or 'a+b' averages voices."""
        np = self._np
        if not isinstance(name, str):
            return np.asarray(name, dtype=np.float32).reshape(-1, 1, 256)
        if name in self._voices:
            return self._voices[name]
        parts = [p for p in re.split(r"[,+]", name) if p]
        if len(parts) > 1:
            v = np.mean([self.voice(p) for p in parts], axis=0)
        elif self._dir:
            path = os.path.join(self._dir, name + ".bin")
            if not os.path.isfile(path):
                raise ValueError(f"voice {name!r} not found in {self._dir}")
            v = np.fromfile(path, dtype=np.float32).reshape(-1, 1, 256)
        else:
            if name not in self._npz:
                raise ValueError(f"voice {name!r} not found in {self._voices_src}")
            v = np.asarray(self._npz[name], dtype=np.float32).reshape(-1, 1, 256)
        self._voices[name] = v
        return v

    def tokens(self, ps):
        return [VOCAB[c] for c in ps if c in VOCAB]

    def infer(self, ps, voice="af_heart", speed=1.0):
        """Run the model on one phoneme chunk (<= 510 symbols). Returns float32 audio at 24 kHz."""
        np = self._np
        ids = self.tokens(ps)[:MAX_TOKENS]
        if not ids:
            return np.zeros(0, dtype=np.float32)
        table = self.voice(voice)
        style = table[min(len(ids), len(table)) - 1].reshape(1, -1)
        feed = {self._tok_name: np.array([[0, *ids, 0]], dtype=self._inputs[self._tok_name])}
        if "style" in self._inputs:
            feed["style"] = style.astype(self._inputs["style"])
        if "speed" in self._inputs:
            sp = self._inputs["speed"]
            feed["speed"] = np.array([round(speed) if np.issubdtype(sp, np.integer) else speed], dtype=sp)
        audio = self.sess.run(None, feed)[0]
        return np.asarray(audio, dtype=np.float32).reshape(-1)

    def create(self, text, voice="af_heart", speed=1.0, is_phonemes=False):
        """Text -> (float32 audio, 24000). Long text is split under the 510-token limit at sentence
        and clause boundaries, and the pieces are joined with a short pause."""
        np = self._np
        speed = float(min(max(speed, 0.5), 2.0))
        ps = text if is_phonemes else phonemize(text)
        chunks = split_phonemes(ps)
        parts = []
        for k, (chunk, pause) in enumerate(chunks):
            a = self.infer(chunk, voice, speed)
            if len(chunks) > 1:
                a = _trim(a, np)
                if k < len(chunks) - 1:
                    a = np.concatenate([a, np.zeros(int(pause * SAMPLE_RATE / speed), dtype=np.float32)])
            parts.append(a)
        audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return audio, SAMPLE_RATE


def _trim(a, np, thresh=0.01, keep=0.04):
    """Cut leading / trailing near-silence, keeping a few ms."""
    if not len(a):
        return a
    loud = np.flatnonzero(np.abs(a) > thresh * max(1e-6, float(np.abs(a).max())))
    if not len(loud):
        return a
    pad = int(keep * SAMPLE_RATE)
    return a[max(0, loud[0] - pad): min(len(a), loud[-1] + pad)]


def _main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="kokoro_lite: GPL-free G2P + Kokoro ONNX")
    ap.add_argument("text")
    ap.add_argument("--wav", help="write audio here (needs the model files)")
    ap.add_argument("--model", default=os.path.join(_HERE, "models", "kokoro-onnx", "kokoro-v1.0.onnx"))
    ap.add_argument("--voices", default=os.path.join(_HERE, "models", "kokoro-onnx", "voices-v1.0.bin"))
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.0)
    a = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print(phonemize(a.text))
    if a.wav:
        import wave
        import numpy as np
        audio, sr = KokoroLite(a.model, a.voices).create(a.text, a.voice, a.speed)
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
        with wave.open(a.wav, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm.tobytes())
        print(f"wrote {a.wav}: {len(audio) / sr:.2f} s")


if __name__ == "__main__":
    _main()
