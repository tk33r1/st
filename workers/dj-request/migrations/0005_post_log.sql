-- 連打カウンタの元帳
-- wrangler d1 execute dj-request-db --file=./migrations/0005_post_log.sql --remote
--
-- これまで「直近この端末が何件送ったか」を requests の行数で数えていたが、
-- 取り下げるとその行が消えるため、投稿→取り下げを繰り返すだけで上限が戻った。
-- 数える先を、取り下げでは消えない専用の元帳に移す。
CREATE TABLE IF NOT EXISTS post_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_post_log_rate ON post_log(device_key, created_at DESC);
-- 古い行の掃除で使う。端末の鍵を必要以上に持ち続けないため。
CREATE INDEX IF NOT EXISTS idx_post_log_age  ON post_log(created_at);

-- 移行の直後だけ上限が緩まないよう、判定に効く範囲だけ写しておく
INSERT INTO post_log (device_key, created_at)
  SELECT device_key, created_at FROM requests WHERE created_at > datetime('now', '-1 hour');

-- requests 側の連打用インデックスは使わなくなった
DROP INDEX IF EXISTS idx_requests_rate;
