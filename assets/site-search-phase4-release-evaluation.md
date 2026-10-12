# サイト内検索 Phase 4 公開評価

実装済み（2026-10-12）。正本はコード。404・日刊2誌・tools・gameの文字／読み検索①とJev検索②を共通ロジック・UIに統一して公開した。tools/gameの②は同じ一覧の候補をWorker側で絞って判定する。入力・絞り込み・並べ替え・追加表示では送信せず、Enter／検索ボタンでだけ送信する。版ずれの基礎／読みデータ復帰は1画面1回、②の自動再送はしない。

## 公開版

| 対象 | 確認した版・日時（UTC） |
| --- | --- |
| 実装を公開したGit | `c1142b344864246bd7982b602c0dfd12003a80b4`。その後botの`10087b7e`（sitemap/dateModified）を取り込み、公開記録を追加 |
| Pages | `1760c14b-80b8-44a0-8b6f-43ea7e998a36`、main、2026-10-12 00:53:27公開完了。公開URLはhttps://tk.st/ |
| Worker | `bd73301e-c07b-4a3d-90e3-eb3cab1d8803`、2026-10-12 00:57頃。`POST /search/api/rank`、有効scope `site,nitori,retail,tools,game` |
| 共通ファイル | 3ライブラリ・解析Worker `20261012_5`。共通CSS／従来通信部品 `20261011_1`。Git blobと本番の6ファイルの生バイトSHAが一致 |
| 出荷 | 678ファイル。サイト96ページ・tools9件・game8件・日刊ニトリ197記事／リテール214記事。全年度の読みmanifestとsource SHA／ID順を照合 |

[公開バイト列・索引の記録](../.github/site-search/phase4/release-bytes-20261012.json)には共通6ファイル、取得した基礎索引・読み・manifestのSHAとbytesを記録。全題名とDJ／Thought／思索／人類踊狂計画の①、深い存在しないパスのHTTP404を確認した。正本一覧・記事JSONは直接編集していない。最新mainの20261012号を保持し、61号の共通参照を生成器で更新した。公開後botのdateModified同期（20261011号2誌とポータル）も取り込み、手動生成による保存とbotの後続更新を区別する。

## ビルド・回帰・速度

[最終Linux検証 38189518864](https://github.com/tk33r1/st/actions/runs/38189518864)（5087dcb3）は、固定依存の冷／温取得、出荷、Python6件、Node211件、読み・5画面・共通UI・旧HTML・320/768/1440px／CSS200%／焦点／通知・正式速度測定をすべて通過した。最初の合格実行38188586608も保持し、最速の実行だけを選ばない。最終実行の[環境](../.github/site-search/phase4/linux-environment-release-20261012.json)、[共通UI](../.github/site-search/phase4/ui-release-linux-20261012.json)・[実adapter](../.github/site-search/phase4/ui-adapter-release-linux-20261012.json)を保存した。

固定fixture・CPU4倍抑制・20入力×5・3回、監視なし。Windows／Linuxとも100入力p95は50ms以下。共有／別語彙10kでWindowsの最大40.2ms、初回Linux最大29.3ms、最終Linux最大24.1ms。実日刊adapterの大きいケースは本文を保持した7,500件で、8MiB上限を変えず、10kと偽らない。準備はWindows約2.7〜2.9秒、初回Linux約3.1〜3.3秒、最終Linux約1.9〜2.2秒。固定fixtureと共通6ファイルのhashはOS間で一致する。

最終Linuxの冷取得1.847秒・温取得0.243秒、出荷10.341秒／ピークRSS411.7MiB。初回Linuxは5.885／0.848／14.320秒、RSS408.5MiBで、過去の値も残した。LinuxのRSSは各処理と子孫の最大で、同時プロセス合計ではない。実Pagesのpreviewと本番でもビルド成功したが、PagesそのもののRAMは取得していない。[詳細な実装・測定記録](../.github/site-search/phase4/implementation-progress.md)。

## 実Jevと本番画面

公開前に新入口をWorkerへ先行配置し、tools/gameは一時評価キー付きに限定。普通の要求はdisabled、不正filtersは400、世代不一致はindex_updatingで判定前に停止した。固定finalの各20問を本番入口で1回ずつ実行して合格した。

| scope | 正解の上位5件到達 | 必須候補到達 | 正解なしの誤表示 | Worker往復p95 |
| --- | --- | --- | --- | --- |
| tools | 11/11 | 10/10 | 0/9 | 307.5ms |
| game | 13/13 | 9/9 | 0/7 | 293.2ms |

[固定40問の本番記録](../.github/site-search/phase4/rank-publication-20261012.json)。候補到達は100%、scope／filters外の表示・判定欠け・失敗は0件。固定80問の直接Jev各2回とsmokeは[別記録](../.github/site-search/phase4/rank/README.md)で、tools 0.4/revision 1・game 0.5/revision 2を維持した。game-final-17に続編が混ざる限界は残る。注釈はAPIより前にエージェントが付け、本人は未確認。本番入口はusage・モデル実版を返さないため、本番の請求額／モデル実版を直接APIの値で代用しない。

公開後の[本番ブラウザ検査](../.github/site-search/phase4/url-production-20261012.json)で5scopeを各1回実検索し、すべてcomplete=trueの結果を表示。旧入口も3scope各1回が合格し、旧入口のtools/gameは400を維持した。[旧契約の本番記録](../.github/site-search/phase4/legacy-production-20261012.json)。本作業の共有回数枠への要求は固定40＋公開5＋最初の中断実行1＋旧入口3＝49件。最初のブラウザ実行はsiteだけ完了してURL検査で停止した記録も[保持](../.github/site-search/phase4/url-production-first-attempt-20261012.json)。キャッシュでも回数を数えるため、この数を有料Jevの実呼出数や請求額と呼ばない。

実接続で `cache:'no-cache'` の互換フラグ不足を検出し、互換日付2025-01-01は維持して本番とevalに `cache_no_cache_enabled` を追加した。[Cloudflareの互換フラグ仕様](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-cache-no-cache-http-standard-api)。修正前のindex_updatingは索引取得前後の停止で、精度評価の成功や有料判定には数えない。診断コードを除去した正本へ戻して公開した。

## URL・計測・停止と復帰

本物のGTM／gtag／Ahrefsを取得し、計測送信は観測してから停止した。入力・sort・filtersはPOSTゼロ、明示操作だけ1回、再読み込みで条件を持ち越さず、受け渡しと不正値を計測より前にURLから除去。検索語は外部のURL／Referer／計測本文（許可した伏せ字済みGA4 search_termを除く）へ載せず、メール／電話の伏せ字、自動view_search_resultsなし、検索イベント停止を確認した。tools/game/404の解析停止はタグ読込も止める。日刊の既存設定は検索イベント停止で、タグ読込停止の保証へ広げない。

旧 `?q=` URLで開く要求自体は既にtk.stへ届く。同一サイトのCloudflare `GET /cdn-cgi/speculation` のRefererが初期URLを持つ例を12件観測し、外部計測とは区別した。これはPhase 3の検査も区別していた範囲。今回の除外は同一サイトのGETの固定パスのRefererだけで、URL／本文・外部通信・Cloudflare Web Analyticsは検査対象に残す。previewだけの成功を本番の合格に転用しない。JS無効でも404ツリーを開閉・移動でき、日刊ヘッダーの入力をURLへ載せないことを確認した。

実Workerでtools/gameだけを一時停止し、両画面でdisabled／searched=null、①の文字・読み結果を維持、確定操作の重複送信なしを確認して5scopeへ戻した。[停止検査](../.github/site-search/phase4/scope-stop-20261012.json)。初回の検査は明示検索で既に開いた全候補のボタンを待ったため補助スクリプトを修正し、製品コードは変えず再確認した。

Pagesは上記公開版から旧正常版1b6f8ba5へ実際にrollbackし、旧画面を観測してから新版1760c14bへ復帰。00:55:56〜00:56:03 UTCに両版のHTTP200と画面を確認した。[復帰記録](../.github/site-search/phase4/pages-rollback-20261012.json)。[Cloudflareのrollback API](https://developers.cloudflare.com/api/go/resources/pages/subresources/projects/subresources/deployments/methods/rollback/)。

一時評価変数・SITE_RANK_EVAL_KEY・診断コードを本番から除去し、手元の一時キーファイルと診断の生ログも削除した。既存AIキー／DB／通知設定は維持。最終設定はwrangler.tomlの5scope、2つの互換フラグ。実URL検査は `node .github/scripts/test-site-search-ui.mjs --base https://tk.st`、実②5回も行う場合は `--live`。停止確認は運用側でscopeを外した後、`node .github/scripts/test-phase4-scope-stop.mjs --expect-disabled` を使い、検査後に正本を再デプロイする。公開バイト確認は `node .github/scripts/verify-phase4-release.mjs`。

## 残る確認と既知の限界

- OSの日本語IME、NVDA／VoiceOver、Safari／iOS／Androidの実機は未検証。ChromiumのCDP preedit→確定Enter、キーボード、CSS200%は代用とはしない。実機環境を使う確認が残る。
- Windowsの初回20入力だけでは10kが54.1／55.7ms、7,500件が61.6／59.1ms。正式100入力p95の合格と分ける。準備中には実adapterで最大約0.222秒の停止が残る。
- 読みfinalは29/30（96.7%）。分割された複合語の読み、未知語、gameの余分な候補など、評価に記録した限界を残す。補正は空で、本人による正解注釈の確認は未実施。
- 解析検査は合成文字列・Chromiumでの送信遮断付き観測。OS／拡張機能／将来のGTM設定変更までの保証ではない。
