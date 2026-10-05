#!/usr/bin/env python3
"""外部AIを呼ばないMAGIプレビュー。8000で画面、8787で模擬SSEを返す。"""
import json
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
IDS = ['MELCHIOR-1', 'BALTHASAR-2', 'CASPER-3']


def vote(k, r, v, text='既知の条件から判断した。', absent=False, state='final'):
    return {'codename': k, 'name': ['Enthusiast', 'Humanist', 'Strategist'][IDS.index(k)], 'round': r,
            'text': '[NO RESPONSE]' if absent else text, 'vote': v, 'vote_state': state, **({'absent': True} if absent else {})}


def fixtures(query, language):
    """(待ち秒, イベント名, 中身)。合否の正本は設計書、ここは再現用のデータ。"""
    legacy = query == 'mock-legacy'
    if not legacy:
        yield 0, 'classification', {'version': 1, 'intent': 'consult', 'site_pages': 'no', 'votable': 'yes', 'magi_candidate': True, 'reply_language': language}
    if query == 'mock-early-error':
        yield 0, 'title', {'text': 'Early error'}
        yield .3, 'error', {'code': 'preview_error', 'message': 'Preview error before motion'}
        return
    if not legacy:
        rejected = query in ('mock-dismiss', 'mock-motion-fail')
        yield .5, 'motion', {'text': '' if rejected else '予算 < 3万円なら、今夜ラーメンを食べに行く', 'votable': not rejected,
                            **({'reason': 'failed' if query == 'mock-motion-fail' else 'not_votable'} if rejected else {})}
    else:
        rejected = True
    if rejected:
        for r in (1, 2):
            for k in IDS:
                yield .3, 'persona', {key: val for key, val in vote(k, r, None).items() if key not in ('vote', 'vote_state')}
        yield .2, 'integrated', {'delta': '通常の回答として判断材料を整理します。'}
        yield 0, 'done', {}
        return
    records = {k: [] for k in IDS}
    rounds = 5 if query == 'mock-5rounds' else 3 if query == 'mock-ask' else 1 if query == 'mock-solo' else 2
    for r in range(1, rounds + 1):
        if r >= 3:
            yield .4, 'ask', {'round': r, 'max_rounds': 5, 'questions': [{'codename': IDS[0], 'name': 'Enthusiast', 'text': '費用と条件を踏まえて、判断を更新するか？'}]}
        targets = IDS if r <= 2 else IDS[:1]
        for i, k in enumerate(targets):
            absent = (query in ('mock-hold', 'mock-solo') and (i >= 1 if query == 'mock-solo' else i == 2)) or (query == 'mock-carried' and r == 2 and i == 0)
            if r == 2 and records[k][0].get('absent'):
                continue
            v = 'reject' if query == 'mock-reject' or query in ('mock-split', 'mock-hold') and i == 1 else 'approve'
            if query in ('mock-change', 'mock-ask') and i == 0 and r == 1:
                v = 'reject'
            unread = query == 'mock-unreadable' and i == 0 or query in ('mock-vote-unclear', 'mock-vote-read-fail', 'mock-vote-invalid') and i == 0
            if absent or unread:
                v = None
            pending = unread and query != 'mock-vote-invalid'
            text = '' if query == 'mock-noreason' else '条件が合うなら実行したい。' if v == 'approve' else '費用への懸念が残る。'
            d = vote(k, r, v, text, absent, 'pending' if pending else 'final')
            yield (0.01 if query == 'mock-burst' else 8 if query == 'mock-slow' and i == 2 or query == 'mock-change' and r == 2 and i == 0 else (3 if r == 1 and i == 0 else .8)), 'persona', d
            if pending:
                d = {**d, 'vote_state': 'final'}
                yield .4, 'persona', d
            records[k].append(d)
    tally = {'approve': 0, 'reject': 0, 'none': 0}
    adopted = {}
    for k, rows in records.items():
        last = rows[-1]
        valid = next((v for v in reversed(rows) if v['vote']), None)
        state = 'voted' if last['vote'] else 'carried' if valid else 'unreadable' if any(not v.get('absent') for v in rows) else 'absent'
        adopted[k] = {'vote': valid['vote'] if valid else None, 'round': valid['round'] if valid else None, 'state': state}
        if state == 'carried':
            adopted[k]['issue'] = 'no_response' if last.get('absent') else 'unreadable'
        tally[adopted[k]['vote'] or 'none'] += 1
    result = 'approve' if tally['approve'] >= 2 else 'reject' if tally['reject'] >= 2 else 'hold'
    yield .2, 'verdict', {'result': result, 'tally': tally, 'rounds': rounds, 'votes': adopted}
    if query == 'mock-synth-fail':
        yield .2, 'integrated', {'delta': '途中の説明'}
        yield .3, 'error', {'code': 'preview_synth_error', 'message': 'Incomplete explanation'}
        return
    explanations = {'approve': ('私は実行の利点を重視して承認した。', 'ただ、費用への懸念は私の中にも残っている。'),
                    'reject': ('私は費用への懸念を重視して否決した。', '実行の利点はあるが、今の条件では負担が大きいと考えた。'),
                    'hold': ('私の中で賛否が割れ、有効票も足りず保留となった。', '実行の利点と費用への懸念が残っている。')}
    if query == 'mock-noreason':
        explanations[result] = ('私の中では3票が賛成だった。', '各票に理由が示されていないため、採決の根拠は説明できない。')
    yield .1, 'integrated', {'delta': explanations[result][0]}
    if query == 'mock-title-late':
        yield 0, 'title', {'text': '遅いタイトル'}
    yield .2, 'integrated', {'delta': explanations[result][1]}
    yield 0, 'integrated_end', {}
    if query == 'mock-title-late':
        yield 0, 'title', {'text': '説明完了後のタイトル'}
    if query == 'mock-disconnect-after-synth':
        return
    yield 4 if query == 'mock-suggest-wait' else .1, 'suggest', {'text': '採決せず、判断材料を整理して'}
    yield 0, 'done', {}


class Preview(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_):
        pass

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', 'http://localhost:8000')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/magi2/models':
            self.send_response(200); self.cors(); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'personas': {k: {'model': 'LOCAL PREVIEW', 'provider': 'mock'} for k in IDS}, 'synthesizer': {'model': 'LOCAL PREVIEW', 'provider': 'mock'}}).encode())
            return
        file = (ROOT / ('index.html' if path == '/' else path.lstrip('/'))).resolve()
        if not file.is_relative_to(ROOT) or any(p.startswith('.') for p in file.relative_to(ROOT).parts) or path.startswith('/workers/'):
            self.send_error(404); return
        if path in ('/', '/magi-app/www/', '/magi-app/www/index.html'):
            file = ROOT / ('index.html' if path == '/' else 'magi-app/www/index.html')
        if file.is_file() and file.suffix == '.html':
            html = file.read_text(encoding='utf-8')
            end = html.index('</head>')
            head = re.sub(r'<script\b[^>]*>[\s\S]*?</script>', '', html[:end])
            html = re.sub(r'<noscript\b[^>]*>[\s\S]*?</noscript>', '', head + html[end:])
            body = html.encode('utf-8'); self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.end_headers(); self.wfile.write(body)
            return
        return super().do_GET()

    def do_POST(self):
        if self.path != '/magi2/chat':
            self.send_error(404); return
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        last = data['messages'][-1]['content']
        query = last if isinstance(last, str) else next(p['text'] for p in last if p['type'] == 'text')
        self.send_response(200); self.cors(); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        try:
            for pause, event, body in fixtures(query, data.get('reply_language') or {'version': 1, 'code': data.get('ui_language', 'ja'), 'source': 'ui'}):
                time.sleep(pause)
                self.wfile.write(('event: ' + event + '\ndata: ' + json.dumps(body, ensure_ascii=False) + '\n\n').encode()); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


if __name__ == '__main__':
    api = ThreadingHTTPServer(('127.0.0.1', 8787), Preview)
    threading.Thread(target=api.serve_forever, daemon=True).start()
    print('MAGI preview: http://localhost:8000/  /magi-app/www/?api=http://localhost:8787 ; mock-approve / mock-slow / mock-hold', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8000), Preview).serve_forever()
