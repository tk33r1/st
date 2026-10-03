#!/usr/bin/env python3
"""MAGI の人格カードの素材にする、本人（@Tah_Keh）の X の投稿を X API で取り込む。

本人確認（--check）と、投稿の取り込み（--fetch）を持つ。取り込んだ投稿は .github/magi/x-posts.json に保存する。@Tah_Keh のアクセストークンが、どのアプリの鍵（Consumer Key）と
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
import re
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


def app_bearer_check(src):
    """アプリの鍵だけでアプリ用のトークン（Bearer）を取り、公開情報を1件読む。トークン（ユーザー）側と切り分けるため。"""
    key = os.environ.get(f'{src}_CONSUMER_KEY', '').strip()
    sec = os.environ.get(f'{src}_CONSUMER_SECRET', '').strip()
    basic = base64.b64encode(f'{percent_encode(key)}:{percent_encode(sec)}'.encode()).decode()
    req = urllib.request.Request('https://api.x.com/oauth2/token', data=b'grant_type=client_credentials',
                                 headers={'Authorization': f'Basic {basic}',
                                          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as res:
            bearer = json.loads(res.read().decode('utf-8')).get('access_token')
    except urllib.error.HTTPError as e:
        print(f'{src} のアプリ用トークンの発行: HTTP {e.code} — {e.read().decode("utf-8", errors="replace")[:200]}')
        return
    req = urllib.request.Request(f'{API}/users/by/username/{EXPECTED_HANDLE}', headers={'Authorization': f'Bearer {bearer}'})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as res:
            data = json.loads(res.read().decode('utf-8')).get('data', {})
            print(f'{src} のアプリ用トークンで: 読めた → @{data.get("username")}（アプリはプロジェクトに入っている）')
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            pass
        print(f'{src} のアプリ用トークンで: HTTP {e.code} — {summarize_error(body)}')


def check():
    """各アプリの鍵と組んで、本人として認証できるかを確かめる（/2/users/me）。"""
    key = os.environ.get('X_TAHKEH_CONSUMER_KEY', '').strip()
    if key:
        # 画面に出ている API Key と見比べるための末尾4文字（API Key は通信のたびに平文で送る値。Secret は出さない）
        print(f'X_TAHKEH の API Key: {len(key)} 文字、末尾 …{key[-4:]}')
        app_bearer_check('X_TAHKEH')
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


# ---------------------------------------------------------------- 取り込み

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'magi', 'x-posts.json')
PAGE_SIZE = 100          # 1回の取得の上限（X の仕様）
MAX_POSTS_PER_RUN = 4000  # 1回の実行で読む上限。本人の読み取りは $0.001／件なので最大 $4 の安全弁
TWEET_FIELDS = 'created_at,public_metrics,referenced_tweets,in_reply_to_user_id,note_tweet,lang'


def own_credentials():
    for src, creds in credential_sets():
        if src == 'X_TAHKEH':
            return creds
    sys.exit('X_TAHKEH_CONSUMER_KEY / _SECRET が未設定（本人の投稿は本人のアプリの鍵で読む）')


def clean_text(t, own_handle):
    """他人のアカウント名を伏せる（ファイルは GitHub で公開されるため）。本人のものは残す。"""
    return re.sub(r'@(\w{1,15})', lambda m: m.group(0) if m.group(1).lower() == own_handle.lower() else '@user', t).strip()


def to_record(tw, own_handle):
    refs = {r.get('type') for r in tw.get('referenced_tweets', [])}
    text = (tw.get('note_tweet') or {}).get('text') or tw.get('text', '')
    # 返信の頭に並ぶ宛先（@a @b …）は本文ではないので落とす
    if 'replied_to' in refs:
        text = re.sub(r'^(@\w{1,15}\s+)+', '', text)
    m = tw.get('public_metrics', {})
    return {
        'id': tw['id'],
        'created_at': tw.get('created_at'),
        'kind': 'reply' if 'replied_to' in refs else 'quote' if 'quoted' in refs else 'post',
        'text': clean_text(text, own_handle),
        'likes': m.get('like_count', 0),
        'reposts': m.get('retweet_count', 0),
    }


def fetch():
    """本人の投稿（リポストを除く）を新しい順に読み、前回より新しい分を x-posts.json に足す。"""
    creds = own_credentials()
    status, me = api_get('/users/me', {}, creds)
    if status != 200:
        sys.exit(f'本人の情報を取れなかった: HTTP {status} — {summarize_error(me)}')
    user_id, handle = me['data']['id'], me['data']['username']

    try:
        with open(OUT_PATH, encoding='utf-8') as f:
            saved = json.load(f)
    except FileNotFoundError:
        saved = {'posts': []}
    known = {p['id'] for p in saved['posts']}
    newest = max((int(p['id']) for p in saved['posts']), default=0)

    query = {'max_results': str(PAGE_SIZE), 'exclude': 'retweets', 'tweet.fields': TWEET_FIELDS}
    if newest:
        query['since_id'] = str(newest)  # 2回目以降は、前回より新しい分だけを読む（読んだ件数だけ課金される）
    added, read, pages = [], 0, 0
    while read < MAX_POSTS_PER_RUN:
        status, body = api_get(f'/users/{user_id}/tweets', query, creds)
        if status != 200:
            sys.exit(f'投稿を読めなかった（{pages + 1} ページ目）: HTTP {status} — {summarize_error(body)}')
        pages += 1
        tweets = body.get('data', [])
        read += len(tweets)
        added += [to_record(t, handle) for t in tweets if t['id'] not in known]
        token = body.get('meta', {}).get('next_token')
        if not token or not tweets:
            break
        query['pagination_token'] = token

    posts = sorted(saved['posts'] + added, key=lambda p: int(p['id']), reverse=True)
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({
            'note': '本人（@' + handle + '）の X の投稿。MAGI の人格カードの素材（.github/scripts/magi-x-posts.py が書く。手で編集しない）。'
                    '他人のアカウント名は @user に伏せてある',
            'handle': handle,
            'posts': posts,
        }, f, ensure_ascii=False, indent=1)
        f.write('\n')
    kinds = {k: sum(1 for p in posts if p['kind'] == k) for k in ('post', 'reply', 'quote')}
    span = (posts[-1]['created_at'][:10], posts[0]['created_at'][:10]) if posts else ('-', '-')
    print(f'読んだ件数: {read}（{pages} ページ、本人の読み取りなら約 ${read * 0.001:.2f}）')
    print(f'新しく足した件数: {len(added)} ／ 保存の合計: {len(posts)}（投稿 {kinds["post"]}・返信 {kinds["reply"]}・引用 {kinds["quote"]}）')
    print(f'期間: {span[0]} 〜 {span[1]}')
    if read >= MAX_POSTS_PER_RUN:
        print(f'::warning::1回の上限（{MAX_POSTS_PER_RUN} 件）で止めた。続きは次の実行で読む')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true', help='本人として認証できるかだけを確かめる')
    ap.add_argument('--fetch', action='store_true', help='本人の投稿を読み、前回より新しい分を保存する')
    args = ap.parse_args()
    if args.check:
        check()
    elif args.fetch:
        fetch()
    else:
        ap.print_help()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
