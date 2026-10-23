# AGENTS.md — tk.st

個人サイト **tk.st**（Shinya Takeda のターミナル風ポートフォリオ）のリポジトリ。
静的 HTML/CSS/JS のサイト本体と、動的機能を担う Cloudflare Workers 群で構成される。
リモートは `https://github.com/tk33r1/st.git`（ブランチは `main`）。リポジトリは GitHub で全体公開している。

## プロジェクト概要

- **サイト本体**: ビルド工程のない静的ファイル。各ページは `*/index.html` にスタイルとスクリプトをほぼ内包する
  自給自足型。公開 URL はディレクトリ構造と一致する（`tools/pdf-studio/index.html` → `https://tk.st/tools/pdf-studio/`）。
  何をサイトに出すかは `build.sh` が決める（後述「公開範囲」）。
- **Workers** (`workers/`): 認証・DB・AI 呼び出しなどのサーバーサイド機能。Cloudflare Workers + D1 (SQLite)。
  入口は各 Worker の `src/index.js`（`export default { async fetch(request, env) {...} }` の標準形）。
  共通モデル設定は `config/ai-models.json`、magi2 の設定は `personas.js`、サイト案内の処理は `site-search.js`。
- **MAGI アプリ** (`magi-app/`): MAGI チャットのモバイル版。PWA + Capacitor 8。同期はAndroidのみ。iPhoneはPWAで配布する。
- **GitHub Actions** (`.github/`): 日刊ブリーフの生成と X 投稿、MAGI の人格カード、サイトマップ、ガソリン価格、
  AI モデルの検査、Worker のデプロイ（後述「デプロイ」）。

### 外部参照の制約

- **トップページ（ルートの `index.html`）**: Bitcoin の Witness 領域（Ordinals インスクリプション）にも刻んであるため、
  外部フォント / CDN / 外部アセットを足さない（CSS・JS・アイコン・QR はすべてインライン）。
  **例外は head の Ahrefs と GTM の2本だけ**で、これは公開サイト側の計測用。インスクリプション版はこの2行を落としたもの。
  もう1つ、サイドバーの Search を開いたときに、**tk.st の上でだけ**共通検索（`/assets/` の search-ui などと `/data/` の索引）を遅れて読み、
  コマンドとサイトのページを一緒に探す（読む資産と版は `index.html` の `SHARED_SEARCH_ASSETS`。共通検索の版を上げたらここも上げる）。
  tk.st 以外（インスクリプション版など）や読めなかったときは、インラインのコマンド検索のまま動くので、インスクリプション版から落とす行は無い。
- **SAFE TOOLS（`tools/` 配下）**: 外部とやりとりするのはアクセス解析だけ（後述「SAFE TOOLS の通信制限」）。
- **それ以外のページ**: Google Fonts などの Web フォントや CDN の CSS/JS を読み込んでよい。
- どのページでも、フレームワーク・ビルドツールを勝手に持ち込まない。

## ディレクトリ構成

| パス | 内容 |
| --- | --- |
| `index.html` | トップページ。ターミナル風ポートフォリオ兼 MAGI チャット UI（英語メイン）。巨大かつ高頻度で編集される |
| `data/` | データ（JSON）だけを置く。ここに置いたものはすべて公開される。手で直す正本は `tools.json`・`game.json`（一覧）と `glitch.json`（記事メタ）、`magi-versions.json`（MAGIの更新履歴）。GitHub Actions が作る生成物（手で編集しない）は `oil-price.json`、`magi-context.json`（MAGI の人格カード。magi2 が `https://tk.st/data/magi-context.json` から読むので場所を変えない）、`nitori-daily/`・`retail-tech-daily/`（日刊の号データ。年ごとの `<YYYY>.json`。読み書きは `daily_engine.py` の `load_history`/`save_history` を通す）、`nitori-tiktok-buzz.json`（日刊ニトリ用の TikTok の取得結果）、`search-boost.json`（共通検索の候補クリックの集計。`search-boost.yml` が作る） |
| `assets/` | 区画をまたいで使う自前のコードと、取り込んだ外部物。`analytics.js`（GTM と Ahrefs の読み込み。ID はここにだけ書く）、`site-search.js`（検索②の通信・応答検査、`window.STSiteSearch`。旧画面APIも保持）。検索Phase 4の共通①は`japanese-search.js`、UIは`search-ui.js`+`.css`（[UI改修設計](assets/site-search-ui-redesign.md): 操作と構造は共通、見た目と結果の描画はページに従う）、対象別の宣言は`search-data.js`、大きな公開JSONの生バイトhashと解析を行うBlob Workerは`search-json-worker.js`（辞書・通信は持たない）、`buy-me-oil.js`（寄付ウィジェット。`oil-price.json` は自分の場所から `../data/` を引く）、`bijutsu-shisui.js`+`.css`（DJ の各ページと `anniversary/mitsuki32/` の背景演出）、`vendor/`・`fonts/`（取り込んだライブラリとフォント。後述「SAFE TOOLS の通信制限」） |
| `files/` | ダウンロード用の資料（PDF）。トップページからリンクしている。旧 `data/` の URL は `_redirects` で 301（インスクリプション版のトップページが旧 URL を持っているので外さない） |
| `tools/` | ブラウザ内完結のツール群（SAFE TOOLS）。共通部品は `tools/assets/`: `tools-ui.js`+`tools-ui.css`（共通 UI、`window.STCommon`。ドロップ枠・保存・コンソール表示・FFmpeg の読み込みのほか、テーマの切り替え（描画前の反映を含む）・先頭へ戻るボタン・パンくずの印も受け持つので、ページ側に書かない）、`tools-base.css`（土台のリセットとアイコン寸法などの部品クラス。QR Palette は読まない）、`tools-share.js`（完了時のシェア/寄付のお願い、`window.STShare`）。アクセント色は `tools.json` の `category` と同じ値を `<html data-category="…">` に書いて決める（`tools-ui.css` の `--cat-*`）。ページの CSS で `--accent` を持たない |
| `images/` | `contents/`（ページ内の画像。区画ごとに分ける: `dj/`、`glitch/<記事番号>/`、`motovlog/`）、`favicons/`（ファビコンと apple-touch-icon。iOS は SVG を使えないので、SVG とは別に 180px の PNG を置く）、`ogp/`（各ページの OGP 画像、2400×1260。ツールなどの分は手元で `.github/scripts/ogp/` のスクリプトを叩いて作る（同 `README.md`）。手で描き直さない。日刊の号別カードは日刊の workflow が `images/ogp/<media_id>/<YYYYMMDD>.webp` に作る） |
| `game/` | ゲーム群。ランキングは `workers/games` |
| `glitch/` | 技術ブログ。記事メタは `data/glitch.json` にだけ持ち、`glitch/assets/glitch.js` が描く（記事を足すときは HTML ではなく JSON を編集する）。コメントは `workers/comments` |
| `dj/` | DJ 関連。`index.html`（ポートフォリオ。末尾に出演オファーフォーム）、`schedule/`（日程調整）、`request/`（曲リクエスト。`catalog.js` は iTunes 検索と AI 推薦曲の照合）、`booth/`（ブースコンソール。`audio-analysis.js` は30秒プレビューから BPM とキーをブラウザ内で推定する。音声はどこにも送らない）。共通部品は `dj/assets/`: `dj-modal.js`+`.css`（モーダル）、`dj-request-core.js`（`request/` と `booth/` の共通処理、`window.DJRequestCore`。API 呼び出し・localStorage・プレビューの再生・日時の整形・`escapeHTML`・`appleHref`） |
| `job/` | 職務ページと日刊ブリーフ（`nitoridaily/`・`retailtechdaily/`。号ページは GitHub Actions が生成する。横断検索の索引は年ごとに分け、`search-index.json` に最新の年の記事と年の一覧、それより前の年は `search-index-<年>.json`）。日刊の共通部品は `job/assets/` |
| `magi/`, `contact/`, `thought/` | 個別ページ（`magi/` は旧 MAGI で、`workers/magi` を呼ぶ） |
| `motovlog/` | ハーレーのモトブログ（LIBERTY MOTOVLOG）。OGP は `.github/scripts/ogp/generate-motovlog.js` |
| `anniversary/` | 記念日ページ |
| `workers/` | Cloudflare Workers（下表）。`workers/package.json` は全 Worker 共通の wrangler |
| `config/` | AI モデル設定の正本 `ai-models.json`（後述「AIモデル設定」） |
| `magi-app/` | MAGI モバイルアプリ。`www/` が出荷物。画面の版の表示（`www/app.js` とトップページの `ver X.Y`）・`package.json` の version・Android の versionName は常に同じ値にする（`magi-app/README.md`「Release」） |
| `build.sh` | Cloudflare Pages のビルド（後述「公開範囲」「デプロイ」） |

### ファイルの置き場所

ビルド工程がないので、ページはパスを直書きして読む。置き場所は次の順で決める。

1. 1ページでしか使わない JS・CSS は、そのページの横に置く（例: `dj/request/catalog.js`）
2. 1つの区画（`tools/`・`dj/`・`glitch/`・`job/` など）の複数のページで使うものは、その区画の `assets/` に置く
3. 区画をまたいで使うものは、ルートの `assets/` に置く。
   例外は QR Palette の部品（`tools/qr-palette/` の `qr-core.js`・`qr-style.js`・`qr-assets.js`・`qr-export.js`）。持ち主は QR Palette で、`dj/request/` と `.github/scripts/ogp/generate-qr-artwork.js` はそれを借りて読んでいる。直したら借りている側も確かめる
4. 外部から取り込んだライブラリ・フォントは `assets/vendor/`・`assets/fonts/`。取り込みスクリプトを通し、手で置かない
5. データ（JSON）は `data/` に置く。GitHub Actions が作るものは、上の表に「手で編集しない」と書く
6. ダウンロード用の資料は `files/` に置く
7. 画像は `images/` に置く（ページの横には置かない。OGP やファビコンは外部から絶対 URL で参照されるため、1か所にまとめる）。
   ページ内の画像は `images/contents/<区画>/`。ファイル名は小文字のハイフン区切りにし、空白・大文字・`_` を使わない
   （空白は URL で `%20` になり、大文字小文字の違いは環境によって別のファイルになる）。高解像度版は `@2x` を付ける。
   手で作る OGP 画像は WebP にする（PNG だと 1MB を超えることがある）。
   例外は `magi-app/www/` の PWA アイコン（`icon-*.png`）。Capacitor はアプリに `www/` しか同梱しないので、出荷物の中に置く
8. 設計書・企画書は、対象のページの横に `.md` で置く（例: `game/masala-tetris-tiffin/企画書.md`）。区画全体に関わるものは `<区画>/README.md`。
   拡張子は小文字の `.md` にする（`build.sh` は `*.md` をサイトに出さないが、`.MD`・`.txt`・`.html` などは出る）。
   GitHub では公開されるので、キーや個人情報は書かない。公開したあとは冒頭に「実装済み（日付）。正本はコード」と書き、以後は直さない

### 公開範囲

公開される場所は2つあり、決まり方が違う。

- **GitHub**: Git が管理しているファイルはすべて公開される（`.gitignore` に当たるものだけが出ない）。
- **tk.st**: `build.sh` が Git の管理下のファイルのうち、`private()` に当たらないものすべてを `_site/` に写して出す
  （ページを足すたびに書き足す必要はない）。出さないのはドットファイル（`.github/`・`.claude/` など。`.well-known/` は出す）、
  `AGENTS.md`・`build.sh`、`workers/`・`config/`、`magi-app/` の `www/` 以外、reverse-recaptcha のソース、
  `*.md`（`assets/vendor/` のライセンス文は出す）。それ以外はどこに置いても公開される。

公開した URL は外部から直リンクされうるので、動かしたら必ず `_redirects` に 301 を足す
（公開をやめるだけのもの、行き先が1つに決まらないものは張らない）。

### Workers 一覧（各ディレクトリに `wrangler.toml` と `src/index.js`）

Cloudflare は route の重複を許さないため、Worker 同士で接頭辞を分ける。

| Worker | 名前 | ルート | 用途 |
| --- | --- | --- | --- |
| `workers/comments` | tk-st-comments | `tk.st/glitch/api/*` | glitch 記事のコメント。D1: `glitch-comments-db`。secret: `ADMIN_KEY`（管理操作）、`CLIENT_API_KEY`（サイト外から呼ぶとき） |
| `workers/dj-schedule` | tk-st-dj-schedule | `tk.st/dj/api/schedule/*` | 日程調整 API。D1: `dj-schedule-db`。**詳細は同ディレクトリの README.md を読むこと** |
| `workers/dj-request` | tk-st-dj-request | `tk.st/dj/api/req/*` | 曲リクエスト API。D1: `dj-request-db`。secret: `IP_SALT`, `SONGBPM_KEY`, `OPENAI_API_KEY`。ブース向けに曲の背景カード（OpenAI の Web 検索を強制、出典を照合した事実だけ保存、trackId ごとにイベントをまたいで使い回し、1日の生成数に上限）も作る。投稿時に作り、取りこぼした曲はブースの一覧読み込みのついでに裏で作る |
| `workers/dj-offer` | tk-st-dj-offer | `tk.st/dj/api/offer/*` | 出演オファーフォームの受け口。D1 なし（内容は Resend でメール転送するだけ）。secret: `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, `OFFER_TO`, `OFFER_FROM`。**Resend / Turnstile の初期設定は同ディレクトリの README.md を読むこと** |
| `workers/magi` | tk-st-magi-api | `workers.tk.st/magi*` | MAGI 旧版（`magi/` が呼ぶ）。secret: `MAGI_API_KEY`、`CLIENT_API_KEY` |
| `workers/magi2` | tk-st-magi2-api | `workers.tk.st/magi2*`、`tk.st/search/api/*` | MAGI 現行（3人格＋統合、SSE ストリーミング（トップページと PWA は同じイベントを WebSocket の `/magi2/ws` で受け、開けなければ SSE。止めるのは `WS_ENABLED`）、画像対応。後述「magi2 の人格設定」）。D1: `tk-st-magi2-db`。secret: `MAGI_OPENAI_API_KEY`・`MAGI_DEEPSEEK_API_KEY`・`MAGI_ANTHROPIC_API_KEY`、`CLIENT_API_KEY`。任意で `MAGI_TYPESAFE_API_KEY`（発言の分類と会話の初回の言語判定、404 のサイト内検索の②。無ければ手元の規則、②は使えない）、`SEARCH_CLICK_SALT`（共通検索の候補クリックの記録で IP をハッシュにする塩。無ければ記録しない）、`RESEND_API_KEY`・`ALERT_TO`・`ALERT_FROM`（各社の残高切れ・キーの失効をメールで知らせる。同 README.md）、`MAGI_FISH_AUDIO_API_KEY`・`SPEECH_SIGN_KEY`（統合人格の回答の読み上げ。`SPEECH_ENABLED` と3つそろったときだけ開く。同 README.md「読み上げ」） |
| `workers/magi2`（env.eval） | tk-st-magi2-eval | `magi2-eval.tk.st/magi2*` | 評価専用（DB未作成）。専用DB `tk-st-magi2-eval-db` とAccessを先に設定し、手動で `--env eval` を付けて公開する。通常のdeploy-worker.ymlには入れず、評価後の片付けはmagi2/README.mdに従う |
| `workers/games` | st-games-api | ルートなし（`*.workers.dev` 直叩き） | ゲーム共通 API（ランキング、AI 呼び出し）。2026-10-17、代表7場面の確認後にHaikuを採用。D1: `st-games-ranking-db`。secret: `GAME_ANTHROPIC_API_KEY`（現行）、`GAME_OPENAI_API_KEY`（旧OpenAI設定用）。モデルはWorkerの`GAME_AI_PROVIDER`で選び、クライアントから変更させない |

## ビルドとテスト

- **ビルド工程は存在しない**。例外は `game/reverse-recaptcha/`（Vite + React）。リポジトリにあるのはソースで、
  `build.sh` がビルドした結果（`assets/index-*.js` を読む `index.html`）を同じ場所（`/game/reverse-recaptcha/`）に置く。
  `src/` から import していないファイルや `public/` の未参照ファイルは置かない。
- 公開されるものを手元で確かめるには `bash build.sh` → `python3 -m http.server --directory _site`。
- **テストスイートも存在しない**。検証は構文チェックと手動確認で行う。ルートの `index.html` を変えたら、
  下の script 抽出＋`node --check` で構文を確かめるのがこのリポジトリの習慣:
  ```bash
  # Worker の構文チェック
  node --check workers/<name>/src/index.js

  # HTML 内スクリプトの構文チェック（script タグを抽出して node --check）
  node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];fs.writeFileSync('/tmp/_chk.js',m[m.length-1][1]);"
  node --check /tmp/_chk.js

  # JSON の妥当性
  node -e "JSON.parse(require('fs').readFileSync('data/game.json','utf8')); console.log('valid')"
  ```
- Worker のローカル実行: `npx wrangler dev --local`（`workers/dj-schedule/wrangler.dev.toml`
  はローカル D1 用の設定例。同 README.md「ローカル確認」節を参照）。
- npm を使うのは次の4つだけ:
  - `magi-app/`: `npm run serve`（PWA 確認）、`npm run sync`（Capacitor 同期）。
  - `game/reverse-recaptcha/`: `npm ci` → `npm run build`（本番は `build.sh` がビルドする）。
    依存を変えたら `npm install` で `package-lock.json` も更新してコミットする（ずれると `npm ci` が通らない）。
  - `workers/`: 全 Worker 共通の wrangler だけ（`workers/package.json`）。`cd workers && npm ci` で入れる。
  - `.github/scripts/`: 検証用の Playwright だけ（`.github/scripts/package.json`。版を固定）。`cd .github/scripts && npm ci` で入れ、ブラウザは手元なら `npx playwright install chromium`。
    週次の `ai-model-watch.yml` は `npm ci` をしないので、smoke の経路で npm の依存を読まない（`assets/site-search-design.md` 10.5）。

## デプロイ

- **静的サイト**: `main` への push で Cloudflare Pages がビルドして反映する。Pages の設定は
  「ビルドコマンド: `bash build.sh`」「ビルドの出力先: `_site`」。`build.sh` は公開するファイルを `_site/` に写し
  （「公開範囲」）、reverse-recaptcha をビルドし、出来上がりを確かめる（必要なファイルが無い・出さないはずのものがある・
  Pages の上限（1ファイル 25MiB、全体 20,000 件）を超える、のどれかで止まり、デプロイされない）。
  `_headers` は使っていない。`_redirects` はルートに置き、旧 URL のリダイレクトだけを定義している。
  存在しないパスにはルートの `404.html` が 404 で返る。このページはどの深さのパスでも同じファイルが出るので、
  中のリンク・画像はルートからのパス（`/…`）で書く。
  `/in`・`/tw`・`/ln_100y`・`/magi-app/android/` などの短縮 URL は Cloudflare のゾーン側のリダイレクトで、リポジトリにはない。
- **Workers**: 手動デプロイ。wrangler は `workers/` に共通で入れてあるので、`cd workers` してから
  `npx wrangler deploy --config <name>/wrangler.toml`（ほかの場所で `npx` すると毎回ダウンロードが走る）。
  手元に環境が無いときは、GitHub の Actions 画面から `deploy-worker.yml` を Worker を選んで実行する（下記）。
- **シークレット**: `wrangler secret put <NAME> --config workers/<name>/wrangler.toml` で設定。
  リポジトリにコミットしない。`.dev.vars` も `.gitignore` 済み。
- **D1 の初期化**: `npx wrangler d1 create <db>` → database_id を `wrangler.toml` に貼る →
  `npx wrangler d1 execute <db> --remote --file=./schema.sql`。
  既存 DB への変更は各 Worker の `migrations/` に連番（`0001_<内容>.sql`）で置き、`d1 execute --file` で流す
  （2回適用は `duplicate column` で落ちる＝適用済み）。
- **GitHub Actions**（bot が `main` に直接コミットする）:
  - `sitemap.yml`（push 時）: `update-modified.py` で各 HTML の JSON-LD `dateModified` を
    git コミット日時と同期 → `sitemap.xml` / `robots.txt` を再生成。bot 自身のコミットは
    `[skip ci]` と冪等性でループ回避。
  - `oil-price.yml`（毎週水曜 16:00 JST）: 資源エネルギー庁の xlsx から東京のハイオク価格を
    取得して `data/oil-price.json` を更新。
  - `retail-tech-daily.yml` / `nitori-daily.yml`（毎日 01:55 / 02:05 JST）: `daily-brief-reusable.yml` 経由で
    日刊ブリーフを生成し、最後に `post-to-x.py` が新着号を公式 X（@retailtechdaily / @dailynitori）へポストする。
    本文の URL は `ttps://` 表記にして自動リンクを避け（X は URL 付きポストを高く課金する）、代わりに号の OGP 画像を添付する。
    OGP は Chrome でレンダリングするため、CI に `fonts-noto-cjk` の導入が必須（入れないと日本語が豆腐になる）。
    ポスト ID は号の JSON（`x_post_id`）に記録され、これが二重ポストの抑止を兼ねる。
    認証に使うリポジトリ Secrets の名前は `post-to-x.py` の冒頭にある。未設定なら警告だけ出して生成は通す。
  - `nitori-tiktok-fetch.yml`（毎日 14:00 JST）: Bright Data で TikTok の人気動画を取り、`data/nitori-tiktok-buzz.json` に
    書く。数分かかる取得を、翌日 02:05 の日刊ニトリの発行から外すため前日に回している。
  - `deploy-worker.yml`（手動のみ）: 選んだ Worker を `wrangler deploy` で出す（`dry-run` ならバンドルの確認だけ）。
    リポジトリ Secrets に `CLOUDFLARE_API_TOKEN`（テンプレート「Edit Cloudflare Workers」で作り、ゾーン tk.st の
    Workers Routes の編集権限を含める）と `CLOUDFLARE_ACCOUNT_ID` を置く。`dj-request` の DB 更新には対象アカウントの
    `Account > D1 > Edit` も追加する（上記テンプレートには含まれない）。DB 更新後、リポジトリ Secret `TYPESAFE_API_KEY` が
    あれば Worker へ同期する。`magi2` は出すたびに、リポジトリ Secret `ANTHROPIC_API_KEY` を Worker の `MAGI_ANTHROPIC_API_KEY` へ
    同期する（未設定ならデプロイを止める）。Anthropic のキーを入れ替えるときは、Cloudflare 側だけでなくリポジトリ Secret も替える
    （Cloudflare 側だけ替えると、次のデプロイで古いキーに戻る）。それ以外の既存 secret は Cloudflare 側のまま使う。
    Worker を足したら `options` にも足す。
  - `site-rank-browser.yml`（手動のみ）: 404 のサイト内検索の②の応答時間を、ランナーのブラウザから本番の Worker へ送って測る
    （`eval-site-rank.mjs --probe` → `--browser`。生の記録は成果物。`assets/site-search-design.md` 10.4）。
  - `site-search-url.yml`（手動のみ）: 検索語が URL・参照元・計測に残らないことを、本番の tk.st で本物の GTM・Ahrefs を読み込んで確かめる
    （`test-site-search-ui.mjs --base https://tk.st`。計測の送信は記録してから止める）。
  - `magi-classification-eval.yml`（手動のみ）: magi2 の発言分類（Jev）を固定の合成文で確かめる（`eval-magi-classification.mjs`。リポジトリ Secret の `TYPESAFE_API_KEY`）。問い・基準を変えたら、変える前と後で回して比べる。
  - `search-boost.yml`（毎日 03:40 JST＋手動）: 共通検索の候補クリック（magi2 の D1 の `search_clicks`）を `search-boost.py` で集計して
    `data/search-boost.json` を作り直し、90日より古い記録を消す。画面はこの JSON を読むだけで、検索のたびに D1 を読まない（無料枠の読み込みを守る）。
    `CLOUDFLARE_API_TOKEN` に `Account > D1 > Edit` が要る。
  - `post-to-x.yml`（手動のみ）: 既存の号を X へポストし直す。再送・バックフィルと、
    `dry-run` での本文確認に使う（生成は走らない）。
  - `magi-context.yml`（push 時＋手動）: `.github/scripts/magi-context.py` が MAGI の人格カードを作り直して
    `data/magi-context.json` にコミットする（後述「MAGI の人格カード」。差分判定や失敗時の扱いは同スクリプトの冒頭）。
    手動実行の `force` は素材が同じでも全人格を作り直す。`magi-context.json` を書くのはこの workflow だけ
    （書き手が2つあると生成物どうしが rebase で衝突する）。
  - `magi-x-posts.yml`（毎週月曜 03:00 JST＋手動）: 本人の X を人格カードの素材として読み、素材が変わったらコミットして
    `magi-context.yml` を `workflow_dispatch` で起動する（bot の push はほかの workflow を起動しないが、dispatch はできる。
    後述「MAGI の人格カード」の X の素材）。
    手動実行の `mode` は `check`（認証の確認だけ）・`fetch`（新しい投稿を足す。毎週の定期実行）・`recheck`（直近 `days` 日（既定60日）を読み直して X で消した投稿を落とす。
    毎月2日の定期実行。git の履歴には残る）・`interests`（いいねとフォローの要約）。
  - `ai-models.yml`（push＋PR）/ `ai-model-watch.yml`（週次＋手動）: AIモデル設定の正本
    `config/ai-models.json` の形式とモデルIDの直書きがないことを検査し、OpenAI / DeepSeek の
    `/models` APIから更新候補を検知する。スモークテストは毎週回し、候補が通ればレビュー用PRへ出し、
    失敗したらIssueで通知する。自動マージ・自動デプロイはしない。運用詳細は `.github/AI_MODELS.md`。
  - **bot のコミットの決まり**:
    - main に push する workflow は、どれも `.github/scripts/push-with-retry.sh` で push する（取り込んでから push し、
      弾かれたら取り込みからやり直す）。workflow をまたぐ `concurrency.group` の共有はしない（待機中の実行が
      新しい実行にキャンセルされ、sitemap が黙って飛ぶため）。bot のコミットを増やすときも同じスクリプトを使う。
    - サイトにすぐ出したい生成物（号ページ、`magi-context.json` など）のコミットに `[skip ci]` を付けない
      （Cloudflare Pages もビルドを省略し、次の push まで公開されない）。

### MAGI の版番号

- 本人の公開は `X.Y`（例: 6.0）、継続改善の自律公開は小数第2位を上げた `X.YZ`（Zは1〜9。例: 6.01）を使う。`6.00`・`5.90`・`5.100` は使わない。
- `APP_VERSION`・トップページの表示・Android の versionName・`data/magi-versions.json` の先頭は同じ表示にする。package.json と package-lock.json の version は `X.Y.0` / `X.Y.Z`（例: 6.01 → 6.0.1）でそろえる。
- 自律更新では versionCode を変えない。次に APK を作るときから、整数×100＋2桁の小数部（5.9 → 590、5.91 → 591、6.0 → 600）にする。実物との照合は `magi-app/scripts/verify-apk.py` で行う。
- 更新履歴は新画面が `/magi2/versions?format=2` で取得する。`format=2` の無い旧 APK には X.YZ を除いて返す。Worker → 画面の順に公開し、両方の公開後にだけ X.YZ の履歴を足す。
- 自律更新で版を上げる条件・番号の再利用禁止・上限は [継続改善設計§2.4](magi2継続改善設計書.md) に従う。

### MAGI の継続改善

- 点検とレビューの手順は [`.github/magi2-daily/README.md`](.github/magi2-daily/README.md)。区分Aの条件・互換性・利用体験への影響を確認し、変更の意味が曖昧ならBにする。現在は準備中で自動マージしない。
- 再レビューは過去の指摘IDごとに `fixed / withdrawn / open` と対象headの根拠を結果表へ残す。表の欠落・記載漏れ・状態コメントのreadyを合格とみなさない。経路未設定は未設定のまま扱う。
- 手動のmagi2公開もコミットを版に残す。`node .github/scripts/magi2-daily-check.mjs --deployment-message` の値を `wrangler deploy --message` に渡す。Workerの本番依存に未コミットの変更があれば `-dirty` になり、後に自動公開を接続してもその状態では出さない。Anthropicキーの同期は従来どおり先に行う。

## コーディング規約

- **言語**: コメント・ドキュメントは原則**日本語**（magi-app の README や tools-ui.js の一部など例外あり）。
  コミットメッセージは短い英語（`update` 等）。
- **キャッシュ対策**: 共通の JS/CSS は `?v=YYYYMMDD_n` を付けて読む（例: `tools-ui.js?v=20261003_1`）。
  中身を変えたら、そのファイルを読む全ページの値を上げる。
- **SAFE TOOLS の通信制限**: `tools/` 配下の全ページは head の先頭で Content-Security-Policy を宣言し、
  読み込みや送信に使える通信先を、このサイトとアクセス解析（GTM 経由の GA4 と Google シグナル、
  Cloudflare Web Analytics、Ahrefs Web Analytics）だけに制限している（寄付ウィジェットの Ko-fi は iframe の表示だけ許可）。
  正確な一覧は各ページの CSP の `<meta>`。国別の google ドメインは日本（`www.google.co.jp`）だけ許しているので、
  ほかの国からの訪問ではシグナルの一部が止まる。広告コンバージョンは GA4 側で切ってある。
  - **Microsoft Clarity は入れない**（セッション記録が入力や QR の中身まで送る）。GTM 側で `tk.st/tools/` を除外してあり、
    除外が外れても CSP が止める。
  - Ahrefs は URL を丸ごと送るので、`data-page-location` にパスとクエリだけを渡して `#` 以降
    （QR Palette の共有デザイン `#d=` など）を載せない。
  - ページの注記・FAQ・構造化データでもこの約束を説明している。CSP が保証するのは「読み込みと送信の通信先」まで
    （ページの移動や、許した送り先へ何を載せるかは縛れない）なので、「どんな不具合があっても送れない」の
    ような言い方はしない。「中身を送る処理を持たない」＋「通信先を制限している」の2段で書く。
  - CSP は各ページに同じ文字列で書いてある。外部の通信先を足すと約束の説明も変わるので、広げる前に同梱で済まないかを考える。
  - **新しいツールを足すとき**の head の順番: `<meta charset>` → CSP の `<meta>` → `tools/assets/tools-ui.js` → GTM → Ahrefs。
    `tools-ui.js` を GTM より後ろに置くと、通信メーターが先に止められた通信を「想定外の行き先への送信」と数え、
    安全設計カードが「!」になる。
  - ライブラリ・フォントは CDN から読まず、`assets/vendor/`・`assets/fonts/` に同梱して読む。取り込みは
    `.github/scripts/vendor/fetch-vendor.js`（`LIBS` を直して実行し、`assets/vendor/SOURCES.json` の差分ごとコミットする。
    `--check` で照合だけできる）と `.github/scripts/fonts/fetch-fonts.js`。
    25MB を超えるファイル（FFmpeg のコア wasm）は分割して置き、`STCommon.fetchVerified` がつないで SHA-256 を照合する。
    両ディレクトリは `.gitattributes` で改行変換を止めている（記録した SHA-256 と食い違うため）。
  - CSP は `'unsafe-eval'` を許していない。文字列からコードを作る古い Emscripten 出力（heic2any の libheif、
    QR Palette の OpenCV WeChat）は `.github/scripts/vendor/patches.js` の置き換えで直してあり、`fetch-vendor.js` が
    取り込みのたびに当てる。`--check` は、理由を書いて許したもの（`DYNAMIC_OK`）以外に文字列からコードを作る処理が
    見つかったら止まる。ライブラリを足したら必ず走らせる。
  - Worker は blob: の URL から起動する（`toBlobURL` や `fetch` → `URL.createObjectURL`）。同じサイトの URL から
    直接起動した Worker にはページの meta の CSP が効かない（HTTP ヘッダーの CSP が使われ、このサイトは付けていない）。
- **安全設計カードと処理レシート**: `tools-ui.js` が各ツールの `<main>` の直後（`.prose-tool` / `.prose` の説明文があれば
  その手前）に出す。5項目のチェックは宣言ではなく、そのページで実際に起きた通信と CSP の点検から決める
  （判定の詳細は `tools-ui.js` のコメント）。
  - どれもページ自身による計測で、Worker の中の通信は数えていない。画面にもそう書いてあるので、
    「送れない」のような言い方に変えないこと。
  - CSP が止めたフォント（font-src）は、ブラウザや拡張機能が差し込んだものとして送信に数えていない。
    **サイトのスタイルに外部のフォントを足すと、この前提が崩れる**。
  - 処理レシートは `STShare.celebrate()` のたびに自動で出る。ツール側の追加作業はない。
- **アクセス解析を止める**: 安全設計カードの下のボタンで、利用者が止められる。設定は localStorage の
  `st-analytics`（`off` で停止）。新しいツールの GTM と Ahrefs のスニペットの先頭にも同じ判定
  （`try{if(localStorage.getItem('st-analytics')==='off')return}catch(e){}`）を入れる。Cloudflare Web Analytics と、
  途中で止めたときの以後の送信は `tools-ui.js` が止める。一覧ページ（`tools/index.html`）は `tools-ui.js` を読まないので、
  止まるのは GTM と Ahrefs だけ。
- **完了時のお願い**: ツールがユーザーの用を足した瞬間で `if (window.STShare) STShare.celebrate();` を呼ぶ。
  ダウンロードは `STCommon.saveBlob(blob, name)` を通せばこれを呼ぶので、保存以外の完了地点（text-diff の結果のコピーなど）
  だけ1行足せばよい。ツールを増やすときは `tools-share.js` を `buy-me-oil.js` の隣で読む。
  文面・共有 URL はページの JSON-LD / og:title / canonical から組み立て、頻度の制御も `tools-share.js` の中で
  済ませているので、呼び出し側で引数や条件分岐を足さない。パネルの「要望・不具合を伝える」は
  `/contact/?subject=[ツール名] 改善のご提案` へ飛ぶ。見た目の確認は URL に `?st-share=preview` を付けて完了操作をする。
- **一覧データ**: tools / game の一覧は `data/tools.json` / `data/game.json` が正本。HTML に直接書かない。
- **AIモデル設定**: モデルIDの正本は `config/ai-models.json`。Pythonからは
  `.github/scripts/ai_model_registry.py` を通して読み、Worker はJSONを `import` する（wrangler が
  デプロイ時に取り込む）。モデルIDを別の場所へ直書きしない（`ai_models.py check` が検出する）。
  週次のスモークテスト（`ai_models.py` の `smoke_*`）は各利用箇所の呼び出し方（temperature・top_p・
  画像・推論・ストリーミング）をなぞっているので、呼び出し方を変えたらそちらも合わせる。
  TypeSafe AI（Jev）を使うとき・評価するときは、先に `.github/JEV.md` を読む（API の形、料金と上限、規約、
  問いの書き方と閾値の決め方の知見、いまの利用箇所）。新しく使ったら、同じ資料の利用箇所の表に足す。
- **magi2 の人格設定**: `workers/magi2/personas.js` が人格の骨格プロンプト、用途ごとの推論強度、
  トークン上限、タイムアウト、揺らぎの唯一の正本。モデルIDだけは上記の共通正本に従う。
  - 404のAI検索とチャットのサイト案内は `SITE_SEARCH`／`site-search.js`。404検索はサイト案内固定で、討議なしの事実回答（`runFactAnswer`・`FACT_ANSWER`、推論low。テーマなしなのでOpenAI、本文前の失敗だけAnthropicへ1回）で答える。対応通知 `site_debate=1` が無い旧画面には409を返し、AIや利用回数を使わない。
    検索候補は `.github/scripts/site-search-index.py` が公開HTMLから作る `data/site-search.json`（生成物、手で編集しない）。
    `build.sh` は出荷するHTMLから毎回生成する。手元では `python -B .github/scripts/site-search-index.py` で更新する。
    noindex・転送・別URLをcanonicalとするページ・404は除く。ツール・ゲーム・Glitchの説明やタグは既存の正本JSONで補う。
    主な入口は `404.html` の常設入口（`data-entry`）が正本で、noindexでも索引に入れ、日英の名前を持たせる（入口を足すなら `data-entry` を書く）。
    404 の「サイトの全体」は同じ形の9枚のタイル（並びはトップページの `pages` コマンドの一覧（`index.html` の `projects`）の順に、MAGI・お問い合わせを足したもの）で、押すとその段の下にパネルが1つだけ開く（JS無効・開閉の配線の失敗ではすべて開いたまま）。パネルの中身は `search-tree.py` が出荷時に、索引のページ（日刊の号は媒体ごとに新しい3件）と、各区画のページで `data-sitemap="日本語" data-sitemap-en="English"` を付けた節（リンク先は `data-sitemap-anchor`、無ければ id）から作る。
    節を足したら目印を付ける。区画を足すときは 404.html にタイルとパネルを書く（どのタイルにも入らないページは「ほかのページ」に出て、ビルドに警告が出る）。
    404 の検索ボタン（②）は同じ入口に `mode: 'rank'` を送り、索引の各ページを TypeSafe AI（Jev）で判定して並べる（`SITE_RANK`／`site-rank.js`、画面の部品は `assets/site-search.js`）。
    日刊2誌の②も同じ入口で、`scope: nitori|retail` と `filters`・`generation` を送る。明示検索でだけ送信し、日刊の③は設けない。
    正本は `search-scope.js`・`site-rank.js`・`SITE_RANK.scopes`。対象は全年度、候補は最大20件。媒体ごとの有効化・停止は `SITE_RANK_SCOPES` で行い、回数は404の②と共有する。停止は索引・回数・Jevより前で行い、①は利用可能。
    Phase 4（2026-10-12公開）は`POST /search/api/rank`を5scopeの共通入口にし、tools/gameも対象にする。`search_contract: 1`と基礎データの生バイト列hashに対応するgenerationを送り、Workerは回数・Jev・結果キャッシュより前に版を照合する。旧入口は従来の3scopeの契約を保持する。ブラウザの版ずれ復帰は自動で1画面1回、②は明示検索だけ。公開設定は5scopeが有効。新scopeのtune/final・smokeの記録は`.github/site-search/phase4/rank/README.md`、本番確認と限界は`assets/site-search-phase4-release-evaluation.md`。
    UI改修は`assets/site-search-ui-redesign.md`。トップページのサイドバーの Search も同じ部品で、adapter の `commands` でコマンドを先頭に足す（tk.st の上でだけ遅れて読む。上の「外部参照の制約」）。操作と構造は共通、見た目はページ。下書きと確定語を分け、①は20件ずつ、②は先頭20件との重複を除いて3行の枠へ描く。日刊の号の確定だけは、同じタブの30秒以内・一度きりの目印でポータルへ明示操作を引き継ぐ。
    読みは`search-reading-index.py`が固定したSudachiで出荷時に生成し、正本の全文・ID順・生バイト列hashを保つ。補正の正本は`config/search-readings.json`。ブラウザへ辞書を配らない。`data/site-keyword.json`・各scopeの読み、日刊の年別読み／manifestは`_site`だけの生成物で、手で書かない。共通UIとadapterへ変更を集め、ページ側に独立した検索制御を追加しない。
    止めるときは Worker の `SITE_RANK_ENABLED` を先に false にし、その後で 404 の `RANK_ENABLED` を false にする（magi2 の README.md）。
    AIの検索範囲は常設入口に限らない。AIへは関連度で最大40件・16,000文字分だけ渡す（値の正本は `SITE_SEARCH`）。
    AIの検索や MAGI の話題から外したいページは、ページを noindex にする。
    回数は既存の `countUp`／`rate_limit` に `search:<IP>` と `search:global` で記録し、通常チャットと分ける（例外はA5の404会話の続きの質問で、通常チャットの回数で数える）。
    検索語・行動ログは取ってよい（2026-10-12 に「検索語をDB・ログに残さない」約束は破棄した。tools の約束は「アップロードされた中身を保存しない」だけ）。
    共通検索の候補を開くと、画面が `POST /search/api/click` へ検索語（照合と同じ正規化）・開いたページ・一覧と順位を sendBeacon で送り、D1 の `search_clicks` に1行書く
    （同じ組は1日1回、`st-analytics=off` なら送らない。上限は `personas.js` の `SEARCH_CLICK`、停止は `SEARCH_CLICK_ENABLED`）。
    集計した `data/search-boost.json` を `search-data.js` が読み、同じ点数の候補を押した人数の順に並べ、同じ検索語で3人以上が押したページを最上位に上げる（`search-ui.js` の `promote`）。
    MAGI はサイトの案内役も兼ねる（`SITE_GUIDE`／`siteGuide`）。分類対応の画面では、今回のintent・site_pagesと画面の許可を確認してから索引・一覧・ページ選択を使う（musicとdj/requestは省く）。画面が `page`（トップページは `'/'`、アプリは `'app'`）を送ったときだけ、
    3人格に場面といまのページを、統合人格に `data/site-search.json` から作るページ一覧（日刊の号を除く）を足す。
    `dj/request/` は送らない（選曲の相談にサイトの話を混ぜない）。新しい画面で MAGI を使うときは、送るかどうかを決めること。
  人間向けの別形式（以前の `persona.yaml` のようなもの）を並べて二重管理にしないこと。
  - **固定プロンプトに書くのは「役割と出力の形」と「気質」だけ**。本人の事実・関心・考え（好きなもの、拠り所の書物、
    仕事の中身、得意ジャンルなど）は書かず、サイトの本文に書いて人格カードに任せる（固定に書くと本人が変わっても
    古いまま残り、カードと食い違う）。統合人格は気質も固定に持たず、性格検査から作る自己像のカードを気質の正本にする。
    画面（トップページとアプリ）のスプラッシュに出す人格の説明（気質・素材・テーマによる違い）は `personas.js` の
    `PERSONA_GUIDE` が正本で、`/magi2/models` がモデル名と一緒に返す。画面には名前しか書かない（アプリのリリースなしで直せる）。
    気質は固定プロンプトに、素材は `magi-context.py` の `PERSONAS` に揃える。
  - 3人格は答えの癖と間違え方をばらけさせるため、人格ごとに会社を分けている（Enthusiast = DeepSeek、
    Humanist = Anthropic、Strategist = OpenAI。統合はライトがOpenAI、ダークがAnthropicで、本文が始まる前の失敗だけ相手へ1回切り替える。`DEFAULTS.models.persona` を codename で引く）。呼び出し先は `PROVIDERS`、
    会社ごとの推論の切り方やトークン上限の名前の違いは `src/index.js` の `requestBody` に閉じている。
    1人格が失敗しても（障害・安全フィルター・キー未設定・時間切れ）その人格を `[NO RESPONSE]` にして
    残りで討議と統合を続け、全員が失敗したときだけエラーにする。
  - **討議の回数**: `fact_mode:true`の新画面はresearch・siteを討議なしで答え、musicは曲案内として最大5回。印のない新契約のsite・musicは第2回で統合する。consultと旧契約は、第2回の後から統合人格が判定し（`DEBATE`、両テーマHaiku・medium。失敗時だけLuna・mediumへ1回、同じ20秒以内）、答えを変えうる論点が残っていれば
    答えられる人格にだけ聞き返して最大5回まで回す。基準は「一致したか」ではない（価値観の違いは統合で本人が決める）。
    第3回以降は、リクエストに `adaptive_debate: true` を付けた画面だけ（配布済みの古いアプリは2回のまま）。
    MAGI を使う画面を足すときは、`ask` イベントと履歴の `followups` に対応してから付ける（詳細は magi2 の README.md）。
  - **A5の404会話（5.2、2026-10-16公開）**: `site_debate=1&site_chat=1`でJSONの会話を継続する。Jevは初回の言語・悪意、継続の悪意だけを判定し、種別はsite固定。直近3往復だけを送信し、履歴・言語・終了状態はページ内のメモリに持つ。履歴付き③は64KiB、②と旧③は4KiB。旧入口のmode付き本文と新入口5scopeの②は会話処理より先に分ける。公開確認と品質の限界は`workers/magi2/A5公開評価.md`。
  - **A3の確認質問**: `clarify:true`の通常チャットは判定と質問を同じJSONで生成し、必要時に1〜3問を`clarify`→`done`で送る。MAGI・DJ・404・印のない画面は利用者へ確認しない。直前のassistantが`clarify`なら再確認せず、回答の分類時だけ元の相談・質問と選択肢・直前のintent/freshをJevへ渡す。通常のAI回答・討議・カード・状況説明はJevへ送らない。
  - **人格ごとの会話の履歴**: 画面は履歴の回答に、その回の各人格の意見を `debate`（`{ 人格名: { round1, round2, followups } }`。
    `followups` は聞き返された第3回以降の `[{ round, ask, text }]`）として
    付けて送る（トップページとアプリは履歴の項目をそのまま、`dj/request/` は保存した `personas` を変換して）。Worker は
    人格ごとに履歴を組み直し（`personaThread`）、**その人格自身の過去の意見だけを assistant に置く**。3人格は一人の人間の
    中の面なので記憶は共有し、他の2人格の過去の意見と統合人格の過去の回答も、次の質問の頭に誰の言葉かを書いた見出し
    （「前回、BALTHASAR-2（Humanist）…が言ったこと」「前回、3つの面の議論をまとめて Shinya Takeda が答えたこと」）を
    付けて文脈として渡す（自分の発言としては渡さない）。3人格の固定プロンプトの冒頭にも、この構造（一人の人間の中の
    3つの面で、3人の議論を本人がまとめて答える）と、その呼び出しで頼むのはその面の意見だけで、書いた文章がその面のカードに出ることを書いてある
    （仕組みだけを書くと、討議全体を書けと読まれる）。統合人格には従来どおり自分の回答を assistant で渡す。
    上流の API へは role と content しか送らない（`requestBody`）。
  - 討議する入力は3社すべてに送られる。A2の事実確認はライトがOpenAI、ダークがAnthropicへ直接送り、本文前の失敗だけ相手へ1回答え直す。会社を変えたり足したりしたら、トップページと `magi-app/www/app.js` の
    「System & Privacy」と `dj/request/` の送信先の説明も直すこと。Anthropic APIは通常30日保持（安全対策・法令等の例外あり）し、通常はモデルの学習に使わない。条件を変更したときは説明も直すこと。
    読み上げ（準備中）は、利用者が 🔊 を押した統合人格の回答の本文だけを Fish Audio（無料版）へ送る。Fish Audio は保持期間の定めが無く、学習に使いうる（`workers/magi2/読み上げ実装前確認.md`）。有効にするときは `PRIVACY` に `requires: ['speech']` の段落を足す。
  - **分類と言語**: `classification_state: true` の一般会話は、TypeSafe AI（Jev）へ初回5問・継続4問（language・malice・votable・intent・site_pages、継続は言語を省く）を1回で送り、最新本文と直前2件のユーザー本文から分類し、初回だけ最初のユーザー本文から言語を決める。DJはmusic固定で、初回は言語・maliceの2問、継続はmaliceの1問。旧画面はリクエストごとの言語1問を維持する。
    **実API検証の予算（本人指定2026-10-15）**: 今回Luna約$4・Haiku約$4かかった検証費用を1/10までに抑える。指示以後の対話改修の残り検証は累計Luna最大$0.40・Haiku最大$0.40、Jev等も含む総額最大$0.80。実行・テーマ・修正・ターンごとにリセットしない。保存済み応答の再生とローカル検証を優先し、全件の再送を重ねない。実APIは全段階・再試行を含む保守的な費用上限が残額以内の最小限だけ。料金不明・未保存の中断をゼロ扱いせず、予算で未実施の条件は未確認として残す。本人の残高補充後にLuna照合4回のみ実行し、予約額$0.073820を保持。本人の「この進め方で良い」により、既存評価・原典照合＋修正4件＋ローカル回帰でA2検証を確定し、全30件の新規評価は省略。全件の意味の支持・3回制限での新規検索品質を確認済みにしない。同日の「本番公開して」でA2を公開済み。公開作業の追加有料API呼出しは0回。公開後の画面確認は固定SSEで、本番の実上流応答は確認済みにしない。詳しくは`magi2対話改修検証計画.md`の費用上限と§3.2。
    **2026-10-17追加の代表評価（本人「おススメ案で実施」）**: 追加$2の縮小案を採用し、上の旧上限を累計総額$2.80・OpenAI最大$1.20・Anthropic最大$1.20へ変更。過去の予約を同じ台帳に保持する。Android通常/MAGI/合成画像各1件、PDF/QR各3往復、保存討議2件の旧・現判定比較に限定し、独立20相談・45回答の全件評価は再開しない。ネイティブ・本番の動的な呼出しは固定合成入力と会社別の事前予約・D1費用ガードがそろう場合だけ実行する。
    **B0継続確認（2026-10-17）**: 5.3候補で通常/MAGI/合成画像各1件を追加確認。既存台帳へ$0.316を事前予約し、本番D1の会社別ガードを使用。累計予約は端数切上げ込み$2.778029、残枠$0.021971。未使用の予約も減らさない。一時secretは削除済み。結果は`magi-app/ネイティブ機能進捗.md`。
    **B3追加承認（2026-10-20）**: 本人の「追加$0.32の代表3件で進める」により累計総額を$3.12へ変更。OpenAI・Anthropicの個別上限$1.20は維持。通常相談・MAGI・合成画像各1件だけ本番で確認し、計$0.316を同じ台帳へ事前予約した。累計予約$3.094029、残枠$0.025971。受付3件・予算拒否0、ガード加算計$0.191407。一時secretは削除・不在確認済み。長時間9場面は模擬SSEを使う方針変更も承認済み。過去の予約は減らさず、全件の本番長時間試験を確認済みにしない。画面・実機の結果は`magi-app/B3実装評価20261020.md`。
    A2の実API評価器は`magi-eval-budget.mjs`で既定拒否。共通の`workers/.wrangler/magi2-dialogue-a2/budget-20261015.json`に要求ごとの保守的な費用見積もりを置いた場合だけ、個社・総額を検査して先に予約する。失敗・中断でも予約は減らさず、別台帳へ替えて累計をリセットしない。単価・最大費用の根拠が無ければ送らない。ガードを持たない旧試作で予算を迂回しない。請求額の自動取得・保証ではない。
    `fact_mode:true`の一般会話はresearchとfreshを追加し、初回6問・継続5問。musicは曲の案内・選曲だけで、拍子やコード等の説明はresearch、個人的な練習計画はconsult。正本は`INTENT_CLASSIFY.fact_questions`。Webなしの事実説明はlow、Web検索はmedium（本人採用2026-10-14）。Webは両テーマLuna、本文前の失敗だけAnthropicの検索・ページ取得へ1回（本人採用2026-10-15）。通常のダーク回答はHaikuを維持する。`RESEARCH.reasoning_effort`を直接回答の`FACT_ANSWER.reasoning_effort`と混同しない。
    Webの原案は表示せず、引用先の公開本文をWorkerが取得して同じ回答会社のJSON呼出しで照合する。存在する出典・本文番号だけを受け付け、必要な項目を未確認も含めて返す。意味の対応はモデルの判断なので実本文の監査を別に行う。検索・取得・照合で各社45秒、公開ページへキーやCookieは送らない。PDF・未対応の文字コードの本文はこの取得では読めない。本文を JavaScript で描くページ（取れた本文が400字未満の HTML）は、1回答につき1件だけ Cloudflare Browser Run の `/markdown` で描画して読む（`RESEARCH.render`。無料枠のため全体で10秒に1回・1日100件まで。secret `BROWSER_RUN_API_TOKEN`（Browser Run - Edit）と `wrangler.toml` の `BROWSER_RUN_ACCOUNT_ID`。無ければ描画しない）。
    3人格・統合・討議の判定・タイトル・予測に同じ言語指定を付ける（`INTENT_CLASSIFY`／`classification.js`。画像・状況説明・AIの回答は分類に送らない）。会話ごとの言語を画面に保存・復元し、分類結果・本文・ハッシュをD1に保存しない。
    決まらなければ手元の規則（`REPLY_LANGUAGE`）とUI言語で初回に固定する。Jev は4社目の送り先なので、上の説明にも載せてある。
  - **悪意への短い返答（対話改修A1）**: identity・extraction・extremeが確信度0.55以上なら、討議・採決・サイト案内・タイトル・予測より先に、テーマの統合モデルが推論なしで短く返す。返答モデルへ送るのは固定の方向・本人のカード・言語だけで、相手の本文と履歴は渡さない。`classification` → `integrated` → `closed` → `done`。トップ/PWAは `close_on_malice` を送り、終了状態を保存して入力を閉じ、［新しい会話］で再開する。DJは短い返答だけで入力を閉じず、その往復を `closed: true` で保存して人格の枠を出さず、次の相談の履歴から外す。統合人格の一人称は「私」、語尾「ぜ」は使わない（正本は `SYNTHESIZER.voice_rules`）。返答の本文前だけ相手の会社へ1回答え直し、両社失敗なら会話の言語の固定文（`MALICE_REPLY.fallback`。無い言語は英語）。
  - 次の質問の予測: リクエストに `suggest: true` を付けると、統合の答えの後に軽量モデル（`anthropic.haiku`・推論なし、HTTP失敗時だけOpenAI）で
    利用者が次に送りそうな質問を1つ作り、`suggest` イベントで送ってから `done` にする（失敗・4秒超えなら送らずに終える）。
    いま付けているのはトップページの MAGI、`magi-app/www/app.js`、`dj/request/` の「AIに相談」。どれも空の入力欄に薄く重ね、
    右の › で入力欄に入れる（送信はしない）。新しい入口を作らずチャットの中で返すので、Origin の確認と1日の上限はチャットと共通。
- **MAGI の人格カード（`data-magi` の目印）**: magi2 の3人格は、固定の骨格プロンプト（personas.js）に
  サイト本文から要約した「いまの中身」を足して動く。元ネタはページ内で `data-magi="<人格>"` を
  付けた要素だけ（`balthasar` = `thought/`、`melchior` = `dj/`・`motovlog/`、`casper` = `job/`）で、
  ほかに `data/tools.json` を使う。JSON-LD は使わない。人格に知らせたい事実は本文に書いて目印を付ける。
  - **glitch の記事**は `data/glitch.json` の一覧から全部たどり、記事の本文に付けた目印で人格に振り分ける（いまは casper。
    DJ 音源の買い方の 003 は `casper melchior`）。記事を足しても `PERSONAS` は直さなくてよいが、本文の要素に
    `data-magi` を付けること（目印の無い記事があると止まる）。
  - **トップページのデータ**: 年表・自己紹介・肩書き・性格検査は JS が描くので本文に無く、目印では読めない。
    `magi-context.py` が `index.html` の定数（`TIMELINE_DATA`・`ABOUT_DATA`・`JOB_TITLES`・`PROFILE_DATA`）を名前で取り出す
    （`.github/scripts/magi-js-data.mjs`。Node で評価する）。**名前を変えたら `TOP_CONSTANTS` も直す**（見つからなければ止まる）。
    年表はカテゴリー（`cat`）で振り分ける（`TIMELINE_ROUTES`: music・bike = melchior、flânerie = balthasar、digital = casper）。
    表に無いカテゴリーは統合人格のカードに入れ、Actions に警告を出すので、担当を決めたら `TIMELINE_ROUTES` に足す。
  - **統合人格のカード**: 3人格のほかに、統合人格（キーは `Shinya Takeda`）の分も作り、統合の system プロンプトの後ろに足す。
    素材は自己像（自己紹介・ライト／ダークの肩書き・性格検査の事故の後と前）と X（投稿・関心の要約）で、サイトの本文は3人格の素材と重ねない。
    Worker は4枚そろったときを「完全」とみなす（欠ければ欠けた分を前回のまま保ち、1分後に取り直す）。
  - **X の素材**（`.github/scripts/magi-x-posts.py`、本人 @Tah_Keh の OAuth 1.0a。Secrets は `X_TAHKEH_*`）:
    - 投稿（リポストを除く）は `.github/magi/x-posts.json` に貯める。他人の @ は `@user` に伏せる。
      直近1年分を MELCHIOR と統合人格の素材にし、言い回しの見本もここから取る。
    - 画像付きの投稿には画像の説明（`media`。1枚1行）を、返信・引用には相手の投稿の要約（`context`）を、取り込むときに AI で付ける。
      画像そのものと相手の本文は保存しない（他人の投稿を公開リポジトリに並べない。X の規約でも再配布は制限される）。
      相手の投稿は本人の読み取りではないので $0.005／件。素材では〔〕で囲み、本人の言葉と区別する。
    - いいねとフォローは生のデータを保存せず、LLM で分野ごとに要約した `.github/magi/x-interests.json` だけを残して4枚すべてに足す
      （他人の投稿やアカウントを公開リポジトリに並べないため。一般の個人の名前もカードに書かせない）。
    - 費用は本人の読み取りの単価（$0.001／件）で、X の残高から引かれる。いいね5,000件とフォローを読む `interests` は1回 約$5。
      アプリが Pay Per Use のプロジェクトに入っていないと 403（client-forbidden）になる。
    - いいねは15分に75回（7,500件）までなので、続けて実行すると 429 になる。スクリプトは制限が解けるまで待って続ける。
  - **ページを改修するときは `data-magi` の属性を残すこと**（class や id は自由に変えてよい）。目印が消えると
    workflow がエラーで止まる（Worker は前回のカードのまま動き続ける）。
  - 目印の内側で読ませたくない部分は `data-magi-skip` を付けて外す（job の Signal Board のような
    演出用の数値、料金、数値の仕様表（排気量・寸法など）といった実務情報は入れない。愛機のデザインの
    特徴のように、こだわりとして語れるものは入れてよい）。
  - 抽出は DOM の順に読むので、年表の年のような見出しは HTML 上で本文より前に置く（見た目の位置は CSS で決める。
    後ろに置くと LLM が次の項目の年として読む）。抽出は JS を実行しないので、JS で書き換わる部分
    （motovlog の近況など）には目印を付けない。
  - 素材のページを増やすときは `magi-context.py` の `PERSONAS` にだけ足す（workflow は絞り込みをしていない）。
    抽出結果は `python .github/scripts/magi-context.py --dry-run --show` で API キーなしに確認できる。
  - Worker はカードを isolate ごとに使い回すので、反映は10分強遅れることがある（間隔は `personas.js` の `PERSONA_CONTEXT`）。
    デプロイ時点の `data/magi-context.json` も Worker に同梱していて、起動直後や `tk.st` から取れないときはそれで答える
    （カード無しで答えることはほぼ起きない）。同梱分はデプロイのたびに入れ替わるので、magi2 を出すときは先に `git pull` して最新のカードを取り込む。
- **XSS 対策**: ユーザー入力は保存時に `<` `>` と制御文字を除去し、表示はすべて
  `textContent` で描画する（dj-schedule README「制限値」節の方針が全 worker 共通）。
  - MAGI採決の議題は比較の意味を守るため `<` `>` を残す。禁止制御文字・双方向制御文字と長さはWorkerと両画面で検査する。
    議題は `textContent`、SVGのラベルは `setAttribute` で入れ、`innerHTML` のテンプレートに組み込まない。Markdown書き出しもエスケープする。
  - 曲リクエストも例外（`workers/dj-request` と `dj/request/`・`dj/booth/`）。保存時に落とすのは制御文字と
    長さの超過だけで、`<` `>` は残る。表示は一覧を `innerHTML` で組むので、来場者由来の値は必ず
    `escapeHTML`（`dj/assets/dj-request-core.js`。各ページでは `esc`）を通してから文字列に入れる。表示する値を足すときも同じ。
  - URL はエスケープでは防げない（`javascript:` がそのまま残る）。来場者が送った URL（`appleUrl`）を `href` や
    `location` に入れる前に、`appleHref` で Apple の https URL か確かめ、違えば使わない。ジャケットとプレビューの URL は
    `<img src>` と `new Audio()` にしか渡さないので、エスケープだけでよい。
  - ブースの背景カード（LLM の出力と、Web 検索で拾った出典 URL）も来場者由来と同じ扱いにする。文字列は `esc` を通し、
    出典 URL は Worker（`linkUrl`）とブース（`httpUrl`）の両方で http(s) か確かめてから `href` に入れる。
- **CORS 方針**: `ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st']` に Origin ベースで
  許可し、それ以外は API キー（`x-api-key` / `x-admin-key`）を要求。例外は、magi2 が Capacitor アプリの
  `https://localhost` オリジンも正規表現で許可していることと、games が手元確認用に `http://127.0.0.1:5500` を許可していること。

- dj-requestの開発用Originは `DJ_LOCAL_DEV="true"`・WorkerのURLがHTTP(S)ループバック・ページのOriginがHTTP(S)localhostの3条件がそろう場合だけ追加許可する。本番設定はfalse。ローカル起動はrouteによるhost書換えを避けるため `--local-upstream localhost:8788` を付ける。

## セキュリティ上の注意

- API キー・ソルト類はすべて Wrangler secret。コードや wrangler.toml に書かない。
- ゲーム系 Worker では、料金に響くパラメータ（モデル・トークン上限等）をクライアントに
  開けない（Origin は偽装できる前提で設計）。
- magi2 の画像入力は `data:` URL のみ許可。外部 URL を許すと Worker が踏み台になる。
- dj 系ページは身内向けで、`noindex` で検索に出さないだけ。URL は公開リポジトリから分かるので、機密情報を置かない。
  `workers/dj-request` のブースの操作（`/admin/*`）には鍵を掛けていない。
- `workers/dj-schedule` のコードには `CLIENT_API_KEY` の分岐があるが設定しても挙動は変わらない
  （README「アクセス制限について」に理由の記述あり）。

## その他

- `.claude/settings.json`（共有する Claude Code の設定）もリポジトリごと GitHub で公開されている（サイトには出ない）。
  手元の絶対パス（`c:\dev\…`・ユーザー名入りのパス）を含む許可や `additionalDirectories` は、`.gitignore` 済みの
  `.claude/settings.local.json` に置く。
