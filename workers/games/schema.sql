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
