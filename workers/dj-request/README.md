# 曲リクエストWorker：NEXTの評価

NEXTは最後に再生済みにした曲を起点に、pending／queuedの候補を次の式で順位付けする。

```
総合点 = 70 × Jev評価 + 30 × いいね数 / (いいね数 + 2)
Jev評価 = Score応答のscore / 4
```

質問の正本は`src/transitions.js`、モデルIDは`config/ai-models.json`。BPM・キー・年代・ジャンル・版の種類と、既存のBPM差・キーの関係を1つのScore質問で評価する。曲調の説明・音源・曲名・アーティスト・投稿者情報は送らない。votesとqueuedの旧加点は順位計算に使わない。

`POST /admin/next`は現在のイベントと最後の再生済み曲をDBで照合する。クライアントから自由な質問やメタデータを受け付けず、手元でタップしたBPMだけを反映する。BPM・キー・入力・加点の共通処理は`dj/booth/transition-score.js`。UIには総合点と相性・いいねの内訳、従来のBPM・キーから計算する繋ぎ方の目安を表示する。

評価結果は入力・質問・モデルのハッシュでD1に保存する。いいねやstatusを変えても同じ音楽評価を再利用し、総合点だけ再計算する。メタデータやタップBPMが変われば別の評価になる。同じ入力の同時要求はDBの先取りで重複を防ぎ、失敗は60秒、取り残された処理は30秒で再試行できる。1リクエスト12件・4並列・上流7秒、Worker全体でUTCの1日2,000評価まで。設定は`TRANSITION_LIMITS`。

評価済みの候補から上位3曲を表示する。未評価の曲がある間は評価済み・未評価の件数を併記し、一部の評価待ちや失敗があっても取得済みの候補は表示し続ける。障害・キー未設定・上限到達の場合は未評価の件数と取得失敗を表示する。キー未設定でも既存の成功キャッシュは使える。

## 初回反映

リポジトリSecret `CLOUDFLARE_API_TOKEN`は、従来の「Edit Cloudflare Workers」テンプレートとゾーンtk.stのWorkers Routes編集権限に加え、対象アカウントの **Account > D1 > Edit** が必要。この追加権限はテンプレートには含まれないため、CloudflareのAPIトークン設定で追加してから実行する。

GitHub Actionsの`Deploy Worker`で`dj-request`を選ぶと、認証設定を確認し、`0008_transition_scores.sql`を適用してからリポジトリSecret `TYPESAFE_API_KEY`をWorkerへ設定し、デプロイする。DB更新に失敗した場合は必要権限の案内を出し、キー設定・デプロイを行わず停止する。Secret未設定の場合はCloudflare側の既存キーを維持する。dry-runは認証設定の確認・キー設定・DB更新を行わない。ブース画面は通常どおりmainへのpushで反映される。

手元から反映する場合は、`workers/`で以下を実行する。

```powershell
npx wrangler d1 execute dj-request-db --remote --config dj-request/wrangler.toml --file dj-request/migrations/0008_transition_scores.sql
# DB更新が成功したことを確認してから、キー設定とデプロイへ進む。
npx wrangler secret put TYPESAFE_API_KEY --config dj-request/wrangler.toml
npx wrangler deploy --config dj-request/wrangler.toml
```

ローカル実行は`dj-request/.dev.vars`に`TYPESAFE_API_KEY`を置く。同じWorkerの環境に`MAGI_TYPESAFE_API_KEY`があれば代わりに使える。別Workerのシークレットは共有されない。`.dev.vars`をコミットしない。

## 確認

`node .github/scripts/test-dj-transitions.mjs`で、実曲テストの入力・質問・結果との一致、DBキャッシュ・同時実行・予算・失敗時処理、ブースの順位更新を確認する。Node 22.13以上の組み込みSQLiteを使い、外部API・本番DBには接続しない。

承認された実曲再テストの結果は`dj/booth/jev-evaluation.md`。比較用の旧NEXTは`.github/scripts/fixtures/dj-next-rule.js`に保存しており、本番の順位計算では使わない。
