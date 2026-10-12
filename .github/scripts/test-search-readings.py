"""辞書の固定・未知語・元の文字保持・年別対応を実際の解析器で検証する。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from japanese_search import ReadingBuilder, analysis_text, normalize, encode, digest, keyword_index, list_records, daily_records

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reading_index', Path(__file__).with_name('search-reading-index.py'))
index = importlib.util.module_from_spec(spec)
spec.loader.exec_module(index)


class Readings(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = ReadingBuilder(REPO / 'config/search-readings.json')

    def test_analysis_keeps_kana_then_matching_normalizes(self):
        self.assertEqual(analysis_text('ﾆﾄﾘと家電'), 'ニトリと家電')
        self.assertEqual(normalize('ニトリと家電'), 'にとりと家電')
        words = set(self.builder.words('ニトリと家電'))
        self.assertIn(('にとり', 'にとり'), words)
        self.assertIn(('家電', 'かでん'), words)
        self.assertFalse(any(s == 'と' for s, _ in words))

    def test_deterministic_bytes_field_bits_and_raw_source_hash(self):
        records = [{'id':'fixture:1','fields':[('家電',1),('家電',2)]}]
        first = self.builder.build(b'raw\r\n', records)
        self.assertEqual(encode(first), encode(self.builder.build(b'raw\r\n', records)))
        self.assertNotEqual(first['source_sha256'], self.builder.build(b'raw\n', records)['source_sha256'])
        term = next(t for t in first['terms'] if t['surface'] == '家電')
        self.assertEqual(term['postings'], [(0,3)])
        self.assertEqual(first['record_ids'], ['fixture:1'])
        self.assertFalse(any(t['reading'] in ('k','ka','kad','kaden') for t in first['terms']))

    def test_unknown_kanji_stays_unresolved_and_english_is_valid(self):
        self.builder.words('𠮷野𠀋𠮟')
        self.assertFalse(any(s == '𠮷野𠀋𠮟' for s, _ in self.builder.words('𠮷野𠀋𠮟')))
        self.assertEqual(self.builder.build(b'english', [{'id':'en','fields':[('browser privacy tools',1)]}])['record_ids'], ['en'])
        self.assertEqual(self.builder.build(b'empty', [])['terms'], [])

    def test_full_original_description_survives_short_metadata(self):
        pages = {'version':1,'pages':[{'id':'tool:1','kind':'tool','url':'/tools/test/','title':'表示名','description':'短い説明','detail':''}]}
        original = {'title':'副題も含む全体の名前','description':'文' * 700 + '検索のための末尾','shortDescription':'短い説明','tags':['タグ']}
        source = encode(pages)
        base, records = keyword_index(source, {'/tools/test/':original})
        self.assertIn(original['description'], base['pages'][0]['search_fields']['description'])
        self.assertEqual(base['rank_generation'], digest(source))
        self.assertIn((original['title'], 1), records[0]['fields'])

    def test_list_ids_and_daily_anchor_order_are_explicit(self):
        rows = [{'id':1,'url':'https://tk.st/tools/test/','title':'家電','tags':[]}]
        self.assertEqual(list_records('tools',rows)[0]['id'], 'tool:1')
        with self.assertRaises(ValueError): list_records('tools', rows + rows)
        for url in ('//outside.test/tools/test/', '/tools/../game/', '/tools/test/?q=private', '/tools/%2e%2e/game/'):
            with self.assertRaises(ValueError): list_records('tools',[{**rows[0],'url':url}])
        row = {'date':'20240229','url':'20240229/#art-2','title':'家電','tags':[]}
        part = {'media':'nitoridaily','generation':'abcd','records':[row]}
        self.assertEqual(daily_records('nitoridaily','2024',part,'abcd')[0]['id'], 'nitoridaily:20240229:2')
        for changed in ({**row,'date':'20230229','url':'20230229/#art-2'}, {**row,'url':'20240229/#art-0'}):
            with self.assertRaises(ValueError): daily_records('nitoridaily',changed['date'][:4],{**part,'records':[changed]},'abcd')
        with self.assertRaises(ValueError): daily_records('retailtechdaily','2024',part,'abcd')
        with self.assertRaises(ValueError): daily_records('nitoridaily','2024',part,'dcba')

    def test_empty_year_manifest_and_mixed_generation_fail_before_writing(self):
        with tempfile.TemporaryDirectory(dir=REPO / '.github', prefix='.reading-test-') as directory:
            self.assertTrue(Path(directory).resolve().is_relative_to((REPO / '.github').resolve()))
            root = Path(directory) / 'root'
            output = Path(directory) / 'output'
            (root/'data').mkdir(parents=True)
            for name in ('tools','game','glitch'):
                (root/'data'/f'{name}.json').write_bytes(encode({'articles':[]} if name=='glitch' else []))
            (root/'data/site-search.json').write_bytes(encode({'version':1,'pages':[]}))
            for media in ('nitoridaily','retailtechdaily'):
                target = root/'job'/media
                target.mkdir(parents=True)
                (target/'search-index.json').write_bytes(encode({'media':media,'years':['2026','2025'],'generation':'abcd','records':[]}))
                (target/'search-index-2025.json').write_bytes(encode({'media':media,'generation':'abcd','records':[]}))
            index.generate(root,output,self.builder)
            manifest = json.loads((output/'job/nitoridaily/search-readings.json').read_bytes())
            self.assertEqual([f['records'] for f in manifest['files']], [0,0])
            original = (output/'data/site-readings.json').read_bytes()
            changed = root/'job/retailtechdaily/search-index-2025.json'
            changed.write_bytes(encode({'media':'retailtechdaily','generation':'dcba','records':[]}))
            with self.assertRaises(ValueError): index.generate(root,output,self.builder)
            self.assertEqual((output/'data/site-readings.json').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
