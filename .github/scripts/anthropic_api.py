"""日刊・MAGI人格カード・X素材のMessages API呼び出し。SDKは追加しない。"""
import http.client
import json
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = 'https://api.anthropic.com/v1/messages'
# 人格カード・X素材の呼び出し方（推論なし）。週次のスモークも同じ値で試す。
CARD_OPTIONS = {'max_tokens': 4000, 'thinking': 'disabled', 'effort': 'low'}


def message_payload(model, system, content, *, max_tokens, thinking, effort):
    """公開素材の画像URLも、Messages APIのcontentへ変換する。"""
    if isinstance(content, list):
        content = [({'type': 'image', 'source': {'type': 'url', 'url': part['image_url']['url']}}
                    if part.get('type') == 'image_url' else part) for part in content]
    return {'model': model, 'system': system, 'messages': [{'role': 'user', 'content': content}],
            'max_tokens': max_tokens, 'thinking': {'type': thinking}, 'output_config': {'effort': effort}}


def post_messages(endpoint, api_key, payload, user_agent, *, timeout=90, retry_waits=(), stream=False):
    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode('utf-8'), headers={
        'Content-Type': 'application/json', 'x-api-key': api_key,
        'anthropic-version': '2023-06-01', 'User-Agent': user_agent,
    })
    for attempt in range(len(retry_waits) + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode('utf-8')
            return raw if stream else json.loads(raw)
        except urllib.error.HTTPError as error:
            # キー・入力・応答本文はエラーログへ出さない。
            description = f'HTTP {error.code}'
            retryable = error.code == 429 or error.code >= 500
            error.close()
        except (OSError, http.client.HTTPException, json.JSONDecodeError) as error:
            description, retryable = type(error).__name__, True
        if not retryable or attempt == len(retry_waits):
            raise RuntimeError(f'Anthropic の呼び出しに失敗: {description}')
        print(f'[WARN] Anthropic {description} — {retry_waits[attempt]} 秒後に再試行します', file=sys.stderr)
        time.sleep(retry_waits[attempt])


def message_text(body, *, allow_partial=False):
    reason = body.get('stop_reason')
    if reason != 'end_turn' and not (allow_partial and reason == 'max_tokens'):
        # 拒否や出力上限で切れた本文は再試行しない。
        raise RuntimeError(f'Anthropic 応答が完了していません: {reason}')
    text = ''.join(block.get('text', '') for block in body.get('content', []) if block.get('type') == 'text').strip()
    if not text:
        raise RuntimeError('Anthropic の本文が空です')
    return text


def call_messages(endpoint, api_key, payload, user_agent, **options):
    return message_text(post_messages(endpoint, api_key, payload, user_agent, **options))
