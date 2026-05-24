# MAGI (mobile)

The **MAGI** chat — *Multi-Agent Generative Intelligence* — extracted from
`tk.st`'s `index.html` into a standalone mobile app. It is a **PWA** that can be
packaged for **iOS and Android** with [Capacitor](https://capacitorjs.com/).

The AI itself runs entirely server-side. This app is only the chat client; it
streams from the existing Cloudflare Worker backend (`workers.tk.st/magi2/*`).
Three personas (MELCHIOR / BALTHASAR / CASPER) deliberate, then a unified
"Shinya Takeda" answer streams in. Likes / emoji reactions and per-conversation
history (localStorage) are preserved from the original.

## Layout

```
magi-app/
├── www/                     ← the app (this is what ships)
│   ├── index.html           ← full-screen mobile UI
│   ├── app.js               ← chat, SSE streaming, reactions, history
│   ├── manifest.webmanifest ← PWA manifest
│   └── sw.js                ← service worker (caches shell, never the API)
├── resources/icon.svg       ← source icon for generation
├── capacitor.config.json
├── package.json
└── README.md
```

## 1. Run as a web app / PWA

```bash
cd magi-app
npm run serve        # serves www/ at http://localhost:5173
```

Open it in a mobile browser and "Add to Home Screen" to install as a PWA.

> Pass a different backend with `?api=`, e.g.
> `http://localhost:5173/?api=http://localhost:8787` for local Worker dev.

## 2. Package for iOS / Android (Capacitor)

```bash
cd magi-app
npm install
npm run icons        # generate PNG app icons + splash from resources/icon.svg
npm run add:ios      # adds the ios/ native project   (macOS + Xcode)
npm run add:android  # adds the android/ native project (Android Studio)
npm run sync
npm run open:ios     # or: npm run open:android  → build & run from the IDE
```

- **iOS** requires macOS with Xcode.
- **Android** requires Android Studio (any OS).
- After changing `www/`, re-run `npm run sync`.

## Backend CORS

The Worker at `workers.tk.st/magi2/*` only answers requests whose **Origin** is
on its allowlist (otherwise it requires an `x-api-key`, which is impractical to
ship in a distributed app — and the CORS headers wouldn't match anyway).

This repo's backend has been updated to trust localhost-scheme origins, which is
exactly what Capacitor WebViews use — see
[`workers/magi2/src/index.js`](../workers/magi2/src/index.js) (`APP_ORIGIN_RE`):

| Build               | Origin sent to the backend                     | Allowed? |
|---------------------|------------------------------------------------|----------|
| iOS (Capacitor)     | `https://localhost` (via `iosScheme: https`)   | ✅ |
| Android (Capacitor) | `https://localhost` (via `androidScheme: https`) | ✅ |
| local dev / PWA     | `http://localhost:5173`                         | ✅ |
| Hosted PWA (custom domain) | e.g. `https://magi.tk.st`                | ➕ add it to `ALLOWED_ORIGINS` |

So the native and local-dev builds work out of the box once the Worker is
redeployed:

```bash
cd workers/magi2
npx wrangler deploy
```

If you later host the PWA on a real domain, add that origin to `ALLOWED_ORIGINS`
in the Worker and redeploy. For a quick test against any backend you control,
use `?api=` / `window.MAGI_API_BASE`.

## Release (signed) APK

The release build is signed with a keystore loaded from
`android/keystore.properties` (both the keystore `*.jks` and that properties file
are **gitignored** — never commit them; back them up safely, the key is required
for all future updates if you ever publish).

```bash
cd magi-app/android
# JAVA_HOME = Android Studio's bundled JDK (Windows path shown)
JAVA_HOME="C:\Program Files\Android\Android Studio\jbr" \
  ./gradlew.bat assembleRelease --no-daemon
# → app/build/outputs/apk/release/app-release.apk   (signed, v1+v2)
```

`android/app/build.gradle` reads the signing config like this (re-add if you ever
delete & regenerate `android/`):

```gradle
def keystorePropsFile = rootProject.file('keystore.properties')
def keystoreProps = new Properties()
if (keystorePropsFile.exists()) { keystoreProps.load(new FileInputStream(keystorePropsFile)) }
// android { signingConfigs { release { storeFile rootProject.file(keystoreProps['storeFile']); storePassword ...; keyAlias ...; keyPassword ... } }
//           buildTypes { release { signingConfig signingConfigs.release } } }
```

`android/keystore.properties` format:

```properties
storeFile=../release.jks        # relative to android/
storePassword=********
keyAlias=magi
keyPassword=********
```

Verify a build: `apksigner verify --verbose app-release.apk` (needs `JAVA_HOME`).

To regenerate the keystore from scratch:

```bash
keytool -genkeypair -v -keystore magi-app/release.jks -alias magi \
  -keyalg RSA -keysize 2048 -validity 10000
```

## Notes

- `index.html` of `tk.st` is a self-contained Bitcoin inscription and is **not**
  modified by this project — MAGI here is a faithful re-implementation of that
  client, mobile-first (full screen instead of the right-hand dock).
- No build step or framework: plain HTML/CSS/JS, so it stays light.
