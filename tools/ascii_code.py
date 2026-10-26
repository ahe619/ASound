"""Keep source files plain ASCII: interface text belongs in app/locales/*.json.

Rewrites any non-ASCII character in .js / .css / .html / .py sources as an escape (\\uXXXX in JS,
\\XXXXXX in CSS). Dashes in comments become "-". Run: python tools/ascii_code.py [--check]
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = [
    ("app/js", ".js"), ("app/kokoro", "neural-tts.js"), ("app/css", "app.css"),
    ("app", "index.html"), (".", "server.py"), ("tools", ".py"),
]


def files():
    for folder, suffix in TARGETS:
        base = os.path.join(ROOT, folder)
        for name in sorted(os.listdir(base)):
            path = os.path.join(base, name)
            if os.path.isfile(path) and name.endswith(suffix):
                yield path


def escape(ch, ext):
    if ch in (chr(0x2014), chr(0x2013)):  # em and en dash
        return "-"
    cp = ord(ch)
    if ext == ".css":
        return "\\%06X " % cp
    if ext in (".js", ".html"):
        return "\\u%04x" % cp if cp <= 0xFFFF else "\\u{%x}" % cp
    return "\\u%04x" % cp


def main():
    check = "--check" in sys.argv
    dirty = 0
    for path in files():
        with open(path, encoding="utf-8") as f:
            text = f.read()
        if text.startswith(chr(0xFEFF)):  # a byte-order mark is not content: drop it rather than escape it
            text = text[1:]
        if text.isascii():
            continue
        dirty += 1
        ext = os.path.splitext(path)[1]
        out = "".join(c if ord(c) < 128 else escape(c, ext) for c in text)
        print(("non-ASCII: " if check else "fixed: ") + os.path.relpath(path, ROOT))
        if not check:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(out)
    print("clean" if not dirty else f"{dirty} file(s)")


if __name__ == "__main__":
    main()
