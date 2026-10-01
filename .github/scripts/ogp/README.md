# OGP カード生成

`images/ogp/*-ogp.{png,webp}` を作り直すスクリプト。ヘッドレス Chrome に
1200×630 の HTML を描かせて dsf 2 で撮り、2400×1260 の画像として書き出す。

依存パッケージなし（Node 組み込みの `WebSocket` で CDP を直接叩く）。Node 18 以上。

## 使い方

```bash
node .github/scripts/ogp/generate.js              # 全部
node .github/scripts/ogp/generate.js light-svg    # 1枚だけ
node .github/scripts/ogp/generate.js --check      # 検査のみ、書き出さない
node .github/scripts/ogp/generate-qr-artwork.js   # QR Palette の実QR図版を作り直す
node .github/scripts/ogp/verify-qr.js             # QR が読めるか確認
```

Chrome は既定のインストール先を自動で探す。見つからない場合は
`CHROME=/path/to/chrome` を渡す。

Web フォント（JetBrains Mono / Noto Sans JP）を Google Fonts から読むので
**ネットワークが要る**。オフラインだとローカルのフォントで代替して描画が
変わるため、その場合はログに `TIMEOUT-local-fonts` と出る。出たら捨てて
やり直すこと。

## 構成

| ファイル | 役割 |
|---|---|
| `cards.js` | カードの定義。共通シェルの CSS と、ツールごとの図版・文言・カテゴリ |
| `generate.js` | 1枚を画像にする処理だけ。ツール固有のことは持たない |
| `generate-qr-artwork.js` | QR Palette と同じ描画エンジンで実QRの図版を生成 |
| `verify-qr.js` | QR Palette のカードに入っている QR が実際にデコードできるか検査 |
| `assets/qr-artwork.png` | QR Palette の図版（後述） |

ツールを増やすときは `cards.js` に1エントリ足す。

## ツール以外のページ

SAFE TOOLS の棚に載らないページは、`cards.js` を通さず1ページ1スクリプトで
持っている（`generate-job-ogp.js`、`generate-motovlog.js` など）。`cdp.js` は
共有するが、カードの定義はそれぞれのファイルに閉じている。

```bash
node .github/scripts/ogp/generate-motovlog.js   # /motovlog/ の OGP
```

カードの色・書体・グラデーションは `motovlog/index.html` のヒーローと同じ値を
持ち、左肩のマークもページのナビと同じ `images/contents/motovlog-logo.webp` を
読む。ページ側のデザインを変えたらスクリプトも合わせて直すこと。

## アクセントカラーはカテゴリで決まる

`cat` は `data/tools.json` の `category` と一致していなければならず、
`generate.js` が起動時に照合して食い違えば止まる（`imageUrl` の綴りも見る）。
カードだけ色が違う、という事故を防ぐため。

使う値は `tools/assets/tools-ui.css` の **ライトテーマ側**。SAFE TOOLS のトップページと
同じく白を基調にし、カテゴリ色はページ上のバッジや操作色と一致させる。

| category | カード上のアクセント |
|---|---|
| `converter` | `#0F766E` |
| `optimizer` | `#0369A1` |
| `editor` | `#4F46E5` |
| `generator` | `#C026D3` |

## QR Palette の図版だけは実物

`assets/qr-artwork.png` は、ツール本体と同じ描画エンジンで作る**読み取り可能な QR**。
CSS で似せて描くと「QR に見える絵」になり、共有された先でスキャンできない。

このカードを触ったあとは必ず `verify-qr.js` を通す。3つとも
`https://tk.st/tools/qr-palette/` にデコードできれば OK。

図版を差し替えるときは `generate-qr-artwork.js` を実行する。背景は透過なので、
カードの台紙の色が変わっても馴染む。

## 生成 HTML をリポジトリに置かない理由

`generate.js` はテンプレート HTML を OS の一時ディレクトリに書く。sitemap の
ワークフロー（`.github/workflows/sitemap.yml`）が `*.html` を拾うため、
リポジトリ内に置くとテンプレートが sitemap に載ってしまう。

このディレクトリが `.github/` の下にあるのも同じ理由で、Cloudflare Pages は
ドット始まりのディレクトリを配信しないので、スクリプトが CDN に出ない。
