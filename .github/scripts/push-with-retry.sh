#!/usr/bin/env bash
# bot のコミットを main へ push する。コミット済みの状態で呼ぶこと。
#
# 同じ push をきっかけに複数の workflow（sitemap.yml・magi-context.yml）が main にコミットするので、
# 取り込んでから push し、取り込んだ直後に相手が先に push して弾かれたら取り込みからやり直す。
# bot のコミットを増やすときは、この後ろに同じく `bash .github/scripts/push-with-retry.sh` を置く。
#
# Pages は同じ SHA の MAGI Chat Gate の成功を待って公開する（build.sh）。GITHUB_TOKEN の push は
# Gate の push 実行を起こさないので、[skip ci] の無いコミットを出したら Gate を workflow_dispatch で起動する。
# 呼ぶ step には `GH_TOKEN: ${{ github.token }}`、workflow には `actions: write` が要る。
set -u

pushed=
for i in 1 2 3 4; do
  if git pull --rebase origin main && git push origin HEAD:main; then pushed=1; break; fi
  git rebase --abort 2>/dev/null || true
  sleep $((i * 5))
done
if [ -z "$pushed" ]; then
  echo "push に4回失敗した" >&2
  exit 1
fi

# Pages がビルドを省く印（Cloudflare Pages の skip の書き方）があれば、公開されないので検査も要らない
if git log -1 --format=%B | grep -qiE '\[(skip[ -]ci|ci[ -]skip|cf-pages-skip)\]'; then
  exit 0
fi
# 起動に失敗しても push は済んでいるので止めない（その SHA は公開されず、次の公開に含まれる）
if ! gh workflow run magi-chat-validation.yml --ref main; then
  echo "::warning::MAGI Chat Gate を起動できなかった。$(git rev-parse --short HEAD) は Pages で公開されない（GH_TOKEN と actions: write を確認する）"
fi
exit 0
