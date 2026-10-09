# サイト内検索 Phase 3 検証計画書

実装開始（2026-10-09）。同日の本人のレビューで範囲を「日刊2誌の②」に絞った。T03〜T05は実装・公開済み。同範囲の正本はコード。日刊②と実 API の精度・速度の検証は未実施。

対象と期待値は [PRD](site-search-phase3-prd.md)、仕組みは [設計書](site-search-phase3-design.md)、作業の順番は [実装計画書](site-search-phase3-plan.md)。本書でケース・環境・合格条件・証跡を固定する。Phase 2 のテストの成功を Phase 3 の合格として数えない。

## 1. 検証の段階

| 段階 | 環境 | 上流 | 確かめること |
| --- | --- | --- | --- |
| 資料の点検 | 手元の Markdown | 呼ばない | 要件・契約・作業・ケースの整合 |
| 単体 | Node・Python、公開できる fixture | 模擬 | 候補・検査・件数・キャッシュ・期限・generation |
| 画面 | Playwright、手元の静的サーバー | Worker は模擬、計測は記録して止める | 明示操作だけの送信、入力、表示、privacy |
| 精度 | 固定した公開の索引 | Jev | 候補に正解が入る割合、判定、探索範囲の表示 |
| 出荷の確認 | `build.sh` の `_site` | 模擬 | 生成物・参照・非公開のファイルの除外 |
| 本番の確認 | 媒体を開けた本番（画面の公開の前後） | 本物の Worker、最小限の要求 | 応答時間・切断・hash・計測・停止 |

本番の測定は既存の利用の枠を共有する。生の検索語を含む記録は追跡しない場所に置き、キーや個人情報を GitHub に出さない。

## 2. ケースと期待値

| ID | 要件 | ケースと合格条件 | 主な確認先 |
| --- | --- | --- | --- |
| V00 | 全体 | 4資料の参照と作業の依存が解決し、本人の決定（PRD 8章）が入っている。未実施を合格と書かない | 資料 |
| V01 | R02・R08 | 未知の scope・`tools`/`game`、型違い、余分なキー、4KiB 超え、200文字超え、空の入力、未知の filter、不正な年月、site の filters を拒否。③と site の②は従来どおり | test-magi2 |
| V02 | R02・R06 | 日刊の3つの filter を当てる。値は実在しても組み合わせが0件なら正常な0件（上流を呼ばない）。別の媒体の kind・URL・ID を返さない | Worker・URL の検査 |
| V03 | R04 | 全ファイルの generation の一致を確かめ、混ざり・欠け・重複 ID・上限超え・不正な日付を拒否。取得中に新しい版が出ても、整合した版は受け付け、headを取り直さない。ブラウザは混ざりの後に読み込み途中のものを捨て、次の明示検索で読み直す。画面と応答の版が違う場合も次の検索で読み直し、①とフォーカスを保つ。Workerは版ずれで60秒の間隔を守って取り直し、取得中・間隔の内でも既知の絞り込みには24時間以内の完全な版で答える。未知の絞り込み等でindex_updatingを返すときは回数・Jevを使わず、自動で再送しない。初回・通常取得の中断後はすぐ再試行でき、強制取得の中断には制限を残す。生成側は題名・カテゴリー・タグの違反で索引を書かない | 生成側・Worker・daily-ui |
| V04 | R05・R09 | 候補の点数・新しい記事での補い・20件の上限・同点の順・400文字の短縮、Jev の欠け・型違い・範囲外、N/M/J・complete・キャッシュ。言い換え語を作った場合は、その重みと Jev へ渡さないこと | rankSearch・評価 CLI |
| V05 | R05・R09 | 媒体ごとの固定セットで2回、候補に正解が入る割合・上位5件・誤表示・hash が基準を満たす（3章） | 評価 CLI・実測の記録 |
| V06 | R08 | 本文・索引・Jev・通知の遅れ、切断、IP と全体の上限、キャッシュに当たる、scope の停止。止めた scope で索引・回数・Jev を使わず、site は止まらない | test-magi2・本番の tail |
| V07 | R07 | 検索語を含む上流のエラーを模擬。公開の応答・ログ・DB・通知に原文やキャッシュのキーが出ず、件数と設定値だけが残る | ログ・D1 と通知の模擬 |
| V08 | R01・R03・R06 | 404 の形：入力中はドロップダウンだけで②も `daily_search` も送らない、↑↓・Enter・Esc・外を押す・変換中の候補、Enter・虫眼鏡で②→①の順、入力を変えたら入力中の形に戻る、①0件の案内。初期表示・受け渡し・タグ・filter・①の読み込み完了で②を送らない。A→B、A→B→A、①の読み込み中の変更、確定 Enter の押し続け、フォーカスの保持、記事単位の重なりの除き | Playwright |
| V09 | R07・R13 | 日刊の `#q=`・古い `?q=` と、ツール・ゲーム一覧の `?q=`・`#q=` が計測より先に URL から消える。競合・不正・長すぎる値も消える。手入力と表示した検索語が URL・参照元・許していない計測に出ない。GA4 の伏せ字の `search_term` だけが例外 | 実計測を記録する画面の検証 |
| V10 | R10 | 320px・200%・日英・明暗・キー操作・読み上げ（状態の行が隠れた欄の外にある）、見出しの横のインフォメーションマークとダイアログ | Playwright・手動 |
| V11 | R04・R07 | 両誌の新しい号・過去の号・年またぎ、テンプレート、キャッシュの版、全 HTML の参照、`Date-Sync`、`_site` の中身 | Python の生成・build.sh |
| V12 | R12 | ③の全体の上限が100回、IP ごとの10回は同じ。README と PRD の数字が一致 | test-magi2・資料 |
| V13 | R13 | ツール・ゲーム一覧の CSP と通信先が基点と同じ。カードの絞り込みと並べ替えが従来どおり | Playwright・差分 |
| V14 | R11 | 媒体だけの停止→①は使える→戻して再読み込みで再開。`daily_rank_*` が GA4 に届き（GTM のトリガーは2026-10-09に直し済み）、計測を止めた人からは届かない。公開前の文書と、出荷したコミット・Worker の版・Pages の版が一致し、切り戻しの証跡がある | 本番・運用の記録 |

### 2.1 fixture の最低限

公開できる合成データを使う。いまの両誌は1年分だけなので、複数年の保証を実データの成功だけに頼らない。

- 2媒体×2年以上。年末・年始、うるう日、正しい空の索引、20件以下・21件以上。
- 同じ号の複数の記事、同じ題名で違うアンカー、同じ番号で違う号、同じ記事の URL で違う媒体。
- generation が全ファイルで同じ、head だけ新しい、過去の年だけ新しい、取得中に更新、24時間の境目。
- 実在するカテゴリーと月の組み合わせで0件、未知のカテゴリー、不正な月、JP・GLOBAL。
- 長い題名・要約・タグ、絵文字、結合文字、指示文を含む要約、外部 URL・遡り・二重エンコード。
- Jev の答えが全部欠ける・一部欠ける・不正な値、本文だけ遅い応答、切断の後に答える上流。

## 3. 精度の評価セット

site のセットは変えず、`.github/site-search/phase3-rank-queries.json` を別に作る。各行に scope・query・locale・filters・type・正解の ID・none・split を持たせ、固定した索引の generation・hash・正解を付けた担当・固定日を記録する。

| scope | 最低件数 | tune/final | 必ず含める入力 |
| --- | --- | --- | --- |
| nitori | 60 | 30/30 | 古い記事、商品・経営、英語、月・地域・カテゴリー、同じ号の別記事、字の重ならない言い換え |
| retail | 60 | 30/30 | 同上、国内外の似た題材 |

- 各 split の20%以上を、答えの無い問い合わせにする。filter の後で対象が0件のケースは機能の検証に置き、誤表示率の分母に入れない。
- 正解は、結果を見る前に、公開記事の title・summary を根拠に付ける。付けた担当を記録し、本人の確認済みとは書かない。正解は候補の20件の中だけでなく、filter の後の全記事から付ける（候補選びの取りこぼしを隠さない）。

### 3.1 合格条件

| 指標 | 基準 | 集計 |
| --- | --- | --- |
| 答えのある問いの上位5件に正解 | 各媒体・各 final で80%以上 | 失敗も不正解に数える |
| 答えの無い問いへの誤表示 | 各媒体・各 final で15%以下 | 閾値以上を1件でも出したら誤表示 |
| 正解が候補20件に入る割合 | 各媒体・各 final で90%以上 | filter の後の正解のうち少なくとも1件が入るか |
| 探索範囲の誤った断定 | 0件 | M<N で「無い」と書く・索引の失敗を0件にする |
| キャッシュなしの応答時間 | 各媒体・各回の p95 が1.5秒以内 | POST の開始から応答本文の検査の完了まで |

- 割合だけでなく、分子・分母と失敗の数を記録する。閾値0.4は出発点で、tune でだけ選ぶ。final を見て変えたら、その final は以後 tune として扱い、新しい final を用意する。
- 候補に入る割合が90%未満なら、候補選びを直す（実装計画書 P3-T10 の言い換え語）。Jev の閾値を下げて取りこぼしを救ったように扱わない。
- 上位5件の基準は、記事が数百件ある日刊だから意味を持つ。件数の少ない一覧（ツール・ゲーム）に②を入れる将来の案があれば、上位1件か3件で測る。

## 4. 応答時間と実 API の実行

1. 対象の件数・評価の件数・候補の上限から、Jev の要求数と入力の見積もりを出す。キーや単価を資料に写さない。
2. 固定の索引とセットで精度を測る。コード・設定・モデルの応答の版・generation・candidate_hash・問いごとの候補 ID を追跡しない場所に残す。
3. 評価する媒体だけを本番の Worker で開け、画面は止めたまま、本物のブラウザから②を測る。final から結果を見る前に固定した24件を速度の対象にし、精度の合否は final 全件で別に判定する。疎通の1件は評価の語と重ねず、速度の集計に混ぜない。
4. 同じ UTC 日に10分以上（キャッシュの10分と余裕）空け、同じ generation・hash で2回測る。1 UTC 日に1媒体、48件＋疎通2件まで。既存の利用で50件の余裕が無ければ別の日にする。IP ごとの60回は両誌で共通なので、両誌の2回ずつを同じ日に組まない。
5. 両回の全要求の応答で `searched.generation` が精度の fixture と同じで、`cached` が false であることを確かめる（測定の Actions はログを集めないので `wrangler tail` には頼らない。設計書 9章）。revision は Worker の Version とコミットで確かめる。generation の違う要求・キャッシュに当たった要求・rate_limited・`index_updating` を含む測定は不成立とし、成功に数えない。測定の成果物に、要求ごとの request_id・generation・cached を残す。

失敗・timeout は、精度では不正解、速度では「実測値と8秒の大きいほう」として記録する。p95 は昇順の `ceil(0.95 × n)` 番目（1始まり）。成功率と timeout の件数も書く。期間内に前提がそろわなければ「不成立」とし、合格にしない。

## 5. privacy と表示

- 目印は個人情報でない合成語にし、外向きの通信の URL と本文をデコードして探す。明示操作の②の POST の本文は、許した検索の送信として計測への送信と分ける。メールアドレス・電話番号の合成例、全角・区切り・日付の例外・100文字・部品の読み込み失敗を確かめる。
- 本物の GTM・Ahrefs を読む検証では、読み込めたかを別に記録する。読み込めなかった検証を「実計測でも漏れない」と言い換えない。公開後の GTM のイベントの受信は、本人の画面か本番の通信の証跡で確かめる。
- Clarity は 404・日刊の既存の扱いのまま（PRD 4章）。ツール一覧の除外は維持し、ツール・ゲーム一覧の CSP と通信先は基点と同じであることを確かめる。
- キーボードでは、ドロップダウンの↑↓、②→①、結果が届いている間の操作、ダイアログの開閉を確かめる。状態の行は読み上げられ、結果が届いただけでフォーカスを動かさない。Safari・iOS・Android の実機の確認は、Chromium の合成の IME の検証と分けて記録する。

## 6. 証跡と公開の判定

| 記録 | 内容 | 置き場所 |
| --- | --- | --- |
| 固定セット | scope・split・正解・担当・固定日・索引の識別子 | `.github/site-search/phase3-rank-queries.json`（実装時） |
| fixture | 年別の索引・generation の期待値・filter の期待結果 | `.github/site-search/fixtures/phase3/`（実装時） |
| 単体・画面 | 実行したコマンド、コミット、対象の root、成否、通信の検証の範囲 | 合格記録の要約・追跡しないログ |
| 実 API の生の記録 | 問い・候補・応答の版・usage・時間・request_id | `workers/.wrangler/` だけ |
| 合格記録 | 媒体ごとの2回の分子・分母・hash・p95・残った課題 | `assets/site-search-phase3-evaluation.md`（実測後） |
| 公開・停止 | コミット、Worker の版、Pages の版、許した scope、時刻、停止の試験 | 実装計画書の進み具合・合格記録 |

媒体ごとに、該当するケースが通り、重大な不具合が無く、精度・本番の privacy・応答時間の基準を満たしたときだけ公開してよい。手元の成功、本番の成功、モデルの精度は別々に記録する。一方の媒体の不合格で、もう一方の公開を止めない。

切り戻しは、その媒体を `SITE_RANK_SCOPES` から外すのが先。開いたままの古い画面でも①を使えることを確かめる。戻した後は再読み込みで②が使え、止めている間に自動の送信が無いことを確かめる。generation は消さない。

## 7. 進み具合

| 項目 | 状態（2026-10-09） |
| --- | --- |
| 現行のコード・データ・Phase 2 の契約の調査 | 実施済み |
| V00 の資料の点検 | 本人のレビューの決定を反映済み |
| Phase 3 のテストの作成 | T03〜T08の境界・generation・一覧の受け渡し・両ポータルの画面を追加。T09で固定した380記事・120問と両媒体×3年度の合成fixture・模擬評価器18件を追加。7.12 |
| V12（T03） | 模擬Workerで確認済み。本番Workerの公開成功、Versionと読み取り専用の疎通を確認。実利用の回数を100回まで消費する試験は行っていない |
| V09・V13（T04） | 手元・出荷物・本番URLで一覧の6場面を確認済み。コードレビュー時の手元と公開後の本番では、GTM・Ahrefsを実際に読み込み、計測の送信を記録して停止 |
| V03・V11（T05の生成側） | 全年度で共通のgeneration、過去年だけの変更、空の索引、再生成の安定性、既存の日刊画面の互換を確認済み。Worker側は7.2〜7.3で模擬検証済み。画面の版の照合は7.4で模擬検証済み |
| 出荷の確認 | 簡素化後も `build.sh` 成功（653ファイル）。Pagesのビルド成功。本番の両誌の索引が出荷内容と一致（176記事・204記事）。generation以外の既存項目は変更前と一致 |
| T06〜T07のWorker側 | 7.2〜7.3に記録。全体の回帰148件通過 |
| T08の画面 | 7.4〜7.6に記録。両誌の模擬検証・本番反映済み。日刊②は停止設定を維持 |
| V04・V05の準備（T09〜T10） | 固定セット・CLIとsearch_termsを実装。T10後のtuneの候補recallは両誌24/24。Jevの候補変換は保持。final・Jevの精度・本番速度は未実測。7.12〜7.13 |
| その他のV01〜V14・実 API の測定・日刊②の公開の検証 | 未実施 |

実行したコマンド（2026-10-09、基点 `27fae390`、未コミットのT03〜T05）：

```sh
python -B .github/scripts/generate-nitori-daily.py --rebuild-search-index
python -B .github/scripts/generate-retail-tech-daily.py --rebuild-search-index
python -B .github/scripts/test-daily-news.py
node --test --test-name-pattern='検索は認可|検索のIP上限|Phase 3' .github/scripts/test-magi2.mjs
node .github/scripts/test-site-search-ui.mjs --root . --match 一覧
node .github/scripts/test-site-search-ui.mjs --root . --match 日刊ポータル
bash build.sh
node .github/scripts/test-site-search-ui.mjs --root _site --match 一覧
git diff --check
```

Pythonは22件、模擬Workerは3件、既存の日刊ポータルは5場面が通った。両一覧のインラインJSと `personas.js` もNodeの構文検査を実施。WindowsのGit Bashでは、手元の呼び出しで標準コマンドのPATHと `python3` を補ってビルドした（リポジトリのビルド設定は変更なし）。この手元検証では本番へ送っていない。公開後の確認は7.1に記録した。次はT06の検証を追加する。

同日の簡素化で、再生成の2モードの履歴読み込み・空データの検査を共通化し、両一覧の文字数の重複計算と画面テストの繰り返しを整理した。Python22件と手元の一覧6場面を再実行して通過。再生成の両モードと空データの終了を模擬で確認し、実データの索引だけの再生成では両誌の出力が変更前とバイト単位で一致した。headの受け渡しはインラインのまま。この時点では簡素化後の出荷ビルドと実計測は未確認だった（以後の確認は7.1）。

### 7.1 T03〜T05の公開（2026-10-09）

本人の「本番反映して」の指示により公開した。コードは `6d070f56`（T03）・`c50ead30`（T04）・`20cb42cf`（T05）の3コミット。最新の人格カードを含むmainを確認してからpushし、デプロイした。日刊②は公開していない。

- **Pages**：`20cb42cf3bee8f667f63a11e00f26fbe4203b088`、deployment `9a43c43f-0234-440b-be25-150f2c8dc306`。GitHubのCloudflare Pagesチェックが2026-10-09 12:07:37 JSTに成功。
- **magi2**：[Deploy Worker実行](https://github.com/tk33r1/st/actions/runs/37877808474)、同じコミットから `worker=magi2`・`dry-run=false`。2026-10-09 12:07:43 JSTに公開成功。Version `fe2d3f16-1463-4738-976c-e809bd77a78e`。`/magi2/models` は本番でHTTP 200・正常なJSON。
- **本番の一覧**：`node .github/scripts/test-site-search-ui.mjs --base https://tk.st --match 一覧` の6場面が通過。GTM・Ahrefsを読み込めた。記録したGA4のイベントは `page_view`・`user_engagement`。URL・本文・参照元への目印の漏れを検出せず、検索のWorkerへの送信も無し。計測の送信は記録して止めた。
- **本番の索引**：ブラウザ経由で出荷したJSON全体と一致を確認。nitori `2063db70449ba414`（176記事）、retail `88e2025867b34429`（204記事）。通常のPython HTTPクライアントは403となったため、ブラウザで照合した。

公開に伴うsitemap botのコミット `2dda2f14` はsitemapの更新だけで、索引・号の本文は変更していない。上の公開の証跡はT03〜T05だけのもの。日刊②の精度・応答時間・停止の合格には数えない。

### 7.2 T06の手元検証（2026-10-09）

`workers/magi2/search-scope.js` を追加。scopeと媒体の固定の対応、filters・generation、全年度の索引の検査・取得、媒体ごとのキャッシュを実装した。APIへの接続と公開はT07以後。

- `node --test --test-name-pattern="日刊scope" .github/scripts/test-magi2.mjs`：12件通過。両媒体×3年の合成データ、最大4並列、head1回、版の混在・欠落・重複・不正な日付とURL、UTF-8の合計バイトと記事数・年数、10分・24時間・60秒の境界、generationの更新の合図、本文の遅れ・切断・並行要求を確認。
- 実データの両誌（176記事・204記事）を同じ検査に通した。generationの値をPythonの方式で計算し直していない。
- `node --test .github/scripts/test-magi2.mjs`：新規10件を含む133件通過。その後、本文受信と並行要求の2件を追加し、新規12件を再実行して通過。
- `search-scope.js`・`personas.js` のNode構文検査と `git diff --check` が成功。実API・本番のWorkerは呼んでいない。

V01〜V03のWorker内部の検査を確認した。HTTPでの契約・回数・停止・候補はT07、画面の版の照合はT08、精度・応答時間はT11〜T12で確認する。

### 7.3 T07の手元検証（2026-10-09）

日刊のscopeをAPIへ接続し、候補・変換・応答・キャッシュ・停止・ログを実装した。設定は `SITE_RANK_SCOPES="site"` のまま。未設定もsiteだけで、全体の停止が優先する。日刊の問い・閾値0.4・revision 1は初期値で、精度は未評価。

- `test-magi2.mjs` に日刊②の13件を追加。HTTPの型と範囲、停止時の索引・回数・Jevなし、文字の一致と新しさによる20件、要約300・合計400コードポイント、両媒体のN/M/J・generation・cached・最大5件を確認。
- `node --test .github/scripts/test-magi2.mjs`：最終変更の全148件通過（T06の12件・T07の13件を含む）。既存の404・MAGI・アプリの回帰も通過。
- 3つのfilterと実在する値の組み合わせの0件、古い版の更新待ち、更新後の新しい月・カテゴリー、未知の値の400、取得失敗を確認。更新待ち・要求の誤りでは回数を消費しない。
- 完全な結果・0件のキャッシュ、欠けた判定の扱い、キーのscope・revision・locale・filters・全年度hash、媒体の取り違えの拒否、404と共通のIP→全体の回数を確認。
- 全体の期限とHTTP要求の切断、索引の中止・裏で更新しないこと、ログが1回で検索語・filtersの原文を含まないことを確認。
- 公開済みの `cf556607` と比較し、siteの35候補の `candidate_hash` と日英2例の送信payloadが一致。siteの問い・閾値・revisionは変更していない。
- `node .github/scripts/eval-site-rank.mjs --check` と `python -B .github/scripts/ai_models.py check` が成功。評価CLIと週次smokeの読み込みに新しいWorker部品を追加したが、npm依存は増やしていない。
- `wrangler deploy --config magi2/wrangler.toml --dry-run --outdir .wrangler/phase3-dry-run` が成功（224.77KiB、gzip 63.23KiB）。ログ先は手元の `WRANGLER_LOG_PATH` でリポジトリ内の `.wrangler/phase3-logs` にした。
- Workerの変更した4つのJSのNode構文検査と `git diff --check` が成功。実API・本番へは送信していない。

V01〜V04・V06〜V07のWorker側の模擬検証であり、精度・本番の応答時間・画面・privacy・公開の合格を意味しない。次はT08。


### 7.4 T08の手元検証（2026-10-09）

両誌のポータルを404の形の検索欄に変更した。入力中は①の最大6候補だけを開き、Enter・虫眼鏡で①の処理を待ってから②を送る。受け渡し・ヘッダー・タグ・ウォッチ・絞り込みは①だけ。②の前に確定した①を最大100件で残し、号のパスと記事アンカーが同じ結果だけを除く。

- `test-site-search-ui.mjs` に両媒体で計36場面を追加。候補のARIA・矢印・Enter・Esc・欄の外、①0件、IME中の候補・確定Enterの押し続け、同じ条件の再送防止、読み込み中の変更とA→B→A、②到着時のフォーカスを確認。
- category・region・month・locale・generationが②のPOSTに入り、①と同じ条件になることを確認。入力だけでは②・`daily_search`を送らず、入力変更と日英の切り替えで旧結果を隠す。受け渡しと送信前の上限も200コードポイントにそろえ、200個の絵文字の受け取り・201個の拒否・号のヘッダーからの受け渡しを確認。
- 全年度のgenerationの混在・欠落で、記事と年別Promiseを捨てる。入力中は自動再試行せず、次の明示操作でheadから読み直す。ウォッチが1月に最新年と前年を読めても、それを全年度の索引として使わないことを確認。
- N/M/J・generation・cached・completeの型と大小、日付・記事番号・媒体・URL・重複を画面でも検査。一部候補の該当なしを全記事の該当なしにせず、欠けた判定と版の相違を表示。`index_updating`は待つ案内だけで再送せず、`disabled`は②を隠して①を使える。
- `daily_rank_run/result/click`の値は既存の404と同じ項目だけ。runの`search_term`と既存`daily_search`を伏せ字で送り、result/clickに原文を含めない。計測停止・共通の伏せ字部品が無い場合・同じ語の連続を確認。Workerへの明示POSTの原文は仕様どおり許し、URL・参照元・Cookieを付けない。
- 320px、1280pxで200%表示、OSの暗い配色の指定、日英の案内、キーボード、状態行のrole/aria-live、説明ダイアログのフォーカスを確認。日刊の既存の明色テーマは維持。両誌の出荷物の検索画面を画像でも点検。
- `origin/main`を再生成の前後に取得し、新しい号のコミットが無いことを確認。全55号はJS/CSSの参照2か所以外が変更前とバイト単位で一致し、本文とdateModifiedを保持。両誌の索引も変更前と一致。共通JS/CSS・テンプレート・404・全日刊HTMLの版は`20261009_2`にそろえた（変更していないsearch-analyticsは従来の版）。コミットに`Date-Sync: skip`を付ける。
- 説明のTypeSafe AIの学習・保持期間・処理地は、[公式プライバシーポリシー](https://typesafe.ai/legal/privacy-policy)を2026-10-09に照合した。公開直前の再確認と運用文書の更新はT13で行う。

実行結果：`node .github/scripts/test-site-search-ui.mjs --root _site`の全94場面が通過（既存58・新規36）。仕上げで不正なタグを取得失敗にする検査も追加し、両媒体の版の混在・復旧の2場面を再実行して通過。`node --test .github/scripts/test-magi2.mjs`は148件、`test-daily-news.py`は22件、`test-site-search-index.py`は5件通過。`eval-site-rank.mjs --check`・`ai_models.py check`・変更したJS/Pythonと全58HTMLのインラインJSの構文検査・`git diff --check`が成功。`build.sh`も成功（653ファイル）。

実API・本番へは送っていない。手元ではGTM・Ahrefsのスクリプトを読み込めず、dataLayerと模擬POSTの検査まで。実際の解析の送信と本番privacyの合格はT13で確認する。`SITE_RANK_SCOPES="site"`は変更していない。日刊②の精度・本番の応答時間・公開の条件は引き続き未達。次はT09。

### 7.5 T08の簡素化（2026-10-09）

検索の機能を保ったまま、絞り込み3項目の参照と日英文言を使い回し、結果リンクの二重設定とgeneration差異の案内の重複を整理した。検索の順序・応答の検査・中止・計測の項目は変更していない。受け渡しテンプレートのインデントも既存の出力にそろえた。

- 共通のdaily-uiとsite-searchの参照を`20261009_3`に更新。CSSとsearch-analyticsの版は従来のまま。全57日刊HTMLは、この2つのJSの参照バージョン以外が変更前とバイト単位で一致し、全55号の本文・dateModifiedと両誌の索引を保持した。
- `node .github/scripts/test-site-search-ui.mjs --root _site`：全94場面通過。`test-daily-news.py`は22件、`test-site-search-index.py`は5件通過。変更したJS/Pythonの構文検査と`git diff --check`が成功。
- `build.sh`成功（653ファイル）。変更した58HTMLと共通JSの2ファイルが出荷物とバイト単位で一致することを確認。

未公開。実API・本番へは送っていない。計測スクリプトの実通信は7.4と同じく未確認。`SITE_RANK_SCOPES="site"`を維持し、公開の条件は変更していない。日付を保持するためコミットに`Date-Sync: skip`を付ける。次はT09。

### 7.6 T06〜T08と簡素化の本番反映（2026-10-09）

本人の「本番環境反映して」の指示で、`20e7c18c`・`f015496f`・`6e8636d1`・`5890beef`を反映した。`SITE_RANK_SCOPES="site"`を維持し、日刊②の有効化・実APIの評価は行っていない。

- Workerを先に手元のwranglerで本番へデプロイ。Version `ddbc64d1-bce5-4d16-bbc6-4bade6c506e2`、224.77KiB（gzip 63.23KiB）。本番DB・ルートと停止設定が一致。`GET /magi2/models`は200。両誌への合成要求は200・`failed/disabled`・`searched:null`・`cached:false`で、Jevや回数を使う経路には入らない。
- mainへpush後、Cloudflare Pagesの公開成功をGitHubのチェックで確認。Deployment `57a9221c-4f38-47fc-98ff-6a2c40cdcfcc`、対象`5890beef`。AIモデル検査・sitemap・人格カードworkflowも成功。
- 14:16 JSTにブラウザから両ポータルを確認。入力候補は最大6件・APIなし、明示Enterは本物のWorkerから`disabled`を受けて②を隠し、①は利用可能。連続Enterで再送しない。URLに検索語を残さず、ページエラーなし。実APIの判定は行っていない。
- 公開された両誌のheadは出荷内容と一致。nitori `2063db70449ba414`（176記事）、retail `88e2025867b34429`（204記事）。共通JSの2ファイルも内容と`20261009_3`の参照が一致。存在しないURLは404で、新版site-searchを参照。
- `node .github/scripts/test-site-search-ui.mjs --base https://tk.st --match 日刊ポータル`の5場面通過。`#q=`・旧`?q=`・ヘッダー・タグ・絞り込みと解析停止を確認。本物のGTM・Ahrefsを読み込み、解析の送信を記録して停止した。GA4の`daily_search`・`daily_rank_run/result`を観測。これは停止中の画面と受け渡しの確認であり、有効化した日刊②のprivacy・精度・応答時間の合格には数えない。
- push前後にリモートmainを取得。新しい号・人格カードは無し。sitemap botの`767b6c71`はsitemapだけの更新で、号本文とdateModified・索引は変わっていない。bot更新を手元にも取り込んだ。

生の画面記録とログは非追跡の`workers/.wrangler/`に保存。次はT09。日刊②の有効化には引き続きT11〜T13の合格が必要。

### 7.7 提案を採用したWorkerの簡素化（2026-10-09）

本人の「おすすめだと思われる分だけ実施して」の指示で、日刊のsnapshot.indexHashを廃止し、既存のsnapshotHashへ統一した。取得の期限内でハッシュを確定する順序は保持し、同じWeakMapのPromiseを使い回す。scopeの判定はSEARCH_SCOPESから行い、エラーの対応付けと重複する正規表現の検査を整理した。

- JSの末尾固定の正規表現（mなし）が末尾の改行を拒否することを実行確認。日付の妥当性・記事番号の範囲・URLの媒体一致・generationの一致は維持。
- `node --test .github/scripts/test-magi2.mjs`：全148件通過。日刊の索引・ハッシュ・HTTP・キャッシュ・回数・期限・切断と、既存site・MAGIの回帰を確認。`eval-site-rank.mjs --check`も成功。
- 変更したWorkerの3JSの構文検査と`git diff --check`が成功。wranglerのdry-run成功（224.71KiB、gzip 63.20KiB）。

公開関数の入力の契約を保つため、filtersの再正規化は残した。siteの0件の扱い・媒体ごとの設定も維持。`SITE_RANK_SCOPES="site"`は変更していない。実API・本番へは送信していない。この簡素化は未公開。

### 7.8 提案を採用した画面の簡素化（2026-10-09）

日刊①の検索文字列を索引の読み込み時に一度だけ正規化し、記事をキーにしたWeakMapから使い回す。元のrecordsと本文は書き換えず、タイトル・要約・要点・出典・カテゴリー・タグの一致と大小文字・空白の規則を維持。候補描画は条件を一度だけ組み立てる。

- Enter判定・②の送信可能な条件・伏せ字・入力と言語変更のリセット・停止時の0件の日英文言を共通化。計測停止の判定がlastTracked更新より先に行われる順序はそのまま残した。
- generation・年・URLの重複する正規表現の検査を整理。日刊URLは固定のパスの検査を先に行い、siteのURL検査は維持。
- `test-site-search-ui.mjs`に両媒体各1場面を追加。6項目それぞれの一致、大文字小文字・日本語の空白・従来どおり全角英字を変換しないこと、地域の絞り込みと入力中に送信しないことを確認。
- `node .github/scripts/test-site-search-ui.mjs --root _site`：全96場面通過（既存94・追加2）。Pythonは`test-daily-news.py`22件・`test-site-search-index.py`5件通過。変更したJS/Pythonの構文検査と`git diff --check`が成功。
- 共通daily-uiとsite-searchの参照を`20261009_4`へ更新。全57日刊HTMLはこの2つのJSの版以外が変更前とバイト単位で一致し、全55号の本文・dateModifiedと両誌の索引を保持。CSSとsearch-analyticsの版は変更なし。
- `build.sh`成功（653ファイル）。変更した58HTMLと共通JSの2ファイルが出荷物とバイト単位で一致。日付を保つため画面側のコミットに`Date-Sync: skip`を付ける。

この簡素化は未公開。実API・本番へは送っていない。手元ではGTM・Ahrefsを読み込めず、解析の検査はdataLayerまで。日刊②の停止設定と後続の評価・有効化の条件は維持。

### 7.9 追加簡素化の本番反映（2026-10-09）

本人の「本番環境反映して」の指示で、Workerの`c758670d`と画面の`24872851`を本番へ反映した。日刊②の`SITE_RANK_SCOPES="site"`を維持し、Jevによる日刊の判定は有効化していない。

- Workerを先にデプロイ。Version `30941fba-c221-4258-89d3-cca026cda584`、224.71KiB（gzip 63.20KiB）。本番DB・ルート・停止設定を確認。modelsは200のJSON、両誌の合成要求は200・`failed/disabled`・`searched:null`・`cached:false`。
- mainへpushし、Cloudflare Pagesの公開成功を確認。対象`24872851`、Deployment `5408a779-4c21-4fd0-811d-dd9458db8862`。モデル検査・人格カード・sitemapのActionsも成功。
- 14:56 JSTに本番の両ポータルをブラウザで確認。入力候補は最大6件・APIなし、明示Enterで本物のWorkerから停止応答を受け、①は利用可能。連続Enterで再送せず、URLは検索語なし、ページエラーなし。
- 両誌のheadと共通JSの2ファイルは手元の出荷内容と一致。nitori `2063db70449ba414`（176記事）、retail `88e2025867b34429`（204記事）。全参照の新版は`20261009_4`。本番404も404の応答で新版site-searchを参照。
- 本番の日刊ポータルの受け渡し5場面が通過。本物のGTM・Ahrefsを読み込み、解析の送信を記録して停止。`daily_search`・`daily_rank_run/result`を観測した。Jevの判定を含む日刊②の精度・応答時間・privacyの合格とは分ける。
- push前後に最新mainを確認。新しい号・人格カードは無し。sitemap botの`a3e4c182`はsitemapだけを更新し、号本文・dateModified・索引は変わっていない。手元へ取り込み済み。

生の証跡は非追跡の`workers/.wrangler/phase3-simplify-production-*`に保存。追加簡素化の公開は完了。次はT09で、日刊②の有効化の条件は維持。

### 7.10 T06〜T08のレビュー指摘への修正（2026-10-09）

本人の「必要に応じておすすめと思われる点を修正して」の指示で、3点の再現テストを先に追加した。修正前に、古いタブのindex_updating・初回中断後のretryAt・画面の索引が更新されない問題と、生成側が不正な題名・カテゴリー・タグを通すことを確認した。

- Workerの修正は`284e9212`。版ずれだけで既知の絞り込みを指定した要求には、再取得中・60秒の間隔の内でも24時間以内の完全な索引で答える。未知の絞り込みと24時間を超えた版は通さない。初回・通常取得の中断は取得前のretryAtへ戻し、強制取得の中断は60秒の制限を維持。
- 画面は応答と①のgenerationが異なれば索引を更新対象にする。確定済みの①とフォーカスは保ち、自動の再取得・再送はせず、次の検索で全年度を読み直す。版の新旧をハッシュから推測しない日英の案内に変更した。
- 生成側は不正な題名・カテゴリー・タグをValueErrorで止め、索引の書き出し前に検査する。媒体・号・記事番号・項目名を示す。既存の索引を変更しないことと40コードポイントの境界を両誌で確認。
- `node --test .github/scripts/test-magi2.mjs`：150件通過。古いタブの1秒・61秒・62秒・122秒、再取得中、24時間、初回中断直後の再試行、強制中断後の制限と既存の回帰を確認。通常更新の中断でretryAtを戻す追加の検査も通過。
- `node .github/scripts/test-site-search-ui.mjs --root _site`：98場面通過。両誌に古いタブの次回検索で版を更新する場面を追加し、①・フォーカス・自動送信なし・同じ条件の重複送信なしを確認。手元のGTM・Ahrefsの実通信は未確認で、解析の検査はdataLayerまで。
- Pythonの`test-daily-news.py`23件・`test-site-search-index.py`5件通過。JSの構文検査・`eval-site-rank.mjs --check`・`git diff --check`も成功。wranglerのdry-run成功（224.89KiB、gzip 63.26KiB）。
- daily-uiの版を`20261009_5`へ更新し、両誌を再生成。全57日刊HTMLはこの参照以外が変更前とバイト単位で一致し、全55号の本文・dateModifiedと索引を保持。`build.sh`成功（653ファイル）。変更した58公開ファイルは出荷物とバイト単位で一致。画面側のコミットに`Date-Sync: skip`を付ける。

この修正は未push・本番未反映。実APIの判定は行っていない。初回の並行要求のPromise共有は今回の対象から外した。`SITE_RANK_SCOPES="site"`とT11〜T13の公開条件を維持。生の証跡は非追跡の`workers/.wrangler/daily-fixes-*`に保存。次はT09。

### 7.11 レビュー指摘の修正の本番反映（2026-10-09）

本人の「本番反映して」の指示で、`284e9212`（Worker）・`beac050e`（画面と生成側）を反映した。日刊②の停止設定`SITE_RANK_SCOPES="site"`を維持し、有効化とJevの実判定は行っていない。

- 最新mainを取得し、人格カード・新しい号の追加が無いことを確認してからWorkerをデプロイ。Version `106b3f83-0fe6-48b5-9d83-a3405118ab2e`、224.89KiB（gzip 63.26KiB）。本番DB・ルート・停止設定が一致。modelsは200のJSON、両誌の正しいrank要求は200・`failed/disabled`・`searched:null`・`cached:false`。
- mainへpushし、Cloudflare Pagesの公開成功を確認。対象`beac050e`、Deployment `e8d87229-b242-47ef-91a1-3e0eac766c47`。AIモデル検査・人格カード・sitemapのActionsも成功。
- 16:04 JSTに本番の両ポータルを確認。入力候補は最大6件でAPIなし、明示Enterで本物のWorkerから停止応答を受け、①を利用できる。連続Enterで再送せず、検索語がURLに残らず、ページエラーなし。
- 両誌のheadと共通JSは出荷内容と一致。nitori `2063db70449ba414`（176記事）、retail `88e2025867b34429`（204記事）。daily-uiは`20261009_5`、site-searchは`20261009_4`。両最新号のHTMLもCloudflareの解析・チャレンジの差し込みだけを除けば出荷内容と一致し、記事本文とdateModifiedを保持。
- 本番の日刊ポータルの受け渡し5場面が通過。本物のGTM・Ahrefsを読み込み、解析の送信を記録して停止。`daily_search`・`daily_rank_run/result`を観測。停止中の画面と受け渡しの確認であり、日刊②を有効化した精度・応答時間・privacyの合格には数えない。
- 公開後のsitemap botの`7b132e69`はsitemapだけを更新。号本文・dateModified・索引・人格カードは変わっていない。手元にも取り込み済み。

生の証跡は非追跡の`workers/.wrangler/daily-fixes-production-*`へ保存。本番反映は完了。次はT09で、日刊②の有効化には引き続きT11〜T13の合格が必要。

### 7.12 T09の固定セットと評価CLI（2026-10-09）

元コミット`9b0dd28bc3eeebfbd41dc2ba27033d1760666c75`の公開索引を`.github/site-search/fixtures/phase3/`へ固定した。nitori176記事・retail204記事、両誌とも現在保存済みの全年度は2026年だけ。実際の複数年度の精度を測ったとは扱わない。正解はCodexが候補選び・APIの結果を見る前に、条件を当てた全記事の題名・要約から付けた（本人未確認）。

- `phase3-rank-queries.json`は各媒体tune30・final30の計120問。各splitの答え無しは6問、keyword・sentence・paraphrase・englishも各6問。古い記事、商品・経営、month/category/region、同じ号の別記事、字の重ならない正解を含む。速度の24問も各finalから事前に固定した（英語5問・答え無し6問を含む）。
- 元コミット、固定日、担当、全ファイルのSHA-256、generation・index_hash・candidate_hashを保存。fixtureはバイト単位で元コミットと一致し、Gitの改行変換を止めた。公開索引・号本文・地域の値は変更していない。
- `eval-daily-rank.mjs`はWorkerの全年度の検査・filters・20候補・変換・問い・確率・閾値・並び・URL検査を使用。オフラインのcheck/plan/candidatesと、Jevを直接呼ぶaccuracy、保存済み記録のreport、本番ブラウザのprobe/browserを実装。新しいnpm依存はない。siteのCLIの処理は変更せず、共通の読み込み・キー・ブラウザ・応答検査をexportして借りた。
- 各run・各問の候補ID・確率・HTTP・失敗・Jev応答のモデル版・usage・時間・生の本文と、問い・コード・設定・索引のhashを記録する。tuneの閾値比較は1応答を再生し、追加のAPI呼び出しはしない。部分記録を保持し、欠けた問や失敗を分母から除かない。精度の2回を平均して合格にはしない。
- 速度の各要求にrequest_id・generation・cached・N/M/J・complete・結果ID・時間を保存。キャッシュ・版ずれ・rate_limited・index_updating・記録の欠落を不成立とし、失敗/timeoutは実時間と8秒の大きい方でp95へ入れる。2回目の同一UTC日・24問・hashとVersion ID・キャッシュ期限＋余裕を検査し、既知の測定の1媒体50回/日と重複も確認する。共有上限の残量はunknownと記録する。本番の実行は未実施。
- 両媒体×3年度の合成fixtureを別に用意。年末年始・閏日・同じ号の別アンカー・長文・Unicode・20件を超える対象と、混版・欠落・暦・媒体・重複・制御文字を検証。合成fixtureを精度の分母に混ぜない。

手元のtuneの候補recallはnitori **19/24（79.2%）**、retail **20/24（83.3%）**。ともに90%未満でT10の条件に該当する。これはJevの判定精度ではない。正解やfinalを候補の結果に合わせて直していない。finalのrecall・精度は未評価。

`--plan --set tune --runs 2`で各媒体60要求、現在の候補・問いでnitori約$0.0593、retail約$0.0616の概算を確認。入力トークン数をpayloadのUTF-8バイト数と置いた概算で、実usageとは異なる。公式料金の照合日とURLをCLIに残す。T10後と実測直前に見積もり・モデル・契約・料金を再確認する。詳しい使い方・固定セットの根拠は[README](../.github/site-search/fixtures/phase3/README.md)。

検証：`node --test .github/scripts/test-daily-rank.mjs`18件、`test-magi2.mjs`150件通過。`eval-daily-rank.mjs --check`、両媒体のplan・tune candidates、既存`eval-site-rank.mjs --check`・`--smoke-payload`が成功。JS構文・`ai_models.py check`・`git diff --check`も成功。最新origin/mainは基点と同じで、新しい号の追加は無し。実API・本番へは送信していない。生の記録は非追跡の`workers/.wrangler/daily-rank-*`へ保存。このT09は未push。次はT10で、日刊②の停止とT11〜T13の公開条件を維持。

### 7.13 T10の言い換え語と過去分の補完（2026-10-09）

T09のtuneで90%未満だったため、設計書5.1のsearch_termsを実装した。今後の号は既存のLLM呼び出しの出力に3〜5語を加え、追加のAPI呼び出しは行わない。過去分はLLMではなく、本文にある概念の日本語・英語の辞書で一度補完した。評価の検索語・正解IDを生成処理から読まない。生成が欠けた・不正な語を返した場合も、APIを呼び直さず同じ規則で補う。

- 生成側とWorkerで、任意のsearch_termsの配列・3〜5語・各60コードポイント・重複なし・制御文字なしを検査。語の無い旧索引も読める。語があるのに不正な1行は、索引全体の取得失敗にする。語はsummary・tags・categoryと同じ軽い重みで候補選びにだけ使い、Jevの変換・画面①・結果の本文に足さない。
- `--backfill-search-terms`を両生成CLIへ追加。load_history/save_historyを通し、全年度の構築を検査してから保存。既存の語は上書きせず、不正な既存値は保存前に止める。dry-run・2回目の0件・X投稿IDを含む履歴の保持・HTML/RSSの保持を検証。
- 全380記事（nitori176・retail204）を補完。Gitの元データと比べ、履歴JSONはsearch_terms以外が完全に一致。全57日刊HTML・両RSSは変更前とバイト単位で一致し、号本文・dateModified・公開URL・記事番号を保持。HTML/JSの参照の更新は不要。コミットにDate-Sync: skipを付ける。
- 日刊のrevisionをそれぞれ1→2へ更新。閾値0.4・20候補・問いは維持。siteのrevision・閾値・候補・問いと、SITE_RANK_SCOPES="site"は変更していない。
- `with-search-terms/`へ補完後の全年度の索引とmanifestを固定。元のT09のfixture、120問の問い・正解・filters・split・速度24問はバイト単位で保持。manifestに元のindex_hash・補完規則のSHA-256・補完後のgeneration/hashを保存し、CLIの`--index-set terms`で明示して使う。Jevのcandidate_hashは両媒体ともT09と同じ。最初の語の一致ゼロという条件は、語を足す前の題名・要約で検査する。

補完後のtuneの候補recallは両誌 **24/24（100%）**。元のnitori19/24・retail20/24から改善し、T10の候補選びの条件を満たした。finalの候補recall・Jevの精度・本番の速度を合格と扱わない。次の実測の索引はnitori `021c767db6e4df27`、retail `13d28fe0e9fcb24d`。詳しい手順は[補完後のfixture README](../.github/site-search/fixtures/phase3/with-search-terms/README.md)。

検証：評価器23件、模擬Worker150件、Pythonの日刊28件・索引5件通過。画面は既存98場面が通過し、新規の言い換え語の2場面もテストの呼び出し名を直して個別に再実行し通過（計100場面）。①のドロップダウン・横断検索が語を使わず、明示した②だけを送ることを両媒体で確認。手元でGTM・Ahrefsを読み込めず、実計測のprivacyの合格には数えない。

build.sh成功（653ファイル）。履歴JSON・索引・全日刊HTML/RSSが出荷物と一致。wranglerのdry-run成功（225.34KiB、gzip 63.34KiB）、本番の停止設定を維持。JS構文・既存site評価CLIのcheck・AIモデル設定・差分検査も成功。補完前に最新mainを取得し、日刊の追加が無いことを確認した。実API・本番へは送っていない。生のログは非追跡のworkers/.wrangler/t10-*・daily-rank-*に保存。

補完後のtuneを2回なら各媒体60要求。現在のpayloadで概算はnitori約$0.0593、retail約$0.0616（UTF-8バイト数を入力トークン数と置いた概算）。単価・モデル・契約は実測直前に再確認する。このT10は未push・本番未反映。次はT11で、日刊②の停止とT11〜T13の公開条件を維持。

### 7.14 T10の簡素化（2026-10-09）

過去分の補完では、保存前に構築・検査した索引をそのまま保存し、同じ索引の二重生成を除いた。補完語は題名に一致したもの、要約だけに一致したものの順で辞書順を保持し、重み・順番号・ソートを除いた。評価CLIはfixtureの検査を通した生成規則のハッシュを記録にも使い、ソースの再読み込みを除いた。

変更前のコードと全380記事・境界および生成例1,018件を比較し、補完語と順序が一致。両誌の索引の内容・generationと固定fixtureのバイトも保持した。manifestは生成規則のソースハッシュだけを更新し、固定120問・元の索引・補完後の索引は変更していない。

検証：日刊Python28件・評価器23件が通過。補完前後のfixtureのCLI検査、両媒体・両索引のplanとハッシュの記録、JS構文・差分検査が成功。保存処理を模擬して、媒体ごとの索引構築が1回になり、保存する内容と入力履歴が維持されることも確認した。保存前の検査・dry-run・不正な既存値の拒否は保持。実API・本番へは送っていない。

### 7.15 T06以降のレビュー指摘の修正（2026-10-09）

T06からT10の簡素化までを見直し、生成側の型検査と企業名の誤補完を修正した。

- 索引のsummary・sourceなどの文字列を検査し、null・数値・配列などを拒否する。summary・sourceの省略時は従来の空文字を保持。通常発行と全号の再生成も、履歴やHTML/RSSを保存する前に全年度の索引を検査し、構築済みの索引をそのまま保存する。不正な値があれば媒体・号・記事番号・項目名を示して止める。
- 両媒体の通常発行・全号再生成・索引再生成・過去分補完で、不正なsummary/sourceがあると保存処理やHTML/RSSの生成へ進まないことを確認。既存ポータル・RSS・索引の保持と、正常な発行・再生成で履歴と索引が保存されることも確認した。
- 「メタバース」「メタデータ」をMetaへ、「コーチング」をCoachへ補完しない。Coachは服飾の文脈を要する。実際の企業・ブランド名、中黒で区切った名前、日本語と英語の表記は回帰テストで保持。接客のコーチング20記事と古いCoachブランド記事の合成ケースでは、修正前はブランド記事が候補から落ち、修正後は20候補の先頭に入ることをPythonの生成処理とWorkerの候補選びで確認した。
- 既存380記事の補完語と順序は変更前および保存済みの値と一致。生成した索引は公開用ファイル・固定fixtureとバイト単位で一致し、generationはnitori `021c767db6e4df27`・retail `13d28fe0e9fcb24d`のまま。fixtureのmanifestは生成規則のソースハッシュだけを更新。固定120問・正解・filters・split・両版の索引は変更していない。

検証：日刊Python32件・評価器24件が通過。補完前後のfixtureのCLI検査とJS構文・差分検査が成功。補完後のtuneの候補recallは両媒体24/24を維持。final・実APIは未評価。ログとtuneの候補記録は非追跡のworkers/.wrangler/fix-review-*・daily-rank-candidates-*へ保存。公開用データ・HTML・ブラウザ資産・Workerのコードと停止設定は変更していない。この修正は未push・本番未反映。

### 7.16 T09・T10・レビュー修正の本番反映（2026-10-09）

本人の「本番反映して」の指示で、T09 `5e0607d1`・T10 `8cb98854`・簡素化 `2f443234`・レビュー修正 `8d56741c`をmainへpushした。日刊②の停止設定を維持し、実APIの評価と有効化は行っていない。

- 公開前に最新mainを取得し、追加の号・他の変更が無いことを確認。Worker150件・日刊Python32件・評価器24件・画面100場面が通過。build.sh成功（653ファイル）。出荷する履歴JSONと両誌の索引が、検査済みの履歴・索引と一致。
- magi2の本番デプロイ成功。Version `1a181c67-d462-4c52-bba0-5f97e0788eb3`、225.34KiB（gzip 63.34KiB）。本番DB・ルートと`SITE_RANK_SCOPES="site"`を確認。modelsは200のJSON、両日刊scopeは200・failed/disabled・searched:null・cached:false。
- [Cloudflare Pages](https://dash.cloudflare.com/28a9a66a67a07a598cb99f7cc0ab54ed/pages/view/st/8e40e2e7-9f98-4faa-982f-e2ceecac040d)の対象コミット`8d56741c`・Deployment `8e40e2e7-9f98-4faa-982f-e2ceecac040d`の公開成功をGitHubのcheckでも確認。AIモデル検査・人格カード・sitemapのActionsも成功。
- 17:53 JSTに本番の両ポータルをブラウザで確認。nitori176記事・generation `021c767db6e4df27`、retail204記事・generation `13d28fe0e9fcb24d`。索引と共通JSが手元の公開物と一致。入力候補は最大6件でAPIなし、明示Enterは停止応答を受け①が使える。連続Enterで再送せず、検索語はURLに残らず、ページエラーなし。

本番の画面確認では解析を停止している。手元の100場面でもGTM・Ahrefsを読み込めず、実計測を含むprivacyの合格には数えない。生の証跡は非追跡のworkers/.wrangler/t10-production-*へ保存。公開後のmainにも追加変更が無いことを確認した。次はT11で、日刊②の停止とT11〜T13の公開条件を維持。
