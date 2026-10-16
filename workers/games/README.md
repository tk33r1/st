# ゲーム共通API

ランキングとAIの入口。`/api/gpt`・`/api/deepseek`は`{text}`、旧`/api/gemini`は`candidates[0].content.parts[0].text`を返す。

## Haiku移行（2026-10-17、公開準備）

代表7場面の内容・形式・画面を確認し、`GAME_AI_PROVIDER`を`anthropic`へ変更した。キーは`GAME_ANTHROPIC_API_KEY`。クライアントからは選べない。未設定の旧環境では従来のOpenAI経路を維持する。
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
