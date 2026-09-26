-- 曲の背景カード（OpenAI + Web 検索）と、BPM・キーの出どころ
-- wrangler d1 execute dj-request-db --file=./migrations/0007_song_info.sql --remote
--
-- BPM とキーは外部サービス（GetSongBPM / Deezer）で取れないことが多い。取れなかった曲は
-- ブースがプレビューを解析して推定値を入れる（空欄のときだけ）。画面で「推定」と
-- 見分けられるよう、値ごとに出どころを持つ。既存の行は NULL のまま（＝外部サービス由来）。
ALTER TABLE songs ADD COLUMN bpm_src TEXT;   -- gsb | deezer | est
ALTER TABLE songs ADD COLUMN key_src TEXT;   -- gsb | est

-- 背景カードは曲（Apple の trackId）ごとに1枚。イベントをまたいで使い回すので
-- songs とは別の表に持つ。イベントを消してもカードは残る（同じ曲がまた来たら料金ゼロ）。
CREATE TABLE IF NOT EXISTS song_info (
  track_id   TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | ok | failed
  card       TEXT,                            -- 画面に出す JSON（出典を照合済みの項目だけ）
  model      TEXT NOT NULL DEFAULT '',
  error      TEXT NOT NULL DEFAULT '',
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 1日あたりの生成数の上限を数える
CREATE INDEX IF NOT EXISTS idx_song_info_updated ON song_info(updated_at);
