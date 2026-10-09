# Phase 3 T12 ニトリの本番測定記録

測定済み（2026-10-09）。本記録はこの日の結果を固定する。コードの正本は実装。リテールの測定とT13の公開判断は別作業。

## 結果

本物のChromiumから本番Workerへ固定24問を2回送信し、送信開始から本文のJSON読み取りまでを測り、応答を検査した。両回ともキャッシュなしのp95が1,500ms以内。48件すべて正常で、generation・ハッシュ・Worker版が一致した。日刊②の一般公開は停止を維持している。

| 指標 | 1回目 | 2回目 |
| --- | --- | --- |
| 開始（UTC） | 2026-10-09 10:04:12.990 | 2026-10-09 10:15:40.001 |
| 終了（UTC） | 10:04:20.394 | 10:15:47.867 |
| 件数・正常終了 | 24/24 | 24/24 |
| p50 | 243.7ms | 259.4ms |
| p95（昇順23番目） | 415.6ms | 620.7ms |
| 最大 | 708.4ms | 658.5ms |
| 失敗・timeout・不完全 | 0・0・0 | 0・0・0 |
| cached=false・generation一致 | 24/24 | 24/24 |
| 参考の上位5件の正解 | 18/18 | 18/18 |
| 参考の答えなしの誤表示 | 0/6 | 0/6 |

1回目の終了から2回目の開始まで679.607秒。10分のキャッシュ期限に1分以上の余裕を空けた。速度用24問はT09でfinalから固定済みで、結果を見て選び直していない。参考精度は[T11のfinal全30問](site-search-phase3-evaluation.md)の合否を置き換えない。

## 条件

- 実装コミット：`31578bd13dd0e8c4369e3843d39a31fe1dfa8256`。両回とも未コミット変更なし。
- 測定Worker Version：`20ea3f24-b662-43ac-b771-aba3220a201a`。
- Chromium：`141.0.7390.37`。Originは`https://tk.st`、宛先は本番の`workers.tk.st/magi2/site-search`。
- `scope=nitori`、`--index-set terms`、revision 2、閾値0.4、候補上限20。176記事。locale・filtersは固定セットの値。
- generation：`021c767db6e4df27`。
- index_hash：`b2f55a85e41a780780965e11777aafb6f3f4aa6cb5ba947acacdfd0a5415e132`。
- candidate_hash：`db605b91262402a1d263d3e76967b365f1bfdf95ede8e33191026ee1f6c7effc`。
- query_hash：`07d2868bce1e6df80243f456812f39242bdd31847718c3c3e553b110b8617a82`。
- config_hash：`e965befe7f77b181616ade8603a0b5f7cfe249344d074f33d83946dd6c4a2df6`。
- code_hash：`e05a98d66eaa83b0c9acc43016fc5d6f02407c0d9f983da557818c2f2a36dccf`。
- terms_source_sha256：`6edde2f834cc470b146466b930cd508bb0be74e1f3b052d3d4682e3f1c3ee493`。

T11から候補・問い・設定・索引のハッシュは変わっていない。code_hashだけは測定用の認可とCLIの変更で変わった。順位付け・候補選び・Jevへ送る内容は変更していない。

モデルの正本は`config/ai-models.json`の`jev-latest`。同日の[公式モデル資料](https://docs.typesafe.ai/models)では`jev-1.13.0`を指し、T11の実応答も全件この版だった。T12の公開応答は解決後のモデルIDやusageを返さないため、T12の実応答からモデル版を確認したとは扱わない。契約は同日の[公式資料](https://docs.typesafe.ai/legal)で再確認した。合成の固定検索語と公開記事を送った。

## 要求数・切断・通知

ブラウザ48件＋疎通2件の計50要求を実施し、追加の再試行は行っていない。事前の保守的な費用見積もりは約$0.0499。公開応答にはusageがないため、実費ではない。事前の共有カウンタは2、終了後は51で、49増えた。切断用要求は索引取得中に終了し、回数の計上より前に止まったことと整合する。カウンタの確認ではIPの値を取得していない。

最初の疎通1件を`--cancel-after 150`で意図的に切断した。ブラウザの記録はtimeoutで不成立のまま保存し、成功数やp95には入れていない。tailでは当該要求IDの実行結果が`canceled`、`site_rank failed unavailable`、Worker内の経過105ms、indexMs・jevMs・N/M/Jが未確定だった。既存コードは内部の`cancelled`を公開の`unavailable`へ変換するので、ログに`cancelled`というreasonは出ない。索引取得中の切断で処理が短時間に終了することを本番で確認した。取得用signalのabort・共有索引を確定しないこと・回数とJevへ進まないことは模擬テストでも確認済み。Jev実行中の切断は本番で追加測定していない。

もう1件の通常疎通は正常で715.3ms、キャッシュなし、版一致だった。疎通の語は速度セット・相互で重ねていない。

通知の期限は`test-magi2.mjs`の模擬Resendで確認した。通信が止まる場合のabort・再試行用の印の解放と、成功応答の本文が止まる場合の本文中止・成功印の保持を含む。本番の課金障害を故意に起こしたり、実メールを送ったりする検証は行っていない。

## 測定用の保護と片付け

測定中だけ`SITE_RANK_SCOPES=site,nitori`、`SITE_RANK_EVAL_SCOPES=nitori`とした。専用secret `SITE_RANK_EVAL_KEY`を持つ要求だけを通す。通常の画面は索引・回数・Jevより前でdisabled。siteとretailの扱いは変えていない。

測定中と片付け後に本番の両ポータルをブラウザで確認した。入力中はAPIを送らず候補を表示し、明示検索の②はdisabled、①の結果は利用可能。連続Enterは追加要求を送らず、URLに検索語が残らない。公開の索引と共通JSは手元の公開済み版と一致した。解析は停止し、GTM・Ahrefsの実通信確認はT13へ残した。

測定後は正本の`SITE_RANK_SCOPES=site`で再デプロイし、`SITE_RANK_EVAL_SCOPES`を外し、専用secretを削除した。片付け後の有効Worker Versionは`c21ca155-126c-409d-b06a-d12b4e910745`。モデル一覧は200、両誌は200 disabled・searched=null・cached=falseを確認。手元の専用キーも削除した。

## 証跡と次の作業

生の記録は非追跡の`workers/.wrangler/`に保存し、キー・検索語・上流本文は公開する記録へ写していない。

| ファイル | SHA-256 |
| --- | --- |
| `daily-rank-browser-nitori-2026-10-09T10-04-20-395Z.json` | `c58be58e075bad6c77ef1b585bbc3c62dadb3e6f420fda2890300f7c41756d40` |
| `daily-rank-browser-nitori-2026-10-09T10-15-47-867Z.json` | `8584934d6343cfb9c45fa438a7a9bce6d0defd911b7d53ac68f22342f7370e06` |
| `daily-rank-probe-nitori-2026-10-09T10-04-01-882Z.json` | `4f2a59c9bb24f798917c27ddb199468f27f9fbc96834e078080015db67ab9188` |
| `daily-rank-probe-nitori-2026-10-09T10-13-56-628Z.json` | `793e4b5f781980e7b51c40e63d2a71b629c80ce51f0b7359d6745cf95b7e49d8` |

ほかに`t12-nitori-protocol.json`・`t12-nitori-summary.json`・`t12-nitori-tail-sanitized.json`・`t12-production-ui-check.log`・`t12-production-ui.json`・`t12-production-worker.json`・片付けとカウンタのログを保存した。

Worker 151件・評価CLI 24件、既存siteと日刊の固定セットのcheckが成功。実装と本記録は手元のコミットで、未push。

リテールは共有IP上限を守り、別のUTC日に測定する。次回は本番索引とT11 fixtureのgeneration・hashを先に照合し、新しい号で版が変わっていれば固定データと精度評価を更新してから測る。T12全体とT13・T14は未完了で、両誌の一般公開は停止を維持する。
