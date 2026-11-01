-- 会話の保存（設定で「会話をサイトに保存」をオフにしていない新しい画面の通常チャット。→ personas.js の CONVERSATION_STORE）。
-- 1往復ごとに1行。プロンプトの文字（画像は枚数、添付は名前だけ）と統合人格の答えを保存する。保存期間を過ぎた行は Worker が消す。
-- 適用: cd workers && npx wrangler d1 execute tk-st-magi2-db --remote --file=magi2/migrations/0003_conversations.sql
-- 索引は張らない（張ると1件の記録で書き込み行数が増える。期限切れの削除は毎日の全件走査で行う）。
CREATE TABLE conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT    NOT NULL,      -- ISO8601 (UTC)
  ip              TEXT,
  conversation_id TEXT,                  -- 画面の会話の ID（session_…）。同じ会話の往復をまとめる
  theme           TEXT,                  -- light / dark
  intent          TEXT,                  -- 発言の分類（consult / research / site / music など）
  mode            TEXT,                  -- 討議 / 事実回答（fact）/ 採決（magi）
  request         TEXT    NOT NULL,      -- 今回のプロンプト（文字だけ。画像は枚数、添付は名前）
  response        TEXT    NOT NULL       -- 統合人格の答え
);
