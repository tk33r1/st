"""ActionsでTypeSafeの残高不足・キー失効をメール通知する。応答本文は外へ出さない。"""

import http.client
import json
import os
import re
import sys
import threading
import urllib.request

QUOTA_RE = re.compile(r'insufficient|quota|balance|billing|credit|exhausted', re.I)
_lock = threading.Lock()
_sent = set()
_missing_warned = False


def notify_http_error(error):
    """通常の429・通信障害は通知せず、通知失敗でも元の処理は続ける。"""
    global _missing_warned
    # 手元の評価やテストからはメールを送らない。
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        return
    status = error.code
    if status not in (401, 402, 403, 429):
        return
    if status == 429:
        try:
            body = error.read(4096).decode('utf-8', errors='replace')
        except (http.client.HTTPException, OSError, ValueError):
            return
        if not QUOTA_RE.search(body):
            return

    # SNS・ニュースの並列判定から同時に呼ばれても、実行中は同じ状態を1通にまとめる。
    with _lock:
        if status in _sent:
            return
        key = os.environ.get('RESEND_API_KEY', '').strip()
        sender = os.environ.get('ALERT_FROM', '').strip()
        recipients = [s.strip() for s in os.environ.get('ALERT_TO', '').split(',') if s.strip()]
        if not key or not sender or not recipients:
            if not _missing_warned:
                print('::warning::TypeSafeの通知に必要なRESEND_API_KEY・ALERT_FROM・ALERT_TOが未設定です', file=sys.stderr)
                _missing_warned = True
            return
        run_url = '{}/{}/actions/runs/{}'.format(
            os.environ.get('GITHUB_SERVER_URL', 'https://github.com'),
            os.environ.get('GITHUB_REPOSITORY', ''), os.environ.get('GITHUB_RUN_ID', ''),
        )
        payload = {
            'from': sender, 'to': recipients,
            'subject': f'[MAGI / Actions] TypeSafe API が HTTP {status} で失敗しています',
            'text': '\n'.join([
                'GitHub ActionsでTYPESAFE_API_KEYを使うTypeSafe AI（Jev）の呼び出しが失敗しています。',
                f'HTTP {status}',
                '残高の不足（チャージ切れ）か、キーの失効・権限の問題の可能性があります。',
                '日刊の内容判定・API確認に影響します。TypeSafeの残高とキーを確認してください。',
                '投稿・記事・APIキー・上流の応答本文はこのメールに含めていません。',
                f'実行: {run_url}',
            ]),
        }
        request = urllib.request.Request(
            'https://api.resend.com/emails', data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
            headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, method='POST',
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                if not 200 <= response.status < 300:
                    raise ValueError('mail status')
            _sent.add(status)
            print(f' -> TypeSafe HTTP {status} の通知メールを送信しました')
        except (http.client.HTTPException, OSError, ValueError) as failure:
            # 本文・キーはログに含めない。送れなければ次の失敗時に再試行する。
            print(f'::warning::TypeSafeの通知メール送信に失敗: {type(failure).__name__}', file=sys.stderr)
