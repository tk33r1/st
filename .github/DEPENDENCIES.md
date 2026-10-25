# 依存関係の更新・脆弱性監視

`dependency-watch.yml` が毎日09:17 JSTに監視し、`dependabot.yml` が毎週月曜に更新PRを作る。
GitHub Actionsの定期実行は遅れることがある。既定ブランチへ取り込むと有効になる。
手動確認はActionsの **Dependency Security Watch → Run workflow**。

## 監視範囲

| 対象 | 毎日の照合 | 更新候補 |
| --- | --- | --- |
| Node.js | `.node-version` と公式リリース一覧を比較。同じメジャーの更新、途中のセキュリティ修正、サポート終了90日前・終了済みを検出。4か所のenginesとの整合も確認 | Issueで通知。メジャー移行先は人が決める |
| npm 4か所 | `package-lock.json` の直接・間接・開発・OS別依存をOSVへ照合 | Dependabotの週次PR。minor/patchをまとめ、majorは個別 |
| 同梱ライブラリ | `assets/vendor/SOURCES.json` のパッケージ名と版、`magi-app/www/vendor/SOURCES.json` のReadabilityをOSVへ照合 | Issueから従来の取り込みスクリプトで対応 |
| 固定Python依存 | `search-reading-requirements.txt` の固定した版をOSVへ照合 | Dependabotの週次PR（wheelのhashもレビュー） |
| GitHub Actions | Dependabotで更新確認 | 週次PR |
| Android Gradle | Dependabotで更新確認 | 週次PR。実機・ビルドの確認が必要 |

照合だけなのでnpm install・依存のスクリプト・ビルド・有料AI呼び出しは実行しない。
OSVへ送るのはパッケージ名と版だけ。GitHub tokenやソースコードは送らない。
ネットワーク・応答形式・ファイルの解析に失敗したときは、検査エラーをIssueに残してActionsも失敗させる。
PRではネットワークなしの監視器テストだけを行い、Issue書き込み権限のあるジョブは実行しない。

## 通知とGitHub設定

対応候補または検査エラーがあると、`依存関係の更新・脆弱性の確認` というIssueを1件作る。
内容に変化があったときだけ本文とコメントを更新し、同じ指摘で毎日通知しない。
全検査が成功して対応候補がなくなったら閉じる。未解決のまま手動で閉じると次回は新しいIssueになる。
全件のJSONはActionsのartifactに30日保存し、要約は実行画面にも残す。

GitHubの **Settings → Advanced Security**（画面によっては **Code security**）で
Dependency graph・Dependabot alerts・Dependabot security updatesも有効にする。
これらの有効化は設定ファイルだけでは保証できない。security updatesを有効にすると、週次の版更新とは別に
既知の脆弱性の修正PRが作られる。通知先・メール配信はGitHubのWatch/Notifications設定に従う。
この仕組みは自動マージ・mainへの直接コミット・Workerの自動デプロイを行わない。

## 更新手順

1. Node.jsは同じメジャーの最新版を確認し、`.node-version`、4か所の`package.json`と`package-lock.json`の
   `engines.node`をそろえる。Cloudflare Pagesに`NODE_VERSION`を設定していればそちらも合わせる。
   開発PCのNode.jsも別途更新して`node --version`を確認する。
2. npmのPRは変更先に応じた構文・ビルド・動作確認を行う。MAGIの依存更新で画面の版番号を勝手に上げない。
   Capacitorの関連パッケージは互換性を確認し、APKを配る場合は既存のリリース手順に従う。
3. 同梱ライブラリは`.github/scripts/vendor/fetch-vendor.js`の`LIBS`を更新して取り込み、
   SOURCES・CSP用パッチ・利用側のパスとキャッシュ版を一緒に確認する。取り込み後に`--check`も通す。
   ReadabilityはMAGIアプリの取り込み手順に従う。
4. 再実行して解消を確認する。修正版がないもの・使っていない機能だけのもの・既存の対策が効くものは、
   影響と判断の根拠をIssueへ残す。指摘は自動で無視しない。

## 限界

既知のアドバイザリと版の照合であり、攻撃できることを確認した結果ではない。
OSVに未登録の脆弱性、同梱wasm内部のC/C++ライブラリなどnpmの版と結びつかないもの、
CDNから直接読むライブラリ、OS・ブラウザ・Java・開発PCのインストール状態は対象外。
Androidの間接依存全体や、workflowが実行時に入れる未固定のPillow等も日次照合には含まない。
GitHub Actions内部のNode.jsは`setup-node`とは別なので、Action本体の更新PRも確認する。
Node.jsのチェックは公式メタデータのsecurity印を使い、各CVEの影響を個別評価しない。
公開リポジトリは長期間操作がないと定期workflowが停止することもあるため、Actions画面の稼働状態も確認する。

## ローカル確認

```sh
node --test .github/scripts/dependency-watch.test.mjs
node .github/scripts/dependency-watch.mjs
```

後者は公式Node.jsデータとOSVへ通信し、結果を表示するだけでIssueやファイルを変更しない。
検査エラー時は終了コード1、検査成功時は対応候補の有無にかかわらず0。
`DEPENDENCY_REPORT`を指定すると、そのパスへJSONも保存する。

根拠: [Node.js公式リリース一覧](https://nodejs.org/dist/index.json)、
[公式サポート予定](https://github.com/nodejs/Release/blob/main/schedule.json)、
[OSV API](https://google.github.io/osv.dev/post-v1-querybatch/)、
[Dependabot設定](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)。
