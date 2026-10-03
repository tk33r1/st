# AIモデルの更新管理

AI APIで使うモデルID・画面の表示名の正本は `config/ai-models.json`（プロバイダー → 用途チャネル → モデル設定）。
各設定はAPIに送るモデルID `id` と、画面用の名称 `display_name` を必ず持つ。
3社とも画面は `display_name` を使い、APIには `id` を送る。
実運用で直接モデルを選ぶプロバイダーは OpenAI・DeepSeek・Google（Gemini）の3社と、magi2 の言語の判定に使う
TypeSafe AI（Jev。magi2の言語判定と日刊ニトリのSNS採否に使う、文章を生成しない判定専用のモデル）で、旧MAGIの `magi.tk.st` は
外部バックエンドへの中継だけなので、この仕組みからは背後のモデルを確認・変更できない。
Jev はモデル一覧の API が無く、`jev-latest` は版を追う固定のエイリアスなので、更新の監視はせずスモークテストだけを行う（`PROVIDERS` の `watch: False`）。

## 仕組み

- Pythonの生成処理は `ai_model_registry.py` から正本を読む。`OPENAI_MODEL` /
  `DEEPSEEK_MODEL` はローカルで別モデルを試す場合だけの上書き手段で、GitHub Actionsの
  実運用workflowでは設定しない。日刊生成は正本を読めなくてもルールベースで号を出す。
- Cloudflare Worker（`workers/magi2`・`workers/games`・`workers/dj-request`）は正本のJSONを `import` する。
  wrangler がデプロイ時にバンドルへ取り込むので、正本を変えたら再デプロイで反映される。
- 正本にはモデルIDと表示名だけを置く。モデル一覧・公式のモデル詳細・Chat CompletionsのURL、APIキーの環境変数、
  版番号のパターン、スモークテストの中身といったプロバイダー固有の知識は `ai_models.py` の
  `PROVIDERS` にまとめてある。
- `ai-models.yml` は `config/`・`.github/`・`workers/` を触るpushとPRで、正本の形式と、
  管理対象コード（`.github/`・`workers/`・`magi-app/www/`）へのモデルIDの直書きがないことを
  検査する。YAMLのクォートなしの値も拾う。過去の日刊号や技術記事は生成・執筆時点の履歴なので対象外。

## 週次の監視（`ai-model-watch.yml`）

1. **現在のモデルのスモークテスト**。DeepSeekの `flash` チャネルはIDが固定のエイリアスで、
   中身はDeepSeek側で黙って差し替わるため、候補の有無にかかわらず毎週試す。
2. **更新候補の検知**。各社の `/models` APIを見て、OpenAIは同じLuna系列のより新しい世代番号
   （`6` と `6.0` は同じ版として扱う）を、Googleは同じFlash-Lite系列のより新しい世代番号を探す。現在のモデルが一覧から消えていても後継は探す。
   候補はその場でスモークテストにかけ、**合格したものだけ**を正本に書く。
   OpenAI・Googleは限定した系列の公式表記（`GPT-<版> Luna`・`Gemini <版> Flash-Lite`）に合わせて
   `display_name` も同時に更新する。
   DeepSeekは公式の「Models & Pricing」のモデルID列と「MODEL VERSION」行を対応させ、
   使用中のエイリアスの実モデル名を取得する。表示名が変わった場合もスモークテストに通ったものだけを
   正本の `display_name` に書く。取得失敗・表の形式変更・対応が曖昧な場合は前回の表示名を保持し、Issueで知らせる。
   確認日時だけでは正本を更新しないので、版が同じなら毎週PRは増えない。
3. **レビュー用PR**。正本が変わっていればPRを作る（ブランチ `automation/ai-model-update`）。
   ほかの要確認事項（停止予定、DeepSeekの一覧取得失敗など）があってもPRは止めない。
   PRに人のコミットがある場合はブランチを上書きせず、レポートをコメントするだけにする。
4. **Issue**。スモークテストの失敗、現在のモデルが一覧にない、停止予定日がある、候補が不合格、
   PRの作成失敗のいずれかがあれば、Issueを作成または追記する。

自動マージとWorkerの自動デプロイはしない。PRをマージするとGitHub Actionsの生成処理は更新される。
MAGI本体・ゲーム共通API・DJ ブースの曲の背景カードは `workers/magi2`・`workers/games`・`workers/dj-request` を
手動デプロイして本番へ反映する。
表示名だけの変更は `workers/magi2` の再デプロイでトップページと配布済みのMAGIアプリに反映される。
`/magi2/models` の `model` は3社共通で画面用の表示名、`model_id` は実際にAPIへ指定するIDを返す。
PR本文にも同じ手順を出す。

### スモークテストの中身

実運用の呼び出し方を最小の形でなぞる。呼び出し方を変えたら `ai_models.py` の `smoke_*` も合わせる。

| プロバイダー | 試すこと | なぞっている利用箇所 |
| --- | --- | --- |
| OpenAI | 推論 medium（temperature なし）・JSON出力 | 日刊生成（一次プロバイダー） |
| OpenAI | 非推論・temperature 0.2・JSON出力 | MAGIの人格カード、ゲームAPI |
| OpenAI | 非推論・temperature 1.3・top_p・画像入力（data URL） | magi2 の Strategist（揺らぎの最大温度、画像付きの質問）。同じ呼び方の magi2 のタイトル要約と次の質問の予測もここで代表させる |
| OpenAI | 推論 medium・ストリーミング | magi2 の統合（上位モデルでは組織認証を求められることがある） |
| OpenAI | Chat Completions・推論なし・temperature 0.4・strictなJSONスキーマ（nullableな日刊検索）、300／120トークン | 404のAI検索・MAGIチャットのサイト案内。本番の `SITE_SEARCH` を読み、両スキーマと `daily` のnull／オブジェクトを試す |
| OpenAI | 推論 low（temperature なし）・strictなJSONスキーマ（enum と配列） | magi2 の討議の判定。本番の `DEBATE` を読む |
| OpenAI | Responses API・Web 検索の強制（`tool_choice: required`）・推論 high・strict な JSON スキーマ | DJ ブースの曲の背景カード（`workers/dj-request`）。検索が実行されたことまで確かめる |
| DeepSeek | temperature 0.2・JSON出力 | 日刊生成（OpenAI が失敗したときのフォールバック） |
| DeepSeek | 推論なし（`thinking` disabled）・temperature 1.3・top_p・画像入力 | magi2 の Enthusiast |
| Google | 推論 minimal（Gemini 3 系は切れない）・temperature 1.3・top_p・画像入力 | magi2 の Humanist |
| TypeSafe | System One API の choice 質問。本番の `LANGUAGE_DETECT` の指示と選択肢で、英字の混ざった日本語・日本語の名前を含む英語・前の発言を引き継ぐ「OK」の3通りが正しく判定されるか | magi2 の言語の判定 |
| TypeSafe | System One APIのnoul質問。本番の `nitori_social_filter.py` の採否基準で、テレビ台・通常の贈り物を採用し、PR・株を除外できるか | 日刊ニトリのX・TikTok内容判定 |

OpenAIのモデル一覧は `OPENAI_API_KEY`、DeepSeekは `DEEPSEEK_API_KEY`、Googleは `GEMINI_API_KEY`、TypeSafe は `TYPESAFE_API_KEY` を使う。
`TYPESAFE_API_KEY` は Worker の `MAGI_TYPESAFE_API_KEY` と同じキーでよい。
Actionsの日刊生成・TikTok取得・週次スモークテストでも、TypeSafeが401・402・403、または残高・枠不足の429を
返したら `typesafe_alert.py` がResendでメール通知する（通常の回数制限の429・通信障害・5xxは対象外）。
Repository Secretsに `RESEND_API_KEY`・`ALERT_FROM`・`ALERT_TO` が必要で、magi2と同じ値でよい。
`ALERT_TO` はカンマ区切りで複数可。宛先を公開リポジトリに書かず、WorkerのsecretもActionsには自動で引き継がれない。
同じPython実行中の同じHTTPステータスは1通にまとめ、送信失敗時は次のAPI失敗で再試行する。
キー・記事・投稿・上流の応答本文は通知に含めない。通知未設定・送信失敗でも従来の判定失敗時の処理を続ける。
OpenAIとDeepSeekは既存のRepository Secretをそのまま使う。`GEMINI_API_KEY` はmagi2の Humanist 用に足した
Repository Secretで、Worker の `MAGI_GEMINI_API_KEY` と同じキーでよい（未設定だと監視がIssueで知らせる）。
レビュー用PRを自動作成するには、GitHubのリポジトリ設定で Actions にPull Requestの作成を
許可しておく。許可されていない場合も、workflowは失敗内容をIssueで通知する。
ボットが作ったPRでは `ai-models.yml` が走らない（GITHUB_TOKEN の push は workflow を起動しない）が、
`update` が書き込み後に同じ検査を実行している。

## 手元での操作

```bash
# 正本の形式と直書きの検査（APIキー不要）
python .github/scripts/ai_models.py check

# モデル一覧・公式のモデル詳細から新しい版や表示名を探し、スモークテストに通れば正本へ反映する（3社のAPIキーが必要）
python .github/scripts/ai_models.py update

# 正本のモデルで実APIの最小互換性テスト（3社のAPIキーが必要。少額のAPI利用が発生）
python .github/scripts/ai_models.py smoke
```

新しいAIプロバイダーを追加するときは、正本にモデルIDを、`ai_models.py` の `PROVIDERS` に
認証環境変数・URL・チャネルの版番号パターン・スモークテストを追加する。
モデル一覧を提供しない会社は、公式の変更履歴を機械取得できるか確認し、できなければ自動更新の
対象にせず、停止予定を人間が確認する運用にする。
