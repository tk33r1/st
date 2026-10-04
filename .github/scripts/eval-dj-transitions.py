#!/usr/bin/env python3
"""DJの繋ぎ候補を、現行ルールとJev 70点＋いいね30点で比較する。

曲データとAPI結果は一時ディレクトリへ保存する。本番の画面・Worker・DBは変更しない。
--prepare METADATA --input PATH で実曲だけの入力をAPI実行前に固定する。
--input PATH --output PATH でScore質問と再現性を評価する。
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from datetime import datetime
import hashlib
import http.client
import json
import math
from pathlib import Path
import statistics
import subprocess
import time
import urllib.error
import urllib.request

from ai_model_registry import REPO_ROOT, model_id
from nitori_social_filter import ENDPOINT, api_key


# 質問は本番Workerを正本にし、評価スクリプトへ複製しない。
QUESTION = json.loads(subprocess.run(
    ['node', '--input-type=module', '-e',
     'const m = await import(process.argv[1]); process.stdout.write(JSON.stringify(m.TRANSITION_QUESTION));',
     (REPO_ROOT / 'workers/dj-request/src/transitions.js').as_uri()],
    capture_output=True, check=True, text=True, encoding='utf-8').stdout)



def like_points(likes):
    if type(likes) is not int or likes < 0:
        raise ValueError('いいね数は非負の整数')
    return 30 * (likes / (likes + 2))


def current_features(cases):
    # 差し替え前にHTMLから抽出した旧NEXTを、比較専用の保存版として実行する。
    script = """
const fs = await import('node:fs');
const { legacyFeatures } = await import(process.argv[1]);
const pairs = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(pairs.map(p => legacyFeatures(p.from, p.to))));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', script,
                             (REPO_ROOT / '.github/scripts/fixtures/dj-next-rule.js').as_uri()],
                            input=json.dumps(cases, ensure_ascii=False), text=True, encoding='utf-8',
                            capture_output=True, check=True)
    return json.loads(result.stdout)


def real_song(row):
    card = json.loads(row['info_card']) if row.get('info_card') else {}
    # 名前・投稿のひとこと・端末情報は取得元のSELECTに含めない。
    # 曲の背景カードのチャート等は音楽的な説明ではないため今回のstateには使わない。
    return {
        'id': row['id'], 'title': row['title'], 'artist': row['artist'],
        'variant': row['variant'] or '', 'genre': row['genre'] or '',
        'releaseYear': row['release_year'] or None, 'originalYear': card.get('originalYear'),
        'bpm': row['bpm'], 'songKey': row['song_key'] or '', 'camelot': row['camelot'] or '',
        'bpmSrc': row['bpm_src'] or '', 'keySrc': row['key_src'] or '', 'bpmTapped': False,
        'likes': row['likes'] or 0, 'votes': row['votes'] or 0, 'status': row['status'],
        'eventCode': row['event_code'], 'playedAt': row['played_at'],
    }


def prepare(path):
    rows = json.loads(path.read_text(encoding='utf-8-sig'))[0]['results']
    songs = [real_song(row) for row in rows]
    # 全曲を起点にする。同じイベント内の実曲だけを候補にし、実際のstatus・votesを保つ。
    anchors = [song['id'] for song in songs]
    cases = []
    for base in songs:
        for song in songs:
            if song['id'] != base['id'] and song['eventCode'] == base['eventCode']:
                cases.append({'id': f'real-{base["id"]}-{song["id"]}', 'origin': 'real',
                              'from': deepcopy(base), 'to': deepcopy(song)})
    for case, features in zip(cases, current_features(cases)):
        case['features'] = features
    current = []
    for code in dict.fromkeys(song['eventCode'] for song in songs):
        played = [song for song in songs if song['eventCode'] == code and song['status'] == 'played' and song['playedAt']]
        if played:
            base = max(played, key=lambda song: song['playedAt'])
            current.append({'anchor': base['id'], 'candidate_ids': [song['id'] for song in songs
                if song['eventCode'] == code and song['id'] != base['id'] and song['status'] in ('pending', 'queued')]})
    existing = {case['id'] for case in cases}
    return {'question': QUESTION, 'songs': songs, 'anchors': anchors, 'cases': cases,
            'variants': ['anonymous'], 'current_next': current,
            'source_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'baseline_sha256': hashlib.sha256((REPO_ROOT / '.github/scripts/fixtures/dj-next-rule.js').read_bytes()).hexdigest(),
            'baseline_path': '.github/scripts/fixtures/dj-next-rule.js',
            'repeat_ids': [name for name in ('real-44-48', 'real-41-37', 'real-36-35', 'real-45-44') if name in existing],
            'scope': '実曲・実メタデータだけ。同一イベントの全方向ペア。status・votes・likesは実値を維持。音源・音の説明はなし。'}


def state_for(case, variant):
    def shape(song):
        named = {'title': song['title'], 'artist': song['artist'], 'variant': song['variant']} if variant == 'named' else {}
        version = song['variant'].casefold()
        return {**named, 'genre': song['genre'], 'originalYear': song['originalYear'],
                'releaseYear': song['releaseYear'], 'bpm': song['bpm'], 'camelot': song['camelot'],
                'songKey': song['songKey'], 'bpmSrc': song['bpmSrc'], 'keySrc': song['keySrc'],
                'versionKind': 'remix' if any(word in version for word in ('remix', 'refix', ' mix')) else 'remaster' if 'remaster' in version else 'extended' if 'extended' in version else 'unspecified',
                }
    return {'from': shape(case['from']), 'to': shape(case['to']),
            **{key: case['features'][key] for key in ('bpmFit', 'keyFit', 'effectiveFromBpm', 'effectiveToBpm')}}


def parse_score(data, top=4):
    answer = data['answers']['transition']
    def number(value, lower, upper):
        if type(value) not in (int, float) or not lower <= value <= upper or not math.isfinite(value):
            raise ValueError('Score応答の数値が不正')
        return value
    if answer['type'] != 'score':
        raise ValueError('Score以外の応答')
    score = number(answer['score'], 0, top)
    confidence = number(answer['confidence'], 0, 1)
    probabilities = [number(answer['probabilities'][str(i)], 0, 1) for i in range(top + 1)]
    # APIは確率・Scoreを小数2桁へ丸めることがある。5段階なら重み付き和の丸め誤差は最大0.055。
    sum_tolerance = .005 * (top + 1) + 1e-9
    score_tolerance = .005 * (top * (top + 1) / 2 + 1) + 1e-9
    if abs(sum(probabilities) - 1) > sum_tolerance or abs(sum(i * p for i, p in enumerate(probabilities)) - score) > score_tolerance:
        raise ValueError('Scoreと確率分布が不一致')
    return score / top, confidence, answer


def evaluate(case, variant, repeat, key, model, question):
    request = urllib.request.Request(ENDPOINT,
        data=json.dumps({'model': model, 'state': state_for(case, variant), 'questions': {'transition': question}}, ensure_ascii=False).encode('utf-8'),
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, method='POST')
    started = time.monotonic()
    result = dict(case_id=case['id'], variant=variant, repeat=repeat)
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                data = json.load(response)
            raw_answer = data.get('answers', {}).get('transition', {})
            # 検証に落ちても、数値だけを残して診断できるようにする。応答本文やエラー本文は記録しない。
            result['numeric_response'] = {name: raw_answer.get(name) for name in ('score', 'confidence') if type(raw_answer.get(name)) in (int, float)}
            result['numeric_response']['probabilities'] = {str(i): raw_answer.get('probabilities', {}).get(str(i))
                for i in range(len(question['criteria'])) if type(raw_answer.get('probabilities', {}).get(str(i))) in (int, float)}
            score, confidence, answer = parse_score(data, len(question['criteria']) - 1)
            result.update(score=score, confidence=confidence, answer=answer, model=data.get('model'), usage=data.get('usage', {}))
            break
        except urllib.error.HTTPError as error:
            result['error'] = f'HTTP {error.code}'
            if attempt == 0 and (error.code == 429 or error.code >= 500):
                time.sleep(.5)
                continue
        except (http.client.HTTPException, OSError, ValueError, KeyError, TypeError) as error:
            result['error'] = type(error).__name__
        break
    if 'score' in result:
        result.pop('error', None)
    result['attempts'] = attempt + 1
    result['elapsed_ms'] = round((time.monotonic() - started) * 1000, 1)
    return result


def summarize(run):
    data, results = run['input'], run['results']
    successful = [r for r in results if 'score' in r]
    first = {(r['case_id'], r['variant']): r for r in successful if r['repeat'] == 0}
    repeat_differences = [abs(r['score'] - first[(r['case_id'], r['variant'])]['score']) for r in successful if r['repeat'] > 0 and (r['case_id'], r['variant']) in first]
    rankings = {}
    for anchor in data['anchors']:
        group = [case for case in data['cases'] if case['origin'] == 'real' and case['from']['id'] == anchor]
        old = sorted(group, key=lambda c: c['features']['ruleScore'])
        rankings[str(anchor)] = {'rule': [c['id'] for c in old], 'jev': {}}
        for variant in data['variants']:
            eligible = [c for c in group if (c['id'], variant) in first]
            ranked = sorted(eligible, key=lambda c: 70 * first[(c['id'], variant)]['score'] + like_points(c['to']['likes']), reverse=True)
            rule_ranks = {c['id']: i + 1 for i, c in enumerate(old)}
            rankings[str(anchor)]['jev'][variant] = [dict(case_id=c['id'], title=c['to']['title'], artist=c['to']['artist'],
                variant=c['to']['variant'], status=c['to']['status'],
                score=first[(c['id'], variant)]['score'], confidence=first[(c['id'], variant)]['confidence'],
                rule_score=c['features']['ruleScore'], rule_rank=rule_ranks[c['id']],
                bpm_penalty=c['features']['bpmPenalty'], key_penalty=c['features']['keyPenalty'],
                likes=c['to']['likes'], like_points=like_points(c['to']['likes']), jev_points=70 * first[(c['id'], variant)]['score'],
                total=70 * first[(c['id'], variant)]['score'] + like_points(c['to']['likes'])) for c in ranked]
    sensitivity = {}
    for anchor, group in rankings.items():
        ranked = group['jev']['anonymous']
        if len(ranked) < 2:
            continue
        best = max(row['score'] for row in ranked)
        sensitivity[anchor] = [{'case_id': row['case_id'], 'title': row['title'], 'jev_gap_points': round(70 * (best - row['score']), 2),
            'likes_to_exceed_top_with_zero_likes': next((likes for likes in range(1001) if 70 * row['score'] + like_points(likes) > 70 * best), None)} for row in [r for r in ranked if r['score'] < best][:3]]
    return {'calls': len(results) + len(run.get('previous_attempts', [])), 'judgements': len(results),
            'http_attempts': sum(r['attempts'] for r in results + run.get('previous_attempts', [])), 'successful': len(successful),
            'errors': [r for r in results if 'error' in r], 'models': sorted({r['model'] for r in successful}),
            'latency_median_ms': statistics.median(r['elapsed_ms'] for r in successful) if successful else None,
            'latency_p95_ms': sorted(r['elapsed_ms'] for r in successful)[int(.95 * (len(successful) - 1))] if successful else None,
            'low_confidence_below_half': sum(r['confidence'] < .5 for r in successful),
            'repeat_max_difference': max(repeat_differences, default=None), 'rankings': rankings, 'like_sensitivity': sensitivity,
            'current_next': [{**current, 'rule': [case_id for case_id in rankings[str(current['anchor'])]['rule']
                if int(case_id.split('-')[-1]) in current['candidate_ids']],
                'jev': [row for row in rankings[str(current['anchor'])]['jev']['anonymous']
                if int(row['case_id'].split('-')[-1]) in current['candidate_ids']]} for current in data['current_next']]}


def write_report(path, run, summary):
    """固定入力と保存応答から、全実曲の入力・旧新スコアを読み比べられる表を作る。"""
    data = run['input']
    songs = {song['id']: song for song in data['songs']}
    cases = {case['id']: case for case in data['cases']}
    def cell(value):
        return str(value if value is not None and value != '' else '不明').replace('|', '\\|').replace('\n', ' ')
    def label(song):
        return cell(song['title'] + ('（' + song['variant'] + '）' if song['variant'] else ''))
    def score_table(rows):
        lines = ['| 候補曲 | 現行順位 | 現行点↓ | Jev順位 | Jev／70 | いいね加点／30 | 総合点↑ | 確信度 |',
                 '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
        rule_order = sorted(rows, key=lambda row: row['rule_rank'])
        for row in rule_order:
            song = cases[row['case_id']]['to']
            lines.append(f'| {label(song)} | {rule_order.index(row) + 1} | {row["rule_score"]:.3f} | {rows.index(row) + 1} | {row["jev_points"]:.3f} | {row["like_points"]:.3f} | {row["total"]:.3f} | {row["confidence"]:.2f} |')
        return lines
    first_results = [result for result in run['results'] if result['repeat'] == 0 and 'score' in result]
    changed = sum(group['rule'][0] != group['jev']['anonymous'][0]['case_id'] for group in summary['rankings'].values())
    lines = ['# DJ NEXT：実曲・既存データだけによる再テスト', '',
             f'再テスト実施（{datetime.now().astimezone().date().isoformat()}）。本番の判定は変更していない。', '',
             '前回の作例を含む評価は、この再テストに置き換える。曲調の項目・説明、架空の曲、作例は今回の入力に含まない。評価基準にも曲調の説明を要求する文言を入れていない。', '',
             '## 実際のNEXT候補', '',
             'イベントごとに、最後に再生済みにした曲を起点に、pending／queuedの候補だけを比較した。status・votes・likesはDBの実値を維持している。', '']
    for current in summary['current_next']:
        lines += [f'### 起点：{label(songs[current["anchor"]])}', '']
        if current['jev']:
            lines += score_table(current['jev']) + ['']
            for row in current['jev']:
                features = cases[row['case_id']]['features']
                bf = features['bpmFit']
                diff = f'{bf["pct"]:+.3f}%、候補BPM×{bf["m"]:g}' if bf else '不明'
                lines += [f'- {label(cases[row["case_id"]]["to"])}：BPM差 {diff}、BPM減点 {row["bpm_penalty"]:g}、キー減点 {row["key_penalty"]:g}（{cell(features["keyFit"]["label"])}）。']
            lines += ['']
        else:
            lines += ['pending／queuedの候補なし。現行ルールでもJevでもNEXTに出る曲はない。', '']
    lines += ['## 比較条件', '',
              f'実曲{len(songs)}曲、同じイベント内の方向付きペア{len(data["cases"])}組。各ペアを1回評価し、{len(data["repeat_ids"])}組を1回再評価。成功{summary["successful"]}判定／HTTP {summary["http_attempts"]}回。実応答モデル：`{", ".join(summary["models"])}`。', '',
              '```', '新しい総合点 = 70 ×（Jevのscore / 4）+ 30 × L /（L + 2）',
              '現行点 = BPM減点 + キー減点 − min(1.5, 0.3 × L + 0.3 × max(0, votes − 1)) −（queuedなら0.5）', '```', '',
              'Lは候補曲のいいね数。現行点は低いほど上位、新しい総合点は高いほど上位。尺度が異なるので、新旧の点数そのものの大小では優劣を比較しない。同点では保存された入力順を維持した。表は現行順位順で並べている。', '',
              '現行点は`dj/booth/index.html`のBPM・キー・NEXT計算コードをそのまま実行して取得した。Jevには保存済みのBPM・キー・ジャンル・原曲年・発売年・BPMとキーの取得元・版の種類、および現行コードで計算した有効BPM・BPM差・キーの関係を渡した。音楽評価の点数はJevが決める。', '',
              '曲名・アーティスト・版名の原文はJevへ渡していない。表に実曲名を載せるための対応付けにのみ使った。版の種類は既存のvariant文字列からremix／extended等に分類したもの。いいね・votes・statusもJevへ渡していない。', '',
              '原曲年は既存の背景カードのoriginalYear、発売年とジャンルは保存済みの値。今回のために補完・変更した値はない。BPMやキーの推定誤差、原曲年とカバー／リミックス版の時代の違いは、そのまま評価結果に影響する。音源は聴いていない。', '',
              '## 実際に使った曲データ', '']
    for number, code in enumerate(dict.fromkeys(song['eventCode'] for song in songs.values()), 1):
        lines += [f'### イベント{number}', '',
                  '| 曲 | アーティスト | ジャンル | 原曲年 | 発売年 | BPM：保存値→現行有効値 | キー | いいね | votes | status | BPM／キー取得元 |',
                  '| --- | --- | --- | ---: | ---: | --- | --- | ---: | ---: | --- | --- |']
        for song in songs.values():
            if song['eventCode'] != code:
                continue
            group = [case for case in data['cases'] if case['from']['id'] == song['id']]
            effective = group[0]['features']['effectiveFromBpm'] if group else None
            key = ' / '.join(v for v in (song['camelot'], song['songKey']) if v)
            lines += [f'| {label(song)} | {cell(song["artist"])} | {cell(song["genre"])} | {cell(song["originalYear"])} | {cell(song["releaseYear"])} | {cell(song["bpm"])}→{cell(effective)} | {cell(key)} | {song["likes"]} | {song["votes"]} | {song["status"]} | {cell(song["bpmSrc"])}／{cell(song["keySrc"])} |']
        lines += ['']
    lines += ['`est`はプレビューからの推定、`gsb`はGetSongBPM、`deezer`はDeezer由来。90未満のBPMを倍にする既存処理は、整数に丸めた後で判定するため、89.9は90、84は168となる。このテストで処理を変えていない。', '',
              '## 全実曲ペアの点数と順位', '',
              '以下は同じイベント内の他曲をすべて候補にした繋ぎ適性の比較。再生済み・スキップ済みの履歴曲も含むため、そのまま現在のNEXTには表示されない。原曲年・発売年・ジャンル・いいねは上の曲データ表と同一。statusや票数を比較用に書き換えていない。', '']
    for anchor in data['anchors']:
        group = summary['rankings'][str(anchor)]
        rows = group['jev']['anonymous']
        lines += [f'### 起点：{label(songs[anchor])}', '']
        lines += score_table(rows) + ['']
    observations = []
    for current in summary['current_next']:
        if current['jev']:
            old_names = ' → '.join(label(cases[case_id]['to']) for case_id in current['rule'][:3])
            new_names = ' → '.join(label(cases[row['case_id']]['to']) for row in current['jev'][:3])
            observations += [f'実際のNEXTの起点{label(songs[current["anchor"]])}からは、現行が{old_names}、Jevが{new_names}。', '']
    for anchor in (36, 41):
        if str(anchor) in summary['rankings']:
            group = summary['rankings'][str(anchor)]
            old_names = ' → '.join(label(cases[case_id]['to']) for case_id in group['rule'][:3])
            new_names = ' → '.join(label(cases[row['case_id']]['to']) for row in group['jev']['anonymous'][:3])
            observations += [f'履歴の{label(songs[anchor])}からは、現行が{old_names}、Jevが{new_names}。', '']
    for case_id in ('real-45-44',):
        if case_id in cases:
            case = cases[case_id]
            row = next((row for row in summary['rankings'][str(case['from']['id'])]['jev']['anonymous'] if row['case_id'] == case_id), None)
            if row:
                observations += [f'履歴の{label(case["from"])}から{label(case["to"])}は、Jev {row["jev_points"]:.3f}点＋実際のいいね{row["likes"]}件による{row["like_points"]:.3f}点＝{row["total"]:.3f}点。候補のstatusは{row["status"]}。これは履歴候補を含めた比較であり、現在のNEXTの推薦結果ではない。', '']
    lines += ['## 観察と判断できる範囲', '',
              f'- 履歴を含む{len(data["anchors"])}起点の比較では、1位が入れ替わった起点は{changed}件。順位変化の数であり、精度改善率ではない。',
              f'- 初回の実曲{len(first_results)}組中、確信度0.5未満は{sum(result["confidence"] < .5 for result in first_results)}組。確信度はAPIの出力であり、正解率として扱わない。',
              f'- 同じ入力を再評価した最大差はJev 70点換算で{70 * summary["repeat_max_difference"]:.3f}点。近い点数の順位には揺れがあり得る。',
              f'- 成功リクエストの経過時間：中央値{summary["latency_median_ms"]:.1f}ms、95パーセンタイル{summary["latency_p95_ms"]:.1f}ms（4並列の観測）。', '',
              *observations,
              '原曲年代・BPM・キー・ジャンルをまとめて評価しているため、ある1つの項目だけが順位変化の原因とは切り分けていない。', '',
              '実データを使った点数・順位の変化はこの表から判断できる。音源でのミックスや本人の採点は行っておらず、Jevの順位の方が正しいと結論付ける比較はまだ行っていない。', '',
              '## 入力・応答の確認と再集計', '',
              f'- 固定入力SHA-256：`{run["dataset_sha256"]}`',
              f'- 取得した曲データSHA-256：`{data["source_sha256"]}`',
              f'- 比較元HTMLのSHA-256：`{data["baseline_sha256"]}`', '',
              '固定入力・実応答・集計JSONは一時ディレクトリの`dj-jev-real-input-20261004.json`、`dj-jev-real-results-20261004.json`、`dj-jev-real-summary-20261004.json`に保存した。キー・投稿者情報は含まない。次のコマンドはAPIを呼ばず、保存済みの実応答から同じ点数表を再生成する。', '',
              '```powershell',
              f'python -X utf8 -B .github/scripts/eval-dj-transitions.py --input "$env:TEMP\\dj-jev-real-input-20261004.json" --output "$env:TEMP\\dj-jev-real-results-20261004.json" --summary "$env:TEMP\\dj-jev-real-summary-20261004.json" --report "{path.as_posix()}" --summarize-only',
              '```', '', '## 今回のScore質問（固定した全文）', '',
              '```json', json.dumps(data['question'], ensure_ascii=False, indent=2), '```', '']
    path.write_text('\n'.join(lines), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', type=Path)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--summary', type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--retry-errors', action='store_true')
    parser.add_argument('--summarize-only', action='store_true', help='保存結果だけを集計する。APIを呼ばない')
    args = parser.parse_args()
    # いいね数を打ち切らず、単調増加で30点未満。1件10点・2件15点を確認。
    assert [like_points(n) for n in (0, 1, 2)] == [0, 10, 15]
    assert 25 < like_points(10000) < 30
    if args.prepare:
        data = prepare(args.prepare)
        args.input.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        real_pairs = sum(case['origin'] == 'real' for case in data['cases'])
        print(f'入力固定: 実曲 {len(data["songs"])}曲 / 実曲ペア{real_pairs}件 / sha256 {hashlib.sha256(args.input.read_bytes()).hexdigest()}', flush=True)
        return
    if not args.output or not 1 <= args.workers <= 8:
        parser.error('--output が必要、--workers は1〜8')
    data = json.loads(args.input.read_text(encoding='utf-8'))
    if data['question'] != QUESTION:
        raise ValueError('入力固定時から質問が変わっている')
    if any(case['origin'] != 'real' for case in data['cases']):
        raise ValueError('実曲以外の入力')
    if not args.summarize_only and current_features(data['cases']) != [case['features'] for case in data['cases']]:
        raise ValueError('保存した旧NEXTの計算結果が入力固定時と違う')
    run = dict(dataset_sha256=hashlib.sha256(args.input.read_bytes()).hexdigest(), requested_model=model_id('typesafe', 'jev'), input=data, results=[])
    jobs = [(case, variant, repeat) for case in data['cases'] for variant in data['variants']
            for repeat in range(2 if case['id'] in data['repeat_ids'] else 1)]
    if args.retry_errors or args.summarize_only:
        saved = json.loads(args.output.read_text(encoding='utf-8'))
        if any(saved[name] != run[name] for name in ('dataset_sha256', 'requested_model', 'input')):
            raise ValueError('再試行の入力・モデル・質問が元の実行と違う')
        run = saved
    if args.summarize_only:
        summary = summarize(run)
        if args.summary:
            args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
        if args.report:
            write_report(args.report, run, summary)
        print(json.dumps({k: summary[k] for k in ('calls', 'http_attempts', 'successful', 'models', 'latency_median_ms', 'latency_p95_ms', 'low_confidence_below_half', 'repeat_max_difference')}, ensure_ascii=False), flush=True)
        return
    if args.retry_errors:
        failed = {(r['case_id'], r['variant'], r['repeat']) for r in run['results'] if 'error' in r}
        jobs = [(case, variant, repeat) for case, variant, repeat in jobs if (case['id'], variant, repeat) in failed]
        run.setdefault('previous_attempts', []).extend(dict(r) for r in run['results'] if 'error' in r)
    key = api_key()
    if not key:
        raise RuntimeError('TypeSafe APIキー未設定')
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(evaluate, case, variant, repeat, key, run['requested_model'], data['question']) for case, variant, repeat in jobs]
        for completed, future in enumerate(as_completed(futures), 1):
            result = future.result()
            if args.retry_errors:
                index = next(i for i, old in enumerate(run['results'])
                             if all(old[key] == result[key] for key in ('case_id', 'variant', 'repeat')))
                run['results'][index] = result
            else:
                run['results'].append(result)
            if completed % 20 == 0 or completed == len(jobs):
                args.output.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding='utf-8')
                print(f'判定完了: {completed}/{len(jobs)}', flush=True)
    summary = summarize(run)
    if args.summary:
        args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.report:
        write_report(args.report, run, summary)
    print(json.dumps({k: summary[k] for k in ('calls', 'http_attempts', 'successful', 'models', 'latency_median_ms', 'latency_p95_ms', 'low_confidence_below_half', 'repeat_max_difference')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
