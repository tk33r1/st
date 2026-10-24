# Node.js の使用箇所と更新

2026-10-24 点検。

PHP のソース、Composer の設定、PHP 実行環境の指定はリポジトリにない。
本文や出典にある外部サイトの `.php` URL は、このサイトの PHP 実装ではない。

Node.js は次で使う。

| 場所 | 用途 |
| --- | --- |
| `game/reverse-recaptcha/` | Vite + React の開発と静的ファイルのビルド。Pages の `build.sh` からも実行 |
| `workers/` | Wrangler による開発・バンドル・デプロイ。本番 API の実行環境は Cloudflare Workers |
| `magi-app/` | Capacitor の同期、アイコン生成、PWA のローカル配信 |
| `.github/scripts/` と Actions | 検証、OGP 生成、MAGI の素材抽出、各種運用 |

## バージョン指定

基準は Node 24 LTS。ルートの `.node-version` を Cloudflare Pages と Actions の
`setup-node` が読む。MAGI の候補検証だけは、信頼するチェックアウトの
`trusted/.node-version` を読む。各 `package.json` の `engines.node` に最低版を記す。

今回の指定は 24.22.1（10月21日のセキュリティ更新）。ローカルにインストールされた
Node 自体は、このリポジトリの変更だけでは入れ替わらない。
Pages の管理画面に `NODE_VERSION` がある場合も、同じ版にそろえる必要がある。
Pages の管理画面に Node の上書き指定がないことを確認済み。本番ビルドへの反映は公開時に確認する。

- Node のリリース: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
- Pages の指定方法: https://developers.cloudflare.com/pages/configuration/build-image/

## 依存更新と検証

- Vite 5.4.21 → 8.3.5、React プラグイン 4.7.0 → 5.2.0。
  React 18 と Tailwind 3 は維持し、ビルド対象ブラウザも Vite 5 の値を明示して維持。
- Wrangler 4.147.0 → 4.152.0。
- MAGI は主要パッケージの固定版を維持し、間接依存を互換範囲内で更新。
- Node 24.22.1 で上記3パッケージの `npm ci`、MAGI 音声プラグインのパッチ適用が成功。
- ゲームの本番ビルドとブラウザ確認が成功。更新前後の見出し・入力・ボタンの
  寸法と文字サイズが一致し、名前入力から第一関門へ進めることを確認。
- 全7 Worker の `wrangler deploy --dry-run` が成功。本番の変更は行っていない。
- 外部 API を呼ばない MAGI 回帰テスト361件が Node 24.22.1 で成功。
- workflow の YAML と manifest/lock の整合を確認。

公開対象の main ベースでサイト全体の `build.sh` が成功（公開ファイル737件）。`NODE_VERSION` の上書き指定がないことも確認済み。GitHub Actions 上の実行、Android APK の再ビルドは未実施。

## npm audit の残件

最新版への更新だけでは解消しない開発用依存がある。2026-10-24 の再検査結果は以下。
件数は advisory の数ではなく、親への波及を含む npm audit の該当パッケージ数。

| パッケージ群 | 残件 | 主な依存経路 |
| --- | --- | --- |
| workers | high 1、moderate 2 | 最新 Wrangler → Miniflare → Undici 7.29.1 |
| reverse-recaptcha | moderate 3 | Tailwind 3 / postcss-nested → postcss-selector-parser 6 |
| magi-app | critical 1、high 3、moderate 3 | アイコン生成器の旧 Capacitor CLI → tar 6、sharp 0.32、および xcode → uuid 7 |
| 検証用 Playwright | 0 | — |

`npm audit fix --force` による CLI のダウングレードや、間接依存の強制差し替えは行っていない。
Tailwind 4 への移行は CSS の互換性確認、アイコン生成器の変更は Android/PWA アイコンの
生成確認を伴うため、個別に扱う。
