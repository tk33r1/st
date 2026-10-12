# tools/game検索②の固定評価

2026-10-12。公開前のローカル評価。Worker／Pagesは公開していない。

## 固定したもの

`manifest.json`に候補の正本2一覧・公開サイト索引・80問の生バイト列SHA-256を記録。各scopeのtune/finalは20問で、正解あり10問・正解なし5問・境界5問の構成。境界には複数の正解、逆の機能、別scope、category/genre外の正解を含める。注釈はエージェントが公開済みの機能説明から実APIより前に付け、本人は未確認。最初の実API以降、問い・正解・localeを変更していない。

候補到達とJevを分け、finalの候補到達・上位5件への正解到達は95%以上、必須候補到達100%、正解なしの誤表示0件、不正noul・失敗0件を条件にする。正解ありに余分な候補が混ざる場合も隠さず別記する。

`eval-list-rank.mjs`はWorkerのスナップショット検査・filters・候補選択・候補変換・問い・閾値判定を使用する。閾値比較は取得済みの応答を再生し、再課金しない。キーは出力せず、生応答は`workers/.wrangler/`に保管。公開可能なID・確率・usage・測定条件を`evaluation-20261012.json`へ残した。

## 結果

| scope | 固定した設定 | finalの正解到達（上位5件） | 正解なしの誤表示 | Jev単体p95・2回 |
| --- | --- | --- | --- | --- |
| tools | 20候補・日本語の基準付き問い・0.4・revision 1 | 11/11、11/11 | 0/9、0/9 | 181.5、191.6ms |
| game | 20候補・同じ問い・0.5・revision 2 | 13/13、13/13 | 0/7、0/7 | 179.6、183.3ms |

すべてHTTP200、モデル版は`jev-1.13.0`、noul欠け・timeoutは0件。候補到達はすべて100%。現在の9ツール・8ゲームは20候補以内なので、増えたときの候補到達を保証する評価ではない。

tuneではtoolsの0.3〜0.6が2回とも条件を満たし、初期値0.4を維持した。gameは0.4で正解なし1問を表示し、0.5では2回とも0件となったため、finalの実行前に0.5／revision 2へ固定した。

gameの`game-final-17`（2024年の原作）では正解`game:1`に加え、1回目は`game:3`（0.59）、2回目は`game:2`（0.50）と`game:3`（0.54）が混ざった。正解は両回とも上位へ届いたが、候補集合が1問で揺れた。finalの結果に合わせて閾値・正解は変更していない。toolsの候補集合は2回で同じ。

週次と同じPython経路のsmoke2問も通過。必要なcategory/genreを付け、候補と問いを同じWorker関数で作る。期待確率はtools 0.96、game 0.87。npmやPlaywrightを読み込まない。全評価とsmokeは162要求、入力427,653 tokens。入力$0.042/M・出力無料による計算は$0.017961426（[公式料金](https://docs.typesafe.ai/models)、2026-10-12確認）。これは請求書の実費照合ではない。

最初のsandbox経路の40試行はHTTP接続前に失敗し、実API応答を得ていない。失敗記録は保持し、HTTP200の測定と分けた。その後は接続失敗時に最初の1件で停止するよう評価CLIを直した。実Workerの共有回数枠・本番キャッシュ・運用通知は使用していない。直接APIの時間を本番ブラウザの速度や公開版の合格へ転用しない。

## 再実行

```sh
node .github/scripts/eval-list-rank.mjs --check
node .github/scripts/eval-list-rank.mjs --plan --scope game --set tune
node .github/scripts/eval-list-rank.mjs --accuracy --scope game --set tune --runs 2
node .github/scripts/eval-list-rank.mjs --accuracy --scope game --set final --runs 2
node .github/scripts/eval-list-rank.mjs --report workers/.wrangler/list-rank-game-final-<日時>.json
node .github/scripts/eval-list-rank.mjs --smoke-payload
node --test .github/scripts/test-list-rank.mjs
```

精度評価のための追加実APIは再課金になる。既存記録の集計は`--report`を使う。新scopeは`wrangler.toml`の公開許可に足していない。本番の評価認可・画面経由の測定・Linux／Pagesの依存導入・実機IME／読み上げは残る。
