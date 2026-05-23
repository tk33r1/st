-- MAGI (magi2) — IP×日次レート制限
-- 適用: wrangler d1 execute tk-st-magi2-db --file workers/magi2/schema.sql --remote
CREATE TABLE IF NOT EXISTS rate_limit (
  ip    TEXT    NOT NULL,
  day   TEXT    NOT NULL,           -- 'YYYY-MM-DD' (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);

-- いいね/絵文字リアクションが付いた回答の request/response 記録
CREATE TABLE IF NOT EXISTS reactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT    NOT NULL,      -- ISO8601 (UTC)
  ip         TEXT,
  target     TEXT    NOT NULL,      -- 人格コードネーム or 'integrated'
  reaction   TEXT    NOT NULL,      -- 絵文字（'👍' = いいね）
  request    TEXT    NOT NULL,      -- リアクション対象のユーザー発言
  response   TEXT    NOT NULL       -- リアクション対象の回答内容
);
CREATE INDEX IF NOT EXISTS idx_reactions_created ON reactions (created_at);
