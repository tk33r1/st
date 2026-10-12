"""共通検索の候補クリックを集計して data/search-boost.json を作る（search-boost.yml が1日1回実行する）。

入力は search-boost.yml が D1 の search_clicks を SQL で集計した結果（`wrangler d1 execute --json`。生の行は取り出さない）。
1つ目がページごと、2つ目が「検索語→ページ」ごとの押した人数（secret を混ぜた IP のハッシュの数）。画面の並び順に使う。
- ページの人数: 同じ点数の候補の中を、人数の多い順に並べる（assets/search-data.js）。
- 検索語→ページ: 同じ検索語で QUERY_MIN_VISITORS 人以上が押したページを、一致した候補の最上位に上げる（assets/search-ui.js）。
  公開リポジトリと公開サイトに出るので、人数の少ない組と、メールアドレス・長い数字を含む検索語は出さない。
押したページが今も公開されているかは、リポジトリのファイルで確かめる（消したページ・作り話の URL を数えない）。
出力は日付を持たず、数が変わらなければ同じバイト列になる（毎日の空コミットを作らない）。
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCOPES = ('site', 'tools', 'game', 'nitori', 'retail')
DAILY = {'nitori': 'nitoridaily', 'retail': 'retailtechdaily'}
WINDOW_DAYS = 90
QUERY_MIN_VISITORS = 3
QUERY_MAX_PAGES = 5
QUERY_MAX_PER_SCOPE = 2000
DIGITS = set('0123456789')
# 電話番号などの区切り。数字の続きを数えるときは飛ばす（090-1234-5678 も11桁と数える）。
SEPARATORS = set(' -().+/') | {chr(c) for c in range(0x2010, 0x2016)} | {chr(0x2212), chr(0x30fc)}


def list_paths(name):
    paths = set()
    for row in json.loads((REPO / f'data/{name}.json').read_text(encoding='utf-8')):
        url = str(row.get('url') or '')
        if url.startswith('https://tk.st/'):
            url = url[len('https://tk.st'):]
        paths.add(url)
    return paths


def page_exists(path):
    """ルートからのパス（/…/）に対応する公開ページがリポジトリにあるか。"""
    if not path.startswith('/') or '..' in path.split('/') or '?' in path or '#' in path:
        return False
    target = REPO / path.strip('/') / 'index.html' if path.endswith('/') else REPO / path.strip('/')
    return target.is_file()


def make_checker():
    tools, game = list_paths('tools'), list_paths('game')

    def valid(scope, href):
        if scope == 'tools':
            return href in tools
        if scope == 'game':
            return href in game
        if scope in DAILY:
            page, sep, anchor = href.partition('#')
            parts = page.strip('/').split('/')
            return (sep == '#' and anchor.startswith('art-') and anchor[4:].isdigit() and len(parts) == 3
                    and parts[:2] == ['job', DAILY[scope]] and len(parts[2]) == 8 and parts[2].isdigit() and page_exists(page))
        return page_exists(href)
    return valid


def private_query(query):
    """公開データに出さない検索語（メールアドレス・区切りを飛ばして7桁以上続く数字）。日付も数字が続くので出さない側に倒れる。"""
    run = 0
    for char in query:
        if char in DIGITS:
            run += 1
        elif char not in SEPARATORS:
            run = 0
        if run >= 7:
            return True
    return '@' in query


def visitors(row):
    n = row.get('visitors')
    return n if isinstance(n, int) and not isinstance(n, bool) and n > 0 else 0


def aggregate(page_rows, query_rows, valid):
    pages = defaultdict(dict)
    queries = defaultdict(lambda: defaultdict(dict))
    for row in page_rows:
        scope, href, n = row.get('scope'), row.get('href'), visitors(row)
        if scope in SCOPES and isinstance(href, str) and n and valid(scope, href):
            pages[scope][href] = n
    for row in query_rows:
        scope, query, href, n = row.get('scope'), row.get('query'), row.get('href'), visitors(row)
        if (scope in SCOPES and isinstance(query, str) and query and isinstance(href, str) and n >= QUERY_MIN_VISITORS
                and not private_query(query) and valid(scope, href)):
            queries[scope][query][href] = n
    out = {}
    for scope in SCOPES:
        page_counts = pages[scope]
        query_counts = {}
        for query, hrefs in queries[scope].items():
            kept = sorted(((n, href) for href, n in hrefs.items()), key=lambda p: (-p[0], p[1]))
            query_counts[query] = {href: n for n, href in kept[:QUERY_MAX_PAGES]}
        if len(query_counts) > QUERY_MAX_PER_SCOPE:
            top = sorted(query_counts, key=lambda q: (-sum(query_counts[q].values()), q))[:QUERY_MAX_PER_SCOPE]
            query_counts = {q: query_counts[q] for q in top}
        if page_counts or query_counts:
            out[scope] = {'pages': dict(sorted(page_counts.items())), 'queries': dict(sorted(query_counts.items()))}
    return {'version': 1, 'window_days': WINDOW_DAYS, 'query_min_visitors': QUERY_MIN_VISITORS, 'scopes': out}


def read_rows(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    # wrangler d1 execute --json は文ごとに { results: [...], success, meta } を返す。ページごと・検索語ごとの2文。
    if (not isinstance(data, list) or len(data) != 2
            or any(not part.get('success') or not isinstance(part.get('results'), list) for part in data)):
        raise ValueError('D1 の集計結果の形が想定と違う（2文の結果を想定）')
    return data[0]['results'], data[1]['results']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rows', required=True, help='wrangler d1 execute --json の出力')
    parser.add_argument('--output', default=str(REPO / 'data/search-boost.json'))
    args = parser.parse_args()
    page_rows, query_rows = read_rows(args.rows)
    result = aggregate(page_rows, query_rows, make_checker())
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8', newline='\n')
    summary = ', '.join(f'{s} {len(v["pages"])}ページ・{len(v["queries"])}語' for s, v in result['scopes'].items())
    print(f'search-boost: {len(page_rows)}ページ・{len(query_rows)}組 → {summary or "集計対象なし"}')


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
