-- AI呼び出しの共有枠。既存ランキングを変更しない。何度適用してもよい。
CREATE TABLE IF NOT EXISTS game_ai_usage (
  bucket TEXT NOT NULL,
  period TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, period)
);
CREATE INDEX IF NOT EXISTS idx_game_ai_usage_expiry ON game_ai_usage(expires_at);
