# 日刊②：Phase 3 T11の精度評価

実施済み（2026-10-09）。設定の正本はコード。日刊②の有効化・本番ブラウザの応答時間測定は未実施。

日刊ニトリとリテールテックの固定セットを、媒体ごとにtune30問・final30問、各2回測定した。両媒体のfinalは各回とも[検証計画書](site-search-phase3-verification.md#31-合格条件)の精度・誤表示・候補recallを満たした。閾値0.4・候補20件・revision 2を維持する。

## 対象と手順

- 測定コード：`0f64b809561989d53b33e55ab942e2d172b2ec51`。全4測定は変更のない同じコード・設定で実行。
- 索引：`--index-set terms`。nitori176記事・retail204記事。保存済みの全年度は2026年のみ。複数年度の精度を実測したとは扱わない。
- 固定120問はT09でCodexがAPIの結果を見る前に題名・要約を根拠に正解を付けた。本人による正解の確認は未実施。各splitは答えあり24問・答え無し6問。固定日・元コミット・各索引の来歴は[fixtureの手順](../.github/site-search/fixtures/phase3/README.md)と[補完後の手順](../.github/site-search/fixtures/phase3/with-search-terms/README.md)にある。
- CLIは固定した全年度の索引をWorkerの関数で検査し、filters・20候補・変換・問い・確率・閾値・並び・結果を同じ処理で評価する。Jevを直接呼び、本番Workerの回数・キャッシュ・D1は使わない。
- 送るのは固定した合成検索語・言語と、公開記事の題名・要約・カテゴリー・タグ・地域。URL・日付のフィールド・takeaway・source・search_termsはJevに渡さない。検索用の語は候補選びにだけ使用。
- tuneでは0.3・0.35・0.4・0.5・0.6を比較。同じ実応答を再生し、閾値ごとの追加API呼び出しはしない。事前に「両回で基準を満たす現在の0.4を優先して維持する」と固定した。両誌のtune後、finalの開始前に閾値0.4を保存した。
- finalは固定した設定で全30問を2回測定し、失敗や候補からの取りこぼしを分母から除外しない。finalの結果に合わせて問い・正解・索引・補完語・閾値は変更していない。

実行は18:38〜18:41 JST。応答のモデルは全240要求で`jev-1.13.0`（送信時のaliasは`jev-latest`）。HTTPは全件200、モデル版・usageの欠落は0件。全応答のN/M/Jとgenerationが対象・候補・判定件数と一致し、失敗・不完全な判定は0件だった。

## tuneと設定の固定

上位5件に少なくとも1件の正解が入った数（各24問）。全閾値・全回で答え無しの誤表示は0/6、候補recallは24/24。

| 閾値 | nitori 1回目 | nitori 2回目 | retail 1回目 | retail 2回目 |
| --- | ---: | ---: | ---: | ---: |
| 0.3 | 24 | 24 | 24 | 24 |
| 0.35 | 24 | 24 | 24 | 24 |
| **0.4** | **24** | **24** | **24** | **24** |
| 0.5 | 24 | 24 | 23 | 24 |
| 0.6 | 24 | 24 | 23 | 23 |

現在の0.4が両回とも合格したため維持。finalの前に設定を固定し、コードの変更は不要だった。

## finalの結果

| 媒体 | 回 | 上位5件に正解 | 答え無しの誤表示 | 候補20件に正解 | 失敗 / 不完全 | 精度の合否 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| nitori | 1 | 23/24（95.8%） | 0/6（0%） | 23/24（95.8%） | 0 / 0 | 合格 |
| nitori | 2 | 23/24（95.8%） | 0/6（0%） | 23/24（95.8%） | 0 / 0 | 合格 |
| retail | 1 | 22/24（91.7%） | 0/6（0%） | 23/24（95.8%） | 0 / 0 | 合格 |
| retail | 2 | 22/24（91.7%） | 0/6（0%） | 23/24（95.8%） | 0 / 0 | 合格 |

各回を別々に判定した。平均による合格ではない。「上位5件に正解」は問い合わせ単位の割合であり、表示する全記事が正しい割合ではない。

既知の取りこぼしはnitori-053とretail-048（候補外）。retail-033は正解が候補にあるものの、Jevの確率が1回目0.19・2回目0.22で閾値に届かなかった。いずれも失敗の分母へ含めている。これらに合わせて候補や問いを調整する場合は、現在のfinalをtuneへ移し、新しいfinalを用意する。

Jev単体のfinal p95はnitori196.6ms / 210.1ms、retail232.2ms / 201.1ms。これはブラウザ→本番Worker→索引→Jev→応答本文の経路を測っていないため、1.5秒の合格には使わない。

## 費用と公式情報の確認

事前見積もりは計240要求・約$0.2429（payloadのUTF-8バイト数を入力トークン数と置いた概算）。実応答のusageは入力2,147,396トークン・出力85,812トークン。確認した入力単価$0.042/Mtoken・出力無料で計算すると約**$0.0902**。請求書やアカウント残高での照合は行っていない。

2026-10-09に[モデル・単価・上限](https://docs.typesafe.ai/models)と[API](https://docs.typesafe.ai/api)を再確認。公開aliasは`jev-1.13.0`を指し、64k/request・stateと最長の問いで32k、80 requests/s・100k tokens/s。[規約](https://docs.typesafe.ai/legal)、[プライバシーポリシー](https://typesafe.ai/legal/privacy-policy)、[データ処理契約](https://typesafe.ai/legal/data-processing)も再確認した。入力で学習しない、保持期間は固定の期間の明示なし、ZDRは企業契約という既存の説明を維持する。

## 固定した版と証跡

全測定のquery_hashは`07d2868bce1e6df80243f456812f39242bdd31847718c3c3e553b110b8617a82`、code_hashは`b563868d031ee59efe7998fb164bf49ea80e8d0bda02fee63b7baf75c5b22cc7`、config_hashは`e965befe7f77b181616ade8603a0b5f7cfe249344d074f33d83946dd6c4a2df6`。全4測定で一致。補完規則のSHA-256は`6edde2f834cc470b146466b930cd508bb0be74e1f3b052d3d4682e3f1c3ee493`。

| 媒体 | generation | index_hash | candidate_hash |
| --- | --- | --- | --- |
| nitori | `021c767db6e4df27` | `b2f55a85e41a780780965e11777aafb6f3f4aa6cb5ba947acacdfd0a5415e132` | `db605b91262402a1d263d3e76967b365f1bfdf95ede8e33191026ee1f6c7effc` |
| retail | `13d28fe0e9fcb24d` | `71d1dae64cd6b8d8efcb1f4cdaa9a1fabaab80a737852c31dfafb87c901f53da` | `2cf3b6417fe718c843c75c3afa0d4e0946e5dc0f1a2ac69e543dbab6dfaf5ab5` |

生の記録は以下の非追跡ファイルに保存。本文・確率・usage・候補ID・設定のhashを保持しており、APIを呼び直さず`--report`で集計し直せる。

| `workers/.wrangler/`内のファイル | SHA-256 |
| --- | --- |
| `daily-rank-accuracy-nitori-2026-10-09T09-38-54-412Z.json`（tune） | `088d2a69cc4cc43ef9e59bee7e581161ec5965d911665042dd7517c65f270b0c` |
| `daily-rank-accuracy-retail-2026-10-09T09-39-42-240Z.json`（tune） | `8853905a3b89a675deea56ab1e5d31cef883d5b4be00270778e7d2b8c4e9cc38` |
| `daily-rank-accuracy-nitori-2026-10-09T09-40-58-882Z.json`（final） | `fb6622fd9947d6a5c74222ca5ffc875bbc3c7fcad1329080f82165deb8beb2d5` |
| `daily-rank-accuracy-retail-2026-10-09T09-41-45-662Z.json`（final） | `0916ca7db8f0f13645d6251c574875ec42551c64175dcdae0fbe26ada39773eb` |

実行前の方針とfinal開始前の閾値固定は`t11-protocol.json`、集計と照合結果は`t11-summary.json`、CLIの表示は`t11-*-tune.log`・`t11-*-final.log`に保存。

T11は両媒体の精度評価が完了。次はT12の本番ブラウザからの速度・切断の測定。本番の`SITE_RANK_SCOPES="site"`は維持し、日刊②の利用者向け公開はT12・T13の合格後に行う。
