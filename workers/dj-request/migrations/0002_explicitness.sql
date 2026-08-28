-- iTunes の trackExplicitness は explicit / cleaned / notExplicit の3値。
-- 「クリーン版かどうか」も繋ぎの判断材料になるので、真偽値ではなく文字列で持つ。
ALTER TABLE songs ADD COLUMN explicitness TEXT NOT NULL DEFAULT '';
ALTER TABLE songs DROP COLUMN explicit;
