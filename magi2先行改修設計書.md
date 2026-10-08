# magi2 先行改修設計書 — 回答の受信・モデル変更・アプリの更新通知とアイコン

設計中（2026-10-09）。実装と公開が済んだら、冒頭を「実装済み（日付）。正本はコード」に書き換え、以後は直さない。
検証の筋書き・評価用入力・合格条件は [magi2先行改修検証計画](magi2先行改修検証計画.md) を正本とする（本書には書かない）。
後に続く改修: [A 対話改修](magi2対話改修設計書.md)、[B ネイティブ機能](magi-app/ネイティブ機能設計書.md)、最後に Fish Audio の読み上げ（別に設計する）。
本書の 2章（版の上げ方）と 4.4（答え直しの規則）は、A・B でもそのまま使う正本。

## 1. 要件

### 1.1 目的と変化

| 公開 | 目的 | 利用者から見た変化 |
| --- | --- | --- |
| 0. 回答の受信 | 通信を最後まで溜めてから渡す環境（会社のネットワークなど）でも、最後まで回答を見られるようにする | 一度に届く環境でもタイムアウトせず、「途中経過がまとめて届きます」と出たあと、人格の意見→討議→統合の答えの順に少しずつ表示される。ふつうの環境は変わらない |
| 1. モデル変更 | BALTHASAR-2 とダークの統合人格を Claude Haiku 5.5 に変え、Anthropic も残高切れの通知と新モデルの検知に乗せる | BALTHASAR の調子が変わり、テーマによらず同じ調子で答える。ダークと曲リクエストの相談では統合の答えを Haiku が書く。モデル名・説明・送り先の表示が変わり、Gemini の無料枠の注意書きが消える。アプリ（PWA を含む）は端末の設定に合ったテーマで始まる |
| 2. アプリの先行版 | 以後の改修が配布済みのアプリに届くようにし、アイコンをトップページの紋章に合わせる | 新しい版があると「新しいバージョン（X.Y）があります」と出る。アイコンが新しい紋章になり、テーマアイコンの端末では単色の紋章になる |

### 1.2 背景

- **0**: 会社の PC では、Comet でも Chrome でも回答が最後に一度に届いた（本人の確認、2026-10-08）。会社のプロキシが通信を溜めている。
  画面は一定時間何も届かないと打ち切り、Worker は処理の合間に何も送らないので、全部が最後に届く環境では届く前に諦めてしまう。
- **1**: BALTHASAR-2 は Gemini 3.5 Flash-Lite の無料枠で動いていて、入力が Google の学習に使われる。Claude Haiku 5.5 は 2026-10-07 に公開された軽量モデル。
- **2**: 今の APK には更新を知らせる仕組みが無い。アイコン（[magi-app/resources/icon.svg](magi-app/resources/icon.svg)、2026-05 作成）は正六角形3つと番号 1・2・3 のままで、
  トップページの紋章（角を切った形、番号は上 2・左 3・右 1。[index.html](index.html) の `agentHintHTML`）と食い違う。
  `magi-app/android/` は `.gitignore` で丸ごと外していて、Android のプロジェクトは本人の PC にだけある。

### 1.3 対象範囲

- Worker: `workers/magi2`（SSE の送り方、Anthropic の呼び出し、統合のモデルの切り替えと答え直し、残高切れの判定、`/magi2/models`）。
- 画面: トップページ（[index.html](index.html)）、MAGI アプリ（[magi-app/www/](magi-app/www/)）、曲リクエストの「AIに相談」（[dj/request/index.html](dj/request/index.html)）、404 ページの AI 検索の説明。
- 週次のモデル監視: [ai_models.py](.github/scripts/ai_models.py)、[ai-model-watch.yml](.github/workflows/ai-model-watch.yml)、[config/ai-models.json](config/ai-models.json)。
- Android アプリ: Git の管理、アイコン、テーマアイコン、テーマの追従、更新通知、APK の版。

### 1.4 やらないこと

- 通信方式の WebSocket への切り替え（0 の効果を見てから A で検討する）。
- 討議を閉じても続ける・通知する、その他のネイティブ機能、Capacitor の版上げ（B）。
- MELCHIOR-1・CASPER-3 と、判定・タイトル・次の質問の予測・議題化・票の読み取りのモデル変更。
- 404 の AI 検索の統合のモデル変更（テーマを送らないので Luna のまま）。
- トップページのテーマの決め方の変更（いつもライトで始まる）。
- Play ストアでの配布、iOS のネイティブ版。

### 1.5 決定事項

本人との相談で決めたこと（2026-10-07〜09）。理由と細部は各節に書く。

| 項目 | 決定 |
| --- | --- |
| 配布と画面の更新 | GitHub Releases のまま。画面は APK に同梱（ライブ更新・`server.url` は使わない）。アプリが新しい版を確かめて知らせる（5.1） |
| アイコン | トップページの紋章に合わせて描き直し、テーマアイコンに対応する（5.2・5.3） |
| 回答の受信 | 期限の延長・Worker からの合図・まとめて届いたときの再生（3章） |
| モデル | BALTHASAR-2 は Haiku 5.5。統合はライト Luna・ダーク Haiku（`dj/request/` は常にダークなので Haiku。曲名の正確さは検証で確かめる）（4.1） |
| 答え直し | 統合人格が失敗したら、もう一方のモデルで答え直す（Haiku → Luna、Luna → Haiku）。3人格は答え直さない（4.4） |
| BALTHASAR の揺らぎ | 代わりの仕掛けは入れず、「テーマによらず安定して答える人格」とする（4.3） |
| アプリのテーマ | 起動時は端末の設定、読めなければ時刻で決める（4.12） |
| Anthropic の通知 | 残高切れのメールと週次の検知・動作確認に乗せる（4.7・4.8）。残高切れの語は公式の文書の語で作る |
| Android のプロジェクト | `magi-app/android/` を Git で管理する（5.0） |

## 2. 公開の単位と版

| 公開 | 出すもの | MAGI の版 | APK |
| --- | --- | --- | --- |
| 0 | Worker（合図）→ 3画面（期限・再生） | 4.5 | 作らない（4.4 のまま） |
| 1 | Worker（モデル）→ 画面（表示名・説明文・テーマ）・週次監視 | 4.6 | 作らない |
| 2 | APK（更新通知・アイコン・テーマの追従。0・1 の画面を同梱） | 4.7 | 4.7 |

**版の上げ方（A・B でも同じ）**:
- 公開ごとに版を1つ上げ、トップページの `ver X.Y`・`magi-app/www/app.js`・`magi-app/package.json` を同じ値にする（`test-magi2.mjs` が検査する）。
- `build.gradle` の `versionName`・`versionCode`（4.7 → 47）も、5.0 で `android/` を Git の管理に入れた後は、APK を作らない公開でも毎回揃え、`test-magi2.mjs` で検査する（AGENTS.md の約束）。それまでは APK を作るときに揃える。
- A4 でバージョン履歴を入れた後は、版を上げるたびに `data/magi-versions.json` に1件足す（[A 対話改修設計書](magi2対話改修設計書.md) 7.2）。
- GitHub Releases のタグ（`vX.Y`）は APK を作った版だけ（v4.4 の次は v4.7）。Web だけの公開の間、配布済みのアプリには変更が届かない。
- 4.7 だけは今の利用者に手で入れ直してもらう（4.4 には更新通知が無い）。

## 3. 公開 0: 回答の受信

### 3.1 方針

画面が待つ時間を Worker の最長の処理時間に合わせ、Worker は処理の合間も合図を送る。合図が届かない（溜める環境だ）と分かったら、まとめて届いた中身を順を追って再生する。
溜めるプロキシでも本当に少しずつ届くようにすることは、こちらだけでは保証できない（一定量ごとに渡す方式なら 3.2 で届く）。

### 3.2 Worker: 合図と見出し

`handleChat` の SSE（[workers/magi2/src/index.js](workers/magi2/src/index.js) の `new ReadableStream`）に足す。値は `personas.js` に置く（例 `STREAM: { padding_bytes: 2048, ping_ms: 10000 }`）。

- **最初の合図**: ストリームを開いたらすぐ、2KiB ほどの SSE のコメント（`:` で始まる行）を1つ送る。一定量まで溜める中継機器に最初の区切りを越えさせる。
- **定期の合図**: 10秒ごとに `: ping` を送る。`close()` とストリームの `cancel()` で必ず止める。中継機器の無通信の打ち切りを避ける効果もある。
- **見出し**: `Cache-Control: no-cache, no-transform` と `X-Accel-Buffering: no`。
- コメントは SSE の仕様で読み飛ばされ、今の3画面の `parseSSE` も無通信の見張りを延ばすだけなので、配布済みのアプリ（4.4）もそのまま読める。

### 3.3 画面: 待つ時間

今はトップページとアプリが「接続 30秒・無通信 70秒」、`dj/request/` が「送信から無通信 70秒」。3画面とも次の値にし、値は各画面の定数1か所に置く。

| 見張り | 値 | 意味 |
| --- | --- | --- |
| 全体の期限 | 300秒 | 送ってから最後まで。Worker の最長（約250秒。内訳は `personas.js` の時間の設定の横にコメントで書き、設定を変えたら見直す）に余裕を足した値 |
| 合図の確認 | 15秒 | この間に何も届かなければ「溜める環境」とみなす（3.4） |
| 無通信 | 70秒（今のまま） | 一度でも届いた後の無通信。合図が10秒ごとに来るので、回線が止まったときだけ効く |

- 15秒で何も届かないときは、考え中の表示の下に注記を出す。ja「この環境では途中経過がまとめて届くようです。最後まで待って表示します（最大5分）」／en「Progress seems to arrive all at once on this network. Waiting for the full reply (up to 5 minutes).」
- 停止ボタン・期限切れの文言は今のまま。接続自体の失敗（fetch の例外）は今どおりすぐにエラーにする。
- 404 の AI 検索は別の期限（Worker 150秒・画面 165秒）で、本書では変えない。4.4 の答え直しで 150秒を超えたら、今どおり検索の失敗として返す（A2 で討議をやめると収まる）。

### 3.4 画面: まとめて届いたときの再生

- **判定**: 送ってから最初の受信までに 15秒以上かかったら「まとめて届いた」とみなす（ふつうの環境では、最初の合図が数秒以内に届く）。
- **再生**: イベントを列に入れ、間を置いて順に流す。再生全体が 20秒を超えそうなら間隔を縮めて 20秒に収める。

| イベント | 間隔 |
| --- | --- |
| `classification`・`title` | すぐ |
| `motion`・`persona`・`ask`・`judge`・`verdict` | 1件ごとに 0.7秒 |
| `integrated` | 本文を約12文字ずつに分け、30ミリ秒ごと |
| `pages`・`suggest`・`integrated_end`・`done`・`error`（A で足すイベントも） | 列が空になってから |

- MAGI モードの審議パネル（`createMagiView`）は、間隔を置いて渡せば今の演出がそのまま出る。
- **停止ボタン**: 再生中に押したら、捨てずに残りを一度に表示して終える（title を「すぐに全部表示」にする）。
- **計時**: `thinkingSeconds` は今どおり最初の回答本文を表示した時点で止める。
- 実装は3画面の `parseSSE`（別々の複製）に列と再生の役割を足す。受け取る側の処理（`handlers`）は変えない。

## 4. 公開 1: モデル変更

### 4.1 割り当て

| 用途 | 今 | 変更後 |
| --- | --- | --- |
| MELCHIOR-1 | DeepSeek V4.1 Flash | 変更なし |
| BALTHASAR-2 | Gemini 3.5 Flash-Lite（推論 minimal） | **Claude Haiku 5.5（推論なし）** |
| CASPER-3 | GPT-6 Luna | 変更なし |
| 統合（ライト・テーマなし・404 検索） | GPT-6 Luna（推論 medium） | 変更なし。失敗したら Haiku（4.4） |
| 統合（ダーク。`dj/request/` を含む） | GPT-6 Luna（推論 medium） | **Claude Haiku 5.5（adaptive thinking・effort medium）**。失敗したら Luna（4.4） |
| 判定・タイトル・予測・議題化・票の読み取り | GPT-6 Luna | 変更なし |

3人格は会社を分ける方針（答えの癖と間違え方をばらけさせる）を保つ: DeepSeek・Anthropic・OpenAI。

### 4.2 Anthropic の呼び出し

- **正本**: [config/ai-models.json](config/ai-models.json) に `"anthropic": { "haiku": { "id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5" } }`。モデルIDはここにだけ書く（`ai_models.py check` が検出する）。
- **呼び出し先**: `personas.js` の `PROVIDERS` に `anthropic: { endpoint: 'https://api.anthropic.com/v1/messages', key: 'MAGI_ANTHROPIC_API_KEY' }`。
  見出しは `x-api-key` と `anthropic-version: 2023-06-01`（今の `callModel` は全社 `Authorization: Bearer` なので、会社で分ける）。
- **形式**: Anthropic の Messages API を、ほかの会社と同じく `fetch` で呼ぶ（OpenAI 互換の窓口は推論・effort・拒否の扱いが対応しないので使わない。SDK は Worker に依存を足さないため使わない）。
  変換は `requestBody` と応答の読み取りに閉じ、呼び出し側は会社を意識しない。
  - `system`: 先頭からの `role: 'system'` を空行でつないで上の階層の `system` に入れる。
  - `messages`: user と assistant だけ。同じ役が続いたらつなぎ、先頭が assistant なら落とす。
  - 画像: `image_url` の data URL を `{ type: 'image', source: { type: 'base64', media_type, data } }` に変える（受け付ける形式は今の `DATA_IMAGE_RE` のまま）。
  - 応答: `type: 'text'` のブロックだけをつなぐ。`thinking` のブロックは読み捨て、次の呼び出しに送り返さない（上流へ送るのは role と本文だけ、という今の約束）。
  - 終わり方: `end_turn` → 成功、`max_tokens` → 今の `length`、`refusal` → 今の `content_filter`（再試行しない）。
- **Haiku 5.5 の制約**: `temperature`・`top_p`・`top_k` は既定値以外が 400 になるので送らない。推論は `thinking: { type: 'disabled' }`（effort は high 以下）か adaptive＋effort で決める。
- **評価用の付け足し**: 評価用の Worker（`src/eval.js` の `evalObserve`）でストリームに足している `stream_options` は Anthropic が受け付けないので、OpenAI 互換の会社にだけ足す。使用量の読み取りも Anthropic の形（`message_start`・`message_delta` の `usage`）に対応させる。
- `magi-search-config.mjs`（週次の動作確認）は `function requestBody(` から `async function callModel(` までを切り出して評価するので、Anthropic への変換はこの範囲の中に書く。

### 4.3 BALTHASAR-2

- 設定: `{ ...modelConfig('anthropic', 'haiku'), thinking: 'disabled', effort: 'low', max_tokens: 1024 }`（名前は実装で揃える）。effort は low で始め、検証の結果で medium と選ぶ。
- 失敗は今どおり [NO RESPONSE] にして、残りの人格で続ける。
- 揺らぎ: `PERSONA_TEMPERATURE` は Anthropic には渡さない（4.2 の制約）。テーマによらず同じ調子の人格とし、説明もそう書く（4.5）。
- `stripCharCount`（文字数の後書きの除去）は残す（害は無く、ほかのモデルが書くこともある）。

### 4.4 統合のモデルと答え直し

- `DEFAULTS.models` に `synthesizer_dark`（Haiku・adaptive・effort medium・`max_tokens` 8192・ストリーミング）を足す。`synthesizer`（Luna・推論 medium）はライトとテーマなし（404 検索）。
- 選び方: `theme === 'dark'` なら `synthesizer_dark`、それ以外は `synthesizer`。MAGI モードの決議の説明も同じ。
- 読み取り: `readSynthesis` に Anthropic のストリーム（`message_start`・`content_block_*`・`message_delta`・`message_stop`・`ping`・`error`）の分岐を足し、`text_delta` だけを `integrated` として送る。
  成功は `message_stop` が届き `stop_reason` が `end_turn` のときだけ（今の「EOF だけでは成功にしない」と同じ）。

**答え直しの規則（統合人格の呼び出しすべての正本。A で足す呼び出しも従う）**:
- テーマのモデルが次のどれかで、まだ本文を1文字も画面へ送っていないうちに終わったら、もう一方のモデル（Haiku ↔ Luna）で同じ入力から1回だけ呼び直す。
  - HTTP のエラー（残高切れ・過負荷・キーの失効を含む）
  - 30秒以内に本文が始まらない（どちらも推論ありなので、考える時間を見込んだ値）
  - 拒否（Haiku の `refusal`・Luna の `content_filter`）、ストリームの `error`、本文が空
- 呼び直しにも統合と同じ 60秒の期限を掛ける。もう一方も失敗したら今の統合の失敗と同じエラー。
- 本文を送り始めた後の失敗は呼び直さない（画面の文字を取り消せない）。利用者の停止・切断のときも呼ばない。最初のモデルの期限は、呼び出しを始めた時点から 60秒。
- 元の会社の失敗が残高切れ・キーの失効なら、呼び直しが成功しても通知を出す（4.7）。ログに `fallback <用途> <元の会社> <理由>` を残す。画面からは区別がつかない。
- **3人格は答え直さない**（今どおり [NO RESPONSE]）。ほかの会社で代わりに答えると2人格が同じ会社になり、会社を分けた意味が薄れるため。

### 4.5 説明文（`PERSONA_GUIDE`）

`personas.js` の `PERSONA_GUIDE` の `theme` を直す（Worker が返すので、アプリの更新なしで全画面に出る）。モデル名は直書きせず、`config/ai-models.json` の表示名から組み立てる。

| 人格 | 変更後（ja。英語も同じ趣旨） |
| --- | --- |
| BALTHASAR-2 | ライト・ダークとも同じ調子で答える。3人の中で、テーマに揺らがない人格。 |
| Shinya Takeda | 今の文に「ライトは GPT-6 Luna、ダークは Claude Haiku 5.5 が答える。片方が答えられないときは、もう片方が答え直す。」を足す |

### 4.6 `/magi2/models` と画面のモデル名

- `synthesizer` は今の形（ライトのモデル）のまま返し、`themes: { light: {…}, dark: {…} }` を足す。配布済みのアプリ（4.4）は `synthesizer` だけを読み、説明文（4.5）でダークを知る。
- 新しい画面は、`themes` があれば統合の LLM 欄に「OpenAI · GPT-6 Luna（ライト）／ Anthropic · Claude Haiku 5.5（ダーク）」と出す。
- 画面の `PROVIDER_LABEL` に `anthropic: 'Anthropic'` を足す（配布済みのアプリでは `anthropic · Claude Haiku 5.5` と出るが、2 の APK で直る）。

### 4.7 残高切れ・キーの失効の通知

今の判定 `isBillingFailure`（[workers/magi2/site-search.js](workers/magi2/site-search.js)）は 401・402・403 と、残高不足を示す本文の 429 を拾う。Anthropic の形に合わせて広げる。

| 状態 | Anthropic の応答（公式の errors） | 今の判定 |
| --- | --- | --- |
| キーの失効・不正 | 401 `authentication_error` | 拾える |
| 支払い情報の問題 | 402 `billing_error` | 拾える |
| 権限 | 403 `permission_error` | 拾える |
| 組織・ワークスペースの利用上限（spend limit） | **400** `invalid_request_error` | **拾えない** |
| 利用段階の月の上限（spend cap） | 429 `rate_limit_error`（`retry-after` なし） | 本文の語による |

- 400 と 429 は、本文の `error.message` に残高・上限の語（credit・balance・billing・spend・usage limit など。公式の文書の語で作り、テストの入力に残す）があるときだけ拾う。
  拾い損ねても、週次の動作確認（4.8）が失敗して Issue になる。
- `PROVIDER_ROLES` に `anthropic`（BALTHASAR-2・ダークの統合）を足し、`openai` の説明にライトの統合を書く。メールの本文には、統合は答え直しで続くが残高切れは早めに直すことを書く。

### 4.8 週次の新モデルの検知と動作確認

[ai_models.py](.github/scripts/ai_models.py) の `PROVIDERS` に `anthropic` を足す。

- **検知**: `GET https://api.anthropic.com/v1/models`。チャネル `haiku` は `claude-haiku-(\d+)-(\d+)` で版を取り、新しい Haiku を候補にする。表示名は API の `display_name`。
  候補は動作確認に通ったものだけを正本に書いて PR にする（今の仕組み）。
- **動作確認**: `DEFAULTS` の値で、BALTHASAR（推論なし・画像なし／あり）とダークの統合（adaptive・ストリーミング、`message_stop` と `end_turn` まで）をなぞる。
  本文は `magi-search-config.mjs` が `requestBody` から作る（4.2）。`config.discussion` に `synthesizer_dark` を足し、[test-magi-smoke.py](.github/scripts/test-magi-smoke.py) に Anthropic の本文の検査を足す。
- **Secrets**: リポジトリ Secret `ANTHROPIC_API_KEY`（登録済み）を `ai-model-watch.yml` の smoke と discover に渡す。

### 4.9 Gemini を外す

Gemini は BALTHASAR-2 でしか使っていないので、1 の公開と同じコミットで外す。

- `personas.js` の `PROVIDERS.google` と BALTHASAR の設定、`requestBody` の google の分岐、`config/ai-models.json` の `google`、`ai_models.py` の google、
  Gemini の利用回数の記録（`recordGoogleUsage`）と `test-magi2.mjs` のそのテスト。D1 に残った `usage:google:*` の行は害が無いので消さない。
- Worker の `MAGI_GEMINI_API_KEY` とリポジトリの `GEMINI_API_KEY` は、戻せるよう公開から2週間ほど残す（消すのは本人）。
- `workers/games` の「Gemini 形式」はゲームの旧クライアントとの互換の話なので触らない。

### 4.10 説明文と文書の更新（公開 0〜2 の全体）

| 場所 | 直すこと | 公開 |
| --- | --- | --- |
| 3画面の「System & Privacy」、トップページと `dj/request/` の FAQ（見える文と構造化データ） | 送り先を「OpenAI・DeepSeek・Anthropic」に。Gemini の無料枠の注意書きを消す。Anthropic のデータの扱いは公式の規約で確かめてから書く | 1 |
| [404.html](404.html) の AI 検索の説明（`ai-info-text`）とプライバシーポリシーへのリンク | 404 も3人格の討議を使うので、Google Gemini を Anthropic に替える | 1 |
| トップページ・`app.js` の画像の送り先のコメント | 同上 | 1 |
| アプリの「System & Privacy」 | 1日1回 GitHub に新しい版を問い合わせること（届くのは IP アドレスなどの通常の通信情報で、会話は送らない） | 2 |
| [AGENTS.md](AGENTS.md) | magi2 の secret（`MAGI_GEMINI_API_KEY` → `MAGI_ANTHROPIC_API_KEY`）、人格の会社の割り当て、Gemini の注記、「入力は3社すべてに送られる」、`ai-models.yml`／`ai-model-watch.yml` の会社、`magi-app/` の `android/` の扱い | 1・2 |
| [.github/AI_MODELS.md](.github/AI_MODELS.md) | Anthropic の追加と Google の削除、スモークテストの表 | 1 |
| [workers/magi2/README.md](workers/magi2/README.md) | secret、モデル、SSE の合図 | 0・1 |
| [magi-app/README.md](magi-app/README.md) | 更新通知、アイコンとテーマアイコンの作り方、`android/` を Git で管理すること、リリースの手順（タグ `vX.Y`） | 2 |

### 4.11 費用と回数の制限

- 費用: BALTHASAR の1回は入力 3〜4千・出力 200 トークンほど、ダークの統合は入力 1万・出力 1〜3千トークンほど。1回の会話で 0.01 ドル未満、全体の1日の上限（300回）でも 3 ドル未満。
  Anthropic の Console で組織の月の利用上限（spend limit）を設定する。
- 回数の制限: Anthropic は入金の額に応じた利用段階（tier）ごとに、1分あたりのリクエスト数・入力トークン数の上限がある。作ったばかりの組織は低く、同時に使われると 429 になりうる
  （429 は残高切れではないので通知は出ないが、BALTHASAR は [NO RESPONSE]、統合は答え直しで続く）。公開前に Console の Limits を確かめ、評価で 429 が出たら入金して段階を上げる。

### 4.12 アプリの起動時のテーマ

テーマで統合のモデルが変わるので、アプリ（`magi-app/www/`。PWA と Android）の起動時のテーマを端末に合わせる。

- 今: 切り替えボタン（`btn-theme`）で選んだテーマを localStorage（`magi_theme`）に覚えて次も使う。覚えていなければダーク。
- 変更後:
  1. 起動時は覚えたテーマを使わない。`matchMedia('(prefers-color-scheme: dark)')` が真ならダーク、`(prefers-color-scheme: light)` が真ならライト。
  2. どちらも真でない（端末の設定が読めない）ときは端末の時計で決める: 6:00〜17:59 はライト、それ以外はダーク。
  3. 起動後はボタンで切り替えられる。切り替えは保存しない。
  4. 起動後に端末の設定が変わったら、ボタンで切り替えていなければ追従する。
- 最初の描画の前に決める（`<html data-theme="dark">` の固定をやめ、描画前の小さなスクリプトで決める）。古い `magi_theme` は起動時に消す。
- Android の WebView に端末の設定を伝えるには APK の変更が要る（5.4）。それまでの APK 4.4 は今の動きのまま。

## 5. 公開 2: アプリの先行版

### 5.0 Android のプロジェクトを Git で管理する

公開 2 と B は `android/` を書き換えるので、変更を履歴とレビューに残し、PC が壊れても失わないよう、最初に Git の管理に入れる。

- `magi-app/.gitignore` から `android/` を外し、代わりに次を外す: `android/build/`・`android/app/build/`・`android/.gradle/`・`android/local.properties`（手元の SDK のパス）・
  `android/keystore.properties`・`*.jks`・`android/app/src/main/assets/public/`（`npx cap sync` が `www/` から写す複製）・`android/app/src/main/assets/capacitor.config.json`・
  `android/capacitor-cordova-android-plugins/` の生成物・`android/release-input/`（手元のリリースの作業用）。`ios/` は今どおり外す。
- 最初のコミットは手を加える前の状態をそのまま入れる。公開リポジトリなので、鍵・パスワード・手元の絶対パスが入っていないことを確かめてから入れる（計画§1.3）。

### 5.1 更新通知

- **確かめる先**: GitHub の公開 API `GET https://api.github.com/repos/tk33r1/st/releases/latest`。リリースを作れば自動で最新になり、手で直すファイルが要らない。
  `tag_name` が `v<数字>.<数字>` のときだけ使う。tk.st にファイルを置く案は、アプリ（`https://localhost`）から読むのに CORS の見出しが要り、手で直す必要もあるので採らない。
- **いつ**: アプリ（`Capacitor.isNativePlatform()`）を開いたとき、前回から 24時間以上たっていれば1回。Web・PWA では確かめない。5秒で諦め、失敗しても何も出さない。
- **比べる版**: `app.js` の版の表記を定数にし（スプラッシュの `ver X.Y` もこれを使う）、`tag_name` の数字と比べる（数字として比べる。4.10 は 4.9 より新しい）。
- **表示**: スプラッシュとチャットの上部に1行の帯。ja「新しいバージョン（4.8）があります」［ダウンロード］［×］／en「Version 4.8 is available」[Download] [×]。
  ［ダウンロード］は配布入口 `https://tk.st/magi-app/android/` を、既存のページ案内のリンクと同じ開き方（`target="_blank"`）で開く。［×］はその版では二度と出さない（localStorage に版を覚える）。

### 5.2 アイコン

- [icon.svg](magi-app/resources/icon.svg) をトップページの紋章（`agentHintHTML` の SVG）の形に描き直す: 角を切った3つの枠、番号は上 2・左 3・右 1、枠をつなぐ3本の線。
  色はダークのテーマ（地 `#0c0c0c`、線と番号 `#4ade80`、枠の塗り `#4ade8026`）。線の流れる演出は入れない。
- Android: `npm run icons`（`@capacitor/assets`）でアイコンとスプラッシュを作り直す。
- PWA: `www/icon-192.png`・`icon-512.png`・`icon-maskable-512.png` を手で作り直し（手順は README）、`sw.js` のキャッシュの版を上げる。
  追加済みの PWA は、Android の Chrome ではしばらくして変わり、iPhone では追加し直すまで古いまま。

### 5.3 テーマアイコン（Android 13 以降）

- 単色版 `magi-app/resources/icon-monochrome.svg`（枠の線・つなぐ線・番号だけ。アダプティブアイコンの安全域に収める）を VectorDrawable（`res/drawable/ic_launcher_monochrome.xml`）にし、
  `mipmap-anydpi-v26/ic_launcher.xml` と `ic_launcher_round.xml` に `<monochrome android:drawable="@drawable/ic_launcher_monochrome" />` を足す。
- `npm run icons` が `<monochrome>` を消すことがあるので、`test-magi2.mjs` で両方の XML にあることを検査し、README の手順にも書く。

### 5.4 端末のテーマへの追従

- `res/values/styles.xml` の `AppTheme` を DayNight 系の親にし、WebView の `prefers-color-scheme` が端末の設定に従うようにする（4.12 の前提）。スプラッシュの色は今の暗い地のまま。

### 5.5 既存の利用者への案内

- GitHub Releases の 4.7 の本文に「この版から、新しい版をアプリ内で知らせます」と書く。4.4 と同じ署名なので、上書きで入り、履歴も残る。

## 6. 実装計画

### 6.1 順番

| 段 | 作業 | 公開 |
| --- | --- | --- |
| 0-1 | Worker の合図と見出し（3.2） | Worker |
| 0-2 | 3画面の期限・注記（3.3）、まとめて届いたときの再生（3.4） | 画面（4.5） |
| 1-1 | 正本・呼び出し・応答の読み取り（4.2） | — |
| 1-2 | BALTHASAR（4.3）、統合と答え直し（4.4）、説明（4.5・4.6）、通知（4.7）、アプリのテーマ（4.12） | — |
| 1-3 | 週次の監視（4.8）、Gemini の撤去（4.9）、説明文と文書（4.10） | — |
| 1-4 | 本人: Console で利用上限を設定し、Limits を記録する（secret とリポジトリ Secret は登録済み） | — |
| 1-5 | Worker → 画面（4.6）→ `ai-model-watch.yml` を手動で1回 | 公開 |
| 2-0 | `android/` を Git の管理に入れる（5.0）。手を加える前の状態で1コミット | — |
| 2-1 | 更新通知（5.1）、版の定数化 | — |
| 2-2 | アイコン・テーマアイコン（5.2・5.3）、テーマの追従（5.4） | — |
| 2-3 | 版を 4.7 に揃えて push → APK を作って署名 → GitHub Releases に `v4.7` → 本人が実機で確かめる | 公開 |

- 各段で `node --test .github/scripts/test-magi2.mjs`、`node --check`（Worker と画面）、`python .github/scripts/test-magi-smoke.py`、`python .github/scripts/ai_models.py check` を通す。
- Worker を出す前に `git pull` して最新の人格カードを取り込む（AGENTS.md の約束）。
- デプロイは Worker が先（0 の合図は配布済みの画面も読み飛ばし、1 の `themes` と `PROVIDER_LABEL` はどちらが先でも表示が崩れない）。APK は 0・1 の画面が公開済みの `main` から作る。

### 6.2 戻し方

| 公開 | 戻し方 |
| --- | --- |
| 0 | 画面の commit を revert して push。Worker の合図は残しても害がない |
| 1 | 該当の commit を revert して Worker を再デプロイ（Gemini の secret を2週間残すのはこのため） |
| 2 | 前の版の APK は GitHub Releases に残る。更新通知の誤作動は、Releases の Latest を前の版に戻せば止まる |
