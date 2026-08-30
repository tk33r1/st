-- 端末単位の鍵。ブラウザの localStorage が持つ値で、同じ Wi-Fi でも人ごとに別になる。
-- wrangler d1 execute dj-request-db --file=./migrations/0004_device_key.sql --remote
--
-- これまで「同じ人か」を ip_hash で見ていたが、会場の Wi-Fi では全員が同じ値に
-- なるため二つ壊れていた。
--   (1) ある曲を最初に送った1人以外は行が作られず、票もひとことも消えていた。
--   (2) その重複時に、既存行の edit_token（＝他人の鍵）を渡していた。
-- 判定を端末単位に移して、どちらも塞ぐ。ip_hash は列としては残すが、
-- あとから荒らしを追う手掛かりで、本人確認には二度と使わない。
ALTER TABLE requests ADD COLUMN device_key TEXT NOT NULL DEFAULT '';

-- 既存行は行ごとに別の値を入れる。空文字のままだと下の UNIQUE で衝突する。
UPDATE requests SET device_key = 'legacy-' || id;

DROP INDEX IF EXISTS idx_requests_once;
CREATE UNIQUE INDEX idx_requests_once ON requests(song_id, device_key);

-- 連投の判定も端末単位で引く
DROP INDEX IF EXISTS idx_requests_rate;
CREATE INDEX idx_requests_rate ON requests(device_key, created_at DESC);
