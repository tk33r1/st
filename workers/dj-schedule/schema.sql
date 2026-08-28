-- 白昼夢スケジュール調整 D1 スキーマ
-- npx wrangler d1 execute dj-schedule-db --remote --file=./schema.sql
--
-- 候補日（その月の日曜日）は月から導けるので保存しない。月ごとの回答とメモだけを持つ。

-- 月ごとの状態（メモ・確定した開催日・開催不可日）
CREATE TABLE IF NOT EXISTS month_memos (
  ym         TEXT PRIMARY KEY,            -- "2026-09"
  memo       TEXT NOT NULL DEFAULT '',
  decided    TEXT,                        -- 確定した開催日 "2026-09-13"。未定は NULL
  blocked    TEXT NOT NULL DEFAULT '[]',  -- 開催不可日 JSON配列 ["2026-09-06"]
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS month_responses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ym         TEXT NOT NULL,              -- "2026-09"
  name       TEXT NOT NULL,
  answers    TEXT NOT NULL DEFAULT '{}', -- JSONオブジェクト {"2026-09-06":"o"|"t"|"x"}
  comment    TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ym, name)
);

CREATE INDEX IF NOT EXISTS idx_month_responses_ym ON month_responses(ym);
