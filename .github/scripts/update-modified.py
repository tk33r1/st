#!/usr/bin/env python3
"""各 HTML の JSON-LD `dateModified` を、そのファイルの最終コミット日時に合わせる。

手書きだと必ず更新を忘れて構造化データが実態からずれるので、git のコミット日時を
唯一の情報源にする。

- 対象は `<script type="application/ld+json">` ブロックの中だけ。同じブロック内の
  `datePublished` / `dateCreated` は公開日・作成日なので絶対に触らない。
- 日時は必ず JST（+09:00）に揃える。ランナーの TZ は UTC なので、変換しないと
  サイト内で表記が混ざる。
- **bot 自身のコミットは無視して日付を決める。** これがこのスクリプトの肝で、
  ワークフローが自分の push で再実行されても同じ値を書くだけ（＝差分なし）になり、
  commit が空振りしてループが止まる。無視しないと bot → bot → … と無限に回る。

差分が無ければ何も書かないので、ワークフロー側の `git commit || exit 0` がそのまま
終了条件として機能する。
"""

import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))
# bot のコミットを見分けるためのアドレス。実体はワークフローの `env.BOT_EMAIL` が持ち、
# commit 時の `git config user.email` と同じ値を参照する。ここで `git config` を読まない
# のは、その設定がこのスクリプトより後の commit ステップで行われるため。既定値は
# ローカル実行用のフォールバック。
BOT_EMAILS = {os.environ.get('BOT_EMAIL') or 'github-actions[bot]@users.noreply.github.com'}

LD_BLOCK = re.compile(
    r'(<script[^>]*type=["\']application/ld\+json["\'][^>]*>)(.*?)(</script>)',
    re.S | re.I)
# 整形済み（`"dateModified": "..."`）と最小化済み（`"dateModified":"..."`）の両方に当てる。
DATE_FIELD = re.compile(r'("dateModified"\s*:\s*")[^"]*')


def git(*args):
    return subprocess.run(('git',) + args, check=True, capture_output=True,
                          text=True, encoding='utf-8').stdout


def tracked_html():
    """追跡下の .html を列挙する。作業ツリーを走査すると node_modules 等まで拾う。"""
    return git('ls-files', '*.html').splitlines()


def last_human_commit(path):
    """bot のコミットを飛ばして、そのファイルを最後に触った日時を JST で返す。"""
    log = git('log', '--format=%cI\t%ae\t%ce', '--', path)
    for line in log.splitlines():
        iso, author, committer = line.split('\t')
        if author in BOT_EMAILS or committer in BOT_EMAILS:
            continue
        return datetime.fromisoformat(iso).astimezone(JST).isoformat()
    return None  # 未コミット、または bot のコミットしか無い


def update(path):
    # newline='' で読み書きする。既定だと読み込み時に CRLF が LF へ潰され、書き戻しで
    # ファイル全体が差分になる（ローカルの Windows で流したときに効く）。
    with open(path, encoding='utf-8', newline='') as f:
        original = f.read()
    if '"dateModified"' not in original:
        return None

    stamp = last_human_commit(path)
    if stamp is None:
        return None

    updated = LD_BLOCK.sub(
        lambda m: m[1] + DATE_FIELD.sub(lambda d: d[1] + stamp, m[2]) + m[3], original)
    if updated == original:
        return None
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(updated)
    return stamp


def main():
    updated = False
    for path in tracked_html():
        stamp = update(path)
        if stamp:
            updated = True
            print(f'updated {path} -> {stamp}')
    if not updated:
        print('dateModified: already up to date')
    return 0


if __name__ == '__main__':
    sys.exit(main())
