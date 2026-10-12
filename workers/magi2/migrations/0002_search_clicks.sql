-- 共通検索の候補クリックの記録（POST /search/api/click）。集計は .github/scripts/search-boost.py が1日1回行い、90日より古い行を消す。
-- 適用: cd workers && npx wrangler d1 execute tk-st-magi2-db --remote --file=magi2/migrations/0002_search_clicks.sql
-- 索引は張らない（張ると1件の記録で書き込み行数が増える。集計と削除は1日1回の全件走査で足りる）。
CREATE TABLE search_clicks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  day      TEXT    NOT NULL,      -- 'YYYY-MM-DD' (UTC)
  at       INTEGER NOT NULL,      -- 記録した時刻（ミリ秒）
  scope    TEXT    NOT NULL,      -- site / tools / game / nitori / retail
  query    TEXT    NOT NULL,      -- 照合と同じ正規化をした検索語
  href     TEXT    NOT NULL,      -- 押したページ
  list     TEXT    NOT NULL,      -- suggest（入力中の候補）/ local（①）/ semantic（②）
  position INTEGER NOT NULL,      -- 一覧の中の順位（1から）
  visitor  TEXT    NOT NULL       -- secret の SEARCH_CLICK_SALT を混ぜた IP のハッシュの先頭16桁（同じ人の重複を集計で除く）
);
