#!/usr/bin/env bash
# Cloudflare Pages のビルド。Pages の設定は「ビルドコマンド: bash build.sh」「ビルドの出力先: _site」。
#
# サイトはビルド工程のない静的ファイルだが、リポジトリ直下をそのまま出すと、Worker のコード・
# workflow・AGENTS.md など、サイトでないものまで公開される。ここで公開するファイルだけを _site/ に写し、
# reverse-recaptcha（Vite + React）だけはビルドした結果を置く。URL はリポジトリのパスのまま変わらない。
#
# 手元でも同じものを作って確かめられる（bash build.sh → python3 -m http.server --directory _site）。
# リポジトリのファイルは書き換えない。
set -euo pipefail
cd "$(dirname "$0")"
OUT=_site

# 公開しないもの。当たったファイルは _site/ に写さない。
# 新しく足すものも、ここに当たらなければ公開される（ページを増やすたびに書き足さなくてよい）。
private() {
  case "$1" in
    .well-known/*) return 1 ;;              # 置く場合は公開する（security.txt など）
    .*|*/.*) return 0 ;;                    # ドットファイル（.github/・.claude/・.gitignore など）
    build.sh|AGENTS.md) return 0 ;;
    workers/*|config/*) return 0 ;;         # Worker のコードと設定（config はデプロイ時に Worker が取り込む）
    magi-app/www/*) return 1 ;;             # MAGI の PWA（出荷物）は公開する
    magi-app/*) return 0 ;;                 # Capacitor の設定・アイコンの元絵・README
    game/reverse-recaptcha/*) return 0 ;;   # ソース。下でビルドした結果を置く
    assets/vendor/*) return 1 ;;            # 同梱ライブラリのライセンス文（LICENSE.*.md を含む）は公開する
    *.md) return 0 ;;                       # README・企画書などの手元の資料
  esac
  return 1
}

# 写す元の一覧。Git が管理しているものだけにする（node_modules や手元の作業ファイルを拾わない）
list() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -z
  else
    find . -type f -not -path './.git/*' -not -path "./$OUT/*" -not -path '*/node_modules/*' -print0 | sed -z 's#^\./##'
  fi
}

rm -rf "$OUT"
mkdir -p "$OUT"

# 1. 公開するファイルを写す
n=0
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue                   # 手元で消したがまだコミットしていないもの
  private "$f" && continue
  mkdir -p "$OUT/$(dirname "$f")"
  cp -p "$f" "$OUT/$f"
  n=$((n + 1))
done < <(list)

# 2. reverse-recaptcha をビルドして、ソースのあった場所（/game/reverse-recaptcha/）に置く
(cd game/reverse-recaptcha && npm ci --no-audit --no-fund && npm run build -- --outDir "../../$OUT/game/reverse-recaptcha" --emptyOutDir)

# 3. 出来上がりを確かめる（足りない・余計なものがあれば、デプロイさせずに止める）
fail() { echo "build.sh: $*" >&2; exit 1; }
for f in index.html 404.html _redirects robots.txt sitemap.xml favicon.ico \
         game/reverse-recaptcha/index.html magi-app/www/index.html assets/vendor/SOURCES.json; do
  [ -f "$OUT/$f" ] || fail "$f が無い"
done
grep -q '/game/reverse-recaptcha/assets/' "$OUT/game/reverse-recaptcha/index.html" \
  || fail 'reverse-recaptcha の index.html がビルド結果になっていない'
for f in AGENTS.md build.sh workers config .github .claude magi-app/package.json game/reverse-recaptcha/src; do
  [ ! -e "$OUT/$f" ] || fail "公開しないはずの $f が入っている"
done
# Cloudflare Pages の上限（1ファイル 25MiB、全体 20,000 ファイル）。超えるとデプロイが通らない
big=$(find "$OUT" -type f -size +25M)
[ -z "$big" ] || fail "25MiB を超えるファイルがある（分けて置く。assets/vendor の split を参照）: $big"
total=$(find "$OUT" -type f | wc -l)
[ "$total" -le 20000 ] || fail "ファイルが $total 件あり、Pages の上限（20,000）を超えている"

echo "build.sh: $n 件を写し、reverse-recaptcha をビルドした（計 $total 件）→ $OUT/"
