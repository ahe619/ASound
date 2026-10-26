"""Build the offline word bank from pinned, auditable dictionary and syllabus data.

python tools/prepare_vocabulary.py --download
python tools/prepare_vocabulary.py

Only --download accesses the network. Large source files stay in build/vocabulary-source.
The committed CET index contains word-form facts extracted from the official PDF;
normal app builds do not need a PDF parser or network access.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import re
import tempfile
import unicodedata
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
REVISION = "ab22ad36302cafc6349a050e2b60894855208055"
BASE = f"https://raw.githubusercontent.com/skywind3000/ECDICT/{REVISION}/"
CET_URL = "https://cet.neea.edu.cn/res/Home/1704/55b02330ac17274664f06d9d3db8249d.pdf"
CET_INDEX_HASH = "47878fc7718efb864c6ff9767f1b5c82b0c7774d5257f2aae25a0fec573a87da"
SOURCES = {
    "ecdict.csv": (BASE + "ecdict.csv", "d1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc"),
    "ECDICT-LICENSE.txt": (BASE + "LICENSE", "f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f"),
}
VALID_TERM = re.compile(r"[a-z]+(?:[ '-][a-z]+|\.[a-z]+)*\.?", re.I)
PERSON_NAME = re.compile(r"男子名|女子名|人名|姓氏|男性名|女性名|男名|女名")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fetch_sources(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, (url, expected) in SOURCES.items():
        target = directory / name
        if target.is_file() and digest(target) == expected:
            continue
        with urlopen(url, timeout=60) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != expected:
            raise ValueError(f"Upstream checksum differs: {name}; review the data before updating pins")
        write_atomic(target, content)


def write_atomic(target, content):
    target = Path(target)
    if target.is_symlink():
        raise ValueError(f"Refusing linked output: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".vocabulary-", delete=False) as file:
        temporary = Path(file.name)
        file.write(content)
    try:
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def expand_form(form):
    """Expand only the optional spelling notation explicitly printed in the syllabus."""
    form = "".join("'" if unicodedata.category(c) == "Co" else c for c in form)
    form = form.replace("G", "-")  # The pinned PDF's hyphen glyph extracts as G.
    if form.startswith("coup("):
        return ["coup", "coup d'etat"]
    if re.match(r"\d", form) or form.startswith("("):
        return []  # A split homograph superscript/alternative, already represented by its headword.
    if form == "accordingto":
        return ["according to"]
    if form in {"babyboom", "babyboomer"}:
        return ["baby boom" if form == "babyboom" else "baby boomer"]
    if form in {"oughtto", "owingto"}:
        return ["ought to" if form == "oughtto" else "owing to"]
    result = []
    for spelling in form.split("/"):
        if not spelling:
            continue
        if spelling.startswith("-") and result:
            suffix = spelling[1:]
            spelling = "connexion" if result[0] == "connection" and suffix == "xion" else result[0][:-len(suffix)] + suffix
        optional = re.search(r"\(([^()]*)\)", spelling)
        if optional:
            before, after = spelling[:optional.start()], spelling[optional.end():]
            result.extend([before + after, before + optional[1] + after])
        else:
            result.append(spelling)
    return [term.casefold() for term in result]


def cet_memberships(index):
    members = {}
    for row in index["rows"]:
        # Join a spelling alternative that the PDF extractor placed after a slash at a line break.
        forms = []
        for token in [row["head"], *row["derivatives"]]:
            if forms and forms[-1].endswith("/"):
                forms[-1] += token
            else:
                forms.append(token)
        for form in forms:
            for term in expand_form(form):
                entry = members.setdefault(term, {"cet4": False, "pages": set(), "forms": set()})
                entry["cet4"] = entry["cet4"] or not row["cet6Only"]
                entry["pages"].add(row["page"])
                entry["forms"].add(form)
    return members


def extract_cet_index(pdf_path):
    """Reproduce the committed fact index; pypdf/pdfplumber are maintenance-only dependencies.

    The PDF uses separate homograph superscripts and positions its star glyph below
    the word baseline. Coordinate extraction identifies the head/star; linear text
    preserves derivatives that otherwise get clipped by table column boundaries.
    """
    from pypdf import PdfReader
    import pdfplumber

    expected = "9166d3c03b7bc43abd9d9df91bd2ef8085b4419286f1e5ca100dea68f3cfd1f1"
    if digest(pdf_path) != expected:
        raise ValueError("CET PDF changed; do not apply the pinned edition's extraction geometry")
    linear = []
    reader = PdfReader(pdf_path)
    for page_index in range(20, 149):
        for line in unicodedata.normalize("NFKC", reader.pages[page_index].extract_text()).splitlines():
            line = line.strip()
            if re.search("[A-Za-z]", line):
                linear.append({"page": page_index + 1, "line": line})
    rows = []
    with pdfplumber.open(pdf_path) as pdf:
        for page_index in range(20, 149):
            groups, stars = [], []
            for char in sorted(pdf.pages[page_index].chars, key=lambda item: item["top"]):
                if unicodedata.normalize("NFKC", char["text"]) == "★":
                    stars.append(char)
                    continue
                if not (60 < char["top"] < 700 and abs(char["size"] - 9.704) < .02):
                    continue
                if not groups or char["top"] - groups[-1][0] > 2.7:
                    groups.append((char["top"], [char]))
                else:
                    groups[-1][1].append(char)
            groups = [(top, chars) for top, chars in groups if any(re.search("[A-Za-z]", c["text"]) for c in chars)]
            left = min(c["x0"] for _top, chars in groups for c in chars)
            for top, chars in groups:
                head = "".join(unicodedata.normalize("NFKC", c["text"]) for c in sorted(chars, key=lambda c: c["x0"])
                               if int((c["x0"] - left + .1) // 87.429) == 0).strip()
                if not head:
                    continue
                if len(head) >= 15 or "/" in head:
                    candidates = {line["line"].lstrip("★ ").split()[0] for line in linear
                                  if line["page"] == page_index + 1 and line["line"].lstrip("★ ").split()[0].startswith(head)}
                    if len(candidates) == 1:
                        head = candidates.pop()
                rows.append({"page": page_index + 1, "head": head, "derivatives": [],
                             "cet6Only": any(abs((star["top"] - 7.336224) - top) < 2.7 for star in stars)})
    position, current = 0, None
    for line in linear:
        tokens = line["line"].lstrip("★ ").split()
        expected_row = rows[position] if position < len(rows) else None
        head = expected_row["head"] if expected_row else ""
        matches = head == tokens[0] or (head.startswith(tokens[0]) and len(head) > len(tokens[0]) and head[len(tokens[0])] in "/(")
        if expected_row and expected_row["page"] == line["page"] and matches:
            current = expected_row
            current["derivatives"] = tokens[1:]
            position += 1
        elif current and current["page"] == line["page"]:
            current["derivatives"].extend(tokens)
        else:
            raise ValueError(f"Unmapped PDF text on page {line['page']}")
    if position != len(rows) or len(rows) != 5377 or sum(row["cet6Only"] for row in rows) != 1263:
        raise ValueError("Official table extraction no longer matches the reviewed row/star counts")
    result = {"schemaVersion": 1, "sourceUrl": CET_URL, "sourceSha256": expected, "edition": "2016", "rows": rows}
    if hashlib.sha256(json_bytes(result)).hexdigest() != CET_INDEX_HASH:
        raise ValueError("Re-extracted CET index differs; inspect it before updating the checked-in snapshot")
    return result


def build(project_root=ROOT, source_dir=None):
    root = Path(project_root).resolve()
    directory = Path(source_dir) if source_dir else root / "build" / "vocabulary-source"
    output = root / "app" / "vocabulary"
    for name, (_url, expected) in SOURCES.items():
        if not (directory / name).is_file() or digest(directory / name) != expected:
            raise ValueError(f"Missing or changed pinned source {name}; run with --download")
    index_path = output / "cet-2016-index.json"
    if digest(index_path) != CET_INDEX_HASH:
        raise ValueError("CET source index changed; review and update its pinned checksum")
    index = json.loads(index_path.read_text(encoding="utf-8"))
    contexts_path = output / "contexts.json"
    contexts = json.loads(contexts_path.read_text(encoding="utf-8")) if contexts_path.is_file() else {"topics": {}, "scenarios": {}}
    context_words = {word.casefold() for kind in ("topics", "scenarios") for group in contexts[kind].values() for word in group}
    cet = cet_memberships(index)
    dictionary = {}
    raw_ky = set()
    with (directory / "ecdict.csv").open(encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            key = row["word"].strip().casefold()
            if "ky" in row["tag"].split():
                raw_ky.add(key)
            # Preserve exact lexical forms; never generate an exam word from a model.
            if not VALID_TERM.fullmatch(key) or not re.search(r"[\u3400-\u9fff]", row["translation"]):
                continue
            if key in dictionary:
                raise ValueError(f"Duplicate case-insensitive dictionary entry: {key}")
            dictionary[key] = row
    words = []
    excluded_general_names = []
    for term, row in sorted(dictionary.items()):
        ranks = [int(row.get(field) or 0) for field in ("bnc", "frq")]
        frequent = any(0 < rank <= 3000 for rank in ranks)
        personal_name = bool(PERSON_NAME.search(row["translation"]))
        general = term in context_words or (frequent and not personal_name)
        if frequent and personal_name and term not in context_words:
            excluded_general_names.append(term)
        exams = []
        if term in cet:
            if cet[term]["cet4"]:
                exams.append("cet4")
            exams.append("cet6")  # Six-level preparation includes the basic level, not only starred additions.
        if term in raw_ky:
            exams.append("kaoyan")
        if not general and not exams:
            continue
        words.append({"id": term, "term": row["word"].strip(), "ipa": row["phonetic"].strip(),
                      "meaning": row["translation"].replace("\\n", "\n").strip(), "exams": exams,
                      "general": general, "topics": [key for key, values in contexts["topics"].items() if term in {v.casefold() for v in values}],
                      "scenarios": [key for key, values in contexts["scenarios"].items() if term in {v.casefold() for v in values}]})
    words_payload = json_bytes({"schemaVersion": 1, "words": words})
    missing_cet = [{"term": term, "pages": sorted(meta["pages"]), "printedForms": sorted(meta["forms"])}
                   for term, meta in sorted(cet.items()) if term not in dictionary]
    missing_ky = sorted(raw_ky - dictionary.keys())
    missing_contexts = sorted(context_words - dictionary.keys())
    if missing_contexts:
        raise ValueError("Unmatched context vocabulary: " + ", ".join(missing_contexts))
    report = {"schemaVersion": 1, "officialCETDocumentHeadwordCount": 5418,
              "extractedCETHeadRows": len(index["rows"]), "candidateCETForms": len(cet),
              "matchedCETForms": sum(term in dictionary for term in cet), "unmatchedCETForms": missing_cet,
              "rawKaoyanTaggedCount": len(raw_ky), "unmatchedKaoyanTerms": missing_ky,
              "contextTerms": len(context_words), "unmatchedContextTerms": missing_contexts,
              "generalExcludedPersonalNames": excluded_general_names,
              "completeOfficialCoverageVerified": False,
              "notes": "Counts differ from printed headword totals because spelling alternatives and listed derivatives are expanded and homographs are merged. This is a sourced study collection, not a guarantee of complete current-year official coverage."}
    details = {
        "general": ("日常词汇", "Everyday words", "ECDICT frequency ranks + curated topics", "https://github.com/skywind3000/ECDICT", REVISION,
                    "来自 ECDICT 的 BNC／当代语料库前 3000 词频词项，加上主题与场景词；频率池排除明确标为人名、姓氏的词，主题白名单可保留。", "Union of ECDICT BNC/contemporary frequency ranks 1–3000 and curated topic/scenario words; explicitly labelled personal names/surnames are excluded from the frequency pool unless curated."),
        "cet4": ("四级词汇", "CET-4", "NEEA CET syllabus (2016) + ECDICT", CET_URL, "2016",
                 "按教育考试院 2016 版词表四级部分提取，含所列派生词和拼写变体，仅收录有词典释义的词项；覆盖缺口见来源报告。", "Matched dictionary entries from the CET-4 portion of the official 2016 syllabus, including listed derivatives and spelling variants; see coverage report for gaps."),
        "cet6": ("六级词汇", "CET-6", "NEEA CET syllabus (2016) + ECDICT", CET_URL, "2016",
                 "按教育考试院 2016 版词表提取，包含四级基础和标星六级词，以及所列派生词、拼写变体；覆盖缺口见来源报告。", "Matched entries from the official 2016 syllabus, including basic CET-4 words, starred CET-6 additions, listed derivatives and spelling variants; see coverage report for gaps."),
        "kaoyan": ("考研词汇（参考）", "Postgraduate English (reference)", "ECDICT ky-tagged reference collection", "https://github.com/skywind3000/ECDICT", REVISION,
                    "来自 ECDICT 的 ky 考研标签参考词库，保留真实词典词项；未核对当年英语一／二完整大纲，不应作为唯一备考词表。", "Real ECDICT entries tagged ky. A reference collection, not a verified complete current-year English I/II syllabus or a sole exam-preparation list."),
    }
    decks = []
    for key, (zh, en, name, url, revision, note_zh, note_en) in details.items():
        decks.append({"id": key, "count": sum(w["general"] if key == "general" else key in w["exams"] for w in words),
                      "labelZh": zh, "labelEn": en, "sourceName": name, "sourceUrl": url, "revision": revision,
                      "notesZh": note_zh, "notesEn": note_en})
    catalog = {"schemaVersion": 1, "wordsFile": "words.json", "wordsSha256": hashlib.sha256(words_payload).hexdigest(),
               "wordCount": len(words), "decks": decks, "coverageReport": "coverage-report.json", "sourceIndex": "cet-2016-index.json",
               "source": {"name": "NEEA CET 2016 word forms + ECDICT definitions/tags", "url": "https://github.com/skywind3000/ECDICT",
                          "revision": REVISION, "license": "ECDICT: MIT; CET membership: extracted word-form facts", "licenseFile": "ECDICT-LICENSE.txt",
                          "notesZh": "考试词来自真实词表与词典，不由 AI 生成。四、六级按 2016 官方词表分类；考研为 ECDICT 标签参考库。词典音标以英式为主。",
                          "notesEn": "Exam words come from traceable lists and dictionary records, not AI generation. CET classification uses the official 2016 list; postgraduate words use ECDICT reference tags. Dictionary phonetics are mainly British."},
               "sourceFiles": [{"file": name, "url": url, "sha256": checksum} for name, (url, checksum) in SOURCES.items()],
               "cetPDF": {"url": CET_URL, "sha256": index["sourceSha256"], "indexSha256": CET_INDEX_HASH},
               "contextsSha256": digest(contexts_path) if contexts_path.is_file() else None}
    for name, data in {"words.json": words_payload, "catalog.json": json_bytes(catalog), "coverage-report.json": json_bytes(report),
                       "ECDICT-LICENSE.txt": (directory / "ECDICT-LICENSE.txt").read_bytes()}.items():
        write_atomic(output / name, data)
    return {"wordCount": len(words), "decks": {d["id"]: d["count"] for d in decks}, "bytes": len(words_payload),
            "unmatchedCET": len(missing_cet), "unmatchedKaoyan": len(missing_ky)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--verify-cet-pdf", type=Path, help="Re-extract and verify a local pinned official PDF; requires pypdf and pdfplumber")
    args = parser.parse_args()
    if args.verify_cet_pdf:
        extract_cet_index(args.verify_cet_pdf)
    if args.download:
        fetch_sources(ROOT / "build" / "vocabulary-source")
    print(json.dumps(build(), ensure_ascii=True))


if __name__ == "__main__":
    main()
