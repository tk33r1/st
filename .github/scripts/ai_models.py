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
from html.parser import HTMLParser
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
# Wrangler のバンドルには正本から取り込んだモデルIDが含まれるので、検査対象から外す。
SKIP_DIRS = ('node_modules', 'vendor', 'android', 'ios', '.wrangler')

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
        validate_chat_stream(raw)
        return raw
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f'JSON応答ではありません: {raw[:500]}') from e


def validate_chat_stream(raw):
    """統合と同じく、正常な終端と本文を検証する（推論だけで終了した応答も失敗）。"""
    done, finish, text = False, None, ''
    for line in raw.splitlines():
        if not line.startswith('data:'):
            continue
        payload = line[5:].strip()
        if payload == '[DONE]':
            done = True
            break
        try:
            body = json.loads(payload)
        except json.JSONDecodeError as e:
            raise RuntimeError('ストリームの JSON が不正です') from e
        if body.get('error'):
            raise RuntimeError('ストリームの途中でエラーが発生しました')
        choices = body.get('choices') or []
        if choices:
            choice = choices[0]
            finish = choice.get('finish_reason') or finish
            text += (choice.get('delta') or {}).get('content') or ''
    if not done or finish != 'stop' or not text.strip():
        raise RuntimeError(f'ストリームが正常な本文を返しませんでした（finish_reason={finish}）')


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
    # 日刊生成：既定と同じ medium 推論、JSON出力。GPT-6 は推論時に temperature を送れない。
    expect_ok_json(post_json(url, api_key, {
        'model': model,
        'messages': JSON_MESSAGES,
        'reasoning_effort': 'medium',
        'max_completion_tokens': 1024,
        'response_format': {'type': 'json_object'},
    }))
    # 人格カード・ゲームAPI：非推論、低温、JSON出力
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
        'max_completion_tokens': 1536,  # magi2 の統合と同じ。推論ぶんの余裕も含む
        'stream': True,
    }, stream=True)
    smoke_openai_web_search(api_key, model)
    return 'JSON/medium、JSON/非推論、画像/高温/top_p、推論/stream、Web検索強制/推論/JSONスキーマ'


OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'


def smoke_openai_web_search(api_key, model):
    """DJ ブースの曲の背景カード（workers/dj-request の requestSongInfo）：Responses API で
    Web 検索を強制し、推論 high、strict な JSON スキーマで答えさせる。検索が実行されたことまで確かめる。"""
    body = post_json(OPENAI_RESPONSES_URL, api_key, {
        'model': model,
        'reasoning': {'effort': 'high'},
        'tools': [{'type': 'web_search', 'user_location': {'type': 'approximate', 'country': 'JP', 'timezone': 'Asia/Tokyo'}}],
        'tool_choice': 'required',
        'include': ['web_search_call.action.sources'],
        'input': 'In what year was "Billie Jean" by Michael Jackson first released?',
        'text': {'format': {'type': 'json_schema', 'name': 'smoke', 'strict': True, 'schema': {
            'type': 'object', 'additionalProperties': False, 'required': ['year'],
            'properties': {'year': {'type': ['integer', 'null']}},
        }}},
        # 本番（requestSongInfo の SONG_INFO.maxOutputTokens）と同じ上限。小さくすると推論 high で
        # 使い切って本文が空になり、本番では起きない失敗を報告してしまう
        'max_output_tokens': 6000,
        'store': False,
    })
    if isinstance(body, dict) and body.get('status') == 'incomplete':
        raise RuntimeError(f'応答が途中で切れました: {body.get("incomplete_details")}')
    output = body.get('output') if isinstance(body, dict) else None
    if not isinstance(output, list):
        raise RuntimeError(f'Responses API の output がありません: {str(body)[:500]}')
    if not any(isinstance(o, dict) and o.get('type') == 'web_search_call' for o in output):
        raise RuntimeError('Web 検索が実行されませんでした（tool_choice: required が効いていない）')
    text = next((
        c.get('text', '') for o in output if isinstance(o, dict) and o.get('type') == 'message'
        for c in (o.get('content') or []) if isinstance(c, dict) and c.get('type') == 'output_text'
    ), '')
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f'JSON本文ではありません: {text[:500]}') from e
    if not isinstance(parsed, dict) or 'year' not in parsed:
        raise RuntimeError(f'期待した応答ではありません: {text[:500]}')


def smoke_deepseek(url, api_key, model):
    # 日刊生成のフォールバック（一次は OpenAI）：JSON出力
    expect_ok_json(post_json(url, api_key, {
        'model': model,
        'messages': JSON_MESSAGES,
        'temperature': 0.2,
        'max_tokens': 32,
        'response_format': {'type': 'json_object'},
    }))
    # magi2 の Enthusiast：推論を切る、揺らぎの最大温度、top_p、画像付きの発言
    message_content(post_json(url, api_key, {
        'model': model,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': 'Name the color of this image in one word.'},
            {'type': 'image_url', 'image_url': {'url': solid_png_data_url()}},
        ]}],
        'thinking': {'type': 'disabled'},
        'temperature': PERSONA_MAX_TEMPERATURE,
        'top_p': 1.0,
        'max_tokens': 16,
    }))
    return 'JSON、推論なし/画像/高温/top_p'


def smoke_google(url, api_key, model):
    # magi2 の Humanist：推論は最小（Gemini 3 系は切れない）、揺らぎの最大温度、top_p、画像付きの発言。
    # 推論トークンも max_tokens に数えるので、本番と同じく余裕を持たせる
    message_content(post_json(url, api_key, {
        'model': model,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': 'Name the color of this image in one word.'},
            {'type': 'image_url', 'image_url': {'url': solid_png_data_url()}},
        ]}],
        'reasoning_effort': 'minimal',
        'temperature': PERSONA_MAX_TEMPERATURE,
        'top_p': 1.0,
        'max_tokens': 1024,
    }))
    return '推論minimal/画像/高温/top_p'


# プロバイダー固有の知識はここだけに置き、正本にはモデルIDと表示名を持つ。
# channels の値は版番号を抜き出すパターンで、より新しい版がモデル一覧に出たら更新候補にする。
# None はIDが固定のエイリアス。互換性に加え、公式のモデル詳細で背後の版も確認する。
PROVIDERS = {
    'openai': {
        'key_env': 'OPENAI_API_KEY',
        'models_url': 'https://api.openai.com/v1/models',
        'chat_url': 'https://api.openai.com/v1/chat/completions',
        'channels': {'luna': re.compile(r'gpt-(\d+(?:\.\d+)*)-luna')},
        'display_name_template': 'GPT-{version} Luna',
        'smoke': smoke_openai,
    },
    'deepseek': {
        'key_env': 'DEEPSEEK_API_KEY',
        'models_url': 'https://api.deepseek.com/models',
        'chat_url': 'https://api.deepseek.com/chat/completions',
        'display_names_url': 'https://api-docs.deepseek.com/quick_start/pricing/',
        'channels': {'flash': None},
        'smoke': smoke_deepseek,
    },
    # Gemini の OpenAI 互換の口。一覧のIDは 'models/' 付きで返ることがあるので fetch_models で外す
    'google': {
        'key_env': 'GEMINI_API_KEY',
        'models_url': 'https://generativelanguage.googleapis.com/v1beta/openai/models',
        'chat_url': 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        'channels': {'flash_lite': re.compile(r'gemini-(\d+(?:\.\d+)*)-flash-lite')},
        'display_name_template': 'Gemini {version} Flash-Lite',
        'smoke': smoke_google,
    },
}


def validate_registry(registry):
    if not isinstance(registry, dict):
        return ['正本がJSONオブジェクトではありません']
    errors = []
    for provider, channels in registry.items():
        if not isinstance(channels, dict):
            errors.append(f'{provider}: 値は「チャネル → モデル設定」のオブジェクトにしてください')
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
            entry = registry[provider][channel]
            if set(entry) - {'id', 'display_name'}:
                errors.append(f'{provider}.{channel}: 未定義のモデル設定があります')
            display_name = entry.get('display_name')
            if not isinstance(display_name, str) or not display_name.strip():
                errors.append(f'{provider}.{channel}: 表示名が必要です')
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
    return {m['id'].removeprefix('models/'): m for m in models if isinstance(m, dict) and m.get('id')}


def version_key(pattern, model):
    parts = [int(part) for part in pattern.fullmatch(model).group(1).split('.')]
    while len(parts) > 1 and parts[-1] == 0:  # gpt-6 と gpt-6.0 を同じ版として扱う
        parts.pop()
    return tuple(parts)


def versioned_display_name(pconf, channel, model):
    # 対象は上の channels で限定した系列だけ。公式の系列名にIDの版番号を組み合わせる。
    match = pconf['channels'][channel].fullmatch(model)
    if not match:
        raise RuntimeError(f'表示名を組み立てられないモデルIDです: {model}')
    return pconf['display_name_template'].format(version=match.group(1))


class ModelDetailsParser(HTMLParser):
    """公式ページの表を読む。モデル列と版の行を対応させ、本文や脚注からは推測しない。"""

    def __init__(self):
        super().__init__()
        self.tables = []
        self.depth = 0
        self.rows = []
        self.row = None
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self.depth += 1
            if self.depth == 1:
                self.rows = []
        elif self.depth == 1:
            if tag == 'tr':
                self.row = []
            elif tag in ('td', 'th') and self.row is not None:
                self.cell = []

    def handle_data(self, data):
        if self.depth == 1 and self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag == 'table':
            if self.depth == 1:
                self.tables.append(self.rows)
            self.depth = max(0, self.depth - 1)
        elif self.depth == 1:
            if tag in ('td', 'th') and self.cell is not None:
                self.row.append(' '.join(''.join(self.cell).split()))
                self.cell = None
            elif tag == 'tr' and self.row is not None:
                self.rows.append(self.row)
                self.row = None


def parse_deepseek_display_name(html, model):
    parser = ModelDetailsParser()
    parser.feed(html)
    names = set()
    for rows in parser.tables:
        headers = [row for row in rows if row and row[0].upper() in ('MODEL', '模型')]
        versions = [row for row in rows if row and row[0].upper() in ('MODEL VERSION', '模型版本')]
        for header in headers:
            columns = [i for i, cell in enumerate(header[1:], 1)
                       if re.search(rf'(?<![\w.-]){re.escape(model)}(?![\w.-])', cell)]
            for row in versions:
                for column in columns:
                    if len(row) != len(header):
                        raise RuntimeError('DeepSeek: 公式のモデル詳細の列数が一致しません')
                    version = row[column]
                    if not re.fullmatch(r'DeepSeek-V\d+(?:\.\d+)*-Flash(?:-[A-Za-z0-9]+)*', version):
                        raise RuntimeError(f'DeepSeek: 公式の Flash モデル版を解釈できません: {version}')
                    names.add(version.removeprefix('DeepSeek-').replace('-', ' '))
    if len(names) != 1:
        raise RuntimeError(f'DeepSeek: {model} に対応する版を公式のモデル詳細から一意に取得できません')
    return names.pop()


def fetch_deepseek_display_name(url, model):
    request = urllib.request.Request(url, headers={
        'Accept': 'text/html', 'User-Agent': 'tk.st-ai-model-watch/1.0',
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            html = response.read().decode('utf-8')
    except (OSError, UnicodeError) as e:
        raise RuntimeError(f'DeepSeek: 公式のモデル詳細の取得に失敗: {e}') from e
    return parse_deepseek_display_name(html, model)


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
    workers_to_deploy = set()

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
            entry = registry[provider][channel]
            current = model_id(provider, channel, registry)
            live = by_id.get(current)
            if not live:
                problems.append(f'{label}: 現在のモデル {current} が一覧にありません')
            elif live.get('shutdown_date'):
                problems.append(f'{label}: {current} の停止予定日は {live["shutdown_date"]}')
            status = '' if live else '（⚠ 一覧にない）'
            if pattern is None:
                report.append(f'- {label}: エイリアス `{current}`{status}')
                if not live:
                    continue
                try:
                    display_name = fetch_deepseek_display_name(pconf['display_names_url'], current)
                    if display_name != entry.get('display_name'):
                        detail = pconf['smoke'](pconf['chat_url'], api_key, current)
                        changes.append(f'{label}: 表示名 `{entry.get("display_name")}` → `{display_name}`（スモークテスト合格: {detail}）')
                        entry['display_name'] = display_name
                        workers_to_deploy.add('magi2')
                    report.append(f'- {label}: 実モデル `{display_name}`（出典: {pconf["display_names_url"]}）')
                except RuntimeError as e:
                    problems.append(str(e))
                    report.append(f'- {label}: 表示名の更新を見送り（{e}）。前回の表示名を保持します。')
                continue

            # 現在のモデルが一覧から消えていても、後継の候補は探す
            newer = [m for m in by_id if pattern.fullmatch(m)
                     and version_key(pattern, m) > version_key(pattern, current)]
            if not newer:
                report.append(f'- {label}: 最新 `{current}`{status}')
                continue
            candidate = max(newer, key=lambda m: version_key(pattern, m))
            try:
                display_name = versioned_display_name(pconf, channel, candidate)
                detail = pconf['smoke'](pconf['chat_url'], api_key, candidate)
            except RuntimeError as e:
                problems.append(f'{label}: 更新候補 {candidate} がスモークテストに失敗: {e}')
                report.append(f'- {label}: 更新候補 `{candidate}` はスモークテスト失敗のため見送り（現在 `{current}`{status}）')
                continue
            entry['id'] = candidate
            entry['display_name'] = display_name
            workers_to_deploy.update(('magi2', 'games', 'dj-request') if provider == 'openai' else ('magi2',))
            changes.append(f'{label}: `{current}` → `{candidate}`（スモークテスト合格: {detail}）')
            report.append(f'- {label}: 更新候補 `{current}` → `{candidate}`')

    report.extend(['', '## 変更', ''])
    if changes:
        report.extend(f'- {change}' for change in changes)
        report.extend([
            '',
            '## マージ後の反映',
            '',
            'GitHub Actionsの生成処理はmainへの反映後から新設定を使います。表示名だけの変更ではAPI用のIDは変わりません。',
            '変更が関係するCloudflare Workerを手動デプロイしてください（正本のJSONはデプロイ時に取り込まれる）。',
            '',
            '```bash',
            'cd workers',
            *(f'npx wrangler deploy --config {worker}/wrangler.toml' for worker in sorted(workers_to_deploy)),
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
    sub.add_parser('update', help='モデル一覧と公式のモデル詳細から新しい版・表示名を探し、スモークテストに通れば正本を更新する')
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
