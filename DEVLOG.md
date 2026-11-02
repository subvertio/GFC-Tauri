# GFC app dev log

The GFC app (Tauri 2 + three.js) for Windows and Android. Newest entries first, under the
release pipeline every release follows.

## Release pipeline: build, publish once, every download location follows

**Rule:** installers are published to the node **only**. Every download link (the node's
pages, the web feed, share pages, the get-the-app pop-up and both galacticfederation.tech
pages) points at the node, so one publish updates them all. Never upload an installer or
APK to Wix or anywhere else: a copy there goes stale with the next release. (The Wix home page
buttons did, and served 0.2.0 and the old Unreal APK until 2026-10-31.)

### 1. Version

Bump the version in all three, the same number:

- `src-tauri/tauri.conf.json` (`version`)
- `src-tauri/Cargo.toml` (`version`)
- `package.json` (`version`)

Android's version code comes from it (0.2.1 is 2001). It must be higher than the version code
phones already have, or they won't install it as an update.

### 2. Build

Windows (the build signs the update with the updater key; it asks for nothing, so the password
is entered first):

```powershell
cd D:\projects\GFC-Tauri; $env:TAURI_SIGNING_PRIVATE_KEY = 'D:\GFCKeys\gfc-updater.key'; $s = Read-Host -AsSecureString 'Updater key password'; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); npx.cmd tauri build; Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
Compress-Archive -Path .\src-tauri\target\release\bundle\nsis\GFC_<version>_x64-setup.exe -DestinationPath .\Packaged\GFC-Setup-<version>-Windows.zip -Force
Copy-Item .\src-tauri\target\release\bundle\nsis\GFC_<version>_x64-setup.exe.sig .\Packaged\
```

The build must leave `GFC_<version>_x64-setup.exe.sig` next to the installer: that's what lets
installed apps update themselves. The updater key (`D:\GFCKeys\gfc-updater.key`, password in the
password manager as "GFC updater key") is the only key the apps accept updates from; losing it
means every user has to reinstall by hand. Its public half is in `tauri.conf.json`
(`plugins.updater.pubkey`) and in the node's `GFC_UPDATER_PUBKEY`.

Android: build the release, then sign it with the upload key (it asks for the password):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\android.ps1 -Release
```

Or build unsigned and sign separately with `apksigner` (see the commands in the 0.2.1 entry).

- **Check the Rust library was rebuilt** (`src-tauri\target\aarch64-linux-android\release\libgfc_lib.so` has a new time).
  If the Rust build fails, Gradle still packages the *old* library into a fresh-looking APK.
- **Check the signature is the release key:**
  `apksigner verify --print-certs <apk>` must show SHA-256
  `323133e4e13e4fc0f65f28d745b9ee6c1799401408d8f6d0e73ee5e721eb725c`. That's the same key as the
  Unreal app, so the APK updates it in place.

### 3. Test on real devices

- **Windows:** run `src-tauri\target\release\gfc.exe`.
- **Android:** `adb install -r <signed apk>` on the moto g and the Samsung. `-r` keeps the app's
  data; never uninstall first.

### 4. Node first, if the release needs node changes

Merge the GFCCoin PRs, then:

```powershell
ssh gfc-node "gfc update"
```

### 5. Publish to the node (the only place)

```powershell
scp '.\Packaged\GFC-Setup-<version>-Windows.zip' '.\Packaged\GFC_<version>_x64-setup.exe.sig' gfc-node:/tmp/; ssh gfc-node "sudo gfc publish-windows /tmp/GFC-Setup-<version>-Windows.zip <version> /tmp/GFC_<version>_x64-setup.exe.sig"
scp '.\Packaged\GFC-<version>-arm64-release.apk' gfc-node:/tmp/GFC-<version>.apk; ssh gfc-node "sudo gfc publish-app /tmp/GFC-<version>.apk <version>"
```

`publish-app` refuses an APK that isn't signed with the release key, and `publish-windows`
refuses an installer whose updater signature doesn't check out.

**Updates reach users by themselves** (from 0.2.3 on):

- **Windows** checks `/app/windows/update.json` at launch and every 6 hours, downloads the signed
  installer in the background, and shows "GFC x.y.z is ready: Restart to update".
- **Android** checks `/app/release.json` and shows "GFC x.y.z is available: Update", which opens
  the download; Android then asks to install it over the old one (it can't update silently
  outside the Play Store).

Anyone on 0.2.2 or older has to install 0.2.3 by hand once.

### 6. Check every location serves it

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-downloads.ps1 -Version <version>
# or, when only one app was released:  -Windows <version> -Android <current android version>
```

The script checks the node's versions, that the files served match the ones in `Packaged\` byte
for byte, and that the web feed and both galacticfederation.tech pages link to the node.

Where the download links are (all via the node):

| Location | Windows | Android |
|---|---|---|
| Node download page | `node.galacticfederation.tech/app` | same page |
| Direct files | `/app/windows` | `/app/gfc.apk` |
| Android install steps | | `/app/android` |
| Web feed and share page header | "Get GFC for Windows" → `/app/windows` | "Get GFC for Android" → `/app/android` |
| Get-the-app pop-up | `/app/windows` | `/app/android` |
| galacticfederation.tech home page (HTML embed `#html1`) | "Download for Windows" → `/app/windows` | "Download the app (APK)" → `/app/android` |
| galacticfederation.tech/gfcwhitepaper | `/app#windows` | `/app` |

If a new download link is ever added anywhere, point it at one of these node addresses and add it
to this table and to `scripts/check-downloads.ps1`.

### 7. Afterwards

- Add an entry below.
- If the white paper mentions the app's version or engine, update its wording too.

---

## 0.2.4 (2026-11-02): Windows

Published 2026-11-02 ~05:15 Central: Windows only (3.3 MB zip, signed; SHA-256
`e721662554adee931b6e091b4d71a0caba90e0fad97feefe72ca5bbf07ec431d`). `check-downloads.ps1
-Windows 0.2.4 -Android 0.2.3` passed. The first real self-update (0.2.3 -> 0.2.4). Android
stays at 0.2.3 until the next Android build.

**New**

- **Bridge to Base** (PR #1): moves GFC from a ledger wallet to the user's Base address as the
  GFC token. Live on mainnet: token `0xc32695f463947170EC142F7987DaC93aa7243336`, bridge
  `0x31A5e7bA6210aaD1e6Aa9b15a263E3F5ed5AfA38` (the node's `/bridge/info`). Send refuses 0x addresses.
- **Bring GFC back** (PR #3): step-by-step Blockscout Write contract instructions (approve, then
  bridgeOut) with copy buttons, because MetaMask Mobile's send screen has no hex data field.
- **History** (PR #2): readable bridge rows; long notes no longer run into the amount.

## 0.2.3 (2026-11-01): Windows and Android

Published 2026-11-01 ~17:32 UTC: Windows (3.4 MB zip, signed for self-updates; the live
`/app/windows/update.json` serves 0.2.3 and `update.exe` matches the build byte for byte) and
Android (11.2 MB APK, version code 2003, release key checked). `check-downloads.ps1 -Version 0.2.3`
passed. The first real self-update will be 0.2.3 → 0.2.4.

**New**

- **Updates itself.** Windows downloads signed updates from the node and asks to restart;
  Android shows "update available" and opens the download (see the pipeline above). Anyone on
  0.2.2 or older installs 0.2.3 by hand once. (node: GFCCoin PR #67)
- **Version number** on the login screen, in the account menu and in the side panel.
- **Ka-ching!** Every time your GFC goes up while the app is open (checked every 30 seconds),
  the coin burst plays with the original GFC ka-ching sound, as it did in the Unreal app.
- **Connect another site:** one-time codes for partner sign-ups such as creator-world.org
  (node: GFCCoin PR #64).

**Fixed**

- Usernames typed as "@Name" log in (the box says "without @"), and a failed login says whether
  the username or the password was wrong. (BubbaStartz typed "@BubbaStartz".) (node: GFCCoin PR #66)

## 0.2.2 (2026-10-31): Windows and Android

Android published 2026-10-31 (10.6 MB APK, version code 2002, release key checked); both apps checked with
`check-downloads.ps1 -Version 0.2.2`.

Published: Windows 2026-10-31 17:46 UTC (3.1 MB zip). Android followed the same day.

- Downloads: a virus-scanner error (the scanner restarting) now says it's being retried, not that the file failed
  (node: GFCCoin PR #62 retries after 1, 5 and 15 minutes).

**New**

- **GFC Ads** (node: GFCCoin PR #61):
  - **Promote this post (ad)** in a post's ••• menu: a budget, a max price per 1,000 views
    (the live market rate is shown, with the views the budget buys), 1-30 days, and which wallet pays;
  - **Your ads** in the left rail and the ••• menu: views, spend, what creators were paid, and Stop ad
    (the unspent budget comes back at once);
  - **Sponsored** posts in For you, one after every 8 posts, kept right under the post the node placed
    them after. That post's creator is paid 70% of each counted view, instantly. A view is reported once
    the ad has been 60% on screen for 1 second.
- **Comment bubble** (💬 and the count) on every post. It opens the post's comments under it, with a
  reply box; replies show at once.

## 0.2.1 (2026-10-31)

Published: Windows 2026-10-31 16:39 UTC (3.1 MB zip), Android 2026-10-31 16:48 UTC (10.6 MB APK).

**New**

- **Following and Bookmarks tabs:**
  - the home tabs are now For you, Following, Bookmarks;
  - Follow / Following on every post and creator profile, with follower counts (node: follows API);
  - tapping a creator's name or avatar opens their profile.
- **Edit profile:** photo (cropped square, 512 px JPEG), name and bio. The node now accepts only
  real JPEG, PNG, GIF or WebP images up to 5 MB as profile photos.
- **Batch upload (Windows):**
  - Add folders and Add videos (Ctrl- or Shift-click for several); each pick adds to the list;
  - titles come from file names, and one description, tags and Exclusive setting cover all;
  - videos post one after another with progress, Stop and Cancel.
- **Big videos:**
  - posts are up to 5 GB, and videos can be uploaded up to 8 GB when GFC's optimised copy fits;
  - the app estimates the optimised size from the video's header before uploading, or shows a
    tip with the bitrate to export at;
  - zip downloads stop at 4 GB, the most ClamAV can scan.
- **Server-side optimisation (node):**
  - oversized videos are re-encoded at the same resolution, at visually lossless quality (CRF 20),
    capped per resolution;
  - the original is replaced only if the copy is at least 25% smaller;
  - the node makes thumbnails for big videos.
- **OneDrive:**
  - online-only videos are marked and download one at a time with progress;
  - a tip with a Start OneDrive button when OneDrive isn't running;
  - plain messages for cloud-file errors (0x80070194).
- **Icon:** the real GFC icon on Windows and Android, replacing Tauri's default.

**Fixed**

- The Android build: batch folder picking is desktop-only.
- Batch titles keep dashes, so dates like 1-23-2025 stay intact.
- The bitrate tip shows one decimal and suggests 720p.

**Signing the Android APK by hand** (if `scripts\android.ps1 -Release` can't be used):

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'; & 'D:\Android\Sdk\build-tools\36.0.0\apksigner.bat' sign --ks 'D:\GFCKeys\gfc-release.keystore' --ks-key-alias gfc --out '.\Packaged\GFC-<version>-arm64-release.apk' '.\Packaged\GFC-<version>-arm64-release-unsigned.apk'
```

**Release notes for the node:** GFCCoin PRs #56 (follows), #57 (profile photos), #58 and #59
(big uploads and optimisation), #60 (5 GB limits and the bitrate tip).
