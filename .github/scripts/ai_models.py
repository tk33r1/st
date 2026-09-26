#!/usr/bin/env python3
"""AIモデルの正本の検査、更新検知、APIスモークテスト。"""

import argparse
import base64
import json
import os
import re
import struct
import sys
import urllib.error
import urllib.request
import zlib
from datetime import datetime, timezone
from pathlib import Path

from ai_model_registry import REGISTRY_PATH, REPO_ROOT, load_registry, model_id


# クォートの有無を問わず拾う（YAML の値はクォートなしで書けるため）。
MODEL_LITERAL_RE = re.compile(
    r'(?<![\w.-])(?:'
    r'gpt-[0-9][a-z0-9._-]*|o[1-9](?:-(?:mini|pro|preview)[a-z0-9._-]*)?|'
    r'deepseek-[a-z0-9._-]+|claude-[a-z0-9._-]+|gemini-[a-z0-9._-]+|'
    r'mistral-[a-z0-9._-]+|grok-[a-z0-9._-]+|command-r[a-z0-9._-]*|llama-[a-z0-9._-]+'
    r')(?![\w.-])',
    re.IGNORECASE,
)
ACTIVE_GLOBS = (
    '.github/**/*.py',
    '.github/**/*.js',
    '.github/**/*.sh',
    '.github/**/*.yml',
    '.github/**/*.yaml',
    'workers/**/*.js',
    'workers/**/*.toml',
    'magi-app/www/**/*.js',
    'magi-app/www/**/*.html',
)
SKIP_DIRS = ('node_modules', 'vendor', 'android', 'ios')

# magi2 の3人格は UI テーマで temperature を揺らす（workers/magi2/personas.js の PERSONA_TEMPERATURE の最大値）。
PERSONA_MAX_TEMPERATURE = 1.3
JSON_MESSAGES = [
    {'role': 'system', 'content': 'Return only a JSON object.'},
    {'role': 'user', 'content': 'Return exactly {"ok":true}.'},
]


def solid_png_data_url(size=32):
    """画像入力の疎通用に、単色の PNG を標準ライブラリだけで作る。"""
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

    row = bytes([0]) + bytes([208, 48, 48]) * size
    png = (
        bytes([137]) + b'PNG' + bytes([13, 10, 26, 10])
        + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(row * size))
        + chunk(b'IEND', b'')
    )
    return 'data:image/png;base64,' + base64.b64encode(png).decode('ascii')


def post_json(url, api_key, payload, stream=False):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
            'User-Agent': 'tk.st-ai-model-smoke/1.0',
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')[:1000]
        raise RuntimeError(f'HTTP {e.code}: {detail}') from e
    except OSError as e:
        raise RuntimeError(f'接続エラー: {e}') from e
    if stream:
        if 'data: [DONE]' not in raw:
            raise RuntimeError('ストリームが [DONE] で完了しませんでした')
        return raw
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f'JSON応答ではありません: {raw[:500]}') from e


def message_content(body):
    try:
        content = body['choices'][0]['message']['content'].strip()
    except (KeyError, IndexError, TypeError, AttributeError) as e:
        raise RuntimeError(f'本文を取得できません: {str(body)[:500]}') from e
    if not content:
        raise RuntimeError(f'本文が空です: {str(body)[:500]}')
    return content


def expect_ok_json(body):
    content = message_content(body)
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        raise RuntimeError(f'JSON本文ではありません: {content[:500]}') from e
    if not isinstance(parsed, dict) or parsed.get('ok') is not True:
        raise RuntimeError(f'期待した応答ではありません: {content[:500]}')


# スモークテストは実運用の呼び出し方を最小の形でなぞる。呼び出し方を変えたらここも直すこと。
def smoke_openai(url, api_key, model):
    # 日刊生成・人格カード・ゲームAPI：非推論、低温、JSON出力
    expect_ok_json(post_json(url, api_key, {
        'model': model,
        'messages': JSON_MESSAGES,
        'reasoning_effort': 'none',
        'temperature': 0.2,
        'max_completion_tokens': 32,
        'response_format': {'type': 'json_object'},
    }))
    # magi2 の3人格：非推論、揺らぎの最大温度、top_p、画像付きの発言
    message_content(post_json(url, api_key, {
        'model': model,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': 'Name the color of this image in one word.'},
            {'type': 'image_url', 'image_url': {'url': solid_png_data_url()}},
        ]}],
        'reasoning_effort': 'none',
        'temperature': PERSONA_MAX_TEMPERATURE,
        'top_p': 1.0,
        'max_completion_tokens': 16,
    }))
    # magi2 の統合：推論あり、ストリーミング（上位モデルでは組織認証を求められることがある）
    post_json(url, api_key, {
        'model': model,
        'messages': [{'role': 'user', 'content': 'Reply with OK.'}],
        'reasoning_effort': 'high',
        'max_completion_tokens': 128,
        'stream': True,
    }, stream=True)
    return 'JSON/非推論、画像/高温/top_p、推論/stream'


def smoke_deepseek(url, api_key, model):
    # 日刊生成の一次プロバイダー：JSON出力
    expect_ok_json(post_json(url, api_key, {
        'model': model,
        'messages': JSON_MESSAGES,
        'temperature': 0.2,
        'max_tokens': 32,
        'response_format': {'type': 'json_object'},
    }))
    return 'JSON'


# プロバイダー固有の知識はここだけに置き、正本（config/ai-models.json）にはモデルIDだけを持つ。
# channels の値は版番号を抜き出すパターンで、より新しい版がモデル一覧に出たら更新候補にする。
# None はIDが固定のエイリアス（中身は各社が差し替える）で、毎週のスモークテストで互換性だけ確かめる。
PROVIDERS = {
    'openai': {
        'key_env': 'OPENAI_API_KEY',
        'models_url': 'https://api.openai.com/v1/models',
        'chat_url': 'https://api.openai.com/v1/chat/completions',
        'channels': {'luna': re.compile(r'gpt-(\d+(?:\.\d+)*)-luna')},
        'smoke': smoke_openai,
    },
    'deepseek': {
        'key_env': 'DEEPSEEK_API_KEY',
        'models_url': 'https://api.deepseek.com/models',
        'chat_url': 'https://api.deepseek.com/chat/completions',
        'channels': {'flash': None},
        'smoke': smoke_deepseek,
    },
}


def validate_registry(registry):
    if not isinstance(registry, dict):
        return ['正本がJSONオブジェクトではありません']
    errors = []
    for provider, channels in registry.items():
        if not isinstance(channels, dict):
            errors.append(f'{provider}: 値は「チャネル → モデルID」のオブジェクトにしてください')
            continue
        known = PROVIDERS.get(provider, {}).get('channels', {})
        errors.extend(
            f'{provider}.{channel}: ai_models.py の PROVIDERS に定義がありません'
            for channel in channels if channel not in known
        )
    for provider, pconf in PROVIDERS.items():
        for channel, pattern in pconf['channels'].items():
            try:
                current = model_id(provider, channel, registry)
            except RuntimeError as e:
                errors.append(str(e))
                continue
            if pattern and not pattern.fullmatch(current):
                errors.append(f'{provider}.{channel}: {current} が版番号のパターンに合いません')
    return errors


def find_unmanaged_literals():
    errors = []
    this_file = Path(__file__).resolve()
    seen = set()
    for pattern in ACTIVE_GLOBS:
        for path in REPO_ROOT.glob(pattern):
            parts = path.relative_to(REPO_ROOT).parts
            if path in seen or path == this_file or not path.is_file():
                continue
            if any(part in SKIP_DIRS for part in parts):
                continue
            seen.add(path)
            for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
                if MODEL_LITERAL_RE.search(line):
                    errors.append(
                        f'{path.relative_to(REPO_ROOT)}:{lineno}: モデルIDは config/ai-models.json から読んでください'
                    )
    return errors


def run_check(quiet=False):
    errors = validate_registry(load_registry()) + find_unmanaged_literals()
    for error in errors:
        print(f'[ERROR] {error}', file=sys.stderr)
    if not errors and not quiet:
        print('AIモデル設定: OK')
    return 1 if errors else 0


def api_key_for(provider, pconf):
    api_key = os.environ.get(pconf['key_env'], '').strip()
    if not api_key:
        raise RuntimeError(f'{provider}: {pconf["key_env"]} が未設定です')
    return api_key


def fetch_models(provider, pconf, api_key):
    request = urllib.request.Request(
        pconf['models_url'],
        headers={
            'Authorization': f'Bearer {api_key}',
            'Accept': 'application/json',
            'User-Agent': 'tk.st-ai-model-watch/1.0',
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')[:500]
        raise RuntimeError(f'{provider}: モデル一覧が HTTP {e.code}: {detail}') from e
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError(f'{provider}: モデル一覧の取得に失敗: {e}') from e
    models = body.get('data') if isinstance(body, dict) else None
    if not isinstance(models, list):
        raise RuntimeError(f'{provider}: モデル一覧の data が配列ではありません')
    return {m['id']: m for m in models if isinstance(m, dict) and m.get('id')}


def version_key(pattern, model):
    parts = [int(part) for part in pattern.fullmatch(model).group(1).split('.')]
    while len(parts) > 1 and parts[-1] == 0:  # gpt-6 と gpt-6.0 を同じ版として扱う
        parts.pop()
    return tuple(parts)


def update_registry():
    """新しい版を探し、スモークテストに通った候補だけを正本へ書く。

    確認が必要な事柄（一覧の取得失敗、停止予定、候補の不合格）は最後に例外で知らせるが、
    合格した候補の書き込みはそれとは独立に行う。レビュー用PRを他の問題で止めないため。
    """
    registry = load_registry()
    errors = validate_registry(registry)
    if errors:
        raise RuntimeError('; '.join(errors))

    report = [
        '# AIモデル更新監視レポート',
        '',
        f"確認日時: {datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        '',
    ]
    changes = []
    problems = []

    for provider, pconf in PROVIDERS.items():
        try:
            api_key = api_key_for(provider, pconf)
            by_id = fetch_models(provider, pconf, api_key)
        except RuntimeError as e:
            problems.append(str(e))
            report.append(f'- {provider}: 未確認（{e}）')
            continue

        for channel, pattern in pconf['channels'].items():
            label = f'{provider}.{channel}'
            current = registry[provider][channel]
            live = by_id.get(current)
            if not live:
                problems.append(f'{label}: 現在のモデル {current} が一覧にありません')
            elif live.get('shutdown_date'):
                problems.append(f'{label}: {current} の停止予定日は {live["shutdown_date"]}')
            status = '' if live else '（⚠ 一覧にない）'
            if pattern is None:
                report.append(f'- {label}: エイリアス `{current}`{status}')
                continue

            # 現在のモデルが一覧から消えていても、後継の候補は探す
            newer = [m for m in by_id if pattern.fullmatch(m)
                     and version_key(pattern, m) > version_key(pattern, current)]
            if not newer:
                report.append(f'- {label}: 最新 `{current}`{status}')
                continue
            candidate = max(newer, key=lambda m: version_key(pattern, m))
            try:
                detail = pconf['smoke'](pconf['chat_url'], api_key, candidate)
            except RuntimeError as e:
                problems.append(f'{label}: 更新候補 {candidate} がスモークテストに失敗: {e}')
                report.append(f'- {label}: 更新候補 `{candidate}` はスモークテスト失敗のため見送り（現在 `{current}`{status}）')
                continue
            registry[provider][channel] = candidate
            changes.append(f'{label}: `{current}` → `{candidate}`（スモークテスト合格: {detail}）')
            report.append(f'- {label}: 更新候補 `{current}` → `{candidate}`')

    report.extend(['', '## 変更', ''])
    if changes:
        report.extend(f'- {change}' for change in changes)
        report.extend([
            '',
            '## マージ後の反映',
            '',
            'GitHub Actionsの生成処理はmainへの反映後から新モデルを使います。',
            'Cloudflare Workerは次の2件を手動デプロイしてください（正本のJSONはデプロイ時に取り込まれる）。',
            '',
            '```bash',
            'npx wrangler deploy --config workers/magi2/wrangler.toml',
            'npx wrangler deploy --config workers/wrangler/wrangler.toml',
            '```',
        ])
        REGISTRY_PATH.write_text(
            json.dumps(registry, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline=''
        )
    else:
        report.append('- 変更なし')
    if problems:
        report.extend(['', '## 要確認', ''])
        report.extend(f'- {problem}' for problem in problems)

    print('\n'.join(report))
    if problems:
        raise RuntimeError('; '.join(problems))


def smoke_test():
    registry = load_registry()
    failures = []
    for provider, pconf in PROVIDERS.items():
        try:
            api_key = api_key_for(provider, pconf)
        except RuntimeError as e:
            failures.append(str(e))
            continue
        for channel in pconf['channels']:
            model = model_id(provider, channel, registry)
            try:
                detail = pconf['smoke'](pconf['chat_url'], api_key, model)
            except RuntimeError as e:
                failures.append(f'{provider}.{channel} ({model}): {e}')
                continue
            print(f'[OK] {provider}.{channel}: {model}（{detail}）')
    if failures:
        raise RuntimeError('; '.join(failures))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('check', help='正本の形式と、モデルIDの直書きがないことを検査する')
    sub.add_parser('update', help='各社のモデル一覧から新しい版を探し、スモークテストに通れば正本を更新する')
    sub.add_parser('smoke', help='正本のモデルで実運用の呼び出し方を最小リクエストで試す')
    args = parser.parse_args()

    try:
        if args.command == 'check':
            return run_check()
        if args.command == 'update':
            update_registry()
            return run_check(quiet=True)
        smoke_test()
        return 0
    except RuntimeError as e:
        print(f'[ERROR] {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
