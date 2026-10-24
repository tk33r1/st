# ゲーム共通API

ランキングとAIの入口。`/api/gpt`・`/api/deepseek`は`{text}`、旧`/api/gemini`は`candidates[0].content.parts[0].text`を返す。

## Haiku移行（2026-10-17、公開済み）

代表7場面の内容・形式・画面を確認し、`GAME_AI_PROVIDER`を`anthropic`へ変更した。キーは`GAME_ANTHROPIC_API_KEY`。クライアントからは選べない。未設定の旧環境では従来のOpenAI経路を維持する。

公開後、稼働バージョンを確認して合成のREADY 1件を実上流へ送り、HTTP200・正常本文・CORSを確認済み。追加予約$0.000637、再試行なし。全入力の品質評価とは分ける。[追加確認](../magi2/公開後追加確認20261017.md)を参照。
Messages API・推論なし・sampling指定なし。入力20件・各4000文字、出力800トークンまでを維持し、30秒で通信と本文の受信を打ち切る。
モデルIDは`config/ai-models.json`。欠落キーは503、上流失敗・拒否・空文は従来のエラー形で返す。別会社への自動再送はしない。

採用後のActionsはRepository Secret `ANTHROPIC_API_KEY`をこのWorkerの`GAME_ANTHROPIC_API_KEY`へ同期する。手動反映は`workers/`から`npx wrangler secret put GAME_ANTHROPIC_API_KEY --config games/wrangler.toml`。
歌舞伎クラフトの接続表示と説明もClaude Haiku 5.5へ合わせた。

ローカル確認は以下。外部AI・本番DBへは送らない。

```powershell
node --test .github/scripts/test-auxiliary-ai.mjs
python .github/scripts/test-auxiliary-smoke.py
node .github/scripts/test-games-haiku-browser.mjs
```

7ゲームのブラウザ確認は操作と模擬回答の描画を検査する。実モデルの回答品質の合格とは別。
実APIの初回計画と上限は[有料確認案](Haiku移行有料確認案.md)。`eval-games-haiku.mjs`は既定で無通信、`--run`も共有予算台帳の指定なしでは拒否する。追加の[比較](Haiku移行追加評価案.md)で最初の2件を修正し、Kabukiの矛盾と字数超過も修正して再確認した。[評価結果](Haiku移行評価.md)のとおり、単一7場面の内容・形式と画面を確認済み。全入力の品質保証ではない。今回の公開状況は[保守公開記録](../magi2/対話改修保守公開20261017.md)を参照。

## AIの利用上限

`/api/gpt`・`/api/deepseek`・`/api/gemini` は同じD1の枠を使う。既定値はIPごと30回/分・500回/UTC日、全体2,000回/UTC日。
日本時間の午前9時に日次枠が切り替わる。各上限と停止は `wrangler.toml` の `GAME_AI_*` で設定する。
Originは認証に使わず、Cloudflareが付ける `CF-Connecting-IP` を基に枠を共有する。IPが取れない要求は全員で同じ枠を使う。
IPを直接保存せず日ごとに変わるhashを使い、期限切れの行は翌日の初回利用時に削除する。

上限ではHTTP429と `Retry-After` を返す。JSONの応答形は従来どおり。DB・回数表・設定に問題があればHTTP503で止め、上流は呼ばない。
上流が失敗しても消費した枠は戻さない。本文は実バイト数で256KiBまで、モデルへの入力件数と文字数・出力トークン上限も維持する。
同じIPの利用者は枠を共有する。複数のIPからの濫用も全体上限で費用を限定するが、利用者認証を追加する仕組みではない。

公開は先に `migrations/0001_ai_rate_limits.sql` を既存の `st-games-ranking-db` へ適用し、その後Workerを出す。
移行SQLは冪等で、既存のランキングを変更しない。`deploy-worker.yml` の games 公開はこの順で行う。
GitHubの `CLOUDFLARE_API_TOKEN` には `Account > D1 > Edit` も必要。

```powershell
cd workers
npx wrangler d1 execute st-games-ranking-db --remote --config games/wrangler.toml --file games/migrations/0001_ai_rate_limits.sql
npx wrangler deploy --config games/wrangler.toml --message <commit>
```

無課金の検証:

```powershell
node --test .github/scripts/test-game-ai-limits.mjs .github/scripts/test-auxiliary-ai.mjs
```
