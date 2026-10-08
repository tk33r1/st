#!/usr/bin/env python3
"""AIモデルの正本の検査、更新検知、APIスモークテスト。"""

import argparse
import base64
import json
import math
import os
import re
import struct
import subprocess
import sys
import urllib.error
import urllib.request
import zlib
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

from ai_model_registry import REGISTRY_PATH, REPO_ROOT, load_registry, model_id
from typesafe_alert import notify_http_error


# クォートの有無を問わず拾う（YAML の値はクォートなしで書けるため）。
MODEL_LITERAL_RE = re.compile(
    r'(?<![\w.-])(?:'
    r'gpt-[0-9][a-z0-9._-]*|o[1-9](?:-(?:mini|pro|preview)[a-z0-9._-]*)?|'
    r'deepseek-[a-z0-9._-]+|claude-[a-z0-9._-]+|gemini-[a-z0-9._-]+|'
    r'mistral-[a-z0-9._-]+|grok-[a-z0-9._-]+|command-r[a-z0-9._-]*|llama-[a-z0-9._-]+|jev-[a-z0-9._-]+'
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
        if url == 'https://api.typesafe.ai/v1/systemone':
            notify_http_error(e)
            raise RuntimeError(f'TypeSafe HTTP {e.code}') from e
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
    config = magi_config()
    smoke_magi_discussion(url, api_key, model, 'openai', config)
    observations = smoke_openai_site_search(url, api_key, model, config)
    print('サイト選択smoke（日刊検索の有無は合否に使わない）: ' + json.dumps(observations, ensure_ascii=False))
    smoke_openai_debate_judge(url, api_key, model, config['judge'])
    smoke_openai_magi(url, api_key, model, config['magi'])
    smoke_openai_web_search(api_key, model)
    return 'JSON/medium、JSON/非推論、MAGI人格・統合/本番設定/サイト候補/画像/stream、サイト選択/requested・auxiliary/daily両形、討議判定・MAGI議題化・票読取/strictスキーマ、Web検索強制/推論/JSONスキーマ'


def magi_config():
    """magi2 の本番の設定（personas.js）を Node で読み出す。"""
    return json.loads(subprocess.check_output(
        ['node', str(REPO_ROOT / '.github/scripts/magi-search-config.mjs')], encoding='utf-8'))


def smoke_magi_discussion(url, api_key, model, provider, config=None):
    """本番のrequestBodyで組んだ3人格・統合。候補モデルを試すときはIDだけ置換する。"""
    config = config if config is not None else magi_config()
    for persona in config['discussion']['personas']:
        if persona['provider'] != provider:
            continue
        body = {**persona['body'], 'model': model}
        # 画像なしのサイト案内と、既存の画像入力の疎通を両方残す。
        # 本番の人格呼出しは、上限終了でも空でない受信済み本文を使う。
        message_content(post_json(url, api_key, body))
        image_body = {**body, 'messages': [*body['messages'], {'role': 'user', 'content': [
            {'type': 'text', 'text': 'Name the color of this image in one word.'},
            {'type': 'image_url', 'image_url': {'url': solid_png_data_url()}},
        ]}]}
        message_content(post_json(url, api_key, image_body))
    synth = config['discussion']['synthesizer']
    if synth['provider'] == provider:
        post_json(url, api_key, {**synth['body'], 'model': model}, stream=True)


def smoke_openai_debate_judge(url, api_key, model, config):
    """magi2 の討議の判定（DEBATE）：推論 low（temperature は送れない）、enum と配列を含む strict な JSON スキーマ。"""
    expected = {'assessment': '前提が割れている', 'action': 'ask',
                'questions': [{'target': 'CASPER-3', 'question': '予算の上限は？'}]}
    response = post_json(url, api_key, {
        'model': model, 'stream': False, 'store': False,
        'messages': [{'role': 'user', 'content': 'Return exactly this JSON: ' + json.dumps(expected, ensure_ascii=False)}],
        'reasoning_effort': config['model']['reasoning_effort'],
        'max_completion_tokens': config['model']['max_tokens'],
        'response_format': config['format'],
    })
    choice = response.get('choices', [{}])[0]
    if choice.get('finish_reason') != 'stop' or choice.get('message', {}).get('refusal'):
        raise RuntimeError('討議の判定の応答が正常完了しませんでした')
    if json.loads(message_content(response)) != expected:
        raise RuntimeError('討議の判定のスキーマ疎通で期待した応答が得られませんでした')


def smoke_openai_magi(url, api_key, model, config):
    """採決の議題化と票読取。本番のスキーマ・推論・上限を使う疎通確認。"""
    for name in ('motion', 'vote_reader'):
        cfg = config[name]
        response = post_json(url, api_key, {**cfg['body'], 'model': model})
        choice = response.get('choices', [{}])[0]
        if choice.get('finish_reason') != 'stop' or choice.get('message', {}).get('refusal'):
            raise RuntimeError('MAGI ' + name + ' の応答が正常完了しませんでした')
        value = json.loads(message_content(response))
        if name == 'motion':
            if value.get('votable') is not True or not isinstance(value.get('motion'), str) or not value['motion'].strip():
                raise RuntimeError('MAGI議題化の疎通で期待した応答が得られませんでした')
        else:
            votes = value.get('votes')
            allowed = cfg['format']['json_schema']['schema']['properties']['votes']['items']['properties']
            if not isinstance(votes, list) or any(
                not isinstance(v, dict) or v.get('codename') not in allowed['codename']['enum']
                or v.get('vote') not in allowed['vote']['enum'] for v in votes
            ) or [v.get('vote') for v in votes if v.get('codename') == 'CASPER-3'] != ['reject']:
                raise RuntimeError('MAGI票読取の疎通で期待した応答が得られませんでした')


def smoke_openai_site_search(url, api_key, model, config):
    """404とチャットの本番スキーマ・推論強度・温度・出力上限をそのまま試す。"""
    # 本番の指示では受理・形式・実在IDだけを検査し、dailyの選択は記録する。
    values = []
    for case in config['site_smoke']:
        response = post_json(url, api_key, {**case['body'], 'model': model})
        choice = response.get('choices', [{}])[0]
        if choice.get('finish_reason') != 'stop' or choice.get('message', {}).get('refusal'):
            raise RuntimeError('サイト案内の応答が正常完了しませんでした')
        values.append(json.loads(message_content(response)))
    # 本番の検査を使い、未知ID・壊れたdailyを拒否する。
    # 検索語や選択順の完全一致、リンクの関連性は週次の合否に使わない。
    subprocess.run(['node', str(REPO_ROOT / '.github/scripts/magi-search-config.mjs'), '--validate-site-smoke'],
                   input=json.dumps(values), encoding='utf-8', check=True, capture_output=True)
    # nullableの両側の受理は、判断を求めず固定JSONを返す別の2ケースで守る。
    for case in config['site_schema_smoke']:
        response = post_json(url, api_key, {**case['body'], 'model': model})
        choice = response.get('choices', [{}])[0]
        if choice.get('finish_reason') != 'stop' or choice.get('message', {}).get('refusal'):
            raise RuntimeError('サイト選択のスキーマ疎通が正常完了しませんでした')
        if json.loads(message_content(response)) != case['expected']:
            raise RuntimeError('サイト選択のnullableスキーマ疎通で指定したJSONが得られませんでした')
    return [{'purpose': case['purpose'], 'daily': value['daily'] is not None}
            for case, value in zip(config['site_smoke'], values)]


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
    smoke_magi_discussion(url, api_key, model, 'deepseek')
    return 'JSON、MAGI人格/本番設定/サイト候補/画像あり・なし'


def smoke_google(url, api_key, model):
    smoke_magi_discussion(url, api_key, model, 'google')
    return 'MAGI人格/本番設定/サイト候補/画像あり・なし'


def smoke_magi_classification(url, api_key, model, config=None):
    """分類のchoiceと形式を確認する。採用確信度の閾値は週次の合否に使わない。"""
    config = config if config is not None else magi_config()
    observations = []
    for case in config['classify_smoke']:
        payload = {**case['payload'], 'model': model}
        body = post_json(url, api_key, payload)
        for name, question in payload['questions'].items():
            answer = body.get('answers', {}).get(name, {})
            if not isinstance(answer, dict) or answer.get('type') != question['type']:
                raise RuntimeError(f'Jevの{name}回答のtypeが不正です')
            confidence = answer.get('confidence')
            if answer.get('choice') not in question['criteria'] or not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not (0 <= confidence <= 1):
                raise RuntimeError(f'Jevの{name}回答の形式が不正です')
        for name, expected in case['expected'].items():
            if body['answers'][name]['choice'] != expected:
                raise RuntimeError(f'Jevの{name}が明確なケースの期待値と異なります')
        observations.append({name: {'choice': answer['choice'], 'confidence': answer['confidence']}
                             for name, answer in body['answers'].items() if name in payload['questions']})
    return observations


def smoke_site_rank(url, api_key, model):
    """404のサイト内検索の②。要求は eval-site-rank.mjs が本番の関数と手元の索引で組む（npm の依存を読まない。設計書 10.5）。"""
    config = json.loads(subprocess.check_output(
        ['node', str(REPO_ROOT / '.github/scripts/eval-site-rank.mjs'), '--smoke-payload'], encoding='utf-8'))
    if config['endpoint'] != url:
        raise RuntimeError('サイト内検索の呼び出し先がsmokeと異なります')
    observations = []
    for case in config['cases']:
        payload = {**case['payload'], 'model': model}
        answers = post_json(url, api_key, payload).get('answers')
        answers = answers if isinstance(answers, dict) else {}
        # Workerは判定の欠けた応答を使わない（rankProbability）。全候補の答えが有効かを見る
        probabilities = {}
        for name in payload['questions']:
            answer = answers.get(name)
            value = answer.get('noul') if isinstance(answer, dict) and answer.get('type') == 'noul' else None
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not (0 <= value <= 1):
                raise RuntimeError(f'サイト内検索の{name}の答えが不正です')
            probabilities[name] = value
        query = payload['state']['query']
        if any(probabilities[name] < config['threshold'] for name in case['expect']):
            raise RuntimeError(f'サイト内検索「{query}」で期待するページが閾値未満です')
        observations.append({'query': query, 'expect': {name: probabilities[name] for name in case['expect']},
                             'shown': sum(v >= config['threshold'] for v in probabilities.values())})
    return observations


def smoke_typesafe(url, api_key, model):
    """分類と言語判定、サイト内検索、日刊の採否、DJの相性Scoreを本番の指示・形式で確認する。"""
    observations = smoke_magi_classification(url, api_key, model)
    print('MAGI分類smoke（合成入力・確信度に採用閾値なし）: ' + json.dumps(observations, ensure_ascii=False))
    observations = smoke_site_rank(url, api_key, model)
    print('サイト内検索smoke（閾値以上の件数は合否に使わない）: ' + json.dumps(observations, ensure_ascii=False))
    from nitori_social_filter import MIN_PROBABILITY, parse_probability, request_payload
    social_cases = [
        ('ニトリのテレビ台を買った。配線が隠せて便利！', True),
        ('母へのプレゼントにニトリのクッションを買った。喜んでくれた。', True),
        ('【PR】ニトリ様からいただいたテレビ台を紹介します。購入はこちら！', False),
        ('ニトリの配当とPERを見て100株買った。決算が楽しみ。', False),
    ]
    for text, expected in social_cases:
        body = post_json(url, api_key, request_payload({'platform': 'x', 'author': '@consumer', 'text': text}, model))
        if (parse_probability(body) >= MIN_PROBABILITY) != expected:
            raise RuntimeError('日刊ニトリのSNS採否が期待と異なります')
    import daily_news_filter as news_gate
    news_cases = [
        ('スイーツ売り場に電子棚札、スーパーが実証開始', '棚札更新の省力化と時間帯別値下げを検証。', True),
        ('Grocery chain deploys dynamic pricing and electronic shelf labels', 'Prices are updated by demand forecasts.', True),
        ('コンビニが秋の新メニュー、限定スイーツを発売', '季節限定の商品だけを紹介。', False),
        ('生成AIで詩を書こう、プロンプト入門', '個人の文章作成を解説。小売・物流の活用は扱わない。', False),
    ]
    for title, description, expected in news_cases:
        body = post_json(url, api_key, news_gate.request_payload(
            news_gate.state_for({'title': title, 'description': description, 'source': ''}), model,
        ))
        if (news_gate.parse_probability(body) >= news_gate.MIN_PROBABILITY) != expected:
            raise RuntimeError('リテールテックのニュース採否が期待と異なります')
    nitori_news_cases = [
        ('Nitori opens a new store in Vietnam', 'The furniture retailer expands its store network.', True),
        ('ニトリグループのN＋、新店舗をオープン', '婦人服ブランドが出店し新商品を展開。', True),
        ('ニトリ株の目標株価と投資判断', '株価予想と投資推奨のみ。商品・店舗・事業の新しい情報はない。', False),
        ('河城にとりが登場するゲームを紹介', '東方Projectのキャラクター紹介。家具小売とは無関係。', False),
    ]
    # ブランド名の救済とは別に、モデル自体の採否を確認する。
    for title, description, expected in nitori_news_cases:
        body = post_json(url, api_key, news_gate.request_payload(
            news_gate.state_for({'title': title, 'description': description, 'source': ''}), model, 'nitori',
        ))
        if (news_gate.parse_probability(body) >= news_gate.MIN_PROBABILITY) != expected:
            raise RuntimeError('ニトリのニュース採否が期待と異なります')
    # 2026-10-04の実曲比較で承認されたHome→Battle Scars／ロッキーのテーマ。
    # 質問はWorkerの正本を読む。曲名はstateへ送らない。
    import importlib.util
    spec = importlib.util.spec_from_file_location('dj_transition_eval', REPO_ROOT / '.github/scripts/eval-dj-transitions.py')
    dj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dj)
    home = dict(title='Home', artist='', variant='', genre='ポップ', originalYear=2026, releaseYear=2026,
                bpm=93.9, camelot='5B', songKey='Eb', bpmSrc='est', keySrc='est')
    candidates = [
        dict(title='Battle Scars', artist='', variant='', genre='ヒップホップ／ラップ', originalYear=2012,
             releaseYear=2012, bpm=84, camelot='5B', songKey='Eb', bpmSrc='deezer', keySrc='est'),
        dict(title='ロッキーのテーマ', artist='', variant='', genre='クラシック', originalYear=1976,
             releaseYear=2015, bpm=98.2, camelot='8A', songKey='Am', bpmSrc='est', keySrc='est'),
    ]
    pairs = [{'from': home, 'to': candidate} for candidate in candidates]
    scores = []
    for pair, features in zip(pairs, dj.current_features(pairs)):
        pair['features'] = features
        body = post_json(url, api_key, {'model': model, 'state': dj.state_for(pair, 'anonymous'),
                                       'questions': {'transition': dj.QUESTION}})
        scores.append(dj.parse_score(body)[0])
    if scores[0] <= scores[1]:
        raise RuntimeError('DJの実曲Scoreの順位が承認された比較と異なります')
    return 'MAGI分類/初回4問・継続3問/votable yes・no、言語/日英・短い返事/DJ・旧画面、サイト内検索/noul/全候補・日英3問、SNS採否/noul/テレビ台・贈り物・PR・株、ニュース採否/noul/リテール技術・食品のみ・一般AI、ニトリ出店・N＋・投資・同名別物、DJ相性/score/BPM・キー・年代・ジャンル'


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
    # 判定専用のモデル（文章を生成しない）。モデル一覧の API が無く、jev-latest は版を追う固定のエイリアスなので、
    # 更新の監視はせず、スモークテストだけを毎週行う。chat_url は判定の口（スモークテストの呼び出し先）
    'typesafe': {
        'key_env': 'TYPESAFE_API_KEY',
        'chat_url': 'https://api.typesafe.ai/v1/systemone',
        'channels': {'jev': None},
        'watch': False,
        'smoke': smoke_typesafe,
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
        if not pconf.get('watch', True):
            report.extend(f'- {provider}.{channel}: エイリアス `{model_id(provider, channel, registry)}`（更新の監視なし。スモークテストのみ）'
                          for channel in pconf['channels'])
            continue
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
