"""Write <link rel="modulepreload"> tags for every module main.js imports (directly or not) into app/index.html.

Without them the browser discovers the module graph one level at a time (main.js, then its imports, then theirs),
so start-up costs one network round trip per level; on a phone far from the server that is seconds. Dynamic
import() calls are left out on purpose: those modules load when they are needed.

    python tools/modulepreload.py           # update app/index.html
    python tools/modulepreload.py --check   # exit 1 if it is out of date
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
INDEX = APP / "index.html"
START, END = "<!-- modulepreload:start -->", "<!-- modulepreload:end -->"
STATIC_IMPORT = re.compile(r'^\s*(?:import|export)\s[^;]*?\sfrom\s+"(\.{1,2}/[^"]+\.js)"|^\s*import\s+"(\.{1,2}/[^"]+\.js)"', re.M)


def graph(entry):
    seen, order, stack = set(), [], [entry]
    while stack:
        path = stack.pop()
        if path in seen:
            continue
        seen.add(path)
        order.append(path)
        text = path.read_text(encoding="utf-8")
        for match in STATIC_IMPORT.finditer(text):
            target = (path.parent / (match.group(1) or match.group(2))).resolve()
            if target.is_file() and APP in target.parents:
                stack.append(target)
    return order


def block():
    modules = graph((APP / "js" / "main.js").resolve())
    lines = [f'<link rel="modulepreload" href="{p.relative_to(APP).as_posix()}">' for p in sorted(modules, key=lambda p: p.as_posix())]
    return "\n".join([START, *lines, END])


def main():
    html = INDEX.read_text(encoding="utf-8")
    new = block()
    if START in html:
        updated = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _: new, html, flags=re.S)
    else:
        updated = html.replace('<script type="module" src="js/main.js"></script>', new + '\n<script type="module" src="js/main.js"></script>')
    if "--check" in sys.argv:
        if updated != html:
            print("app/index.html modulepreload list is out of date: run python tools/modulepreload.py")
            sys.exit(1)
        print("modulepreload list is up to date")
        return
    INDEX.write_text(updated, encoding="utf-8", newline="\n")
    print(f"{new.count('modulepreload') - 2} modules listed in app/index.html")


if __name__ == "__main__":
    main()
