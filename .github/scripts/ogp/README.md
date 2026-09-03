# OGP カード生成

`images/ogp/*-ogp.{png,webp}` を作り直すスクリプト。ヘッドレス Chrome に
1200×630 の HTML を描かせて dsf 2 で撮り、2400×1260 の画像として書き出す。

依存パッケージなし（Node 組み込みの `WebSocket` で CDP を直接叩く）。Node 18 以上。

## 使い方

```bash
node .github/scripts/ogp/generate.js              # 全部
node .github/scripts/ogp/generate.js light-svg    # 1枚だけ
node .github/scripts/ogp/generate.js --check      # 検査のみ、書き出さない
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
| `verify-qr.js` | QR Atelier のカードに入っている QR が実際にデコードできるか検査 |
| `assets/qr-artwork.png` | QR Atelier の図版（後述） |

ツールを増やすときは `cards.js` に1エントリ足す。

## アクセントカラーはカテゴリで決まる

`cat` は `data/tools.json` の `category` と一致していなければならず、
`generate.js` が起動時に照合して食い違えば止まる（`imageUrl` の綴りも見る）。
カードだけ色が違う、という事故を防ぐため。

使う値は `data/tools-ui.css` の **ダークテーマ側**。カード自体が暗いので、
ライト側の値（`#0F766E` など）だと沈む。

| category | カード上のアクセント |
|---|---|
| `converter` | `#2DD4BF` |
| `optimizer` | `#38BDF8` |
| `editor` | `#818CF8` |
| `generator` | `#E879F9` |

## QR Atelier の図版だけは実物

`assets/qr-artwork.png` は、ツールが実際に書き出した**読み取り可能な QR**を
切り出したもの。CSS で似せて描くと「QR に見える絵」になり、共有された先で
スキャンできない。

このカードを触ったあとは必ず `verify-qr.js` を通す。3つとも
`https://tk.st/tools/qr-atelier/` にデコードできれば OK。

図版を差し替えるときは、ツールで QR を書き出して背景を透過させた PNG を
`assets/qr-artwork.png` に置く（背景が透明なら台紙の色が変わっても馴染む）。

## 生成 HTML をリポジトリに置かない理由

`generate.js` はテンプレート HTML を OS の一時ディレクトリに書く。sitemap の
ワークフロー（`.github/workflows/sitemap.yml`）が `*.html` を拾うため、
リポジトリ内に置くとテンプレートが sitemap に載ってしまう。

このディレクトリが `.github/` の下にあるのも同じ理由で、Cloudflare Pages は
ドット始まりのディレクトリを配信しないので、スクリプトが CDN に出ない。
