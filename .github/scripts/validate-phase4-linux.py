"""Linuxで固定依存のcold/warm導入と出荷ビルドを測る。公開・AI送信はしない。"""
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time


def main():
    if platform.system() != 'Linux':
        raise SystemExit('Linux専用の検証')
    root = Path(__file__).resolve().parents[2]
    os.chdir(root)
    output = root / '.github/scripts/.search-reading-env/work/linux-validation'
    output.mkdir(parents=True, exist_ok=True)
    report = {'platform': platform.platform(), 'python': platform.python_version(),
              'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'note': 'GitHub Linux runner。Pagesそのものの測定ではない。timeのRSSは各処理と子孫の最大で、同時プロセスの合計ではない。',
              'runs': []}

    def run(name, args):
        memory = output / (name + '.time.txt')
        started = time.perf_counter()
        result = subprocess.run(['/usr/bin/time', '-v', '-o', str(memory), *args],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        elapsed = time.perf_counter() - started
        (output / (name + '.log')).write_text(result.stdout, encoding='utf-8')
        peak = re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)', memory.read_text())
        report['runs'].append({'name': name, 'seconds': elapsed, 'exit_code': result.returncode,
                               'peak_rss_bytes': int(peak[1]) * 1024 if peak else None})
        (output / 'environment.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(name, result.returncode, round(elapsed, 3), flush=True)
        if result.returncode:
            print(result.stdout)
            raise SystemExit(result.returncode)

    env = root / '.github/scripts/.search-reading-env'
    subprocess.run([sys.executable, '-m', 'venv', str(env)], check=True)
    python = str(env / 'bin/python')
    install = [python, '-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes',
               '--only-binary=:all:', '-r', '.github/scripts/search-reading-requirements.txt']
    run('dependency-cold', [*install, '--no-cache-dir'])
    run('dependency-warm', install)
    run('build', ['bash', 'build.sh'])
    for case in ('shared', 'distinct'):
        run('memory-' + case, [python, '-B', '.github/scripts/measure-search-reading-memory.py',
                               '--case', case, '--output', str(output / ('memory-' + case + '.json'))])
    run('generation', [python, '-B', '.github/scripts/measure-search-readings.py', '--output', str(output / 'fixtures')])
    run('python-regression', [python, '-B', '.github/scripts/test-search-readings.py'])


if __name__ == '__main__':
    main()
