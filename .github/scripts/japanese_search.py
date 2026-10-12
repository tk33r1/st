"""Phase 4の読み生成。表示文字列を変えず、解析と照合の正規化を分ける。"""
from collections import defaultdict
from datetime import date
from functools import lru_cache
from hashlib import sha256
from importlib.metadata import version
from pathlib import Path
import json
import re
import unicodedata

REVISION = 1
TITLE, TAG, DESCRIPTION, DETAIL = 1, 2, 4, 8
CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')
KANA = re.compile(r'^[\u3041-\u3096\u30a1-\u30f6ー]+$')
CONTENT = {'名詞', '動詞', '形容詞', '副詞', '接頭辞', '接尾辞'}
MAX_RECORDS, MAX_TEXT = 10000, 32768
PINNED = {'SudachiPy': '0.6.11', 'SudachiDict-core': '20260428'}
DICT_HASH = '6c1d5adc8a2389875713056e7b39bbcd0073d6122ffd509866e1d3a196f8608e'


def analysis_text(value):
    return CONTROL.sub('', unicodedata.normalize('NFKC', value))


def normalize(value):
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c
                   for c in analysis_text(value).lower())


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')


def digest(data):
    return sha256(data).hexdigest()


def string(value):
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        raise ValueError('検索フィールドの型・長さが不正')
    return value


def fields(row, names):
    result = []
    for name, mask in names:
        value = row.get(name, '')
        values = value if isinstance(value, list) else [value]
        for text in values:
            text = string(text)
            if text:
                result.append((text, mask))
    return result


LIST_FIELDS = {
    'tools': [('title', TITLE), ('tags', TAG), ('description', DESCRIPTION),
              ('shortDescription', DESCRIPTION), ('category', DETAIL)],
    'game': [('title', TITLE), ('description', DESCRIPTION), ('genre', TAG), ('ai', DETAIL)],
}
DAILY_FIELDS = [('title', TITLE), ('tags', TAG), ('summary', DESCRIPTION),
                ('takeaway', DESCRIPTION), ('source', DETAIL), ('category', TAG)]
SITE_FIELDS = [('title', TITLE), ('title_en', TITLE), ('description', DESCRIPTION),
               ('description_en', DESCRIPTION), ('detail', DETAIL), ('tags', TAG),
               ('category', TAG), ('genre', TAG)]


def safe_url(value):
    from urllib.parse import urlsplit, unquote
    if not isinstance(value, str):
        raise ValueError('URLの型が不正')
    u = urlsplit(value)
    if u.scheme not in ('', 'https') or u.netloc not in ('', 'tk.st') or u.query or u.fragment:
        raise ValueError('公開サイト外のURL')
    p = u.path
    decoded = unquote(p)
    if not p.startswith('/') or p.startswith('//') or re.search(r'%(?![0-9a-fA-F]{2})', p) or re.search(r'[\s\\?#\x00-\x1f\x7f]', decoded) or any(
            part in ('.', '..') for part in decoded.split('/')):
        raise ValueError('不正な公開パス')
    return p


def list_records(scope, rows):
    if scope not in LIST_FIELDS or not isinstance(rows, list) or len(rows) > MAX_RECORDS:
        raise ValueError('一覧の形式が不正')
    kind = 'tool' if scope == 'tools' else 'game'
    result, ids, urls = [], set(), set()
    for row in rows:
        identifier = row.get('id') if isinstance(row, dict) else None
        if isinstance(identifier, bool) or not isinstance(identifier, (str, int)):
            raise ValueError('一覧IDが不正')
        key = f'{kind}:{identifier}'
        url = safe_url(row.get('url'))
        if not url.startswith(f'/{scope}/') or key in ids or url in urls or not string(row.get('title')).strip():
            raise ValueError('一覧のID・URL・題名が不正')
        ids.add(key)
        urls.add(url)
        result.append({'id': key, 'fields': fields(row, LIST_FIELDS[scope])})
    return result


def daily_records(media, year, payload, generation):
    if (media not in ('nitoridaily', 'retailtechdaily') or payload.get('media') != media
            or payload.get('generation') != generation or not isinstance(payload.get('records'), list)):
        raise ValueError('日刊の媒体・generationが不一致')
    result, ids = [], set()
    for row in payload['records']:
        match = re.fullmatch(r'(\d{8})/#art-([1-9]\d*)', row.get('url', ''))
        if not match or match[1] != row.get('date') or match[1][:4] != year:
            raise ValueError('日刊の記事URL・年度が不正')
        stamp = match[1]
        date(int(stamp[:4]), int(stamp[4:6]), int(stamp[6:]))
        number = int(match[2])
        key = f'{media}:{stamp}:{number}'
        if key in ids or number > 2 ** 53 - 1 or not string(row.get('title')).strip():
            raise ValueError('日刊の記事ID・題名が不正')
        if not isinstance(row.get('tags'), list):
            raise ValueError('日刊のタグが不正')
        ids.add(key)
        result.append({'id': key, 'fields': fields(row, DAILY_FIELDS)})
    return result


def keyword_index(site_bytes, extras):
    site = json.loads(site_bytes)
    if site.get('version') != 1 or not isinstance(site.get('pages'), list):
        raise ValueError('サイト索引の形式が不正')
    pages, records, ids, urls = [], [], set(), set()
    for page in site['pages']:
        if page.get('kind') not in ('tool', 'game', 'article', 'page'):
            raise ValueError('サイト索引のkindが不正')
        identifier = string(page.get('id'))
        url = safe_url(page.get('url'))
        if not identifier.startswith(page['kind'] + ':') or identifier in ids or url in urls:
            raise ValueError('サイト索引のID・URLが不正')
        ids.add(identifier)
        urls.add(url)
        original = extras.get(url, {})
        search_fields = {
            'title': [page.get('title', ''), page.get('title_en', ''), original.get('title', '')],
            'tags': [*page.get('tags', []), *original.get('tags', []), original.get('genre', ''), original.get('category', '')],
            'description': [page.get('description', ''), page.get('description_en', ''),
                            original.get('description', ''), original.get('shortDescription', ''), original.get('excerpt', '')],
            'detail': [page.get('detail', ''), original.get('ai', '')],
        }
        chosen = []
        for name, mask in [('title', TITLE), ('tags', TAG), ('description', DESCRIPTION), ('detail', DETAIL)]:
            search_fields[name] = list(dict.fromkeys(string(s) for s in search_fields[name] if s))
            chosen.extend((s, mask) for s in search_fields[name])
        pages.append({**page, 'search_fields': search_fields})
        records.append({'id': identifier, 'fields': chosen})
    return {'version': 1, 'rank_generation': digest(site_bytes), 'pages': pages}, records


class ReadingBuilder:
    def __init__(self, aliases_path):
        from sudachipy import dictionary, tokenizer
        import sudachidict_core
        installed = {name: version(name) for name in PINNED}
        if installed != PINNED:
            raise ValueError('固定した解析器・辞書版と不一致')
        dictionary_path = Path(sudachidict_core.__file__).parent / 'resources/system.dic'
        actual = digest(dictionary_path.read_bytes())
        if actual != DICT_HASH:
            raise ValueError('辞書のSHA-256が不一致')
        aliases_bytes = Path(aliases_path).read_bytes()
        aliases = json.loads(aliases_bytes)
        if aliases.get('version') != 1 or aliases.get('normalization_revision') != REVISION or not isinstance(aliases.get('aliases'), list):
            raise ValueError('読み補正の契約が不正')
        self.aliases = {}
        for row in aliases['aliases']:
            surface = normalize(string(row.get('surface')))
            readings = row.get('readings')
            if not surface or surface in self.aliases or not isinstance(readings, list) or not readings or not string(row.get('reason')).strip():
                raise ValueError('読み補正の表記・根拠が不正')
            if any(not isinstance(r, str) or not KANA.fullmatch(analysis_text(r)) for r in readings):
                raise ValueError('読み補正の読みが不正')
            self.aliases[surface] = tuple(sorted({normalize(r) for r in readings}))
        self.analyzer = {'package': f'SudachiPy=={installed["SudachiPy"]}',
                         'dictionary': f'SudachiDict-core=={installed["SudachiDict-core"]}',
                         'dictionary_sha256': actual, 'aliases_sha256': digest(aliases_bytes)}
        self.tokenizer = dictionary.Dictionary(dict='core').create()
        self.modes = (tokenizer.Tokenizer.SplitMode.B, tokenizer.Tokenizer.SplitMode.C)
        self.unknown = set()

    @lru_cache(maxsize=32768)
    def words(self, text):
        words = set()
        for mode in self.modes:
            for m in self.tokenizer.tokenize(text, mode):
                if m.part_of_speech()[0] not in CONTENT:
                    continue
                surface = normalize(m.surface())
                reading = analysis_text(m.reading_form())
                if m.is_oov() and not KANA.fullmatch(analysis_text(m.surface())):
                    if any('CJK' in unicodedata.name(c, '') for c in surface):
                        self.unknown.add(surface)
                    continue  # 未知の漢字の読みを解析器の推測で確定しない。
                if not KANA.fullmatch(reading):
                    reading = analysis_text(m.surface())
                if KANA.fullmatch(reading):
                    words.add((surface, normalize(reading)))
                form = m.dictionary_form()
                if m.part_of_speech()[0] in ('動詞', '形容詞') and form != m.surface():
                    parts = self.tokenizer.tokenize(form, mode)
                    if len(parts) == 1 and not parts[0].is_oov() and KANA.fullmatch(parts[0].reading_form()):
                        words.add((normalize(form), normalize(parts[0].reading_form())))
        for surface, readings in self.aliases.items():
            if surface in normalize(text):
                words.update((surface, r) for r in readings)
        return tuple(sorted(words))

    def build(self, source_bytes, records):
        if len(records) > MAX_RECORDS or len({r['id'] for r in records}) != len(records):
            raise ValueError('レコード数・IDが不正')
        postings = defaultdict(dict)
        for index, record in enumerate(records):
            for text, mask in record['fields']:
                if mask not in (TITLE, TAG, DESCRIPTION, DETAIL):
                    raise ValueError('フィールドbitが不正')
                analyzed = analysis_text(string(text))
                words = set(self.words(analyzed))
                if mask & (TITLE | TAG):
                    # 辞書が分割した未知のかな名も、実際に書かれた連続表記から探せる。
                    for run in re.findall(r'[\u3041-\u3096\u30a1-\u30f6ー]{2,}', analyzed):
                        words.add((normalize(run), normalize(run)))
                for key in words:
                    postings[key][index] = postings[key].get(index, 0) | mask
        dependency = {'source_sha256': digest(source_bytes), 'analyzer': self.analyzer, 'normalization_revision': REVISION}
        result = {'version': 1, **dependency, 'generation': digest(encode(dependency)),
                  'record_ids': [r['id'] for r in records],
                  'terms': [{'surface': s, 'reading': r, 'postings': sorted(rows.items())}
                            for (s, r), rows in sorted(postings.items(), key=lambda entry: (entry[0][1], entry[0][0]))]}
        return result
