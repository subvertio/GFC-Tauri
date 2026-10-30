# GFC (Tauri + three.js)

The Galactic Federation Coin app, rebuilt on [Tauri 2](https://tauri.app) and
[three.js](https://threejs.org). It replaces the Unreal Engine client
(`GFC-Client`) with a much smaller app that talks to the same node API
([build-your-own-frontend.md](https://github.com/subvertio/GFCCoin/blob/master/docs/build-your-own-frontend.md)).

Windows first. The code is laid out so Android (Tauri 2 mobile) can follow: the UI is
plain TypeScript and DOM, and the native parts are small Rust commands.

## Stack

- **Front end:** Vite + TypeScript, no UI framework. `three` is the only runtime library.
- **3D:** three.js `GLTFLoader` with Draco, KTX2 and meshopt; `OrbitControls`; a slow
  turntable that pauses while you drag and resumes 4 s later; neutral studio lighting
  (`RoomEnvironment`); the model's first animation loops. Feed cards load models when
  they come near the viewport and dispose them (GPU memory and WebGL context) when they
  leave. At most 4 live 3D views at once.
- **Network:** every API call goes through Tauri's HTTP plugin (Rust), so nodes don't need
  CORS for the app. Tokens are sent as `Authorization: Bearer`.
- **Native (Rust, `src-tauri/src`):**
  - `secure_store.rs`: the `secure-store` plugin. With "Stay logged in" the session token
    is kept in Windows Credential Manager, nowhere else.
  - `files.rs`: native file pickers, uploads with progress and cancel, saving backups and
    teaser clips. The page never names a path: it gets an opaque id for a file the user
    picked.

## Develop

```
npm install
npm run tauri:dev
```

`tauri:dev` runs as "GFC Dev" (`src-tauri/tauri.dev.conf.json`): its own app identifier,
WebView2 data and Credential Manager entry, so it never touches the installed app's login.

`npm run dev` alone serves the UI in a browser at http://localhost:1420. That only works
against a node that allows that origin (`GFC_CORS_ORIGINS`), and file picking, uploads
and the keychain need the desktop app.

## Build the Windows installer

```
npm run tauri build
```

The NSIS installer lands in `src-tauri/target/release/bundle/nsis/`. It installs per
user and downloads the WebView2 runtime only if Windows doesn't have it (Windows 11
always does).

## Android

Needs the Android SDK (`D:\Android\Sdk`), NDK 27, Android Studio's JDK and the Rust Android
targets (`rustup target add aarch64-linux-android`). The project is in `src-tauri/gen/android`.

```
.\scripts\android.ps1 -Install
```

builds a debug APK and installs it over adb. Debug builds are **GFC Dev**
(`tech.galacticfederation.gfc.dev`): they install next to the GFC app and never replace it.
The script exists because `tauri android build` symlinks the Rust library into the project,
which Windows only allows in Developer Mode.

Release (signed with the same upload key as the Unreal app, so it updates GFC in place; its
version code, 2000 for 0.2.0, is above the Unreal app's):

```
.\scripts\android.ps1 -Release
```

It asks for the key's password (or reads `GFC_KEYSTORE_PASSWORD`). `GFC_KEYSTORE` (default
`D:\GFCKeys\gfc-release.keystore`) and `GFC_KEY_ALIAS` (default `gfc`) override the key; an
untracked `src-tauri/gen/android/app/keystore.properties` (`storeFile`, `storePassword`,
`keyAlias`, `keyPassword`) works too.

On Android, "stay logged in" keeps the token encrypted with an Android Keystore key, files from
the pickers are `content://` URIs opened through `GfcNativePlugin.kt`, downloads and backups go to
Download/, teasers to Movies/GFC, and sharing uses the system share sheet.

## Testing against a local test net

Never post or transfer on the live node while testing. Run a node locally with a
throwaway treasury key (`GFC_TREASURY_PUBKEYS`, which makes it a test net) and its own
`GFC_DATA_DIR`, keep P2P isolated, then pick **Local test node** (`http://127.0.0.1:8100`)
on the login screen.

## Layout

| Path | What |
|---|---|
| `src/api.ts` | The node API client and types |
| `src/session.ts` | Login state, node choice, known wallets, last-seen balances |
| `src/app.ts` | Shell, router, left nav, right rail (search, balance, trending, top earners) |
| `src/screens/` | Feed pages, login, post detail, new post, wallet |
| `src/ui/` | Cards, post actions, exclusives, media playback rules, DOM helpers |
| `src/viewer3d.ts` | The three.js model view and lazy feed mounting |
| `src/styles.css` | All colours as tokens (dark; accent `#3b4cca`, exclusives `#ffd400`) |
