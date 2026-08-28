-- 確定した開催日と開催不可日を month_memos に足す。
-- すでに月ベースのテーブルを --remote に作ってある場合のみ必要。
-- まだ schema.sql を流していないなら schema.sql だけでよい（列は入っている）。
--
--   npx wrangler d1 execute dj-schedule-db --remote --file=./migrate-add-status.sql
--
-- 2回流すと "duplicate column name" で失敗する。それは適用済みという意味なので無視してよい。

ALTER TABLE month_memos ADD COLUMN decided TEXT;
ALTER TABLE month_memos ADD COLUMN blocked TEXT NOT NULL DEFAULT '[]';
