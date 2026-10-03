#!/usr/bin/env python3
"""日刊ニトリのSNS内容判定。1投稿・1問、失敗した投稿は採用しない。"""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

from ai_model_registry import model_id

ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
QUESTION = 'この投稿は、生活者がニトリの商品・店舗・買い物について語っている投稿か（懸賞・広告・株の話・同じ名前の別物ではないか）？'
CONSUMER_QUESTION = {
    'type': 'noul', 'instructions': QUESTION,
    'criteria': {
        'true': '一般の生活者による、ニトリ（デコホーム・島忠・シマホを含む）の商品の使用、購入、比較、感想、不満、買い物相談、来店や店舗の利便性についての投稿。肯定・否定どちらも対象。商品を買って誰かに贈る話や、他店との比較も対象。',
        'false': '懸賞の募集・応募・当選報告、企業公式の販促、PR案件・アフィリエイトなどの広告、株式・投資・決算、採用・経営者・スポーツの話、同名の人物・キャラクターなど別物。ニトリという語やタグがあるだけで商品・店舗・買い物の話だと分からない投稿。',
    },
}
MIN_PROBABILITY = 0.5
TIMEOUT_SECONDS = 8
MAX_WORKERS = 4
CACHE_FIELD = 'consumer_filter'


class ClassificationError(RuntimeError):
    """本文・キー・上流の応答内容を含めない、安全にログへ出せるエラー。"""


def api_key():
    for name in ('TYPESAFE_API_KEY', 'MAGI_TYPESAFE_API_KEY'):
        if os.environ.get(name, '').strip():
            return os.environ[name].strip()
    # 手元での確認用。Actionsは環境変数だけを使う。
    path = Path(__file__).resolve().parents[2] / 'workers/magi2/.dev.vars'
    if path.exists():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            match = re.match(r'^\s*(?:export\s+)?MAGI_TYPESAFE_API_KEY\s*=\s*(.*?)\s*$', line)
            if match:
                value = match[1].strip().strip('"\'')
                if value:
                    return value
    return ''


def state_for(item):
    text = str(item.get('raw_text') or item.get('text') or '').strip()
    tags = item.get('hashtags') or []
    if isinstance(tags, str):
        tags = [tags]
    # 本文にないタグも関連性の手掛かりにする。投稿には含まれない推測を足さない。
    extra_tags = ' '.join(str(t) for t in tags if str(t) not in text)
    return {'platform': item.get('platform', ''), 'author': item.get('author_handle') or item.get('author', ''),
            'text': (text + ' ' + extra_tags).strip()}


def request_payload(state, model, question=None):
    return {'model': model, 'state': state,
            'questions': {'consumer_post': question or CONSUMER_QUESTION}}


def parse_probability(body):
    try:
        answer = body['answers']['consumer_post']
        value = answer['noul']
        if answer['type'] != 'noul' or type(value) not in (int, float) or not 0 <= value <= 1 or not math.isfinite(value):
            raise ValueError()
        return value
    except (KeyError, TypeError, ValueError) as error:
        raise ClassificationError('不正な判定応答') from error


def classify(state, key, model):
    request = urllib.request.Request(
        ENDPOINT, data=json.dumps(request_payload(state, model), ensure_ascii=False).encode('utf-8'),
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return parse_probability(json.load(response))
    except urllib.error.HTTPError as error:
        raise ClassificationError(f'HTTP {error.code}') from error
    except (http.client.HTTPException, OSError, ValueError) as error:
        raise ClassificationError(type(error).__name__) from error


def _signature(state, model):
    # 本文・投稿者・質問・モデル・閾値が同じ判定だけを再利用する。
    data = {'request': request_payload(state, model), 'threshold': MIN_PROBABILITY}
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()


def filter_consumer_posts(items, label):
    """人気順は変えず、内容の採否だけを決める。上位件数に絞る前に呼ぶ。"""
    if not items:
        return []
    try:
        model, key = model_id('typesafe', 'jev'), api_key()
    except Exception as error:
        print(f'[WARN] {label} Jev設定を読み込めないため投稿を採用しません: {type(error).__name__}', file=sys.stderr)
        return []

    def judge(item):
        state = state_for(item)
        if not state['text']:
            return None, 'empty'
        signature = _signature(state, model)
        cached = item.get(CACHE_FIELD)
        if isinstance(cached, dict) and cached.get('signature') == signature:
            p = cached.get('probability')
            if type(p) in (int, float) and 0 <= p <= 1 and math.isfinite(p):
                return (item if p >= MIN_PROBABILITY else None), 'cached'
        if not key:
            return None, 'missing_key'
        try:
            p = classify(state, key, model)
        except ClassificationError as error:
            # 本文・投稿者・キー・上流の応答本文はログへ出さない。
            print(f'[WARN] {label} Jev判定失敗（この投稿は不採用）: {error}', file=sys.stderr)
            return None, 'failed'
        if p < MIN_PROBABILITY:
            return None, 'rejected'
        accepted = dict(item)
        accepted[CACHE_FIELD] = {'signature': signature, 'probability': p}
        return accepted, 'accepted'

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        results = list(pool.map(judge, items))
    missing = sum(status == 'missing_key' for _, status in results)
    if missing:
        print(f'[WARN] {label} TYPESAFE_API_KEY未設定: 未判定の{missing}件を採用しません', file=sys.stderr)
    kept = [item for item, _ in results if item is not None]
    cached = sum(status == 'cached' for _, status in results)
    failed = sum(status == 'failed' for _, status in results)
    print(f' -> {label} Jev内容判定: {len(kept)}/{len(items)}件を採用（判定再利用 {cached}件 / 失敗 {failed}件）')
    return kept
