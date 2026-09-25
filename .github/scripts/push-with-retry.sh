#!/usr/bin/env bash
# bot のコミットを main へ push する。コミット済みの状態で呼ぶこと。
#
# 同じ push をきっかけに複数の workflow（sitemap.yml・magi-context.yml）が main にコミットするので、
# 取り込んでから push し、取り込んだ直後に相手が先に push して弾かれたら取り込みからやり直す。
# bot のコミットを増やすときは、この後ろに同じく `bash .github/scripts/push-with-retry.sh` を置く。
set -u

for i in 1 2 3 4; do
  git pull --rebase origin main && git push origin HEAD:main && exit 0
  git rebase --abort 2>/dev/null || true
  sleep $((i * 5))
done
echo "push に4回失敗した" >&2
exit 1
