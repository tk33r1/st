#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bright Data Web Scraper API 経由の SNS バズ投稿収集

現状の対象は TikTok のみ（Instagram はハッシュタグ探索の手段が無いため見送り）。
`TikTok - Posts by Search URL Fast API` から「直近 1 週間で再生数を伸ばしたニトリ関連動画」を
取得し、daily_engine.py の EXTRA 候補（`is_sns_raw`）と同じ形に整形して返す。

API 仕様は Bright Data 管理画面の AUTHENTICATED REQUEST 実値が一次情報。
公開ドキュメントにはこの Fast API のページが無く、docs 側の近縁データセット
(gd_lu702nij2f790tmv9h) とは入力スキーマが異なるので注意。

    POST /datasets/v3/scrape?dataset_id=gd_m7n5ixlw1gc4no56kx&notify=false&include_errors=true
    {"input":[{"url":"https://www.tiktok.com/search?q=...",
               "num_of_posts":20,
               "country":""}],
     "limit_per_input":20}

★ start_date / end_date は受け付けるが**渡さない**。実測（2026-09-12）の結果:

    日付あり: 26 件中ニトリ関連 2 件（最高 1,252 再生）
    日付なし: 30 件中ニトリ関連 20 件（最高 110 万再生）

日付を渡すと TikTok 側が検索の関連度順を捨て、「その日投稿された無関係な人気動画」を返す。
一方で関連度順に取ると検索上位は数週間〜数ヶ月かけて伸びた動画で占められ、昨日の投稿は入らない。
「ニトリ × 昨日投稿 × 人気」は両立しないため、関連度順で取得して投稿日と再生数はこちら側で絞る。
（`https://www.tiktok.com/tag/<語>` は error_code=dead_page で使用不可）

呼び出しは前夜 20:00 JST の nitori-tiktok-fetch.yml から capture_snapshot() で行い、
翌朝の本体は load_snapshot() でそれを読むだけ。取得時刻を記録するので、紙面に
「昨日20時時点で人気だった動画」と事実どおり書ける。

APIキーは環境変数 BRIGHTDATA_API_KEY からのみ読む（コード・成果物には一切書かない）。
未設定・障害・タイムアウト時は必ず空リストを返し、毎朝の発行パイプラインを落とさない。

単体プローブ（実 API を 1 回だけ叩いて挙動を表示する）:
    BRIGHTDATA_API_KEY=... python brightdata_social.py --num 30
    BRIGHTDATA_API_KEY=... python brightdata_social.py --num 20 --date-filter  # 旧方式との比較用
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))

API_BASE = 'https://api.brightdata.com/datasets/v3'
DEFAULT_TIKTOK_DATASET_ID = 'gd_m7n5ixlw1gc4no56kx'

# 対象は「昨日 1 日分」なので 20 件で十分（Bright Data は成功レコード単位の課金）
NUM_OF_POSTS = 20
TOP_N_PER_PLATFORM = 3

# 「バズ」と呼べる下限の再生数。
# TikTok の検索は日付で絞ると関連度をほぼ捨てて返してくるため、「ニトリ」に言及していても
# 再生数 1,000 前後の無名投稿が混じる。それを「TikTokで話題」として載せると媒体の信頼を損なう
# ので、閾値未満は採用しない（結果その日 0 件になり、X だけのセクションになるのは許容する）。
DEFAULT_MIN_VIEWS = 10000

# 投稿日の対象範囲。「昨日投稿」だけに絞ると TikTok からはほぼ何も取れないため直近 1 週間。
DEFAULT_WINDOW_DAYS = 7

# スナップショットに残す件数。朝の本体が既出を除外したうえで上位 3 件を採るので、
# 除外で枯れないよう多めに確保しておく。
SNAPSHOT_KEEP = 10

DEFAULT_TIMEOUT_SEC = 700
POLL_INTERVAL_SEC = 10
HTTP_TIMEOUT_SEC = 90

USER_AGENT = 'DailyBriefSocial/1.0'


def _warn(msg):
    print(f"[WARN] {msg}", file=sys.stderr)


def _api_key():
    return os.environ.get('BRIGHTDATA_API_KEY', '').strip()


def _timeout_budget():
    try:
        return int(os.environ.get('BRIGHTDATA_TIMEOUT_SEC', '').strip() or DEFAULT_TIMEOUT_SEC)
    except ValueError:
        return DEFAULT_TIMEOUT_SEC


def _min_views():
    try:
        return int(os.environ.get('BRIGHTDATA_MIN_VIEWS', '').strip() or DEFAULT_MIN_VIEWS)
    except ValueError:
        return DEFAULT_MIN_VIEWS


def _window_days():
    try:
        return int(os.environ.get('BRIGHTDATA_WINDOW_DAYS', '').strip() or DEFAULT_WINDOW_DAYS)
    except ValueError:
        return DEFAULT_WINDOW_DAYS


def _request(method, url, api_key, payload=None):
    """Bright Data API を叩いて (status, body_text) を返す。

    失敗時に出すのは HTTP ステータスとレスポンス本文の先頭だけ。
    Authorization ヘッダを含むリクエスト内容はログに出さない。
    """
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', f'Bearer {api_key}')
    req.add_header('User-Agent', USER_AGENT)
    if data is not None:
        req.add_header('Content-Type', 'application/json')

    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as res:
            return res.status, res.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8', errors='replace')
        except Exception:
            pass
        return e.code, body


def _parse_rows(body_text):
    """JSON 配列 / NDJSON / 単一オブジェクトのいずれで返っても行リストに正規化する。"""
    body_text = (body_text or '').strip()
    if not body_text:
        return []
    try:
        parsed = json.loads(body_text)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict):
            return [parsed]
        return []
    except json.JSONDecodeError:
        pass

    rows = []
    for line in body_text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            rows.append(obj)
    return rows


def _poll_snapshot(snapshot_id, api_key, deadline):
    """snapshot が ready になるまでポーリングして行リストを返す。"""
    progress_url = f"{API_BASE}/progress/{urllib.parse.quote(snapshot_id)}"
    snapshot_url = f"{API_BASE}/snapshot/{urllib.parse.quote(snapshot_id)}?format=json"

    while time.monotonic() < deadline:
        status, body = _request('GET', progress_url, api_key)
        if status != 200:
            _warn(f"progress 取得失敗 (HTTP {status}): {body[:200]}")
            return []

        try:
            state = (json.loads(body) or {}).get('status', '')
        except json.JSONDecodeError:
            _warn(f"progress のレスポンスが JSON ではありません: {body[:200]}")
            return []

        if state == 'ready':
            status, body = _request('GET', snapshot_url, api_key)
            if status != 200:
                _warn(f"snapshot 取得失敗 (HTTP {status}): {body[:200]}")
                return []
            return _parse_rows(body)

        if state == 'failed':
            _warn(f"snapshot {snapshot_id} が failed で終了しました")
            return []

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(POLL_INTERVAL_SEC, max(1, remaining)))

    _warn(f"snapshot {snapshot_id} が時間内に ready になりませんでした（予算切れ）")
    return []


def _scrape(dataset_id, api_key, payload, deadline):
    """/scrape を叩く。200 なら結果そのまま、202 なら snapshot をポーリングする。"""
    query = urllib.parse.urlencode({
        'dataset_id': dataset_id,
        'notify': 'false',
        'include_errors': 'true',
        'format': 'json',
    })
    status, body = _request('POST', f"{API_BASE}/scrape?{query}", api_key, payload)

    if status not in (200, 202):
        _warn(f"scrape 失敗 (HTTP {status}): {body[:300]}")
        return []

    rows = _parse_rows(body)

    # 202、または 200 でも snapshot_id だけ返ってきた場合は非同期扱い
    if len(rows) == 1 and isinstance(rows[0], dict) and rows[0].get('snapshot_id'):
        snapshot_id = rows[0]['snapshot_id']
        print(f" -> Bright Data: 非同期実行 (snapshot {snapshot_id}) をポーリングします")
        return _poll_snapshot(snapshot_id, api_key, deadline)

    return rows


def _fmt_utc_iso(dt):
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def _parse_dt(value):
    """API が返す日時文字列を aware datetime に変換する（失敗時 None）。"""
    if not value:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None

    text = str(value).strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _fmt_count_ja(n):
    if n >= 10000:
        man = n / 10000.0
        return f"{man:.1f}万".replace('.0万', '万')
    return f"{n:,}"


def _first_int(row, *keys):
    for k in keys:
        v = row.get(k)
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            return int(v)
        if isinstance(v, str) and v.strip().isdigit():
            return int(v.strip())
    return 0


def _is_error_row(row):
    return bool(row.get('error') or row.get('error_code') or row.get('warning'))


def _relevant(text, relevant_keywords):
    if not relevant_keywords:
        return True
    lowered = text.lower()
    return any(k.lower() in lowered for k in relevant_keywords)


def _normalize_tiktok(row, relevant_keywords=(), spam_keywords=(), excluded_accounts=()):
    """TikTok の 1 レコードを EXTRA 候補形式に整形する（不採用なら None）。"""
    description = (row.get('description') or '').strip()
    hashtags = row.get('hashtags') or []
    if isinstance(hashtags, str):
        hashtags = [hashtags]
    hashtag_text = ' '.join(str(h) for h in hashtags)

    haystack = f"{description} {hashtag_text}"
    if not _relevant(haystack, relevant_keywords):
        return None
    if any(k in haystack for k in spam_keywords):
        return None

    posted = _parse_dt(row.get('create_time') or row.get('create_date'))
    if posted is None:
        return None

    # profile_username は表示名（例 "Nitori - ニトリ【公式】"）でハンドルではない。
    # ハンドルは URL 側の @xxx に入っているので、そちらを一次情報にする。
    post_id = str(row.get('post_id') or '').strip()
    link = (row.get('url') or row.get('post_url') or '').strip()
    profile_url = (row.get('profile_url') or '').strip()
    handle_match = re.search(r'tiktok\.com/@([^/?#]+)', link or profile_url)
    handle = handle_match.group(1) if handle_match else ''
    if handle and any(handle.lower() == a.lower() for a in excluded_accounts):
        return None

    username = (row.get('profile_username') or row.get('account_id') or handle).lstrip('@').strip()
    if not link and handle and post_id:
        link = f"https://www.tiktok.com/@{handle}/video/{post_id}"
    if not link:
        return None

    views = _first_int(row, 'play_count', 'view_count', 'views')
    likes = _first_int(row, 'digg_count', 'like_count', 'likes')
    comments = _first_int(row, 'comment_count', 'num_comments')
    shares = _first_int(row, 'share_count', 'shares')

    body_text = re.sub(r'\s+', ' ', description).strip()
    short = body_text[:70] + '...' if len(body_text) > 75 else body_text
    posted_jst = posted.astimezone(JST)

    return {
        'title': f"【TikTokで{_fmt_count_ja(views)}回再生】{short}",
        'description': (
            f"TikTokで再生数{views:,}回を集めた動画"
            f"（いいね{likes:,} / コメント{comments:,}）：\n「{body_text}」"
        ),
        'source': f"TikTok (@{username})" if username else 'TikTok',
        'link': link,
        'pub_date': posted_jst.strftime('%Y-%m-%d %H:%M'),
        'pub_ts': posted.timestamp(),
        'is_sns_raw': True,
        'platform': 'tiktok',
        'author': f"@{username}" if username else 'TikTokユーザー',
        'likes': likes,
        'retweets': shares,
        'views': views,
        'comments': comments,
        'raw_text': body_text,
    }


def fetch_tiktok_buzz(search_queries, captured_at=None, relevant_keywords=(),
                      spam_keywords=(), deadline=None, limit=SNAPSHOT_KEEP,
                      excluded_accounts=()):
    """「直近 N 日に投稿された、ニトリ関連で再生数の多い」TikTok 動画を返す。

    **API に start_date / end_date は渡さない。** 実測の結果、日付フィルタを付けると
    TikTok 側が検索の関連度順を捨てて「その日に投稿された無関係な人気動画」を返してしまい、
    30 件中 20 件がニトリ関連だったものが 26 件中 2 件まで落ちた。
    関連度順で取得してから、投稿日と再生数でこちら側で絞るほうが圧倒的に精度が高い。

    ただしその代償として「昨日投稿された動画」はほぼ取れない（TikTok の検索上位は
    数週間〜数ヶ月かけて伸びた動画で占められるため）。そこで対象を直近 N 日に広げ、
    呼び出し時刻（captured_at）を「いつ時点のランキングか」として記録する。

    search_queries: TikTok 検索 URL に展開するキーワード（媒体ごとに呼び出し側が指定）
    relevant_keywords: 説明文・ハッシュタグに含まれていなければ捨てる語（空なら素通し）
    spam_keywords: 含まれていたら捨てる語
    """
    if not search_queries:
        return []

    api_key = _api_key()
    if not api_key:
        print("[INFO] BRIGHTDATA_API_KEY 未設定のため TikTok 収集をスキップします")
        return []

    if captured_at is None:
        captured_at = datetime.now(JST)
    if deadline is None:
        deadline = time.monotonic() + _timeout_budget()

    captured_at = captured_at.astimezone(JST)
    window_days = _window_days()
    window_start = captured_at - timedelta(days=window_days)

    dataset_id = os.environ.get('BRIGHTDATA_TIKTOK_DATASET_ID', '').strip() or DEFAULT_TIKTOK_DATASET_ID

    payload = {
        'input': [
            {
                'url': 'https://www.tiktok.com/search?q=' + urllib.parse.quote(q),
                'num_of_posts': NUM_OF_POSTS,
                'country': '',
            }
            for q in search_queries
        ],
        'limit_per_input': NUM_OF_POSTS,
    }

    print(
        f" -> Bright Data TikTok 収集: 直近 {window_days} 日"
        f"（{window_start:%Y-%m-%d %H:%M} 以降）/ クエリ {len(payload['input'])} 件"
    )
    rows = _scrape(dataset_id, api_key, payload, deadline)
    if not rows:
        return []

    error_rows = [r for r in rows if isinstance(r, dict) and _is_error_row(r)]
    if error_rows:
        _warn(f"TikTok: エラー行 {len(error_rows)} 件 (例: {str(error_rows[0])[:200]})")

    min_views = _min_views()
    items = []
    seen_links = set()
    stale = 0
    low_reach = 0
    for row in rows:
        if not isinstance(row, dict) or _is_error_row(row):
            continue
        item = _normalize_tiktok(row, relevant_keywords, spam_keywords, excluded_accounts)
        if item is None:
            continue
        posted = datetime.fromtimestamp(item['pub_ts'], JST)
        if not (window_start <= posted <= captured_at):
            stale += 1
            continue
        if item['views'] < min_views:
            low_reach += 1
            continue
        if item['link'] in seen_links:
            continue
        seen_links.add(item['link'])
        items.append(item)

    items.sort(key=lambda x: (x['views'], x['likes']), reverse=True)
    print(
        f" -> Bright Data TikTok 収集完了: {len(items)} 件 "
        f"(元 {len(rows)} 行 / 期間外 {stale} 件 / 再生数 {min_views:,} 未満 {low_reach} 件)"
    )
    return items[:limit]


def capture_snapshot(path, tiktok_queries=(), relevant_keywords=(), spam_keywords=(),
                     excluded_accounts=()):
    """前夜の取得ワークフロー用。収集結果をスナップショット JSON として書き出す。

    取得に失敗しても既存のスナップショットは壊さない（0 件で上書きしない）。
    """
    captured_at = datetime.now(JST)
    try:
        items = fetch_tiktok_buzz(
            tiktok_queries, captured_at, relevant_keywords, spam_keywords,
            excluded_accounts=excluded_accounts,
        )
    except Exception as e:
        _warn(f"TikTok 収集失敗: {type(e).__name__}: {e}")
        return 1

    if not items:
        _warn("採用できる動画が 0 件でした。既存スナップショットは更新しません。")
        return 0

    snapshot = {
        'captured_at': captured_at.isoformat(),
        'captured_date': captured_at.strftime('%Y%m%d'),
        'window_days': _window_days(),
        'min_views': _min_views(),
        'items': items,
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)
    print(f" -> スナップショット書き出し: {path} ({len(items)} 件 / {captured_at:%Y-%m-%d %H:%M} JST 時点)")
    return 0


def load_snapshot(path, target_date=None, max_age_hours=36):
    """朝の本体用。前夜のスナップショットを読む。

    古すぎる（前夜のワークフローが失敗したまま）スナップショットを「昨日の人気」として
    出すのは誤報になるため、max_age_hours を超えていたら捨てて空を返す。
    """
    if not os.path.exists(path):
        print(f"[INFO] TikTok スナップショットが無いためスキップ: {path}")
        return []

    try:
        with open(path, 'r', encoding='utf-8') as f:
            snapshot = json.load(f)
    except Exception as e:
        _warn(f"TikTok スナップショット読み込み失敗: {type(e).__name__}: {e}")
        return []

    captured_at = _parse_dt(snapshot.get('captured_at'))
    if captured_at is None:
        _warn("TikTok スナップショットに captured_at がありません")
        return []

    now = (target_date or datetime.now(JST)).astimezone(JST)
    age_hours = (now - captured_at.astimezone(JST)).total_seconds() / 3600
    if age_hours > max_age_hours:
        _warn(
            f"TikTok スナップショットが古すぎます（{age_hours:.1f} 時間前 / "
            f"上限 {max_age_hours} 時間）。今回は採用しません。"
        )
        return []

    items = [it for it in snapshot.get('items', []) if isinstance(it, dict)]
    for it in items:
        it['captured_at'] = snapshot.get('captured_at')
    print(f" -> TikTok スナップショット読み込み: {len(items)} 件 ({captured_at.astimezone(JST):%m/%d %H:%M} JST 時点)")
    return items


def _probe(num_of_posts=5, keyword='ニトリ', relevant=None, use_tag_url=False, spam=(),
           send_dates=True, excluded=()):
    """管理画面の実値で確定しきれなかった挙動を実キーで確認するプローブ。"""
    relevant = relevant or [keyword]
    api_key = _api_key()
    if not api_key:
        print("BRIGHTDATA_API_KEY が未設定です。環境変数に入れて再実行してください。", file=sys.stderr)
        return 1

    now = datetime.now(JST)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday_start = today_start - timedelta(days=1)
    dataset_id = os.environ.get('BRIGHTDATA_TIKTOK_DATASET_ID', '').strip() or DEFAULT_TIKTOK_DATASET_ID

    keywords = [k.strip() for k in keyword.split(',') if k.strip()]
    if use_tag_url:
        # URLエンコード済みだと "Couldn't find this hashtag" になったので、生の UTF-8 でも試せるように
        target_urls = ['https://www.tiktok.com/tag/' + k for k in keywords]
    else:
        target_urls = ['https://www.tiktok.com/search?q=' + urllib.parse.quote(k) for k in keywords]

    def _one_input(u):
        inp = {'url': u, 'num_of_posts': num_of_posts, 'country': ''}
        if send_dates:
            inp['start_date'] = _fmt_utc_iso(yesterday_start)
            inp['end_date'] = _fmt_utc_iso(today_start)
        return inp

    payload = {
        'input': [_one_input(u) for u in target_urls],
        'limit_per_input': num_of_posts,
    }

    print(f"dataset_id : {dataset_id}")
    for u in target_urls:
        print(f"url        : {u}")
    print(f"date filter: {'あり' if send_dates else 'なし（関連度順を見るため）'}")
    if send_dates:
        print(f"window     : {payload['input'][0]['start_date']} .. {payload['input'][0]['end_date']}")
    print(f"           : 判定対象 ({yesterday_start:%Y-%m-%d %H:%M} JST .. {today_start:%Y-%m-%d %H:%M} JST)")

    started = time.monotonic()
    query = urllib.parse.urlencode({
        'dataset_id': dataset_id,
        'notify': 'false',
        'include_errors': 'true',
        'format': 'json',
    })
    status, body = _request('POST', f"{API_BASE}/scrape?{query}", api_key, payload)
    print(f"\n[1] POST /scrape -> HTTP {status} ({time.monotonic() - started:.1f}s)")
    print(f"    body head: {body[:300]}")

    rows = _parse_rows(body)
    if len(rows) == 1 and isinstance(rows[0], dict) and rows[0].get('snapshot_id'):
        snapshot_id = rows[0]['snapshot_id']
        print(f"\n[2] 非同期: snapshot {snapshot_id} をポーリング")
        rows = _poll_snapshot(snapshot_id, api_key, time.monotonic() + _timeout_budget())
        print(f"    ready まで {time.monotonic() - started:.1f}s / {len(rows)} 行")
    else:
        print(f"\n[2] 同期で {len(rows)} 行が直接返りました（{time.monotonic() - started:.1f}s）")

    if not rows:
        print("\n結果 0 件。start_date/end_date の解釈かキーワードを見直してください。")
        return 0

    data_rows = [r for r in rows if isinstance(r, dict) and not _is_error_row(r)]
    err_rows = [r for r in rows if isinstance(r, dict) and _is_error_row(r)]
    print(f"\n[3] データ行 {len(data_rows)} / エラー行 {len(err_rows)}")
    if err_rows:
        print(f"    error 例: {str(err_rows[0])[:300]}")

    if data_rows:
        print(f"\n[4] 1 行目のキー一覧:\n    {sorted(data_rows[0].keys())}")
        for name in ('digg_count', 'like_count', 'play_count', 'comment_count',
                     'share_count', 'collect_count', 'create_time'):
            print(f"    {name:14s} = {data_rows[0].get(name, '(なし)')!r}")

    print("\n[5] create_time が窓内に収まっているか:")
    for r in data_rows:
        dt = _parse_dt(r.get('create_time'))
        if dt is None:
            print(f"    ?  create_time 解釈不可: {r.get('create_time')!r}")
            continue
        jst = dt.astimezone(JST)
        mark = 'OK ' if yesterday_start <= jst < today_start else 'NG '
        print(f"    {mark} {jst:%Y-%m-%d %H:%M} JST  play={r.get('play_count')}  {str(r.get('description'))[:40]}")

    min_views = _min_views()
    print(f"\n[6] 関連度フィルタ（{' / '.join(relevant)}）と再生数下限（{min_views:,}）の通過状況:")
    kept = []
    n_relevant = 0
    n_relevant_in_window = 0
    seen = set()
    for r in data_rows:
        it = _normalize_tiktok(r, relevant, spam, excluded)
        desc = re.sub(r'\s+', ' ', str(r.get('description') or ''))[:40]
        src = str((r.get('input') or {}).get('url', ''))
        src = urllib.parse.unquote(src.rsplit('=', 1)[-1].rsplit('/', 1)[-1])[:10]
        if it is None:
            verdict = '除外(無関係)'
        elif it['link'] in seen:
            verdict = '除外(重複)'
        else:
            seen.add(it['link'])
            n_relevant += 1
            posted = datetime.fromtimestamp(it['pub_ts'], JST)
            if not (yesterday_start <= posted < today_start):
                verdict = '除外(対象日外)'
            else:
                n_relevant_in_window += 1
                if it['views'] < min_views:
                    verdict = '除外(再生不足)'
                else:
                    verdict = '採用'
                    kept.append(it)
        print(f"    {verdict:<14} play={r.get('play_count')!s:>9}  [{src}] {desc}")
    print(
        f"    -> ニトリ言及 {n_relevant} / {len(data_rows)} 件（重複除く）、"
        f"うち昨日投稿 {n_relevant_in_window} 件、さらに再生数 {min_views:,} 以上が {len(kept)} 件"
    )

    print(f"\n[7] 実際に掲載される上位 {TOP_N_PER_PLATFORM} 件:")
    kept.sort(key=lambda x: (x['views'], x['likes']), reverse=True)
    if not kept:
        print("    （0 件。この日は X のみのセクションになります）")
    for it in kept[:TOP_N_PER_PLATFORM]:
        print(f"    {it['title']}  <{it['link']}>")
    return 0


def _arg(name, default=None):
    if name in sys.argv:
        try:
            return sys.argv[sys.argv.index(name) + 1]
        except IndexError:
            pass
    return default


if __name__ == '__main__':
    # 前夜の取得ワークフロー用。媒体側の設定を読んでスナップショットを書き出す。
    if '--snapshot' in sys.argv:
        import importlib
        _gen = importlib.import_module('generate-nitori-daily')
        sys.exit(capture_snapshot(
            _arg('--snapshot') or _gen.TIKTOK_SNAPSHOT_PATH,
            _gen.TIKTOK_SEARCH_QUERIES,
            _gen.TIKTOK_RELEVANT_KEYWORDS,
            _gen.TIKTOK_SPAM_KEYWORDS,
            _gen.TIKTOK_EXCLUDED_ACCOUNTS,
        ))

    num = 5
    if '--num' in sys.argv:
        try:
            num = int(sys.argv[sys.argv.index('--num') + 1])
        except (IndexError, ValueError):
            pass
    kw = 'ニトリ'
    if '--keyword' in sys.argv:
        try:
            kw = sys.argv[sys.argv.index('--keyword') + 1]
        except IndexError:
            pass
    relevant = ['ニトリ', 'nitori', 'デコホーム', 'ニトリネット']
    if '--relevant' in sys.argv:
        try:
            relevant = [w for w in sys.argv[sys.argv.index('--relevant') + 1].split(',') if w]
        except IndexError:
            pass
    # 本番と同じ除外条件で測れるよう、媒体側の定数を借りる（取れなければ空で続行）
    spam, excluded = (), ()
    try:
        import importlib
        _g = importlib.import_module('generate-nitori-daily')
        spam = tuple(_g.TIKTOK_SPAM_KEYWORDS)
        excluded = tuple(_g.TIKTOK_EXCLUDED_ACCOUNTS)
    except Exception:
        pass
    sys.exit(_probe(num, kw, relevant, '--tag' in sys.argv, spam,
                    send_dates='--no-date' not in sys.argv, excluded=excluded))
