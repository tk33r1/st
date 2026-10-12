"""404の静的ツリーを、出荷する公開索引だけから作る。"""
import argparse
import json
from pathlib import Path
from html import escape
from urllib.parse import unquote
import re
from japanese_search import safe_url


def render(pages):
    root = {'children': {}, 'page': None}
    seen = set()
    for page in pages:
        url = safe_url(page.get('url'))
        if not url or url in seen:
            raise ValueError('ツリーのURLが不正・重複')
        seen.add(url)
        parts = url.strip('/').split('/') if url != '/' else ['home']
        if len(parts) == 3 and parts[0] == 'job' and parts[1] in ('nitoridaily', 'retailtechdaily') and re.fullmatch(r'[1-9]\d{7}', parts[2]):
            date = parts.pop()
            parts += [date[:4], date[:6], date]
        node = root
        for part in parts:
            node = node['children'].setdefault(part, {'children': {}, 'page': None})
        node['page'] = page

    def label(node, part):
        page = node['page']
        if page:
            return f'<span data-ja="{escape(page["title"], quote=True)}" data-en="{escape(page.get("title_en") or page["title"], quote=True)}">{escape(page["title"])}</span>'
        text = unquote(part)
        if re.fullmatch(r'\d{6}', part):
            text = part[:4] + '/' + part[4:]
        return escape(text)

    def branch(node, part, depth):
        page, children = node['page'], node['children']
        text = label(node, part)
        if page:
            text = f'<a href="{escape(page["url"], quote=True)}">{text}</a>'
        else:
            text = '<span>' + text + '</span>'
        content = ''
        if children:
            section = part if depth == 0 and part in ('tools', 'game', 'glitch') else 'daily' if part in ('nitoridaily', 'retailtechdaily') else ''
            attr = f' data-tree-section="{section}"' if section else ''
            # リンクと開閉は別操作。年・月など実ページのない枝にはhrefを作らない。
            content = f'<details{attr}><summary><span data-ja="配下を開く" data-en="Show children">配下を開く</span></summary><ul>'
            content += ''.join(branch(child, key, depth + 1) for key, child in sorted(children.items())) + '</ul></details>'
        return '<li><div class="site-tree-label">' + text + '</div>' + content + '</li>'
    order = {'home': 0, 'tools': 1, 'game': 2, 'glitch': 3, 'job': 4}
    return '<nav class="site-tree" aria-label="サイトの全体"><ul>' + ''.join(branch(node, key, 0) for key, node in sorted(root['children'].items(), key=lambda pair: (order.get(pair[0], 10), pair[0]))) + '</ul></nav>'


def generate(root):
    page = root / '404.html'
    source = page.read_text(encoding='utf-8')
    pattern = r'(<!-- SEARCH_TREE_START -->)[\s\S]*?(<!-- SEARCH_TREE_END -->)'
    if len(re.findall(pattern, source)) != 1:
        raise ValueError('404のツリー生成領域が一意ではない')
    pages = json.loads((root / 'data/site-search.json').read_bytes())['pages']
    tree = render(pages)
    page.write_text(re.sub(pattern, lambda match: match[1] + '\n' + tree + '\n      ' + match[2], source), encoding='utf-8', newline='\n')
    print(f'search-tree: {len(pages)}ページ（出荷HTMLのみ更新）')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if root == Path(__file__).resolve().parents[2]:
        parser.error('リポジトリ直下ではなく出荷先を指定する')
    generate(root)
