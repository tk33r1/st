# MAGI2 の変更と確認

人格・呼び出し設定は `personas.js`、モデル ID と表示名は `config/ai-models.json` が正本。
人格カードの生成と更新はルートの `AGENTS.md` を参照。

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
- 画面は `done` を受け取った回答だけ保存し、接続30秒・開始後の無通信70秒で入力を戻す。

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

## 404のAI検索とチャットのサイト案内

`POST /magi2/site-search` は `{ query, locale: 'ja' | 'en' }`（200文字・本文4KiBまで）を受け取る。
3つの公開一覧がそろった後、OpenAIに最大3件のIDと短いひとことを選ばせ、照合したIDからリンクを作る。
URLやタイトルをAIに生成させない。失敗は503で、該当なしの正常応答と分ける。応答は `no-store`。

- 404検索は既存の `countUp` と `rate_limit` を利用し、UTC日ごとに `search:<IP>`（10回）→ `search:global`（300回）の順に数える。表・移行の追加はない。
- 入力・認可・停止フラグ・一覧取得の失敗では数えない。AI開始後の失敗・0件・キャンセルは数える。全体上限で断った場合のIP回数は戻さない。
- `site_pages: true` の通常チャットは、最新本文の先頭500文字だけでページを選び、統合に添えた同じ候補を `pages` イベントで返す。通常チャットの上限内で行い、`search:` は使わない。DB未設定時は案内を省く。
- 討議と並列に開始し、統合前には最大2秒だけ待つ。失敗・遅延では検索だけを省く。停止・切断・全員欠席では検索も中止する。
- 両画面は回答の `done` 後だけリンクを表示する。リンクはその場だけで、履歴や次回の要求には含めない。
- 一覧の有効期間は10分、古い一覧は24時間まで使用して裏で更新する。3一覧をそろえて差し替え、失敗後は1分あける。
- 検索語・ひとこと・上流本文はDB／ログ／Resendに残さない。検索用の運用通知は会社・HTTPコード・用途のみ。通知抑制は既存の `alert:<会社>:<HTTP>`、検索の全体上限は `alert:site-search-global` を使う。

公開フラグは初期状態でオフ。Workerの `wrangler.toml` の `SITE_SEARCH_ENABLED = "true"`、次に404の `AI_SEARCH_ENABLED = true` で有効化する。
停止はWorkerを先に `false` にする。通常チャットは続く。公開前に本番スモークテスト、設計書の20件の品質評価・費用見積もり、GTM設定を確認する。
ネイティブアプリは `npm run sync` と再ビルド後、実機でリンクが開くことを確認する。

## ローカル検証のコマンド

```sh
node --test .github/scripts/test-magi2.mjs
python -B .github/scripts/magi-context.py --dry-run
python -B .github/scripts/ai_models.py check
python -B .github/scripts/preview-404-ai.py
```

回帰検証は外部APIを呼ばず、NodeとPython標準のSQLiteを使う。本番のAPI互換性は週次のモデルスモークテストで確認する。
404の画面確認は `http://localhost:4215/missing/`。プレビューだけでフラグを有効にし、AI・解析の外部通信を行わない。検索語 `mock-none`／`mock-limit`／`mock-error`／`mock-daily`／`mock-slow` で状態を模擬できる。
PWAの更新は `www/sw.js` のキャッシュを更新する。ネイティブアプリは変更した `www/` を同期して再ビルドする。
