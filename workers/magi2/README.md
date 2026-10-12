# MAGI2 の変更と確認

人格・呼び出し設定は `personas.js`、モデル ID と表示名は `config/ai-models.json` が正本。
人格カードの生成と更新はルートの `AGENTS.md` を参照。
人格の本文は120字の指示を維持し、指示を外した長い応答も `DEFAULTS.persona_response_max_chars`（4000字）で制限して討議の入力が膨らまないようにする。
Jevを使う環境には `MAGI_TYPESAFE_API_KEY` をWrangler secretで設定する。手元の `.dev.vars` は本番へ自動反映されない。未設定でも回答は続くが、分類はフォールバックとなる。

## リアクションDBの移行

既存DBには、Workerをデプロイする前に次を1回適用する。新しいDBは `schema.sql` で作るため、この移行は不要。

```sh
cd workers
npx wrangler d1 execute tk-st-magi2-db --remote --file=magi2/migrations/0001_reaction_ownership.sql
npx wrangler deploy --config magi2/wrangler.toml
```

登録時は `id` と `delete_token` を返し、取り消しには両方が必要。DBにはトークンのSHA-256だけを保存する。
既存行と旧アプリの履歴は削除トークンを持たないため、連番だけでは取り消せない。必要な旧行の削除は管理者がDBで行う。
同じIPからの同じ内容の重複登録は保存せず、元の登録者のトークンも返さない。
登録・取り消しを合わせ、IPごとに30回/分・480回/UTC日まで。

## 入力とストリーム

- 本文は1メッセージ1,000文字、過去の統合回答は4,000文字まで。人格の履歴も含めた本文合計は40,000文字まで。
- DJ相談の状況説明は `context`（4,000文字まで）に分け、先頭のユーザー発言に付加する。
- リクエスト全体は12MiB、画像は1枚5MiB・合計8MiBまで。枚数は1発言4枚・履歴込み8枚。
- 画面は古い画像を送信対象から除いて直近8枚を残す。端末に保存した履歴は変更しない。
- 統合は空でない本文、`finish_reason: stop`、`[DONE]` がそろったときだけ正常完了する。
- 通常回答は `done` 後に保存する。MAGI採決では受信済みの決議を保持し、説明の完了は `integrated_end` で区別する。
- 先行改修の公開0（4.5、2026-10-12公開）は、送信から `done` / `error` の受信まで300秒を上限にする。15秒の空白では打ち切らず、まとめて届く環境の注記を出し、その送信の残りを順に再生する。Workerは開いた直後の2KiBコメントと10秒ごとのpingを送り、終了・切断でタイマーを止める。
- 再生は人格等を700msごと、統合本文を12文字・30msごとに渡し、長い塊は20秒以内へ縮める。受信完了後の再生には通信の期限を掛けない。停止・期限・切断では受信済みを先に反映し、会話の切り替えでは古い列を捨てる。受信完了後の停止は「すぐに全部表示」として正常に保存する。
- 404の③の150秒・画面165秒と、検索②・クリック記録の設定や契約は維持する。公開結果と残る実機・会社PCの確認は [先行改修評価](先行改修評価.md)、ローカル評価の詳細は [先行改修進捗](先行改修進捗.md) を参照。

## 説明の配信（公開2・公開準備中）

`GET /magi2/models`はモデル名・人格の説明に加えて`provider_label`と`privacy`を返す。段落の正本は`personas.js`の`PRIVACY`。日英の`[{text, requires?}]`を文字だけで持ち、画面が対応する機能の印をすべて満たす段落だけ表示する。送り先はOpenAI・DeepSeek・Anthropic。トップとアプリは10分で説明を取り直し、取得失敗・旧Workerでは会社名を挙げない案内を出す。`themes.light`はLuna、`themes.dark`はHaikuを返す。旧画面のため`synthesizer`はライトのモデルのまま維持する。

## 討議の回数（最大5回）

新契約のsite・musicと404は、第1回（各自の意見）と第2回（他人格の意見を見て再回答）の後に統合する。consultと旧契約では、その後も統合人格（本人）が判定して回数を決める。新契約で第1回に1人だけ答えた場合は第2回を省き、呼んでいない回の欠席通知は送らない。
値と判定のプロンプトは `personas.js` の `DEBATE`、判定のモデルは `DEFAULTS.models.judge`（Luna・推論 low・strict な JSON スキーマ）。

```
第1回 → 第2回 → 判定 ─ 答える ──────────────→ 統合
                   └ 聞き返す → 第3回 → 判定 ─ …… → 第5回 → 統合（第5回の後は判定しない）
```

- 第2・第3回の後は、結論だけでなく「追加の一往復で理由・具体性・判断の質を改善できるか」で判定する。
  相談・選択・評価で、理由が浅い、案の弱点や選ぶ基準が未検討なら、具体的な論点を聞き返す。
- 第4回の後（`strict_after_round: 4`）からは「答えを変えうる論点が残っているか」に絞る。価値観や好みの違いで
  割れているだけなら打ち切り、どれを取るかは統合で本人が決める。
- 全回で一致を求めず、雑談・あいさつ・単純な質問は打ち切る。ユーザーにしか分からない情報は推測で埋めない。
  第2・第3回の後は、既知の条件で選択肢の比較・弱点・判断基準を検討できるなら続け、それもできなければ打ち切る。
- 聞き返すときは、論点に答えられる人格（1〜3人）にだけ、それぞれ問いを向ける。聞かれた人格は、自分のこれまでの意見・
  他の人格のいまの意見・問いを受けて答える。聞かれなかった人格は前の回の意見のまま統合に回る。
- 判定には上限の回数といまの回を伝え、上限までにまとめるよう、論点を1つに絞って回ごとに問いを狭めさせる。
- 判定のメモ（一致・対立とその扱い）は統合の討議メモに添える。第5回まで回したら、上限で打ち切ったことも添える。
- 討議の開始から `budget_ms`（90秒）を過ぎたら次の回を始めない。判定の失敗・時間切れ（`judge_ms`）は「答える」として扱う。
- 変更前の実測（2026-10-04、手元から本番の API）：判定は1回 約2.5秒（推論トークン 60〜170）。ふだんの質問は第2回の後の判定で答えに進んでいた。

通常経路では、画面がリクエストに `adaptive_debate: true` を付けたときだけ第3回以降を行う（トップページ・アプリ・`dj/request/` は付けている）。
第2回を省いた経路は、第1回の意見だけが残り、第2回の枠を出さず、考え中を解除して統合回答を表示する。設計§9.4の「第1回から統合へ進んだことが分かる表示」はこの組合せを指し、追加のラベルは設けない。
付けない画面は第2回で止め、判定もしない。配布済みの古いアプリは第3回以降の `persona` イベントを初回の意見として保存してしまうため。

ストリームのイベント（第3回以降）:

- `ask`: `{ round, max_rounds, questions: [{ codename, name, text }] }`。聞き返した問い。画面は聞かれた人格のカードに枠を足して考え中に戻す。
- `persona`: これまでと同じ形で `round` が3〜5になる。答えられなかった人格は `absent: true`（前の回の意見で統合する）。
- `judge`: `{ round, action: 'answer' }`。判定が答えに進んだ（失敗した）とき。画面は使わないが、無通信の見張りを延ばす。

画面は履歴の `debate` に、聞き返された回を `followups: [{ round, ask, text }]` として足して送る。Worker は人格の過去の意見に、
その中でいちばん新しいものを使う。

## 発言分類と会話の言語

`personas.js` の `INTENT_CLASSIFY` と `classification.js` を本番・実装前確認・週次smokeで共有する。
`classification_state: true` のトップページ・アプリでは初回にlanguage/votable/intent/site_pagesの4問、継続では言語を省いた3問をJevへ1回で送る。
分類は最新本文全体（1,000文字まで）と直近2件までのユーザー本文、言語は最初のユーザー本文（500文字まで）を使う。画像・AI回答・状況説明は分類に送らない。
DJは `entry: dj-request` によりmusic/no/no固定で、言語の初回1問だけ。旧画面は従来のリクエストごとの言語1問を使う。

- 問いごとに選択肢と有限の0〜1のconfidenceを検査し、language/intent/site_pagesは0.5、votableは0.7以上を採用する。
- 言語を引き継ぐ `reply_language` はversion・code・sourceを検査する。初回に失敗しても日本語の規則、固定した短いsample、UI言語で確定し、次のターンには再判定しない。
- 人格カード取得・分類は利用回数の確認と並行して始める。確認後に、対応画面へ `classification` を本流・タイトルより先に1回だけ送る。拒否・停止・切断時は分類も止める。
- 会話ごとの言語はブラウザ内の現在の会話と保存会話に残す。受信後に回答が失敗しても言語を消さず、新しい会話で初期化する。
- 分類結果・本文・ハッシュをD1へ保存しない。ログはプロファイル・問い・choice・confidence・時間・失敗だけ。
- 第1段階では採決を無効にし、`magi_candidate: false` を返した。第2公開で採決・演出・履歴を有効にし、実機・表示確認まで完了した（[評価記録](第2公開評価.md)）。

```sh
node .github/scripts/probe-jev-classify.mjs
```

本番と同じ問いで初回4問・継続3問を各20回、DJ・旧画面の言語1問も確認する。キーは環境変数か非追跡の `.dev.vars` から読み、本文やキーを出力しない。

## 上流の残高切れの通知

1人格の失敗は欠席（`[NO RESPONSE]`）として黙って進むので、チャージを使い切っても画面からは気づきにくい。
各社の API が 401・402・403、または残高や枠の不足を示す 429 を返したら、Resend でメールを送る
（ただの回数制限の 429 は送らない）。同じ会社・同じ HTTP ステータスは UTC の1日に1通で、送った印は
`rate_limit` に `alert:<会社>:<ステータス>` の行として残す。送れなかったら印を消し、次の失敗でまた試す。

```sh
cd workers
npx wrangler secret put RESEND_API_KEY --config magi2/wrangler.toml   # dj-offer と同じキーでよい
npx wrangler secret put ALERT_TO       --config magi2/wrangler.toml   # カンマ区切りで複数可: a@example.com, b@example.com
npx wrangler secret put ALERT_FROM     --config magi2/wrangler.toml   # 例: MAGI <magi@tk.st>
```

どれかが無ければ、ログに `upstream_alert` を出すだけで会話は止めない。

全利用者の合計にも1日の上限（`DEFAULTS.global_daily_limit`、いまは300回）を掛けている。Origin は名乗れるので、
IP を替えながら大量に呼ばれても費用に天井を作るため。超えた最初の1回で同じ仕組みのメールを送る（`alert:global`）。

## 停止

画面は生成中に送信ボタンを停止ボタン（■）に変え、押すと接続を切る。Worker はストリームの `cancel` で
続きの人格・統合・予測の呼び出しを止める（タブを閉じたときも同じ）。止めた質問は入力欄に戻す。

## MAGI採決（第2公開）

本番の `MAGI_MODE_ENABLED` はWeb/PWAの第2公開で `"true"`。両対応通知 `classification_state: true`・`magi_panel: true` を持つ一般会話で、Jevが明示的な賛否の問いを確信度0.7以上と判定した場合に議題化する。却下・失敗時は元の分類の通常経路に戻る。DJと404は採決へ入らない。パネル未対応の旧画面は通常経路を保つ。

Web/PWAとAndroid v4.1は公開済み。Androidは本人が実機で確認し、[配布入口](https://tk.st/magi-app/android/)から署名付きAPKを取得できる。iPhoneには[Web版](https://tk.st/magi-app/www/)をSafariで開き、ホーム画面に追加する方法を案内し、本人による追加・起動・採決・履歴の確認も完了した。ネイティブiOSのビルド・実機確認はApp Store公開を希望する段階で着手する。採決を止める場合は本番の `[vars]` を `"false"` にしてコミットし、Workerを再デプロイする。画面や既存会話の履歴はそのまま使える。

議題化・タグ読取・多数決は `magi-mode.js`、指示と時間・スキーマは `personas.js`。3人格の初回・再回答と最大5回の聞き返しを使い、各人格の最新の有効票から2票以上で承認／否決、それ以外は保留にする。読取待ちの `persona` は `vote_state: pending`、票なしの確定も含め必ず `final` を再送する。過去票はタグではなく「承認／否決／票なし」として渡す。

決議を `verdict` で先に送り、統合は採決を選び直さず根拠を説明する。テーマの重み付け・ページ選択・サイト案内は採決へ混ぜない。正常な説明の終端を `integrated_end`、予測を含めた全受信の終端を `done` で通知する。決議前の中止は往復を除去、決議後の中止は決議を保存し、説明未完なら `reason_missing: true`、説明完了済みなら全文を保持する。

両画面の `MAGI_PRESENTATION_CORE` は時間・色と純粋な演出進行、`MAGI_VIEW` は描画・時計・スクロールを担当する。一致は単体検証で守る。3枠内はコードネームだけを描き、状態は色と明滅で表す。票・応答状況の文字は審議記録とSVGの読み上げに残す。票は600ms以上の間合い、最後の状態適用から600ms後に決議、その強調完了後に説明を表示する。非表示・動き軽減・停止は最新状態へ即時反映し、保存は演出から独立させる。履歴は静止パネルと折りたたんだ審議記録で復元する。

初回から有効票をパネルに反映し、承認は青、否決は赤にする。再討議と票の読取待ちでは直前の有効票の色を保ち、新たな有効票で切り替える。決議前は各人格の現在の色と黒の明滅を続け、決議の受信後に静止する。応答が届いた際の輪郭強調・表示待ちでは明滅を一時停止する演出を、本人の原作再現の判断により維持する。無応答・読取不能で票を引き継ぐ場合は従来どおり淡色にし、有効票のない確定した欠席・読取不能は灰の静止表示にする。

本人指示による意匠調整後は `viewBox="0 0 700 470"` を使い、漢字見出し・決議ラベルの下に英語字幕を付けない。日本語の決議要約は「決議: 承認（賛成2・反対0・票なし1）」の形とし、読み上げでは「MAGI の」を前置する。説明欠落時の保存本文も同じ要約を使い、過去採決をモデルへ渡す見出しの結果も承認・否決・保留で記す。

外部AIを使わないパネル確認は `.github/scripts/preview-magi-mode.py` を起動し、`http://localhost:8000/magi-app/www/?api=http://localhost:8787` で `mock-slow`・`mock-change`・`mock-hold` を送る。本人の指示（2026-10-05）で青2色の案を外し、現在の色と黒を人格ごとに120ms／150ms／180msで切り替える明滅へ変更した。周期は240ms／300ms／360ms、位相60ms、承認は審議と同じ青。票の表示間隔600ms・決議前600msは独立して維持する。動き軽減・非表示・履歴は静止する。従来の1秒3回以下の条件は撤回しており、WCAG適合を宣言しない。

```sh
# 外部APIなし。トップページとPWAで mock-approve / mock-reject / mock-hold 等を送信
python -B .github/scripts/preview-magi-mode.py
# 保存済みの手元のキーで合成入力だけを評価。結果は非追跡の workers/.wrangler/
node .github/scripts/eval-magi-mode.mjs --mode=motion
node .github/scripts/eval-magi-mode.mjs --mode=entry
node .github/scripts/eval-magi-mode.mjs --mode=paired --batch=1
# 指定した合成入力だけ再評価する。結果ファイルは全件評価と分ける
node .github/scripts/eval-magi-mode.mjs --mode=pilot --cases=1,16
# 票と判定だけ模擬にし、理由なし・保留・前回票の説明を実APIで確認
node .github/scripts/eval-magi-mode.mjs --mode=special
```

pairedは10組ずつ（batch 1〜3）通常回答と採決を交互に比較し、上流の認証・課金上限エラーで中断する。API観測はVM内の本番処理を通し、カード・索引・D1は手元の固定値で置き換える。Cloudflareの通信評価・実機・録画解析・本人による演出確認の代わりにはしない。公開手順と未確認事項は実装進捗・第2公開評価を参照。

## 404のAI検索とチャットのサイト案内

`POST /magi2/site-search?site_debate=1` は `{ query, locale: 'ja' | 'en' }`（200文字・本文4KiBまで）を受け取る。
公開HTMLから自動生成した `data/site-search.json` を取得・検証した後、OpenAIに最大3件のIDを選ばせ、照合したリンク候補を3人格の2回討議とmediumの統合へ渡す。リンクは照合済みIDから、commentは統合本文から作る。通常は選択1回・人格6回・統合1回の計8回。
URLやタイトルをAIに生成させない。失敗は503で、該当なしの正常応答と分ける。応答は `no-store`。

対象はtk.stで公開されるHTMLのうちnoindex以外。404・転送用・別URLをcanonicalとする重複ページ・MAGIのアプリの本体（`/magi-app/www/`）も除く。
`/dj/request/` と日刊の号も対象で、`/dj/booth/`・`/dj/schedule/`・記念日のページはnoindexにより対象外。
主な入口は `404.html` の常設入口（`data-entry`）が正本。noindexでも載せ（お問い合わせ）、`hub: true` と英語名（`title_en`・`description_en`）を付ける。
生成側は Worker と同じ条件で全行を検査し、合わない行があればビルドを止める。Worker は合わない行だけ飛ばす。
`.github/scripts/site-search-index.py` がタイトル・説明を抽出し、ツール・ゲーム・Glitchは既存JSONのタグや説明も使う。
`build.sh` は公開ファイルを揃えた後に再生成するため、新しいページをWorkerへ手動登録する必要はない。
手元の生成物は `python -B .github/scripts/site-search-index.py` で更新する（手で編集しない）。
新しい404契約の公開はWorker→対応済み404の順。旧404には409・site_search_update_requiredを返し、AIも回数も使わない。新版404はこの応答で再読み込みを案内する。事前に本番相当経路の時間・費用・上流APIの上限の評価を通す。未達ならWorkerと404をともに現行のまま維持する。
AIへは名前・説明・URLとの一致で順位をつけた最大40件・16,000文字分を渡す。主な入口11件は必ず入れ、日刊の号は5件まで。英語の機能語は数えない。
AIの選択IDは、実際に渡した候補内で検証する。ページ本文の検索・自動翻訳は行わない。

- 404検索は既存の `countUp` と `rate_limit` を利用し、UTC日ごとに `search:<IP>`（10回）→ `search:global`（100回）の順に数える。表・移行の追加はない。
- 入力・認可・停止フラグ・一覧取得の失敗では数えない。AI開始後の失敗・0件・キャンセルは数える。全体上限で断った場合のIP回数は戻さない。
- `site_pages: true` の通常チャットは、最新本文の先頭500文字だけでページを選び、統合に添えた同じ候補を `pages` イベントで返す。通常チャットの上限内で行い、`search:` は使わない。DB未設定時は案内を省く。
- 新契約の一覧取得・選択・リンク通知は画面の許可があり、site_pagesがnoでなく、music・DJでない通常経路だけで行う。短い場面説明は一覧とは分ける。
- 通常siteは討議前に選択を確定して候補を全員へ渡す。consultに任意のリンクを添える選択は討議と並列に開始し、統合前には最大2秒だけ待つ。失敗・遅延では検索だけを省く。停止・切断・全員欠席では検索も中止する。
- 両画面は回答の `done` 後だけリンクを表示する。リンクはその場だけで、履歴や次回の要求には含めない。
- サイト案内: 画面が `page`（トップページは `'/'`、アプリは `'app'`）を送ると、「このページは何？」「tk.st とは？」に答えられるよう、
  3人格の system に場面といまのページ（索引の題名と説明。アプリは `SITE_GUIDE.app`）を、統合人格に同じ索引から作るページ一覧を足す
  （主な入口を先に並べ、日刊の号は外し、`SITE_GUIDE.list_max_chars`（6,000字）で打ち切る）。索引はページ選びと共有し、取得は最大1.5秒だけ待つ。
  取れなければ一覧なしで続ける。停止フラグ（`SITE_SEARCH_ENABLED`）が `true` でなければ索引を読まず、場面の説明だけを足す。
  `page` は索引を引く鍵としてだけ使い、文字列としてプロンプトに入れない。ページ選びには今のページの題名を `current_page` で渡し、今のページ自体のリンクは出さない。
  `dj/request/` は `page` を送らないので、案内は足さない。
- 一覧の有効期間は10分、古い一覧は24時間まで使用して裏で更新する。索引全体を検証して差し替え（検査済みの一覧を日英別に保持）、失敗後は1分あける。noindexへの変更・削除もこの更新周期で反映する。
- 検索語・ひとこと・上流本文はいまDB／ログ／Resendに書いていない（約束ではない。2026-10-12 に破棄した）。検索用の運用通知は会社・HTTPコード・用途のみ。通知抑制は既存の `alert:<会社>:<HTTP>`、検索の全体上限は `alert:site-search-global` を使う。

公開フラグの既定はオン。Workerの `wrangler.toml` の `SITE_SEARCH_ENABLED = "true"`、次に404の `AI_SEARCH_ENABLED = true` で有効化する。
停止はWorkerを先に `false` にする。通常チャットは続く。公開前に本番スモークテスト、設計書の20件の品質評価・費用見積もり、GTM設定を確認する。
ネイティブアプリは `npm run sync` と再ビルド後、実機でリンクが開くことを確認する。

### 切断の検知（`enable_request_signal`）

`wrangler.toml` の `compatibility_flags = ["enable_request_signal"]` は外さない。Cloudflare Workers の `request.signal` は、
このフラグがあるときだけ利用者の切断で中止になる。無いと、404 の検索（③と、Jev の検索の②）の索引の取得・上流の呼び出しが、
利用者が離れても止まらない。課金障害の通知は、切断では止めず、独立した期限（`SITE_RANK.alert_timeout_ms`）で終える。
手元の `wrangler dev` では、フラグがあっても切断が `request.signal` に伝わらない（2026-10-06、wrangler 4.147.0 で確認）。
切断の確かめは本番で `wrangler tail` を見ながら行う（`assets/site-search-plan.md` の T2.10）。

### サイト内検索の②（Jev）

2026-10-12公開のPhase 4は `POST https://tk.st/search/api/rank` に `{search_contract:1,mode:'rank',scope,query,locale,filters,generation}` を送る。scopeはsite・nitori・retail・tools・gameに固定。toolsのfilterはcategory、gameはgenre。旧 `/magi2/site-search` の②は従来の3scopeだけを受け付ける。③は従来の入口を維持する。

新入口は索引の世代を回数・結果キャッシュ・Jevより前に照合する。取得は固定URLごとに共有し、更新間隔は最低60秒。要求した版を確定できない／一覧と公開索引が混在する場合は `index_updating` を返し、回数・Jevは使わない。ブラウザは1画面1回だけデータを読み直し、②を自動再送しない。結果・公開版と未確認の実機範囲は[Phase 4公開評価](../../assets/site-search-phase4-release-evaluation.md)。

**5scopeを有効にして本番公開済み。** 2026-10-12に固定tune/final各20問を2回ずつ実Jevで評価し、toolsは閾値0.4／revision 1、gameは0.5／revision 2へ固定。finalでは両scopeの正解が上位5件へ100%届き、正解なしの誤表示は0件。gameの原作を探す1問に続編が混ざる限界も[評価記録](../../.github/site-search/phase4/rank/README.md)へ残した。評価用に有効化する場合も `SITE_RANK_EVAL_SCOPES`・`SITE_RANK_EVAL_KEY` の制限を併用する。実API単体の評価を本番ブラウザの合格へ転用しない。今回も新入口を先行配置して評価後に一般公開し、本番5画面・旧入口3scope・停止／復帰を確認した。一時評価変数／secretは削除済み。固定索引の `cache:no-cache` を使うため、互換日付2025-01-01では `cache_no_cache_enabled` が必要（wrangler.tomlの本番／eval両方に設定）。

日刊2誌の②は`scope=nitori|retail`、`filters`（category・month・region）、画面の索引の`generation`を送る。`SITE_RANK_SCOPES="site,nitori,retail,tools,game"`で5scopeを有効にする。未設定もsiteだけ。媒体だけを止めるときは値からその媒体を外してWorkerを先に再デプロイする。全体の`SITE_RANK_ENABLED=false`が優先。停止応答はdisabledで、索引・回数・Jevを使わず、開いたままの画面も①を続ける。復帰は媒体を戻してデプロイし、画面を再読み込みする。

日刊は全年度の索引を完全に検査し、絞り込み後の全件数Nから候補最大20件Mを選び、Jevで判定した件数Jとともに画面へ返す。対象0件・索引の取得失敗を分け、別の媒体のリンクを許さない。検索語・公開記事の情報をTypeSafeへ送るのはEnter・虫眼鏡の明示操作だけ。入力中・受け渡し・絞り込みでは送らない。検索語はURL・参照元・運用ログ・DB・通知へ残さない。GA4のsearch_termはメール・電話番号を伏せ字にし、計測停止時は送らない。

評価と公開の証跡は[Phase 3公開評価](../../assets/site-search-phase3-release-evaluation.md)。一時的な本番測定では測る媒体を`SITE_RANK_EVAL_SCOPES`にも指定し、secret `SITE_RANK_EVAL_KEY`をx-api-keyで送る要求だけを許す。通常画面はdisabledとなる。評価後は一時変数とキーを削除する。以下は既存のsiteの契約。

`mode: 'rank'` の要求で、索引の各ページに Jev で「目的を果たせる確率」を付けて並べる（設計は `assets/site-search-design.md`、
設定の正本は `personas.js` の `SITE_RANK`）。`SITE_RANK_ENABLED = "true"` のときだけ動き、停止はこちらを先に `false` にする。
回数は③と別に `rank:<IP>`・`rank:global` で数え（1日に IP ごと60回・全体3,000回。値は `SITE_RANK`）、全体の上限の通知は `alert:site-rank-global`。

- 要求は `POST /magi2/site-search`（クエリなし）に `{ query, locale, mode: 'rank', scope: 'site' }`。応答は `{ request_id, status, complete, reason, searched, results }` で、
  上限は 429、要求の誤りは 400、それ以外の失敗（`disabled`・`unavailable`・`index_unavailable`・`timeout`）は 200 の `status: 'failed'`。検索語はいまログ・DB・通知に書いていない（約束ではない）。
- 画面は `assets/site-search.js`（送信・状態・応答の検査・描画・計測）と、404 の `RANK_ENABLED`。Worker が `disabled` を返すと、画面は検索ボタンと②の欄を隠していまの動き（①が0件で③）に戻る。
- **止め方**：先に Worker の `SITE_RANK_ENABLED` を `"false"` にして出し、その後で 404 の `RANK_ENABLED` を false にする（逆にすると、出したままの画面が②を送り続ける間がある）。
- 応答時間は `.github/workflows/site-rank-browser.yml`（Actions のランナーのブラウザから本番へ）、精度は `node .github/scripts/eval-site-rank.mjs --accuracy` で測る。

### 共通検索の候補クリック（`/search/api/click`）

共通検索（`assets/search-ui.js`）の候補を開くと、画面が `{ scope, query, href, list, position }` を sendBeacon で送る。
Worker は形と画面の種類を確かめ、`countUp` で IP ごと（`click:<IP>`）と全体（`click:global`）の1日の上限を数えてから、D1 の `search_clicks` に1行書く。
1件で書くのは最大3行で、上限に達した後は書かない（無料枠の書き込み10万行／日を守る。値は `personas.js` の `SEARCH_CLICK`）。応答は 204 で、画面は読まない。
IP は secret の `SEARCH_CLICK_SALT` を混ぜたハッシュの先頭16桁（`visitor`）だけを残す。日をまたいでも同じ人を1人と数え（公開する「3人以上」の基準）、塩が無いと逆算できるので、secret が無ければ記録しない。押したページが公開中かは、集計の `.github/scripts/search-boost.py` がリポジトリのファイルで確かめる。

- 初期化（1回だけ）: `cd workers && npx wrangler d1 execute tk-st-magi2-db --remote --file=magi2/migrations/0002_search_clicks.sql`、`node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put SEARCH_CLICK_SALT --config magi2/wrangler.toml`（値を変えると、それより前の記録と同じ人を別人と数える）
- 出す順番: 上の初期化 → Worker のデプロイ → サイトの push。逆でも壊れない（テーブルが無ければ 503、Worker が古ければ 404 で、どちらも画面は無視する）。
- 集計は `.github/workflows/search-boost.yml`（毎日）。画面は `data/search-boost.json` を読むだけで、検索のたびに D1 を読まない。
- 止め方: `wrangler.toml` の `SEARCH_CLICK_ENABLED` を `"false"` にして出す（204 を返して何も書かない）。検索と並び順は、最後に集計した JSON のまま動く。

## ローカル検証のコマンド

```sh
node --test .github/scripts/test-magi2.mjs
python -B .github/scripts/test-site-search-index.py
python -B .github/scripts/magi-context.py --dry-run
python -B .github/scripts/ai_models.py check
python -B .github/scripts/preview-404-ai.py
```

回帰検証は外部APIを呼ばず、NodeとPython標準のSQLiteを使う。本番のAPI互換性は週次のモデルスモークテストで確認する。
404の画面確認は `http://localhost:4215/missing/`。プレビューだけでフラグを有効にし、AI・解析の外部通信を行わない。検索語 `mock-none`／`mock-limit`／`mock-error`／`mock-slow`／`mock-global`／`mock-update` で状態を模擬できる。
PWAの更新は `www/sw.js` のキャッシュを更新する。ネイティブアプリは変更した `www/` を同期して再ビルドする。

## ローカルとCloudflare評価環境

初期化と起動はworkers/で行う。新しいローカルDBにはschemaだけを流し、既存DBには必要なmigrationだけを適用する。

```sh
npx wrangler d1 execute tk-st-magi2-db --local --file magi2/schema.sql --config magi2/wrangler.toml
npx wrangler dev --local --port 8787 --config magi2/wrangler.toml
npx wrangler d1 execute dj-request-db --local --file dj-request/schema.sql --config dj-request/wrangler.toml
npx wrangler dev --local --port 8788 --local-upstream localhost:8788 --config dj-request/wrangler.toml
```

受付Workerの非追跡dj-request/.dev.varsにDJ_LOCAL_DEV="true"を設定し、/adminでイベントを開く。
別のターミナルでリポジトリのルートを静的配信し、ページはhttp://localhostで開く。
DJのapiとreq_apiはlocalhostページだけでループバックのオリジンを指定できる。詳細はルートの検証計画3節。

評価環境はwrangler.tomlのenv.eval（tk-st-magi2-eval、magi2-eval.tk.st/magi2*、DBはtk-st-magi2-eval-db）。専用DBを作ってそのIDを設定する。本番DBのIDを使わない。
先にDNSとCloudflare Accessを設定し、評価専用secretを--env evalへ設定する。本番のDB・通知先を使わず、deploy-worker.ymlの選択肢にも加えない。
Accessサービス認証とAPIキーを環境変数に設定してeval-site-search.mjsを使う。--delayは149秒成功と150秒打切りの通信確認で、AIの品質・速度とは分ける。
評価終了後はWorker名を固定して `npx wrangler delete tk-st-magi2-eval --config magi2/wrangler.toml --env eval`、次に評価DBだけを削除し、評価DNS・Access・専用トークンを片付ける。継続利用する場合は用途と次回の利用日・片付け予定日を記録する。

## Anthropicの運用（公開1）

BALTHASARと、ダークの統合・タイトル・予測・議題化にMessages APIを使う。モデルの正本は `config/ai-models.json`。人格カードとX素材は `.github/scripts/anthropic_api.py` を日刊と共用する。ページ選びはHaikuの実API評価で上限3件を超えたため、検証計画§0-9に従いLunaを維持する。採用しなかった応答と判断は[公開1準備](先行改修公開1準備.md)に記録する。
本人確認（2026-10-12）: 月額spend limitで管理せず、前払いの$5を使い切るとエラーになる運用。4.4利用者全員への案内・更新は公開条件から外し、本人の4.6への更新を確認済みとする。本人以外への連絡は行っていない。
本人の意向（2026-10-13）: 今回の全件品質比較は省略し、公開前の必須条件から外す。本人らしさ・事実関係の合格へ置き換えず、BALTHASARのeffortはlowを維持する。比較の選択・回答は本番のプロンプト・人格カード・学習用の正解に取り込まない。本人の考えと関心は更新されたサイト/X素材から作るカードに任せる。自動検証と公開後の動作確認は維持する。

- 統合は本文を表示する前だけ、HTTP失敗・拒否・空・30秒間本文なし等で、もう一方の会社に一度答え直してもらう。各試行の期限は60秒。表示を始めた後や利用者の停止では答え直さない。
- 補助の役割はHTTP失敗の場合だけ、元の期限の残りでLunaを一度呼ぶ（答え直し先は `DEFAULTS.models.aux_fallback`）。
- Anthropicへ送るsystemには `cache_control`（5分）を付ける。BALTHASARの2回目以降の呼び出しは入力が0.1倍になる。効いているかは応答の `usage.cache_read_input_tokens` で確かめる。人格は他社へ切り替えず、欠席として残りで進める。
- 残高切れ・キーの失効は、答え直しが成功しても会社とHTTP状態ごとにUTCの1日につき1通の通知を送る。Anthropicのspend limit/cap、credit/balance等の語がある400、`retry-after`がない課金上限の429も対象とする。通常のRPM/TPMの429は対象外。
- Geminiの呼び出し・匿名試行の記録・週次監視は撤去する。既存DBの過去の計測行は変更しない。Workerの `MAGI_GEMINI_API_KEY` はロールバック用に公開から2週間保持し、削除する前に本人へ知らせる。
- `deploy-worker.yml` のmagi2公開は、先にリポジトリの `ANTHROPIC_API_KEY` をWorkerの `MAGI_ANTHROPIC_API_KEY` へ同期する。未設定・同期失敗ならデプロイを止める。dry-runでは同期せず、バンドルだけ確認する。手動wrangler公開ではこの同期を先に行う。
- 実APIの事前確認は `magi-anthropic-probe.yml`。合成入力だけを送り、本文・キーを成果物に残さない。X画像URLの確認が未実施なら、完了したとは扱わない。

Anthropicのデータの扱いは [APIの保持期間](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) と [商用APIの学習への利用](https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training) を確認した（2026-10-13）。入出力は既定で学習には利用されず、通常30日以内に削除される。安全管理・法令等の例外を説明文にも残す。

- 票の補助AIは公開前の固定評価でBALTHASARの第1・2回の札30/30件が有効だったため撤去。札が読めない回は判定不能とし、前回の有効票があればコードで引き継ぐ。
