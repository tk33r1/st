-- イベント作成方式（events / responses）をやめて月ベースに変えたときの後片付け。
-- 一度だけ実行すればよい。中身が空であることを確認してから流すこと。
--   npx wrangler d1 execute dj-schedule-db --remote --command "SELECT COUNT(*) FROM responses"
--   npx wrangler d1 execute dj-schedule-db --remote --file=./drop-old-tables.sql

DROP TABLE IF EXISTS responses;
DROP TABLE IF EXISTS events;
