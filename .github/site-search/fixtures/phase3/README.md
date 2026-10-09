# 日刊②の固定評価データとCLI（T09）

実装済み（2026-10-09）。正本はコード。精度の実測・本番の速度測定・日刊②の有効化は未実施。

## 固定したもの

元コミットは `9b0dd28bc3eeebfbd41dc2ba27033d1760666c75`。`nitori/`・`retail/` は、このコミットの `job/<media>/search-index*.json` をバイト単位でコピーしたもの。現在は両誌とも2026年だけで、年の一覧に載った全年度を含む。元の公開索引・記事・地域の値は書き換えていない。Gitの改行変換を `.gitattributes` で止めている。

| scope | 記事数 | generation |
| --- | ---: | --- |
| nitori | 176 | `2063db70449ba414` |
| retail | 204 | `88e2025867b34429` |

`../../phase3-rank-queries.json` に元コミット・各ファイルのSHA-256・Workerの `index_hash`・`candidate_hash` を保存した。評価器は各ファイルを検査してから `makeDailySnapshot` で読み、記録したハッシュと照合する。ライブの索引を精度測定の代わりに使わない。

各媒体60問を、tune30問・final30問に固定した。各splitにはkeyword・sentence・paraphrase・english・noneを6問ずつ置く。古い記事、商品、経営、月・カテゴリー・地域の条件、同じ号の別アンカー、字が重ならない正解を含む。ここで「古い」は保存済みの9月の記事を指し、複数年度の精度評価を済ませたという意味ではない。

正解は **CodexがAPIや候補選びの結果を見る前に、絞り込み後の全記事の題名・要約から付けたもの（本人未確認）**。記事IDは `<media>:<YYYYMMDD>:<記事番号>`。同じ要求をsplit間で重ねず、正解が複数あればいずれか1件が上位5件に入ることを求める。関連する話題だけの記事や、索引にない手続き・情報は正解にしない。各問のnoteには題名または答え無しの根拠を残した。0件になるfiltersは機能試験で扱い、精度の分母から除く。

速度用の各媒体24問も結果を見る前にfinalから固定した。keyword4・sentence5・paraphrase4・english5・none6。正式な精度はfinal30問で別に判定する。finalを見て正解・問い・候補方式・閾値を変えたら、そのfinalをtuneに移し、新しいfinalを用意する。

`synthetic/<scope>/` は両誌それぞれ2026・2025・2024の3年度、25記事の機能試験専用データ。年末と年始、2024年の閏日、同じ号の複数アンカー、20件を超える対象、長い要約、結合文字・絵文字・全角英字を含む。不正なgeneration・暦・媒体・欠落・重複・制御文字はテスト中に変異させる。これを精度測定や本番とのハッシュ照合に混ぜない。

## オフラインの確認

リポジトリのルートで実行する。Nodeの標準部品だけを使い、ここではキーを読まず、APIも呼ばない。

```sh
node .github/scripts/eval-daily-rank.mjs --check
node --test .github/scripts/test-daily-rank.mjs
node .github/scripts/eval-daily-rank.mjs --plan --scope nitori --set tune --runs 2
node .github/scripts/eval-daily-rank.mjs --plan --scope retail --set tune --runs 2
node .github/scripts/eval-daily-rank.mjs --candidates --scope nitori --set tune
node .github/scripts/eval-daily-rank.mjs --candidates --scope retail --set tune
```

`--candidates` はfiltersを当てた全記事から、Workerの `shortlistRankDaily` で20件まで選ぶ。正解あり24問のうち、正解群から1件以上が候補に入る割合を数える。2026-10-09の基準値はnitori **19/24（79.2%）**、retail **20/24（83.3%）**。両誌とも90%未満で、T10の条件に該当した。この時点ではfinalの候補recallやJevの精度は評価していない。

`--plan` は回数・最大20問/要求・payloadのUTF-8バイト数と概算費用を出す。2026-10-09に [TypeSafe AI公式料金](https://docs.typesafe.ai/models) を照合した。UTF-8バイト数を入力トークン数と置いた余裕のある概算で、実usageとは異なる。

現在のtuneを各媒体2回ならそれぞれ60要求、nitori約 **$0.0593**、retail約 **$0.0616**（合計約$0.121）。これは出発点の候補・問いでの見積もりであり、T10後と実測直前に回数・payload・契約・モデル・単価を再確認する。閾値比較のための追加API呼び出しは行わない。

## 精度の実測（T11）

固定セットと見積もりを提示してから使う。`--accuracy` だけがJevへ直接送る。モデル・問い・候補変換・確率の検査・並び・リンクの照合はWorkerの関数をそのまま使う。env.evalや本番Workerの回数・キャッシュには依存しない。scopeは必須、setは既定tune、runsは1か2（既定2）。

```sh
node .github/scripts/eval-daily-rank.mjs --accuracy --scope nitori --set tune --runs 2
node .github/scripts/eval-daily-rank.mjs --accuracy --scope retail --set tune --runs 2
# tune後に媒体ごとの設定を固定してから実行する
node .github/scripts/eval-daily-rank.mjs --accuracy --scope nitori --set final --runs 2
node .github/scripts/eval-daily-rank.mjs --report workers/.wrangler/<精度の生記録>.json
```

キーは既存の `eval-site-rank.mjs` と同じ読み方で、`MAGI_TYPESAFE_API_KEY`、`TYPESAFE_API_KEY`、ローカルの `.dev.vars` から読む。要求ヘッダーやキーを記録に出さない。tuneの閾値0.3・0.35・0.4・0.5・0.6は、各問1回の応答をWorkerで再生して比べる。finalはその媒体の設定値だけ。runごとに実APIを呼び、cNNをその問の候補IDへ戻す。別の問のcNNやキャッシュを流用しない。

媒体・split・各runで候補recall90%以上、正解ありの上位5件hit80%以上、答え無しの誤表示15%以下を別々に出す。途中失敗や欠けた問も分母に残す。失敗した呼び出しがあれば、誤表示が少なくても合格としない。不完全な判定・HTTP・モデル版・usage・生の応答・Jev単体の時間も保存する。認証・残高のエラーは後続を止め、部分記録を残す。2回の平均を合否に使わない。直接呼んだJevの時間はブラウザの速度の合格に使わない。

記録にはgeneration・index_hash・candidate_hash・query_hash・code_hash・config_hash・revision・閾値・モデルのalias・元コミット・測定時のcommit/dirtyを残す。APIからモデル版やusageが欠けていた場合もレポートに出す。生の記録は検索語を含むため、**Git管理外の `workers/.wrangler/` にだけ書く**。固定した合成の検索語と公開済み記事のfixtureだけをGitに入れる。

## 本番ブラウザの速度（T12）

精度の合格後、評価する媒体だけWorker側で開け、画面は停止したまま使う。実測前に、固定した全年度の索引が本番と同じhashか、指定したWorker Version IDと手元のコード・設定が同じかを確認する。本番の索引のhashが違えばCLIはAPIを送らず止まる。WorkerのVersion IDはデプロイ記録から指定する。

```sh
node .github/scripts/eval-daily-rank.mjs --probe --scope nitori --run 1 --worker-version <Version-ID>
node .github/scripts/eval-daily-rank.mjs --browser --scope nitori --run 1 --worker-version <Version-ID>
# 1回目の終了からキャッシュ10分＋余裕1分を空ける
node .github/scripts/eval-daily-rank.mjs --probe --scope nitori --run 2 --worker-version <Version-ID>
node .github/scripts/eval-daily-rank.mjs --browser --scope nitori --run 2 --previous workers/.wrangler/<1回目>.json --worker-version <Version-ID>
```

本物のChromiumからhttps://tk.stをOriginとしてPOSTし、送信直前から本文の読み取りまでを測る。既存の404評価器のブラウザ処理を借り、解析を停止し、サイトとWorker以外の通信を止める。Playwrightはこのモードでだけ読む。8秒の期限と画面の応答検査も共通の部品を使う。

T12では`SITE_RANK_SCOPES`に測る媒体だけを一時的に加え、同じ媒体を`SITE_RANK_EVAL_SCOPES`にも指定する。secret `SITE_RANK_EVAL_KEY`を設定し、CLIに`--eval-key`を付け、同名の環境変数からキーを渡す。`x-api-key`付きの要求だけ許され、通常の公開画面は索引・回数・Jevより前にdisabledで止まる。キーは生の記録にも書かない。siteの利用は変えず、測定後は正本のsiteのみで再デプロイし、専用キーを削除する。

`--probe --cancel-after <1〜7999ms>`は、疎通用の1要求を意図的に切断してrequest.signalの本番伝播を確認する。取り消した要求も当日の50回へ数え、追加で送り直さない。記録には期限・失敗をそのまま残し、通常の疎通成功や速度の成功へ数えない。Workerのtailで実行結果canceledと短時間の終了を確認し、処理の段階も残す。内部のcancelledは公開reasonのunavailableへ対応付けるので、ログのreasonにcancelledを要求しない。切断が確認できなければ未達とする。もう一方の疎通は通常どおり実行する。

24件を2回＋疎通2件＝50要求/媒体。疎通の語は評価セットとも、2回の間でも重ねず、速度に混ぜない。2回は同じUTC日、媒体は別のUTC日に分ける。CLIは手元の既知の記録から当日の50回上限と重複を確認するが、ほかの利用者・端末も使うIP60回/日・全体3000回/日の残量は分からない。残量を十分と決めつけず、rate_limitedが出ればその測定は不成立とする。測定の記録を消して上限の確認を避けない。

各要求のrequest_id・generation・cached・N/M/J・complete・status・結果ID・時間を残す。キャッシュ、版の相違、rate_limited、index_updating、通知や対象数の欠落、不正なリンクは不成立。失敗と時間切れは `max(実時間, 8000)` を時間に入れ、成功数・時間切れ数も残す。p95は昇順の `ceil(0.95*n)` 番目。24件がそろわない回や2回の版・問い・設定が違う測定を合格としない。p95の上限は1500ms。24問の精度は参考値として保存し、正式なfinal30問の精度合否を置き換えない。

`--probe` の終了コードは疎通の成立だけで決める。`--browser` は成立とp95を判定する。このCLIだけで切断・通知の期限・有効化後のprivacyを合格にしない。それらは [検証計画書](../../../../assets/site-search-phase3-verification.md) のV06・V09・V14で確認する。
