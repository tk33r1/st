"""固定10k fixtureの辞書初期化・生成時間とプロセスのピークRSSを測る。依存取得は含めない。"""
import argparse
import ctypes
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import platform
import time
from japanese_search import ReadingBuilder, encode, digest, fields, DAILY_FIELDS


def peak_rss():
    if os.name != 'nt':
        import resource
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return value if platform.system() == 'Darwin' else value * 1024
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
            (key, ctypes.c_size_t) for key in ('PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage',
            'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage')]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    data = Counters()
    data.cb = ctypes.sizeof(data)
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(data), data.cb):
        raise ctypes.WinError(ctypes.get_last_error())
    return data.PeakWorkingSetSize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--case', choices=['shared', 'distinct'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('measurement', Path(__file__).with_name('measure-search-readings.py'))
    measure = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(measure)
    report = {'started': datetime.now(timezone.utc).isoformat(), 'platform': platform.system(), 'python': platform.python_version(), 'case': args.case,
              'script_sha256': digest(Path(__file__).read_bytes()),
              'fixture_script_sha256': digest(Path(__file__).with_name('measure-search-readings.py').read_bytes()),
              'includes': 'プロセス全体のピークRSS。辞書のマッピング・fixture・生成を含み、依存取得・ブラウザは含まない。',
              'initial_peak_rss_bytes': peak_rss()}
    started = time.perf_counter()
    builder = ReadingBuilder(args.root / 'config/search-readings.json')
    report.update(analyzer=builder.analyzer, dictionary_init_seconds=time.perf_counter() - started, dictionary_peak_rss_bytes=peak_rss())
    rows = measure.fixture(args.root, 10000, args.case == 'distinct')
    source = encode(rows)
    started = time.perf_counter()
    readings = builder.build(source, [{'id': row['id'], 'fields': fields(row, DAILY_FIELDS)} for row in rows])
    data = encode(readings)
    report.update(records=len(rows), source_sha256=digest(source), readings_sha256=digest(data),
                  readings_bytes=len(data), generation_seconds=time.perf_counter() - started, peak_rss_bytes=peak_rss())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(encode(report))
    print(json.dumps(report, ensure_ascii=True))


if __name__ == '__main__':
    main()
