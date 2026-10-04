#!/usr/bin/env python3
"""404のAI検索を外部通信なしで画面確認する。python -B .github/scripts/preview-404-ai.py

http://localhost:4215/missing/ を開く。検索語 mock-none / mock-limit / mock-error は各状態、
mock-daily は日刊、mock-slow は遅い応答、mock-global は共有上限、mock-update は更新要求を模擬する。?lang=en で英語表示。
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
        if urlsplit(self.path).path.startswith(('/data/', '/images/favicons/')):
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
        if query == 'mock-slow':
            time.sleep(3)
        status = 429 if query in ('mock-limit', 'mock-global') else 409 if query == 'mock-update' else 503 if query == 'mock-error' else 200
        none = query == 'mock-none'
        comment = 'You can combine PDFs with my PDF Studio.' if data['locale'] == 'en' else 'PDFをまとめるなら、私のPDF Studioが使えます。'
        body = {'request_id': 'local-preview', 'status': 'no_results' if none else 'results', 'comment': None if none else comment,
                'results': [] if none else [{'id': 'tool:7', 'kind': 'tool', 'title': 'PDF Studio', 'description': 'サーバーレスPDF編集ツール', 'url': '/tools/pdf-studio/'}],
                'daily': {'media': 'nitori', 'query': '出店', 'url': '/job/nitoridaily/?q=%E5%87%BA%E5%BA%97#archiveSearch'} if query == 'mock-daily' else None}
        if query in ('mock-global', 'mock-update'):
            body = {'error': {'code': 'global_daily_limit_exceeded' if query == 'mock-global' else 'site_search_update_required', 'retryable': False}}
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.end_headers()
        try:
            self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


if __name__ == '__main__':
    print('404 AI UI preview: http://localhost:4215/missing/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 4215), Preview).serve_forever()
