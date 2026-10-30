# Makes the Tauri app's icons (Windows and Android) the same as the GFC app's: the artwork is
# GFC-Client's Build\Icon\GFCIcon.jpg, and its Scripts\MakeIcon.ps1 has already made the Windows
# .ico and the Android icons from it. This copies those in and adds the sizes Tauri needs.
#   powershell -ExecutionPolicy Bypass -File .\scripts\icons.ps1 [-Client D:\projects\GFC-Client]
param([string]$Client = 'D:\projects\GFC-Client')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$icons = Join-Path $root 'src-tauri\icons'
$res = Join-Path $root 'src-tauri\gen\android\app\src\main\res'
$clientRes = Join-Path $Client 'Build\Android\res'
foreach ($p in (Join-Path $Client 'Build\Windows\Application.ico'), (Join-Path $clientRes 'drawable-xxxhdpi\icon.png')) {
    if (-not (Test-Path $p)) { throw "Missing $p (run GFC-Client's Scripts\MakeIcon.ps1 first)" }
}

function Save-Resized([string]$src, [int]$size, [string]$dest, [switch]$Circle) {
    $img = [System.Drawing.Image]::FromFile($src)
    try {
        $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
        $g.Clear([System.Drawing.Color]::Transparent)
        if ($Circle) {
            $path = New-Object System.Drawing.Drawing2D.GraphicsPath
            $path.AddEllipse(0, 0, $size - 1, $size - 1)
            $g.SetClip($path)
        }
        $g.DrawImage($img, 0, 0, $size, $size)
        $g.Dispose()
        New-Item -ItemType Directory -Force (Split-Path $dest -Parent) | Out-Null
        $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
    } finally { $img.Dispose() }
}

# --- Windows (and the PNGs Tauri lists in tauri.conf.json)
$big = Join-Path $clientRes 'drawable-xxxhdpi\icon.png'   # 192 px rounded square
Copy-Item (Join-Path $Client 'Build\Windows\Application.ico') (Join-Path $icons 'icon.ico') -Force
Save-Resized $big 32 (Join-Path $icons '32x32.png')
Save-Resized $big 128 (Join-Path $icons '128x128.png')
Save-Resized $big 256 (Join-Path $icons '128x128@2x.png')
Save-Resized $big 512 (Join-Path $icons 'icon.png')

# --- Android: legacy square and round icons, and the adaptive icon (Android 8+)
$densities = [ordered]@{ mdpi = 1; hdpi = 1.5; xhdpi = 2; xxhdpi = 3; xxxhdpi = 4 }
foreach ($name in $densities.Keys) {
    $scale = $densities[$name]
    $dir = Join-Path $res "mipmap-$name"
    $legacy = Join-Path $clientRes "drawable-$name\icon.png"
    Save-Resized $legacy ([int](48 * $scale)) (Join-Path $dir 'ic_launcher.png')
    Save-Resized $legacy ([int](48 * $scale)) (Join-Path $dir 'ic_launcher_round.png') -Circle
    Copy-Item (Join-Path $clientRes "drawable-$name\icon_foreground.png") (Join-Path $dir 'ic_launcher_foreground.png') -Force
}
$bg = ([xml](Get-Content (Join-Path $clientRes 'values\gfc_icon.xml') -Raw)).resources.color.'#text'
Set-Content -Encoding utf8 (Join-Path $res 'values\gfc_icon.xml') @"
<?xml version="1.0" encoding="utf-8"?>
<!-- Made by scripts\icons.ps1 (the GFC app icon's background) -->
<resources>
    <color name="gfc_icon_background">$bg</color>
</resources>
"@
$adaptive = @"
<?xml version="1.0" encoding="utf-8"?>
<!-- Made by scripts\icons.ps1 from GFC-Client's icon -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/gfc_icon_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"@
New-Item -ItemType Directory -Force (Join-Path $res 'mipmap-anydpi-v26') | Out-Null
Set-Content -Encoding utf8 (Join-Path $res 'mipmap-anydpi-v26\ic_launcher.xml') $adaptive
Set-Content -Encoding utf8 (Join-Path $res 'mipmap-anydpi-v26\ic_launcher_round.xml') $adaptive
Write-Host 'Icons updated from the GFC app icon.' -ForegroundColor Green
