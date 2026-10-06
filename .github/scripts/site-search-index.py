#!/usr/bin/env python3
"""公開HTMLの検索用メタデータを生成する。本文・スクリプトは索引に入れない。"""
import argparse
import fnmatch
import json
import re
import string
import subprocess
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit

REPO = Path(__file__).resolve().parents[2]
# 主な入口は 404.html の常設入口（data-entry）が正本。ID（page:<data-entry>）・日英の名前と説明をそこから取り、
# 索引では hub: true を付ける。常設入口は noindex でも載せる（お問い合わせは noindex だが、連絡先を聞かれたら案内したい）。
# それ以外の noindex のページは載せない。
# 載せないページ。MAGI のアプリ（PWA）の本体は、トップページと MAGI の入口から案内すれば足りる
EXCLUDE = {'/magi-app/www/'}
# Worker（workers/magi2/site-search.js の makeSitePages）の検査と同じ上限。合わない行があればビルドを止める
KINDS = ('tool', 'game', 'article', 'page')
LIMITS = {'id': 240, 'title': 160, 'description': 320, 'detail': 640}
# 404 の Jev の検索（②）に渡す項目（assets/site-search-design.md 4章）。Worker の makeSitePages と同じ上限。
# Jev に渡す1件は400文字まで。説明は Worker が切るが、それ以外（種類・題名・タグ・カテゴリー・ジャンル）だけで超える行は
# 元の JSON を直すよう、ここでビルドを止める。
RANK_FIELDS = {'tool': ('rank_title', 'tags', 'category'), 'game': ('rank_title', 'genre'), 'article': ('rank_title', 'tags')}
RANK_LIMITS = {'rank_title': 160, 'tags': 12, 'tag': 40, 'category': 40, 'genre': 40, 'candidate': 400}
URL_CHARS = set(string.ascii_letters + string.digits + "-._~!$&'()*+,;=:@/%")
URL_SAFE = "/-._~!$&'()*+,;=:@"


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.canonical = None
        self.title = ''
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): v or '' for k, v in attrs}
        if tag == 'title':
            self.in_title = True
        if tag == 'meta':
            key = (a.get('name') or a.get('property') or a.get('http-equiv', '')).lower()
            self.meta.setdefault(key, []).append(a.get('content', ''))
        if tag == 'link' and 'canonical' in a.get('rel', '').lower().split():
            self.canonical = a.get('href')

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title += data


class Entries(HTMLParser):
    """404.html の常設入口（data-entry を持つリンク）を href ごとに集める。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.entries = {}

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): v or '' for k, v in attrs}
        if a.get('data-entry') and a.get('href', '').startswith('/'):
            self.entries[a['href']] = a


def hub_entries(root):
    parsed = Entries()
    parsed.feed((root / '404.html').read_text(encoding='utf-8'))
    if not parsed.entries:
        raise ValueError('404.html に data-entry の常設入口が無い')
    return parsed.entries


def validate(pages):
    """Worker と同じ条件で全行を確かめる。Worker は合わない行を黙って飛ばすので、ここで止めて気づけるようにする。"""
    hex_digits = set(string.hexdigits)
    ids, urls, errors = set(), set(), []
    for p in pages:
        url, decoded = p['url'], unquote(p['url'])
        bad_percent = any(c == '%' and not (len(url[i + 1:i + 3]) == 2 and set(url[i + 1:i + 3]) <= hex_digits)
                          for i, c in enumerate(url))
        problems = [
            p['kind'] not in KINDS and 'kind',
            (not p['id'].startswith(p['kind'] + ':') or len(p['id']) > LIMITS['id']) and 'id',
            (not p['title'].strip() or len(p['title']) > LIMITS['title']) and 'title',
            len(p['description']) > LIMITS['description'] and 'description',
            len(p['detail']) > LIMITS['detail'] and 'detail',
            any(len(p.get(k, '')) > LIMITS[k.split('_')[0]] for k in ('title_en', 'description_en')) and 'english',
            (not url.startswith('/') or url.startswith('//') or not set(url) <= URL_CHARS or bad_percent
             or any(ord(c) <= 0x20 or ord(c) == 0x7f or c in '?#' or ord(c) == 0x5c for c in decoded)
             or any(part in ('.', '..') for part in decoded.split('/'))) and 'url',
            p['id'] in ids and 'duplicate id',
            url in urls and 'duplicate url',
        ]
        errors += [f"{p['url']}: {name}" for name in problems if name]
        errors += [f"{p['url']}: {name}" for name in rank_problems(p)]
        ids.add(p['id'])
        urls.add(url)
    if errors:
        raise ValueError('サイト検索の索引に Worker が受け付けない行がある: ' + ', '.join(errors[:10]))


def rank_problems(p):
    """②に渡す項目の形と長さ。種類ごとの必須項目が欠けた行も止める（Worker は欠けた索引では②を使わない）。"""
    fields = RANK_FIELDS.get(p['kind'])
    if not fields:
        return []
    problems = [f'{key} missing' for key in fields if key not in p]
    if problems:
        return problems
    tags = p.get('tags', [])
    if not isinstance(p['rank_title'], str) or not p['rank_title'].strip() or len(p['rank_title']) > RANK_LIMITS['rank_title']:
        problems.append('rank_title')
    if not isinstance(tags, list) or len(tags) > RANK_LIMITS['tags'] \
            or any(not isinstance(t, str) or not t or len(t) > RANK_LIMITS['tag'] for t in tags):
        problems.append('tags')
    for key in ('category', 'genre'):
        if key in fields and (not isinstance(p[key], str) or len(p[key]) > RANK_LIMITS[key]):
            problems.append(key)
    if not problems:
        total = len(p['kind']) + len(p['rank_title']) + sum(map(len, tags)) + len(p.get('category', '')) + len(p.get('genre', ''))
        if total > RANK_LIMITS['candidate']:
            problems.append('rank candidate over 400 chars without description')
    return problems


def public_source(path):
    parts = Path(path).parts
    if parts[0] == '.well-known':
        return True
    if any(p.startswith('.') for p in parts) or parts[0] in ('workers', 'config'):
        return False
    if parts[0] == 'magi-app' and parts[1:2] != ('www',):
        return False
    if path.startswith('game/reverse-recaptcha/') and path != 'game/reverse-recaptcha/index.html':
        return False
    return True


def page_url(path):
    return '/' + (path[:-10] if path == 'index.html' or path.endswith('/index.html') else path)


def compact(text, limit):
    return re.sub(r'\s+', ' ', re.sub(r'[\x00-\x1f\x7f-\x9f]', ' ', text)).strip()[:limit]


def generate(root, paths):
    redirects = []
    redirect_file = root / '_redirects'
    if redirect_file.exists():
        for line in redirect_file.read_text(encoding='utf-8').splitlines():
            fields = line.split()
            if len(fields) >= 3 and fields[0].startswith('/') and fields[2] in ('301', '302', '303', '307', '308'):
                redirects.append(fields[0])
    extras = {}
    for name, kind in [('tools', 'tool'), ('game', 'game'), ('glitch', 'article')]:
        file = root / 'data' / (name + '.json')
        data = json.loads(file.read_text(encoding='utf-8'))
        rows = data['articles'] if name == 'glitch' else data
        if not isinstance(rows, list) or not rows:
            raise ValueError(f'{file}: 公開一覧が空または形式不正')
        for row in rows:
            url = '/glitch/' + str(row['id']) + '/' if name == 'glitch' else urlsplit(row.get('url', '')).path
            extras[url] = (kind, row)
    hubs = hub_entries(root)
    pages = []
    for path in sorted(paths):
        if not path.endswith('.html') or path == '404.html':
            continue
        file = root / path
        if not file.is_file():
            continue
        # 日本語などのパスは、Worker が URL として読んだときと同じ形（percent-encode）にそろえる
        url = quote(page_url(path), safe=URL_SAFE)
        if url in EXCLUDE:
            continue
        hub = hubs.get(url)
        parsed = Metadata()
        parsed.feed(file.read_text(encoding='utf-8-sig'))
        robots = ','.join(v for k in ('robots', 'googlebot', 'bingbot') for v in parsed.meta.get(k, [])).lower()
        if 'refresh' in parsed.meta or not hub and re.search(r'\b(?:noindex|none)\b', robots):
            continue
        if any(fnmatch.fnmatchcase(url, pattern) for pattern in redirects):
            continue
        if parsed.canonical:
            c = urlsplit(urljoin('https://tk.st' + url, parsed.canonical))
            if c.scheme not in ('', 'http', 'https') or c.netloc not in ('', 'tk.st', 'www.tk.st') or c.query or c.fragment or c.path != url:
                continue  # 外部・別URLを正本とする重複ページは採らない。
        if re.search(r'[\s\\?#\x00-\x1f\x7f]', unquote(url)) or not parsed.title.strip():
            continue
        kind, row = extras.get(url, ('page', {}))
        title = compact(row.get('title') or parsed.title, 160)
        description = compact(row.get('shortDescription') or row.get('description') or row.get('excerpt')
                              or next(iter(parsed.meta.get('description', [])), ''), 320)
        identifier = kind + ':' + str(row['id']) if row else 'page:' + (hub['data-entry'] if hub else url)
        tags = [t for t in row.get('tags', []) if isinstance(t, str)]
        names = [hub.get(k, '') for k in ('data-title-ja', 'data-title-en', 'data-description-ja', 'data-description-en')] if hub else []
        detail = compact(' | '.join(t for t in [title, description, *names, *tags, row.get('genre', ''), row.get('ai', '')] if t), 640)
        # 主な入口の名前は 404.html のもの（ページの title は SEO 用の長いものや、お問い合わせの「認証にご協力ください」のように
        # 名前にならないものがある）。ページの title は detail に残して照合に使う
        shown = compact(hub.get('data-title-ja', ''), LIMITS['title']) if hub else ''
        page = dict(id=identifier, kind=kind, title=shown or (title.split(' - ')[0] if kind == 'tool' else title),
                    description=description or (compact(hub.get('data-description-ja', ''), LIMITS['description']) if hub else ''),
                    url=url, detail=detail)
        if kind in RANK_FIELDS:
            # ②は副題を含む全体の題名と、タグ・カテゴリー・ジャンルを別の項目で使う（detail には混ぜない）。
            # 長さは切らずに validate で確かめる（黙って切ると、元の JSON の直し忘れに気づけない）
            page['rank_title'] = compact(row.get('title') or parsed.title, 10 ** 6)
            if 'tags' in RANK_FIELDS[kind]:
                page['tags'] = [t for t in (compact(t, 10 ** 6) for t in tags) if t]
            if 'category' in RANK_FIELDS[kind]:
                category = compact(str(row.get('category', '')), 10 ** 6)
                page['category'] = category[:1].upper() + category[1:]  # /tools/ の絞り込みと同じ表記（converter → Converter）
            if 'genre' in RANK_FIELDS[kind]:
                page['genre'] = compact(str(row.get('genre', '')), 10 ** 6)
        if hub:
            # 英語の画面では、404.html の英語の名前と説明で見せる
            page.update(hub=True, title_en=compact(hub.get('data-title-en', ''), LIMITS['title']),
                        description_en=compact(hub.get('data-description-en', ''), LIMITS['description']))
        pages.append(page)
    missing = sorted(set(hubs) - {p['url'] for p in pages})
    if missing:
        raise ValueError('404.html の常設入口が索引に入らなかった（転送・別URLの canonical・ページの欠落）: ' + ', '.join(missing))
    validate(pages)
    return {'version': 1, 'pages': pages}


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--root', type=Path, default=REPO)
    args.add_argument('--output', type=Path)
    options = args.parse_args()
    root = options.root.resolve()
    if root == REPO:
        paths = [p for p in subprocess.check_output(['git', 'ls-files', '-z'], cwd=REPO).decode('utf-8').split('\0') if p and public_source(p)]
    else:
        paths = [p.relative_to(root).as_posix() for p in root.rglob('*.html')]
    result = generate(root, paths)
    output = options.output or root / 'data/site-search.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    # バイト列で書いて改行を LF に固定する（Windows で作り直しても全行の差分にならず、本番と同じ index_hash になる）
    output.write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(f'site-search: {len(result["pages"])} pages → {output}')


if __name__ == '__main__':
    main()
