#!/usr/bin/env python3
"""日刊ニュースの内容判定。Jevの1問で判定し、ニトリはブランド名でも候補を救済する。"""

from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import math
import sys
import unicodedata
import urllib.error
import urllib.request

from ai_model_registry import model_id
from nitori_social_filter import ClassificationError, ENDPOINT, api_key
from typesafe_alert import notify_http_error

MIN_PROBABILITY = 0.5
TIMEOUT_SECONDS = 8
MAX_WORKERS = 4

# 比較テストと実運用で同じ採否基準を読む。
POLICIES = {
    'nitori': {
        'question': 'このニュースは、ニトリグループの商品・店舗・買い物・事業について、日刊ニトリの掲載対象となる具体的な情報を伝えているか？',
        'true': 'ニトリ、デコホーム、島忠、シマホ、N+（N＋）の新商品・商品改善・使い方・生活者の反響、出店・海外展開、EC・アプリ・DX、物流・自動化、価格戦略・経営戦略についての具体的な報道。公式の新商品発表や出店発表も対象。他社との比較はニトリについての具体的な情報があれば対象。決算記事でも出店・物流・価格戦略など事業の新しい情報が中心なら対象。',
        'false': 'ニトリへの言及が脇役で他社だけのニュース、無関係な同名の人物・キャラクター・不動産サイト、スポーツ結果、懸賞募集・応募・当選、アフィリエイト購入誘導が中心の広告、一般的なレシピ・スイーツ情報、定型的な人事異動・機構改革・法定届出、株価予想・投資推奨、数字だけの決算短信・業績予想。記事中にない内容を推測して関連付けない。',
    },
    'retail': {
        'question': 'このニュースは、小売・流通のテクノロジー、DX、店舗の革新、またはそれらへの生活者の反響について、日刊リテールテックの掲載対象となる具体的な情報を伝えているか？',
        'true': '小売・流通でのスマートカート、セルフレジ・無人決済、リテールメディア、店頭サイネージ、電子棚札、RFID、物流・ロボティクス、需要予測・自動発注・AI、価格最適化、EC・オムニチャネルなどの導入、実証、改善、事業戦略、技術動向の解説・調査・専門イベント。セルフレジや店舗技術の使い勝手への生活者の賛否も対象。公式の導入発表や、決算・商品キャンペーンに伴う具体的な技術導入も対象。',
        'false': '技術や店舗の革新と無関係な小売企業のニュース、食品新メニュー・レシピ・スイーツ・セール・懸賞、定型的な人事異動・機構改革・法定届出、数字だけの決算・株価・投資推奨。一般のAI・IT記事で小売や流通での活用がないもの。スーパーが超大型という意味、カートが競技車という意味などの同名別物。記事中にない導入や活用を想像しない。',
    },
}


def state_for(item):
    # 比較テストで検証したRSSの情報だけを使い、記事全文やリンク先は補完しない。
    return {name: item.get(name, '') for name in ('title', 'description', 'source')}


def question_for(media, variant='criteria'):
    policy = POLICIES[media]
    question = {'type': 'noul', 'instructions': policy['question']}
    if variant == 'criteria':
        question['criteria'] = {name: policy[name] for name in ('true', 'false')}
    return question


def request_payload(state, model, media='retail'):
    return {'model': model, 'state': state, 'questions': {'publishable': question_for(media)}}


def parse_probability(body):
    try:
        answer = body['answers']['publishable']
        probability = answer['noul']
        if (answer['type'] != 'noul' or type(probability) not in (int, float)
                or not 0 <= probability <= 1 or not math.isfinite(probability)):
            raise ValueError()
        return probability
    except (KeyError, TypeError, ValueError) as error:
        raise ClassificationError('不正なニュース判定応答') from error


def classify(state, key, model, media='retail'):
    request = urllib.request.Request(
        ENDPOINT, data=json.dumps(request_payload(state, model, media), ensure_ascii=False).encode('utf-8'),
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return parse_probability(json.load(response))
    except urllib.error.HTTPError as error:
        notify_http_error(error)
        raise ClassificationError(f'HTTP {error.code}') from error
    except (http.client.HTTPException, OSError, ValueError) as error:
        # 記事・キー・上流の応答本文をログに載せない。
        raise ClassificationError(type(error).__name__) from error


def filter_news(items, label, *, fallback_fn, media, rescue_fn=None):
    """順序を保って内容だけ判定。通信・設定の失敗時は当該記事に従来ルールを使う。"""
    if not items:
        return []

    def retain(item, judgement):
        if rescue_fn:
            # 候補内だけの判定情報。再判定時には古い救済状態を上書きする。
            item['_news_judgement'] = judgement
        return item

    try:
        model, key = model_id('typesafe', 'jev'), api_key()
    except Exception as error:
        print(f'[WARN] {label} Jev設定を読み込めないため従来ルールを使います: {type(error).__name__}', file=sys.stderr)
        return [retain(item, 'rule') for item in items if fallback_fn(item)]
    if not key:
        print(f'[WARN] {label} TYPESAFE_API_KEY未設定: 従来ルールを使います', file=sys.stderr)
        return [retain(item, 'rule') for item in items if fallback_fn(item)]

    # 同一見出し・説明・配信元には同じ判定を使い、別URLでも呼び出しを重ねない。
    states = {json.dumps(state_for(item), ensure_ascii=False, sort_keys=True): state_for(item) for item in items}

    def judge(pair):
        identity, state = pair
        try:
            return identity, classify(state, key, model, media)
        except ClassificationError as error:
            print(f'[WARN] {label} Jevニュース判定失敗（当該記事に従来ルールを使用）: {error}', file=sys.stderr)
            return identity, None

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        probabilities = dict(pool.map(judge, states.items()))
    kept, fallback_count, rescue_count = [], 0, 0
    for item in items:
        identity = json.dumps(state_for(item), ensure_ascii=False, sort_keys=True)
        probability = probabilities[identity]
        if probability is None:
            fallback_count += 1
            accepted = fallback_fn(item)
            judgement = 'rule'
        else:
            accepted = probability >= MIN_PROBABILITY
            judgement = 'jev'
            # 成功したNGだけを救済する。API障害時は従来ルールの結果をそのまま使う。
            if not accepted and rescue_fn and rescue_fn(item):
                accepted = True
                rescue_count += 1
                judgement = 'brand_rescue'
        if accepted:
            kept.append(retain(item, judgement))
    rescue_summary = f' / ブランド名で救済 {rescue_count}件' if rescue_fn else ''
    print(f' -> {label} Jevニュース内容判定: {len(kept)}/{len(items)}件を採用（従来ルール使用 {fallback_count}件{rescue_summary}）')
    return kept


def has_nitori_brand(item):
    """見出し・RSS説明内の指定ブランド名を確認。英字の大小と全角の＋を揃える。"""
    text = unicodedata.normalize('NFKC', '\n'.join(item.get(name, '') for name in ('title', 'description'))).casefold()
    return any(brand in text for brand in ('ニトリ', '島忠', 'デコホーム', 'n+', 'nitori'))


def news_judgement_priority(item):
    """見出し重複・件数上限では、Jev採用、従来ルール、ブランド救済の順に残す。"""
    return {'jev': 2, 'rule': 1, 'brand_rescue': 0}.get(item.get('_news_judgement'), 1)


def filter_retail_news(items, label, *, fallback_fn):
    return filter_news(items, label, fallback_fn=fallback_fn, media='retail')


def filter_nitori_news(items, label, *, fallback_fn):
    return filter_news(items, label, fallback_fn=fallback_fn, media='nitori', rescue_fn=has_nitori_brand)
