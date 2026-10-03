#!/usr/bin/env python3
"""MAGI の人格カードの素材にする、本人（@Tah_Keh）の X の投稿を X API で取り込む。

  --check      本人として認証できるかを、値を出さずに確かめる
  --fetch      本人の投稿（リポストを除く）のうち前回より新しい分を読み、.github/magi/x-posts.json に足す
  --interests  本人のいいね（最大 MAX_LIKES 件）とフォローを読み、関心を分野ごとに要約して
               .github/magi/x-interests.json に書く。中身は他人の投稿とアカウントなので、生のデータは保存しない
               （公開の GitHub に他人の投稿をまとめて置かないため）。要約に一般の個人の名前は書かせない

  python .github/scripts/magi-x-posts.py --check

認証は OAuth 1.0a（ユーザーとして署名する）。本人の投稿を本人として読むと「Owned Read」の単価になる。
環境変数（リポジトリ Secrets）:
  X_TAHKEH_CONSUMER_KEY / X_TAHKEH_CONSUMER_SECRET       … 本人のアプリの鍵（Pay Per Use のプロジェクトに入れておく）
  X_TAHKEH_ACCESS_TOKEN / X_TAHKEH_ACCESS_TOKEN_SECRET   … @Tah_Keh のトークン
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
HTTP_TIMEOUT_SEC = 30
RATE_LIMIT_RETRIES = 2
RATE_LIMIT_MAX_WAIT_SEC = 16 * 60


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
    """GET して (HTTP ステータス, JSON または本文の先頭) を返す。例外は投げない。
    429（15分ごとの回数制限）は、制限が解ける時刻（x-rate-limit-reset）まで待って出し直す。
    いいねは15分に75回（7,500件）までで、続けて実行すると2回目が途中で引っかかる。"""
    url = f'{API}{path}'
    full = url + ('?' + urllib.parse.urlencode(query) if query else '')
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        req = urllib.request.Request(full, headers={'Authorization': oauth_header('GET', url, query, creds)})
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as res:
                return res.status, json.loads(res.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')
            if e.code == 429 and attempt < RATE_LIMIT_RETRIES:
                reset = e.headers.get('x-rate-limit-reset', '')
                wait = int(reset) - int(time.time()) + 5 if reset.isdigit() else 60
                wait = min(max(wait, 5), RATE_LIMIT_MAX_WAIT_SEC)
                print(f'回数制限に当たった。{wait} 秒待って出し直す（{path}）', flush=True)
                time.sleep(wait)
                continue
            try:
                return e.code, json.loads(body)
            except json.JSONDecodeError:
                return e.code, body[:300]
        except (OSError, ValueError) as e:
            return 0, f'{type(e).__name__}: {e}'


def own_credentials():
    """本人（@Tah_Keh）のトークンと、本人のアプリの鍵。値そのものは表に出さない。"""
    names = ('X_TAHKEH_CONSUMER_KEY', 'X_TAHKEH_CONSUMER_SECRET', 'X_TAHKEH_ACCESS_TOKEN', 'X_TAHKEH_ACCESS_TOKEN_SECRET')
    values = [os.environ.get(n, '').strip() for n in names]
    missing = [n for n, v in zip(names, values) if not v]
    if missing:
        sys.exit('未設定: ' + ', '.join(missing))
    return dict(zip(('consumer_key', 'consumer_secret', 'access_token', 'access_token_secret'), values))


def summarize_error(body):
    if isinstance(body, dict):
        parts = [str(body.get(k)) for k in ('title', 'detail', 'type') if body.get(k)]
        errs = body.get('errors')
        if errs and isinstance(errs, list):
            parts += [str(e.get('message') or e.get('detail') or e)[:120] for e in errs[:2]]
        return ' / '.join(parts)[:300] or json.dumps(body)[:300]
    return str(body)[:300]


def check():
    """本人として認証できるかを確かめる（/2/users/me）。"""
    status, body = api_get('/users/me', {}, own_credentials())
    user = body.get('data') if status == 200 and isinstance(body, dict) else None
    if not user:
        # 403（client-forbidden）は、アプリが Pay Per Use のプロジェクトに入っていないとき
        sys.exit(f'認証できなかった: HTTP {status} — {summarize_error(body)}')
    if user.get('username', '').lower() != EXPECTED_HANDLE.lower():
        sys.exit(f"@{user.get('username')} として認証された（@{EXPECTED_HANDLE} のトークンではない）")
    print(f"@{EXPECTED_HANDLE} として認証できた（id {user.get('id')}）")


# ---------------------------------------------------------------- 取り込み

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'magi', 'x-posts.json')
PAGE_SIZE = 100          # 1回の取得の上限（X の仕様）
MAX_POSTS_PER_RUN = 4000  # 1回の実行で読む上限。本人の読み取りは $0.001／件なので最大 $4 の安全弁
TWEET_FIELDS = 'created_at,public_metrics,referenced_tweets,in_reply_to_user_id,note_tweet,lang'


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


# ---------------------------------------------------------------- いいねとフォロー（要約だけを保存）

INTERESTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'magi', 'x-interests.json')
MAX_LIKES = 5000          # 1回の実行で読むいいねの上限（本人の読み取りは $0.001／件なので最大 $5）
MAX_FOLLOWING = 3000
LIKES_PER_CHUNK = 250     # 要約は分けて行い（いいねが多いと1回の入力に収まらない）、最後にまとめる
LIKE_TEXT_MAX = 160       # 1件あたりの本文の上限（要約の入力を抑える）

AREAS = [  # (見出し, JSON のキー, 中身)
    ('熱量', 'melchior', '音楽・DJ・バイク・アイドル・ゲーム・食や酒など、好きで熱くなるもの（MELCHIOR-1 の素材）'),
    ('思索', 'balthasar', '人・生き方・死生観・社会・心に響いた言葉など、人間についての関心（BALTHASAR-2 の素材）'),
    ('戦略', 'casper', '技術・AI・仕事・小売・マーケティング・お金・制度など、判断や最適化の関心（CASPER-3 の素材）'),
    ('全体', 'synth', '分野をまたいだ全体の傾向、笑いのツボ、何に共感しやすく何に反発しやすいか（統合人格の素材）'),
]
NAME_RULE = ('一般の個人の名前・あだ名・アカウント名は書かない（有名人・アーティスト・作家・ブランド・作品・番組の名前は書いてよい）。'
             '投稿の文をそのまま引用しない。')


def paged_get(path, query, creds, limit, label):
    """ページを送りながら data を集める（最大 limit 件）。読んだ件数だけ課金される。"""
    items, q = [], dict(query)
    while len(items) < limit:
        status, body = api_get(path, q, creds)
        if status != 200:
            sys.exit(f'{label}を読めなかった: HTTP {status} — {summarize_error(body)}')
        items += body.get('data', [])
        token = body.get('meta', {}).get('next_token')
        if not token or not body.get('data'):
            break
        q['pagination_token'] = token
    return items[:limit]


def load_magi_context():
    """要約の呼び出しは magi-context.py のもの（モデル ID の正本・再試行・途中切れの検出）を使う。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location('magi_context', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'magi-context.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def interests():
    creds = own_credentials()
    api_key = os.environ.get('OPENAI_API_KEY', '').strip()
    if not api_key:
        sys.exit('OPENAI_API_KEY が未設定（関心の要約に使う）')
    mc = load_magi_context()
    status, me = api_get('/users/me', {}, creds)
    if status != 200:
        sys.exit(f'本人の情報を取れなかった: HTTP {status} — {summarize_error(me)}')
    user_id = me['data']['id']

    likes = paged_get(f'/users/{user_id}/liked_tweets', {'max_results': '100', 'tweet.fields': 'created_at,note_tweet,lang'},
                      creds, MAX_LIKES, 'いいね')
    following = paged_get(f'/users/{user_id}/following', {'max_results': '1000', 'user.fields': 'description'},
                          creds, MAX_FOLLOWING, 'フォロー')
    print(f'読んだ件数: いいね {len(likes)}・フォロー {len(following)}（本人の読み取りなら約 ${(len(likes) + len(following)) * 0.001:.2f}）')

    areas_text = '\n'.join(f'- {h}: {d}' for h, _, d in AREAS)
    notes = []
    # 1) いいねを分けて要約する（他人の投稿なので、本人が何に響いたかだけを書かせる）
    for i in range(0, len(likes), LIKES_PER_CHUNK):
        chunk = likes[i:i + LIKES_PER_CHUNK]
        lines = '\n'.join('- ' + re.sub(r'\s+', ' ', (t.get('note_tweet') or {}).get('text') or t.get('text', ''))[:LIKE_TEXT_MAX] for t in chunk)
        system = ('あなたは、ある人物（Shinya Takeda）が X で「いいね」した他人の投稿から、本人が何に関心を持ち、'
                  '何に共感し、何を面白がるかを読み取る分析者。次の分野ごとに、読み取れた傾向を箇条書きで書く。'
                  f'\n{areas_text}\n各分野は最大6行。読み取れない分野は「なし」。{NAME_RULE}')
        notes.append(mc.call_openai(api_key, system, f'【いいねした投稿（{i + 1}〜{i + len(chunk)} 件目、新しい順）】\n{lines}'))
        print(f'いいねの要約 {i // LIKES_PER_CHUNK + 1}: {len(notes[-1])} 字')
    # 2) フォローしているアカウント（名前と自己紹介）から、関心の地図を作る
    if following:
        one_line = lambda s: re.sub(r'\s+', ' ', s or '')[:120]
        lines = '\n'.join('- ' + u.get('name', '') + ': ' + one_line(u.get('description')) for u in following)
        system = ('あなたは、ある人物（Shinya Takeda）が X でフォローしているアカウントの一覧から、本人の関心の地図を読み取る分析者。'
                  f'次の分野ごとに、どんな種類のアカウントを追っているかを箇条書きで書く。\n{areas_text}\n各分野は最大6行。{NAME_RULE}')
        notes.append(mc.call_openai(api_key, system, f'【フォローしているアカウント（{len(following)} 件）】\n{lines}'))
        print(f'フォローの要約: {len(notes[-1])} 字')
    # 3) まとめる。分野ごとに、人格カードの素材として渡せる形にする
    heads = '\n'.join(f'## {key}\n（{d}）' for _, key, d in AREAS)
    system = ('あなたは、ある人物（Shinya Takeda）の X のいいねとフォローから読み取った関心のメモを、分野ごとに1つにまとめる編集者。'
              f'次の見出しをこの順にそのまま使い、各見出しの下に「- 」で始まる箇条書きを5〜8行書く（重複はまとめ、よく出る傾向を先に）。\n{heads}\n'
              f'見出しと箇条書き以外は書かない。{NAME_RULE}')
    merged = mc.call_openai(api_key, system, '\n\n'.join(f'【メモ {n + 1}】\n{t}' for n, t in enumerate(notes)))
    areas = {}
    for _, key, _ in AREAS:
        m = re.search(rf'^##\s*{key}\s*$(.*?)(?=^##\s|\Z)', merged, re.M | re.S)
        body = (m.group(1) if m else '').strip()
        body = '\n'.join(l for l in body.splitlines() if l.strip().startswith('-'))
        if not body:
            sys.exit(f'まとめに「{key}」の分野が無かった。まとめの出力: {merged[:300]}')
        areas[key] = body
    from datetime import datetime, timedelta, timezone
    os.makedirs(os.path.dirname(INTERESTS_PATH), exist_ok=True)
    with open(INTERESTS_PATH, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({
            'note': '本人の X のいいねとフォローから読み取った関心の要約（.github/scripts/magi-x-posts.py --interests が書く。手で編集しない）。'
                    '他人の投稿やアカウントの生のデータは保存していない',
            'updated_at': datetime.now(timezone(timedelta(hours=9))).isoformat(timespec='seconds'),
            'counts': {'likes': len(likes), 'following': len(following)},
            'areas': areas,
        }, f, ensure_ascii=False, indent=2)
        f.write('\n')
    for key, body in areas.items():
        print(f'--- {key}（{len(body)} 字）\n{body}\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true', help='本人として認証できるかだけを確かめる')
    ap.add_argument('--fetch', action='store_true', help='本人の投稿を読み、前回より新しい分を保存する')
    ap.add_argument('--interests', action='store_true', help='いいねとフォローを読み、関心を分野ごとに要約して保存する')
    args = ap.parse_args()
    if args.check:
        check()
    elif args.fetch:
        fetch()
    elif args.interests:
        interests()
    else:
        ap.print_help()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
