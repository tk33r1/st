# Phase 4 実装着手の記録

2026-10-12更新（着手は2026-10-11）。ローカルの実装・部分検証。Phase 4の完了／公開記録ではない。正本の作業表は[実装計画](../../../assets/site-search-phase4-plan.md)7章。

## できたもの

- `japanese_search.py`と`search-reading-index.py`: 固定したSudachi B/C、フィールド付き共有語彙・postings、未知の漢字の読みを推測しない生成。UTF-8の生バイト列hash・正本ID順・日刊の媒体／年度／世代を検査し、すべての入力を検査してから別ディレクトリへ出力する。
- `japanese-search.js`: 純粋な文字／読みの照合。空白区切りANDと旧文字一致の和集合、途中子音・n/nn/n'・促音・拗音・長音、共通順位、年別読みの原子的な統合。全件と件数を保持する。
- `search-ui.js/css`: `STSearchUI.mount(container, adapter)`、候補6件、全候補と100件ずつの追加、①②の重複除去、IME中の送信抑止、入力／filter変更による旧応答破棄。1画面1回の共有復帰で文字検索と最新入力を保ち、②を自動再送しない。
- `site-search.js`: 描画しない`createRankClient`／`readRankResponse`を追加。新しい同一サイトPOSTのscope・filters・世代・件数・URLを検査する。旧`rank/readResponse`は維持。既存3ページとテンプレートの参照を20261011_1へ更新。
- 固定fixture・単体／生成／ブラウザ検証と測定スクリプト。2026-10-11時点ではJevへの実通信は未実施。翌日の実測は後述。

- `search-data.js`: 固定URLのscope別adapter。ブラウザはtools/gameで自分の正本と読みだけを取得。日刊は全年度・生バイト列hash・manifest・ID順を照合する。filters／同点順／通常カタログの接続を宣言する。
- 404・日刊2誌・tools/gameを同じUIへ接続。404の③とURL補正の候補、日刊の号→ポータル受け渡しを残す。通常カタログは入力が空なら表示する。toolsのCSP・処理内容の非送信・解析停止は保持する。
- Workerの固定新入口・tools/game・共有取得・60秒の更新制限・世代先行照合・同じIP／全体上限・評価認可を実装。旧入口は従来の3scopeだけを受け付ける。未確定／混在ではJevと回数ゼロ。公開設定の新scopeは停止したまま。
- `build.sh`: hash固定の解析依存を非公開の隔離環境へ入れ、出荷索引から読みと`search-tree.py`の94ページのツリーを生成。WindowsのGit Bashで出荷検査通過。673ファイル。Linux／Pagesでの導入は残る。

**未公開。** 2026-10-12に60語の読み・新scopeの実Jevと同形smoke・共通UIの入力速度・実adapterの7,500件準備・Windows生成側とブラウザのメモリを評価。続きの改善後、実adapterの準備は約2.7〜3.2秒。toolsは0.4、gameは0.5へ固定。初回入力・準備中の短い停止、Linux／Pages、実機IME／読み上げ、本番での確認は残る。

## 依存と再現性

Python 3.13.7、Node 24.14.1、Playwright 1.56.1、Chromium 141.0.7390.37、Windowsで検証。Python環境は`.github/scripts/.search-reading-env/`に隔離しGitで除外。辞書・Python依存を公開assetsへ置いていない。

| 対象 | 固定値 |
| --- | --- |
| 解析器 | SudachiPy 0.6.11 |
| 辞書 | SudachiDict-core 20260428 |
| 分割 | B・C両方 |
| 辞書本体SHA-256 | `6c1d5adc8a2389875713056e7b39bbcd0073d6122ffd509866e1d3a196f8608e` |
| 補正正本SHA-256 | `af5380463ff7273669352d9c6cdad10850bef2ad068f3b4fa5165b4053c86328` |
| 補正 | `config/search-readings.json`、aliasesは空。根拠のない追記はしない |
| 依存の入れ方 | `pip install --require-hashes --only-binary=:all: -r .github/scripts/search-reading-requirements.txt` |

wheelは[公式PyPIのSudachiPy](https://pypi.org/project/SudachiPy/0.6.11/)と[SudachiDict-core](https://pypi.org/project/SudachiDict-core/20260428/)のhashで固定。両者の同梱metadataとライセンスはApache 2.0。20260428の辞書metadataの`SudachiPy>=0.5,<0.7`と一致する組合せを採用。Linux／Pages実環境での導入・辞書RAM・取得時間は未測定。

## 現行データの試験生成

作業ツリーの公開対象HTMLから既存生成器で作った94ページのサイト索引と、現在の正本一覧／2誌の索引を入力した。その後の出荷ビルド`_site`も同じ件数・読みhashで通過。日刊は2026年だけが現行年度で、空の年と世代混在は合成fixtureで検証した。

| 読み | 件数 | 語彙 | postings | raw bytes | gzip bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 全サイト | 94 | 1,821 | 4,824 | 150,027 | 25,662 |
| tools | 9 | 191 | 266 | 13,494 | 2,954 |
| game | 8 | 74 | 126 | 5,476 | 1,401 |
| 日刊ニトリ | 191 | 3,425 | 12,396 | 308,167 | 57,174 |
| 日刊リテールテック | 211 | 3,474 | 13,157 | 322,673 | 61,252 |

404用基礎JSONはraw 194,403 bytes／gzip 23,819 bytes。サイト基礎・サイト読み・2一覧の読みの追加分は合計raw 363,400 bytes／gzip 53,836 bytes。生成全体は0.7244秒（インストールと辞書初期化を除く）。未知語48個は主に数詞であり、文字検索に残す。未知語の一覧だけで精度合格とはしない。

## 大規模な事前測定

実記事402件をもとに、語彙を共有するものと、各記事に別々のかな語を足すものを固定。本文・フィールドは切らず、重複レコードのコピーだけで容量を評価しない。

| fixture | raw bytes | gzip bytes | 生成秒 |
| --- | ---: | ---: | ---: |
| 1,000件・共有語彙 | 867,029 | 196,335 | 0.5981 |
| 1,000件・別語彙 | 989,668 | 213,258 | 0.3653 |
| 10,000件・共有語彙 | 6,151,082 | 1,688,693 | 0.8705 |
| 10,000件・別語彙 | 7,300,652 | 1,833,388 | 3.3908 |

ブラウザ測定は1280×800、CDPでCPU4倍減速、固定20入力×5、準備と入力時処理を分離、各3回。純粋な照合と6件のDOM更新・layoutまでを測った事前試験で、実ページの共通UI／IME／paintまでの正式測定ではない。年別統合APIの追加前の測定であり、最終実装で再測定する。

| fixture | 準備ms | p95・3回のms | Brotli bytes |
| --- | ---: | --- | ---: |
| 1,000件・共有語彙 | 196.1 | 5.4 / 5.1 / 5.0 | 139,231 |
| 1,000件・別語彙 | 248.6 | 5.5 / 5.4 / 5.8 | 147,382 |
| 10,000件・共有語彙 | 1,453.8 | 51.2 / 42.9 / 45.0 | 883,732 |
| 10,000件・別語彙 | 1,606.8 | 45.1 / 44.3 / 43.6 | 951,179 |

**この2026-10-11の事前測定では10k入力p95≤50msは未合格**。2026-10-12の共通UI測定は後述。最速値だけを採用しない。読みの準備も同期で1秒以上あり、非同期化・実UI接続後の入力阻害を検証する。1kのraw≤1MiB／gzip≤256KiBと10k生成≤60秒は事前fixtureでは範囲内だが、正式な出荷環境での判定は残る。

## 通過したローカル検証

| 検証 | 結果 |
| --- | --- |
| `node --test .github/scripts/test-japanese-search.mjs .github/scripts/test-search-rank-client.mjs` | 18件（2026-10-12追加分を含む）。22必須途中入力、AND／旧文字一致、読みの原子的採用、新通信検査・中止・重複送信抑止 |
| 隔離Pythonで`test-search-readings.py` | 6件。実辞書の再現性、未知漢字、全文保持、ID／URL／年度／空の年／混在 |
| `test-search-reading-integration.mjs`＋試験生成先 | Python→ブラウザの生バイト列hash・ID順・日刊manifest、全402記事の題名、DJ／Thought等を照合 |
| `test-phase4-search-ui.mjs` | 同じUIを5scopeで固定データ検証。250件、最大6候補、100件ずつ、重複除去前の総件数、sort／filters／locale／IME抑止、復帰1回、遅い応答破棄。Jevは固定応答 |
| `test-phase4-legacy-ui.mjs` | 旧404・2誌のポータルHTML／JSに新site-search.jsだけを差し替えて検証。旧2号→旧ポータルの受け渡しもPOSTゼロ。新UI／CSSの読み込み不要 |

旧HTML fixtureの基準はcommit `ec5a1ab481d02757abae2458233144ae8b870278`。7ファイルの生バイト列hashを`legacy-contract.json`に固定。日刊の参照更新と検索領域の変更は`daily_engine.render_top_index_html`・`write_issue_page`と`keep_date_modified`を通した。59号は本文・dateModified・参照以外がGitの基準版と同じと確認した。ポータルの検索領域は意図した変更。履歴JSON・日刊基礎索引・RSSは変更していない。

追加の検証:

- `test-phase4-rank-worker.mjs` 10件＋既存Worker／日刊回帰179件、合計189件通過。5scope、旧入口拒否、scope先行filter、版ずれ／混在時の回数・Jevゼロ、並行・旧要求との取得共有、切断、評価専用認可、旧キャッシュ禁止を確認。
- Worker `wrangler deploy --dry-run` 通過。239.42KiB／gzip66.25KiB。公開は行っていない。ローカルログの書き込み警告は出たがバンドルと終了コードは成功。
- `test-phase4-search-data.mjs`、`test-search-reading-integration.mjs _site` 通過。全402記事の題名・各sourceのraw hash・ID順・年別manifestを確認。
- `test-phase4-pages.mjs _site` 通過。出荷HTML／JS／読みを使い、5scopeの明示新POST、最大100件・②の重複除去、同条件の再送抑止、入力で破棄、日刊59号のうち最新2号の受け渡しとURL消去／POSTゼロ、toolsのCSP・自分の索引だけの取得、404③の提示と入力時消去を確認。外部通信は固定応答で、本番Jev・解析へは送っていない。
- 生成Python6件・既存公開索引Python5件通過。既存索引テストの一時領域はWindows sandboxの外へ出ず、リポジトリ内に指定して検証した。
- Workerの新検証で使う公開索引を`site-index.json`へ固定。SHA-256 `4605765760ffff1da585bdb64da13cf3420eed62d08f9f3e905519707622aa06`。出荷用の索引は都度生成し、fixtureを出荷しない。

## 次に検証するもの

1. T02／T11の初回入力・準備中の短い停止、Linux／Pagesでの依存導入とRAM・取得時間を確認する。Windowsの生成側／ブラウザと実adapterの測定は下記。
2. T17の実Jev／同形smokeは後述の通り評価済み。本番Workerの評価認可・画面経由の測定と公開版の照合が残る。
3. 実機IME／読み上げ・焦点の全ケース・ツリーと、実計測を用いるURL回帰を確認する。320/768/1440pxとCSS200%は下記のローカル検証済み。
4. 最新botを取り込み、公開用のWorker／Pages組合せを確認し、本人の公開指示に沿ってWorkerを先に出す。

commit・push・Worker／Pagesの公開は未実施。本番の新scopeを有効化していない。Phase 4の合格／完了は未宣言。

## 2026-10-12の追加実装・評価

準備・読みの検査を中断可能な分割処理へ変更し、検証が完了した読みだけを原子的に採用する。語ごとの得点は最大32件を保持し、filterとsortを跨いで使う。同点順を保持したまま点数別に束ねる。入力中の6候補は題名を表示し、説明は確定した①②へ表示する。同じ状態ではlive regionを再更新しない。

大きな公開JSONはページのCSPを受け継ぐBlob Workerで解析し、値を小分けに主スレッドへ受け渡す。辞書はダウンロードせず、Workerは通信しない。Worker非対応／コード取得失敗では同じ取得済みバイト列へ縮退し、取消時は採用しない。主スレッド解析へ縮退した場合の停止時間は保証しない。

### 読みとJev

事前注釈した一般60語はtune／finalとも29/30（96.7%）。文字一致の救済と読み到達を別に評価した。電子機器／電気自動車は辞書の語境界で分かれ、複合語全体の読みでは届かなかった。合格のための補正追記はしていない。[tune](reading-tune-20261012.json)・[final](reading-final-20261012.json)に記録。

新scopeはAPI実行前に80問を固定した。tuneでtools 0.4/rev1、game 0.5/rev2を固定し、各scopeのfinalを2回実行。正解到達は両回100%、正解なしへの誤表示は0。gameの原作指定の1問では続編も余分に表示され、候補集合が揺れた。finalを見て閾値や正解を変更していない。週次と同形のsmokeも通過。実通信162要求・入力427,653 tokens、公式単価で計算した費用は約$0.01796（請求額の照合ではない）。[評価条件・結果・再実行方法](rank/README.md)。公開scope許可はsite/nitori/retailのまま。

### 大規模な共通UIと実adapter

Chromium 141・CPU4倍抑制・1280×800・固定20入力×5・3回。入力イベントから6候補DOM/layoutまで。paint・実機IMEは含まない。各測定開始時のソースSHAと全入力値を記録する。

| 共通UI fixture | 準備ms | 入力p95・3回のms | 最初の20入力p95・初回のms |
| --- | ---: | --- | ---: |
| 1,000件・共有語彙 | 1,889.8 | 21.5 / 5.4 / 6.3 | 42.5 |
| 1,000件・別語彙 | 1,841.7 | 23.5 / 5.8 / 6.2 | 47.2 |
| 10,000件・共有語彙 | 13,204.1 | 42.2 / 18.2 / 18.6 | 59.2 |
| 10,000件・別語彙 | 14,513.4 | 47.8 / 18.4 / 20.2 | 63.1 |

[共通UIの記録](ui-measurements-20261012.json)。これは固定fixtureを受け取るadapterで共通UIを測った値。契約の100入力p95は各3回通過したが、最初の20入力だけでは10kの50ms目標を超える。最速値だけを選ばない。

実日刊adapterで同じ10k fixtureを読み込むと基礎JSONが10,094,004／10,494,004 bytesとなり、既存8MiB上限で拒否された。[拒否の記録](ui-adapter-limit-20261012.json)の小さい入力時間は不採用で、速度合格には数えない。上限を緩めず、各記事の本文と検索フィールドを保った先頭7,500件を追加測定した。元のfixture名と元ファイルSHAを記録し、`records=7500`と明記する。10kの契約とは別の確認である。

| 実adapter | 基礎／読みbytes | 準備ms | 入力p95・3回のms | 準備中の最大heartbeat間隔ms |
| --- | --- | ---: | --- | ---: |
| 1,000件・共有語彙 | 1,006,839 / 880,031 | 2,453.6 | 24.8 / 5.2 / 5.3 | 158.3 |
| 1,000件・別語彙 | 1,046,839 / 1,002,670 | 2,462.2 | 23.2 / 5.2 / 5.9 | 153.6 |
| 7,500件・共有語彙 | 7,569,153 / 4,780,172 | 14,409.8 | 48.8 / 14.4 / 14.3 | 220.1 |
| 7,500件・別語彙 | 7,869,153 / 5,656,763 | 15,143.6 | 41.5 / 14.6 / 14.0 | 248.3 |

[実adapterの記録](ui-adapter-7500-20261012.json)。全ケースで読みはready、準備中の最後の入力を保持し、②は送信していない。初回20入力のp95は7,500件で71.7／74.2ms。準備は分割しても約15秒かかり、最大約0.25秒止まる点は残る。ブラウザRAM・実機の体感・Linux／Pagesは未確認。

再実行は、固定fixture生成後に`node .github/scripts/measure-search-ui.mjs <fixture-directory> <report-directory>`、実adapterは同じ入力へ`--adapter --records=7500`を付ける。レコードの内容や数を変更した測定を10kの結果として扱わない。

Windowsの生成側メモリは同じ10k fixtureをケースごとの別プロセスで追加測定した。辞書初期化は約0.258秒。共有語彙の生成は1.303秒／ピーク234.7MiB、別語彙は3.837秒／ピーク285.5MiB。ピークは辞書のhash照合・マッピング・fixture・生成を含むプロセス全体のPeakWorkingSetSizeで、定常利用量ではない。2ケースは同時に実行した。入力SHA・出力SHA・測定スクリプトSHAを[共有語彙](reading-memory-shared-20261012.json)・[別語彙](reading-memory-distinct-20261012.json)へ記録した。`measure-search-reading-memory.py --case shared|distinct --output <report>`で再現する。依存取得・Linux／Pages・ブラウザRAMを含む値にはしない。

### 画面と回帰

5scopeで320/768/1440pxとCSS200%の横方向のはみ出し、候補最大6件、矢印／Escape／入力焦点、同じ状態でlive regionを再通知しないことを確認。CSS拡大はOS拡大・実機読み上げの代用とはしない。`test-phase4-layout.mjs`で再現する。JSON Workerの内容保持・不正入力・同じ生バイト列への縮退・中止を4件検証し、照合・通信・一覧評価と合わせ22件通過。既存Worker系189件と重複しない合計は211件。実HTML・旧HTML互換・Python生成の検証は別途行う。

Worker dry-runはログ先を隔離して警告なしで通過（239.41KiB／gzip66.25KiB）。公開処理ではない。

最終出荷ビルドは674ファイルで検査通過。解析用Workerを必須ファイルへ追加し、共通3ライブラリの5画面・日刊生成器の参照を`20261012_2`へ統一した。現行の読みは上記5ファイルと同じhashで再生成。5実画面・最新2号の受け渡し、旧HTML互換、共通UI、320/768/1440px・CSS200%、実adapter／読みmanifestの照合、AIモデル設定の検査を最終ソースで再確認した。APIや解析の外部通信は画面試験では固定応答にしており、本番検証の代わりではない。

最終のWorker回帰189件も通過。sandbox内の初回実行はローカルHTTPを使う既存2件が失敗したため、同じ2件でローカル通信条件を確認し、通信可能な条件で189件を再実行した。AI・メールの実送信は行っていない。追加22件と合わせ211件が通過。構文検査は44スクリプト・64HTMLのscript／JSON-LD・81JSON、`git diff --check`を確認。出荷した共通JS/CSSのバイト列は作業ソースと一致する。

## 2026-10-12の続き：準備時間とブラウザメモリ

大きなdigestの引数コピーも主スレッドで長くかかる例があったため、256KiB以上では生バイトSHA-256とJSON解析の両方をBlob Workerへ移した。失敗時用に同じ取得済みバイト列を保持し、解析するArrayBufferを移譲する。Worker失敗が移譲の前／後のどちらでも再fetchせず同じ内容へ縮退する。hashは整形前のバイト列に対して求める。

準備の分割は`postTask`のbackgroundで再開し、タイマーの入れ子による待機を減らす。既定の`yield()`でタイマーが長く待たされる診断例は採用しなかった。未対応ではタイマーへ縮退する。同じ条件・読みの原子的採用・取消・Jev実行条件は維持した。優先度の説明は[Scheduling APIの仕様](https://wicg.github.io/scheduling-apis/#task-and-continuation-priorities)を参照。

正式測定は同じCPU4倍抑制・固定20入力×5・3回、監視なしで実行し、ブラウザ検証やビルドとは重ねなかった。以前の表と記録は改変せず残す。

| 共通UI fixture | 準備ms | 入力p95・3回のms | 初回20入力p95 ms |
| --- | ---: | --- | ---: |
| 1,000件・共有語彙 | 662.8 | 24.0 / 4.8 / 4.5 | 43.1 |
| 1,000件・別語彙 | 689.2 | 22.7 / 5.4 / 5.4 | 47.6 |
| 10,000件・共有語彙 | 3,290.2 | 39.4 / 14.5 / 14.4 | 57.8 |
| 10,000件・別語彙 | 3,548.3 | 41.9 / 15.0 / 15.6 | 55.8 |

[共通UIの修正後記録](ui-scheduled-20261012.json)。共通UIへの固定fixture受け渡しでは大きなfixture JSONの取得・解析を主スレッドへ置くため、準備中の最大heartbeat間隔525.3／536.1msは実adapterの値と混同しない。入力p95は各3回通過。初回20入力の10kは引き続き50msを超える。

| 実日刊adapter | 準備ms | 入力p95・3回のms | 初回20入力p95 ms | 最大heartbeat間隔ms |
| --- | ---: | --- | ---: | ---: |
| 1,000件・共有語彙 | 826.9 | 26.0 / 4.5 / 4.7 | 39.6 | 166.4 |
| 1,000件・別語彙 | 910.4 | 26.5 / 5.0 / 5.6 | 49.1 | 182.7 |
| 7,500件・共有語彙 | 2,678.6 | 48.0 / 14.3 / 14.4 | 70.9 | 199.7 |
| 7,500件・別語彙 | 3,209.0 | 41.3 / 14.9 / 14.2 | 69.5 | 224.8 |

[実adapterの修正後記録](ui-adapter-scheduled-20261012.json)。記事本文・検索フィールド・元fixtureを保持。全件の読み採用と準備中の入力保持を確認。8MiB上限は緩めていない。7,500件の準備は14.4／15.1秒から2.7／3.2秒へ短縮したが、初回入力と最大約0.225秒の停止は残る。`--case`でケースを選べる。監視付きの`--profile`／`--memory`を正式な速度の合否へ使わない。

ブラウザメモリは別語彙7,500件で200ms間隔の採取と、ready／破棄後の明示GCで確認した。[メモリ診断記録](browser-memory-20261012.json)は速度判定と分ける。主フレームのJS heapの採取最大は約81.5MiB、ready後GCで約24.7MiB、破棄後GCで約1.45MiB。Chromiumのbrowser／renderer／GPU／network各プロセスのWindows private bytes合計は採取最大約251.1MiB、ready後GCで約135.5MiB、破棄後GCで約122.2MiB。これは42採取点の最大で、瞬間ピークの保証ではない。Runtimeのheap値にWorker heapは含めず、Workerの使用はプロセス側だけに含む。private bytesをRSSと呼ばない（[Microsoftの定義](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.privatememorysize64)）。OS・エンジンを跨いだメモリ保証や長時間の漏れ検査とはしない。

再現は速度測定と同じ引数に`--case=10000-distinct --adapter --records=7500 --memory`を付ける。Windowsの採取はCDPのPIDだけを`search-browser-memory.ps1`で読み、公開記録にはPIDを保存しない。監視なしの正式測定と診断の実行を混ぜない。

5scopeではCDPの`imeSetComposition`→Enter keydown→`insertText`→keyupを通し、Chromiumのpreeditと確定に伴うイベントから②が送られないことを確認した。OSの日本語IME・実機読み上げの代用とはしない。scheduler非対応のタイマー縮退も確認。Workerの検証には移譲後の失敗と生バイトhash一致を追加し、取得済みデータへの縮退を検査した。

速度・メモリ測定の参照は`20261012_3`。その後、sortの変更でもPRD3.4どおり②を破棄して次の明示実行を待つよう修正し、5scopeの検査へ追加した。準備・照合・input処理は測定時と同じ。最終の5画面と日刊生成器の共通3ライブラリ、解析Workerの取得URLを`20261012_4`へ更新。公開scope許可・有料Jev評価・補正正本はこの続きで変更していない。

最終ビルドは674ファイルで検査通過。5実画面・最新2号の受け渡し、toolsのCSP内での索引取得、404の入口、実adapterと読みmanifestの照合、320/768/1440px・CSS200%の画面検査を確認した。共通UIの5scopeと追加3ケースではsort変更・CDPのIMEイベント・scheduler非対応時の縮退も通過。追加回帰22件を最終ソースで再確認した。Worker実装はこの続きでは変えておらず、前段で通過した189件の結果を引き継ぐ。構文検査は45スクリプト・64HTMLのscript／JSON-LD・84JSON、AIモデル設定と`git diff --check`も通過。出荷した共通JS/CSSのバイト列は作業ソースと一致する。画面試験のAPI・解析通信は固定応答であり、本番接続の検証ではない。Linux／Pages、OSの日本語IME、実機読み上げ、本番のURL・計測の確認は引き続き未実施。


## 2026-10-12：Linux・Pages・本番Workerの公開前検証

最新main（2172cf0）の20261012号とMAGI生成物を取り込み、出荷は678ファイル、サイト96ページ、日刊197＋214＝411記事となった。61号の共通UI参照だけを更新し、本文・dateModifiedを保持。共通3ライブラリと解析Workerは `20261012_5`。大きなpostingsの移譲も最大512組へ分割した。game一覧のGTM/Ahrefsが解析停止設定を無視していた点を修正した。

WindowsとLinuxの正式測定は同じ411記事から作ったfixture、CPU4倍抑制、20入力×5・3回、監視なしで実施。共通UI4ケースと実日刊adapter4ケースの全測定で100入力p95が50ms以下。fixture hashと共通6ファイルのhashは両OSで一致する。実adapterの大きいケースは8MiB上限を保った7,500件で、10kの合格と混同しない。

| 環境 | 共通10kの入力p95最大ms | 実adapter 7,500件の入力p95最大ms | 実adapterの準備ms |
| --- | ---: | ---: | --- |
| Windows | 40.2 | 38.8 | 2,659.0 / 2,903.0 |
| Linux | 29.3 | 26.9 | 3,058.2 / 3,335.5 |

[Windows共通](ui-final-windows-20261012.json)・[実adapter](ui-adapter-final-windows-20261012.json)、[Linux共通](ui-final-linux-20261012.json)・[実adapter](ui-adapter-final-linux-20261012.json)。Windowsの最初の20入力p95は10kで54.1／55.7ms、7,500件で61.6／59.1ms。準備中の最大heartbeat間隔は実adapterで204.9／221.6ms。正式合格でも、この制約と実機IME／読み上げ未検証は残る。

Linuxの[Actions 38188586608](https://github.com/tk33r1/st/actions/runs/38188586608)（86c2e20）で固定依存の冷／温取得、出荷ビルド、Python6件、Node211件、読み照合、5画面、旧HTML、共通UI、画面寸法／焦点／通知、正式測定が通過。初回のfixture履歴取得不足と次回の試験locale不足は修正して再実行した。合格結果だけに置き換えず経緯を残す。Python3.13.16／Linux x86_64／Node24.21.0。冷取得5.885秒・温取得0.848秒、出荷14.320秒／ピークRSS408.5MiB。10k生成は共有1.702秒／316.9MiB、別語彙5.046秒／372.4MiB。[環境記録](linux-environment-20261012.json)、[共有語彙](reading-memory-shared-linux-20261012.json)・[別語彙](reading-memory-distinct-linux-20261012.json)。RSSは各処理と子孫の最大で同時プロセス合計ではない。PagesそのもののRAMと呼ばない。

実Cloudflare Pagesの[preview](https://b9bfde6a.st-dmt.pages.dev)（b9bfde6a-f1b8-4311-8d56-18ffc4dfe3f0、86c2e20）もビルド成功。ローカル出荷とpreviewで本物のGTM／gtag／Ahrefsを読み、送信を記録して停止した。5scopeのURL・Referer・伏せ字・明示POST・受け渡し・再読み込み・JS無効時の404ツリーと日刊フォームが通過。[preview](url-preview-20261012.json)・[ローカル](url-local-20261012.json)。日刊の既存解析停止設定は検索イベントの停止であり、tools/gameのタグ読込停止と同一だとは記載しない。

本番Workerに新入口を先行配置し、tools/gameは一時評価キー付きだけで有効化。普通の要求はdisabled、不正filterは400、世代不一致はindex_updatingで有料判定へ進まないことを確認。本番接続で `cache:'no-cache'` に必要な互換フラグが不足していたため、2025-01-01を維持して `cache_no_cache_enabled` を追加した（[Cloudflare仕様](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-cache-no-cache-http-standard-api)）。配置直後の停止記録もGit管理外へ保存し、有料測定とは数えない。

固定finalを各scope20問・1回ずつ本番入口で評価して合格。toolsは上位5件11/11、必須候補10/10、正解なし誤表示0/9。gameは13/13、必須9/9、0/7。scope/filter外の表示、判定欠け、失敗は0件。game-final-17に続編が混ざる既知の限界は残す。Worker往復p95は307.5／293.2msでJev単体と混同しない。[本番評価](rank-publication-20261012.json)。40件が共有回数枠を利用し、別の6件は判定前の停止検査。既存の固定80問・2回の評価は正解も閾値も変更していない。

合格後に5scopeを一般利用向けに有効化。Workerは5cf9e947-e7a7-4fd2-a0c4-5e6e5c01d7bcへ正本を配置し、一時変数と診断コードを除去、SITE_RANK_EVAL_KEYを削除した。静的画面の本番公開と公開ブラウザ確認はこの続きで実施する。


## 2026-10-12：本番公開と完了記録

mainへc1142b34を反映し、Pages1760c14bが公開完了。最終Linux38189518864も全項目合格。5画面の実Jev、旧入口の3scope、公開6ファイル／読みmanifestの実バイト、URL／実GTM／Ahrefs・JS無効・scope停止と①保持・Pages旧版→新版の実rollbackを確認。一時評価secret・変数・診断コードを除去した。

最初のURL検査が同一サイトのCloudflare先読み設定GET /cdn-cgi/speculationの初期Refererを外部計測と扱って停止したため、既存Phase 3の区別を固定GETパスだけへ限定して検査を修正した。外部通信・URL・本文は引き続き検査し、全5scopeの本番検査が合格。先の実検索1件も記録へ残し、共有枠への実要求は本番final40＋公開確認6＋旧入口3＝49件。

最後に公開後botの10087b7e（sitemap／dateModified）を取り込んだ。実装済みとして4資料を凍結し、正本はコードとした。版・証跡・再現手順・初回入力／準備停止・実機IME／読み上げ未検証などの限界は[Phase 4公開評価](../../../assets/site-search-phase4-release-evaluation.md)へ固定した。
