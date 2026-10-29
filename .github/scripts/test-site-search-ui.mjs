// サイト内検索の URL・参照元・計測の検証の入口。中身は test-phase4-publication.mjs。
// Actions の site-search-url.yml・magi-publication.yml がこの名前で呼ぶので残している。引数はそのまま渡る。
//   node .github/scripts/test-site-search-ui.mjs [--root _site]                 … 手元（先に bash build.sh で _site を作る）
//   node .github/scripts/test-site-search-ui.mjs --base https://tk.st [--live]  … 本番（--live だけ②を実際に送る）
// Phase 3 の画面を相手にした旧来の場面は、公開中の画面が Phase 4 になって通らない経路になったので外した（git の履歴にある）。
// 古いHTMLとの互換は test-phase4-legacy-ui.mjs、共通UIの操作は test-phase4-search-ui.mjs が受け持つ。
await import('./test-phase4-publication.mjs');
