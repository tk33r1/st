"""T02の固定1,000/10,000件fixture。生成とブラウザ測定を分ける。"""
import argparse
import gzip
import json
from pathlib import Path
import sys
import time
from japanese_search import ReadingBuilder, encode, digest, fields, DAILY_FIELDS
import importlib.util

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reading_index', Path(__file__).with_name('search-reading-index.py'))
index = importlib.util.module_from_spec(spec)
spec.loader.exec_module(index)


def fixture(root, size, distinct):
    originals = []
    for media in ('nitoridaily', 'retailtechdaily'):
        originals.extend(json.loads((root / f'job/{media}/search-index.json').read_bytes())['records'])
    if not originals:
        raise ValueError('測定の元記事が空')
    kana = 'かきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもらりるれろ'
    records = []
    for i in range(size):
        row = dict(originals[i % len(originals)])
        row['id'] = f'measure:{i}'
        if distinct:
            # 固有のかな語が多いfixture。全文と既存語彙は実記事から保持する。
            number, word = i, 'ぴぴ'
            for _ in range(4):
                word += kana[number % len(kana)]
                number //= len(kana)
            row['title'] = word + ' ' + row['title']
            row['tags'] = [*row['tags'], word]
        records.append(row)
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=REPO)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() == REPO:
        parser.error('リポジトリ直下は測定出力にできません')
    builder = ReadingBuilder(REPO / 'config/search-readings.json')
    measurements = []
    for size in (1000, 10000):
        for distinct in (False, True):
            name = f'{size}-' + ('distinct' if distinct else 'shared')
            records = fixture(args.root, size, distinct)
            source = encode(records)
            start = time.perf_counter()
            reading = builder.build(source, [{'id': r['id'], 'fields': fields(r, DAILY_FIELDS)} for r in records])
            data = encode(reading)
            elapsed = time.perf_counter() - start
            index.write(args.output / f'{name}.json', encode({'records':records,'source_sha256':digest(source),'readings':reading}))
            measurements.append({'name':name,'records':size,'source_sha256':digest(source),'fixture_sha256':digest(source + data),
                                 'terms':len(reading['terms']),'postings':sum(len(t['postings']) for t in reading['terms']),
                                 'bytes':len(data),'gzip_bytes':len(gzip.compress(data,mtime=0)),'seconds':round(elapsed,4)})
            print(json.dumps(measurements[-1]),flush=True)
    index.write(args.output / 'generation-measurements.json', encode({'analyzer':builder.analyzer,'cases':measurements}))


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
