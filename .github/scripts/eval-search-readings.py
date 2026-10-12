"""事前に注釈した60語を実辞書→ブラウザと同じ純粋照合へ通す。通信しない。"""
import argparse
import json
from pathlib import Path
import subprocess
from japanese_search import ReadingBuilder, digest, encode, fields

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--set', choices=('tune', 'final'), required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    raw = (ROOT / '.github/site-search/phase4/reading-general.json').read_bytes()
    expected = (ROOT / '.github/site-search/phase4/reading-general.sha256').read_text().strip()
    if digest(raw) != expected:
        raise ValueError('事前固定の正解が変わった')
    data = json.loads(raw)
    cases = [r for r in data['rows'] if r['set'] == args.set]
    if len(cases) != 30 or len({r['id'] for r in cases}) != 30:
        raise ValueError('固定セットの件数・IDが不正')
    records = [{'id': r['id'], r['field']: [r['text']] if r['field'] == 'tags' else r['text']} for r in cases]
    names = [('title', 1), ('tags', 2), ('description', 4), ('detail', 8)]
    source = encode(records)
    builder = ReadingBuilder(ROOT / 'config/search-readings.json')
    payload = builder.build(source, [{'id': r['id'], 'fields': fields(r, names)} for r in records])
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(encode({'set': args.set, 'fixture_sha256': expected, 'cases': cases, 'records': records,
                              'sourceHash': digest(source), 'payload': payload,
                              'unknown': sorted(builder.unknown)}))
    subprocess.run(['node', str(ROOT / '.github/scripts/eval-search-readings.mjs'), str(output)], cwd=ROOT, check=True)


if __name__ == '__main__':
    main()
