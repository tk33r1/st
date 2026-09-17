#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""日刊ブリーフの新着号を公式 X アカウントへ自動ポストする。

`generate-*.py` の CONFIG（media_id / x_handle / share_prefix / x_hashtags）を
そのまま流用するため、アカウントや文言の正本は各メディアの設定側にある。

  python .github/scripts/post-to-x.py --media nitoridaily
  python .github/scripts/post-to-x.py --media retailtechdaily --dry-run

認証情報は環境変数から読む（メディア別を優先し、無ければ共通名）:
  X_NITORIDAILY_CONSUMER_KEY / _CONSUMER_SECRET / _ACCESS_TOKEN / _ACCESS_TOKEN_SECRET
  X_RETAILTECHDAILY_CONSUMER_KEY / ...
  X_CONSUMER_KEY / X_CONSUMER_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET
未設定のときは警告を出して正常終了する（シークレット未投入で日刊 CI を落とさない）。

ポスト成功時は該当号の JSON に x_post_id / x_posted_at を書き戻す。
これが二重ポストの抑止と、あとから投稿を辿るための記録を兼ねる。
"""

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from daily_engine import format_issue_date, load_json_list, write_json_atomic

JST = timezone(timedelta(hours=9))
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# メディア ID -> CONFIG を持つ生成スクリプト
MEDIA_MODULES = {
    'nitoridaily': 'generate-nitori-daily.py',
    'retailtechdaily': 'generate-retail-tech-daily.py',
}

TWEET_ENDPOINT = 'https://api.x.com/2/tweets'
ME_ENDPOINT = 'https://api.x.com/2/users/me'
HTTP_TIMEOUT_SEC = 30

# X の文字数カウント（twitter-text の weighted length 準拠）
TWEET_WEIGHT_LIMIT = 280
URL_WEIGHT = 23
# 重み 1 のコードポイント範囲。ここに含まれない文字（日本語など）は重み 2
LIGHT_RANGES = ((0, 4351), (8192, 8205), (8208, 8223), (8242, 8247))

URL_PATTERN = re.compile(r'https?://\S+')

NEWLINE = chr(10)
TAKEAWAY_LABEL = NEWLINE + '💡 要点: '


def log(message):
    print(message, flush=True)


def warn(message):
    """GitHub Actions のアノテーションとしても拾える形で警告を出す。"""
    print("::warning::" + message, flush=True)


def load_media_config(media_id):
    filename = MEDIA_MODULES.get(media_id)
    if not filename:
        raise SystemExit(f"未対応のメディアです: {media_id}")
    if SCRIPT_DIR not in sys.path:
        sys.path.insert(0, SCRIPT_DIR)
    spec = importlib.util.spec_from_file_location(f"media_{media_id}", os.path.join(SCRIPT_DIR, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CONFIG


def read_credentials(media_id):
    """メディア別シークレットを優先して OAuth 1.0a の4点セットを読む。"""
    prefix = f"X_{media_id.upper()}_"
    names = ('CONSUMER_KEY', 'CONSUMER_SECRET', 'ACCESS_TOKEN', 'ACCESS_TOKEN_SECRET')
    creds = {}
    for name in names:
        creds[name.lower()] = os.environ.get(prefix + name, '').strip() or os.environ.get('X_' + name, '').strip()
    missing = [n for n in names if not creds[n.lower()]]
    return creds, missing


# ---------------------------------------------------------------- 本文の組み立て

def weighted_length(text):
    total = 0
    for ch in text:
        cp = ord(ch)
        total += 1 if any(lo <= cp <= hi for lo, hi in LIGHT_RANGES) else 2
    return total


def post_weighted_length(text):
    """URL は実長ではなく一律 23 として数える、X 側と同じ数え方。"""
    total = 0
    last = 0
    for m in URL_PATTERN.finditer(text):
        total += weighted_length(text[last:m.start()]) + URL_WEIGHT
        last = m.end()
    return total + weighted_length(text[last:])


def truncate_weighted(text, budget):
    """weighted length が budget を超えないよう末尾を省略記号で詰める。"""
    if budget <= 0:
        return ''
    if weighted_length(text) <= budget:
        return text
    ellipsis = '…'
    room = budget - weighted_length(ellipsis)
    if room <= 0:
        return ellipsis
    out = []
    used = 0
    for ch in text:
        w = weighted_length(ch)
        if used + w > room:
            break
        out.append(ch)
        used += w
    return ''.join(out).rstrip('、。 　') + ellipsis


def issue_takeaway(issue):
    """要点に使う1文。executive_summary の先頭、無ければ summary。"""
    for candidate in (issue.get('executive_summary') or []):
        text = re.sub(r'\s+', ' ', str(candidate or '')).strip()
        if text:
            return text
    return re.sub(r'\s+', ' ', str(issue.get('summary') or '')).strip()


def issue_url(config, date_key):
    return f"https://tk.st/job/{config['media_id']}/{date_key}/"


def build_post_text(config, issue, url):
    """サイトのシェア文（daily-ui.js の shareText）と同じ体裁に揃える。"""
    head = f"{config.get('share_prefix', '')}{format_issue_date(issue['date'])}号"
    hashtags = ' '.join(str(t).strip() for t in (config.get('x_hashtags') or []) if str(t).strip())
    tail = NEWLINE + '🔗 ' + url + ((NEWLINE + hashtags) if hashtags else '')
    # URL は実長ではなく一律 23 として数えられる
    fixed = weighted_length(head) + weighted_length(TAKEAWAY_LABEL)
    fixed += weighted_length(tail) - weighted_length(url) + URL_WEIGHT
    takeaway = truncate_weighted(issue_takeaway(issue), TWEET_WEIGHT_LIMIT - fixed)
    body = (TAKEAWAY_LABEL + takeaway) if takeaway else ''
    return head + body + tail


# ---------------------------------------------------------------- X API 呼び出し

def percent_encode(value):
    return urllib.parse.quote(str(value), safe='-._~')


def oauth_header(method, url, creds):
    """OAuth 1.0a (HMAC-SHA1) の Authorization ヘッダを組む。

    本文は JSON で送る（form-encoded ではない）ため、署名対象はクエリ文字列と
    oauth_* パラメータのみでよい。
    """
    oauth_params = {
        'oauth_consumer_key': creds['consumer_key'],
        'oauth_nonce': secrets.token_hex(16),
        'oauth_signature_method': 'HMAC-SHA1',
        'oauth_timestamp': str(int(time.time())),
        'oauth_token': creds['access_token'],
        'oauth_version': '1.0',
    }
    parsed = urllib.parse.urlsplit(url)
    base_params = dict(oauth_params)
    base_params.update(dict(urllib.parse.parse_qsl(parsed.query)))
    base_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', ''))
    encoded = sorted((percent_encode(k), percent_encode(v)) for k, v in base_params.items())
    param_string = '&'.join(f"{k}={v}" for k, v in encoded)
    base_string = '&'.join([method.upper(), percent_encode(base_url), percent_encode(param_string)])
    signing_key = f"{percent_encode(creds['consumer_secret'])}&{percent_encode(creds['access_token_secret'])}"
    signature = hmac.new(signing_key.encode('utf-8'), base_string.encode('utf-8'), hashlib.sha1).digest()
    oauth_params['oauth_signature'] = base64.b64encode(signature).decode('ascii')
    return 'OAuth ' + ', '.join(f'{percent_encode(k)}="{percent_encode(v)}"' for k, v in sorted(oauth_params.items()))


def call_x_api(method, url, creds, payload=None):
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', oauth_header(method, url, creds))
    req.add_header('User-Agent', 'DailyBriefXPoster/1.0')
    if data is not None:
        req.add_header('Content-Type', 'application/json; charset=UTF-8')
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as res:
        return json.loads(res.read().decode('utf-8'))


def http_error_detail(e):
    try:
        return f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:500]}"
    except Exception:
        return f"HTTP {e.code}"


def verify_account(creds, expected_handle):
    """取り違え防止。想定と違うアカウントなら False（確認できない場合は続行）。"""
    expected = str(expected_handle or '').lstrip('@').lower()
    if not expected:
        return True
    try:
        me = call_x_api('GET', ME_ENDPOINT, creds)
    except urllib.error.HTTPError as e:
        warn(f"アカウント確認をスキップします（{http_error_detail(e)}）")
        return True
    except Exception as e:
        warn(f"アカウント確認をスキップします（{e}）")
        return True
    username = str((me.get('data') or {}).get('username') or '')
    if username.lower() != expected:
        print(f"[ERROR] 認証アカウント @{username} が想定の @{expected} と一致しません。", file=sys.stderr)
        return False
    log(f" -> 認証アカウント確認: @{username}")
    return True


def page_is_live(url):
    """号ページが公開反映済みか確かめる。

    未知パスにもトップページが 200 で返るホスティングなので、ステータスだけでは
    判定できない。canonical が対象 URL を指しているかどうかで見る。
    """
    req = urllib.request.Request(url, method='GET')
    req.add_header('User-Agent', 'DailyBriefXPoster/1.0')
    req.add_header('Cache-Control', 'no-cache')
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as res:
            if res.status != 200:
                return False
            body = res.read().decode('utf-8', 'replace')
    except Exception:
        return False
    return f'rel="canonical" href="{url}"' in body


def wait_for_page(url, timeout_sec, interval_sec=15):
    """OGP カードを取得させたいので、公開反映を待ってからポストする。"""
    if timeout_sec <= 0:
        return True
    deadline = time.time() + timeout_sec
    while True:
        if page_is_live(url):
            return True
        if time.time() + interval_sec >= deadline:
            return False
        time.sleep(interval_sec)


# ---------------------------------------------------------------- エントリーポイント

def main():
    parser = argparse.ArgumentParser(description='日刊ブリーフの新着号を X へポストする')
    parser.add_argument('--media', required=True, choices=sorted(MEDIA_MODULES), help='対象メディア')
    parser.add_argument('--date', default='', help='対象号 (YYYYMMDD)。省略時は最新号')
    parser.add_argument('--dry-run', action='store_true', help='本文を表示するだけでポストしない')
    parser.add_argument('--force', action='store_true', help='ポスト済みでも再ポストする')
    parser.add_argument('--wait-sec', type=int, default=300, help='公開反映を待つ秒数（0 で待たない）')
    args = parser.parse_args()

    config = load_media_config(args.media)
    data_json_path = config['data_json_path']
    history = load_json_list(data_json_path)
    if not history:
        raise SystemExit(f"号が1件もありません: {data_json_path}")

    if args.date:
        issue = next((i for i in history if i.get('date') == args.date), None)
        if issue is None:
            raise SystemExit(f"{args.date} 号が {data_json_path} に見つかりません。")
    else:
        issue = max(history, key=lambda i: str(i.get('date') or ''))

    handle = str(config.get('x_handle') or '').lstrip('@')
    date_key = issue['date']
    url = issue_url(config, date_key)
    log(f"=== X ポスト: {config['media_name']} {date_key}号 -> @{handle} ===")

    if issue.get('x_post_id') and not args.force:
        log(f" -> ポスト済みのためスキップします (post_id={issue['x_post_id']})")
        return

    text = build_post_text(config, issue, url)
    log(f"--- 本文 ({post_weighted_length(text)} / {TWEET_WEIGHT_LIMIT}) ---")
    log(text)
    log('---')

    if args.dry_run:
        log(' -> dry-run のためポストしません')
        return

    creds, missing = read_credentials(args.media)
    if missing:
        warn(f"{args.media} の X 認証情報が未設定のためポストをスキップします（不足: {', '.join(missing)}）")
        return

    if not wait_for_page(url, args.wait_sec):
        warn(f"公開反映を確認できませんでした（{url}）。カードが出ない可能性がありますがポストは続行します。")

    if not verify_account(creds, handle):
        raise SystemExit(1)

    try:
        result = call_x_api('POST', TWEET_ENDPOINT, creds, {'text': text})
    except urllib.error.HTTPError as e:
        raise SystemExit(f"ポストに失敗しました: {http_error_detail(e)}") from e

    post_id = str((result.get('data') or {}).get('id') or '')
    if not post_id:
        raise SystemExit(f"ポスト応答に id がありません: {json.dumps(result, ensure_ascii=False)[:300]}")

    issue['x_post_id'] = post_id
    issue['x_posted_at'] = datetime.now(JST).isoformat(timespec='seconds')
    write_json_atomic(data_json_path, history, indent=2)
    log(f" -> ポスト完了: https://x.com/{handle}/status/{post_id}")


if __name__ == '__main__':
    main()
