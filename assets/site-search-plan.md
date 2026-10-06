# サイト内検索の刷新 実装計画書

作成（2026-10-06）。進めながら「進み具合」（5章）を更新する。要件は [site-search.md](site-search.md)（PRD）、作り方は [site-search-design.md](site-search-design.md)（設計書）。

- この計画書に書くのは、作業の単位・順番・完了条件・担当・進み具合だけ。中身は設計書の節を参照し、ここで決め直さない。設計を変えるときは先に設計書を直す。
- 対象は Phase 0〜2（404 の公開）と、その後のアプリ・Worker の移行（設計書 9章の 1〜8）。Phase 3（日刊2誌・`/tools/`・`/game/`）は、Phase 2 の公開後に設計書を詳しくしてから計画する。

## 1. 進め方

- **単位**：1つの作業（`T` の番号）を1コミットにする。コミットメッセージは短い英語（AGENTS.md）。作業ブランチで進め、`main` へは本人の指示で入れる（`main` への push で Cloudflare Pages が公開する）。
- **担当**
  - Claude：リポジトリの変更と、手元でできる検証。
  - 本人：secret の設定、Worker のデプロイ（`cd workers && npx wrangler deploy --config magi2/wrangler.toml`、または Actions の `deploy-worker.yml`）、GA4・GTM の確認、評価セットの確認、キーが要る評価の実行、アプリの配布。
  - Worker を出す前は `git pull` で最新の人格カードを取り込む（AGENTS.md）。Worker は `main` に入れたコードから出す。
- **公開の単位とブランチ**：`main` へは作業ブランチを丸ごとマージして出している。サイトに出るファイルを変える作業は、次の単位ごとにまとめて出し、途中のものを混ぜない。
  - サイトに出る単位：T0.1／T1.1／T3.4 の説明の直し／M4（T4.2〜T4.9。1回の push）／M5（T5.1〜T5.6。1回の push）／T6.1。
  - サイトに出ないもの（`workers/`・`.github/`・`*.md`）は、いつ `main` に入れてもサイトは変わらない（Worker はデプロイするまで変わらない）。
  - そのため、作業ブランチに置くのは「次に出す単位」と「サイトに出ないもの」だけにする。サイトに出る単位を2つ以上同時に作るときは、2つ目以降を別のブランチで作る（このセッションでは、別のブランチへの push に本人の許可が要る）か、前の単位を出し終えてから作業ブランチに載せる。
  - 単位の途中で急ぎの修正を出すときは、その修正だけを `main` へ入れる。
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
| P | 検証の道具（Playwright）の準備 | - | なし |
| M0 | いまの値を取る計測（Phase 0） | 1 | なし |
| M1 | 索引の追加項目 | 2 | なし |
| M2 | Worker の②（止めた状態で本番へ） | 3 | M1 |
| M3 | 評価と閾値の決定 | 4 | M2、P |
| M4 | 検索語を URL に残さない | 5 | P |
| M5 | 404 の公開 | 6 | M0 から2週間、M3 の合格、M4 |
| M6 | アプリの更新 | 7 | M4 |
| M7 | Worker の日刊リンクを新しい形に | 8 | M6 が行き渡る |

前提の無い P・M0・M1 は同時に始められ、P の後は M4 も始められる。M5 は M6・M7 を待たない（設計書 13章の5）。

## 3. 作業一覧

状態は 5章の表で管理する。規模は S（半日以内）・M（1日程度）・L（数日）の目安。

### P 検証の道具の準備

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| TP.1 | `.github/scripts/package.json`・`package-lock.json` に `playwright` を版を固定して置く。AGENTS.md の「npm を使うのは」に足す | 10.3・12章 | Claude | S | `cd .github/scripts && npm ci` で入り、Chromium でページを開ける（手元は `npx playwright install chromium`。Claude Code の環境で版が合わなければ、`executablePath` で入っている `/opt/pw-browsers/chromium` を指す）。`bash build.sh` の公開物に `.github/` が出ない |

### M0 いまの値を取る（Phase 0）

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T0.1 | 404 に `not_found_keyword_count` を足す | 6.6 | Claude | S | 入力が1.5秒止まったときだけ、①の件数（6以上は6）を送る。読み込み中・失敗では送らない。検索語を送らない。ほかの動きは変わらない。`node --check` が通る |
| T0.2 | GA4 でイベントを確かめ、取り始めた日を 5章に書く | 8.1 | 本人 | S | GA4 の DebugView などで `count` が見える |

### M1 索引の追加項目

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T1.1 | `site-search-index.py` に `rank_title`・`tags`・`category`・`genre` と上限・合計400文字の検査を足し、`test-site-search-index.py` を足す。`data/site-search.json` を作り直す | 4章 | Claude | M | 検査が通る。`bash build.sh` が通る。`data/site-search.json` の差分が追加項目だけ。`main` へ出し、本番の `https://tk.st/data/site-search.json` に追加項目が載る（`build.sh` がデプロイ時に作り直したもの）。いまの Worker の③が動く（知らない項目は読み捨てる） |

### M2 Worker の②（止めた状態で本番へ）

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T2.1 | `site-search.js` の下ごしらえ：`sha256`・`isBillingFailure`・`QUOTA_RE` を移し、点数付けを `scoreItems` に切り出す | 3.6・3.13 | Claude | S | 動きは変えない。いまの `test-magi2.mjs` がそのまま通る |
| T2.2 | 索引のスナップショット：本文のハッシュ、`makeSitePages` の追加項目、`cache.raw`・`rankReady`・`candidate_hash` | 3.5・3.11 | Claude | M | 不完全な索引で `rankReady` が false。③の寛容な検査は変わらない |
| T2.3 | `personas.js` に `SITE_RANK`（日英の問いを両方持つ） | 3.4 | Claude | S | モデル ID の直書きが無い（`ai_models.py check`） |
| T2.4 | `site-rank.js`：変換・候補・要求の組み立て・判定・結果・キャッシュ（scope は `site` だけ）。`test-magi2.mjs` の読み込む一覧に足す（つなぐ順は設計書 3.13） | 3.6〜3.10・3.13 | Claude | L | 10.1 の判定・変換・キャッシュ・URL の検証が通る |
| T2.5 | `index.js`：入口の振り分け、本文読み取りの期限と中止、`handleSiteRank`、回数・ログ・応答の形 | 3.1〜3.3・3.11・3.12 | Claude | M | 10.1 の入力・回数・期限の検証が通る。`mode` なしの③は、いまの検証がそのまま通る |
| T2.6 | 通知に `signal` と期限：`searchUpstream`・`sendAlert` に省略できる引数を足す | 3.8 | Claude | M | 10.1 の通知の検証が通る。②の確定した通知は、切断では止まらず、独立した5秒の期限で終わる（要求の `signal` を渡さない）。引数を省略した③・チャットの通知は変わらない |
| T2.7 | `wrangler.toml`：`SITE_RANK_ENABLED = "false"` と `compatibility_flags = ["enable_request_signal"]`（本番と `env.eval`）。`workers/magi2/README.md` にフラグの理由を書く（外すと②・③の索引の取得・上流の呼び出しが切断で止まらない。確定した通知はフラグに関係なく5秒の期限で終わる） | 3.3・12章 | Claude | S | `npx wrangler deploy --dry-run --config magi2/wrangler.toml` が通る |
| T2.8 | `test-magi2.mjs` に 10.1 の検証を足す。検証は T2.1〜T2.6 のそれぞれのコミットに含め、ここでは抜けを埋める | 10.1 | Claude | M | `node --test` が通る |
| T2.9 | `wrangler dev` で切断の確認 | 3.3 | Claude | S | 手元では確かめられないと分かった（下記）。確かめは T2.10 に移す |
| T2.10 | 本番へデプロイ | 9章の3 | 本人 | S | 本番で `mode: 'rank'` が `disabled` を返す。③とチャットがいままで通り答える。`wrangler tail` を見ながら 404 の③を送って数秒でキャンセルし、`site_search` の `elapsed_ms` がキャンセルまでの時間で終わる（切断で止まる。設計書 3.3） |

### M3 評価と閾値の決定

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T3.1 | 評価セットの案：`.github/site-search/rank-queries.json`（60件以上、`tune`・`final`、6種類、答えの無いもの20%） | 10.4 | Claude | M | 形式の検査が通る。`reviewed` はまだ空 |
| T3.2 | 評価セットの確認 | 10.4 | 本人 | S | 正解を直し、`reviewed` に日付を書く（結果を見る前） |
| T3.3 | `eval-site-rank.mjs`：精度（Jev 直接・方式と閾値の比較・2回）、ブラウザの応答時間（Playwright）、`--smoke-payload`、索引の `candidate_hash`（手元の索引と本番の `site-search.json` の両方から、Worker と同じ関数で作る） | 10.4・10.5 | Claude | L | キーが無ければ精度の測定は止まる。手元と本番の `candidate_hash` を並べて出せる（T3.6 で使う）。`--smoke-payload` が本番の関数で要求を出し、`npm ci` をしていない環境（`ai-model-watch.yml` と同じ）でも動く（Playwright はブラウザの測定のときだけ読む。設計書 10.5） |
| T3.4 | `tune`：言語を決め、閾値を選ぶ。取りこぼした項目の説明を直したら索引を作り直して測り直す。直した元の JSON（`game.json` など）は `main` へ出し、本番の索引に載るのを待つ。説明は `/tools/`・`/game/`・404 の一覧にもそのまま出る。`tools.json` を直すと、push のたびに動く `magi-context.yml` が人格カードを作り直す（OpenAI の費用が少しかかる） | 3.4・10.4 | 本人（キーが要る）＋ Claude（結果の読み取り・説明の直し） | M | 2回とも精度・誤表示率の条件を満たす閾値がある |
| T3.5 | `SITE_RANK` を決めた値に（`question_language`・`threshold`・`revision`。使わない言語の文面を消す）。Worker を出し直す | 3.4 | Claude → 本人（デプロイ） | S | 本番の `revision` が評価と同じ |
| T3.6 | `final` を2回（精度） | 10.4 | 本人 | S | 2回とも PRD 7.1 の精度・誤表示率の条件を満たす。測定に使った索引が本番と同じ。本番の `https://tk.st/data/site-search.json` から作った `candidate_hash` と、測定に使った索引のものが一致する（この時点の本番の Worker は②を止めていて `disabled` を返し、索引を読まないので、Worker のログでは比べられない） |
| T3.7 | `wrangler.toml` の `SITE_RANK_ENABLED` を true にして本番へ出し（画面は出さない）、ブラウザの応答時間を測る。2回目は UTC の別の日 | 9章の4・10.4 | Claude（変更）→ 本人（デプロイ・測定） | S | 本番に `MAGI_TYPESAFE_API_KEY` がある。本番の Worker のログの `revision`・`candidate_hash` が T3.6 と同じ（②を有効にした後なのでログに出る）（違えば `index_unavailable` か条件の不一致なので、索引の反映を待って測り直す）。2回とも p95 が1.5秒以内で、同じ測定の精度・誤表示率も PRD 7.1 の条件を満たす |
| T3.8 | 記録：`site-search-evaluation.md` に結果をまとめる。`ai_models.py` の smoke に②を足す | 10.4・10.5 | Claude | S | 記録にコミット・ハッシュ・`revision`・2回の数字がある。`ai_models.py smoke` が、npm の依存を入れない状態で通る |

- **合格しなかったら**：本番の `SITE_RANK_ENABLED` を false に戻し、原因（候補の説明・問い・閾値）を直して T3.4 からやり直す。`final` を見てから閾値を選び直す場合は、評価セットを作り直す（設計書 10.4）。

### M4 検索語を URL に残さない（PRD 6.1）

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T4.1 | `update-modified.py`：`Date-Sync: skip` のコミットを飛ばす。説明を冒頭に書く | 8.6 | Claude | S | 手元の一時リポジトリで、トレーラー付きのコミットが日時に使われない。先に `main` へ出す |
| T4.2 | `daily-ui.js`：受け渡しの受け取り、ヘッダー検索とタグの処理、`q` を書かない、`location.search` の `q` を読む処理を消す | 8.3 | Claude | M | 手元で `#q=`・古い `?q=`・ヘッダー・タグが動く |
| T4.3 | `daily_engine.py`：head の同期処理（削除と検査を分ける）、ヘッダーの検索欄、タグの `#q=`、`daily-ui.js?v=` | 8.2・8.3 | Claude | M | `test-daily-news.py` が通り、手元で `--rebuild` した HTML を T4.8 で確かめる（このテストは生成の HTML を見ない）。受け取らない値も URL から消える |
| T4.4 | 404：日刊リンクを `#q=` に、③の日刊リンクの検査を新旧両方に | 8.4 の1 | Claude | S | 古い形は新しい形に直して `href` に入る |
| T4.5 | トップページ（`index.html`。ページの中に書く）と `magi-app/www/app.js` の日刊リンクの検査 | 8.4 の1 | Claude | S | `test-magi2.mjs` の画面の検査が通る。トップページに外部スクリプトを足していない |
| T4.6 | `analytics.js`：Ahrefs に `data-page-location` | 8.5 | Claude | S | Ahrefs の読み込みの属性に `#` 以降が載らない |
| T4.7 | `preview-404-ai.py`：日刊リンクの模擬を新しい形に | 10.3 | Claude | S | 模擬の `mock-daily` で新しい形が出る |
| T4.8 | `test-site-search-ui.mjs` の URL の部分（手元。TP.1 の Playwright を使う） | 10.3 | Claude | M | 目印の検索語が、外へ出る通信・URL・参照元に無い（手元の見当） |
| T4.9 | 公開：T4.2〜T4.7 のコミットと、`generate-nitori-daily.py --rebuild`・`generate-retail-tech-daily.py --rebuild` の結果（`Date-Sync: skip` 付きの1コミット）を、**1回の push** で `main` へ | 8.6 | Claude（コミット）→ 本人（push の指示） | S | 下の注を守る。`--rebuild` は最新の `main` を取り込んだ直後に行い、日刊の bot の実行（01:55・02:05 JST）より前に push する。push までに bot の号が `main` に入ったら、取り込んでから `--rebuild` をやり直す（bot の号は古いテンプレートで作られ、作り直さないと古いヘッダーの検索欄が残る）。`--rebuild` の差分に検索以外の変更が混ざったら別のコミットに分ける（同じ push に入れてよい）。`sitemap.yml` の後も号の `dateModified` が変わらない |
| T4.10 | 本番の URL の検証（本物の GTM・Ahrefs） | 10.3 | Claude（届かなければ本人） | M | PRD 6.1 の受け入れ条件。GA4 に `view_search_results` が無い。検索語が載る計測があれば、本人が GTM でそのページの計測を止める |

- **T4.9 を1回の push にする理由**（ブランチの扱いは 1章）：新しい `daily-ui.js` は URL の `q` を読まず、head の処理が渡す値だけを受け取る（設計書 8.3）。`daily-ui.js` や 404 の `#q=` のリンクだけが先に出ると、作り直す前の日刊の HTML（head の処理が無い）では、タグ・ヘッダー検索・404 からの受け渡しが動かない期間ができる。`daily-ui.js`・生成した HTML・404・トップページを同じ Pages のデプロイで出す。

### M5 404 の公開

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T5.1 | `assets/site-search.js`（共通部品） | 5章 | Claude | L | 状態・世代・応答の検査・計測が設計どおり |
| T5.2 | 404 の画面：検索ボタン、②の欄、Enter とキー操作、③の出し方、①の重複除き、文言、ダイアログ、計測。`RANK_ENABLED` は止めるための定数として持つ | 6章 | Claude | L | `RANK_ENABLED` を false にすると、いまと同じ動きに戻る。`node --check` が通る |
| T5.3 | `preview-404-ai.py` に②の模擬（遅い・欠け・上限・停止・外部 URL） | 10.3 | Claude | S | 手元で各状態を目で見られる |
| T5.4 | `test-site-search-ui.mjs` の②の応答の検査・状態・連携・表示 | 10.3 | Claude | M | 外部 URL などを含む応答を描かない。PRD 3.1 と 7.4 の画面の条件が通る |
| T5.5 | 説明を直す：`AGENTS.md`・`workers/magi2/README.md`・`.github/JEV.md` | 12章 | Claude | S | 送り先・回数・停止が書いてある（`enable_request_signal` は T2.7 で書いた） |
| T5.6 | 公開：T5.1〜T5.5 を、`RANK_ENABLED` を true にして1回の push で `main` へ | 9章の6 | 本人（指示） | S | 前提（M0 から2週間・M3 の合格・M4）を満たす。本番の `SITE_RANK_ENABLED` が true のまま（T3.7）。本番で②・③が動き、止め方（下記）を確かめてある |
| T5.7 | 公開後の見守り（1〜2週間） | 8.2（PRD） | 本人＋ Claude | S | GA4 のイベント、Worker のログ（失敗の種類・判定なし）、Jev の費用、全体上限の通知 |

- T5.1〜T5.5 は T5.6 まで `main` へ出さない（文言も変わるので、②より先に一部だけ公開しない）。ブランチの扱いは 1章の「公開の単位とブランチ」。
- **止め方**：Worker の `SITE_RANK_ENABLED` を false にして出す（画面は `disabled` を受けていまの動きに戻る）。そのあと `RANK_ENABLED` を false にする（設計書 9章）。

### M6 アプリの更新

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T6.1 | `magi-app/www/index.html` の `app.js?v=` と `sw.js` のキャッシュ名を上げる | 8.4 の3 | Claude | S | PWA を開き直すと新しい `app.js` になり、チャットの日刊リンクが出る |
| T6.2 | ネイティブ：`npm run sync`・再ビルド・配布 | 8.4 の3 | 本人 | M | ストアの更新が出る |

### M7 Worker の日刊リンクを新しい形に

| ID | 作業 | 設計書 | 担当 | 規模 | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| T7.1 | `validateSiteChoice` の `daily.url` を `#q=` に。検証を直す | 8.4 の4 | Claude | S | `test-magi2.mjs` が通る |
| T7.2 | デプロイ | 9章の8 | 本人 | S | M6 が行き渡っている。404・トップ・アプリで日刊リンクが出る |

## 4. 危ないところ

作業の中で手当てするもの（評価の不合格、全号の再生成、GTM、`enable_request_signal`、アプリの配布の遅れ）は、それぞれの作業と注に書いた。ここには作業の外で起きるものだけを書く。

| 何が | どうなる | どうする |
| --- | --- | --- |
| Jev の障害・残高切れ | ②が `unavailable` | 画面は①と③で動く。通知で気づく。長引けば `SITE_RANK_ENABLED` を false |
| 本番の②を先に有効にする期間（T3.7〜T5.6） | Origin を偽れば呼べる | 全体の上限（3,000回/日）で費用を抑える。長引くなら false に戻す |

## 5. 進み具合

| ID | 状態 | メモ |
| --- | --- | --- |
| TP.1 | 完了（2026-10-06） | `playwright@1.56.1`。この環境の Chromium（1194）と版が合うので `executablePath` は不要 |
| T0.1 | 公開（2026-10-06） | 手元の Playwright で確認：止まって1.5秒で1回、`{ count }` だけ、同じ入力は1回、1ページ10回まで、一覧の読み込み失敗・変換中は送らない |
| T0.2 | 未着手 | 取り始めた日： |
| T1.1 | 公開（2026-10-06） | ツール9・ゲーム8・記事5の22行に追加項目。`test-site-search-index.py`・`test-magi2.mjs`・`build.sh` が通る |
| T2.1〜T2.9 | 実装済み（2026-10-06） | T2.4・T2.5・T2.8 は1コミット（②の検証が両方にまたがるため）。`test-magi2.mjs` 120件が通る（コードレビューの修正を含む。2回目のレビューで、通知の成功応答の本文の取り消し、429本文の4KiBをバイトで切る、切断時に②が③のログを残さない、を直した）。`wrangler deploy --dry-run` が通る。T2.9：手元の `wrangler dev` では、フラグの有無にかかわらず切断が `request.signal` に伝わらなかった（最小の Worker で確認）。T2.10 で本番で確かめる |
| T2.10 | 完了（2026-10-06） | `main`（`e63ce7cb`）から出した（Version `64497f56`）。`--probe` で `"reason": "disabled"`、`/magi2/models` が200、③の空の検索語が400、`site_debate` の無い③が409。本人が `wrangler tail` で確認：通常の③は討議と統合まで進んで `elapsed_ms 10004`。約3秒でキャンセルした③は `Canceled` で、`unavailable` → `elapsed_ms 4960` で終わり、その後に討議・統合の呼び出しが無い（切断で止まる）。チャットは分類・2回の討議・統合・予測まで通常どおり |
| T3.1 | 実装済み（2026-10-06） | 80件（`tune`・`final` 各40。各セットに6種類、答えの無いもの各8件＝20%、英語の画面各8件）。`final` はブラウザの1回の上限（50件）以内なので、事前の選び直しは要らない。形式の検査は `node .github/scripts/eval-site-rank.mjs --check`（T3.3 で測定を足す。正解の ID は手元の索引から Worker と同じ関数で作った②の対象と照らす）。迷いそうな正解と、似た機能があって紛らわしい「答えの無いもの」には `note` を付けた |
| T3.2 | 未着手 | |
| T3.3 | 実装済み（2026-10-06） | `eval-site-rank.mjs` に `--hash`・`--smoke-payload`・`--accuracy`・`--browser`・`--probe`。精度は本物の Jev の応答を残し、閾値ごとの結果は Worker の `rankSearch` に流し直して作る（並べ方・URL の検査・`complete` まで本番と同じ）。方式は日英×基準の有無の4つと、`404.html` から取り出した「含む」検索。確かめたこと：`--hash` で手元と本番の `candidate_hash` が一致（`72ed536f…`、Worker のログの値とも同じ）。`--smoke-payload` は npm の依存なしで動く。精度は Jev を模擬した応答で通した（閾値ごとの差、時間切れ、判定の欠け、方式ごとの要求の中身）。`--probe`・`--browser` は本番へ実際に送り、404 のページ・プリフライト・解析の遮断が動くこと、②の形でない応答で止まることを確かめた（本番はまだ②の無い版）。評価セットは未確認（T3.2）なので、本物の Jev では測っていない。レビューの修正：方式と閾値の比較は `tune` だけにし、`final` は確定した設定（`question_language` の基準付きの問いと `threshold`）だけで測る（T3.5 で使わない言語の文面を消した後も動く）。答えの読めない応答（JSON でない 200 など）は、その問い合わせだけを失敗として分母に残す。`--accuracy` は、公開 HTML から索引を作り直して `data/site-search.json` とバイト単位で違えば止まる。あわせて `site-search-index.py` が Windows で CRLF を書いていたのを LF に固定した（全行の差分と `index_hash` のずれを防ぐ）。2回目のレビューの修正：ブラウザの測定の期限を画面と同じ8秒にし、画面の検査（設計書 5.3）に通らない応答は `failed` に数える。2回の比較は、表示ページの増減（集合）と順位だけの変化を分けて数える。精度の測定は Jev の毎秒のトークンの上限に当たらないよう1件ずつ順に呼ぶ |
| T3.4〜T3.8 | 未着手 | |
| T4.1 | 実装済み・未公開 | 一時リポジトリで確認（トレーラー付きは飛ばす。大文字小文字は問わない）。いまの履歴では変更前と同じ結果 |
| T4.2〜T4.8 | 未着手 | |
| T4.9〜T4.10 | 未着手 | |
| T5.1〜T5.5 | 未着手 | |
| T5.6〜T5.7 | 未着手 | |
| T6.1〜T6.2 | 未着手 | |
| T7.1〜T7.2 | 未着手 | |

最初に進めるのは T0.1（2週間の計測を早く始めるため）、続けて TP.1・T1.1・T4.1。
