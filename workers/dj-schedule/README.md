# tk-st-dj-schedule

白昼夢（人類踊狂計画）の日程調整ページ用 API。

- フロント: [`/dj/schedule/index.html`](../../dj/schedule/index.html) → https://tk.st/dj/schedule/
- API ルート: `tk.st/dj/api/*`
- ストレージ: D1（`dj-schedule-db`）

ログイン無し・身内限定。ページ側は `noindex, nofollow`、API レスポンスにも `X-Robots-Tag: noindex` を付けている。

## 考え方

白昼夢は**毎月1回・日曜開催**なので、**1ヶ月＝1イベント**として扱う。

- 候補日はその月の日曜日そのもの。DB には持たず、`ym`（`"2026-09"`）から毎回計算する
- 「イベントを作る」操作は無い。月を開けばそこに日曜が並んでいる
- 月ごとに「確定した開催日」を1日と「開催できない日」を持てる。どちらも `month_memos` の行に入る
- 通し回数（白昼夢①②③…）は画面側の表示だけ。`dj/schedule/index.html` の
  `SERIES_START = '2026-06'`（＝白昼夢①）から算出する。**起点を変えるならここ**

## 初回デプロイ

```bash
cd workers/dj-schedule

# 1. D1 を作る（出力された database_id を wrangler.toml に貼る）
npx wrangler d1 create dj-schedule-db

# 2. テーブルを作る
npx wrangler d1 execute dj-schedule-db --remote --file=./schema.sql

# 3. デプロイ
npx wrangler deploy
```

## アクセス制限について

**実質かかっていない。** このページを守っているのは URL の非公開性と `noindex` だけ。

コードに `CLIENT_API_KEY` を見る分岐があるが、**設定しても挙動は変わらない**ので不要。
理由は、同一オリジンの GET に `Origin` ヘッダが飛ばないため `origin === ''` を許可しており、
ヘッダーを付けない curl も同じ条件で素通りするから。キーが効くのは
「`Origin` 付きで tk.st 以外から来たリクエスト」だけだが、それは JSON POST なら
プリフライトの時点でブラウザが弾く。

本当に絞るなら、書き込み系（POST/PUT/DELETE）で `Origin` を必須にする（curl のヘッダー無しを弾ける。
ただし `-H 'Origin: https://tk.st'` で迂回できるので気休め）か、合言葉／ログインを足すことになる。
後者は「ログイン不要」という運用方針と衝突する。

### 確定日・開催不可日の追加（既存 DB のみ）

`month_memos` に `decided` / `blocked` 列を足す。`schema.sql` を流していない DB には不要
（`schema.sql` 側に列が入っている）。

```bash
npx wrangler d1 execute dj-schedule-db --remote --file=./migrate-add-status.sql
```

2回流すと `duplicate column name` で落ちる。適用済みという意味なので無視してよい。

### イベント作成方式からの移行

初期版は `events` / `responses` テーブルを使っていた。月ベースに変えたので、
`schema.sql` を流し直したあと、空であることを確認して旧テーブルを落とす。

```bash
npx wrangler d1 execute dj-schedule-db --remote --command "SELECT COUNT(*) FROM responses"
npx wrangler d1 execute dj-schedule-db --remote --file=./drop-old-tables.sql
```

## ローカル確認

`wrangler.dev.toml` はルート定義を外し、ダミー ID で miniflare のローカル D1 を使う設定。

```bash
cd workers/dj-schedule
npx wrangler d1 execute dj-schedule-db --local --file=./schema.sql --config ./wrangler.dev.toml
npx wrangler dev --local --port 8787 --config ./wrangler.dev.toml
```

ページ側の `API_BASE` は `/dj/api` 固定（同一オリジン）なので、ローカルで通しで触るときは
静的配信サーバから `/dj/api/*` を `127.0.0.1:8787` にプロキシする。

## エンドポイント

`:ym` は `YYYY-MM`（2020-01 〜 2099-12）。

| メソッド | パス | 用途 |
| --- | --- | --- |
| GET | `/dj/api/months` | 回答が入っている月の一覧（新しい順・最大24件） |
| GET | `/dj/api/months/:ym` | その月の日曜日・メモ・全回答。DB に行が無くても空の月として 200 を返す |
| PUT | `/dj/api/months/:ym/memo` | 月のメモを更新 `{memo}` |
| PUT | `/dj/api/months/:ym/status` | 確定日と開催不可日 `{decided:"2026-09-13"\|null, blocked:["2026-09-06"]}` |
| POST | `/dj/api/months/:ym/responses` | 回答の登録・更新 `{name, answers:{date:"o"\|"t"\|"x"}, comment}` |
| DELETE | `/dj/api/months/:ym/responses/:responseId` | 回答を1件削除 |

`answers` は日付をキーにした連想配列。その月の日曜日以外のキーは保存時に捨てられる。
`decided` / `blocked` も同様に、その月の日曜日以外は捨てられる。`decided` に指定した日は `blocked` から自動で外れる。
`status` は毎回 2つの値をまとめて上書きするので、画面側は現在値を含めて送ること。
回答は `(ym, name)` で一意で、同じ名前で再送すると上書き（＝修正）になる。

## 制限値

回答 60件/月 / 名前 20文字 / ひとこと 200文字 / メモ 500文字。
保存時に `<` `>` と制御文字を落とす（メモのみ改行を保持）。表示側は全て `textContent` で描画。
