-- 曲リクエスト受付 D1 スキーマ
-- wrangler d1 execute dj-request-db --file=./schema.sql --remote

-- ── イベント ───────────────────────────────
-- QR は https://tk.st/dj/request/ 固定で、どのイベントに投稿されるかは
-- サーバが「いま open のイベント」を解決して決める。
CREATE TABLE IF NOT EXISTS events (
  code       TEXT PRIMARY KEY,            -- 6文字。DJ が口頭で伝えられる長さ
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',-- open | closed
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at  DATETIME
);

-- open は常に 0 件か 1 件。アプリ側のバグで二重に開くのを DB で防ぐ。
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_single_open
  ON events(status) WHERE status = 'open';

-- ── 曲（集約行） ───────────────────────────
-- 同じ曲が複数人から来ても行は増やさず votes を積む。
-- DJ の一覧が同じ曲で埋まらず、人気曲が浮かび上がる。
CREATE TABLE IF NOT EXISTS songs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_code  TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,              -- Apple の trackId、無ければ正規化した artist|title
  track_id    TEXT,                       -- カタログ外リクエストは NULL
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL DEFAULT '',   -- 表示用（JP ストアフロントの表記）
  artist_en   TEXT NOT NULL DEFAULT '',   -- コピー用（rekordbox 検索で当たりやすい）
  variant     TEXT NOT NULL DEFAULT '',   -- "Radio Edit" など
  album       TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  artwork     TEXT NOT NULL DEFAULT '',   -- 240x240bb.webp に差し替え済みの URL
  apple_url   TEXT NOT NULL DEFAULT '',   -- trackViewUrl。booth は music:// に変えて開く
  preview_url TEXT NOT NULL DEFAULT '',
  is_free     INTEGER NOT NULL DEFAULT 0, -- 1 = 自由入力（曲を特定できていない）

  -- 繋ぎの判断材料。ジャンル/年/explicit は iTunes の応答にそのまま入っている。
  genre        TEXT    NOT NULL DEFAULT '',
  release_year INTEGER NOT NULL DEFAULT 0,
  explicitness TEXT    NOT NULL DEFAULT '', -- explicit | cleaned | notExplicit
  -- BPM とキーは外部サービスから後で埋める。取れないことも多いので NULL 許容。
  bpm          REAL,
  song_key     TEXT,   -- "F#m" のような表記
  camelot      TEXT,   -- "11A" のようなキャメロット表記
  votes       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | queued | played | skipped
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  played_at   DATETIME                    -- 「今かかっている曲」の判定と再生済の並び順に使う
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_dedupe ON songs(event_code, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_songs_event  ON songs(event_code, status);
CREATE INDEX IF NOT EXISTS idx_songs_played ON songs(event_code, played_at DESC);

-- ── 投稿（1人1件） ─────────────────────────
-- 名前とひとことは投稿ごとに持つ。ひとことは DJ だけが読むもので、
-- 公開用の /board では一切返さない。
CREATE TABLE IF NOT EXISTS requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id    INTEGER NOT NULL,
  event_code TEXT NOT NULL,
  from_name  TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL DEFAULT '',
  -- あとから荒らしを追うための手掛かり。会場の Wi-Fi では全員同じ値になるので、
  -- 「同じ人か」の判定にも連投の判定にも使ってはいけない。
  ip_hash    TEXT NOT NULL DEFAULT '',
  -- 端末を見分ける鍵。ブラウザの localStorage が持つ値をそのまま受け取る。
  -- 作り直せば別端末として扱われるが、止めたいのは面白半分の連打なので足りる。
  device_key TEXT NOT NULL DEFAULT '',
  -- 投稿者が自分の投稿を後から直す／取り下げるための鍵。投稿時に発行して
  -- ブラウザにだけ渡す。ip_hash は会場の Wi-Fi で全員同じになるので使えない。
  edit_token TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 同じ端末が同じ曲を連打しても票は 1 のまま。
-- 別の人が同じ曲を送るのは歓迎（票が積まれ、ひとことも人数分残る）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_once ON requests(song_id, device_key);
CREATE INDEX IF NOT EXISTS idx_requests_song ON requests(song_id);
CREATE INDEX IF NOT EXISTS idx_requests_token ON requests(song_id, edit_token);

-- ── 連打カウンタの元帳 ─────────────────────
-- 投稿が通るたびに1行増やす。requests とは別に持つのが要点で、requests は
-- 取り下げると行ごと消えるため、それを数えると投稿→取り下げの繰り返しで
-- 上限がいくらでも戻ってしまう。判定に要らなくなった行は投稿のたびに捨てる。
CREATE TABLE IF NOT EXISTS post_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_post_log_rate ON post_log(device_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_log_age  ON post_log(created_at);
