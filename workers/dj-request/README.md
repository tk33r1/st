# 曲リクエストWorker：NEXTの評価

## 背景カードの採用方針（2026-10-17）

検索からカード生成までLunaを継続する。本人の「過去のテストで検索との組み合わせにLunaの優位があれば、検索を伴うものはLunaでよい」という回答を、[A2の検索品質比較](../magi2/A2Web回答品質比較.md)で確認した。Haikuに残った原文重複・開館時間の混在・項目不足が、同じダーク設定でWebだけLunaへ替えた15問では改善していた。Lunaの全件正確性やDJでの直接比較を証明したものではない。

下記のHaiku候補は未採用の評価用として保持し、自動切替しない。Luna検索＋Haiku生成へ分割する案も採用しない。MAGIの通常のダーク回答・討議判定や、検索のないゲームの移行候補にはこの決定を広げない。URLのパス・クエリを小文字にしない出典照合の修正は、現行Luna経路にも適用する。

## 背景カードのHaiku移行候補（2026-10-16、未公開）

設計§5.7の候補を追加。`SONG_INFO_AI_PROVIDER`は`openai`のままで、`anthropic`への切り替えは未採用。候補のキーは`ANTHROPIC_API_KEY`。
候補は強制Web検索（high、検索最大2回）とJSON生成（推論なし）を分け、実検索ブロックのURLと一致する引用本文だけをJSON生成へ渡す。無引用の要約や検索で見つかっただけの未引用URLは根拠にしない。カード要求全体は16,000コード単位までとし、過大な資料は切り詰めず後段の送信前に止める。
同じ期限を2段階で共有し、曲照合とDB先取りの所要時間も持ち時間から引く。自動25秒・手動再生成45秒、dailyCap・再試行回数・既存カードの保存を維持する。

`node --test .github/scripts/test-auxiliary-ai.mjs`で検索未実行・ツールエラー・拒否・不正JSON・期限切れ・架空URL・無引用資料の除外と上限を確認できる。URLのパス・クエリの大文字小文字を維持して別ページを混同しない。固定した公開原典からのカード生成は実モデル5件を確認済みだが、実検索を含む全経路の品質・2段階の実時間は未評価。[修正と限定評価](Haiku移行修正評価.md)を参照。
従来の背景カード評価の入力・保存済み応答は今回の作業領域では見つかっていない。比較入力の確定と、検索中の追加入力トークンを含む費用上限の根拠が揃うまで新規の有料検索は送らない。
将来この方針を見直す場合は、同じ入力でLunaとの出典脱落率・事実誤り・全体25秒を比較し、ブースの送り先表記とキー同期を揃える。現在の設定ではDJ用Anthropicキーを同期せず、週次smokeも候補へ送らない。

## NEXTの評価

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

## AI相談のローカル確認

受付Workerとmagi2を両方起動し、localhostページの `?api=http://localhost:8787&req_api=http://localhost:8788` で接続する。受付Workerの非追跡 `.dev.vars` だけ `DJ_LOCAL_DEV="true"` にし、`wrangler dev` へ `--local-upstream localhost:8788` を付ける。DB初期化・イベント作成・Origin条件はmagi2のREADMEとルートの検証計画3節に従う。本番の設定はfalseで維持する。
