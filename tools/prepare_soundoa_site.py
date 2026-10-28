"""Prepare an auditable GitHub Pages release for soundoa.cn, without publishing it.

Run from the repository root: python tools/prepare_soundoa_site.py
By default no network calls, repository creation, DNS changes, or model downloads are made.
With --download-web-voice, only missing pinned browser voice files are fetched.
"""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import uuid
import zipfile

try:
    from .build_web import build, MARKER as WEB_MARKER, RELEASE_LINE, ASSETS_LINE, encode
    from .prepare_model_host import DEFAULT_PACKS
    from .prepare_web_voice import verify_voice_payload
except ImportError:  # Direct script execution: tools/ is on sys.path.
    from build_web import build, MARKER as WEB_MARKER, RELEASE_LINE, ASSETS_LINE, encode
    from prepare_model_host import DEFAULT_PACKS
    from prepare_web_voice import verify_voice_payload


ROOT = Path(__file__).resolve().parent.parent
SITE_MARKER = ".soundoa-site-prepared"
NOTES_MARKER = ".soundoa-release-prepared"
MARKER_TEXT = "ASound generated release preparation v1\n"
DOMAIN = "soundoa.cn"
REPOSITORY = "ahe619/ASound"
OWNED_RECEIPTS = {(REPOSITORY, "existing"), ("ahe619/soundoa-site", "planned")}
ROOT_ASSETS = {"index.html", "repair.html", "voice-check.html", "manifest.webmanifest", "packs.json", "LICENSES.md", "version.json", "voice-models.json"}
EXTENSIONS = {
    "audio": {".wav"},
    "css": {".css"}, "fonts": {".woff2", ".woff", ".ttf", ".txt", ".md"},
    "img": {".png", ".svg", ".ico", ".webp", ".jpg", ".jpeg"},
    "js": {".js", ".mjs"}, "locales": {".json"},
    "kokoro": {".js", ".mjs", ".wasm", ".json", ".txt", ".md"},
    "vendor": {".js", ".mjs", ".wasm", ".json", ".txt", ".md"},
    "vocabulary": {".json", ".txt", ".md"},
}
FORBIDDEN_NAME = re.compile(r"(?:^|[._-])(?:secret|secrets|credential|credentials|private|api[_-]?key|id_rsa)(?:[._-]|$)", re.I)
FORBIDDEN_DIRECTORIES = {"test", "tests", "logs", "models", "weights", "backend", "__pycache__", "node_modules"}

PAGES_WORKFLOW = """name: Publish ASound website

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - name: Upload the website only
        uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v5
"""

PUBLIC_README = """# ASound portable website release

The selected source and deployment repository is `ahe619/ASound`. Its existing source
workflow builds and verifies the website, then publishes `dist/soundoa-site/site/`.
Do not copy this portable bundle over that repository's README or workflow.

This optional bundle contains the generated website under `site/` and a workflow for
a repository that contains prebuilt assets only. It is also suitable for transferring
`site/` to another static hosting service. Python services, development environments,
model weights, and user data are not part of this bundle.

The planned custom domain is `soundoa.cn`; this preparation does not configure it or
publish a website. Check that the account plan supports Pages for the repository's
visibility, then enable GitHub Actions publishing and verify the default HTTPS site.
Domain verification, DNS records, custom-domain settings, and HTTPS enforcement
are separate steps after the domain is ready. There is intentionally no CNAME file.

AI models are downloaded to and run on the user's device. Mainland-China connectivity
and real-phone inference performance still require testing. Rebuild from the source
repository for updates; do not edit `site/` assets by hand because their hashes are pinned
in the service worker release manifest.
"""

INSTRUCTIONS = """ASound / soundoa.cn 发布准备包

当前选择直接使用已有源码仓库 ahe619/ASound，不再要求新建发布仓库。
将审核后的源码变更推送到 main，由该仓库现有 .github/workflows/pages.yml
运行 prepare_soundoa_site.py 并发布 dist/soundoa-site/site/。
仓库 Settings -> Pages 需选择 GitHub Actions，且 ASOUND_PAGES_ENABLED 变量为 true。
须先确认账号方案支持当前仓库可见性的 Pages；本工具不会公开仓库或购买套餐。

soundoa-site/site/ 是已构建的网页，可供本地预览或其他静态托管平台使用。
soundoa-site/ 中附带的 README 和工作流只适合独立的预构建产物仓库，
不能覆盖已有 ASound 源码仓库的 README 或工作流，也不要把整个 ZIP 当作网页上传。
instructions/ 仅供操作者参考，不属于网页发布目录。

本工具只生成发布包，没有发布网站、绑定域名或修改 DNS。
launch-status.json 是本次准备工作的记录，不是托管平台的实时部署状态。
先验证 GitHub 提供的 HTTPS 网址，再按 SOUNDOA_LAUNCH.md 完成域名验证和绑定。
不要直接修改 site/ 内的文件，否则完整版本校验会失败。更新应从源码重新生成。

本包不含模型权重。首次 AI 使用需要下载模型，下载源和真实手机性能仍待试用。
"""


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_path(value):
    """Reject links before resolving paths, including Windows directory junctions."""
    path = Path(value).absolute()
    for part in (path, *path.parents):
        if part.is_symlink() or getattr(part, "is_junction", lambda: False)():
            raise ValueError(f"Linked output paths are not supported: {path}")
    return path.resolve()


def owned_directory(path, marker):
    if path.exists():
        token = path / marker
        if not path.is_dir() or not token.is_file() or token.is_symlink() or token.read_text(encoding="utf-8") != MARKER_TEXT:
            raise ValueError(f"Refusing to replace an unowned output directory: {path}")


def owned_archive(path):
    if not path.exists():
        return
    try:
        if not path.is_file():
            raise ValueError("not a regular file")
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo("instructions/launch-status.json")
            if info.file_size > 64_000:
                raise ValueError("invalid ownership receipt")
            receipt = json.loads(archive.read(info))
            identity = (receipt.get("repository"), receipt.get("repositoryStatus"))
            if receipt.get("domain") != DOMAIN or identity not in OWNED_RECEIPTS:
                raise ValueError("unrecognized release receipt")
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as exc:
        raise ValueError(f"Refusing to replace an unowned ZIP output: {path}") from exc


def allowed_asset(name):
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or "\\" in name or ":" in name
            or any(part in ("", ".", "..") or part.startswith(".") for part in name.split("/"))):
        return False
    if any(FORBIDDEN_NAME.search(part) for part in path.parts):
        return False
    if any(part.lower() in FORBIDDEN_DIRECTORIES for part in path.parts[:-1]):
        return False
    return name in ROOT_ASSETS or (len(path.parts) > 1 and path.suffix.lower() in EXTENSIONS.get(path.parts[0], set()))


def verify_site(site):
    """Hash every manifest asset and reject any unpublished or unexpected payload."""
    worker = (site / "sw.js").read_text(encoding="utf-8")
    matches = re.findall(r"^const ASSETS = (.+); // @asound-assets$", worker, re.M)
    if len(matches) != 1:
        raise ValueError("Website is missing a unique generated asset manifest")
    assets = json.loads(matches[0])
    names = set()
    for asset in assets:
        name = asset["url"]
        if name in names or not allowed_asset(name):
            raise ValueError(f"Unexpected or duplicate public asset: {name}")
        target = site / name
        if not target.is_file() or target.is_symlink() or not target.resolve().is_relative_to(site.resolve()):
            raise ValueError(f"Missing or linked public asset: {name}")
        if sha256(target) != asset["sha256"]:
            raise ValueError(f"Public asset hash mismatch: {name}")
        names.add(name)
    optional = verify_voice_payload(site, json.loads((site / "packs.json").read_text(encoding="utf-8")))
    actual = {p.relative_to(site).as_posix() for p in site.rglob("*") if p.is_file()}
    if actual != names | optional | {"sw.js", ".nojekyll", WEB_MARKER}:
        raise ValueError("Website contains files outside its verified release")
    releases = re.findall(r"^const RELEASE = (.+); // @asound-release$", worker, re.M)
    if len(releases) != 1:
        raise ValueError("Website is missing a unique generated release")
    release = json.loads(releases[0])
    version = json.loads((site / "version.json").read_text(encoding="utf-8"))
    base_worker = worker.replace(f"const RELEASE = {releases[0]}; // @asound-release", RELEASE_LINE)
    base_worker = base_worker.replace(f"const ASSETS = {matches[0]}; // @asound-assets", ASSETS_LINE)
    base_assets = [asset for asset in assets if asset["url"] != "version.json"]
    # build_web hashes filesystem-sorted Paths before sorting the final JSON by URL.
    base_assets.sort(key=lambda asset: Path(asset["url"]))
    expected = version["appVersion"] + "-" + hashlib.sha256((base_worker + encode(base_assets) + version["appVersion"]).encode("utf-8")).hexdigest()[:12]
    if release != expected or version["version"] != release or (site / WEB_MARKER).read_text(encoding="utf-8").strip() != release:
        raise ValueError("Generated service worker release hash mismatch")
    return assets


def publication_files(directory):
    """Only these paths may enter a portable prebuilt website bundle."""
    allowed_controls = {"README.md", ".gitignore", ".github/workflows/pages.yml"}
    optional = verify_voice_payload(directory / "site", json.loads((directory / "site" / "packs.json").read_text(encoding="utf-8")))
    for path in sorted(directory.rglob("*")):
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)() or not path.resolve().is_relative_to(directory.resolve()):
            raise ValueError(f"Linked publication content: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(directory).as_posix()
        if relative in {SITE_MARKER, "site/" + WEB_MARKER}:
            continue
        if relative in allowed_controls:
            yield relative, path
        elif relative.startswith("site/") and (allowed_asset(relative[5:]) or relative[5:] in optional | {"sw.js", ".nojekyll"}):
            yield relative, path
        else:
            raise ValueError(f"Unexpected publication content: {relative}")


def remove_generated(path, marker=None):
    """Only remove an exact, checked generated location, never a computed ancestor."""
    checked = checked_path(path)
    if checked != path:
        raise ValueError("Generated output path changed")
    if marker:
        owned_directory(path, marker)
        shutil.rmtree(path)
    else:
        path.unlink()


def replace_outputs(items):
    """Swap prepared siblings into place; restore previous outputs on a failed swap."""
    moved = []
    backups = []
    try:
        for staged, target, marker in items:
            checked_path(target)
            if marker:
                owned_directory(target, marker)
            else:
                owned_archive(target)
            backup = target.with_name(f".soundoa-backup-{uuid.uuid4().hex}")
            if target.exists():
                target.rename(backup)
                backups.append((backup, target, marker))
            staged.rename(target)
            moved.append((target, marker))
    except Exception:
        for target, marker in reversed(moved):
            remove_generated(target, marker)
        for backup, target, _marker in reversed(backups):
            backup.rename(target)
        raise
    else:
        for backup, _target, marker in backups:
            remove_generated(backup, marker)


def prepare(project_root=ROOT, output=None, release_dir=None, archive_path=None,
            with_web_voice=False, download_web_voice=False, download_bases=None):
    root = checked_path(project_root)
    source = checked_path(root / "app")
    license_file = checked_path(root / "LICENSES.md")
    output = checked_path(output or root / "dist" / "soundoa-site")
    notes = checked_path(release_dir or output.parent / "soundoa-release")
    version = (root / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", version):
        raise ValueError("Invalid application version")
    archive = checked_path(archive_path or output.parent / f"ASound-soundoa-ready-{version}.zip")
    for target in (output, notes, archive):
        if target == root or root.is_relative_to(target) or target == source or target.is_relative_to(source):
            raise ValueError("Outputs must not replace the project or enter app/")
    if output == notes or output.is_relative_to(notes) or notes.is_relative_to(output):
        raise ValueError("Public output and operator instructions must be separate directories")
    if any(archive.is_relative_to(folder) or folder.is_relative_to(archive) for folder in (output, notes)):
        raise ValueError("ZIP must be outside both generated directories")
    owned_directory(output, SITE_MARKER)
    owned_directory(notes, NOTES_MARKER)
    owned_archive(archive)
    for parent in {output.parent, notes.parent, archive.parent}:
        parent.mkdir(parents=True, exist_ok=True)
    staged_site = Path(tempfile.mkdtemp(prefix=".soundoa-stage-", dir=output.parent)).resolve()
    staged_notes = Path(tempfile.mkdtemp(prefix=".soundoa-notes-", dir=notes.parent)).resolve()
    with tempfile.NamedTemporaryFile(prefix=".soundoa-zip-", suffix=".zip", dir=archive.parent, delete=False) as temporary:
        staged_archive = Path(temporary.name).resolve()
    (staged_site / SITE_MARKER).write_text(MARKER_TEXT, encoding="utf-8")
    (staged_notes / NOTES_MARKER).write_text(MARKER_TEXT, encoding="utf-8")
    try:
        built = build(source, staged_site / "site", version, license_file, model_packs=list(DEFAULT_PACKS),
                      with_web_voice=with_web_voice or download_web_voice, download_web_voice=download_web_voice,
                      download_bases=download_bases)
        assets = verify_site(staged_site / "site")
        workflow = staged_site / ".github" / "workflows" / "pages.yml"
        workflow.parent.mkdir(parents=True)
        workflow.write_text(PAGES_WORKFLOW, encoding="utf-8", newline="\n")
        readme = PUBLIC_README
        instructions = INSTRUCTIONS
        if built["optionalVoiceFiles"]:
            readme = readme.replace("model weights, and user data are not part of this bundle.", "user data, and conversation-model weights are not part of this bundle.\nThe pinned Kokoro q8 browser voice pack is hosted under voice-models/ as an optional\ndownload; it is not downloaded with normal webpage updates. Its exact sources and\nhashes are listed in site/voice-models.json; attribution and the complete Apache-2.0\nlicense are in site/kokoro/KOKORO-MODEL-LICENSE.txt.")
            instructions = instructions.replace("本包不含模型权重。首次 AI 使用需要下载模型，下载源和真实手机性能仍待试用。", "本包含已核验的 Kokoro q8 浏览器语音包（约 101 MB），通过网站按需下载，不随网页更新自动下载。\nsite/voice-models.json 列出固定来源和文件校验值；完整许可证在 site/kokoro/KOKORO-MODEL-LICENSE.txt。\n对话和识别模型仍使用各自的下载源。下载速度和真实手机性能仍待试用。")
        (staged_site / "README.md").write_text(readme, encoding="utf-8", newline="\n")
        (staged_site / ".gitignore").write_text(f"{SITE_MARKER}\nsite/{WEB_MARKER}\n", encoding="utf-8", newline="\n")
        public_files = list(publication_files(staged_site))
        receipt = {
            "domain": DOMAIN, "domainStatus": "registered_as_reported_by_user",
            "repository": REPOSITORY, "repositoryStatus": "existing",
            "statusScope": "local_preparation_only",
            "published": False, "dnsConfigured": False, "customDomainConfigured": False,
            "httpsVerified": False, "weightsIncluded": bool(built["optionalVoiceFiles"]),
            "optionalVoiceFiles": built["optionalVoiceFiles"],
            "release": built["version"], "appVersion": version,
            "serviceWorkerSha256": sha256(staged_site / "site" / "sw.js"),
            "verifiedAssets": len(assets), "files": len(public_files),
            "bytes": sum(p.stat().st_size for _name, p in public_files),
            "modelPacks": list(DEFAULT_PACKS), "mainlandNetworkTested": False,
            "realPhoneInferenceTested": False,
        }
        (staged_notes / "launch-status.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (staged_notes / "README.txt").write_text(instructions, encoding="utf-8")
        guide = root / "docs" / "SOUNDOA_LAUNCH.md"
        if guide.is_file():
            if checked_path(guide) != guide or not guide.resolve().is_relative_to(root):
                raise ValueError("Launch guide cannot be a linked external file")
            shutil.copyfile(guide, staged_notes / guide.name)
        with zipfile.ZipFile(staged_archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for name, path in public_files:
                bundle.write(path, "soundoa-site/" + name)
            for path in sorted(staged_notes.iterdir()):
                if path.is_file() and path.name != NOTES_MARKER:
                    bundle.write(path, "instructions/" + path.name)
        with zipfile.ZipFile(staged_archive) as bundle:
            if bundle.testzip() is not None:
                raise ValueError("Generated deployment ZIP failed validation")
        replace_outputs([(staged_site, output, SITE_MARKER), (staged_notes, notes, NOTES_MARKER), (staged_archive, archive, None)])
        return {**receipt, "output": str(output), "instructions": str(notes), "archive": str(archive), "archiveBytes": archive.stat().st_size}
    finally:
        for path, marker in ((staged_site, SITE_MARKER), (staged_notes, NOTES_MARKER), (staged_archive, None)):
            if path.exists():
                remove_generated(path, marker)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "soundoa-site")
    parser.add_argument("--with-web-voice", action="store_true", help="Host the verified Kokoro q8 pack as an optional browser download")
    parser.add_argument("--download-web-voice", action="store_true", help="Fetch missing pinned voice files before building (implies --with-web-voice)")
    parser.add_argument("--download-base-url", action="append", help="Optional public HTTPS voice mirror root; repeat up to three times")
    args = parser.parse_args()
    result = prepare(output=args.out, with_web_voice=args.with_web_voice, download_web_voice=args.download_web_voice,
                     download_bases=args.download_base_url)
    print(f"{result['release']}: {result['verifiedAssets']} verified website assets -> {result['output']}")
    print(f"{result['archive']} ({result['archiveBytes'] / 1_000_000:.1f} MB)")
    print(f"Prepared only: website not published, DNS not changed; {result['optionalVoiceFiles']} verified optional browser voice files.")


if __name__ == "__main__":
    main()
