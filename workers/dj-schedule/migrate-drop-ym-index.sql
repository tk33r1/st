-- month_responses(ym) の索引を消す。UNIQUE (ym, name) の索引が先頭に ym を持つので、
-- WHERE ym = ? はそちらで足り、この索引は書き込みのたびに更新されるだけだった。
-- 以前の schema.sql で作った DB のみ対象。何度流しても害はない。
--
--   npx wrangler d1 execute dj-schedule-db --remote --file=./migrate-drop-ym-index.sql

DROP INDEX IF EXISTS idx_month_responses_ym;
