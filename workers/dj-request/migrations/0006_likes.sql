-- いいね（来場者が「みんなのリクエスト」から押す）
-- wrangler d1 execute dj-request-db --file=./migrations/0006_likes.sql --remote
--
-- votes（リクエストした人数）とは別に持つ。votes は「送った人の数」で、
-- 投稿しないと増やせない。いいねは曲を送っていない人でも押せる人気の目安で、
-- 用途が違うので同じ列に混ぜない（ブースは REQ と LIKE を並べて出す）。
--
-- 誰が押したかは requests と同じく device_key で見る。会場の Wi-Fi では
-- 来場者全員の IP が同じ値になるので、IP では「同じ人か」を判定できない。
CREATE TABLE IF NOT EXISTS likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id    INTEGER NOT NULL,
  event_code TEXT NOT NULL,
  device_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 1人1曲1回。連打しても2票目は入らない。
CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_once ON likes(song_id, device_key);
CREATE INDEX IF NOT EXISTS idx_likes_song ON likes(song_id);

-- 表示のたびに数え直さずに済むよう、songs 側にも合計を持つ。
-- 増減のたびに likes を数え直して書き戻すので、ずれても次の押下で直る。
ALTER TABLE songs ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;

-- 人気順（ブースの SORT）で引く
CREATE INDEX IF NOT EXISTS idx_songs_likes ON songs(event_code, likes DESC);
