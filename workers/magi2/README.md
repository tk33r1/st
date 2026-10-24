# MAGI2 の変更と確認

人格・呼び出し設定は `personas.js`、モデル ID と表示名は `config/ai-models.json` が正本。
人格カードの生成と更新はルートの `AGENTS.md` を参照。

チャット・APIの進行制御は `src/index.js`、Web検索のストリーム解析と出典本文・アイコンの取得は `research.js` が受け持つ。討議用入力の組立てとPOST入口を整理した記録は [simplify確認（2026-10-25）](simplify確認20261025.md) を参照。

2026-10-17の残課題修正は[修正・限定評価・実時間観測](残課題修正と観測20261017.md)を参照。選択ページに添えるPDF/QRの操作手順は`personas.js`の`SITE_SEARCH.usage`。対象ツールの操作を変えたら同時に照合する。検算・経験の推測・人格間の発言参照の規則も同ファイルが正本。
人格の本文は120字の指示を維持し、指示を外した長い応答も `DEFAULTS.persona_response_max_chars`（4000字）で制限して討議の入力が膨らまないようにする。
Jevを使う環境には `MAGI_TYPESAFE_API_KEY` をWrangler secretで設定する。手元の `.dev.vars` は本番へ自動反映されない。未設定でも回答は続くが、分類はフォールバックとなる。

## 設計書・検証計画

トップページ・PWA・Androidと共通のMAGI仕様は、このディレクトリにまとめる。公開済みの文書は当時の記録として保持し、現在の仕様はコードと本READMEで確認する。

| 対象 | 設計 | 検証計画 |
| --- | --- | --- |
| 統合・分類・会話の言語 | [統合設計書](magi2統合設計書.md) | [検証計画](magi2検証計画.md) |
| 受信・モデル・更新通知 | [先行改修設計書](magi2先行改修設計書.md) | [先行改修検証計画](magi2先行改修検証計画.md) |
| 悪意判定・事実確認・聞き返し | [対話改修設計書](magi2対話改修設計書.md) | [対話改修検証計画](magi2対話改修検証計画.md) |
| 継続改善 | [継続改善設計書](magi2継続改善設計書.md) | [継続改善検証計画](magi2継続改善検証計画.md) |
| 読み上げ・WebSocket | [読み上げ設計書](magi2読み上げ設計書.md) | [読み上げ検証計画](magi2読み上げ検証計画.md) |
| 一時チャット・パーソナライズ | [設計書](magi2一時チャット・パーソナライズ設計書.md) | [検証計画](magi2一時チャット・パーソナライズ検証計画.md) |

Android固有の設計と公開評価は [`magi-app/`](../../magi-app/README.md)、404ページの設計は対象HTMLと同じルートの [`404-redesign.md`](../../404-redesign.md)・[`404-ai-search-design.md`](../../404-ai-search-design.md) に置く。

## 検証用ファイルの扱い

検証スクリプトはリポジトリのルートから実行し、生成物を `workers/.wrangler/` または `.github/scripts/.search-reading-env/work/` に保存する。スクリーンショットは再生成できるが、評価JSON・本人の採点・費用台帳は削除しない。

`preview-magi47-materials.py` は手動の `magi-anthropic-probe.yml` が使う。`summarize-magi47.mjs` と `verify-magi47-dj.mjs` は、その評価データの新旧比較とDJ回答のカタログ照合に使う手動ツールとして保持する。名前に旧版が含まれていても、版番号だけで削除しない。

## 代表経路の費用を制限した本番確認

2026-10-17に本人が追加$2の代表案を採用。共通台帳の過去の予約を維持し、累計総額$2.80、OpenAI・Anthropic各$1.20の範囲で実施する。全件評価の再開ではない。

`prepare-magi-representative.mjs`で合成入力・モデル・会社別上限を固定し、`eval-magi-representative-production.mjs --reserve-site` / `--reserve-native`で送信前に共通台帳へ予約する。その後だけ、固定したJSONを一時secret `MAGI_QA_PLAN`へ設定する。`qa-budget.js`は一致する合成入力だけに適用し、各要求を一度だけ受け付け、上流ごとの保守的な費用をD1へ原子的に加算する。通常入力・secret未設定時には適用しない。受付前に止めたときは、チャットも404の③も409（`stage: evaluation`、`code`は`qa_budget_*`）を返す。D1の失敗などガードの判定でないものは、404は`search_unavailable`、チャットは`evaluation_unavailable`の503（再試行可）で、内部のメッセージは応答に出さない。

接続待ちで計画が失効した実機分は、D1で未送信を確認した後だけ`native-plan.json`へ分けて期限を延長する。ケースID・日付・モデル・入力・費用枠を維持し、24時間以内の期限と元の実機ケースの完全一致を予約器で検査する。実機操作器`qa-magi-representative-android.mjs`は予約hash・本番設定済み記録・入力文の完全一致・画像枚数を確認し、観測したSendを1回だけ押す。[2026-10-17の実施結果](代表経路追加評価20261017.md)を参照。

入力・画像寸法・履歴件数・モデル・最大トークンを検査し、Web検索や予定外の要求は送信前に拒否する。D1の`rate_limit`に保存するのは`qa:<計画ID>:<ケースID>:<会社>`の予約値と拒否件数だけで、本文・画像・実IPは保存しない。失敗時も予約を取り消さず、同じケースを再送しない。確認後は対象計画の行を照合し、部分回答や拒否を合格にせず、全呼出しの終了後にsecretを削除する。請求額の取得・保証ではない。

## リアクションDBの移行

既存DBには、Workerをデプロイする前に次を1回適用する。新しいDBは `schema.sql` で作るため、この移行は不要。

```sh
cd workers
npx wrangler d1 execute tk-st-magi2-db --remote --file=magi2/migrations/0001_reaction_ownership.sql
npx wrangler deploy --config magi2/wrangler.toml --message "$(node ../.github/scripts/magi2-daily-check.mjs --deployment-message)"
```

登録時は `id` と `delete_token` を返し、取り消しには両方が必要。DBにはトークンのSHA-256だけを保存する。
既存行と旧アプリの履歴は削除トークンを持たないため、連番だけでは取り消せない。必要な旧行の削除は管理者がDBで行う。
同じIPからの同じ内容の重複登録は保存せず、元の登録者のトークンも返さない。
登録・取り消しを合わせ、IPごとに30回/分・480回/UTC日まで。

## 入力とストリーム

- 本文は1メッセージ1,000文字、過去の統合回答は4,000文字まで。人格の履歴も含めた本文合計は40,000文字まで。
- 4,000文字を超える事実回答も、トップ/PWAの表示・保存・引用は全文を保持する。次の送信に添えるfact回答の本文だけ先頭4,000文字以内へ収め、サロゲート対を途中で切らない。後半はその回のモデルの文脈に含まれない。以前に保存した長い回答にも同じ処理を使う（2026-10-15のA2レビュー修正）。Workerも`mode:"fact"`のassistant本文を受付前に同じ上限へ切り詰めるので、切り詰めない画面からの送信も400にしない（通常の履歴の上限は変えない）。
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

`GET /magi2/usage`は今日（UTC）の通常チャットのIPごとの回数を`{used, limit, day, resets_at, global_full}`で返す（`global_full`は全利用者の合計が上限に達した日にtrue）。数えずに読むだけで、許可したOriginかAPIキーが要り、`Cache-Control: no-store`。アプリのヘッダーの円グラフが起動時・送信の後・画面に戻ったとき（60秒以上空いたら）に読む。取得は6秒で打ち切り、取得中に呼ばれたら終わった後に読み直す。旧Worker（404など）では円グラフを隠し、通信の失敗では前の値を残す。

## 討議の回数（最大5回）

`classification_state:true`と`fact_mode:true`の画面では、research・siteは討議なしのlow回答、musicは曲の案内としてadaptive_debateに従い最大5回。印のない新契約のsite・musicは第2回で統合する。consultと旧契約は、その後も統合人格（本人）が判定して回数を決める。新契約で第1回に1人だけ答えた場合は第2回を省き、呼んでいない回の欠席通知は送らない。
値と判定のプロンプトは `personas.js` の `DEBATE`。両テーマとも`DEFAULTS.models.judge`（Haiku・medium）で判定と質問を1回のJSONで生成する。HTTP失敗・不正JSON・未完了時だけ`judge_fallback`（Luna・medium）へ1回切り替え、同じ20秒の期限を共有する。両社失敗なら現在の討議で統合する。

## A3の確認質問（5.0・2026-10-15公開）

`clarify:true`の通常チャットで、第2〜4回の後の判定が`ask_user`なら、1〜3問と各3選択肢の`clarify`を送り、統合・予測を作らず`done`で終える。`ask_personas`では選ばれた1〜3人格へだけ追加質問する。最大5回・討議90秒は維持。MAGI・DJ・404・印のない画面では利用者への確認を出さない。MAGIの採決はコードで集計する。

トップ/PWAは各問に固定の「その他（入力する）」を足し、1問のAI選択肢は即送信、複数問は選択と補足をまとめて送る。「その他」は100文字、合成後の送信は1,000文字まで。質問・選択肢・`intent`・`fresh`を端末の履歴へ保存し、最後の未回答の質問だけ操作を復元する。Workerは直前のassistantが`clarify`なら再確認を禁止し、回答を通常の悪意・intent・fresh分類から通す。この分類だけ、元の相談・確認の質問と選択肢・直前のintent/freshをJevへ足す。人格の討議・カード・DJの状況説明はJevへ送らない。

公開の結果と未確認範囲は[A3公開評価](A3公開評価.md)。APKはA4で更新する。

A3〜A5の追加修正は2026-10-16に5.2の保守更新として公開した。確認質問の失敗後の復元、404の下書き保持・上限・取り消し、更新履歴の後退防止などの結果は[A3〜A5修正公開評価](A3-A5修正公開評価.md)。

## A5の404会話（5.2・2026-10-16公開）

`/magi2/site-search?site_debate=1&site_chat=1`は`query`・`locale`・任意の`history`/`reply_language`を受け、既存のページ候補・commentへ`reply_language`と`closed`を追加する。履歴は最大6メッセージ（user/assistant交互の3往復）。user 200字、assistant 2,000字、assistantのpagesは最大3件の`{title,url}`（160/500字）。継続はreply_languageが必要。文字数はコードポイントで数える。本文は64KiB、既存の②と旧③は4KiB。

site_chatのない旧③は従来どおり。②は最初に分岐し、会話の項目・URLクエリを拒否する。初回は検索の回数、historyがある続きは通常チャットの回数を使う。Jevは言語・悪意のみで、AI回答やページ名は送らない。ページ選びと直接回答には直近の会話を渡し、過去のページは現行索引で照合する。AIに渡す候補の絞り込みは今回の語の点数を先に比べ、会話の文脈は同点の並びにだけ使う（話題を変えた続きで前の話題のページが枠を埋めないように）。検索語と回答からは、続きの履歴の検査で拒む制御文字・双方向制御文字を除いて返す。会話の保存は行わず、別の検索・空への確定・再読み込みで消す。同じ条件や下書き・IMEでは会話を壊さない。

公開の結果と未確認範囲は[A5公開評価](A5公開評価.md)、代表2相談の実モデル確認と修正は[A5品質確認](A5品質確認.md)。A5は404の変更なのでAPKは作らず、Androidの配布版は5.1を維持する。

## A4の更新履歴（5.1・2026-10-15公開）

正本は手で直す`data/magi-versions.json`。`GET /magi2/versions`は固定URLから取得し、10分キャッシュする。取得失敗・形式不正・同梱分より古い履歴は、デプロイ時に同梱した分へ戻す。CORSはmodelsと同じで、公開情報のため認可とAI呼出しはない。取得先・期限は`personas.js`の`VERSION_HISTORY`、取得は`versions.js`。形式・並び・上限の検査は`version-history.js`を日次の検査と共有する。

トップ/PWAはスプラッシュの版を押すと履歴パネルを開き、ⓘはサブタイトルの右へ移す。日英は画面の言語に合わせ、更新文を文字として描く。取得失敗でもチャットは続けられる。過去の分は本人が文面を採用して公開済み。結果と未確認範囲は[A4公開評価](A4公開評価.md)。日付を確定できない2.1以前だけ、版はearlier・日付はnullとして「それ以前」と表示する。

## A2の事実確認（4.9・2026-10-15公開）

**出典の読み取り（2026-10-24）**: 出典の HTML は 1MiB まで読む（`RESEARCH.verify.source_bytes`。天気予報のページは 600KB 前後あり、表が 256KB より後ろにあった）。
`<main>`・`<article>` の本文が400字未満で、ページ全体がその倍を超えるときは全体を読む（`section_min_chars`。tenki.jp は区画に知らせだけがあり、予報の表が外にある）。
取得には `RESEARCH.user_agent`（`tk.st-MAGI/1.0`）を名乗る（名乗りが無いと tenki.jp は 403）。

**推定所在地（2026-10-24）**: Web で調べるときは、Cloudflare が通信元の IP から推定した市・地域・国（`request.cf`。GPS ではない。精度は市や県の単位）を、検索の会社の `user_location`、検索の指示（場所の指定が無い質問にだけ使う）、照合の材料（`estimated_place`）に渡す。
照合の JSON の `place_used` が true のときだけ、確認日時の次の行に「推定した場所: …」を出す。WebSocket では開いたときの要求の `cf` を使う。値の正本は `RESEARCH.place_prompt`・`place_rules`・`place_label`。

**JavaScript で描く出典の描画（2026-10-24）**: 出典の HTML から取れた本文が400字未満なら、本文の最も少ない1件だけを Cloudflare Browser Run の `/markdown`（REST）で描画して本文を取り直す（`renderThinSource`・`RESEARCH.render`）。気象庁の台風・天気のページのように、本文を JavaScript で描くページのためのもの。
Browser Run は無料枠（全体で10秒に1回・1日10分）なので、1日100件（`render:global`）まで・15秒で打ち切り、429・失敗は描画しなかった扱いで照合を続ける。送るのは公開ページの URL だけ。
鍵は secret `BROWSER_RUN_API_TOKEN`（Cloudflare の API トークン。権限は Account の Browser Run - Edit だけ）、アカウントは `wrangler.toml` の `BROWSER_RUN_ACCOUNT_ID`。鍵が無ければ描画しない（止め方も鍵の削除でよい）。

問いと閾値は`INTENT_CLASSIFY.fact_questions`が正本。初回6問・継続5問、DJは初回2問・継続1問のまま。音楽理論・楽譜・コード・楽器の説明はresearch、曲推薦・選曲だけmusic。本人やサイトの事実はsite。旧契約の問いを維持する。

最新情報のresearchは両テーマともOpenAI ResponsesのWeb検索（2026-10-15本人採用）。Webの推論はmedium（2026-10-14本人採用）、Webなしの事実説明はlowで、通常のダーク回答はAnthropicを維持する。URLを持つ検索結果より前の前置きは送らず、本文前の失敗だけAnthropicの検索・ページ取得へ1回答え直す。両社失敗やUTC日ごとのWeb上限（IP20回・全体300回）では注記とWebなしlowへ進む（Webの指示を含まない通常の事実回答の入力で答える）。Webの回答はページ選びを待たずに始め、選んだページのリンクは回答の後に出す。カウンタは既存のdaily_limitsを使い、DB移行は不要。各試行は45秒、Anthropicの検索と取得はそれぞれ最大3回、pause_turnはassistantのcontentを保持して1回だけ続ける。停止・本文後の失敗では答え直さない。UTCの確認日時とは別に日本の現在日付と曜日をWorkerが計算して上流へ渡す。

Webの原案は表示せず、`research.js`のネイティブ引用から最大5ページの公開本文をWorkerが取得し、同じ会社のJSON呼出し1回（medium・最大4,096トークン）で照合する。取得は各8秒・256KiB・本文24,000文字まで、標準ポートのHTTP(S)だけで認証・IP表記・内部用ホストと不正な転送を拒否する。ページへキー・Cookie・会話本文は送らない。PDF・JS描画・未対応の文字コード・読取失敗・HTTPの失敗（403・404など）は未読として残して照合で未確認にし、打切りもモデルへ渡す。HTMLは`main`/`article`の区画をすべて読み、区画内の見出しを残す。照合にはカード・検索の指示・画像を送り直さず、照合の指示・言語・確認日時と、前の会話の文字・質問・原案・本文だけを送る。未確認の項目は引用が無くても受け付け、引用が1件も無い回答では`sources`を送らない。UTF8に加え、HTTPヘッダー又はHTML先頭の宣言に従いShift_JIS・EUC-JP・ISO-2022-JPを復号する。出典番号・実本文の区分番号・正常終了をコードで検査するが、意味の支持はモデルの判断なので品質監査を別に行う。検索・取得・照合を合わせ各社45秒、回数は一つのWeb要求として数える。

照合後の最終本文をまとめて`integrated`で送り、使った出典へ番号を振り直し、項目末尾のUTF16位置を`marks`へ記録する。未確認の項目はモデルの候補値を含む本文を表示せず、`RESEARCH.unverified_note`の固定文へ置き換える。Responsesの検索とページ閲覧は`max_tool_calls:3`で制限する。最大5出典の`sources`をdone前に1回送る。確認日時はWorkerがUTC時刻を本文へ付け（見出しは`RESEARCH.checked_label`、Webを使えないときの注記は`limited_note`。どちらも9言語）、引用位置にもその文字数を足す。トップ/PWAはfactのカードを出さず、リンクを文字ノードで描き、mode/sourcesを履歴とMarkdownへ残す。404③はページ選択と1回答え（low）。②の5scope・旧3scope・世代・時間・クリックは維持。

実装と検証状況は[A2実装評価](A2実装評価.md)。2026-10-15、保存済み評価・原典照合＋修正4件の実API確認＋ローカル回帰で検証を確定する進め方を本人が承認。修正後の全30件の新規評価は省略し、全件の意味の支持と3回制限を付けた新規検索の品質・時間は未確認として残す。同日の「本番公開して」でWorkerを先行デプロイ後、Web/PWA 4.9・DJ・404を公開した。公開作業中の有料API呼出しは0回。公開後の固定SSEによる表示/保存と未実施範囲は[A2公開評価](A2公開評価.md)。Androidの出荷版はまだ作成していない。

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
`classification_state: true` のトップページ・アプリでは、対話改修A1で初回にlanguage/malice/votable/intent/site_pagesの5問、継続では言語を省いた4問をJevへ1回で送る（2026-10-14にWorker公開。実測と公開確認は[対話改修評価](対話改修評価.md)）。
分類は最新本文全体（1,000文字まで）と直近2件までのユーザー本文、言語は最初のユーザー本文（500文字まで）を使う。画像・AI回答・状況説明は分類に送らない。
DJは `entry: dj-request` によりmusic/no/no固定で、初回は言語とmaliceの2問、以後はmaliceだけ。毎回の本文と直近2件のユーザー本文を使い、状況説明とAIの返答は渡さない。古い契約（classification_stateなし）は従来のリクエストごとの言語1問を使う。

- 問いごとに選択肢と有限の0〜1のconfidenceを検査し、language/intent/site_pagesは0.5、votableは0.7以上を採用する。
- 言語を引き継ぐ `reply_language` はversion・code・sourceを検査する。初回に失敗しても日本語の規則、固定した短いsample、UI言語で確定し、次のターンには再判定しない。
- 人格カード取得・分類は利用回数の確認と並行して始める。確認後に、対応画面へ `classification` を本流・タイトルより先に1回だけ送る。拒否・停止・切断時は分類も止める。
- 会話ごとの言語はブラウザ内の現在の会話と保存会話に残す。受信後に回答が失敗しても言語を消さず、新しい会話で初期化する。
- 分類結果・本文・ハッシュをD1へ保存しない。ログはプロファイル・問い・choice・confidence・時間・失敗だけ。
- 第1段階では採決を無効にし、`magi_candidate: false` を返した。第2公開で採決・演出・履歴を有効にし、実機・表示確認まで完了した（[評価記録](第2公開評価.md)）。

```sh
node .github/scripts/probe-jev-classify.mjs
```

本番と同じ問いで初回5問・継続4問を各20回、DJの言語＋maliceの2問・旧画面の言語1問も確認する。キーは環境変数か非追跡の `.dev.vars` から読み、本文やキーを出力しない。

## 対話改修A1（4.8）

maliceの調整確定値は0.55（2026-10-13、実Jev。2026-10-14に修正後56返答の本人確認を記録し、検証計画§3.1は合格。同日にWorker公開）。identity/extraction/extremeだけが短い返しに入り、none/uncertain・低確信・欠落・障害では通常経路を使う。討議・議題化・ページ選び・タイトル・予測より先に分岐する。短い返しはテーマの統合モデルを推論なしで呼び、本文前の失敗だけもう一方の会社で1回答え直す。両社失敗は会話の言語の固定文（`MALICE_REPLY.fallback`。日英と主要7言語、無い言語は英語）、本文を送った後の失敗と停止は答え直さない。言語がotherで本文由来のsampleしか無いときは、この返しだけUI言語を使って攻撃本文を渡さない。

classification → integrated → closed（reason: malice）→ done。closedは印なしの新分類契約にも送り、配布済み画面では未知イベントとして読み飛ばされる。対応画面はclose_on_maliceを送り、正常完了後にclosed: trueを履歴に残し、新しい会話まで入力を閉じる。DJは返しだけで入力を閉じず、その往復を `closed: true` で保存して人格の枠を出さず、次の相談で送る履歴から外す（攻撃の文が直近2件の分類や3人格の文脈に残らないように）。履歴のclosedをWorkerの受付拒否に使わず、毎回判定する。404・検索②はA1の対象外。

統合人格は一人称「私」、語尾「ぜ」を使わない（正本は `SYNTHESIZER.voice_rules`。通常の統合ではカードより後ろに別のsystemとして送り、system_promptには重ねて書かない）。短い返しは本人のカードの後に出力ルールを付け、会話を続ける誘いや後で話す約束を付け足さずに終える。

実測前に、検証計画§0.1に従って本人が入力の文面・期待値を確定する。確認済み調整用は `.github/scripts/fixtures/magi-dialogue-a1-tune.json`、別途確認済みの判定用は `magi-dialogue-a1-final.json`（同じディレクトリ）、測定は `.github/scripts/eval-magi-malice.mjs`。調整用で値を確定した後、判定用の分類単体は各回誤検知0件・検出27件。口調修正後、両テーマの実Worker各80件は無害50件の誤検知0件・対象30件の検出28件で、全件正常完了した。返答完了の中央値はライト1075ms、ダーク1194ms。返答の修正前後で分類の契約hashが不変で、問い・閾値を変えていない。2026-10-14、本人が「修正後の両テーマ56件を採用する」と承認し、確認用本文と測定元JSONのhash・テーマ別28件のIDを記録した。実測は[対話改修Jev評価](対話改修-jev-evaluation.md)、公開結果と未確認範囲は[対話改修評価](対話改修評価.md)。

```sh
node .github/scripts/eval-magi-malice.mjs --inspect
# 本人確認後、JSONのreviewed_by/reviewed_atに事実を記録してから調整用を測る
node .github/scripts/eval-magi-malice.mjs --run --input=.github/scripts/fixtures/magi-dialogue-a1-tune.json
# 別の判定用を用意し、確定した閾値・コードの調整記録と照合してから測る
node .github/scripts/eval-magi-malice.mjs --run --input=<判定用JSON> --freeze=<確定後の調整記録JSON>
# 外部AIなし。トップ・PWA・DJの会話終了・再生・保存・再開を確認
node .github/scripts/test-magi-stream-browser.mjs . --malice-only
# 旧画面の比較元を固定して確認（--inspectではブラウザ・実APIを起動しない）
node .github/scripts/eval-magi-a1-browser.mjs --legacy-ref=3b68b9e1 --inspect
# 新しいローカルWorkerとA1前の画面を比較する。実APIを使う
node .github/scripts/eval-magi-a1-browser.mjs --base=http://localhost:8793 --legacy-ref=3b68b9e1
# 新画面＋旧Workerの比較では旧画面を読み込まない
node .github/scripts/eval-magi-a1-browser.mjs --base=http://localhost:8794 --legacy-worker
# 手動プレビューの入力はmock-malice
python -B .github/scripts/preview-magi-mode.py
```

## 上流の残高切れの通知

1人格の失敗は欠席（`[NO RESPONSE]`）として黙って進むので、チャージを使い切っても画面からは気づきにくい。
各社の API が 401・402・403、または残高や枠の不足を示す 429 を返したら、Resend でメールを送る
（ただの回数制限の 429 は送らない）。同じ会社・同じ HTTP ステータスは UTC の1日に1通で、送った印は
`rate_limit` に `alert:<会社>:<ステータス>` の行として残す。送れなかったら印を消し、次の失敗でまた試す。

OpenAI ResponsesのHTTP200内の失敗イベントも、`insufficient_quota`・`credit_balance_exhausted`・`billing_hard_limit_reached`を通知する。判定へ渡すのはエラーのcode/typeだけで、回答・推論・エラーmessageは渡さない。通常の回数制限やサーバーエラーは通知せず、Webの本文前の答え直しは維持する（[A2修正公開評価](A2修正公開評価.md)）。

```sh
cd workers
npx wrangler secret put RESEND_API_KEY --config magi2/wrangler.toml   # dj-offer と同じキーでよい
npx wrangler secret put ALERT_TO       --config magi2/wrangler.toml   # カンマ区切りで複数可: a@example.com, b@example.com
npx wrangler secret put ALERT_FROM     --config magi2/wrangler.toml   # 例: MAGI <magi@tk.st>
```

どれかが無ければ、ログに `upstream_alert` を出すだけで会話は止めない。

全利用者の合計にも1日の上限（`DEFAULTS.global_daily_limit`、いまは300回）を掛けている。Origin は名乗れるので、
IP を替えながら大量に呼ばれても費用に天井を作るため。超えた最初の1回で同じ仕組みのメールを送る（`alert:global`）。

## 読み上げ（C1・準備中）

統合人格の回答を Fish Audio の無料版（`config/ai-models.json` の `fishaudio.tts`）と本人の声のモデルで読み上げる（[読み上げ設計書](magi2読み上げ設計書.md)、[実装前確認](読み上げ実装前確認.md)）。

- **署名**: `SPEECH_ENABLED` が `"true"` で secret の `MAGI_FISH_AUDIO_API_KEY`・`SPEECH_SIGN_KEY` がそろうと、チャットは `done` の直前に `speech` イベント `{ sig, lang }` を送る。
  `sig` は画面へ実際に送った `integrated` の差分をつないだ本文の `HMAC-SHA256(SPEECH_SIGN_KEY, "v1\n" + 本文)`。確認質問・悪意への短い返答・DJ の相談・エラー・停止には付けない。
- **入口** `POST /magi2/speech` `{ text, sig, part, lang? }`: 署名が合わなければ 403 `speech_unsigned`。区切りは `speech.js` の `speechParts`（40・80・160・180文字と伸ばし以後 180、全体 2,000文字・最大 14区切り）で毎回作り直し、`X-Speech-Parts` で数を返す。
  同じ区切りは Cache API（データセンターごと）から返し、Fish Audio を呼ばず回数にも数えない。数えるのは送った区切りだけで、`speech:<IP>`（30）・`speech:global`（300）／UTC 日。全体の上限ではメールを1日1通（`alert:speech-global`）。
  上流の 401・402・403 と残高・枠の不足を示す 429 は残高切れの通知（`alert:fishaudio:<状態>`）、声のモデルが無い 400（`Reference not found`）は `alert:fishaudio:voice`。429 は1秒後に1回だけ送り直す。有料のモデルへは切り替えない。
- `/magi2/models` の `features.speech` が上の3つがそろったときだけ true になり、画面はこれを見て 🔊 を出す。
- 値は `personas.js` の `SPEECH`。引数を変えたら `params_version` を上げる（キャッシュの鍵に入る）。
- **有効にする手順**（C1b。本人の試聴と `PRIVACY` の段落の了承の後）:

```sh
cd workers
npx wrangler secret put MAGI_FISH_AUDIO_API_KEY --config magi2/wrangler.toml
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put SPEECH_SIGN_KEY --config magi2/wrangler.toml
# wrangler.toml の SPEECH_ENABLED を "true" にして出す
```

- **止め方**: `SPEECH_ENABLED` を `"false"` にして出す。全画面から 🔊 が消え、`/magi2/speech` は 404。`SPEECH_SIGN_KEY` を入れ替えると、それまでの回答は読めなくなる。
- **出典のアイコン**: Web で確かめた回答（A2）の出典の本文を読むときに、同じページの `<link rel="icon">`（SVG を除く。無ければ `/favicon.ico`）、
  控えの apple-touch-icon（宣言した大きさの小さいもの）、最後に `/favicon.ico` の順で最大4つをホストごとに試し、
  PNG・ICO・JPEG・GIF・WebP を中身の先頭バイトで確かめて `sources.items[].icon` に data: URL で入れる（`SOURCE_ICON`）。画面へ渡すのは 8KiB 以下の1枚
  （回答と一緒に端末の履歴へ入るため。画面は data: URL を 11,000 文字まで受け付ける）。.ico は上限以内のファイルでも、収まる画像のうち 32px に近いもの
  （同じ大きさなら色数の多い方）だけを取り出して1枚の .ico（PNG ならそのまま PNG）にする。複数の大きさをまとめた .ico（tenki.jp・ウェザーニュース・新聞各社は 4〜44KB）が
  多いため（2026-10-24）。目次が崩れて取り出せない .ico も、上限以内ならそのまま渡す。取るのは 1ファイル 64KiB までで、超えた .ico は先頭だけから取り出す。
  上限は実物30サイトで決めた（4KiB で26件、8KiB で28件に付く。40KiB でも増えるのは1件で、1枚の平均が 3KB から 10KB 余りに増える）。照合と並行して取り、照合が終わった時点で取れていた分だけ付ける。
  URL の検査・認証を付けないこと・名乗り（`RESEARCH.user_agent`）は出典の本文と同じ。

## WebSocket の入口（C2）

会社のプロキシは SSE の応答を最後まで溜めて一度に流すが、WebSocket は素通しにする（[読み上げ設計書](magi2読み上げ設計書.md) 6.7 の測定）。
そこでトップページと PWA は回答を WebSocket で受け、開けないときだけ SSE を使う。`dj/request/` と Android のアプリ（ネイティブ受信）は SSE のまま。

- **入口** `GET /magi2/ws`（`Upgrade: websocket`）: `WS_ENABLED` が `"true"` でなければ 404、許可した Origin でなければ 403（`x-api-key` は使わない）、`Upgrade` が無ければ 426。
- 開いた後の最初のメッセージ `{ "type": "chat", "v": 1, "body": <POST /magi2/chat と同じ JSON> }` を1回だけ受け、今の `handleChat` に渡す（入力の検査・上限・回数は POST と同じ）。
  10秒来ない（`STREAM.ws_first_message_ms`）・解釈できない・2回目の chat は `error` を送って 1008 で閉じる。
- 各イベントは `{ "event": <名前>, "data": <SSE と同じ> }`。10秒ごとに `{ "event": "ping" }`。`done`・`error` の後は 1000 で閉じる。入力の誤り・回数の超過は今の封筒に `http_status` を足して `error` で送り、1008 で閉じる。
- 画面の `{ "type": "stop" }`・切断・エラーは、どれも SSE の切断と同じく続きの呼び出しを止める。
- SSE と WebSocket は同じ本体（`handleChat` の `run`）を使い、送り方（sink）だけが違う。SSE の出力は変えていない。
- 画面（`openAgentChat`。トップページと `app.js` の `AGENT_TRANSPORT` の区画）は、開く前の失敗（5秒で開かない・開く前の error・close）だけ SSE で同じ要求を1回送り、その画面を閉じるまで SSE を使う（`sessionStorage` の `magi_transport`）。
  開いて要求を送った後に切れたら送り直さない（二重の課金を避ける）。
- **止め方**: `wrangler.toml` の `WS_ENABLED` を `"false"` にして出す。画面は開く前の失敗として SSE に切り替わるので、画面を出し直さなくてよい。
- 確認: `test-magi2.mjs`（入口・受け渡し）、`node .github/scripts/test-magi-ws-browser.mjs`（実ブラウザ。WebSocket の Worker は模擬）。ほかの画面のテストは SSE の経路を見るため、`magi_transport` を `sse` にして始める。

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
公開HTMLから自動生成した `data/site-search.json` を取得・検証した後、OpenAIに最大3件のIDを選ばせ、照合したリンク候補を討議なしの事実回答（low）へ渡す。リンクは照合済みIDから、commentはその本文から作る。通常は選択1回・回答1回の計2回。
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

- 404検索は既存の `countUp` と `rate_limit` を利用し、UTC日ごとに `search:<IP>`（10回）→ `search:global`（100回）の順に数える。A5の会話の続きの質問だけは、通常チャットの回数で数える。表・移行の追加はない。
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

## 継続改善の準備と手動公開

手順の正本は[継続改善の実行手順](../../.github/magi2-daily/README.md)。本人の指示で段0を保留して準備を先行している。現在の毎時workflowは検証・報告だけを行い、自動マージ・公開はしない。レビュー経路も未設定で、模擬結果は実レビューの完了に数えない。

手動のActions公開は`deploy-worker-core.yml`で対象SHAを固定し、Anthropicキーの同期後に`--message <SHA>`を付ける。手元から出す場合も、リポジトリのルートで次を実行して得た値を`wrangler deploy --message`に渡す。

```sh
node .github/scripts/magi2-daily-check.mjs --deployment-message
```

本番依存に未コミットの変更があれば`-dirty`が付く。出した内容とgitの履歴が違うことを表すため、後に自動公開を接続したときは停止対象になる。コミットして出し直すまで印を外さない。手元からも従来どおりAnthropicキーの同期を先に行い、secretの値はコミットや公開ログに出さない。

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

- 統合は本文を表示する前だけ、HTTP失敗・拒否・空・30秒間本文なし等で、もう一方の会社に一度答え直してもらう。各試行の期限は60秒。表示を始めた後や利用者の停止では答え直さない（本文を流さない404の③は、本文の途中の失敗でも答え直す。全体の150秒は変えない）。
- 補助の役割はHTTPの失敗と、応答の前の失敗（鍵の未設定・通信の失敗）の場合だけ、元の期限の残りでLunaを一度呼ぶ。200の応答（拒否・途中切れ・本文の解析の失敗）と利用者の停止では呼ばない（答え直し先は `DEFAULTS.models.aux_fallback`）。
- 3人格の固定プロンプトは共通の枠（この呼び出しで頼むのはその面の意見だけで、書いた文章は画面のカードに出て他の面と本人が読む）と、人格ごとの気質・話し方でできている。書き方（長さ・票の形）は `role.chat`・`role.magi`。仕組みだけを書いていた旧版では、Haikuが4人分の台本を書いた（2026-10-13。固定31回で第1回10回→0回、3人格とも0回。`eval-magi-persona.mjs`、probeの `persona` 評価。整理は[人格プロンプト整理](人格プロンプト整理.md)）。頭に付く自分の名前の見出しは `stripOwnHeader` で画面と討議に渡す前に落とす。
- Anthropicへ送るsystemには `cache_control`（5分）を付ける。BALTHASARの2回目以降の呼び出しは入力が0.1倍になる。効いているかは応答の `usage.cache_read_input_tokens` で確かめる。人格は他社へ切り替えず、欠席として残りで進める。
- 残高切れ・キーの失効は、答え直しが成功しても会社とHTTP状態ごとにUTCの1日につき1通の通知を送る。Anthropicのspend limit/cap、credit/balance等の語がある400、`retry-after`がない課金上限の429も対象とする。通常のRPM/TPMの429は対象外。
- Geminiの呼び出し・匿名試行の記録・週次監視は撤去する。既存DBの過去の計測行は変更しない。Workerの `MAGI_GEMINI_API_KEY` はロールバック用に公開から2週間保持し、削除する前に本人へ知らせる。
- `deploy-worker.yml` のmagi2公開は、先にリポジトリの `ANTHROPIC_API_KEY` をWorkerの `MAGI_ANTHROPIC_API_KEY` へ同期する。未設定・同期失敗ならデプロイを止める。dry-runでは同期せず、バンドルだけ確認する。手動wrangler公開ではこの同期を先に行う。
- 実APIの事前確認は `magi-anthropic-probe.yml`。合成入力だけを送り、本文・キーを成果物に残さない。X画像URLの確認が未実施なら、完了したとは扱わない。

Anthropicのデータの扱いは [APIの保持期間](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) と [商用APIの学習への利用](https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training) を確認した（2026-10-13）。入出力は既定で学習には利用されず、通常30日以内に削除される。安全管理・法令等の例外を説明文にも残す。

- 票の補助AIは公開前の固定評価でBALTHASARの第1・2回の札30/30件が有効だったため撤去。札が読めない回は判定不能とし、前回の有効票があればコードで引き継ぐ。

## バグ報告

Webとアプリのメニュー「バグを報告」は `POST /magi2/bug-report` へ入力本文と明示的に選んだ添付画像だけを送る。
本文は空欄不可・Unicodeコードポイントで2000文字まで。会話履歴や会話内の画像は自動では添えず、報告の本文と添付画像はDBやログに保存しない。
既存のOrigin/APIキー認可を使い、D1の `rate_limit` でIPごと5通・全体100通/日（UTC）に制限する。
Resendで固定宛先 `magi@tk.st` へ送り、`RESEND_API_KEY` と既存の `ALERT_FROM` を使う。`ALERT_TO` は使わない。
いずれかのsecretやDBが無い・メール送信が失敗した場合は503を返し、画面は入力を保持する。
添付はPNG・JPEG・WebPを3枚まで、1枚5MiB・合計10MiB。JSON受信は14MiBまでに制限し、MIME・Base64・ファイル先頭の署名を検査する。SVG・外部URLは受け付けず、添付名はWorkerが `bug-report-<番号>.<拡張子>` に固定する。
画像は`images:[{type,content}]`（contentはBase64）で受け、[Resendの添付API](https://resend.com/docs/dashboard/emails/attachments)へメモリ内で渡す。
新画面は報告ごとにUUIDの`report_id`を作り、本文・画像を変えない再試行では再利用する。[Idempotency-Key](https://resend.com/docs/api-reference/emails/send-email#headers)で24時間内のメール重複を抑える。再試行も既存の回数制限には含める。
応答の`images`は受け付けた添付数。添付を送った新画面は、この数が一致しなければ成功として本文や画像を消さない。旧画面の本文だけの送信（images/report_id省略）は引き続き受け付ける。
公開はWorkerが先。画像対応前のWorkerは新画面の画像を処理しないため、画面だけを先に出さない。
メールの本番配送と受信確認はローカル検証に含めない。

アプリ管理の「位置情報サービス」をオフにすると、次のチャットから `location_enabled:false` を送る。
SSE/WebSocket共通で端末・IPの所在地を検索・照合に渡さない。Android 6.82以降はGPSに対応する（詳細は末尾の「Android GPS」）。
既存画面の互換性のため、フラグ省略時は従来どおり推定所在地を使う。

## Android GPS（6.82）

AndroidのGPS対応APKは、OSの許可を得た送信時の `device_location`（緯度・経度・精度m・測位からの経過時間ms、任意で国・市・地域・時刻帯）を本文に添える。
`devicePlace` が数値・範囲・鮮度（5分以内、未来は10秒まで）を確かめ、小数4桁に丸める。精度の目安が10kmを超える場合や不正値・古い値は捨て、従来のIP推定へ戻す。
有効な端末位置はIPより優先する。市・地域・国を取得できなかった場合に、IP由来の別の地域を混ぜない。
検索会社の `user_location` は対応している国・市・地域だけとし、座標は検索用の構造化データと照合の `device_coordinates` にだけ渡す。
通常の討議・分類・タイトル生成には座標を添えず、D1や履歴にも座標専用の項目を作らない。利用したときの回答の前提は地名と精度の目安で示し、表示名に座標を混ぜない。
座標は利用者の自己申告であり、認証や地域制限には使わない。Workerを先に公開し、新APKを配布する。

鮮度はAndroidの単調増加時計から求めた`age_ms`で検査する。GPSの衛星時刻・端末の時計・Workerの時計の差では判定しない。Workerは旧`timestamp`も互換のため受け付ける。

## 一時チャット・パーソナライズ（6.9）

設計と検証は[設計書](magi2一時チャット・パーソナライズ設計書.md)・[検証計画](magi2一時チャット・パーソナライズ検証計画.md)、実装の確認範囲は[記録](一時チャット・パーソナライズ実装記録.md)を参照。`privacy.js`が要求の契約と設定の検査を担う。`TEMPORARY_CHAT_ENABLED=false`・`PERSONALIZATION_ENABLED=false`で個別停止でき、未設定時は有効。一時音声はv2署名でモード・言語・本文を固定し、Cache APIを使用しない。D1のスキーマ変更は不要。

一時チャットの明示パーソナライズは、`privacy_contract:1`・`conversation_mode:"temporary"`に`temporary_personalization:true`と`personalization`を付ける。従来の一時要求では設定を破棄し、新画面は機能通知`temporary_personalization:true`を確認してから送る。`session.personalization_applied`で適用の一致も検査する。設定を適用しても会話・評価・音声の非保存経路は変わらず、選択自体は画面メモリだけに保持する。
