-- MAGI (magi2) — IP×日次レート制限
-- 適用: wrangler d1 execute tk-st-magi2-db --file workers/magi2/schema.sql --remote
CREATE TABLE IF NOT EXISTS rate_limit (
  ip    TEXT    NOT NULL,
  day   TEXT    NOT NULL,           -- 'YYYY-MM-DD' (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);
