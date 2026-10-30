# Build the GFC Android app.
#   .\scripts\android.ps1               debug APK: "GFC Dev" (tech.galacticfederation.gfc.dev), installs next to GFC
#   .\scripts\android.ps1 -Install      ...and install it on the phone over adb (never uninstalls anything)
#   .\scripts\android.ps1 -Release      release APK signed with the upload key (updates the GFC app in place)
#
# Release signing reads GFC_KEYSTORE_PASSWORD (asked for if unset), GFC_KEYSTORE (default
# D:\GFCKeys\gfc-release.keystore) and GFC_KEY_ALIAS (default gfc); see gen\android\app\build.gradle.kts.
#
# Why not just `tauri android build`: it symlinks the Rust library into the Android project, and
# Windows only allows symlinks in Developer Mode. This runs the same steps with a copy instead.
param(
    [switch]$Release,
    [switch]$Install,
    [string]$Target = 'aarch64'
)
# Native tools write progress to stderr; Windows PowerShell would treat that as an error under 'Stop'
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent

if (-not $env:JAVA_HOME) { $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr' }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = 'D:\Android\Sdk' }
if (-not $env:NDK_HOME) { $env:NDK_HOME = (Get-ChildItem "$env:ANDROID_HOME\ndk" -Directory | Sort-Object Name | Select-Object -Last 1).FullName }

$abi = @{ aarch64 = 'arm64-v8a'; armv7 = 'armeabi-v7a'; x86_64 = 'x86_64'; i686 = 'x86' }[$Target]
$triple = @{ aarch64 = 'aarch64-linux-android'; armv7 = 'armv7-linux-androideabi'; x86_64 = 'x86_64-linux-android'; i686 = 'i686-linux-android' }[$Target]
$arch = @{ aarch64 = 'Arm64'; armv7 = 'Arm'; x86_64 = 'X86_64'; i686 = 'X86' }[$Target]
$profile = if ($Release) { 'release' } else { 'debug' }
$Profile_ = if ($Release) { 'Release' } else { 'Debug' }

if ($Release -and -not $env:GFC_KEYSTORE_PASSWORD) {
    $secure = Read-Host -AsSecureString 'Upload key password'
    $env:GFC_KEYSTORE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

Push-Location $root
try {
    # 1. Front end + Rust library + generated Android config. Its last step (the symlink)
    #    fails without Developer Mode, so its exit code is ignored and the library checked instead.
    $tauriArgs = @('tauri', 'android', 'build', '--apk', '--target', $Target)
    if (-not $Release) { $tauriArgs += '--debug' }
    & npx @tauriArgs 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -notmatch 'symbolic link|developer mode|SeCreateSymbolicLink|enable-your-device|create-symbolic-links|Window 8.1|Windows 10 or newer' } | Write-Host
    $lib = Join-Path $root "src-tauri\target\$triple\$profile\libgfc_lib.so"
    if (-not (Test-Path $lib)) { throw "Rust library not built: $lib" }

    # 2. Copy it where Gradle expects it
    $jni = Join-Path $root "src-tauri\gen\android\app\src\main\jniLibs\$abi"
    New-Item -ItemType Directory -Force $jni | Out-Null
    Remove-Item (Join-Path $jni 'libgfc_lib.so') -Force -ErrorAction SilentlyContinue
    Copy-Item $lib $jni

    # 3. Gradle, skipping its own Rust step (it would try the symlink again)
    Push-Location (Join-Path $root 'src-tauri\gen\android')
    try {
        & .\gradlew.bat "assemble$arch$Profile_" "-x" "rustBuild$arch$Profile_" --console=plain
        if ($LASTEXITCODE -ne 0) { throw "Gradle failed ($LASTEXITCODE)" }
    } finally { Pop-Location }

    $flavor = $arch.ToLower()
    $apk = Get-ChildItem (Join-Path $root "src-tauri\gen\android\app\build\outputs\apk\$flavor\$profile") -Filter *.apk | Select-Object -First 1
    Write-Host ("APK: {0} ({1:N1} MB)" -f $apk.FullName, ($apk.Length / 1MB)) -ForegroundColor Green

    if ($Install) {
        if ($Release) { throw 'Install release builds yourself: they update the GFC app in place.' }
        # -r replaces an earlier GFC Dev; it never touches tech.galacticfederation.gfc
        adb install -r $apk.FullName
        if ($LASTEXITCODE -ne 0) { throw 'adb install failed' }
    }
} finally { Pop-Location }
