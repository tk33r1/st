#!/usr/bin/env python3
"""両日刊のニュース内容の採否を、現行ルールとJevの1問で比較する。

--prepare PATH で除外前RSSと作例を保存し、実記事のexpected/reasonを先に付ける。
--input PATH --output PATH で短問と採否基準付きの質問を評価する。
本文や結果はOSの一時ディレクトリへ保存する。本番の発行処理は呼ばない。
日付・重複・順位・最終記事選定は、この内容判定の比較に含めない。
"""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics
import sys
import time
import urllib.error
import urllib.request

from ai_model_registry import model_id
from daily_news_filter import POLICIES, parse_probability, question_for, state_for
from daily_engine import (DEFAULT_GLOBAL_NOISE_BLACKLIST, DEFAULT_JP_NOISE_BLACKLIST,
                          JST, fetch_google_news_rss, filter_and_dedup_news, noise_blacklist)
from nitori_social_filter import ENDPOINT, api_key

ROOT = Path(__file__).resolve().parents[2]


def load_media(filename):
    spec = importlib.util.spec_from_file_location(filename, ROOT / '.github/scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CONFIG


MEDIA = {'nitori': load_media('generate-nitori-daily.py'),
         'retail': load_media('generate-retail-tech-daily.py')}

# 実記事と分けて集計する、APIを見ずに採否を付けた境界事例。
# (媒体, 採否, 分類, 見出し, 説明, 海外記事)
BOUNDARIES = [
    ('nitori', True, '商品', 'ニトリ、工具なしで組み立てられるテレビ台を発売', '省スペースでも配線しやすい構造を採用した。', False),
    ('nitori', True, '除外語と商品', 'ニトリ、スイーツ作りに使える耐熱保存容器を発売', 'オーブンと冷凍保存の両方に対応する新商品。', False),
    ('nitori', True, '除外語と商品', 'プレゼントにも便利、ニトリの新しい食器シリーズ登場', '軽量化と割れにくさを両立した素材を採用。', False),
    ('nitori', True, '決算と戦略', 'ニトリ決算短信：新物流拠点の自動化計画を発表', 'ロボット導入で配送日数を短縮し、翌年度に海外店舗を増やす計画。', False),
    ('nitori', True, '関連ブランド海外', 'Shimachu deploys automated picking robots in its distribution center', 'The furniture retailer announces a new logistics system to shorten delivery time.', True),
    ('nitori', True, '関連ブランド', 'シマホ、店舗受け取りサービスをアプリで予約可能に', '島忠が店頭受け取りの待ち時間を短縮。', False),
    ('nitori', True, '比較', 'IKEAとニトリの収納棚、耐荷重と組み立てやすさを比較', '同サイズの商品を購入し、使用感を検証。', False),
    ('nitori', True, '生活者反響', 'ニトリの収納ボックス、持ち手の変更にSNSで賛否', '旧製品との違いを利用者が比較し、使い勝手に反応。', False),
    ('nitori', True, '経営者と戦略', '似鳥会長、海外出店と価格維持の戦略を語る', '為替変動に対応した調達と物流改革を説明。', False),
    ('nitori', True, 'キャンペーンと技術', 'ニトリ、キャンペーン開催に合わせアプリの在庫検索を刷新', '店舗ごとの在庫をリアルタイムに確認できる新機能を導入。', False),
    ('nitori', False, '懸賞', 'ニトリ商品券をプレゼント！フォローとリポストで応募', '抽選で10名に当たる。', False),
    ('nitori', False, '投資', 'ニトリ株は買い時？円高を見込んだ投資戦略', '株価の予想と売買タイミングを解説。', False),
    ('nitori', False, '数字のみ', 'ニトリ、通期営業利益が前年比5％増', '売上と利益の数字だけを伝える決算短信。', False),
    ('nitori', False, '人事', 'ニトリホールディングスの人事異動一覧', '各部署の部長の異動と発令日を掲載。', False),
    ('nitori', False, '同名人物', '河城にとりの新グッズ発売、ファン注目', '東方Projectのキャラクター。検索タグはニトリ。', False),
    ('nitori', False, '同名サイト', 'ホームズ、賃貸マンションの家賃相場を発表', 'LIFULL HOME’Sの不動産情報。', False),
    ('nitori', False, '言及のみ', 'ユニクロが新しい物流センターを開設', '会場はニトリの店舗の向かい。ユニクロの配送体制だけを説明。', False),
    ('nitori', False, '他社のみ', 'IKEA opens new stores and installs warehouse robots', 'IKEA announces its expansion and automation plans. Nitori is not involved.', True),
    ('nitori', False, '広告', 'ニトリのおすすめ品を買うなら今！購入リンクはこちら', '紹介者に報酬が入るリンクへの誘導が中心で、新しい商品情報はない。', False),
    ('nitori', False, 'スポーツ', 'ニトリ所属選手が大会で優勝', 'ゴルフ大会の結果を伝える。店舗や商品とは無関係。', False),
    ('retail', True, '技術導入', 'スーパー、AI需要予測で食品廃棄を削減', '販売データから店舗別の発注数量を自動計算する。', False),
    ('retail', True, '除外語と技術', 'スイーツ売り場に電子棚札、スーパーが実証開始', '棚札更新の省力化と時間帯別値下げを検証。', False),
    ('retail', True, '除外語と技術', '新メニューの需要をAIで予測、コンビニが自動発注を導入', '新商品発売時の欠品と廃棄を減らす。', False),
    ('retail', True, '除外語と技術', 'プレゼントキャンペーンに購買データを活用、小売の広告基盤を刷新', '会員IDと店舗POSを連携し、リテールメディアの効果を計測。', False),
    ('retail', True, '決算と技術', 'Retailer quarterly results reveal rollout of cashierless checkout', 'The retailer announces a new deployment to 200 stores and its operational impact.', True),
    ('retail', True, '生活者反響', 'セルフレジの年齢確認で店員を待つ問題、SNSで賛否', '買い物客が操作と店員呼び出しの使い勝手を議論。', False),
    ('retail', True, 'EC物流', 'EC事業者、返品仕分けロボットを倉庫に導入', '画像認識により再販可能な商品を判別する。', False),
    ('retail', True, 'RFID', '小売チェーン、RFIDで棚卸し時間を半減', '店頭在庫とEC在庫を連携し、店舗からの発送を開始。', False),
    ('retail', True, '否定的報道', '無人決済の実証終了、認識精度と運営費が課題', '小売企業が現場検証の結果と有人レジへの変更を説明。', False),
    ('retail', True, '日英表記', 'Grocery chain deploys dynamic pricing and electronic shelf labels', 'Prices are updated by demand forecasts and remaining inventory.', True),
    ('retail', False, '小売だが技術なし', 'コンビニが秋の新メニュー、限定スイーツを発売', '季節限定の商品ラインアップを紹介。', False),
    ('retail', False, '小売だが技術なし', 'スーパー、野菜の特売セールを開催', '週末の割引価格と営業時間を紹介。', False),
    ('retail', False, '懸賞', 'コンビニ商品券をプレゼント！懸賞に応募しよう', '抽選キャンペーンの応募手順だけを紹介。', False),
    ('retail', False, '一般AI', '生成AIで詩を書こう、プロンプト入門', '個人の文章作成を解説。小売・物流の活用は扱わない。', False),
    ('retail', False, '同名', 'スーパーコンピューターで宇宙の起源を解明', '研究機関の計算結果を紹介。', False),
    ('retail', False, '同名', 'スマートカート選手権、電動レーシングカートが激走', 'モータースポーツ大会の結果。買い物カートとは無関係。', False),
    ('retail', False, '言及のみ', '芸能人がスーパーで目撃される', '番組出演後の買い物姿についての記事。技術や買い物体験の分析はない。', False),
    ('retail', False, '他業種', '病院のAI診断システムが実証を開始', '医療画像の解析精度を検証。小売・流通への応用は扱わない。', False),
    ('retail', False, '数字のみ', 'Retail shares fall after quarterly financial results', 'The report gives revenue and profit numbers and a stock price forecast only.', True),
    ('retail', False, '人事', '大手スーパーの人事異動一覧', '各店舗の店長の異動日を掲載。', False),
]


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def rule_decision(case):
    config = MEDIA[case['media']]
    global_ = case.get('is_global', False)
    patterns = noise_blacklist(config, 'global_noise_blacklist' if global_ else 'jp_noise_blacklist',
                               DEFAULT_GLOBAL_NOISE_BLACKLIST if global_ else DEFAULT_JP_NOISE_BLACKLIST)
    relevant = config.get('is_relevant_fn')
    item = {**case, 'link': case.get('url') or case['id']}
    accepted, _ = filter_and_dedup_news([item], patterns, is_relevant_fn=relevant, is_global=global_)
    return {'accepted': bool(accepted), 'noise_hits': [p.pattern for p in patterns if p.search(item['title'])],
            'relevant': relevant(item, is_global=global_) if relevant else True}


def prepare(production_limit, expanded_limit):
    jobs = []
    for media, config in MEDIA.items():
        for query_key in ('jp_query_gen', 'jp_query_ind', 'jp_query_sns',
                          'global_query_gen', 'global_query_ind', 'global_query_sns'):
            jobs.append((media, 'production_rss', query_key.startswith('global'), query_key,
                         config[query_key] + ' when:14d'))
        broad = ('(ニトリ OR デコホーム OR 島忠 OR シマホ OR 似鳥 OR ホームズ)' if media == 'nitori'
                 else '(セルフレジ OR スマートカート OR リテールメディア OR スーパー AI OR コンビニ 新商品)')
        # 検索段階の除外による取りこぼしを見るため、除外語を外した同一検索も取る。
        unexcluded = config['jp_query_gen']
        for term in (' -レシピ', ' -セール', ' -スイーツ'):
            unexcluded = unexcluded.replace(term, '')
        jobs.extend([(media, 'expanded_rss', False, 'without_search_exclusions', unexcluded + ' when:30d'),
                     (media, 'expanded_rss', False, 'broad', broad + ' when:14d')])

    def fetch(job):
        media, origin, global_, name, query = job
        items = fetch_google_news_rss(query, lang='en-US' if global_ else 'ja',
                                      gl='US' if global_ else 'JP', ceid='US:en' if global_ else 'JP:ja',
                                      max_items=45)
        return job, items

    with ThreadPoolExecutor(max_workers=4) as pool:
        fetched = list(pool.map(fetch, jobs))
    counts = [{'media': job[0], 'origin': job[1], 'name': job[3], 'fetched': len(items)}
              for job, items in fetched]
    if not all(any(job[0] == media and items for job, items in fetched) for media in MEDIA):
        raise RuntimeError('両媒体の実記事を取得できませんでした。作例だけの比較は実施しません')
    cases = []
    for media in MEDIA:
        seen = set()
        for origin, limit in (('production_rss', production_limit), ('expanded_rss', expanded_limit)):
            groups = []
            for job, items in fetched:
                m, o, global_, name, query = job
                if m == media and o == origin:
                    groups.append([(item, global_, name) for item in items])
            # 各検索の先頭を順に取る。現行ルールやJevの結果ではサンプルを選ばない。
            n = 0
            for index in range(max((len(g) for g in groups), default=0)):
                for group in groups:
                    if index >= len(group) or n >= limit:
                        continue
                    item, global_, name = group[index]
                    identity = (item['title'], item['source'])
                    if identity in seen:
                        continue
                    seen.add(identity)
                    n += 1
                    cases.append({**item, 'url': item['link'], 'id': f'{media}-{origin}-{n:03}',
                                  'media': media, 'origin': origin, 'query_group': name, 'is_global': global_,
                                  'expected': None, 'reason': ''})
    for i, (media, expected, reason, title, description, global_) in enumerate(BOUNDARIES, 1):
        cases.append({'id': f'synthetic-{i:02}', 'media': media, 'origin': 'synthetic',
                      'title': title, 'description': description, 'source': '', 'is_global': global_,
                      'expected': expected, 'reason': reason})
    for case in cases:
        case['rule'] = rule_decision(case)
    return {'prepared_at': datetime.now(JST).isoformat(), 'policies': POLICIES, 'feed_counts': counts,
            'sampling': f'各検索の先頭をラウンドロビン。媒体ごとに実運用検索{production_limit}件・拡張検索{expanded_limit}件。見出しと媒体で重複を除いた。',
            'label_source': 'API結果を見る前にCodexが掲載対象の基準に沿って付ける暫定ラベル。利用者による確認は未実施。',
            'scope': '内容の採否のみ。日付・重複・順位・最終AI選定は評価しない。', 'cases': cases}


def evaluate(case, variant, key, model):
    payload = {'model': model, 'state': state_for(case),
               'questions': {'publishable': question_for(case['media'], variant)}}
    request = urllib.request.Request(ENDPOINT, data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                                     headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, method='POST')
    start = time.monotonic()
    result = {'case_id': case['id'], 'variant': variant}
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
        p = parse_probability(data)
        result.update(probability=p, model=data['model'], usage=data.get('usage', {}))
    except urllib.error.HTTPError as error:
        result['error'] = f'HTTP {error.code}'
    except Exception as error:
        result['error'] = type(error).__name__
    result['elapsed_ms'] = round((time.monotonic() - start) * 1000, 1)
    return result


def metrics(cases, predictions):
    counts = Counter()
    for case in cases:
        if type(case.get('expected')) is not bool:
            counts['unlabeled'] += 1
            continue
        if case['id'] not in predictions:
            counts['missing'] += 1
            continue
        actual, predicted = case['expected'], predictions[case['id']]
        counts['tp' if actual and predicted else 'fn' if actual else 'fp' if predicted else 'tn'] += 1
    tp, tn, fp, fn = (counts[k] for k in ('tp', 'tn', 'fp', 'fn'))
    n = tp + tn + fp + fn
    return {'n': n, 'tp': tp, 'tn': tn, 'fp': fp, 'fn': fn,
            'unlabeled': counts['unlabeled'], 'missing': counts['missing'],
            'accuracy': (tp + tn) / n if n else None,
            'precision': tp / (tp + fp) if tp + fp else None,
            'recall': tp / (tp + fn) if tp + fn else None}


def summarize(cases, results):
    summary = {}
    for media in (*MEDIA, 'all'):
        for origin in ('production_rss', 'expanded_rss', 'real', 'synthetic', 'all'):
            subset = [c for c in cases if (media == 'all' or c['media'] == media)
                      and (origin == 'all' or c['origin'] == origin or (origin == 'real' and c['origin'] != 'synthetic'))]
            if not subset:
                continue
            group = {'rule': metrics(subset, {c['id']: c['rule']['accepted'] for c in subset})}
            for variant in ('short', 'criteria'):
                valid = [r for r in results if r['variant'] == variant and 'probability' in r]
                for threshold in (.3, .5, .7, .8, .9):
                    group[f'{variant}@{threshold}'] = metrics(subset, {r['case_id']: r['probability'] >= threshold for r in valid})
            summary[f'{media}/{origin}'] = group
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', type=Path)
    parser.add_argument('--production-limit', type=int, default=40)
    parser.add_argument('--expanded-limit', type=int, default=20)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--variant', choices=['short', 'criteria', 'both'], default='both')
    parser.add_argument('--limit', type=int, help='通信確認用に先頭の件数だけ実行')
    parser.add_argument('--retry-errors', action='store_true', help='同一条件の保存済み結果で失敗したリクエストだけ再実行')
    args = parser.parse_args()
    if args.prepare:
        data = prepare(args.production_limit, args.expanded_limit)
        write_json(args.prepare, data)
        print(json.dumps({'prepared': str(args.prepare), 'cases': len(data['cases']),
                          'groups': dict(Counter((c['media'] + '/' + c['origin']) for c in data['cases'])),
                          'feed_counts': data['feed_counts']}, ensure_ascii=False, indent=2))
        return 0
    if not args.input or not args.output:
        parser.error('--input と --output が必要です')
    if not 1 <= args.workers <= 8:
        parser.error('--workers は1〜8')
    data = json.loads(args.input.read_text(encoding='utf-8'))
    if data['policies'] != POLICIES:
        raise ValueError('ラベル付け時から採否基準が変わっています')
    cases = data['cases'][:args.limit] if args.limit else data['cases']
    ids = [c['id'] for c in cases]
    if len(ids) != len(set(ids)) or any(type(c.get('expected')) not in (bool, type(None)) or not c.get('reason') for c in cases):
        raise ValueError('API実行前に一意のIDとexpected（不明ならnull）とreasonを付けてください')
    key, model = api_key(), model_id('typesafe', 'jev')
    if not key:
        raise RuntimeError('TYPESAFE_API_KEYまたはMAGI_TYPESAFE_API_KEYが必要です')
    variants = ['short', 'criteria'] if args.variant == 'both' else [args.variant]
    results = []
    run = {'started_at': datetime.now(JST).isoformat(), 'requested_model': model, 'endpoint': ENDPOINT,
           'dataset_sha256': hashlib.sha256(args.input.read_bytes()).hexdigest(),
           'metadata': {k: v for k, v in data.items() if k != 'cases'},
           'questions': {m: {v: question_for(m, v) for v in variants} for m in MEDIA},
           'cases': cases, 'results': results}
    jobs = [(case, variant) for case in cases for variant in variants]
    if args.retry_errors:
        saved = json.loads(args.output.read_text(encoding='utf-8'))
        if any(saved[k] != run[k] for k in ('dataset_sha256', 'requested_model', 'endpoint', 'questions', 'cases')):
            raise ValueError('再試行する入力・モデル・質問が元の実行と違います')
        run = saved
        results = run['results']
        failed = {(r['case_id'], r['variant']) for r in results if 'error' in r}
        jobs = [(case, variant) for case, variant in jobs if (case['id'], variant) in failed]
        run.setdefault('previous_attempts', []).extend(dict(r) for r in results if 'error' in r)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(evaluate, case, variant, key, model) for case, variant in jobs]
        completed = 0
        for future in as_completed(futures):
            result = future.result()
            if args.retry_errors:
                index = next(i for i, r in enumerate(results)
                             if (r['case_id'], r['variant']) == (result['case_id'], result['variant']))
                results[index] = result
            else:
                results.append(result)
            completed += 1
            write_json(args.output, run)
            if completed % 20 == 0 or completed == len(futures):
                print(f'completed: {completed}/{len(futures)}', flush=True)
    run['finished_at'] = datetime.now(JST).isoformat()
    run['summary'] = summarize(cases, results)
    attempts = results + run.get('previous_attempts', [])
    times = sorted(r['elapsed_ms'] for r in attempts)
    run['performance'] = {'requests': len(attempts), 'errors': sum('error' in r for r in attempts),
                          'unresolved_errors': sum('error' in r for r in results),
                          'median_ms': statistics.median(times), 'p95_ms': times[max(0, math.ceil(len(times) * .95) - 1)],
                          'usage': {k: sum(r.get('usage', {}).get(k, 0) for r in attempts) for k in ('input_tokens', 'output_tokens')}}
    write_json(args.output, run)
    print(json.dumps({'performance': run['performance'], 'models': sorted({r['model'] for r in results if 'model' in r}),
                      'summary': {k: {v: value for v, value in group.items() if v in ('rule', 'short@0.5', 'criteria@0.5')}
                                  for k, group in run['summary'].items() if k.endswith(('/real', '/synthetic'))}}, ensure_ascii=False, indent=2))
    return 1 if run['performance']['unresolved_errors'] else 0


if __name__ == '__main__':
    sys.exit(main())
