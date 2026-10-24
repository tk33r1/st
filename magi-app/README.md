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
- ︙ → **Check for updates** (Android only) checks on every press. When a newer
  Release exists, `MagiUpdatePlugin` downloads `magi-android.apk` from this
  repository's Release (only the version and SHA-256 come from the screen; the
  URL is fixed and redirects must stay on https `github.com` /
  `*.githubusercontent.com`, at most 64MiB). It installs only when the SHA-256
  matches the asset `digest` GitHub reports, and the package name, signing
  certificate and a higher `versionCode` match the installed app; then it opens
  Android's installer (`REQUEST_INSTALL_PACKAGES`, first use asks for “Allow from
  this source”). Without a digest or the plugin, it links to the download page.
  The banner's Download opens the same panel. Builds before 6.7 lack this and
  must be updated manually once.
  In 6.73, a profile that cannot request installs (Android 13+) is detected before
  downloading. It directs users to update from the main profile instead of
  opening a permission screen that may belong to a different profile (observed
  with Samsung DUAL_APP). Returning without permission now offers the download
  page and does not offer the same install retry. Profiles already allowed to
  install retain the normal update flow. No install restrictions are bypassed.
- The owner-requested 6.71 APK supports `vX.YZ` release tags as well as `vX.Y`.
  Version 6.7 recognizes only `vX.Y`, so install 6.71 from the Android download
  link once. This manual APK release does not change the no-APK policy for
  autonomous daily releases.
- About MAGI in the more menu opens FAQ, Terms of Use, Privacy Policy and Version information. Android checks for APK updates from Version information; Web/PWA shows the current version and release history.
- Privacy Policy comes from `/magi2/models` (10-minute cache). Paragraphs use
  `textContent`; all `requires` flags must be supported by this screen. A failed
  fetch or legacy Worker gives a recipient-neutral fallback instead of stale
  company names. Model labels use `provider_label`, and `themes` can show two LLMs.
  Optional `title` fields are rendered as plain-text headings; legacy Workers
  without them still work. Android notes use the same list and typography, and
  replace the `id: history` browser-storage paragraph with app-storage details.

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

## B3 native reply transport (5.6)

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
original reopened after external-file deletion and an app restart. The separate probe app was removed.
Version 5.6 was published on 2026-10-21 after integrating the newer history and input fixes.
See [the release verification](B3公開評価20261021.md) for the final APK, additional checks,
and the distinction between candidate and release testing. Android 13/14 and other devices remain unverified.

## B4 home widget (5.7, redesigned in 5.9)

The Android home widget is a launcher only. From 5.9 it offers Chat, Camera, Album and
Voice input, modelled on common AI assistant widgets; it shows no conversation content.
Two or more rows place the chat bar above the three buttons; one row places all four in
a line, with icons only below about 250dp. The widget performs no network requests.
Links open the app without sending a message.

Chat (`magi://new`) and voice (`magi://voice`) are handled by the screen. Camera and album
(`magi://camera`, `magi://album`) are opened natively by `MagiSharePlugin`, because the
WebView cannot open a file chooser without a user gesture. The captured photo (through
the existing FileProvider, without the camera permission) or up to four photos from the
system photo picker enter the existing share queue, so the screen starts a new
conversation with them attached. Cancelling leaves the current conversation unchanged.
When a killed process is restored, `MainActivity` drops the stale `magi://` launch link.
Where no speech recognition service exists (Samsung Secure Folder has none), the voice
button stays hidden and the voice link shows a visible notice instead of failing silently.

5.7 and 5.8 also showed the last answer on larger widgets with a masking setting. 5.9
removes that display, `MagiWidgetStore`, `MagiWidgetData` and the screen-to-widget sync,
and deletes the old `magi-widget` preferences on upgrade. Settings keep only the
request to add the widget to the home screen.

Local checks are `test-magi-native-widget.mjs` through `test-magi2.mjs` and
`test-magi-native-widget-browser.mjs`. The debug-only `MagiWidgetProbeActivity` renders
the RemoteViews in a real AppWidgetHostView at three sizes; it is absent from release APKs.

The initial candidate was installed over 5.6 on the test device, preserving all 14 saved-list
entries. Device reboot, home-launcher resize gestures,
other Android versions and launchers remain unverified. Actual speech recognition
is outside this widget check. See [B4 verification](B4実装評価20261021.md).

The later [B3/B4 simplify changes](B3B4simplify確認20261021.md) keep the same version
and behavior: title normalization and native activity intents are shared, and widget
settings initialization is extracted. The rebuilt candidate was checked locally;
it did not replace the earlier candidate on the device during that verification.

The subsequent [review fixes](B3B4レビュー修正20261021.md) register active receipt
under the stream-store lock and read its ID under the same lock. Widget sync captures
the revision first, selects pending answers per conversation, and can restore display
data from the saved SSE without importing or resending the chat. An unrelated pending
answer no longer blocks unmasking a newer conversation. The fixed APK has not been
installed on the test device; its verification is distinct from the initial candidate.

Version 5.8 / 58 adds [further simplification](B3B4simplify追加20261021.md) and
[review fixes](B3B4再レビュー修正20261021.md). The `magi://` intent-filter was removed:
notifications and widgets open `MainActivity` through explicit PendingIntents, so web
pages can no longer reset a chat or start voice input. Pending-stream folders without
`meta.json` no longer break listing, deletion or widget sync, and a service started
after its request already ended calls `startForeground` before stopping.

## Release (signed) APK

Version 5.8 was published on 2026-10-21. See [release verification](B3B4追加公開評価20261021.md)
for the source commit, APK digest, production checks and remaining device checks.
The 5.7 record is [B4 release verification](B4公開評価20261021.md).

Version 5.8 / 58 hardens B3/B4 links, pending streams and service start on top of
5.7, which added B4 home widgets and the B3/B4 review fixes to background receipt
and notifications from 5.6, and B1 history storage and B2 Android share intents and
dictation introduced in 5.5. Shared text is
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

**Version display must always match the release.** Owner releases use `X.Y`
(e.g. `6.0`); autonomous daily releases use `X.YZ`, with Z from 1 to 9 (e.g.
`6.01`). Do not use `6.00`, `5.90`, or `5.100`. Keep `APP_VERSION` in `www/app.js`,
the top page display, Android `versionName`, and the first entry in
`data/magi-versions.json` aligned. The npm version in `package.json` and
`package-lock.json` is `X.Y.0` / `X.Y.Z` (`6.01` becomes `6.0.1`).

Autonomous updates leave Android `versionCode` unchanged and do not create APKs,
GitHub Releases, or tags. Starting with the next APK build, set `versionCode` to
major × 100 plus the two-digit fractional part (`5.9` → 590, `5.91` → 591,
`6.0` → 600). `verify-apk.py` checks this rule against Gradle and the actual APK;
the source regression test checks the aligned display versions independently of
APK build timing. Owner Release tags retain the `vX.Y` form.

Publish the Worker before the web changes. Updated screens request
`/magi2/versions?format=2`, which includes `X.YZ`. Older APKs and cached screens
omit `format=2` and receive only `X.Y` entries, so autonomous releases do not
appear in their history. Add an `X.YZ` history entry only after both Worker and
screens have been published. Bump `app.js?v=` and the `sw.js` cache for PWA
updates; Android receives the changed shell with the next APK. Keep each used
daily version number reserved even after a revert, and stop at `X.Y9`; see
[the daily improvement design](../workers/magi2/magi2継続改善設計書.md#24-版の上げ方2026-10-23-本人決定)
for bump conditions, numbering, and history limits.

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
- Header (5.9): ☰ opens the saved chats and New chat; the ring shows today's
  per-IP usage from `GET /magi2/usage`; ⋮ holds theme, language, share, export
  and the remaining actions.
- Language (5.9): English or Japanese. `app-theme.js` sets `<html lang>` before
  the first paint from the saved choice (`magi_lang`) or the device language.
  Fixed strings carry Japanese in `data-ja`, `data-ja-title`, `data-ja-aria` and
  `data-ja-ph`; built strings use `tr(en, ja)`. Notices from the native helpers
  are written as `English / 日本語` and `pickLang` shows one side. Switching
  redraws the splash and the conversation unless a reply is streaming. The
  chosen language also becomes `ui_language`, the fallback reply language.

## アプリ管理の設定とバグ報告

Web・PWA・Android共通で、︙メニューの「アプリ管理」にパーソナライズをまとめる。オン／オフはトグルで操作し、呼び方・カスタム指示と一緒に「保存」で確定する。キャンセルや戻るでは変更せず、オフにしても入力済みの呼び方・指示を保持する。一時チャットは初期状態でパーソナライズなしとし、中央の選択ボタン（会話開始後は︙の「一時チャットの設定」）から、その会話だけの適用を選ぶ。選択は端末に保存せず、終了時に破棄する。
Androidでは同じ画面に「位置情報サービス」と「通知」のトグル、ウィジェット・履歴の操作も表示する。
Android 6.82以降の位置情報はGPSを優先する。設定を端末内に保存し、次の送信から検索への利用を切り替える（詳細は末尾の「Android GPS」）。
通知設定はAndroidのSharedPreferencesに保存し、オフでは到着通知と自動の通知許可要求を止める。
オンにすると必要に応じてOSの許可を求め、拒否済みの場合はAndroidの通知設定を開く。戻ったときに実際の許可状態を読み直す。
バックグラウンド受信に必要なフォアグラウンドサービスの表示はAndroidが管理する。
この通知操作には更新した `MagiConversation` プラグインを含むAPKが必要。

Web・PWA・Android共通のメニューに「バグを報告」を置く。最大2000文字の本文と、利用者が選んだPNG・JPEG・WebPの画像を `magi@tk.st` に送る。画像は3枚まで、1枚5MiB・合計10MiB。送信前のプレビューと削除に対応し、会話の画像を自動添付しない。
送信失敗時は本文・画像を残す。同じ内容の再試行では報告IDを再利用する。画像の読み込み中・送信中は操作を制限し、画面を閉じると読み込み・通信を中止してプレビューURLを解放する。Workerの `/magi2/bug-report` を先に公開する。

ローカル確認: `node --test .github/scripts/test-magi2.mjs` と `node .github/scripts/test-magi-settings-browser.mjs`。
ブラウザ確認は模擬APIを使い、実メール・有料AI APIは呼ばない。

## Android GPS（6.82）

位置情報は送信時だけAndroid標準の `MagiLocation` プラグインで取得する。GPSを優先し、利用できなければ端末のネットワーク測位も使う。
オンへの切替時と未許可の最初の送信時にOSの権限を求める。Androidでおおよその位置だけ許可した場合はその精度を尊重し、拒否後は送信のたびに再要求しない。
測位は最大8秒、60秒以内の測位結果だけを再利用する。市・地域への変換（AndroidのGeocoder）は最大1.5秒待ち、失敗しても座標で検索できる。
座標は小数4桁に丸め、誤差の目安と測位からの経過時間・変換できた市・地域・国・端末の時刻帯を `device_location` としてWorkerへ送り、検索と照合を担当する会社にも渡す。
座標を履歴の項目やネイティブの受信ファイルに保存せず、表示用の地名にも混ぜない。回答本文に含まれる地名は回答とともに保存される。
測位失敗・権限拒否・位置サービス停止時はIP由来の市・地域へ戻し、画面に通知する。停止ボタン・画面を離れたとき・設定オフでは測位の購読を外す。
オフでは `location_enabled:false` を送り、端末・IPの両方の所在地を検索に使わない。設定変更は次の送信から反映する。
この機能は新しい `MagiLocation` を含むAPKが必要。Workerを先に公開し、APKを更新する。Web・PWA・旧APKは従来のIP推定を維持する。

鮮度はAndroidの単調増加時計から求めた`age_ms`で検査する。GPSの衛星時刻・端末の時計・Workerの時計の差では判定しない。Workerは旧`timestamp`も互換のため受け付ける。

## Temporary chat and personalization (6.9)

The dotted speech bubble starts an empty temporary conversation and restores the previous normal chat when turned off. Temporary chat bypasses history, original-image storage, ratings, sharing and native durable receipt; it keeps copy, retry and supported read-aloud playback. Personalization is off by default and stores the preferred name and custom instructions per device/origin. Temporary chats start without personalization, but their own settings sheet can explicitly apply the saved name and instructions without changing normal-chat settings. The temporary choice stays in memory and resets when the chat ends. The empty-chat view contains a centered notice and a details modal; the dotted speech bubble gains a plus to return to normal chat. See [release verification](6.9公開評価20261025.md).
