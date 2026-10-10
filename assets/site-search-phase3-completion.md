# サイト内検索 Phase 3 完了記録

実装済み（2026-10-10）。正本はコード。本書は日刊2誌の②の公開版と確認結果を固定する。評価条件は[公開前評価](site-search-phase3-release-evaluation.md)、前日のニトリの速度は[ニトリ測定記録](site-search-phase3-timing-nitori.md)。

## 公開版

本人の「別UTC日になったと思うので、残りを進めて」の指示に沿ってT12リテール・T13両誌の公開・T14を実施した。最新botコミット`160cccc4`を取り込み、索引の追加10記事を確認してから固定・精度再評価した。

| 対象 | 版・状態 |
| --- | --- |
| 最新索引と評価CLI | `1ec69b1f2cdbbf750666fe9a2d34eb124bc78f83`。固定索引は`publications/20261010/` |
| 公開設定・運用文書・本番UI試験 | `45a15d338e5c7bb69eb3207ed06c76a3f2a9d164` |
| 一般公開のWorkerデプロイ | `68649313-47a5-4092-a088-a2f1ef0b225d`。225.56KiB、gzip 63.39KiB |
| 評価secret削除後の有効Worker | `8a195140-eb95-4f95-ba18-14ee83dd47f6`。2026-10-10 03:33:07 UTC（12:33:07 JST）に100%へ反映 |
| 検証したPages | `160cccc4`、Deployment `37354525-56da-48db-aa6d-ae4539dc104d`、Production/main |
| 本番設定 | `SITE_RANK_ENABLED=true`、`SITE_RANK_SCOPES="site,nitori,retail"`。`SITE_RANK_EVAL_SCOPES`なし |
| 評価用キー | `SITE_RANK_EVAL_KEY`の削除をsecret一覧で確認。手元の一時キーファイルも削除 |

DB・ルート・既存siteの設定を保持。共通JS・CSS・HTML・テンプレートは変更しておらず、既に公開された画面をWorkerの媒体設定で有効化した。JS参照はdaily-ui `20261009_5`・site-search `20261009_4`のまま。AGENTS・JEV・magi2 READMEを公開前に更新した。今回の資料と評価CLIのpushによるPages更新には、画面や索引の変更は含まれない。

## 一般公開後の確認

2026-10-10 03:36:38 UTC（12:36:38 JST）までに、本番の両ポータルで評価キーなしの実検索を各1件確認した。両誌ともHTTP 200・results・complete=true・cached=false、最新索引のgenerationと一致。入力中の送信なし、APIのRefererなし、検索語をURLへ残さない。

| 媒体 | 記事数 | generation | request_id |
| --- | ---: | --- | --- |
| nitori | 184 | `342e37c82e45fa11` | `faf3e000-8113-4c8c-8f0e-48fefc3fcf9a` |
| retail | 206 | `3532957787af2d77` | `64214519-a464-488c-ab41-3061279e451b` |

本物のGTM・Ahrefsが読み込まれ、両誌のdataLayerにdaily_search・daily_rank_run・daily_rank_resultが出た。この2要求の短時間の記録では、GA4向け通信はpage_view・form_startだけを観測した。公開後にタグの初期化を待ち、本番URL・実計測スクリプト・模擬日刊応答で別に確認すると、両誌ともGA4向け通信にdaily_search・daily_rank_run・daily_rank_resultが載った。実Workerへの追加送信は0件。この通信確認と実検索2件の観測は混同しない。計測の通信は記録してから遮断しており、GA4管理画面での受信照合ではない。

## 合格の証跡

- 精度：今日の390記事を固定し、両誌tune/final各2回の計240要求。閾値0.4・revision 2を保持。各finalはnitori23/24・retail22/24、誤表示0/6、候補recall23/24、失敗・不完全0。使用量から約$0.0900。
- 速度：ニトリの前日の176記事は各回p95 415.6ms・620.7ms、リテールの今日の206記事は431.2ms・292.2ms。各媒体48/48正常・キャッシュなし・版とhash一致。最新ニトリ184記事について48要求の速度測定を再実施したとは扱わない。
- 切断：本番の入力変更で両誌の要求を中断し、tailのcanceledを確認。Worker内の経過はニトリ81ms・リテール73ms、判定J未確定、古い結果の描画なし。索引取得中の切断は前日のニトリ、abortと通知期限は模擬Workerでも確認。本番の通知メールは故意に発生させていない。
- 停止・復帰：リテール停止中の開いたタブでdisabled・①利用可能、ニトリ②正常。復帰して再読み込み後にリテール②正常。切替直後の最初の不成立を保持し、設定版を照合して30秒の反映猶予を空けた再検証が通った。
- 回帰：Worker151件、評価CLI25件、本番URLと本物のGTM・Ahrefsを使う公開前の画面101場面が通過。公開後も日刊②の42場面が通過し、別にタグ初期化後の両誌のGA4向け通信を確認。
- privacy：公式契約とダイアログの学習・保持・処理地の説明を再照合。メール・電話番号の合成例の伏せ字、クリックへ検索語を付けないこと、URL・参照元・外向き通信、計測停止を確認。SAFE TOOLSのCSP・Clarityの扱いは変更なし。

T12リテールの速度測定は48要求＋疎通2件の50要求で終了。T13の既存site疎通・実画面・切断・停止復帰・一般公開後の確認を合わせた共有カウンタは、同日のclient最大59・global59。速度の追加測り直しはせず、一般公開後の確認を終えて課金APIの検証を終了した。

## 記録と限界

生の成果物は非追跡の`workers/.wrangler/`へ保存。公開版・secret・Pages・匿名カウンタは`t13-final-deployments.json`・`t13-final-version.json`・`t13-final-secrets.json`・`t13-pages-before-push.json`・`t13-quota-final.log`。検索語やキーを本書へ転記していない。

| 確認記録 | SHA-256 |
| --- | --- |
| `t13-public-daily.json` | `acc1d39ea6677f033e8675b411da28f38dec5fa3d67c2e553cf40eb65b75b5f3` |
| `t13-public-analytics.json`（03:41:26 UTC） | `fc5682ce9077410794f59fbb666427dfad7ba184c2f3c5a81d496fdead9f378e` |
| `t13-stop-live-retry.json` | `b65f009430561597b89250a063db97143669f776aaecaf28d3f23b862974e244` |
| `t13-live-tail-sanitized.json` | `17856735577411b257e93501bade138311a329281f17266a0874319f918c2f55` |

Safari・iOS・Androidの実機は未確認。Chromiumの合成IME・キーボード・320px・暗い配色の検証を実機確認に置き換えない。固定セットは正解を結果に合わせて変更していないが、今日の更新は独立したholdoutではなく公開索引に対する回帰評価。実複数年度の精度や、本番の通知障害を起こした確認も未実施として保持する。
