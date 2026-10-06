"""公開HTMLを候補にする境界を、外部通信なしで検証する。"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('site_index', Path(__file__).with_name('site-search-index.py'))
index = importlib.util.module_from_spec(spec)
spec.loader.exec_module(index)


class PublicIndex(unittest.TestCase):
    def test_public_html_and_exclusions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            for name in ('tools', 'game', 'glitch'):
                rows = [{'id': '1', 'title': 'Fixture', 'url': '/' + name + '/test/'}]
                (root / 'data' / (name + '.json')).write_text(json.dumps({'articles': rows} if name == 'glitch' else rows), encoding='utf-8')
            pages = {
                'index.html': '<title>Home</title>',
                'contact/index.html': '<title>認証にご協力ください</title><meta name="robots" content="noindex, nofollow">',
                'magi-app/www/index.html': '<title>MAGI</title>',
                'ノート/index.html': '<title>日本語のパス</title>',
                'dj/request/index.html': '<title>リクエスト</title><meta name="description" content="曲をリクエスト">',
                'dj/booth/index.html': '<title>Booth</title><META NAME="ROBOTS" CONTENT="NOINDEX, FOLLOW">',
                'dj/schedule/index.html': '<title>Schedule</title><meta name="googlebot" content="noindex">',
                'tools/test/index.html': '<title>Tool</title><meta name="robots" content="none">',
                '404.html': '<title>Error</title><a data-entry="contact" data-title-ja="お問い合わせ" data-title-en="Contact"'
                            ' data-description-ja="連絡" data-description-en="Get in touch" href="/contact/">',
                'redirect/index.html': '<title>Redirect</title><meta http-equiv="refresh" content="0;url=/">',
                'alias/index.html': '<title>Alias</title><link rel="canonical" href="https://tk.st/dj/request/">',
                'outside/index.html': '<title>Outside</title><link rel="canonical" href="https://outside.test/">',
                'http-redirect/index.html': '<title>HTTP redirect</title>',
                'relative/index.html': '<title>Relative canonical</title><link rel="canonical" href="./">',
                'job/nitoridaily/20261004/index.html': '<title>2026年10月4日号</title>',
                'note.html': '<title>Note &amp; memo</title><script>throw new Error("never run")</script>',
            }
            for path, html in pages.items():
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(html, encoding='utf-8')
            (root / '_redirects').write_text('/http-redirect/* / 301\n', encoding='utf-8')
            actual = index.generate(root, pages)['pages']
            self.assertEqual({p['url'] for p in actual}, {'/', '/contact/', '/dj/request/', '/job/nitoridaily/20261004/', '/note.html',
                                                          '/relative/', '/%E3%83%8E%E3%83%BC%E3%83%88/'})
            # 常設入口は noindex でも載せ、名前は 404.html のもの。ほかは hub を持たない
            contact = next(p for p in actual if p['url'] == '/contact/')
            self.assertEqual((contact['id'], contact['title'], contact['title_en'], contact['hub']), ('page:contact', 'お問い合わせ', 'Contact', True))
            self.assertIn('認証にご協力ください', contact['detail'])
            self.assertFalse(any(p.get('hub') for p in actual if p['url'] != '/contact/'))
            self.assertEqual(next(p['title'] for p in actual if p['url'] == '/note.html'), 'Note & memo')
            self.assertEqual(actual, index.generate(root, reversed(list(pages)))['pages'])
            # 常設入口が索引に入らなければ止める
            (root / 'contact/index.html').write_text('<title>x</title><meta http-equiv="refresh" content="0;url=/">', encoding='utf-8')
            with self.assertRaises(ValueError):
                index.generate(root, pages)
            (root / 'data/game.json').unlink()
            with self.assertRaises(FileNotFoundError):
                index.generate(root, pages)

    def test_validate_matches_worker(self):
        good = {'id': 'page:/a/', 'kind': 'page', 'title': 'A', 'description': '', 'url': '/a/', 'detail': 'A'}
        index.validate([good])
        for bad in ({'url': '//a/'}, {'url': '/a/%ZZ/'}, {'url': '/a/%2e%2e/'}, {'url': '/a/b c/'}, {'url': '/a/?q'},
                    {'id': 'tool:1'}, {'title': ' '}, {'title': 'x' * 161}, {'detail': 'x' * 641}, {'title_en': 'x' * 161}):
            with self.assertRaises(ValueError, msg=bad):
                index.validate([{**good, **bad}])
        with self.assertRaises(ValueError):
            index.validate([good, {**good, 'url': '/b/'}])

    def test_rank_fields_are_copied_from_source_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            sources = {
                'tools': [{'id': 1, 'title': 'PDF Studio - PDF 結合ツール', 'url': 'https://tk.st/tools/pdf/', 'category': 'converter',
                           'description': 'PDF を結合', 'tags': ['PDF', '結合', 3, '']}],
                'game': [{'id': 2, 'title': 'Puzzle', 'url': 'https://tk.st/game/puzzle/', 'genre': 'puzzle', 'description': 'A puzzle'}],
                'glitch': {'articles': [{'id': '001', 'title': '記事', 'excerpt': '抜粋', 'tags': ['AI']}]},
            }
            for name, rows in sources.items():
                (root / 'data' / (name + '.json')).write_text(json.dumps(rows), encoding='utf-8')
            pages = {'404.html': '<a data-entry="home" data-title-ja="トップ" href="/">', 'index.html': '<title>Home</title>',
                     'tools/pdf/index.html': '<title>PDF</title>', 'game/puzzle/index.html': '<title>Puzzle</title>',
                     'glitch/001/index.html': '<title>記事</title>'}
            for path, html in pages.items():
                (root / path).parent.mkdir(parents=True, exist_ok=True)
                (root / path).write_text(html, encoding='utf-8')
            by_url = {p['url']: p for p in index.generate(root, pages)['pages']}
            tool, game, article = by_url['/tools/pdf/'], by_url['/game/puzzle/'], by_url['/glitch/001/']
            # 表示の題名は副題を落とし、②の題名は全体。文字列でないタグと空のタグは落とす
            self.assertEqual((tool['title'], tool['rank_title'], tool['tags'], tool['category']),
                             ('PDF Studio', 'PDF Studio - PDF 結合ツール', ['PDF', '結合'], 'Converter'))
            self.assertEqual((game['rank_title'], game['genre']), ('Puzzle', 'puzzle'))
            self.assertNotIn('tags', game)
            self.assertEqual((article['rank_title'], article['tags']), ('記事', ['AI']))
            self.assertFalse(any(k in by_url['/'] for k in ('rank_title', 'tags', 'category', 'genre')))

    def test_rank_fields_limits(self):
        tool = {'id': 'tool:1', 'kind': 'tool', 'title': 'T', 'description': '', 'url': '/t/', 'detail': 'T',
                'rank_title': 'T', 'tags': ['a'], 'category': 'Converter'}
        index.validate([tool])
        index.validate([{**tool, 'tags': []}])
        for bad in ({'rank_title': 'x' * 161}, {'rank_title': ' '}, {'tags': 'PDF'}, {'tags': ['x'] * 13}, {'tags': ['x' * 41]},
                    {'tags': ['']}, {'category': 'x' * 41}, {'category': None},
                    {'rank_title': 'x' * 160, 'tags': ['y' * 40] * 6}):  # 説明以外で400文字を超える
            with self.assertRaises(ValueError, msg=bad):
                index.validate([{**tool, **bad}])
        for kind, missing in (('tool', 'category'), ('game', 'genre'), ('article', 'tags')):
            row = {**tool, 'id': kind + ':1', 'kind': kind, 'genre': 'g'}
            row.pop(missing, None)
            with self.assertRaises(ValueError, msg=(kind, missing)):
                index.validate([row])

    def test_source_scope_matches_public_build(self):
        for path in ('workers/test/index.html', 'config/index.html', '.github/test.html',
                     'magi-app/src/index.html', 'game/reverse-recaptcha/src/index.html', 'tools/.private/index.html'):
            self.assertFalse(index.public_source(path), path)
        for path in ('index.html', 'dj/request/index.html', 'anniversary/mitsuki32/index.html',
                     'magi-app/www/index.html', 'game/reverse-recaptcha/index.html'):
            self.assertTrue(index.public_source(path), path)


if __name__ == '__main__':
    unittest.main()
