#!/usr/bin/env python3
"""404のAI検索を外部通信なしで画面確認する。python -B .github/scripts/preview-404-ai.py

http://localhost:4215/missing/ を開く。検索語 mock-none / mock-limit / mock-error は各状態、
mock-slow は遅い応答、mock-global は共有上限、mock-update は更新要求を模擬する。?lang=en で英語表示。
検索（Enter・虫眼鏡。②）も同じ検索語で模擬する：mock-none は該当なし、mock-limit は上限、mock-error は失敗、mock-slow は3秒、
mock-partial は一部を判定できない、mock-disabled は停止（②の欄と説明が消える）、mock-evil は外部 URL（描かずに失敗）。
ほかの語は2件の結果を返す。
本番ファイル・フラグは変更せず、解析スクリプトも読み込まない。
"""
import json
import re
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]


class Preview(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if urlsplit(self.path).path.startswith(('/data/', '/images/favicons/', '/assets/')):
            return super().do_GET()
        html = (ROOT / '404.html').read_text(encoding='utf-8')
        scripts = list(re.finditer(r'<script>([\s\S]*?)</script>', html))
        for script in reversed(scripts[:-1]):
            html = html[:script.start()] + html[script.end():]
        html = re.sub(r'<noscript>[\s\S]*?</noscript>', '', html)
        html = html.replace('var AI_SEARCH_ENABLED = false;', 'var AI_SEARCH_ENABLED = true;')
        if 'lang=en' in self.path:
            html = html.replace("if (navigator.language)", "if (false)").replace("var lang = 'ja';", "var lang = 'en';")
        mock = "<script>const originalFetch=window.fetch;window.fetch=(url,opts)=>originalFetch(String(url).split('?')[0].endsWith('/magi2/site-search')?'/__site-search':url,opts);</script>"
        html = html.replace('<body>', '<body><p>LOCAL UI PREVIEW — AI replies are simulated</p>' + mock)
        body = html.encode('utf-8')
        self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        if self.path != '/__site-search':
            self.send_error(404); return
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        query = data['query']
        if data.get('mode') == 'rank':
            return self.rank(data)
        if query == 'mock-slow':
            time.sleep(3)
        status = 429 if query in ('mock-limit', 'mock-global') else 409 if query == 'mock-update' else 503 if query == 'mock-error' else 200
        none = query == 'mock-none'
        comment = 'You can combine PDFs with my PDF Studio.' if data['locale'] == 'en' else 'PDFをまとめるなら、私のPDF Studioが使えます。'
        body = {'request_id': 'local-preview', 'status': 'no_results' if none else 'results', 'comment': None if none else comment,
                'results': [] if none else [{'id': 'tool:7', 'kind': 'tool', 'title': 'PDF Studio', 'description': 'サーバーレスPDF編集ツール', 'url': '/tools/pdf-studio/'}]}
        if query in ('mock-global', 'mock-update'):
            body = {'error': {'code': 'global_daily_limit_exceeded' if query == 'mock-global' else 'site_search_update_required', 'retryable': False}}
        self.send_json(status, body)

    def send_json(self, status, body):
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.end_headers()
        try:
            self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    # ②の模擬（Worker の応答の形は assets/site-search-design.md 3.12）
    def rank(self, data):
        query = data['query']
        if query == 'mock-slow':
            time.sleep(3)
        en = data['locale'] == 'en'
        rows = [{'kind': 'tool', 'title': 'PDF Studio', 'description': 'Edit PDFs in your browser' if en else 'ブラウザで完結するPDF編集', 'url': '/tools/pdf-studio/'},
                {'kind': 'page', 'title': 'MAGI', 'description': 'Chat with three AI personas' if en else '3つの人格と話すAIチャット', 'url': '/magi/'}]
        body = {'request_id': 'local-preview', 'status': 'results', 'complete': query != 'mock-partial', 'reason': None,
                'searched': {'total': 35, 'candidates': 35, 'judged': 35 if query != 'mock-partial' else 30}, 'results': rows}
        status = 200
        if query == 'mock-none':
            body.update(status='no_results', results=[])
        elif query in ('mock-limit', 'mock-error', 'mock-disabled'):
            reason = {'mock-limit': 'rate_limited', 'mock-error': 'unavailable', 'mock-disabled': 'disabled'}[query]
            body.update(status='failed', complete=False, reason=reason, results=[], searched=None)
            status = 429 if query == 'mock-limit' else 200
        elif query == 'mock-evil':
            body['results'] = rows[:1] + [{'kind': 'page', 'title': 'evil', 'description': '', 'url': '//example.com/'}]
        self.send_json(status, body)


if __name__ == '__main__':
    print('404 AI UI preview: http://localhost:4215/missing/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 4215), Preview).serve_forever()
