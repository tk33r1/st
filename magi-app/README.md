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
│   ├── icon-*.png           ← PWA / home-screen icons (192, 512, maskable 512)
│   └── sw.js                ← service worker (caches shell, never the API)
├── resources/icon.svg       ← source icon for the native app icons
├── capacitor.config.json
├── package.json
└── README.md
```

## 1. Run as a web app / PWA

The public web app is [https://tk.st/magi-app/www/](https://tk.st/magi-app/www/).
For iPhone users, this PWA is the current distribution method. Open it in Safari,
choose Share → Add to Home Screen, enable Open as Web App if shown, and tap Add.
The start screen and More options menu include the instructions; the top-page
iPhone button opens them directly. Chat requires an internet connection.

Android users can also download the signed APK from
[the Android download link](https://tk.st/magi-app/android/).
Native iOS packaging is deferred until App Store distribution is requested;
the steps below are retained for that future work.

```bash
cd magi-app
npm run serve        # serves www/ at http://localhost:5173
```

Open it in a mobile browser and "Add to Home Screen" to install as a PWA.

> Local browser development can select a loopback backend with `?api=`, e.g.
> `http://localhost:5173/?api=http://localhost:8787` for local Worker dev.
> Hosted pages and native builds always use `https://workers.tk.st`.

## 2. Package for iOS / Android (Capacitor)

```bash
cd magi-app
npm install
npm run add:ios      # adds the ios/ native project   (macOS + Xcode)
npm run add:android  # adds the android/ native project (Android Studio)
npm run icons        # generate native app icons + splash from resources/icon.svg
npm run sync
npm run open:ios     # or: npm run open:android  → build & run from the IDE
```

- **iOS** requires macOS with Xcode.
- **Android** requires Android Studio (any OS).
- B0 (5.3): Capacitor **8.5.3**, Node **22+**,
  Android Studio **Otter 2025.2.1+** with JDK **21**, Android SDK **36**,
  AGP **8.13.0**, Gradle **8.14.3**. Android **7.0 / API 24+** is required.
  Migration follows the official [6→7](https://capacitorjs.com/docs/updating/7-0)
  and [7→8](https://capacitorjs.com/docs/updating/8-0) guides in order.
- After changing `www/`, re-run `npm run sync`.
  Sync now targets Android only; no iOS project is generated or updated.
- The native Android shell uses the built-in SystemBars insets and the official
  App back handler. Back closes panels / menus first, then exits at the root.
  These plugins are never registered by the Web/PWA client. Keyboard visibility,
  system bars and predictive back still require device checks for each release.
- `npm run icons` uses the existing `@capacitor/assets` generator for Android,
  keeps splash backgrounds at `#0c0c0c`, restores both adaptive icons' `monochrome`
  layer, and rasterizes all three PWA PNGs. Sources are `resources/icon.svg` and
  `resources/icon-monochrome.svg`; the digits are paths so font substitution cannot
  change the output. `scripts/generate-icons.cjs` owns these steps.
- Android sources are tracked. Build outputs, copied `assets/public/`, local SDK
  paths, signing files and release work files stay ignored. On a clean clone:
  `npm ci` → `npx cap sync android` → `android/gradlew assembleDebug` (Windows:
  `android\gradlew.bat`). Set `JAVA_HOME` and the Android SDK locally.
- Android `AppTheme` uses DayNight. The page chooses its initial theme before
  rendering, follows system changes until the theme button is used, and never
  saves that button's choice. If the system preference is unavailable it uses
  light from 06:00–17:59 and dark at other times.
- Native builds check the public GitHub latest-release API at most once per 24
  hours, stop after 5 seconds and quietly ignore failures. Web/PWA never contact
  GitHub for updates. Dismissing a version hides that version; the next one can
  still be shown.
- System & Privacy comes from `/magi2/models` (10-minute cache). Paragraphs use
  `textContent`; all `requires` flags must be supported by this screen. A failed
  fetch or legacy Worker gives a recipient-neutral fallback instead of stale
  company names. Model labels use `provider_label`, and `themes` can show two LLMs.

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
use a local browser server and a loopback `?api=` / `window.MAGI_API_BASE` URL.

## Release (signed) APK

**Version display must always match the release.** Before every APK build, set the
same `X.Y` in all four places: `magi-app/package.json` (`X.Y.0`), the
`APP_VERSION` constant in `www/app.js`, the `ver X.Y` display in the top page `../index.html`, and `versionName` in
`android/app/build.gradle` (raise `versionCode` too, e.g. 4.5 → 45). Push the web
side (with the `app.js?v=` / `sw.js` cache bump) in the same release so the PWA,
the top page and the APK show the same version. `node --test .github/scripts/test-magi2.mjs`
fails if any disagree (including Android versionCode).

Before uploading any APK, verify the actual packaged files against the Git
commit, Android version and the previous distribution's certificate:

```bash
# JAVA_HOME must be set; use the installed SDK build-tools directory.
python magi-app/scripts/verify-apk.py --apk magi-app/android/app/build/outputs/apk/release/app-release.apk --reference magi-app/magi-android.apk --commit HEAD --build-tools "$ANDROID_HOME/build-tools/34.0.0" --report workers/.wrangler/magi2-app46-eval/apk.json
```

This reads every tracked `www/` file from Git and compares its exact bytes in
`assets/public/`. A stale `cap sync`, missing file, extra non-runtime file, wrong
version, certificate change or missing v1/v2 signature fails the check. Run
`npx cap sync android` after the final edit. APKs and raw reports stay ignored.

For an **unpublished prototype only**, replace `--commit HEAD` with
`--working-tree` to compare saved local sources (including new, non-ignored
`www/` files). The report marks `source: working-tree`; it does not certify a
release commit. Repeat with `--commit` after committing, before distribution.

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
