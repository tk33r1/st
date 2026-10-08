# サイト内検索 Phase 3 設計書

草案（2026-10-09）。同日の本人のレビューで範囲を「日刊2誌の②」に絞った。未実装・未公開。

要件は [Phase 3 PRD](site-search-phase3-prd.md)。Phase 2 の [設計書](site-search-design.md) への追加設計で、停止・期限・認可・通知・回数は既存の仕組みを使う。Phase 2 設計書 11章（Phase 3 の方針）と食い違うところは本書を正とする。

## 1. 変えるファイル

| ファイル | 現行 | Phase 3 の変更 |
| --- | --- | --- |
| `.github/scripts/daily_engine.py` | 年別の索引とページを生成 | 索引の全ファイルに同じ `generation` を書く。ポータルの検索欄を 404 の形に、説明のダイアログ、版番号 |
| `job/assets/daily-ui.js` | 全年度の横断検索・受け渡し | 入力中のドロップダウン、②の欄、①と②の重なりの除き、generation の照合 |
| `assets/site-search.js` | ②の共通部品。日刊の URL の検査は既にある | 日刊の `searched`（N/M/J）の検査と表示 |
| `workers/magi2/site-rank.js` | `site` だけを判定 | scope `nitori`・`retail`、filters、日刊の候補選びと変換 |
| `workers/magi2/search-scope.js`（新規） | なし | scope の定義、filters の検査、日刊のスナップショットの取得・検査 |
| `workers/magi2/personas.js` | `SITE_RANK`・`SITE_SEARCH` | `SITE_RANK.scopes`（日刊の候補数・閾値・revision）、`SITE_SEARCH.global_daily_limit` を100に |
| `.github/scripts/eval-site-rank.mjs` | site の評価・本番の測定 | scope の評価、候補に正解が入る割合、generation の照合 |
| `tools/index.html`・`game/index.html` | `?q=` を読んでカードを絞る | head で `?q=`・`#q=` を受け取って URL から消す（①だけ）。AI の送信は無い |

区画をまたぐ部品は `assets/`、Worker の scope の処理は magi2 の直下。伏せ字は `assets/search-analytics.js`（`28e22be` で 404 と日刊が共有）を使い、書き写さない。新しいビルドツールは持ち込まない。

## 2. API

入口は `POST /magi2/site-search` の `mode: 'rank'` のまま。認可・CORS・4KiB の本文の上限を保つ。索引の本文・上限・閾値・問いはクライアントから受け付けない。③（`mode` なし）は変えない。

```json
{ "mode": "rank", "scope": "nitori", "query": "収納の新商品", "locale": "ja", "filters": { "category": "新商品", "region": "JP", "month": "202610" } }
```

| 項目 | 検査 |
| --- | --- |
| scope | `site`・`nitori`・`retail`。`tools`・`game` は Phase 3 でも400のまま |
| query | Phase 2 と同じ（元の入力200コードポイントまで、Worker が落とす文字を除いて空なら400） |
| locale | `ja`・`en` |
| filters | 日刊だけ。plain object で、キーは `category`（40コードポイントまで）・`region`（`JP`/`GLOBAL`）・`month`（暦として正しい `YYYYMM`）。null・配列・未知のキーは400。省略と `{}` は同じ。`site` で filters を送ったら400 |

空文字の値は未選択として除く。カテゴリーと月が索引に実在するかは、完全なスナップショットで確かめ、無ければ400（画面に再読み込みを案内）。値は実在しても組み合わせの対象が0件なら、正常な0件にする（上流を呼ばない。回数は数える）。

正規化した filters は決まったキー順で JSON にし、クライアントのキー順でキャッシュが分かれないようにする。キャッシュのキーには scope を必ず含める。

### 2.1 応答

HTTP・`status`・`reason` は Phase 2 と同じ。日刊の成功では `searched: {total, candidates, judged}` を必須にし、0以上の整数で `judged <= candidates <= total` を満たすか確かめる。`complete` は `judged === candidates`。失敗では `complete: false`、対象数が分かる前に限り `searched: null` を許す。結果は最大5件。

別の媒体の URL、件数の矛盾、1件でも不正なリンクを含む応答は、全体を失敗にする（Phase 2 の `readResult` と同じ）。リンクは Worker が検査した索引の ID から組み立てる。

## 3. scope・ID・リンク

| scope | kind | 対象 | URL |
| --- | --- | --- | --- |
| nitori | daily | 日刊ニトリの全記事と filters | `/job/nitoridaily/<YYYYMMDD>/#art-<正の整数>` |
| retail | daily | リテールテック日刊の全記事と filters | `/job/retailtechdaily/<YYYYMMDD>/#art-<正の整数>` |

- 記事の ID は `<媒体のディレクトリ名>:<日付>:<記事番号>`（例：`nitoridaily:20261008:1`）。scope の名前（`nitori`）と索引の media（`nitoridaily`）の対応は、固定の scope 定義に置く。
- 番号は1以上、日付は暦として正しく、URL の日付・`date`・年別ファイルの年が一致すること。同じ ID・URL の重複は取得失敗。遡り・二重スラッシュ・外部の origin・バックスラッシュ・制御文字・二重エンコードを拒否する。
- ブラウザは①の相対 URL をサイト内の絶対パスにそろえ、重なりのキーは pathname と hash にする。404 の打ち間違い補正用の `pathParts` は使わない。
- `index_hash` は、その媒体の head と過去の年別ファイルの取得本文を、ファイル名と組にして順序を固定した JSON の digest。

## 4. 日刊の索引を一貫して読む

### 4.1 生成（generation）

いまの head（最新年の records と years）と過去の年別ファイルの形は保ち、全ファイルに同じ `generation` を足す。

- `generation` は `daily_engine.py` が1回の `save_history` のたびに1回だけ作る値（その回に書く全年度の正規化済みデータの SHA-256 の先頭16桁など。作り方は Python の中だけで決める）。
- **読む側（Worker・ブラウザ）は digest を計算し直さず、全ファイルの `generation` が一致するかだけを見る**。Python と JS で同じ JSON の形を作る必要が無く、文字のエスケープや数値の書き方の違いで食い違う危険が無い。中身の壊れは、JSON の読み込みと行の検査で落ちる。
- 過去の年のファイルを書き直さない回でも、generation が変わったら全ファイルに新しい値を書く（年をまたいで揃っていることが条件なので）。
- 既存のブラウザは足した項目を読み捨てるので、索引を先に出せる。公開 URL と記事のアンカーは変えない。号の本文と `dateModified` も変えない。

### 4.2 Worker の取得

1. scope から決まる固定の URL の head を、索引の3秒の期限内に1回だけ取る。
2. media・years・generation・records を検査する。years は重複なし・降順の4桁の年。head の records は最新年だけ。空の完全な索引は years も records も空。
3. `years.slice(1)` の固定のファイルを読む。head に書かれた任意の URL はたどらない。年・media・generation を照合する。
4. 全部そろって一致したときだけ、媒体のスナップショットを一度に差し替える。一部だけを更新しない。

- 取得中に新しい版が公開されても、取った全ファイルの generation が一致していれば、その版は整合している。head を取り直さない。一致しなければ取得失敗にし、その要求の中では自動で再試行しない。
- 3秒は手順全体に掛け、②の全体6秒の内側にする。並列は最大4本。防御の上限（本文の合計8MiB・全記事20,000件・年数100）は `personas.js` に置き、評価と記事の増え方を見て確定する。超えたら `index_unavailable`。
- 更新の間隔10分、完全な古い索引を使える24時間、失敗後の取り直し60秒は既存の設定を使う。日刊2誌と site のキャッシュは分ける。

### 4.3 ブラウザ

- ①の全年度の読み込みも、全ファイルの generation の一致を確かめる。一致しなければ、その媒体の読み込み途中の Promise と集めた records を捨て、取得失敗を表示する。次の明示的な検索で head から読み直す（要求の中では自動で再試行しない）。
- head は読み込みのたびに `cache: 'no-cache'` で1回読む。年のファイルの Promise は media・generation・ファイル名で区別し、違う版で使い回さない。
- ウォッチの新着（一部の年だけを読む）も generation を確かめるが、全年度の検査済みの索引として扱わない。
- 最初は generation を書くだけにして、従来の画面が動くことを確かめてから、一致を必須にする画面へ移す。

## 5. 候補と変換

- 候補は、絞り込みの後、`scoreItems` で title を重く、summary・tags・category を軽く数える。takeaway・source・date は判定の根拠にしない。正の点数の記事を点数の降順・日付の降順・記事番号の昇順に取り、20件まで。足りなければ新しい記事で補う（同じ ID を重ねない）。
- 変換は `{kind:'daily', title, summary, category, tags, region:'国内'|'海外'}`。要約300・全体400コードポイント。超えたら要約、末尾のタグ、題名の末尾の順に縮める。変換のために記事を候補から外さない。
- 問いと閾値は `SITE_RANK.scopes.nitori`・`.retail` に置く。site の問い・閾値・revision は変えない。日刊の変換・候補の規則・閾値を変えたら、その scope の revision を上げる。最初は Phase 2 の基準付きの問いと閾値0.4から始め、合格の値とは決めつけない。
- 候補の変換・要求・判定は、評価スクリプトも Worker の関数を使う。

### 5.1 検索用の言い換え語（条件付きの工程）

候補選びは字の重なりと新しさで決めるので、字の重ならない言い換え（例：「片付け」で「収納」の記事）では古い記事が候補に入らない。最初の測定で候補に正解が入る割合が90%を下回ったら、次を足す。

- `daily_engine.py` が号を作るとき、記事ごとに検索用の短い語（3〜5語。題名・要約に無い言い換えや英語）を作り、索引の行に `search_terms` として持つ。作るのは号の生成と同じ LLM の呼び出しに足す（別の呼び出しを増やさない）。
- `scoreItems` の対象に `search_terms` を軽い重みで足す。Jev へ渡す変換には入れない（判定は記事の中身で行う）。
- 過去の記事は一度だけ埋め直す（`Date-Sync: skip`）。足したら scope の revision を上げ、候補の測定からやり直す。

## 6. 画面（日刊のポータル）

404 の作り直した形（Phase 2 設計書 6.1・6.2）をそのまま使う。

- 検索欄は `role="combobox"`、欄の中に虫眼鏡（`type="submit"`）。いまの検索ボタンは外す。見出しの横にインフォメーションマーク。
- 入力中は①の上位6件を `role="listbox"` のドロップダウンに出す（`aria-activedescendant`、↑↓・Enter・Esc・外を押す、変換中も）。①の索引は、検索欄にフォーカスしたときに読み始める。
- 検索した後は②の欄→①の一覧。①の描き方（最大100件・件数の表示）はいまの横断検索のまま、②に出た記事だけを除く。
- ②は `STSiteSearch.rank()` を scope `nitori`・`retail` で使う。`condition` は検索語・言語・filters。入力・言語・filters が変わったら `invalidate()`。
- ①の処理を `runKeywordSearch`（受け渡し・タグ・filters・Enter の①の部分）と、Enter・虫眼鏡の `runExplicitSearch`（①を済ませてから②）に分ける。①も非同期の読み込みの前に条件と世代を固定し、読み終えた時点で古ければ描かない・計測しない。
- 確定 Enter の押し続けによるフォームの暗黙の送信を止める（404 の `imeEnterHeld` と同じ）。②の結果が届いても、フォーカスのあるリンクと同じ行き先へ戻す。
- 検索した後の形・入力中の形の切り替え、①0件の案内、受け渡しの後の案内は PRD 2章のとおり。

## 7. URL・計測・ログ

- 日刊の受け渡し（`#q=`、古い `?q=`）は Phase 2 のまま。ツール・ゲーム一覧の head にも同じ処理（単一の値・200コードポイント・不正なエンコードと競合の検査）を足し、計測より先に URL から消す。取り出した値は①の初期条件にだけ使う。
- ②の POST は `credentials: 'omit'`・`referrerPolicy: 'no-referrer'`（Phase 2 の部品のまま）。
- 計測のイベントは `daily_rank_run`・`daily_rank_result`・`daily_rank_click`（`media` を付ける）。`daily_rank_run` にだけ伏せ字の `search_term` を付ける。result に検索語・URL・題名・確率を入れない。①の `daily_search` は変えない。
- **GTM**：いまのトリガーのイベント名 `^(not_found_.*|daily_search)$` は新しいイベントを拾わない。公開の前に本人が `^(not_found_.*|daily_.*)$` に直す（実装計画書 P3-T12）。拾えていることを本番の通信で確かめる。
- Worker のログは scope を足し、件数・時間・reason・revision・index_hash・candidate_hash だけを残す。filters の原文、検索語、キャッシュのキー、候補の本文、上流のエラーの本文は残さない。candidate_hash は絞り込み前の全記事の `[id, toRankCandidate(item)]` を ID 順に並べた digest。

## 8. 回数・キャッシュ・停止

- 回数は既存の `rank:<IP>`→`rank:global`。scope ごとの枠は作らない。
- キャッシュのキーは scope、scope の revision、locale、正規化した query・filters、スナップショットの index_hash。最大256件・10分。complete な results・no_results だけを入れ、`searched` も持つ。
- 停止：環境変数 `SITE_RANK_SCOPES`（許す scope のカンマ区切り。未設定は `site` だけ）を足す。全体の `SITE_RANK_ENABLED=false` が優先する。止めた scope は `disabled` を返し、索引・回数・Jev を使わない。画面は `disabled` で②を隠し、①は使える。
- ③の全体の上限：`SITE_SEARCH.global_daily_limit` を20→100。`workers/magi2/README.md` の回数の説明（`search:global`（20回））と、Phase 2 PRD の上限の記述も直す。

## 9. 評価の再現性

- 精度は公開されている索引を保存して固定し、Worker と同じ検査・候補・変換で読む。generation・index_hash・candidate_hash・コード・設定・モデルの応答の版を記録する。候補選びと Jev の判定を分けて集計する。
- 本番の応答時間は、本番が使ったスナップショットの hash を request_id でログと照らす。日刊は毎日記事が増えるので、2回の測定は同じ UTC 日に10分以上（キャッシュの10分と余裕）空け、両方が同じ generation・candidate_hash のときだけ比べる。
- 速度の測定は1 UTC 日に1媒体、2回で48件＋疎通2件まで。既存の利用で回数の余裕が無ければ別の日にする。途中で号が増えたら、新しい索引で正解を付け直し、両回をやり直す。
- キャッシュに当たった・上限で断られた測定を応答時間に含めない。キャッシュを外す公開の仕掛けは作らない。

## 10. 公開と切り戻し

1. **S1 ③の上限**：`global_daily_limit` を100にして Worker を出す（他と独立）。
2. **S2 一覧の `?q=`**：ツール・ゲーム一覧の head の受け渡し（他と独立）。
3. **A 索引の generation**：全ファイルに generation を書く。従来の画面と互換。
4. **B Worker**：scope `nitori`・`retail` を実装し、`SITE_RANK_SCOPES` から外したまま出す。評価のときだけその媒体を開ける。
5. **C 媒体ごとの画面**：ポータルの検索欄・②・説明・計測、運用文書（AGENTS・JEV・magi2 README）を同じ公開単位で出す。その媒体の精度・本番の応答時間・privacy が合格してから、`SITE_RANK_SCOPES` に足す。

切り戻しは、その媒体を `SITE_RANK_SCOPES` から外すのが先、画面は後。site を巻き込んで全体を止めない。generation は従来の画面と互換なので残す。公開した URL は動かさない。

## 11. 未確定の値

防御の上限（4.2）、日刊の閾値と revision（5章）、言い換え語を作るか（5.1）は、評価の結果で決める。実測していない精度・応答時間・料金を合格済みと扱わない。
