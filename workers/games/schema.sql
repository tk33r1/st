CREATE TABLE IF NOT EXISTS scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_name TEXT    NOT NULL,
  score       INTEGER NOT NULL,
  stage       INTEGER NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- ゲーム別ランキングの区別（/api/:game/scores の :game）。後から足した列なので最後に置く
  -- （本番 DB には ALTER TABLE で追加済み）。
  game_id     TEXT    NOT NULL
);

-- AI呼び出しの共有枠。既存ランキングを変更しない。何度適用してもよい。
CREATE TABLE IF NOT EXISTS game_ai_usage (
  bucket TEXT NOT NULL,
  period TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, period)
);
CREATE INDEX IF NOT EXISTS idx_game_ai_usage_expiry ON game_ai_usage(expires_at);
