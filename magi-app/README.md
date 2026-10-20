# MAGI (mobile)

The **MAGI** chat — *Multi-Agent Generative Intelligence* — extracted from
`tk.st`'s `index.html` into a standalone mobile app. It is a **PWA** that can be
packaged for **iOS and Android** with [Capacitor](https://capacitorjs.com/).

The AI itself runs entirely server-side. This app is only the chat client; it
streams from the existing Cloudflare Worker backend (`workers.tk.st/magi2/*`).
Three personas (MELCHIOR / BALTHASAR / CASPER) deliberate, then a unified
"Shinya Takeda" answer streams in. Likes / emoji reactions and per-conversation
history are preserved from the original. Web/PWA uses localStorage; Android 5.5
uses app-private files.

## Layout

```
magi-app/
├── www/                     ← the app (this is what ships)
│   ├── index.html           ← full-screen mobile UI
│   ├── app.js               ← chat, SSE streaming, reactions, history
│   ├── native-history.js    ← Android file history, migration and image storage
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

## B3 native reply transport (5.6 candidate, unpublished)

The [first prototype](B3試作評価20261020.md) showed that a foreground service alone
did not keep the WebView processing events. Version 5.6 uses a native OkHttp
connection owned by `MagiConversationService` (`dataSync`). It receives and saves
SSE independently of JavaScript, enforces a 300-second deadline, and releases its
wake lock and service on success, failure or cancellation. Capawesome is no
longer a dependency. No location, overlay or battery-optimization exemption is requested.

`magi/pending/<requestId>/` contains metadata and the received SSE. The screen
reads these bytes through `native-background.js`, validates them with the existing
parser, saves the conversation through B1, then acknowledges the pending data.
Reopening after process death replays saved data without repeating the HTTP request.
Conversation IDs and request IDs keep late replies attached to their original chat.
The native service does not write B1's conversation JSON files.

There are two notification channels: silent ongoing discussion and reply arrival.
Notifications show the conversation title, and open it through `magi://open?id=`.
The ongoing Stop action cancels the native HTTP call directly. Notification denial
does not disable chat; Settings shows the permission state and opens Android's settings.

Ordinary builds use the fixed production HTTPS endpoint. For isolated verification,
build `android/gradlew assembleDebug -PmagiB3Probe=true` (Windows: `gradlew.bat`).
This uses **st.tk.magi.b3probe** with a debug signature and a fixed loopback endpoint.
It cannot send paid requests to production. Debug-only notification test actions
are unavailable in normal builds. Do not distribute this test APK.

`probe-magi-background-android.mjs` supplies local synthetic SSE through ADB reverse,
disconnects DevTools, and reads native completion, persistence, notification and
service-stop metadata before reopening the WebView. It then verifies exactly-once
recovery; `--restart=on` also kills the test process before reopening.

The probe checks that the installed APK matches its build file and holds only the
test ACK until native metadata can be inspected. `--hold-ui=on` also pauses screen
reads to demonstrate receipt without JavaScript progress. `--interrupt=on` kills an
unfinished request; it must restore a draft without resending. The deadline case
uses `--seconds=310 --case=stall --hold-ui=on` to exercise the actual 300-second
native timeout. These hooks apply only to the isolated test run. For example:

```powershell
node .github/scripts/probe-magi-background-android.mjs --adb=<SDK>/platform-tools/adb.exe --transport=<ADB-transport-id> --mode=home --seconds=300 --label=home-300-1
```

The other modes are `browser` (opens Chrome at `about:blank`) and `lock` (turns off
the display; unlock the device manually afterwards). The script force-stops only
the test app and removes its forwarding rules at the end. Received replies stay
in app-private pending files until they are saved to the conversation. Verification
reports use synthetic text. Reports and APKs stay
under ignored `workers/.wrangler/magi-b3-native-20261020/`. The approved scope uses
nine synthetic long background trials and three guarded production representatives
(normal, MAGI and a synthetic image). It does not claim that all nine long trials
used production responses, or certify an unpublished candidate as a release.

Local checks: `test-magi2.mjs`, `test-magi-native-background-browser.mjs`, the existing
native shell/input browser checks, and `MagiSseReaderTest` / `MagiArticleReaderTest`.
See [B3 implementation verification](B3実装評価20261020.md) for the current result and limits.

Candidate verification completed on 2026-10-21 on one Android 16 device: all nine
five-minute synthetic background trials passed, including replay after process
death and while screen reads were held. The three approved production representatives
also completed. Existing saved-list entries survived the upgrade; the new image's
original reopened after external-file deletion and an app restart. The separate probe app was removed. Version 5.6
is still unpublished; Android 13/14 and other devices remain unverified.

## Release (signed) APK

Version 5.5 / 55 combines B1 history storage with B2 Android share intents and dictation. Shared text is
placed in a new conversation without sending. Text over 1,000 characters becomes the shared
document as-is, and a URL inside it is not fetched. Articles use bundled Mozilla
Readability 0.6.0 (`scripts/vendor-readability.cjs`, recorded SHA-256 and license
in `www/vendor/`). Shared document text stays with the conversation and is sent
with subsequent questions; only its title is sent to the classifier.

`MagiSharePlugin` copies up to four incoming content-URI images to app cache and
queues incoming intents until the screen is ready. The native article reader
uses OkHttp 4.12.0 with no cookie jar, manually checked redirects (at most three),
an overall 8-second deadline and a 2MiB limit on the decoded HTTP body. This
replaces the proposed CapacitorHttp call because its response API cannot enforce
the size limit while reading. Public HTTP URLs are supported through Android's
cleartext setting; chat still uses its fixed HTTPS endpoint. Native builds do
not register the PWA service worker and remove old app-shell registrations.

Speech uses `@capacitor-community/speech-recognition` 7.0.1. The deterministic
`postinstall` script `scripts/patch-speech.cjs` adds final-result and error events,
tags events with the recognition session ID, and resolves the stop promise
in its Android implementation; run it after any install that used
`--ignore-scripts`. Recognized text is appended on final results. Tapping Send while
listening, leaving the app or the 60-second limit stops listening without sending and
appends the final result; if none arrives within 3 seconds, or recognition ends with an
error, the last partial result is appended instead. The device
language is passed explicitly, with one English fallback for unsupported
languages. Stopping for a conversation switch disables results immediately;
events from earlier recognition sessions are ignored. Microphone permission is requested on the first button press. Voice
may go to the device speech service; it never goes to the MAGI Worker.

Deploy the Worker changes before distributing the APK. See
[B2 verification](B2実装評価20261020.md) for remaining device checks and
[B1/B2 release verification](B1B2公開評価20261020.md) for the 5.5 release record.

B1 history storage, included in 5.5, uses pinned official plugins `@capacitor/filesystem`
8.1.5 and `@capacitor/share` 8.0.3. Android history lives in `Directory.Data/magi/`:
an index, one JSON per conversation, current state, original images named by
SHA-256, and migration metadata. Individual JSON files are written to temporary
files and renamed; a pending journal recovers interrupted batches on startup.
Migration reads files back before removing the old conversation keys. Failed
migration keeps localStorage and retries on the next launch. Failed reads after
migration stop startup rather than overwrite saved conversations.

Android More options → Settings shows storage usage, exports all conversations
through the system share sheet as JSON without images, and deletes all chats and
their images after confirmation. Android automatic backup is disabled for the
whole app. Device replacement requires exporting chats first; image originals
are excluded from the export. Web/PWA retains its existing storage and menus.

Local B1 regression checks run as part of `test-magi2.mjs`; the mock native UI
check is `node .github/scripts/test-magi-native-shell.mjs`. Neither calls AI APIs.
See [B1 implementation record](B1実装評価20261020.md) for coverage and outstanding
release checks. A separate test application ID must be used for destructive
fixtures on a physical device; never clear the installed production app.

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
