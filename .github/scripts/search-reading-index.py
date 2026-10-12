"""出荷済みの基礎JSONから読みとmanifestを生成する。基礎JSONは書き換えない。"""
import argparse
import gzip
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from japanese_search import ReadingBuilder, digest, encode, keyword_index, list_records, daily_records, safe_url

REPO = Path(__file__).resolve().parents[2]


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name, delete=False) as file:
        temporary = Path(file.name)
        file.write(data)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def generate(root, output, builder, site_index=None):
    report = {'files': [], 'unknown': [], 'source_root': str(root)}
    extras = {}
    for name in ('tools', 'game', 'glitch'):
        rows = json.loads((root / f'data/{name}.json').read_bytes())
        rows = rows['articles'] if name == 'glitch' else rows
        for row in rows:
            url = f'/glitch/{row["id"]}/' if name == 'glitch' else safe_url(row.get('url'))
            extras[url] = row
    site_bytes = (site_index or root / 'data/site-search.json').read_bytes()
    base, records = keyword_index(site_bytes, extras)
    base_bytes = encode(base)
    artifacts = {'data/site-keyword.json': base_bytes}

    def reading(name, source, records):
        start = time.perf_counter()
        payload = builder.build(source, records)
        data = encode(payload)
        artifacts[name] = data
        report['files'].append({'file': name, 'records': len(records), 'terms': len(payload['terms']),
                                'postings': sum(len(t['postings']) for t in payload['terms']),
                                'bytes': len(data), 'gzip_bytes': len(gzip.compress(data, mtime=0)),
                                'seconds': round(time.perf_counter() - start, 4), 'sha256': digest(data)})
        return data

    reading('data/site-readings.json', base_bytes, records)
    for scope in ('tools', 'game'):
        source = (root / f'data/{scope}.json').read_bytes()
        reading(f'data/{scope}-readings.json', source, list_records(scope, json.loads(source)))
    for media in ('nitoridaily', 'retailtechdaily'):
        directory = f'job/{media}'
        head_bytes = (root / directory / 'search-index.json').read_bytes()
        head = json.loads(head_bytes)
        years = head.get('years')
        generation = head.get('generation')
        if (not isinstance(years, list) or len(years) > 100 or any(not isinstance(y, str) or not re.fullmatch(r'[0-9]{4}', y) or y == '0000' for y in years)
                or years != sorted(set(years), reverse=True) or not isinstance(generation, str) or not re.fullmatch(r'[a-f0-9]{1,32}', generation)):
            raise ValueError('日刊headの年度・generationが不正')
        if head.get('media') != media or not isinstance(head.get('records'), list) or (not years and head['records']):
            raise ValueError('日刊headの媒体・recordsが不正')
        files = []
        for i, year in enumerate(years):
            base_name = 'search-index.json' if i == 0 else f'search-index-{year}.json'
            source = head_bytes if i == 0 else (root / directory / base_name).read_bytes()
            records = daily_records(media, year, json.loads(source), generation)
            read_name = f'search-readings-{year}.json'
            data = reading(f'{directory}/{read_name}', source, records)
            files.append({'year': year, 'source': base_name, 'source_sha256': digest(source),
                          'readings': read_name, 'readings_sha256': digest(data), 'records': len(records)})
        manifest = {'version': 1, 'media': media, 'source_generation': generation,
                    'normalization_revision': 1, 'files': files}
        manifest['generation'] = digest(encode(manifest))
        artifacts[f'{directory}/search-readings.json'] = encode(manifest)
    # 全入力の検査が済むまで、成果物を一部だけ書き換えない。
    for name, data in artifacts.items():
        write(output / name, data)
    report['unknown'] = sorted(builder.unknown)
    report['analyzer'] = builder.analyzer
    report['site_keyword_bytes'] = len(base_bytes)
    report['site_keyword_gzip_bytes'] = len(gzip.compress(base_bytes, mtime=0))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=REPO)
    parser.add_argument('--output', type=Path, required=True, help='生成先。出荷時は_site。ソースJSONは書き換えない')
    parser.add_argument('--site-index', type=Path, help='事前試験で固定した公開索引')
    parser.add_argument('--report', type=Path, help='測定と未知語の記録（サイトへ出さない場所）')
    args = parser.parse_args()
    output, root = args.output.resolve(), args.root.resolve()
    if output == REPO:
        parser.error('リポジトリ直下を生成先にできません')
    builder = ReadingBuilder(REPO / 'config/search-readings.json')
    start = time.perf_counter()
    report = generate(root, output, builder, args.site_index)
    report['seconds'] = round(time.perf_counter() - start, 4)
    if args.report:
        write(args.report, encode(report))
    print(json.dumps({k: v for k, v in report.items() if k != 'unknown'}, ensure_ascii=False))
    print(f'unknown: {len(report["unknown"])}（文字検索は保持）')


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
