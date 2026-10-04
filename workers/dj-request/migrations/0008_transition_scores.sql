-- Jevの音楽評価は入力・質問・モデル単位で保存。いいねは入力に含めない。
CREATE TABLE IF NOT EXISTS transition_scores (
  cache_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed')),
  score REAL CHECK (score >= 0 AND score <= 1),
  confidence REAL CHECK (confidence >= 0 AND confidence <= 1),
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transition_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);
