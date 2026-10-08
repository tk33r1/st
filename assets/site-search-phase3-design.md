# サイト内検索 Phase 3 設計書

草案（2026-10-09）。設計着手済み・未実装・未公開。

要件は [Phase 3 PRD](site-search-phase3-prd.md)。Phase 2 の [設計書](site-search-design.md) に対する追加設計で、現行コードの契約と新しい契約を分けて書く。停止・期限・認可・通知は既存の仕組みを再利用する。未確定の仕様案はPRD 8章と本書11章を参照。

## 1. 現行との差分とファイルの役割

| ファイル | 現行 | Phase 3の変更 |
| --- | --- | --- |
| `assets/site-search.js` | ②の共通部品、scope別のURL検査 | ③の実行・中止・描画を移し、探索件数を検査・表示 |
| `404.html` | ③の本体を内包 | 共通の③を呼ぶ。既存の条件・文言・計測を維持 |
| `tools/index.html`・`game/index.html` | ローカルのカード絞り込み、`?q=`を読む | ②③、明示送信、絞り込みの接続、headの引き継ぎ、説明 |
| `job/assets/daily-ui.js` | 全年度の横断検索・引き継ぎ | ①の描画と②の送信を分離し、②③と世代管理を接続 |
| `.github/scripts/daily_engine.py` | 年別索引とページを生成 | 索引のgeneration、ポータルの②③・説明・版番号 |
| `.github/scripts/site-search-index.py` | kind別の判定用メタデータ | toolのcategory識別子を追加し、表示名と分けて保持 |
| `workers/magi2/site-rank.js` | `site`だけを判定 | scope・filters・daily変換・候補選びを共通化 |
| `workers/magi2/site-search.js` | 公開ページの索引とページ選び | scope内の③の候補・選択検査・探索範囲を扱う |
| `workers/magi2/search-scope.js`（新規案） | なし | scope・filters・URLの対応、対象抽出、日刊スナップショット |
| `workers/magi2/personas.js` | SITE_RANK・SITE_SEARCH | 日刊の候補数、scope設定、③の限定範囲の指示 |
| `.github/scripts/eval-site-rank.mjs` | site評価・本番ブラウザ測定 | scope評価・日刊の候補包含率・世代の照合 |

区画横断の部品は `assets/`、Worker共通のscope処理はmagi2直下。画面ごとに③や伏せ字ルールを書き写さない。`assets/search-analytics.js` は検索語の計測用の正本として使う。JSONやCSSを新しいビルドツールで束ねない。

確認基点はPRD 1章のとおり。現行Workerは②で `site` 以外を400にし、③で `query`・`locale` 以外の本文キーを拒否する。現行ブラウザのURL検査が他scopeを知っているだけではPhase 3は動かない。

## 2. APIと互換性

入口は `POST /magi2/site-search` のまま。認可・CORS・4KiB本文制限を維持する。クライアントから索引本文・上限・閾値・問いを受け付けない。

```json
{ "mode": "rank", "scope": "tools", "query": "書類をまとめたい", "locale": "ja", "filters": { "category": "editor" } }
```

```json
{ "scope": "nitori", "query": "収納の新商品", "locale": "ja", "filters": { "region": "JP", "month": "202610" } }
```

後者は③で、URLに `?site_debate=1` を付ける。`mode` のある本文は②だけへ振り分け、未知のmodeを③へ流さない。②はscope必須。③のscope省略は従来の `site` とする。旧 `{query, locale}` とトップページ・アプリの既存通信を維持する。

| 項目 | 検査 |
| --- | --- |
| scope | `site`・`tools`・`game`・`nitori`・`retail` の固定集合 |
| query | 既存の②③それぞれの正規化、元入力200コードポイント上限、空なら400 |
| locale | `ja`・`en` |
| filters | plain object。null・配列・未知キーは400。省略と `{}` は同じ条件 |
| site | filtersキーを持つ要求は400 |
| tools | categoryだけ。元の `tools.json.category` の識別子を使う |
| game | genreだけ。元の `game.json.genre` の値を使う |
| nitori・retail | category（40コードポイント以内）・region（JP/GLOBAL）・month（実在する年月） |

空文字のfilter値は未選択として除去する。型が違う値・不正な年月は取得前に400。カテゴリー・ジャンル・月の実在は完全なscope索引で検査し、実在しなければ400。各値が存在しても組み合わせの対象が0件なら正常な0件とする。期間は暦として検査し、例えば202613を通さない。

正規化したfiltersは決まったキー順でJSON化し、クライアントのキー順でキャッシュが分かれないようにする。`scope` を条件キーへ必ず含める。

### 2.1 応答

②のHTTP・status・reasonはPhase 2と同じ。新scopeの成功では `searched: {total, candidates, judged}` を必須にし、非負整数かつ `judged <= candidates <= total` を検査する。成功時の `complete` は `judged === candidates`。失敗時はcompleteをfalseとし、対象数が判明する前だけsearchedをnullにできる。最大5件。

③は既存の結果形に `searched: {total, candidates}` を追加する。最大3リンクと統合コメント。scope付きの新画面では件数が欠けた・不正な応答を失敗とし、探索済みと表示しない。既存のsite画面は旧応答も受け取れる移行期間を設ける。ページ選びの失敗をno_resultsにしない。

③の設定停止はHTTP 503・`error.code: 'search_disabled'`・`retryable: false`、一時障害はHTTP 503・既存の `error.code: 'search_unavailable'`・`retryable: true` とする。DB・索引・上流の障害や期限切れを停止へ変換しない。画面は停止専用コードだけで③を隠し、一時障害や未知の503では失敗を表示して明示的な再試行を残す。旧site画面が新しい停止コードを受けても、従来の汎用利用不可表示で扱えるHTTP形を維持する。

正常な対象0件では②の上流を呼ばず、回数は数えてno_resultsを返す。③では索引・filters検査後、AI・討議・利用回数を使わず正常な対象0件を返す。画面は絞り込み変更へ誘導する。

scope外のkind・URL、件数矛盾、1件でも不正なリンクを含む結果は全体を失敗とする。独自に作ったURLを描かず、Workerの検証済み索引のIDから組み立てたリンクだけを返す。

## 3. scope・絞り込み・リンク

| scope | kind | 対象抽出 | URL |
| --- | --- | --- | --- |
| site | page/tool/game/article | 日刊の号を除く公開ページ | 現行の検証 |
| tools | tool | kindとcategory_key | `/tools/<slug>/`、クエリ・フラグメントなし |
| game | game | kindとgenre | `/game/<slug>/`、クエリ・フラグメントなし |
| nitori | daily | その媒体の全記事とfilters | `/job/nitoridaily/<YYYYMMDD>/#art-<正整数>` |
| retail | daily | その媒体の全記事とfilters | `/job/retailtechdaily/<YYYYMMDD>/#art-<正整数>` |

toolの索引に `category_key` を追加する。Jevに渡す既存の表示名categoryは変更せず、filtersはcategory_keyを使う。表示名から識別子を推測する変換をWorkerに複製しない。旧索引ではsiteは従来どおり動かし、toolsのfilter対応は利用不可とする。

日刊のIDは `<媒体のディレクトリ名>:<日付>:<記事番号>`（例：`nitoridaily:20261008:1`）。scopeの別名 `nitori`/`retail` と、索引mediaの値 `nitoridaily`/`retailtechdaily` の対応は固定のscope定義に置く。番号は1以上、日付は暦として有効で、url内の日付・date・年別ファイルの年が一致すること。同じID・URLの重複は取得失敗。パスの遡り・二重スラッシュ・外部origin・バックスラッシュ・制御文字・二重エンコードで検査を迂回する値を拒否する。

ブラウザは①の相対URLを基底URLでサイト内の絶対パスにそろえる。日刊の重複キーはpathnameとhash、ツール・ゲームはpathname。404の誤入力補正用 `pathParts` を日刊の重複判定へ流用しない。

scopeごとの `index_hash` を定義する。siteは取得本文の現行digest、tools/gameはそのscopeの正規化済み全行を索引順にJSON化したdigest、日刊はheadと過去年別ファイルの取得本文をファイル名と組にして順序を固定したJSONのdigestとする。tools/gameの行には表示・filters・判定に使う項目も含める。全サイトの取得本文hashをtools/gameへ使うと日刊の新号だけで評価条件が変わるため、対象scopeのデータで区別する。filtersを当てる前のhashを保持する。

## 4. 日刊の索引を一貫して読む

### 4.1 生成契約

現行のhead（最新年のrecords＋years）と過去年別ファイルを維持し、全ファイルに同じ `generation` を追加する。従来のブラウザは追加項目を読み捨てるので、索引だけを先に出せる。

generationは、1回の `load_history` から作った全年度について次をUTF-8のJSONにし、SHA-256を取ったものとする。

```text
[media, years,
 [[year, [[date,title,summary,takeaway,source,source_kind,category,region,tags,url], ...]], ...]]
```

yearsは新しい順。各年のrecordsは生成時の順序、tagsも元の順序。JSONは空白なし・Unicodeを文字として保存する。列は固定し、欠けた任意の文字列は空文字、tagsは空配列にそろえる。必須のdate・title・category・region・urlは検査する。PythonとWorkerで同じ公開fixtureのdigestを照合し、シリアライズの差を検出する。

generationは全記事の検査・正規化済みデータの版。headの文字列を含めた取得本文の `index_hash` は、これとは別に保持する。generationを追加しても既存の公開URLと記事アンカーは変更しない。

### 4.2 Workerの取得

1. scopeから決まる固定URLのheadを、索引の3秒期限内で取得する。
2. media、years、generation、recordsを検査する。yearsは重複なし・降順の4桁年。headのrecordsは最新年のものだけ。空の完全な索引はyears空・records空で表す。
3. `years.slice(1)` の固定ファイルを読む。headに書かれた任意のURLはたどらない。年・media・generationを照合する。
4. 全年度を検査し、上のdigestを再計算してgenerationと照合する。
5. 全部そろってから媒体ごとのスナップショットを一度に差し替える。部分的にキャッシュを更新しない。

headは1回だけ取得する。全年度のdigestが最初のheadのgenerationと一致すれば、その世代の整合性は成立する。取得中に新しいheadが公開されても、整合した旧世代を拒否しない。年・generation・digestの不一致は取得失敗とし、その要求内で上流を自動再試行しない。最新性は下記の更新周期で扱い、整合性の検査へheadの再取得を重ねない。

3秒は1ファイルずつではなく手順全体に適用し、②の全体6秒にも含める。並列取得は最大4本、本文の合計8MiB・全記事20,000件・年数100を初期の防御上限案とする。超過はindex_unavailable。値はpersonas.jsへ置き、評価結果と成長見込みを確認してから確定する。

索引の更新は10分、完全な古い索引を使えるのは24時間、再取得失敗後の間隔は60秒という既存設定を使う。日刊2誌・siteのキャッシュは分離する。更新中は既存の完全なsnapshotを使い、更新失敗で一部の年だけを継ぎ足さない。24時間を超えたら失敗にする。

要求は取得したsnapshotを終了まで保持する。filter選択肢・件数・候補・hashは同じsnapshotから作る。画面とWorkerで公開版がずれ、選んだ値がWorker索引にまだ無い場合は400として再読み込みを案内する。全サイトの索引更新を待たず、該当媒体の停止で切り戻せるようにする。

### 4.3 ブラウザと生成物

①の `loadSearchIndex(true)` も4.2と同じ全年度のdigest照合を使い、過去年の欠落・混在を0件にしない。媒体ごとに同時進行の取得処理を共有し、やり直すたびに取得epochを進める（索引のgenerationとは別）。headは取得処理ごとに `cache: 'no-cache'` で1回読み、以前の処理の解決済みPromiseを再利用しない。年度ファイルのPromiseは媒体・generation・ファイル名で区別し、異なる世代で使い回さない。

HTTP・JSON・行の検査の失敗に加え、取得自体は成功しても年・generation・digestが一致しなければ、その媒体の未確定のhead・年度ファイルのPromiseと集約recordsをまとめて破棄する。`ensureIndex` に未検査のrecordsを残さない。次の明示検索ではheadから新しい取得処理を始め、要求内では自動再試行しない。破棄は失敗した取得epochが保持する項目にだけ適用し、古い要求の終了処理で新しい取得のPromiseやrecordsを消さない。

完全な検査済みsnapshotは未確定のキャッシュと分け、更新周期・旧snapshotの有効期間は4.2に合わせる。失敗で有効期間を延ばさず、代用できるsnapshotが無ければ取得失敗を表示する。新しいsnapshotの確定時に旧世代の年度Promiseを解放し、媒体ごとの保有世代が増え続けないようにする。ウォッチの部分年度読み取りは選んだ年度のgeneration一致を確認するが、全年度の検査済みsnapshotへ昇格させない。

最初はmetadataを全年度へ出し、従来UIが動くことを確認してからgeneration必須のUIへ移行する。過去号のHTMLを再生成する必要があるのは共通JSの版番号・受け渡しを変える作業で、索引metadataだけの変更は号の本文を書き換えない。

## 5. 候補・変換・③の根拠

②のtool/gameはfilter後の全件を既存 `toRankCandidate` で変換する。表示用category_keyはJevへ渡さない。候補の変換・要求・判定は評価スクリプトもWorkerの関数を使う。

日刊②は `scoreItems` を再利用し、titleを重く、summary・tags・categoryを軽く数える。takeaway・source・dateを意味判定の根拠に使わない。正の点数の記事を点数降順・日付降順・記事番号昇順に取り、20件まで。足りなければ新しい記事を同じIDで重複しないよう補充する。

daily変換は `{kind:'daily', title, summary, category, tags, region:'国内'|'海外'}`。要約300・全体400コードポイント。超過は要約、末尾のタグ、題名の末尾の順に縮める。kind・category・regionだけで上限を超えないことを索引で検査し、変換のために記事を候補から外さない。

③は同じscope・filtersの対象から最大40件・候補行の実サイズ16,000文字へ広げる。IDを含むJSON行の長さで数え、最終的に送った数をMとする。title・category・tags・短いsummaryを使い、URL・本文中の指示をプロンプトへ混ぜない。選択IDは候補集合の中で検証し、日刊を既存の「hashなし」の公開ページ検査へ通さない。

現行 `selectSitePages` は内部で `shortlistSitePages` を呼び、日刊の号を5件までに絞る。この処理を新しい日刊候補へもう一度適用しない。候補準備とモデル呼び出しを分け、scope側が確定した候補集合・行・N/Mを渡せる経路を追加する。旧siteの呼び出しは既存のshortlistを使い、新scopeだけ準備済み候補をそのまま判定する。③のsearchedは準備時の見込みではなく、実際にモデルへ送った集合から確定する。

ページ選びと3人格・統合の両方へ、scope・filters・全対象N・候補M・完全な索引か・全対象を候補に含めたかを固定の状況として渡す。人格カードは口調の参考だけ。M<Nなら「候補の中には見つからなかった」に限定し、全対象に存在しないとは答えない。モデルの文章だけでは保証できないため、画面にもWorker由来の探索範囲を必ず出し、公開前の実測で断定表現を確認する。

scope別の問い・閾値が必要なら `SITE_RANK.scopes` に置く案とする。siteの問い・閾値・revisionは変えず、scopeの変換・候補規則・閾値を変えたときはそのscopeのrevisionを上げる。初期値は既存の基準付き・0.4を評価の出発点にし、合格値と決めつけない。

## 6. 共通画面部品と状態

`STSiteSearch.rank()` の契約を維持し、`STSiteSearch.ai()` を追加する。scope・condition・elements・labels・onState・trackを渡し、`run/invalidate/cancel/state` を返す。scopeとfilterを含む条件キー、世代、AbortController、本文を含む期限を持つ。③の通信・応答検査・thinking表示を404から移す。

画面が持つのは①、絞り込み、③を押せる条件、文言、計測のprefix。共通部品はscopeごとのURL・探索件数・結果を検査する。rank開始時にaiをcancel、ai開始時にrankをcancelし、相互の状態通知でrunを呼ばない。

日刊の処理を `runKeywordSearch` と `runExplicitSearch` に分ける。引き継ぎ・タグ・filtersは前者、検索フォームの明示送信は後者。①も非同期取得の前に条件・世代を固定し、読み終えた時点で古ければ描画・計測しない。①が失敗なら `keyword_state: failed`、未読ならloading、正常なときだけknownと件数を渡す。

Enter長押しの既定のフォーム送信を抑止する。IMEの確定はキーを離すまで検索へ流さない。入力欄の②の開始後に①のリンクを操作していても、結果更新時に同じリンクのフォーカスを保つ。②へ移る場合も同じ行き先へ戻し、無いときだけ入力欄へ戻す。

新scopeのrank結果ではsearchedの表示を受け持つ欄を渡せるようにする。siteの旧結果は件数表示を必須にしない移行経路を残す。画面の初期条件や一覧のロード完了を理由にrank.runを呼ばない。

## 7. URL・通信・計測

ツール・ゲームのheadで `?q=`・`#q=` を計測より前に受け取り、URLから消す。単一値・200コードポイント・不正エンコード・競合の検査は日刊の規則を引き継ぐ。headの短い同期処理は遅延スクリプトに移さない。取り出した値は①の初期条件にだけ使う。

toolsのCSPは一覧のconnect-srcへ `https://workers.tk.st` だけを追加する。各ツールのCSP、Workerの起動方法、通信メーターに変更を入れない。検索語は②③のPOST本文だけ、credentials omit・referrerPolicy no-referrerで送る。検索のprivacy文面は一覧・FAQ・構造化データを同時に直す。

新画面のイベントは `site_search_rank_run/result/click`、`site_search_ai_used/result/click` とし、scopeを必須にする案。rank_runとai_usedだけに伏せ字のsearch_termを付ける。resultへquery・URL・題名・確率を入れない。①の日刊 `daily_search`、404の既存イベント名は維持する。GTMの既存トリガーが新イベントを拾うとは仮定せず設定・実通信を確認する。

game一覧のClarityはGTMの起動条件から除外する。対象は `/game`・`/game/`・`/game/index.html` で、検索の引き継ぎ・手入力・②③の結果表示後まで除外が続くことを確認する。入力欄だけのマスクに頼らず、検索語を表示するDOMもClarityへ送らない。個別ゲームや404・日刊の既存設定を一括で変えない。GTM設定の除外や実通信を確認できない場合は、game一覧のheadのスクリプトとbodyのnoscript iframeの両方を除いてGTMを読み込まない形へ切り替え、検索イベントを含むGTM経由の計測停止を記録する。伏せ字のGA4イベントは、その一覧で安全なGTM設定を確認できた場合だけ送る。

Workerのログはscopeを追加し、件数・時間・reason・revision・index_hash・candidate_hashだけを記録する。filtersの原文、検索語、キャッシュキー、候補本文、上流のエラー本文は記録しない。日刊のcandidate_hashはfilter前の全記事の `[id,toRankCandidate(item)]` をID順にJSON化したdigest。絞り込みと短縮候補だけのhashに置き換えない。

## 8. 回数・キャッシュ・停止

回数は既存 `rank:<IP>`→`rank:global`、③は `search:<IP>`→`search:global`。scope別の新しい枠は作らない。失敗・停止・不正入力での消費順はPhase 2を維持する。

②のキャッシュキーはscope、scopeのrevision、locale、正規化query・filters、snapshotのindex_hash。最大256件・10分、completeなresults/no_resultsだけを入れる。日刊の候補包含が不完全でもM件の判定が完全ならキャッシュ可能だが、searchedを保持し探索範囲を明示する。

全体フラグに加え、環境変数 `SITE_RANK_SCOPES` と `SITE_SEARCH_SCOPES` の許可リストを追加する案。未設定はsiteだけ。値は固定のscope名のカンマ区切りで、未知の設定値はデプロイ検査で止める。全体フラグfalseが優先する。siteの既存チャット処理への影響は避け、許可リストは検索の入口だけに適用する。

既知だが未公開・停止中のscopeは②ならdisabled、③なら2.1の `search_disabled` を返し、索引・回数・AIを使わない。未知のscopeは400。画面は②のdisabledで②を隠し、③の停止専用コードで③を隠すが①を維持する。③の一時障害ではボタンを残す。停止を受けた画面内では自動で可否を再確認せず、Worker・画面の公開フラグを戻した後の再読み込みで再開する。

## 9. 評価の再現性

精度測定では公開されている索引を保存し、全年度を固定したfixtureをWorkerと同じ検査・候補・変換で読む。generation、index_hash、candidate_hash、コード、設定、モデル応答の版を記録する。候補選びとJevの判定を別に集計する。

本番応答時間の測定は、本番が返すsnapshotのhashをrequest_idでログと照合する。日刊の2回は同じUTC日に10分以上空け、両方が同じgeneration・candidate_hashの場合だけ比較可能とする案。本番の速度測定用24件はfinalから結果を見る前に固定し、精度の合否はfinal全件の実API測定で別に判定する。日刊の速度測定は1UTC日につき1媒体、2回合計48件＋疎通2件までとし、既存の利用で残り枠が不足していれば別日に移す。更新を挟んだら新しい索引で正解を事前固定し、精度を含めて両回をやり直す。site/tools/gameの既存の別日測定条件は維持する。

キャッシュヒット・上限で断った測定を正常な応答時間に含めない。②のキャッシュを無効化する公開パラメータは作らない。日刊の2回目は10分TTLと余裕を超えて待ち、実際のログでヒットしていないことを確認する。

## 10. 公開・切り戻し

tools/gameはcategory_keyを含む索引→共通契約と対象scopeを実装した停止中のWorker→共通部品の404移行→各一覧の順に公開する。日刊はgeneration付き全年度索引→日刊対応を追加した停止中のWorker→各媒体の画面へ進む。日刊の索引・Worker実装をtools/gameの前提にしない。未実装のscopeは許可リストへ入れず、停止中のscopeとして扱う。各scopeは精度・本番時間・privacy・互換性の合格後に公開する。Workerはmainのコードから出し、画面を先に新契約へ進めない。

公開前に対象scopeのAGENTS・JEV・Worker READMEの仕様・通信先・停止手順を更新し、画面の注記・FAQ・JSON-LDと同じ公開単位へ含める。toolsの通信例外はその一覧の公開時点でAGENTSにも記載済みとする。公開後は版・時刻・合格証跡を記録する。日刊までの全公開を待って仕様更新を後回しにしない。

切り戻すときは該当scopeのWorker許可を先に外し、画面の公開フラグを戻す。siteを巻き込んで全体フラグを止めない。索引metadataは旧画面と互換なので残す。公開後のURLを動かさない。

## 11. レビューで確定する項目

filtersのtools/gameへの拡張、generation形式と防御上限、scope別revision、許可リスト、イベント名、日刊の同日測定は追加設計案。実装前に [検証計画書](site-search-phase3-verification.md) の期待値も同時に固定する。実測していない精度・応答時間・料金を合格済みと扱わない。
