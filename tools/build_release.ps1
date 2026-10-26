# Build the small Windows download: dist\ASound-win-x64.zip (the program and the interface, no AI models).
# On first start ASound shows "Download your AI coach" and fetches the models itself (Settings > Models later).
#
#   powershell -ExecutionPolicy Bypass -File tools\build_release.ps1
#
# Steps: rebuild ASound.exe with PyInstaller (from .venv), then copy the exe, its _internal folder, app\ without
# app\models and app\dev, and the readme/licenses into dist\ASound, and zip it.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Py = Join-Path $Root ".venv\Scripts"
$Dist = Join-Path $Root "dist"
$Out = Join-Path $Dist "ASound"

# 1. the exe. Without the GPL phonemizer when our own (kokoro_lite.py) is present.
$piArgs = @("--noconfirm", "--onedir", "--windowed", "--name", "ASound", "--icon", (Join-Path $Root "branding\asound.ico"),
          "--distpath", (Join-Path $Root "build\dist"), "--workpath", (Join-Path $Root "build\work"), "--specpath", (Join-Path $Root "build"),
          "--exclude-module", "tkinter", "--collect-submodules", "onnxruntime", "--hidden-import", "packs")
if (Test-Path (Join-Path $Root "kokoro_lite.py")) {
    $piArgs += @("--hidden-import", "kokoro_lite", "--exclude-module", "kokoro_onnx", "--exclude-module", "phonemizer",
               "--exclude-module", "espeakng_loader", "--exclude-module", "segments", "--exclude-module", "language_tags")
} else {
    $piArgs += @("--collect-all", "kokoro_onnx", "--collect-all", "espeakng_loader", "--collect-all", "phonemizer",
               "--collect-all", "language_tags", "--collect-all", "segments")
}
Push-Location $Root
try {
    & (Join-Path $Py "pyinstaller.exe") @piArgs (Join-Path $Root "launcher.py")
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
} finally { Pop-Location }

# 2. the folder
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force $Out | Out-Null
robocopy (Join-Path $Root "build\dist\ASound") $Out /E /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy (Join-Path $Root "app") (Join-Path $Out "app") /E /XD models dev /NFL /NDL /NJH /NJS /NP | Out-Null
foreach ($f in "README.md", "LICENSES.md") { Copy-Item (Join-Path $Root $f) $Out }

# 3. the zip
$zip = Join-Path $Dist "ASound-win-x64.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $Out -DestinationPath $zip -CompressionLevel Optimal
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
$folder = [math]::Round(((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host "dist\ASound-win-x64.zip: $mb MB (unpacked $folder MB)"
