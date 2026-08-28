-- 既存の dj-request-db に繋ぎ判断用のカラムを足す
-- wrangler d1 execute dj-request-db --file=./migrations/0001_track_details.sql --remote
ALTER TABLE songs ADD COLUMN genre        TEXT    NOT NULL DEFAULT '';
ALTER TABLE songs ADD COLUMN release_year INTEGER NOT NULL DEFAULT 0;
ALTER TABLE songs ADD COLUMN explicit     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE songs ADD COLUMN bpm          REAL;
ALTER TABLE songs ADD COLUMN song_key     TEXT;
ALTER TABLE songs ADD COLUMN camelot      TEXT;
