#!/usr/bin/env python3
"""日刊ブリーフの RSS 更新を WebSub の hub へ知らせる。

Google の sitemap ping は 2023 年に廃止され、ニュースの URL を API で登録する手段もない。
自動で「新しい号が出た」と伝えられるのは、RSS を WebSub の hub 経由で配ることだけ
（フィードには daily_engine.py が rel="hub" を載せている）。

hub は通知を受けるとフィードを取りに行くので、公開前に送ると古いフィードが配られる。
手元の rss.xml の先頭の号が本番のフィードに現れるのを待ってから送る。
どこで失敗しても警告だけ出して 0 で終える（後ろの X ポストを止めないため）。
"""

import argparse
import os
import re
import sys
import time
import urllib.parse
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
HTTP_TIMEOUT_SEC = 20
USER_AGENT = 'DailyBriefWebSubPing/1.0'


def log(message):
    print(message, flush=True)


def warn(message):
    print(f"::warning::{message}", flush=True)


def read_feed(media):
    """手元のフィードから、自身の URL・hub・先頭の号の URL を取り出す。"""
    path = os.path.join(REPO_ROOT, 'job', media, 'rss.xml')
    with open(path, encoding='utf-8') as f:
        body = f.read()
    self_url = re.search(r'<atom:link href="([^"]+)" rel="self"', body)
    hub_url = re.search(r'<atom:link href="([^"]+)" rel="hub"', body)
    first_guid = re.search(r'<guid[^>]*>([^<]+)</guid>', body)
    if not (self_url and hub_url and first_guid):
        return None
    return self_url[1], hub_url[1], first_guid[1]


def feed_has(feed_url, guid):
    req = urllib.request.Request(feed_url, method='GET')
    req.add_header('User-Agent', USER_AGENT)
    req.add_header('Cache-Control', 'no-cache')
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as res:
            if res.status != 200:
                return False
            body = res.read().decode('utf-8', 'replace')
    except Exception:
        return False
    return f'>{guid}</guid>' in body


def wait_for_feed(feed_url, guid, timeout_sec, interval_sec=15):
    if timeout_sec <= 0:
        return True
    deadline = time.time() + timeout_sec
    while True:
        if feed_has(feed_url, guid):
            return True
        if time.time() + interval_sec >= deadline:
            return False
        time.sleep(interval_sec)


def publish(hub_url, feed_url):
    data = urllib.parse.urlencode({'hub.mode': 'publish', 'hub.url': feed_url}).encode()
    req = urllib.request.Request(hub_url, data=data, method='POST')
    req.add_header('User-Agent', USER_AGENT)
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as res:
        return res.status


def main():
    parser = argparse.ArgumentParser(description='日刊ブリーフの RSS 更新を WebSub hub へ通知する')
    parser.add_argument('--media', required=True, choices=['nitoridaily', 'retailtechdaily'])
    parser.add_argument('--wait-sec', type=int, default=600, help='公開反映を待つ秒数（0 で待たない）')
    args = parser.parse_args()

    feed = read_feed(args.media)
    if feed is None:
        warn(f"{args.media}/rss.xml から self / hub / 号の URL を読み取れないため通知しません")
        return 0
    feed_url, hub_url, guid = feed
    log(f"=== WebSub: {feed_url} (最新 {guid}) -> {hub_url} ===")

    if not wait_for_feed(feed_url, guid, args.wait_sec):
        warn(f"本番のフィードに {guid} が現れないため通知しません（公開反映の遅れ）")
        return 0
    try:
        status = publish(hub_url, feed_url)
    except Exception as e:
        warn(f"hub への通知に失敗しました: {e}")
        return 0
    log(f" -> 通知しました (HTTP {status})")
    return 0


if __name__ == '__main__':
    sys.exit(main())
