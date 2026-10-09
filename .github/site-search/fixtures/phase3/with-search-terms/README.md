# T10：言い換え語を加えた日刊②の評価用索引

実装済み（2026-10-09）。正本はコード。手元のみ。本番反映・Jevの精度評価・日刊②の有効化は未実施。

T09のtuneで、候補recallはnitori19/24・retail20/24となり、基準90%に届かなかった。そこで記事ごとに3〜5個、各60コードポイント以内の `search_terms` を加えた。Workerは題名より軽い重みで候補選びに使い、Jevには渡さない。日刊①も使わない。

今後の号は `daily_engine.py` の既存のLLM呼び出しで、要約と同時に日本語の言い換え・英語を作る。別のAPI呼び出しは増やさない。語が欠けた・不正な形の場合は、題名・要約にある概念だけを辞書で補う。3〜5個・各60文字・重複なし・制御文字なしを生成側とWorker側で検査する。語がない旧索引もWorkerで読めるが、語があるのに不正なら索引全体を拒否する。

過去分は `.github/scripts/daily_search_terms.py` の概念辞書で全380記事を補った。これはLLMでの埋め直しではなく、追加API費用のない規則による補完。辞書は記事の題名・要約から一致する概念を選び、英語3語・日本語2語まで作る。未知の題材は元のタグ・カテゴリー・題名を使い、記事にない事実を追加しない。ASCIIは語の境界で照合し、AIがretailやchairの途中に一致することを避ける。評価セット・正解IDを辞書や生成処理から読まない。

## 保存・再現

過去分の補完は通常の `load_history` / `save_history` を通す。既存の語は上書きせず、全年度を検査してから履歴と索引だけを保存する。号HTML・ポータル・RSS・OGP・X投稿は作り直さない。

```sh
python -B .github/scripts/generate-nitori-daily.py --backfill-search-terms --dry-run
python -B .github/scripts/generate-retail-tech-daily.py --backfill-search-terms --dry-run
# 未補完の語がある場合だけ保存する（現在は両誌とも0記事）
python -B .github/scripts/generate-nitori-daily.py --backfill-search-terms
python -B .github/scripts/generate-retail-tech-daily.py --backfill-search-terms
```

公開用の索引のgenerationはnitori `021c767db6e4df27`、retail `13d28fe0e9fcb24d`。検索用の語を含む本文のindex_hashは更新した。Jev用のcandidate_hashは両誌ともT09と一致する。日刊のrevisionはそれぞれ1→2、閾値0.4・候補20件・Jevの問いは維持。siteのrevision・候補・問いは変更していない。

本ディレクトリに、補完後の全年度の索引を公開用と同じバイトでコピーした。`indexes.json` は元のT09のindex_hash、補完規則のソースのSHA-256（改行はLFにそろえる）、補完後の全ファイルのSHA-256・generation・index_hash・candidate_hashを記録する。CLIはこれを照合する。元のT09のfixtureと120問の問い・正解・filters・split・速度24問は変更していない。

## 評価の対象を明示する

`--index-set terms` が本索引、`--index-set original`（既定）はT09の索引。T11以降は **termsを明示** する。両方ともWorkerの同じ関数で読み、記録にindex_setと実際のgeneration/hashを残す。本番の速度測定では、選んだ索引と本番のhashが違えば送信前に止まる。

```sh
node .github/scripts/eval-daily-rank.mjs --check --index-set terms
node .github/scripts/eval-daily-rank.mjs --candidates --scope nitori --set tune --index-set terms
node .github/scripts/eval-daily-rank.mjs --candidates --scope retail --set tune --index-set terms
node .github/scripts/eval-daily-rank.mjs --plan --scope nitori --set tune --runs 2 --index-set terms
node .github/scripts/eval-daily-rank.mjs --plan --scope retail --set tune --runs 2 --index-set terms
# T11：見積もりを提示し、モデル・契約・単価を再確認してから実APIを呼ぶ
node .github/scripts/eval-daily-rank.mjs --accuracy --scope nitori --set tune --runs 2 --index-set terms
node .github/scripts/eval-daily-rank.mjs --accuracy --scope retail --set tune --runs 2 --index-set terms
# tuneで媒体ごとの設定を決めた後、固定したfinalを2回測る
node .github/scripts/eval-daily-rank.mjs --accuracy --scope nitori --set final --runs 2 --index-set terms
```

T12のprobe/browserにも `--index-set terms` を付ける。条件・50回/媒体/UTC日・キャッシュ期限・生の記録の扱いは [T09の手順](../README.md) と [検証計画書](../../../../../assets/site-search-phase3-verification.md) に従う。

## 手元の結果

| 媒体 | T09のtune | T10のtune |
| --- | ---: | ---: |
| nitori | 19/24（79.2%） | 24/24（100%） |
| retail | 20/24（83.3%） | 24/24（100%） |

両誌のtuneの候補recallは90%を満たした。finalのrecall・Jevの精度は未評価で、公開の合格を意味しない。精度の正式な分母は固定したfinal全30問。補完規則や閾値をfinalの結果に合わせて直す場合は、新しいfinalを作る。

補完後のtuneを各媒体2回なら、それぞれ60要求で計120要求。`--plan` はpayloadのUTF-8バイト数を入力トークン数と置いた概算を出す。記事の語はJevのpayloadに入らないが、候補が変わるのでT09の見積もりを流用せず計算し直す。単価・モデル・契約は実測直前に再確認する。生の記録はGit管理外の `workers/.wrangler/` にだけ保存する。
