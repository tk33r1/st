-- 既存行は NULL のまま残す。旧クライアントの連番だけによる削除は許可しない。
ALTER TABLE reactions ADD COLUMN delete_token_hash TEXT;
ALTER TABLE reactions ADD COLUMN fingerprint TEXT;
CREATE UNIQUE INDEX idx_reactions_fingerprint ON reactions (ip, fingerprint);
