"""404の「サイトの全体」（タイルの下に開くパネル）の中身を、出荷する公開索引と各ページの目印から作る。

- パネルの枠（タイル・名前・説明・ページへのリンク）は404.htmlに手で書き、中身を入れる場所に
  data-sitemap-slot="/区画/" を置く。ここではその中身だけを埋める。
- 「ページ内」は、その区画のページで data-sitemap="日本語" data-sitemap-en="English" を付けた要素。
  リンク先は data-sitemap-anchor、無ければ id。
- 「ページ一覧」は、索引のうちURLがその区画の下にあるページ。日付のURLの孫（日刊の号）は新しい3件だけを添え、
  それ以外の孫は普通の行として並べる。
- どのスロットにも入らないページ（新しい区画）は data-sitemap-slot="*" に並べ、警告を出す。
"""
import argparse
import json
from pathlib import Path
from html import escape
from html.parser import HTMLParser
import re
from japanese_search import safe_url

LATEST = 3
SLOT = re.compile(r'(<div class="panel-body" data-sitemap-slot="([^"]+)">)[\s\S]*?(</div><!-- /slot -->)')


def text(ja, en):
    return f'<span data-ja="{escape(ja, quote=True)}" data-en="{escape(en or ja, quote=True)}">{escape(ja)}</span>'


class Marks(HTMLParser):
    """data-sitemap の目印をDOMの順に集める。"""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.items = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if 'data-sitemap' not in a:
            return
        anchor = a.get('data-sitemap-anchor') or a.get('id') or ''
        label = (a.get('data-sitemap') or '').strip()
        if not re.fullmatch(r'[A-Za-z][\w-]{0,63}', anchor) or not label or len(label) > 40:
            raise ValueError(f'data-sitemap の目印が不正: {label!r} #{anchor!r}')
        self.items.append((anchor, label, (a.get('data-sitemap-en') or '').strip()))


def marks(root, url):
    page = root / url.strip('/') / 'index.html'
    if not page.is_file():
        raise ValueError(f'スロットのページが無い: {url}')
    parser = Marks()
    parser.feed(page.read_text(encoding='utf-8'))
    anchors = [anchor for anchor, _, _ in parser.items]
    if len(set(anchors)) != len(anchors):
        raise ValueError(f'{url}: data-sitemap のリンク先が重複')
    return parser.items


def page_text(page):
    return text(page['title'], page.get('title_en'))


def issue_label(url):
    last = url.strip('/').split('/')[-1]
    return f'{last[:4]}/{last[4:6]}/{last[6:]}' if re.fullmatch(r'\d{8}', last) else None


def children_html(base, pages):
    """base の直下のページと、その下の新しい数件。"""
    # 末尾の / を外して並べる（/masala-tetris/ を /masala-tetris-dx/ より前にする）
    below = sorted((p for p in pages if p['url'] != base and p['url'].startswith(base)), key=lambda p: p['url'].rstrip('/'))
    direct = [p for p in below if p['url'].count('/') == base.count('/') + 1]
    covered = {p['url'] for p in direct}
    rows = []
    for child in direct:
        row = f'<li><a href="{escape(child["url"], quote=True)}">{page_text(child)}</a>'
        issues = sorted((p for p in below if p['url'].startswith(child['url']) and issue_label(p['url'])), key=lambda p: p['url'], reverse=True)
        covered.update(p['url'] for p in issues)
        if issues:
            links = ''.join(f'<li><a href="{escape(p["url"], quote=True)}">{issue_label(p["url"])}</a></li>' for p in issues[:LATEST])
            row += f'<p class="panel-latest">{text("最新", "Latest")}</p><ul class="panel-latest-list">{links}</ul>'
        rows.append(row + '</li>')
    # 号以外の孫と、親ページが索引に無い孫（中間のURLにページが無い）も落とさない。
    rows += [f'<li><a href="{escape(p["url"], quote=True)}">{page_text(p)}</a></li>' for p in below if p['url'] not in covered]
    return rows


def group(ja, en, rows):
    return f'<div class="panel-group"><h4>{text(ja, en)}</h4><ul>' + ''.join(rows) + '</ul></div>' if rows else ''


def render(root, slots, pages):
    seen = set()
    pages = [dict(page, url=safe_url(page.get('url'))) for page in pages]
    for page in pages:
        if page['url'] in seen:
            raise ValueError('索引のURLが重複')
        seen.add(page['url'])
    bases = sorted((s for s in slots if s != '*'), key=len, reverse=True)
    owned = {base: [] for base in bases}
    stray = []
    for page in pages:
        if page['url'] == '/':
            continue  # トップページはパネルの下の「トップページへ」から行く
        base = next((b for b in bases if page['url'].startswith(b)), None)
        (owned[base] if base else stray).append(page)
    bodies = {}
    for base in bases:
        on_page = [f'<li><a href="{escape(base + "#" + anchor, quote=True)}">{text(label, en)}</a></li>' for anchor, label, en in marks(root, base)]
        bodies[base] = group('ページ内', 'On this page', on_page) + group('ページ一覧', 'Pages', children_html(base, owned[base]))
    if stray:
        print('search-tree: 警告 どのタイルにも入らないページ: ' + ', '.join(p['url'] for p in stray))
    bodies['*'] = group('ほかのページ', 'More pages', [f'<li><a href="{escape(p["url"], quote=True)}">{page_text(p)}</a></li>' for p in sorted(stray, key=lambda p: p['url'])])
    return bodies


def generate(root):
    page = root / '404.html'
    source = page.read_text(encoding='utf-8')
    slots = [m[2] for m in SLOT.finditer(source)]
    if not slots or len(set(slots)) != len(slots) or '*' not in slots:
        raise ValueError('404のスロットが無い・重複・「*」が無い')
    pages = json.loads((root / 'data/site-search.json').read_bytes())['pages']
    bodies = render(root, slots, pages)
    page.write_text(SLOT.sub(lambda m: m[1] + bodies[m[2]] + m[3], source), encoding='utf-8', newline='\n')
    print(f'search-tree: {len(pages)}ページ・{len(slots) - 1}区画（出荷HTMLのみ更新）')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if root == Path(__file__).resolve().parents[2]:
        parser.error('リポジトリ直下ではなく出荷先を指定する')
    generate(root)
