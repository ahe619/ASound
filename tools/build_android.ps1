# Build the Android app (mobile/android) into dist\ASound-android.apk.
#
#   powershell -ExecutionPolicy Bypass -File tools\build_android.ps1
#
# What it needs, and what it does about it:
#   - Java 17: uses JAVA_HOME if set, else downloads Microsoft's OpenJDK 17 into build\jdk.
#   - Gradle 8.10: downloads it into build\gradle (from services.gradle.org).
#   - The Android SDK: uses ANDROID_HOME if set, else downloads Google's command-line tools into build\android-sdk and
#     installs platform 35 + build tools. Google asks you to accept the Android SDK license the first time: the script
#     runs `sdkmanager --licenses` in this window, read it and answer y yourself.
# The app's web files are copied from app\ (without the models: the app downloads those itself) into the APK.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Build = Join-Path $Root "build"
$Project = Join-Path $Root "mobile\android"
New-Item -ItemType Directory -Force $Build | Out-Null

function Get-Zip($url, $dest, $name) {
    if (Test-Path $dest) { return }
    $zip = Join-Path $Build "$name.zip"
    Write-Host "Downloading $name ..."
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $dest -Force
    Remove-Item $zip
}

# Java 17
if (-not $env:JAVA_HOME) {
    $jdkDir = Join-Path $Build "jdk"
    Get-Zip "https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.zip" $jdkDir "jdk17"
    $env:JAVA_HOME = (Get-ChildItem $jdkDir -Directory | Select-Object -First 1).FullName
}
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

# Gradle
$gradleDir = Join-Path $Build "gradle"
Get-Zip "https://services.gradle.org/distributions/gradle-8.10.2-bin.zip" $gradleDir "gradle"
$gradle = Join-Path (Get-ChildItem $gradleDir -Directory | Select-Object -First 1).FullName "bin\gradle.bat"

# Android SDK
if (-not $env:ANDROID_HOME) {
    $sdk = Join-Path $Build "android-sdk"
    $tools = Join-Path $sdk "cmdline-tools\latest"
    if (-not (Test-Path $tools)) {
        Get-Zip "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip" (Join-Path $Build "cmdline-tmp") "cmdline-tools"
        New-Item -ItemType Directory -Force (Split-Path $tools) | Out-Null
        Move-Item (Join-Path $Build "cmdline-tmp\cmdline-tools") $tools
        Remove-Item -Recurse -Force (Join-Path $Build "cmdline-tmp")
    }
    $env:ANDROID_HOME = $sdk
    $sdkmanager = Join-Path $tools "bin\sdkmanager.bat"
    if (-not (Test-Path (Join-Path $sdk "platforms\android-35"))) {
        Write-Host "Google's Android SDK license follows. Read it and type y to accept (this is your decision)."
        & $sdkmanager --sdk_root=$sdk --licenses
        & $sdkmanager --sdk_root=$sdk "platforms;android-35" "build-tools;35.0.0" "platform-tools"
    }
}
Set-Content -Path (Join-Path $Project "local.properties") -Value ("sdk.dir=" + ($env:ANDROID_HOME -replace "\\", "/")) -Encoding ascii

# The web app (without models, test pages or the desktop-only voice files)
$www = Join-Path $Project "app\src\main\assets\www"
if (Test-Path $www) { Remove-Item -Recurse -Force $www }
New-Item -ItemType Directory -Force $www | Out-Null
robocopy (Join-Path $Root "app") $www /E /XD models dev /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copying app\ failed" }

& $gradle -p $Project --no-daemon assembleDebug
if ($LASTEXITCODE -ne 0) { throw "gradle build failed" }

$dist = Join-Path $Root "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
Copy-Item (Join-Path $Project "app\build\outputs\apk\debug\app-debug.apk") (Join-Path $dist "ASound-android.apk") -Force
Write-Host "Built dist\ASound-android.apk"
