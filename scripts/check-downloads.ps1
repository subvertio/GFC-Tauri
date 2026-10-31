# After publishing a release (DEVLOG.md, step 6): does every download location serve it?
#   powershell -ExecutionPolicy Bypass -File .\scripts\check-downloads.ps1 -Version 0.2.1
#   ... -Windows 0.2.2 -Android 0.2.1      when the two apps are on different versions
# Checks the node's published versions, that they're byte for byte the files in Packaged\ (by
# SHA-256), and that the web feed and the white paper link to the node. Read-only.
param(
    [string]$Version = '',
    [string]$Windows = $Version,
    [string]$Android = $Version,
    [string]$Node = 'https://node.galacticfederation.tech',
    [string]$Site = 'https://www.galacticfederation.tech'
)
$ErrorActionPreference = 'Stop'
if (-not $Windows -or -not $Android) { throw 'Give -Version, or both -Windows and -Android' }
$root = Split-Path $PSScriptRoot -Parent
$packaged = Join-Path $root 'Packaged'
$failed = 0

function Check([string]$what, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Host "  ok    $what" -ForegroundColor Green }
    else { Write-Host "  FAIL  $what $detail" -ForegroundColor Red; $script:failed++ }
}

function LocalHash([string]$pattern) {
    $f = Get-ChildItem $packaged -Filter $pattern -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'unsigned' } | Select-Object -First 1
    if ($f) { return (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower() }
    return $null
}

Write-Host "GFC download locations: Windows $Windows, Android $Android" -ForegroundColor Cyan

Write-Host 'Node (the one place installers are published):'
$win = Invoke-RestMethod "$Node/app/windows.json"
$apk = Invoke-RestMethod "$Node/app/release.json"
Check "Windows published: $($win.version)" ($win.version -eq $Windows)
Check "Android published: $($apk.version)" ($apk.version -eq $Android)
$localWin = LocalHash "GFC-Setup-$Windows-Windows.zip"
$localApk = LocalHash "GFC-$Android-arm64-release.apk"
if ($localWin) { Check 'Windows download is the file in Packaged\' ($win.sha256 -eq $localWin) "(node $($win.sha256.Substring(0,16)), local $($localWin.Substring(0,16)))" }
else { Write-Host "  --    no Packaged\GFC-Setup-$Windows-Windows.zip here to compare" }
if ($localApk) { Check 'Android download is the file in Packaged\' ($apk.sha256 -eq $localApk) "(node $($apk.sha256.Substring(0,16)), local $($localApk.Substring(0,16)))" }
else { Write-Host "  --    no Packaged\GFC-$Android-arm64-release.apk here to compare" }
Check 'Android signed with the release key' ($apk.cert_sha256 -replace ':', '' -eq '323133E4E13E4FC0F65F28D745B9EE6C1799401408D8F6D0E73EE5E721EB725C')
$page = (Invoke-WebRequest "$Node/app" -UseBasicParsing).Content
Check 'Download page shows both versions' (($page -match "Version $([regex]::Escape($Windows))") -and ($page -match "Version $([regex]::Escape($Android))"))

Write-Host 'Web feed and share pages:'
$web = (Invoke-WebRequest "$Node/web" -UseBasicParsing -Headers @{ Accept = 'text/html' }).Content
Check 'Header: Get GFC for Windows -> /app/windows' ($web -match 'href="/app/windows"')
Check 'Header: Get GFC for Android -> /app/android' ($web -match 'href="/app/android"')

Write-Host 'galacticfederation.tech:'
$paper = (Invoke-WebRequest "$Site/gfcwhitepaper" -UseBasicParsing).Content
Check 'White paper links to the node' ($paper -match [regex]::Escape("$Node/app"))
$stale = [regex]::Matches($paper, 'https://[^"]*usrfiles\.com/[^"]*\.(apk|zip|exe)') | ForEach-Object { $_.Value }
Check 'White paper has no installer copies on Wix' (-not $stale) ($stale -join ', ')
Write-Host '  check The home page buttons are built by Wix in the browser, so check them by hand once:' -ForegroundColor Yellow
Write-Host "        open $Site and hover Download for Windows and Download the app (APK):" -ForegroundColor Yellow
Write-Host "        they should go to $Node/app/windows and $Node/app/android" -ForegroundColor Yellow

if ($failed) { Write-Host "$failed check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host "All checks passed (Windows $Windows, Android $Android)" -ForegroundColor Green
