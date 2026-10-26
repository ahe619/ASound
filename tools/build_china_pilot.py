"""Build the small-model web pilot and its deployment ZIP, without downloading models.

python tools/build_china_pilot.py
python tools/build_china_pilot.py --model-base-url https://your-model-host.example/asound/v1
"""
import argparse
import json
from pathlib import Path
import tempfile
import zipfile

from build_web import build
from prepare_model_host import prepare, DEFAULT_PACKS

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-base-url", help="Real model hosting URL; omit to keep the existing download sources")
    args = parser.parse_args()
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    web = ROOT / "dist" / "web-test"
    models = ROOT / "dist" / "model-host-plan"
    result = build(ROOT / "app", web, version, ROOT / "LICENSES.md", args.model_base_url, list(DEFAULT_PACKS))
    manifest = prepare(ROOT / "app" / "packs.json", models)
    destination = ROOT / "dist" / f"ASound-china-pilot-{version}.zip"
    instructions = """ASound 国内网页测试包

web/ 是完整网页发布目录，可部署到 HTTPS 静态站点。
本机预览：在解压目录执行 python -m http.server 8783 --bind 127.0.0.1 --directory web
再打开 http://127.0.0.1:8783/ 。手机不能使用电脑的 127.0.0.1 地址。

model-manifest.json 只是模型上传清单，不包含模型权重。
未配置自有模型源的包仍使用现有 HF/镜像下载服务，不能据此保证国内访问速度。
首次 AI 使用仍需下载所需模型；本包没有云端 AI 服务。
更改域名、模型列表或文件后，须从源码重新构建，不要直接修改 web/ 内的配置，
否则发布清单校验会失败。完整步骤见 CHINA_DEPLOYMENT.md。

开发者重新打包：python tools/build_china_pilot.py
有模型地址后：python tools/build_china_pilot.py --model-base-url https://实际模型域名/版本路径
"""
    receipt = {"release": result["version"], "modelBaseConfigured": bool(args.model_base_url),
               "modelWeightsIncluded": False, "selectedPacks": list(DEFAULT_PACKS),
               "modelHostBytes": manifest["totalBytes"], "mainlandNetworkTested": False,
               "realPhoneInferenceTested": False}
    with tempfile.NamedTemporaryFile(prefix=".asound-pilot-", suffix=".zip", dir=destination.parent, delete=False) as temp:
        temporary = Path(temp.name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(web.rglob("*")):
                if path.is_file() and path.name != ".asound-web-build":
                    archive.write(path, "web/" + path.relative_to(web).as_posix())
            archive.write(models / "model-manifest.json", "model-manifest.json")
            archive.write(ROOT / "docs" / "CHINA_DEPLOYMENT.md", "CHINA_DEPLOYMENT.md")
            archive.writestr("README.txt", instructions)
            archive.writestr("deployment-status.json", json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    print(f"{result['version']}: {destination} ({destination.stat().st_size / 1_000_000:.1f} MB)")
    print(f"Preview: python -m http.server 8783 --bind 127.0.0.1 --directory {web}")
    print("Model manifest only; no model weights included. Mainland networks and real-phone inference still need testing.")


if __name__ == "__main__":
    main()
