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
- **MAGI アプリ** (`magi-app/`): MAGI チャットのモバイル版。PWA + Capacitor 6 で iOS/Android にパッケージングする。
- **GitHub Actions** (`.github/`): 日刊ブリーフの生成と X 投稿、MAGI の人格カード、サイトマップ、ガソリン価格、
  AI モデルの検査、Worker のデプロイ（後述「デプロイ」）。

### 外部参照の制約

- **トップページ（ルートの `index.html`）**: Bitcoin の Witness 領域（Ordinals インスクリプション）にも刻んであるため、
  外部フォント / CDN / 外部アセットを足さない（CSS・JS・アイコン・QR はすべてインライン）。
  **例外は head の Ahrefs と GTM の2本だけ**で、これは公開サイト側の計測用。インスクリプション版はこの2行を落としたもの。
- **SAFE TOOLS（`tools/` 配下）**: 外部とやりとりするのはアクセス解析だけ（後述「SAFE TOOLS の通信制限」）。
- **それ以外のページ**: Google Fonts などの Web フォントや CDN の CSS/JS を読み込んでよい。
- どのページでも、フレームワーク・ビルドツールを勝手に持ち込まない。

## ディレクトリ構成

| パス | 内容 |
| --- | --- |
| `index.html` | トップページ。ターミナル風ポートフォリオ兼 MAGI チャット UI（英語メイン）。巨大かつ高頻度で編集される |
| `data/` | データ（JSON）だけを置く。ここに置いたものはすべて公開される。手で直す正本は `tools.json`・`game.json`（一覧）と `glitch.json`（記事メタ）。GitHub Actions が作る生成物（手で編集しない）は `oil-price.json`、`magi-context.json`（MAGI の人格カード。magi2 が `https://tk.st/data/magi-context.json` から読むので場所を変えない）、`nitori-daily/`・`retail-tech-daily/`（日刊の号データ。年ごとの `<YYYY>.json`。読み書きは `daily_engine.py` の `load_history`/`save_history` を通す）、`nitori-tiktok-buzz.json`（日刊ニトリ用の TikTok の取得結果） |
| `assets/` | 区画をまたいで使う自前のコードと、取り込んだ外部物。`analytics.js`（GTM と Ahrefs の読み込み。ID はここにだけ書く）、`buy-me-oil.js`（寄付ウィジェット。`oil-price.json` は自分の場所から `../data/` を引く）、`bijutsu-shisui.js`+`.css`（DJ の各ページと `anniversary/mitsuki32/` の背景演出）、`vendor/`・`fonts/`（取り込んだライブラリとフォント。後述「SAFE TOOLS の通信制限」） |
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
| `magi-app/` | MAGI モバイルアプリ。`www/` が出荷物 |
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
| `workers/magi2` | tk-st-magi2-api | `workers.tk.st/magi2*` | MAGI 現行（3人格＋統合、SSE ストリーミング、画像対応。後述「magi2 の人格設定」）。D1: `tk-st-magi2-db`。secret: `MAGI_OPENAI_API_KEY`・`MAGI_DEEPSEEK_API_KEY`・`MAGI_GEMINI_API_KEY`、`CLIENT_API_KEY`。任意で `RESEND_API_KEY`・`ALERT_TO`・`ALERT_FROM`（各社の残高切れ・キーの失効をメールで知らせる。同 README.md） |
| `workers/games` | st-games-api | ルートなし（`*.workers.dev` 直叩き） | ゲーム共通 API（ランキング、GPT 呼び出し）。D1: `st-games-ranking-db`。secret: `GAME_OPENAI_API_KEY` |

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
- npm を使うのは次の3つだけ:
  - `magi-app/`: `npm run serve`（PWA 確認）、`npm run sync`（Capacitor 同期）。
  - `game/reverse-recaptcha/`: `npm ci` → `npm run build`（本番は `build.sh` がビルドする）。
    依存を変えたら `npm install` で `package-lock.json` も更新してコミットする（ずれると `npm ci` が通らない）。
  - `workers/`: 全 Worker 共通の wrangler だけ（`workers/package.json`）。`cd workers && npm ci` で入れる。

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
    Workers Routes の編集権限を含める）と `CLOUDFLARE_ACCOUNT_ID` を置く。Worker の secret は Cloudflare 側のまま使う。
    Worker を足したら `options` にも足す。
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
- **magi2 の人格設定**: `workers/magi2/personas.js` が人格の骨格プロンプト、用途ごとの推論強度、
  トークン上限、タイムアウト、揺らぎの唯一の正本。モデルIDだけは上記の共通正本に従う。
  - 404のAI検索とチャットのサイト案内は `SITE_SEARCH`／`site-search.js`。404検索はOpenAIだけに送る。
    固定の入口11件は `SITE_SEARCH.pages` と `404.html` の `data-entry` で同じ行き先・日英の名前・説明を持つ。片方を変えたらもう片方も直す。
    回数は既存の `countUp`／`rate_limit` に `search:<IP>` と `search:global` で記録し、通常チャットと分ける。検索内容はログ・通知・DBに残さない。
  人間向けの別形式（以前の `persona.yaml` のようなもの）を並べて二重管理にしないこと。
  - **固定プロンプトに書くのは「役割と出力の形」と「気質」だけ**。本人の事実・関心・考え（好きなもの、拠り所の書物、
    仕事の中身、得意ジャンルなど）は書かず、サイトの本文に書いて人格カードに任せる（固定に書くと本人が変わっても
    古いまま残り、カードと食い違う）。統合人格は気質も固定に持たず、性格検査から作る自己像のカードを気質の正本にする。
    画面（トップページとアプリ）のスプラッシュに出す人格の説明（気質・素材・テーマによる違い）は `personas.js` の
    `PERSONA_GUIDE` が正本で、`/magi2/models` がモデル名と一緒に返す。画面には名前しか書かない（アプリのリリースなしで直せる）。
    気質は固定プロンプトに、素材は `magi-context.py` の `PERSONAS` に揃える。
  - 3人格は答えの癖と間違え方をばらけさせるため、人格ごとに会社を分けている（Enthusiast = DeepSeek、
    Humanist = Gemini、Strategist・統合 = OpenAI。`DEFAULTS.models.persona` を codename で引く）。呼び出し先は `PROVIDERS`、
    会社ごとの推論の切り方やトークン上限の名前の違いは `src/index.js` の `requestBody` に閉じている。
    1人格が失敗しても（障害・安全フィルター・キー未設定・時間切れ）その人格を `[NO RESPONSE]` にして
    残りで討議と統合を続け、全員が失敗したときだけエラーにする。
  - **人格ごとの会話の履歴**: 画面は履歴の回答に、その回の各人格の意見を `debate`（`{ 人格名: { round1, round2 } }`）として
    付けて送る（トップページとアプリは履歴の項目をそのまま、`dj/request/` は保存した `personas` を変換して）。Worker は
    人格ごとに履歴を組み直し（`personaThread`）、**その人格自身の過去の意見だけを assistant に置く**。3人格は一人の人間の
    中の面なので記憶は共有し、他の2人格の過去の意見と統合人格の過去の回答も、次の質問の頭に誰の言葉かを書いた見出し
    （「前回、BALTHASAR-2（Humanist）…が言ったこと」「前回、あなたたち3人の議論をまとめて Shinya Takeda が答えたこと」）を
    付けて文脈として渡す（自分の発言としては渡さない）。3人格の固定プロンプトの冒頭にも、この構造（一人の人間の中の
    3つの面で、3人の議論を本人がまとめて答える）を書いてある。統合人格には従来どおり自分の回答を assistant で渡す。
    上流の API へは role と content しか送らない（`requestBody`）。
  - 入力は3社すべてに送られる。会社を変えたり足したりしたら、トップページと `magi-app/www/app.js` の
    「System & Privacy」の送信先・保持・学習利用の説明も直すこと。Gemini はいま無料枠のキーで動いている
    （入力が Google の製品改善とモデルの学習に使われ、人が読むこともある）。注意文はそれに合わせてあるので、
    有料枠に切り替えたら説明も直すこと。
  - 次の質問の予測: リクエストに `suggest: true` を付けると、統合の答えの後に軽量モデル（`openai.luna`・推論なし）で
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
  - **例外は曲リクエスト**（`workers/dj-request` と `dj/request/`・`dj/booth/`）。保存時に落とすのは制御文字と
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
