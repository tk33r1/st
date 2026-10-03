#!/usr/bin/env python3
"""MAGI の人格カードの素材にする、本人（@Tah_Keh）の X の投稿を X API で取り込む。

いまは本人確認（--check）だけを持つ。@Tah_Keh のアクセストークンが、どのアプリの鍵（Consumer Key）と
組めば通るか、通ったときに本人として認証されるかを、値を出さずに確かめる。

  python .github/scripts/magi-x-posts.py --check

認証は OAuth 1.0a（ユーザーとして署名する）。本人の投稿を本人として読むと「Owned Read」の単価になる。
環境変数:
  X_TAHKEH_ACCESS_TOKEN / X_TAHKEH_ACCESS_TOKEN_SECRET   … @Tah_Keh のトークン
  アプリの鍵は、次のうち設定されているものを順に試す:
    X_TAHKEH_CONSUMER_KEY / X_TAHKEH_CONSUMER_SECRET
    X_NITORIDAILY_CONSUMER_KEY / X_NITORIDAILY_CONSUMER_SECRET
    X_RETAILTECHDAILY_CONSUMER_KEY / X_RETAILTECHDAILY_CONSUMER_SECRET
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.x.com/2'
EXPECTED_HANDLE = 'Tah_Keh'
CONSUMER_SOURCES = ('X_TAHKEH', 'X_NITORIDAILY', 'X_RETAILTECHDAILY')
HTTP_TIMEOUT_SEC = 30


def percent_encode(value):
    return urllib.parse.quote(str(value), safe='-._~')


def oauth_header(method, url, query, creds):
    """OAuth 1.0a（HMAC-SHA1）の Authorization ヘッダ。GET のクエリも署名に含める。"""
    oauth = {
        'oauth_consumer_key': creds['consumer_key'],
        'oauth_nonce': secrets.token_hex(16),
        'oauth_signature_method': 'HMAC-SHA1',
        'oauth_timestamp': str(int(time.time())),
        'oauth_token': creds['access_token'],
        'oauth_version': '1.0',
    }
    params = {**oauth, **query}
    param_str = '&'.join(f'{percent_encode(k)}={percent_encode(v)}' for k, v in sorted(params.items()))
    base = '&'.join([method.upper(), percent_encode(url), percent_encode(param_str)])
    key = f"{percent_encode(creds['consumer_secret'])}&{percent_encode(creds['access_token_secret'])}"
    oauth['oauth_signature'] = base64.b64encode(hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()).decode()
    return 'OAuth ' + ', '.join(f'{percent_encode(k)}="{percent_encode(v)}"' for k, v in sorted(oauth.items()))


def api_get(path, query, creds):
    """GET して (HTTP ステータス, JSON または本文の先頭) を返す。例外は投げない。"""
    url = f'{API}{path}'
    full = url + ('?' + urllib.parse.urlencode(query) if query else '')
    req = urllib.request.Request(full, headers={'Authorization': oauth_header('GET', url, query, creds)})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as res:
            return res.status, json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, body[:300]
    except (OSError, ValueError) as e:
        return 0, f'{type(e).__name__}: {e}'


def credential_sets():
    """@Tah_Keh のトークンと、設定済みのアプリの鍵の組み合わせを返す。値そのものは表に出さない。"""
    token = os.environ.get('X_TAHKEH_ACCESS_TOKEN', '').strip()
    token_secret = os.environ.get('X_TAHKEH_ACCESS_TOKEN_SECRET', '').strip()
    if not token or not token_secret:
        sys.exit('X_TAHKEH_ACCESS_TOKEN / X_TAHKEH_ACCESS_TOKEN_SECRET が未設定')
    sets = []
    for src in CONSUMER_SOURCES:
        key = os.environ.get(f'{src}_CONSUMER_KEY', '').strip()
        sec = os.environ.get(f'{src}_CONSUMER_SECRET', '').strip()
        if key and sec:
            sets.append((src, {'consumer_key': key, 'consumer_secret': sec,
                               'access_token': token, 'access_token_secret': token_secret}))
    if not sets:
        sys.exit('アプリの鍵（X_*_CONSUMER_KEY / _SECRET）が1組も設定されていない')
    return sets


def summarize_error(body):
    if isinstance(body, dict):
        parts = [str(body.get(k)) for k in ('title', 'detail', 'type') if body.get(k)]
        errs = body.get('errors')
        if errs and isinstance(errs, list):
            parts += [str(e.get('message') or e.get('detail') or e)[:120] for e in errs[:2]]
        return ' / '.join(parts)[:300] or json.dumps(body)[:300]
    return str(body)[:300]


def check():
    """各アプリの鍵と組んで、本人として認証できるかを確かめる（/2/users/me）。"""
    # トークンの持ち主のユーザー ID はトークンの先頭（"数字-…"）に入っている。値は出さず、一致だけ見る
    token = os.environ.get('X_TAHKEH_ACCESS_TOKEN', '').strip()
    print(f'トークン: {len(token)} 文字、ユーザー ID の形 = {token.split("-", 1)[0].isdigit()}')
    ok = None
    for src, creds in credential_sets():
        status, body = api_get('/users/me', {}, creds)
        if status == 200 and isinstance(body, dict) and body.get('data'):
            user = body['data']
            same = user.get('username', '').lower() == EXPECTED_HANDLE.lower()
            print(f'{src} の鍵と組んで: 認証できた → @{user.get("username")}（id {user.get("id")}）'
                  f'{"" if same else "  ※ @" + EXPECTED_HANDLE + " ではない"}')
            ok = ok or (src if same else None)
        else:
            print(f'{src} の鍵と組んで: HTTP {status} — {summarize_error(body)}')
    if ok:
        print(f'結論: @{EXPECTED_HANDLE} として {ok} のアプリの鍵で認証できる')
    else:
        print('結論: どの鍵とも本人として認証できなかった（上の HTTP ステータスと理由を参照）')
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true', help='本人として認証できるかだけを確かめる')
    args = ap.parse_args()
    if args.check:
        check()
    else:
        ap.print_help()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
