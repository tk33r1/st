#!/usr/bin/env python3
"""東京都のハイオク小売価格を資源エネルギー庁の週次調査から取得して data/oil-price.json に書き出す。

資源エネルギー庁「石油製品価格調査（給油所小売価格調査）」の週次 xlsx を読む。
- 一覧ページの xlsx リンクのうち、`YYMMDD.xlsx`（詳細版）が都道府県別シートを持つ。
  `YYMMDDs5.xlsx` は集計ファイルなので拾わない。
- 既定 UA だと 403 が返るのでブラウザ UA を送る。
- 依存を増やしたくないので xlsx は zip + XML として素で読む（openpyxl 等は使わない）。

値が前回と同じなら JSON は書き換わらないので、ワークフロー側の commit は空振りして終わる。
"""

import json
import os
import re
import sys
import urllib.request
import zipfile
from datetime import date, timedelta
from io import BytesIO
from xml.sax.saxutils import unescape

INDEX_URL = 'https://www.enecho.meti.go.jp/statistics/petroleum_and_lpgas/pl007/results.html'
BASE = 'https://www.enecho.meti.go.jp'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

PREFECTURE = '東京'
GRADE = 'ハイオク'
# 明らかな異常値を掴んだまま公開しないための範囲。円/L。
PRICE_MIN, PRICE_MAX = 80.0, 500.0

OUT_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'oil-price.json')


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def latest_workbook_url():
    """一覧ページから最新週の詳細版 xlsx の URL を返す。"""
    html = get(INDEX_URL).decode('utf-8', 'replace')
    hrefs = re.findall(r'href="([^"]*/pl007/xlsx/(\d{6})\.xlsx)"', html)
    if not hrefs:
        raise SystemExit('詳細版 xlsx のリンクが一覧ページに見つからない')
    # ページの並びに依存しないよう YYMMDD で最大のものを採る
    href, _ = max(hrefs, key=lambda h: h[1])
    return BASE + href if href.startswith('/') else href


def col_index(ref):
    """セル参照 'B12' → 列インデックス（0 始まり）。"""
    letters = re.match(r'([A-Z]+)', ref).group(1)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_sheet(book, want_in_name):
    """シート名に want_in_name を含むシートを {行番号: {列: 値}} で返す。"""
    strings = []
    if 'xl/sharedStrings.xml' in book.namelist():
        raw = book.read('xl/sharedStrings.xml').decode('utf-8')
        strings = [unescape(re.sub(r'<[^>]+>', '', si))
                   for si in re.findall(r'<si>(.*?)</si>', raw, re.S)]

    rels = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"',
                           book.read('xl/_rels/workbook.xml.rels').decode('utf-8')))
    target = None
    for attrs in re.findall(r'<sheet ([^>]*)/?>', book.read('xl/workbook.xml').decode('utf-8')):
        name = re.search(r'name="([^"]*)"', attrs)
        rid = re.search(r'r:id="([^"]*)"', attrs)
        if name and rid and want_in_name in unescape(name.group(1)):
            target = rels[rid.group(1)]
            break
    if target is None:
        raise SystemExit(f'「{want_in_name}」を含むシートが見つからない')
    if not target.startswith('xl/'):
        target = 'xl/' + target.lstrip('/')

    rows = {}
    xml = book.read(target).decode('utf-8')
    for row_attrs, body in re.findall(r'<row ([^>]*)>(.*?)</row>', xml, re.S):
        r_no = int(re.search(r'r="(\d+)"', row_attrs).group(1))
        cells = {}
        # セルは欠落しうるので、並び順ではなく r 属性の列で引く
        for cell_attrs, cell_body in re.findall(r'<c ([^>]*?)(?:/>|>(.*?)</c>)', body, re.S):
            ref = re.search(r'r="([A-Z]+\d+)"', cell_attrs)
            if not ref:
                continue
            v = re.search(r'<v>(.*?)</v>', cell_body or '', re.S)
            if not v:
                continue
            value = unescape(v.group(1))
            t = re.search(r't="([^"]+)"', cell_attrs)
            if t and t.group(1) == 's':
                value = strings[int(value)]
            cells[col_index(ref.group(1))] = value
        if cells:
            rows[r_no] = cells
    return rows


def norm(s):
    return re.sub(r'[\s　]', '', s or '')


def serial_to_date(serial):
    # Excel のシリアル値。1900 年うるう年バグを含むので基準は 1899-12-30
    return date(1899, 12, 30) + timedelta(days=int(float(serial)))


def main():
    url = latest_workbook_url()
    book = zipfile.ZipFile(BytesIO(get(url)))
    rows = read_sheet(book, '都道府県別')

    # ハイオクの列位置を見出し行から拾う。各油種は「前週・最新週」の 2 列組。
    grade_col = None
    for cells in rows.values():
        for col, value in sorted(cells.items()):
            if GRADE in norm(value):
                grade_col = col
                break
        if grade_col is not None:
            break
    if grade_col is None:
        raise SystemExit(f'見出しに「{GRADE}」が見つからない')

    # 見出し直下の日付行から、2 列組のどちらが最新週かを決める
    date_row = None
    for r_no in sorted(rows):
        pair = [rows[r_no].get(grade_col), rows[r_no].get(grade_col + 1)]
        if all(p and re.fullmatch(r'\d{5}(\.\d+)?', p) for p in pair):
            date_row = r_no
            break
    if date_row is None:
        raise SystemExit('調査日の行が見つからない')
    serials = {c: float(rows[date_row][c]) for c in (grade_col, grade_col + 1)}
    price_col = max(serials, key=serials.get)
    surveyed_on = serial_to_date(serials[price_col])

    price = None
    for r_no in sorted(rows):
        if r_no <= date_row:
            continue
        label = next((rows[r_no][c] for c in sorted(rows[r_no]) if norm(rows[r_no][c])), '')
        if norm(label) == PREFECTURE:
            price = float(rows[r_no][price_col])
            break
    if price is None:
        raise SystemExit(f'「{PREFECTURE}」の行が見つからない')
    if not (PRICE_MIN <= price <= PRICE_MAX):
        raise SystemExit(f'価格が想定範囲外: {price}')

    payload = {
        'prefecture': '東京都',
        'grade': GRADE,
        'price': round(price, 1),
        'unit': '円/L',
        'surveyedOn': surveyed_on.isoformat(),
        'source': '資源エネルギー庁 石油製品価格調査',
        'sourceUrl': INDEX_URL,
        'sourceFile': url,
    }
    out = os.path.normpath(OUT_PATH)
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'{payload["prefecture"]} {GRADE} {payload["price"]}円/L ({surveyed_on}) -> {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
