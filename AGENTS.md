# AGENTS.md — tk.st

個人サイト **tk.st**（Shinya Takeda のターミナル風ポートフォリオ）のリポジトリ。
静的 HTML/CSS/JS のサイト本体と、動的機能を担う Cloudflare Workers 群で構成される。
リモートは `https://github.com/tk33r1/st.git`（ブランチは `main`）。

## プロジェクト概要

- **サイト本体**: ビルド工程なしの素の静的ファイル。各ページは `*/index.html` に
  スタイルとスクリプトをほぼ内包する自給自足型（ルートの `index.html` は単体で約350KB）。
  公開 URL はディレクトリ構造と一致する（`tools/pdf-studio/index.html` → `https://tk.st/tools/pdf-studio/`）。
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
| `data/` | 共有 JS/CSS/JSON。`buy-me-oil.js`（寄付ウィジェット）、`glitch.js`+`glitch.json`（記事メタ一元管理）、`tools-ui.js`+`tools-ui.css`（SAFE TOOLS 共通 UI、`window.STCommon`）、`tools-share.js`（完了時のシェア/寄付のお願い、`window.STShare`）、`game.json`/`tools.json`（一覧データ）、`oil-price.json`（GitHub Actions が週次更新） |
| `tools/` | ブラウザ内完結のツール群（csv-json-bridge, light-svg, pdf-studio 等）。`tools-ui.js` を共有。アクセント色は `tools.json` の `category` 由来（`data/tools-ui.css` の `--cat-*`）で、ツール個別には持たない。ダウンロード等の完了地点では `STShare.celebrate()` を呼ぶ（後述） |
| `images/ogp/` | 各ページの OGP 画像（2400×1260）。ツールの分は `.github/scripts/ogp/generate.js` で生成する。手で描き直さない |
| `game/` | ゲーム群（masala-tetris 系、reverse-recaptcha 等）。ランキングは `workers/wrangler`（st-games-api） |
| `glitch/` | 技術ブログ記事（001〜005）。コメントは `workers/comments` |
| `dj/` | DJ 関連。`schedule/`（日程調整）、`request/`（曲リクエスト）、`booth/`（ブースコンソール） |
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
| `workers/magi` | tk-st-magi-api | `workers.tk.st/magi*` | MAGI 旧版。secret: `MAGI_API_KEY` |
| `workers/magi2` | tk-st-magi2-api | `workers.tk.st/magi2*` | MAGI 現行（3人格＋統合、SSE ストリーミング、画像対応）。D1: `tk-st-magi2-db`。secret: `MAGI_OPENAI_API_KEY`（`MAGI_DEEPSEEK_API_KEY` は未使用の保持） |
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

## コーディング規約

- **言語**: コメント・ドキュメントは原則**日本語**（magi-app の README や
  tools-ui.js の一部など例外あり）。コミットメッセージは短い英語（`update` 等）。
- **スタイル**: ページごとに自給自足。外部 CSS/JS への依存は `data/` の共有ファイルに限る。
  フレームワーク・ビルドツールを勝手に持ち込まない。
- **データ一元化**: glitch 記事のメタは `data/glitch.json` にだけ持ち、`data/glitch.js` が
  描画する。記事追加時は HTML ではなく JSON を編集する。tools/game の一覧も同様に
  `data/tools.json` / `data/game.json` が正。
- **完了時のお願い**: ツールがユーザーの用を足した瞬間（ダウンロード・保存・書き出し、
  text-diff なら結果のコピー）で `if (window.STShare) STShare.celebrate();` を呼ぶ。
  文面・共有 URL はページの JSON-LD / og:title / canonical から自動で組み立てるので
  引数は不要。パネルには「要望・不具合を伝える」の行き先も置いてあり、
  `/contact/?subject=[ツール名] 改善のご提案` へ飛ぶ（`contact/index.html` が
  `?subject=` を制御文字除去＋エンコードのうえ mailto に載せる。省略時は従来どおり件名なし）。
  頻度制御（1セッション1回、21日クールダウン、応じた人は180日、
  「今後は表示しない」は永久）は `data/tools-share.js` 側に閉じているので、
  呼び出し側で条件分岐しない。ツールを増やすときは `<script src="../../data/tools-share.js">`
  を `buy-me-oil.js` の隣に置き、ダウンロード処理を通す共通関数に1行足すだけでよい。
  見た目の確認は URL に `?st-share=preview` を付けて完了操作をすると抑制を無視して出る。
- **personas 二重管理**: `workers/magi2/persona.yaml` が正本で `personas.js` がランタイム用。
  **変更時は両方を更新すること**（ファイル頭の注意書きどおり）。
- **XSS 対策**: ユーザー入力は保存時に `<` `>` と制御文字を除去し、表示はすべて
  `textContent` で描画する（dj-schedule README「制限値」節の方針が全 worker 共通）。
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
