"""Validate interface dictionaries, including independently loaded feature strings.

English and Chinese must cover literal keys used by the app and stay in sync.
Other interface languages may omit keys: i18n.js deliberately falls back to English.
Computed/template keys are listed for manual review, not claimed as validated.
"""

import argparse
from dataclasses import dataclass, field
import json
from pathlib import Path
import re


APP = Path(__file__).resolve().parent.parent / "app"
STATIC_KEY = re.compile(r"""\bt\(\s*["']([\w.-]+)["']""")
TEMPLATE_KEY = re.compile(r"""\bt\(\s*`([^`]+)`""")
HTML_KEY = re.compile(r"""data-i18n(?:-placeholder|-label)?=(["'])([\w.-]+)\1""")
INVALID_JSON = object()


@dataclass
class Report:
    used: set = field(default_factory=set)
    templates: list = field(default_factory=list)
    problems: list = field(default_factory=list)
    locale_count: int = 0
    feature_count: int = 0


def _read_json(path, report):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        report.problems.append(f"{path.name}: cannot read JSON: {exc}")
        return INVALID_JSON


def _dictionary(value, label, report):
    if not isinstance(value, dict):
        report.problems.append(f"{label}: expected a dictionary of text keys")
        return None
    for key, text in value.items():
        if not isinstance(text, str):
            report.problems.append(f"{label}: {key} must contain a string")
    return value


def _symmetry(dictionaries, label, report):
    if "en" in dictionaries and "zh" in dictionaries:
        for key in sorted(dictionaries["en"].keys() ^ dictionaries["zh"].keys()):
            absent = "zh" if key in dictionaries["en"] else "en"
            report.problems.append(f"{label}: {key} missing from {absent}")


def check_app(app=APP):
    """Check one app directory without printing or mutating any source files."""
    app = Path(app)
    report = Report()
    sources = sorted((app / "js").rglob("*.js"))
    for path in sources:
        try:
            source = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as exc:
            report.problems.append(f"{path.name}: cannot read source: {exc}")
            continue
        report.used.update(STATIC_KEY.findall(source))
        report.templates.extend((path.name, key) for key in TEMPLATE_KEY.findall(source))
    try:
        html = (app / "index.html").read_text(encoding="utf-8-sig")
        report.used.update(key for _, key in HTML_KEY.findall(html))
    except (OSError, UnicodeError) as exc:
        report.problems.append(f"index.html: cannot read source: {exc}")

    # Validate every supplied locale, including optional languages that use fallback.
    locales = {}
    for path in sorted((app / "locales").glob("*.json")):
        report.locale_count += 1
        raw = _read_json(path, report)
        if raw is not INVALID_JSON:
            dictionary = _dictionary(raw, path.name, report)
            if dictionary is not None:
                locales[path.stem] = dictionary
    for lang in ("en", "zh"):
        if not (app / "locales" / f"{lang}.json").is_file():
            report.problems.append(f"{lang}.json: required locale file is missing")
    _symmetry(locales, "main locales", report)

    # Feature dictionaries have the shape {"en": {...}, "zh": {...}}.
    # Keep per-file parity checks so one feature cannot hide another's missing text.
    merged = {lang: dict(dictionary) for lang, dictionary in locales.items()}
    for path in sorted((app / "locales" / "feat").glob("*.json")):
        report.feature_count += 1
        raw = _read_json(path, report)
        if raw is INVALID_JSON:
            continue
        if not isinstance(raw, dict):
            report.problems.append(f"feat/{path.name}: expected language dictionaries")
            continue
        feature = {}
        for lang, value in raw.items():
            dictionary = _dictionary(value, f"feat/{path.name}:{lang}", report)
            if dictionary is not None:
                feature[lang] = dictionary
                # The main dictionary takes priority at runtime; only coverage matters here.
                merged.setdefault(lang, {}).update(dictionary)
        for lang in ("en", "zh"):
            if lang not in raw:
                report.problems.append(f"feat/{path.name}: required {lang} dictionary is missing")
        _symmetry(feature, f"feat/{path.name}", report)

    for lang in ("en", "zh"):
        if lang in locales:
            report.problems.extend(f"{lang}: missing {key}" for key in sorted(report.used - merged[lang].keys()))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=APP, help="app directory to check")
    args = parser.parse_args(argv)
    report = check_app(args.app)
    for problem in report.problems:
        print(problem)
    print(f"{report.locale_count} locale files, {report.feature_count} feature dictionaries, "
          f"{len(report.used)} static keys")
    templates = sorted({key for _, key in report.templates})
    print(f"{len(report.templates)} template keys (check by hand): " + ", ".join(templates))
    print("ok" if not report.problems else f"{len(report.problems)} problem(s)")
    return 1 if report.problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
