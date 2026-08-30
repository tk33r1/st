-- 投稿者が自分の投稿を後から直す／取り下げるための鍵
-- wrangler d1 execute dj-request-db --file=./migrations/0003_edit_token.sql --remote
--
-- ip_hash は本人確認には使えない。会場の Wi-Fi では全員が同じ IP に見えるので、
-- ip_hash で認証すると隣の人のひとことが読めて書き換えられてしまう。
-- 投稿時に発行してブラウザだけが持つトークンで、その1行だけを触れるようにする。
ALTER TABLE requests ADD COLUMN edit_token TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_requests_token ON requests(song_id, edit_token);
