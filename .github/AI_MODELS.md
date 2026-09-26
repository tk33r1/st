# AIモデルの更新管理

AI APIで使うモデルIDの正本は `config/ai-models.json`（プロバイダー → 用途チャネル → モデルID）。
実運用で直接モデルを選ぶプロバイダーは OpenAI・DeepSeek・Google（Gemini）の3社で、旧MAGIの `magi.tk.st` は
外部バックエンドへの中継だけなので、この仕組みからは背後のモデルを確認・変更できない。

## 仕組み

- Pythonの生成処理は `ai_model_registry.py` から正本を読む。`OPENAI_MODEL` /
  `DEEPSEEK_MODEL` はローカルで別モデルを試す場合だけの上書き手段で、GitHub Actionsの
  実運用workflowでは設定しない。日刊生成は正本を読めなくてもルールベースで号を出す。
- Cloudflare Worker（`workers/magi2`・`workers/wrangler`）は正本のJSONを `import` する。
  wrangler がデプロイ時にバンドルへ取り込むので、正本を変えたら再デプロイで反映される。
- 正本にはモデルIDだけを置く。モデル一覧・Chat CompletionsのURL、APIキーの環境変数、
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
3. **レビュー用PR**。正本が変わっていればPRを作る（ブランチ `automation/ai-model-update`）。
   ほかの要確認事項（停止予定、DeepSeekの一覧取得失敗など）があってもPRは止めない。
   PRに人のコミットがある場合はブランチを上書きせず、レポートをコメントするだけにする。
4. **Issue**。スモークテストの失敗、現在のモデルが一覧にない、停止予定日がある、候補が不合格、
   PRの作成失敗のいずれかがあれば、Issueを作成または追記する。

自動マージとWorkerの自動デプロイはしない。PRをマージするとGitHub Actionsの生成処理は更新される。
MAGI本体とゲーム共通APIは `workers/magi2` と `workers/wrangler` を手動デプロイして本番へ反映する。
PR本文にも同じ手順を出す。

### スモークテストの中身

実運用の呼び出し方を最小の形でなぞる。呼び出し方を変えたら `ai_models.py` の `smoke_*` も合わせる。

| プロバイダー | 試すこと | なぞっている利用箇所 |
| --- | --- | --- |
| OpenAI | 非推論・temperature 0.2・JSON出力 | 日刊生成、MAGIの人格カード、ゲームAPI |
| OpenAI | 非推論・temperature 1.3・top_p・画像入力（data URL） | magi2 の Strategist（揺らぎの最大温度、画像付きの質問） |
| OpenAI | 推論 high・ストリーミング | magi2 の統合（上位モデルでは組織認証を求められることがある） |
| DeepSeek | temperature 0.2・JSON出力 | 日刊生成 |
| DeepSeek | 推論なし（`thinking` disabled）・temperature 1.3・top_p・画像入力 | magi2 の Enthusiast |
| Google | 推論 minimal（Gemini 3 系は切れない）・temperature 1.3・top_p・画像入力 | magi2 の Humanist |

OpenAIのモデル一覧は `OPENAI_API_KEY`、DeepSeekは `DEEPSEEK_API_KEY`、Googleは `GEMINI_API_KEY` を使う。
OpenAIとDeepSeekは既存のRepository Secretをそのまま使う。`GEMINI_API_KEY` はmagi2の Humanist 用に足した
Repository Secretで、Worker の `MAGI_GEMINI_API_KEY` と同じ有料枠のキーでよい（未設定だと監視がIssueで知らせる）。
レビュー用PRを自動作成するには、GitHubのリポジトリ設定で Actions にPull Requestの作成を
許可しておく。許可されていない場合も、workflowは失敗内容をIssueで通知する。
ボットが作ったPRでは `ai-models.yml` が走らない（GITHUB_TOKEN の push は workflow を起動しない）が、
`update` が書き込み後に同じ検査を実行している。

## 手元での操作

```bash
# 正本の形式と直書きの検査（APIキー不要）
python .github/scripts/ai_models.py check

# 各社のモデル一覧から新しい版を探し、スモークテストに通れば正本へ反映する（3社のAPIキーが必要）
python .github/scripts/ai_models.py update

# 正本のモデルで実APIの最小互換性テスト（3社のAPIキーが必要。少額のAPI利用が発生）
python .github/scripts/ai_models.py smoke
```

新しいAIプロバイダーを追加するときは、正本にモデルIDを、`ai_models.py` の `PROVIDERS` に
認証環境変数・URL・チャネルの版番号パターン・スモークテストを追加する。
モデル一覧を提供しない会社は、公式の変更履歴を機械取得できるか確認し、できなければ自動更新の
対象にせず、停止予定を人間が確認する運用にする。
