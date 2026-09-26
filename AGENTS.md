# AGENTS.md — tk.st

個人サイト **tk.st**（Shinya Takeda のターミナル風ポートフォリオ）のリポジトリ。
静的 HTML/CSS/JS のサイト本体と、動的機能を担う Cloudflare Workers 群で構成される。
リモートは `https://github.com/tk33r1/st.git`（ブランチは `main`）。

## プロジェクト概要

- **サイト本体**: ビルド工程なしの素の静的ファイル。各ページは `*/index.html` に
  スタイルとスクリプトをほぼ内包する自給自足型（ルートの `index.html` は単体で約400KB）。
  公開 URL はディレクトリ構造と一致する（`tools/pdf-studio/index.html` → `https://tk.st/tools/pdf-studio/`）。
  ルートの `index.html` は Bitcoin の Witness 領域（Ordinals インスクリプション）にも刻んである
  ため、外部フォント / CDN / 外部アセットを足さない（CSS・JS・アイコン・QR はすべてインライン）。
  **例外は head の Ahrefs と GTM の2本だけ**で、これは公開サイト側の計測用。インスクリプション版は
  この2行を落としたものになる。新しく外部参照を増やすときは、その前提を壊していないか確認すること。
  **この制約はトップページ（ルートの `index.html`）だけ**で、他のページは外部の CSS / JS / フォントを使ってよい。
  ただし **SAFE TOOLS（`tools/` 配下）は別の決まり**があり、外部とやりとりするのはアクセス解析（GTM 経由の GA4、Cloudflare Web Analytics、Ahrefs Web Analytics）だけ（後述「SAFE TOOLS の通信制限」）。
- **Workers** (`workers/`): 認証・DB・AI 呼び出しなどのサーバーサイド機能。
  Cloudflare Workers + D1 (SQLite)。すべて `src/index.js` 単一ファイル構成で、
  `export default { async fetch(request, env) {...} }` の標準形。
- **MAGI アプリ** (`magi-app/`): MAGI チャットのモバイル版。PWA + Capacitor で
  iOS/Android にパッケージングする唯一の npm 管理サブプロジェクト。
- **GitHub Actions** (`.github/`): サイトマップ生成とガソリン価格 JSON の週次更新。
  `.github/scripts/ogp/` は CI ではなく手元で叩く OGP カード生成（`README.md` 参照）。

## ディレクトリ構成

| パス | 内容 |
| --- | --- |
| `index.html` | トップページ。ターミナル風ポートフォリオ兼 MAGI チャット UI（英語メイン） |
| `data/` | 共有 JS/CSS/JSON。`buy-me-oil.js`（寄付ウィジェット）、`glitch.js`+`glitch.json`（記事メタ一元管理）、`tools-ui.js`+`tools-ui.css`（SAFE TOOLS 共通 UI、`window.STCommon`。ドロップ枠・保存・コンソール表示・FFmpeg の読み込みなども持つ）、`tools-base.css`（SAFE TOOLS の土台のリセットとアイコン寸法などの部品クラス。以前 Tailwind の実行版が組み立てていたものの書き写し。QR Atelier は読まない）、`tools-share.js`（完了時のシェア/寄付のお願い、`window.STShare`）、`dj-request-core.js`（`dj/request/` と `dj/booth/` の共通処理、`window.DJRequestCore`。API 呼び出し・localStorage・30秒プレビューの再生・日時の整形・`escapeHTML`・`appleHref`）、`game.json`/`tools.json`（一覧データ）、`oil-price.json`（GitHub Actions が週次更新）、`magi-context.json`（MAGI の人格カード。GitHub Actions が生成、手で編集しない）、`vendor/`（SAFE TOOLS が使う外部ライブラリの同梱。`.github/scripts/vendor/fetch-vendor.js` が取り込み、出どころと SHA-256 を `vendor/SOURCES.json` に記録。手で置かない）、`fonts/`（Web フォントの同梱。`.github/scripts/fonts/fetch-fonts.js` が作る） |
| `tools/` | ブラウザ内完結のツール群（csv-json-bridge, light-svg, pdf-studio 等）。`tools-ui.js` を共有。アクセント色は `tools.json` の `category` と同じ値を `<html data-category="…">` に書いて決める（`data/tools-ui.css` の `--cat-*`）。ページの CSS で `--accent` を持たない。ダウンロードは `STCommon.saveBlob()` を通す（`STShare.celebrate()` まで呼ぶ。後述） |
| `images/ogp/` | 各ページの OGP 画像（2400×1260）。ツールの分は `.github/scripts/ogp/generate.js` で生成する。手で描き直さない。日刊の号別カードは `images/ogp/<media_id>/<YYYYMMDD>.webp`（旧 `<media_id>-<date>.webp` は `_redirects` で 301） |
| `game/` | ゲーム群（masala-tetris 系、reverse-recaptcha 等）。ランキングは `workers/wrangler`（st-games-api） |
| `glitch/` | 技術ブログ記事（001〜005）。コメントは `workers/comments` |
| `dj/` | DJ 関連。`index.html`（ポートフォリオ。末尾に出演オファーフォーム）、`schedule/`（日程調整）、`request/`（曲リクエスト）、`booth/`（ブースコンソール） |
| `magi/`, `contact/`, `job/`, `thought/` | 個別ページ |
| `anniversary/` | 記念日ページ。`matsumura40/`（旧 `/matsumura40/`。`_redirects` で 301 済み） |
| `images/` | `common/`, `contents/`, `favicons/`, `ogp/` |
| `workers/` | Cloudflare Workers（下表参照） |
| `magi-app/` | MAGI モバイルアプリ（PWA + Capacitor 6）。`www/` が出荷物 |

### Workers 一覧（各ディレクトリに `wrangler.toml` と `src/index.js`）

| Worker | 名前 | ルート | 用途 |
| --- | --- | --- | --- |
| `workers/auth` | tk-st-auth | `tk.st/bitcoinyen/bbm/*` | Basic 認証。secret: `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` |
| `workers/comments` | tk-st-comments | `tk.st/glitch/api/*` | glitch 記事のコメント。D1: `glitch-comments-db` |
| `workers/dj-schedule` | tk-st-dj-schedule | `tk.st/dj/api/schedule/*` | 日程調整 API。D1: `dj-schedule-db`。**詳細は同ディレクトリの README.md を読むこと** |
| `workers/dj-request` | tk-st-dj-request | `tk.st/dj/api/req/*` | 曲リクエスト API。D1: `dj-request-db`。secret: `ADMIN_KEY`, `IP_SALT` |
| `workers/dj-offer` | tk-st-dj-offer | `tk.st/dj/api/offer/*` | 出演オファーフォームの受け口。D1 なし（内容は Resend でメール転送するだけ）。secret: `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, `OFFER_TO`, `OFFER_FROM`。**Resend / Turnstile の初期設定は同ディレクトリの README.md を読むこと** |
| `workers/magi` | tk-st-magi-api | `workers.tk.st/magi*` | MAGI 旧版。secret: `MAGI_API_KEY` |
| `workers/magi2` | tk-st-magi2-api | `workers.tk.st/magi2*` | MAGI 現行（3人格＋統合、SSE ストリーミング、画像対応）。人格ごとに会社を分けている（Enthusiast = DeepSeek、Humanist = Gemini、Strategist・統合 = OpenAI）。D1: `tk-st-magi2-db`。secret: `MAGI_OPENAI_API_KEY`・`MAGI_DEEPSEEK_API_KEY`・`MAGI_GEMINI_API_KEY` |
| `workers/wrangler` | st-games-api | ルートなし（`*.workers.dev` 直叩き） | ゲーム共通 API（ランキング、GPT 呼び出し）。D1: `st-games-ranking-db`。wrangler のみ npm 依存 |

## ビルドとテスト

- **ビルド工程は存在しない**。静的ファイルはそのままデプロイされる。
- **テストスイートも存在しない**。検証は構文チェックと手動確認で行う:
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
- `magi-app/` のみ npm あり: `npm run serve`（PWA 確認）、`npm run sync`（Capacitor 同期）。

## デプロイ

- **静的サイト**: `main` への push で Cloudflare 側に反映される前提（リポジトリ内に
  Pages 設定ファイルはない。`_headers` は未使用、`_redirects` はルートに置いて
  旧 URL の 301 リダイレクトのみ定義している）。
- **Workers**: 手動デプロイ。各ディレクトリで `npx wrangler deploy`
  （ルートから `npx wrangler deploy --config workers/<name>/wrangler.toml` でも可）。
- **シークレット**: `wrangler secret put <NAME> --config workers/<name>/wrangler.toml` で設定。
  リポジトリにコミットしない。`.dev.vars` も `.gitignore` 済み。
- **D1 の初期化**: `npx wrangler d1 create <db>` → database_id を `wrangler.toml` に貼る →
  `npx wrangler d1 execute <db> --remote --file=./schema.sql`。
  既存 DB への列追加は `migrate-*.sql` / `migrations/` を使う（2回適用は `duplicate column` で落ちる＝適用済み）。
- **GitHub Actions**（bot が `main` に直接コミットする）:
  - `sitemap.yml`（push 時）: `update-modified.py` で各 HTML の JSON-LD `dateModified` を
    git コミット日時と同期 → `sitemap.xml` / `robots.txt` を再生成。bot 自身のコミットは
    `[skip ci]` と冪等性でループ回避。
  - `oil-price.yml`（毎週水曜 07:00 UTC）: 資源エネルギー庁の xlsx から東京のハイオク価格を
    取得して `data/oil-price.json` を更新。
  - `retail-tech-daily.yml` / `nitori-daily.yml`（毎朝 JST）: `daily-brief-reusable.yml` 経由で
    日刊ブリーフを生成し、最後に `post-to-x.py` が新着号を公式 X（@retailtechdaily /
    @dailynitori）へポストする。本文の URL は `ttps://` 表記にして自動リンクを避け
    （X は URL 付きポストを課金対象にする）、代わりに号の OGP 画像を添付する。
    OGP は Chrome でレンダリングするため、CI に `fonts-noto-cjk` の導入が必須
    （入れないと日本語が豆腐になる）。ポスト ID は号の JSON（`x_post_id`）に記録され、これが
    二重ポストの抑止を兼ねる。認証は OAuth 1.0a で、リポジトリ Secrets に
    `X_<MEDIA_ID 大文字>_CONSUMER_KEY` / `_CONSUMER_SECRET` / `_ACCESS_TOKEN` /
    `_ACCESS_TOKEN_SECRET` の4点（メディアごと）を置く。未設定なら警告だけ出して生成は通す。
  - `post-to-x.yml`（手動のみ）: 既存の号を X へポストし直す。再送・バックフィルと、
    `dry-run` での本文確認に使う（生成は走らない）。
  - `magi-context.yml`（push 時＋手動）: `.github/scripts/magi-context.py` が
    MAGI の人格カードを作り直して `data/magi-context.json` にコミットする（後述「MAGI の人格カード」）。
    push のたびに起動するが、素材のハッシュが前回と同じ人格は LLM を呼ばない。変わった人格は
    毎回素材からゼロで作る（前回のカードは渡さない。言い回しが多少変わるのは許容）。
    手動実行の `force` は素材が同じでも全人格を作り直す。コミットメッセージに CI を止める印を入れない
    （Cloudflare Pages がビルドを省略し、JSON が次の push まで公開されない）。
  - `ai-models.yml`（push＋PR）/ `ai-model-watch.yml`（週次＋手動）: AIモデル設定の正本
    `config/ai-models.json` の形式とモデルIDの直書きがないことを検査し、OpenAI / DeepSeek の
    `/models` APIから更新候補を検知する。スモークテストは毎週回し、候補が通ればレビュー用PRへ出し、
    失敗したらIssueで通知する。自動マージ・自動デプロイはしない。運用詳細は `.github/AI_MODELS.md`。
  - `sitemap.yml` と `magi-context.yml` は同じ push で main にコミットしうるので、どちらも
    `.github/scripts/push-with-retry.sh` で push する（取り込んでから push し、弾かれたら取り込みから
    やり直す）。workflow をまたぐ `concurrency.group` の共有はしない（待機中の実行が新しい実行に
    キャンセルされ、sitemap が黙って飛ぶため）。bot のコミットを増やすときも同じスクリプトを使うこと。

## コーディング規約

- **言語**: コメント・ドキュメントは原則**日本語**（magi-app の README や
  tools-ui.js の一部など例外あり）。コミットメッセージは短い英語（`update` 等）。
- **スタイル**: ページごとに自給自足が基本。外部参照を禁じるのはトップページ（ルートの `index.html`）
  と SAFE TOOLS（`tools/` 配下。次項）で、それ以外のページは Google Fonts などの Web フォントや CDN の
  CSS/JS を読み込んでよい。共有したい自前の CSS/JS は `data/` に置く。フレームワーク・ビルドツールを勝手に持ち込まない。
- **SAFE TOOLS の通信制限**: `tools/` 配下の全ページは head の先頭で Content-Security-Policy を宣言し、
  読み込みや送信に使える通信先を、このサイトとアクセス解析（GTM 経由の GA4、Cloudflare Web Analytics、
  Ahrefs Web Analytics）だけに制限している（寄付ウィジェットの Ko-fi は iframe の表示だけ許可）。GA4 の Google シグナルの送り先
  （*.g.doubleclick.net・www.google.com・www.google.co.jp）も許している。国別の google ドメインは日本だけなので、
  ほかの国からの訪問ではシグナルの一部が止まる。広告コンバージョンは GA4 側で切ってある。Microsoft Clarity は
  入れない（GTM 側で `tk.st/tools/` を除外済み。セッション記録が入力や QR の中身まで送っていた。
  除外が外れても CSP が止める）。Ahrefs は `analytics.ahrefs.com` を script-src と connect-src に許し、GTM の直後の
  インラインスクリプトから読み込む。Ahrefs は URL を丸ごと送るので、`data-page-location` にパスとクエリだけを渡して
  `#` 以降（QR Atelier の共有デザイン `#d=` など）を載せない。
  - ページの注記・FAQ・構造化データでも説明している。CSP が保証するのは「読み込みと送信の通信先」まで
    （ページの移動や、許した送り先へ何を載せるかは縛れない）なので、「どんな不具合があっても送れない」の
    ような言い方はしない。「中身を送る処理を持たない」＋「通信先を制限している」の2段で書く。
  - ライブラリ・フォントは CDN から読まず、`data/vendor/`・`data/fonts/` に同梱して読む。版を上げる・足すときは
    `fetch-vendor.js` の `LIBS` を直して実行し、`SOURCES.json` の差分ごとコミットする（`--check` で照合だけできる）。
    25MB を超えるファイル（FFmpeg のコア wasm）は分割して置き、`STCommon.fetchVerified` が `SOURCES.json` の
    `split` を読んでつなぎ、SHA-256 を照合する。
  - CSP は `'unsafe-eval'` を許していない。文字列からコードを作る古い Emscripten 出力（heic2any の libheif、
    QR Atelier の OpenCV WeChat）は `.github/scripts/vendor/patches.js` の置き換えで同じ働きのクロージャに
    直してあり、`fetch-vendor.js` が取り込みのたびに当てる。`--check` は同梱の JS 全体を調べ、理由を書いて
    許したもの（`DYNAMIC_OK`）以外に文字列からコードを作る処理が見つかったら止まる。ライブラリを足したら必ず走らせる。
  - `data/vendor/`・`data/fonts/` は `.gitattributes` で改行変換を止めている（記録した SHA-256 と食い違うため）。
  - CSP は各ページに同じ文字列で書いてある。外部の通信先を足すと約束の説明（注記・FAQ・構造化データ）も
    変わるので、広げる前に同梱で済まないかを考える。新しいツールを足すときも同じ `<meta>` を head の先頭
    （`<meta charset>` の直後、どのスクリプトよりも前）に置く。
  - `data/tools-ui.js` は CSP の meta の直後、GTM を含むどのスクリプトよりも前に読む（通信メーターが GTM の通信や
    ブラウザが止めた通信まで数えるため）。新しいツールでも同じ位置に置く。後ろに置くと、先に止められた通信が
    「想定外の行き先への送信」に見えて安全設計カードが「!」になる。
  - Worker は blob: の URL から起動する（`toBlobURL` や `fetch` → `URL.createObjectURL`）。同じサイトの URL から
    直接起動した Worker にはページの meta の CSP が効かない（Worker を返したときの HTTP ヘッダーの CSP が使われ、
    このサイトは付けていない）。pdf.js の worker もこの理由で blob: にしてある。
- **安全設計カードと処理レシート**: `tools-ui.js` が各ツールの `<main>` の前に出す。5項目のチェックは
  宣言ではなく、そのページで実際に起きた通信（Resource Timing、fetch / XHR / sendBeacon などの呼び出し、
  CSP が止めた知らせ）と CSP の点検から決める。「データの送信」（中身を載せられる送り方。アクセス解析は別に数える）が
  1件でもあれば緑にしない。ページの CSP がどの指定でも許していない行き先なのに、止められずに Resource Timing に
  現れた通信は、ページのプログラムからは出せないので「ブラウザや拡張機能」として分け、送信に数えない
  （Perplexity の Comet がフォントを差し込むなど）。CSP が止めたフォント（font-src）も同じ扱いにする。フォントは
  スタイルシートからしか読み込まれず、このサイトのスタイルは許していない行き先のフォントを使わないため
  （止めた知らせの中身では、ページ自身が差し込んだものと見分けがつかないので、何が止まったかで判断している）。
  サイトのスタイルに外部のフォントを足すと、この前提が崩れる。「ガードを試す」は example.com へあえて送ろうとし、ブラウザが止めるのを見せる。
  処理レシートは `STShare.celebrate()` のたびに出る（celebrate が `st:complete` イベントを出し、tools-ui.js が
  それを受けて出す。ツール側の追加作業はない）。
  区切りはファイルを受け取った時点（change / drop / paste を捕捉で拾う）。どれもページ自身による計測で、
  Worker の中の通信は数えていない。画面にもそう書いてあるので、「送れない」のような言い方に変えないこと。
  カードはツールのすぐ下（`<main>` の直後。`<main>` 直下に `.prose-tool` / `.prose` の説明文があればその手前）に出る。
- **アクセス解析を止める**: 安全設計カードの下のボタンで、利用者が止められる。設定は localStorage の
  `st-analytics`（`off` で停止）。止めていると、`tools/` の各ページの GTM と Ahrefs の読み込みスニペットが先頭で
  このキーを見て読み込まず、`tools-ui.js` が Cloudflare Web Analytics の差し込みスクリプトを実行前に取り除き、
  途中で止めたときは以後の解析（Ahrefs を含む）への fetch / XHR / sendBeacon を送らずに捨てる。新しいツールの
  GTM と Ahrefs のスニペットにも同じ判定（`try{if(localStorage.getItem('st-analytics')==='off')return}catch(e){}`）を
  入れる。一覧ページ（`tools/index.html`）は GTM と Ahrefs が止まる（`tools-ui.js` を読まないので Cloudflare の分は止まらない）。
- **データ一元化**: glitch 記事のメタは `data/glitch.json` にだけ持ち、`data/glitch.js` が
  描画する。記事追加時は HTML ではなく JSON を編集する。tools/game の一覧も同様に
  `data/tools.json` / `data/game.json` が正。
- **完了時のお願い**: ツールがユーザーの用を足した瞬間（ダウンロード・保存・書き出し、
  text-diff なら結果のコピー）で `if (window.STShare) STShare.celebrate();` を呼ぶ。
  ファイルの保存は `STCommon.saveBlob(blob, name)` がこれを呼ぶので、保存を通すツールは何もしなくてよい。
  文面・共有 URL はページの JSON-LD / og:title / canonical から自動で組み立てるので
  引数は不要。パネルには「要望・不具合を伝える」の行き先も置いてあり、
  `/contact/?subject=[ツール名] 改善のご提案` へ飛ぶ（`contact/index.html` が
  `?subject=` を制御文字除去＋エンコードのうえ mailto に載せる。省略時は従来どおり件名なし）。
  頻度制御（1セッション1回、21日クールダウン、応じた人は180日、
  「今後は表示しない」は永久）は `data/tools-share.js` 側に閉じているので、
  呼び出し側で条件分岐しない。ツールを増やすときは `<script src="../../data/tools-share.js">`
  を `buy-me-oil.js` の隣に置き、ダウンロードを `STCommon.saveBlob` で行えばよい（コピーなど保存以外の完了地点だけ1行足す）。
  見た目の確認は URL に `?st-share=preview` を付けて完了操作をすると抑制を無視して出る。
- **AIモデル設定**: モデルIDの正本は `config/ai-models.json`。Pythonからは
  `.github/scripts/ai_model_registry.py` を通して読み、Worker はJSONを `import` する（wrangler が
  デプロイ時に取り込む）。モデルIDを別の場所へ直書きしない（`ai_models.py check` が検出する）。
  週次のスモークテスト（`ai_models.py` の `smoke_*`）は各利用箇所の呼び出し方（temperature・top_p・
  画像・推論・ストリーミング）をなぞっているので、呼び出し方を変えたらそちらも合わせる。
- **magi2 の人格設定**: `workers/magi2/personas.js` が人格の骨格プロンプト、用途ごとの推論強度、
  トークン上限、タイムアウト、揺らぎの唯一の正本。モデルIDだけは上記の共通正本に従う。
  以前あった `persona.yaml` は読まれないまま内容がずれたので廃止した。人間向けの別形式を
  並べて二重管理に戻さないこと。
  - 3人格は答えの癖と間違え方をばらけさせるため、人格ごとに会社を分けている（`DEFAULTS.models.persona` を
    codename で引く）。呼び出し先は `PROVIDERS`、会社ごとの推論の切り方やトークン上限の名前の違いは
    `src/index.js` の `requestBody` に閉じている。1人格が失敗しても（障害・安全フィルター・キー未設定・時間切れ）
    その人格を `[NO RESPONSE]` にして残りで討議と統合を続け、全員が失敗したときだけエラーにする。
  - 入力は3社すべてに送られる。会社を変えたり足したりしたら、トップページと `magi-app/www/app.js` の
    「System & Privacy」の送信先・保持・学習利用の説明も直すこと。Gemini は有料枠のキーを使う（無料枠は入力が学習に使われる）。
- **MAGI の人格カード（`data-magi` の目印）**: magi2 の3人格は、固定の骨格プロンプト（personas.js）に
  サイト本文から要約した「いまの中身」を足して動く。元ネタはページ内で `data-magi="<人格>"` を
  付けた要素だけ（`balthasar` = `thought/`、`melchior` = `dj/`・`motovlog/`、`casper` = `job/`）で、
  ほかに `data/tools.json`・`data/glitch.json` を使う。JSON-LD は使わない（本文の言い換えばかりで、
  SEO の都合で直すたびに作り直しが走るため）。人格に知らせたい事実は本文に書いて目印を付ける。
  **ページを改修するときは `data-magi` の属性を残すこと**（class や id は自由に変えてよい）。
  目印の内側で読ませたくない部分は `data-magi-skip` を付けて外す（job の Signal Board のような
  演出用の数値、料金、数値の仕様表（排気量・寸法など）といった実務情報は入れない。愛機のデザインの
  特徴のように、こだわりとして語れるものは入れてよい）。抽出は DOM の順に読むので、年表の年のような
  見出しは HTML 上で本文より前に置く（見た目の位置は CSS で決める。後ろに置くと LLM が次の項目の年として
  読む）。抽出は JS を実行しないので、JS で書き換わる部分（motovlog の近況など）には目印を付けない。
  目印が消えると workflow がエラーで止まり、Worker は前回のカードのまま動き続ける。要約に失敗した人格も
  前回のカードのまま残り、作れた人格だけが保存される。素材のページを増やすときは
  `magi-context.py` の `PERSONAS` にだけ足す（workflow は絞り込みをしていない）。抽出結果は `python .github/scripts/magi-context.py --dry-run --show` で API キーなしに確認できる。
  Worker は `https://tk.st/data/magi-context.json` を isolate ごとに10分使い回し（期限切れ後は手元の
  カードで答えつつ裏で取り直す）、取得に失敗したり3人格そろわなかったりしたら1分後に再試行する。
  カードは人格ごとに上書きし、JSON に欠けた人格は直近のカードを保つ。反映は10分強遅れることがある。
- **XSS 対策**: ユーザー入力は保存時に `<` `>` と制御文字を除去し、表示はすべて
  `textContent` で描画する（dj-schedule README「制限値」節の方針が全 worker 共通）。
  - **例外は曲リクエスト**（`workers/dj-request` と `dj/request/`・`dj/booth/`）。保存時に落とすのは制御文字と
    長さの超過だけで、`<` `>` は残る。表示は一覧を `innerHTML` で組むので、来場者由来の値は必ず
    `escapeHTML`（`data/dj-request-core.js`。各ページでは `esc`）を通してから文字列に入れる。表示する値を足すときも同じ。
  - URL はエスケープでは防げない（`javascript:` がそのまま残る）。来場者が送った URL（`appleUrl`）を `href` や
    `location` に入れる前に、`appleHref` で Apple の https URL か確かめ、違えば使わない。ジャケットとプレビューの URL は
    `<img src>` と `new Audio()` にしか渡さないので、エスケープだけでよい。
- **CORS 方針**: `ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st']` に Origin ベースで
  許可し、それ以外は API キー（`x-api-key` / `x-admin-key`）を要求。magi2 は Capacitor アプリの
  `https://localhost` オリジンも正規表現で許可。
- **ルート設計**: Cloudflare は route の重複を許さないため、Worker 同士で接頭辞を分ける
  （dj-schedule は `/dj/api/schedule/*`、dj-request は `/dj/api/req/*`）。

## セキュリティ上の注意

- API キー・ソルト類はすべて Wrangler secret。コードや wrangler.toml に書かない。
- ゲーム系 Worker では、料金に響くパラメータ（モデル・トークン上限等）をクライアントに
  開けない（Origin は偽装できる前提で設計）。
- magi2 の画像入力は `data:` URL のみ許可。外部 URL を許すと Worker が踏み台になる。
- dj 系ページは身内限定で、URL の非公開性と `noindex` のみが防御。過度な機密情報を置かない。
- `workers/dj-schedule` のコードには `CLIENT_API_KEY` の分岐があるが設定しても挙動は変わらない
  （README「アクセス制限について」に理由の記述あり）。

## その他

- `.gitignore`: `node_modules/`, `.wrangler/`, `.dev.vars`, `*.apk`（APK は GitHub Releases で配布）、
  デバッグ用ダンプ（`dom.txt`, `err.txt`, `*.log`）。
- ルート `index.html` は巨大かつ高頻度で編集される。変更後は上記の script 抽出＋
  `node --check` で構文確認するのがこのリポジトリの習慣。
