# サイト内検索の刷新 実装計画書

作成（2026-10-06）。進めながら「進み具合」（6章）を更新する。要件は [site-search.md](site-search.md)（PRD）、作り方は [site-search-design.md](site-search-design.md)（設計書）。

- この計画書に書くのは、作業の単位・順番・完了条件・担当・進み具合だけ。中身は設計書の節を参照し、ここで決め直さない。設計を変えるときは先に設計書を直す。
- 対象は Phase 0〜2（404 の公開）と、その後のアプリ・Worker の移行（設計書 9章の 1〜8）。Phase 3（日刊2誌・`/tools/`・`/game/`）は、Phase 2 の公開後に設計書を詳しくしてから計画する。

## 1. 進め方

- **単位**：1つの作業（`T` の番号）を1コミットにする。コミットメッセージは短い英語（AGENTS.md）。作業ブランチで進め、`main` へは本人の指示で入れる（`main` への push で Cloudflare Pages が公開する）。
- **担当**
  - Claude：リポジトリの変更と、手元でできる検証。
  - 本人：secret の設定、Worker のデプロイ（`cd workers && npx wrangler deploy --config magi2/wrangler.toml`、または Actions の `deploy-worker.yml`）、GA4・GTM の確認、評価セットの確認、キーが要る評価の実行、アプリの配布。
  - Worker を出す前は `git pull` で最新の人格カードを取り込む（AGENTS.md）。
- **毎回の検証**（変えたものに応じて）

  ```bash
  node --check workers/magi2/src/index.js && node --check workers/magi2/site-search.js && node --check workers/magi2/site-rank.js
  node --test .github/scripts/test-magi2.mjs
  python -B .github/scripts/test-site-search-index.py
  bash build.sh   # 公開物の確認（索引の生成と検査を含む）
  # 404.html・index.html を変えたら、script を取り出して node --check（AGENTS.md の手順）
  ```

## 2. 全体の流れ

| 段 | 内容 | 設計書 9章 | 前提 |
| --- | --- | --- | --- |
| M0 | いまの値を取る計測（Phase 0） | 1 | なし |
| M1 | 索引の追加項目 | 2 | なし |
| M2 | Worker の②（止めた状態で本番へ） | 3 | M1 |
| M3 | 評価と閾値の決定 | 4 | M2 |
| M4 | 検索語を URL に残さない | 5 | なし |
| M5 | 404 の公開 | 6 | M0 から2週間、M3 の合格、M4 |
| M6 | アプリの更新 | 7 | M4 |
| M7 | Worker の日刊リンクを新しい形に | 8 | M6 が行き渡る |

```
M0 ──────────(2週間)──────────┐
M1 → M2 → M3 ─────────────────┼→ M5（404 の公開）
M4 ───────────────────────────┘
M4 → M6 →（行き渡り）→ M7
```

- M0・M1・M4 は同時に始められる。M0 は早く出すほど、M5 の待ちが短くなる。
- M5 は M6・M7 を待たない（設計書 13章の5）。

## 3. 作業一覧

状態は 6章の表で管理する。規模は S（半日以内）・M（1日程度）・L（数日）の目安。

### M0 いまの値を取る（Phase 0）

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T0.1 | 404 に `not_found_keyword_count` を足す | 6.6 | Claude | S | 入力が1.5秒止まったときだけ、①の件数（6以上は6）を送る。読み込み中・失敗では送らない。検索語を送らない。`node --check` が通る |
| T0.2 | GA4 でイベントを確かめ、取り始めた日を 6章に書く | 8.1 | 本人 | S | GA4 の DebugView などで `count` が見える |

### M1 索引の追加項目

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T1.1 | `site-search-index.py` に `rank_title`・`tags`・`category`・`genre` と上限・合計400文字の検査を足し、`test-site-search-index.py` を足す。`data/site-search.json` を作り直す | 4章 | Claude | M | 検査が通る。`bash build.sh` が通る。`data/site-search.json` の差分が追加項目だけ。いまの Worker の③が動く（知らない項目は読み捨てる） |

### M2 Worker の②（止めた状態で本番へ）

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T2.1 | `site-search.js` の下ごしらえ：`sha256`・`isBillingFailure`・`QUOTA_RE` を移し、点数付けを `scoreItems` に切り出す | 3.6・3.13 | Claude | S | 動きは変えない。いまの `test-magi2.mjs` がそのまま通る |
| T2.2 | 索引のスナップショット：本文のハッシュ、`makeSitePages` の追加項目、`cache.raw`・`rankReady`・`candidate_hash` | 3.5・3.11 | Claude | M | 不完全な索引で `rankReady` が false。③の寛容な検査は変わらない |
| T2.3 | `personas.js` に `SITE_RANK`（日英の問いを両方持つ） | 3.4 | Claude | S | モデル ID の直書きが無い（`ai_models.py check`） |
| T2.4 | `site-rank.js`：変換・候補・要求の組み立て・判定・結果・キャッシュ（scope は `site` だけ） | 3.6〜3.10 | Claude | L | 10.1 の判定・変換・キャッシュ・URL の検証が通る |
| T2.5 | `index.js`：入口の振り分け、本文読み取りの期限と中止、`handleSiteRank`、回数・ログ・応答の形 | 3.1〜3.3・3.11・3.12 | Claude | M | 10.1 の入力・回数・期限の検証が通る。`mode` なしの③は、いまの検証がそのまま通る |
| T2.6 | 通知に `signal` と期限：`searchUpstream`・`sendAlert` に省略できる引数を足す | 3.8 | Claude | M | 10.1 の通知の検証が通る。引数を省略した③・チャットの通知は変わらない |
| T2.7 | `wrangler.toml`：`SITE_RANK_ENABLED = "false"` と `compatibility_flags = ["enable_request_signal"]`（本番と `env.eval`）。`workers/magi2/README.md` にフラグの理由を書く（外すと②・③・通知が切断で止まらない） | 3.3・12章 | Claude | S | `npx wrangler deploy --dry-run --config magi2/wrangler.toml` が通る |
| T2.8 | `test-magi2.mjs` に 10.1 の検証を足す。検証は T2.1〜T2.6 のそれぞれのコミットに含め、ここでは抜けを埋める | 10.1 | Claude | M | `node --test` が通る |
| T2.9 | `wrangler dev` で切断の確認 | 3.3 | Claude | S | ②・③・チャットで、応答の前に接続を切ると上流の通信が止まることをログで見る |
| T2.10 | 本番へデプロイ | 9章の3 | 本人 | S | 本番で `mode: 'rank'` が `disabled` を返す。③とチャットがいままで通り答える |

### M3 評価と閾値の決定

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T3.1 | 評価セットの案：`.github/site-search/rank-queries.json`（60件以上、`tune`・`final`、6種類、答えの無いもの20%） | 10.4 | Claude | M | 形式の検査が通る。`reviewed` はまだ空 |
| T3.2 | 評価セットの確認 | 10.4 | 本人 | S | 正解を直し、`reviewed` に日付を書く（結果を見る前） |
| T3.3 | `eval-site-rank.mjs`：精度（Jev 直接・方式と閾値の比較・2回）、ブラウザの応答時間（Playwright）、`--smoke-payload` | 10.4・10.5 | Claude | L | キーが無ければ精度の測定は止まる。`--smoke-payload` が本番の関数で要求を出す |
| T3.4 | `tune`：言語を決め、閾値を選ぶ。取りこぼした項目の説明を直したら索引を作り直して測り直す | 3.4・10.4 | 本人（キーが要る）＋ Claude（結果の読み取り・説明の直し） | M | 2回とも精度・誤表示率の条件を満たす閾値がある |
| T3.5 | `SITE_RANK` を決めた値に（`question_language`・`threshold`・`revision`。使わない言語の文面を消す）。Worker を出し直す | 3.4 | Claude → 本人（デプロイ） | S | 本番の `revision` が評価と同じ |
| T3.6 | `final` を2回（精度） | 10.4 | 本人 | S | 2回とも PRD 7.1 の精度・誤表示率の条件を満たす |
| T3.7 | `wrangler.toml` の `SITE_RANK_ENABLED` を true にして（Claude）本番へ出し（本人。画面は出さない）、ブラウザの応答時間を測る。2回目は UTC の別の日 | 9章の4・10.4 | Claude → 本人 | S | 本番に `MAGI_TYPESAFE_API_KEY` がある。2回とも p95 が1.5秒以内で、同じ測定の精度・誤表示率も PRD 7.1 の条件を満たす |
| T3.8 | 記録：`site-search-evaluation.md` に結果をまとめる。`ai_models.py` の smoke に②を足す | 10.4・10.5 | Claude | S | 記録にコミット・ハッシュ・`revision`・2回の数字がある。smoke が通る |

- **合格しなかったら**：本番の `SITE_RANK_ENABLED` を false に戻し、原因（候補の説明・問い・閾値）を直して T3.4 からやり直す。`final` を見てから閾値を選び直す場合は、評価セットを作り直す（設計書 10.4）。

### M4 検索語を URL に残さない（PRD 6.1）

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T4.1 | `update-modified.py`：`Date-Sync: skip` のコミットを飛ばす。説明を冒頭に書く | 8.6 | Claude | S | 手元の一時リポジトリで、トレーラー付きのコミットが日時に使われない。先に `main` へ出す |
| T4.2 | `daily-ui.js`：受け渡しの受け取り、ヘッダー検索とタグの処理、`q` を書かない、`location.search` の `q` を読む処理を消す | 8.3 | Claude | M | 手元で `#q=`・古い `?q=`・ヘッダー・タグが動く |
| T4.3 | `daily_engine.py`：head の同期処理（削除と検査を分ける）、ヘッダーの検索欄、タグの `#q=`、`daily-ui.js?v=` | 8.2・8.3 | Claude | M | `test-daily-news.py` が通る（生成の HTML は検査しないので、これだけでは足りない）。手元で `--rebuild` した HTML を T4.8 で確かめ、受け取らない値も URL から消える |
| T4.4 | 404：日刊リンクを `#q=` に、③の日刊リンクの検査を新旧両方に | 8.4 の1 | Claude | S | 古い形は新しい形に直して `href` に入る |
| T4.5 | トップページ（`index.html`。ページの中に書く）と `magi-app/www/app.js` の日刊リンクの検査 | 8.4 の1 | Claude | S | `test-magi2.mjs` の画面の検査が通る。トップページに外部スクリプトを足していない |
| T4.6 | `analytics.js`：Ahrefs に `data-page-location` | 8.5 | Claude | S | Ahrefs の読み込みの属性に `#` 以降が載らない |
| T4.7 | `preview-404-ai.py`：日刊リンクの模擬を新しい形に | 10.3 | Claude | S | 模擬の `mock-daily` で新しい形が出る |
| T4.8 | `test-site-search-ui.mjs` の URL の部分（手元） | 10.3 | Claude | M | 目印の検索語が、外へ出る通信・URL・参照元に無い（手元の見当） |
| T4.9 | 公開：T4.2〜T4.7 のコミットと、`generate-nitori-daily.py --rebuild`・`generate-retail-tech-daily.py --rebuild` の結果（`Date-Sync: skip` 付きの1コミット）を、**1回の push** で `main` へ | 8.6 | Claude（コミット）→ 本人（push の指示） | S | 下の注を守る。日刊の bot の実行（01:55・02:05 JST）と重ならない時間に出す。`--rebuild` の差分に検索以外の変更が混ざったら別のコミットに分ける（同じ push に入れてよい）。`sitemap.yml` の後も号の `dateModified` が変わらない |
| T4.10 | 本番の URL の検証（本物の GTM・Ahrefs） | 10.3 | Claude（届かなければ本人） | M | PRD 6.1 の受け入れ条件。GA4 に `view_search_results` が無い。検索語が載る計測があれば、本人が GTM でそのページの計測を止める |

- **T4.9 を1回の push にする理由**：新しい `daily-ui.js` は URL の `q` を読まず、head の処理が渡す値だけを受け取る（設計書 8.3）。`daily-ui.js` や 404 の `#q=` のリンクだけが先に出ると、作り直す前の日刊の HTML（head の処理が無い）では、タグ・ヘッダー検索・404 からの受け渡しが動かない期間ができる。`daily-ui.js`・生成した HTML・404・トップページを同じ Pages のデプロイで出す。

### M5 404 の公開

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T5.1 | `assets/site-search.js`（共通部品） | 5章 | Claude | L | 状態・世代・応答の検査・計測が設計どおり |
| T5.2 | 404 の画面：検索ボタン、②の欄、Enter とキー操作、③の出し方、①の重複除き、文言、ダイアログ、計測。`RANK_ENABLED` は止めるための定数として持つ | 6章 | Claude | L | `RANK_ENABLED` を false にすると、いまと同じ動きに戻る。`node --check` が通る |
| T5.3 | `preview-404-ai.py` に②の模擬（遅い・欠け・上限・停止・外部 URL） | 10.3 | Claude | S | 手元で各状態を目で見られる |
| T5.4 | `test-site-search-ui.mjs` の②の状態・連携・表示 | 10.3 | Claude | M | PRD 3.1 と 7.4 の画面の条件が通る |
| T5.5 | 説明を直す：`AGENTS.md`・`workers/magi2/README.md`・`.github/JEV.md` | 12章 | Claude | S | 送り先・回数・停止が書いてある（`enable_request_signal` は T2.7 で書いた） |
| T5.6 | 公開：T5.1〜T5.5 を、`RANK_ENABLED` を true にして1回の push で `main` へ | 9章の6 | 本人（指示） | S | 前提（M0 から2週間・M3 の合格・M4）を満たす。本番の `SITE_RANK_ENABLED` が true のまま（T3.7）。本番で②・③が動く |
| T5.7 | 公開後の見守り（1〜2週間） | 8.2（PRD） | 本人＋ Claude | S | GA4 のイベント、Worker のログ（失敗の種類・判定なし）、Jev の費用、全体上限の通知 |

- T5.1〜T5.5 は T5.6 まで作業ブランチに置き、`main` へ先に出さない。見出し・説明・ダイアログの文言も変わるので、②を出す前に一部だけ公開しないため。
  - `main` へはこれまで作業ブランチを丸ごとマージして出している。T5.1〜T5.5 を作り始めるのは、M5 より前に出すもの（M3・M4 の公開）を `main` に入れ終えてからにする。その間に別の修正を出す必要が出たら、T5 のコミットを含めないように、その修正だけを `main` へ入れる。
- **止め方**：Worker の `SITE_RANK_ENABLED` を false にして出す（画面は `disabled` を受けていまの動きに戻る）。そのあと `RANK_ENABLED` を false にする（設計書 9章）。

### M6 アプリの更新

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T6.1 | `magi-app/www/index.html` の `app.js?v=` と `sw.js` のキャッシュ名を上げる | 8.4 の3 | Claude | S | PWA を開き直すと新しい `app.js` になる |
| T6.2 | ネイティブ：`npm run sync`・再ビルド・配布 | 8.4 の3 | 本人 | M | ストアの更新が出る |

### M7 Worker の日刊リンクを新しい形に

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T7.1 | `validateSiteChoice` の `daily.url` を `#q=` に。検証を直す | 8.4 の4 | Claude | S | `test-magi2.mjs` が通る |
| T7.2 | デプロイ | 9章の8 | 本人 | S | M6 が行き渡っている。404・トップ・アプリで日刊リンクが出る |

## 4. 公開ごとの確認

| 公開 | 何が変わるか | 確かめること |
| --- | --- | --- |
| T0.1 | 404 に計測イベント | 404 の動きが変わらない。イベントに検索語が無い |
| T1.1 | 索引（Pages） | 本番の③が答える |
| T2.10・T3.5 | Worker | ③・チャットが答える。`mode: 'rank'` の応答が設計どおり |
| T4.1 | `update-modified.py` | 次の `sitemap.yml` で差分が出ない |
| T4.9 | 日刊・404・トップ・`analytics.js`（Pages） | 日刊の横断検索・ヘッダー検索・タグ・号への移動、③の日刊リンク、T4.10 |
| T5.6 | 404 の②（Pages） | 10.3、PRD 7.4。止め方を確かめておく |
| T6.1・T6.2 | アプリ | チャットの日刊リンク |
| T7.2 | Worker | 404・トップ・アプリの日刊リンク |

## 5. 危ないところ

| 何が | どうなる | どうする |
| --- | --- | --- |
| 評価が条件を満たさない | M5 に進めない | T3.4 からやり直す。説明の薄い項目を直す。閾値・問いを見直す（`revision` を上げる） |
| Jev の障害・残高切れ | ②が `unavailable` | 画面は①と③で動く。通知で気づく。長引けば `SITE_RANK_ENABLED` を false |
| 全号の再生成（T4.9） | 日刊の bot のコミットとぶつかる。`--rebuild` が JSON も直す | bot の実行時刻を避ける。差分を分ける |
| GTM が検索語を拾う設定になっている | PRD 6.1 を満たせない | T4.10 で見つけたら、本人が GTM でそのページの計測を止める（PRD 11章の12） |
| `enable_request_signal` の影響 | チャットと③が切断で止まるようになる | T2.9 で手元で確かめ、T2.10 の後にチャットが答えることを確かめる |
| アプリの配布が遅れる | M7 が遅れる | M5 は待たない。古いアプリは新しい形の日刊リンクを出さないだけ |
| 本番の②を先に有効にする期間（T3.7〜T5.6） | Origin を偽れば呼べる | 全体の上限（3,000回/日）で費用を抑える。長引くなら false に戻す |

## 6. 進み具合

| ID | 状態 | メモ |
| --- | --- | --- |
| T0.1 | 未着手 | |
| T0.2 | 未着手 | 取り始めた日： |
| T1.1 | 未着手 | |
| T2.1〜T2.9 | 未着手 | |
| T2.10 | 未着手 | |
| T3.1 | 未着手 | |
| T3.2 | 未着手 | |
| T3.3 | 未着手 | |
| T3.4〜T3.8 | 未着手 | |
| T4.1 | 未着手 | |
| T4.2〜T4.8 | 未着手 | |
| T4.9〜T4.10 | 未着手 | |
| T5.1〜T5.5 | 未着手 | |
| T5.6〜T5.7 | 未着手 | |
| T6.1〜T6.2 | 未着手 | |
| T7.1〜T7.2 | 未着手 | |

最初に進めるのは T0.1（2週間の計測を早く始めるため）、続けて T1.1 と T4.1。
