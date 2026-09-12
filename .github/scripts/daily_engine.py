#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Daily Brief Common Engine (daily_engine.py)

Retail Tech Daily Brief, Nitori Daily Brief などの日刊ニュースメディアの
データ収集、重複排除、マルチAI要約、HTML/JSON/RSS出力、OGP生成を一括制御する共通コアエンジン。
"""

import argparse
import email.utils
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

# Windows コンソール等の UTF-8 出力安全化
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
if hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

JST = timezone(timedelta(hours=9))
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
DATA_DIR = os.path.join(REPO_ROOT, 'data')
PERSON_ID = "https://tk.st/#author"

# 共有 SVG アイコン
ICON_EXTERNAL_SVG = '<svg class="external-icon" viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.5" fill="none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>'
ICON_WIM_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>'
ICON_COPY_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'
ICON_X_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'
ICON_RSS_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9"></path><path d="M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"></circle></svg>'


def esc(s):
    return html.escape(str(s or ''), quote=True)


_JSONLD_SCRIPT_ESCAPE_TABLE = str.maketrans({'<': '\\u003c', '>': '\\u003e', '&': '\\u0026'})


def escape_jsonld_for_script(json_str):
    """外部由来のテキスト（記事タイトル等）が </script> を含んでいても
    <script type="application/ld+json"> を閉じてしまわないようにする。"""
    return json_str.translate(_JSONLD_SCRIPT_ESCAPE_TABLE)


def sanitize_url(url):
    if not url:
        return '#'
    url = str(url).strip()
    if re.match(r'^(https?:)?//', url, re.IGNORECASE):
        return url
    return '#'


def clean_html_text(text):
    if not text:
        return ""
    text = re.sub(r'<[^>]+>', ' ', text)
    text = html.unescape(text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def build_keyword_regex(patterns):
    p_sorted = sorted(patterns, key=len, reverse=True)
    return re.compile(r'(' + '|'.join(map(re.escape, p_sorted)) + r')')


def bold_scan_text(escaped_text, keyword_regex):
    if not escaped_text or not keyword_regex:
        return escaped_text
    return keyword_regex.sub(r'<strong class="kw-scan">\1</strong>', escaped_text)


def split_takeaway(raw_wim):
    if not raw_wim:
        return "", ""
    wim = clean_html_text(raw_wim).strip()
    
    # "/” は開き・閉じが同じ文字集合に含まれる（対称的な引用符）ため、
    # 単純な開き/閉じカウンタでは開いたまま閉じられず永久にロックされる。
    # スタックで「今開いている引用符が閉じるはずの文字」を管理し、
    # 対称な引用符は直前に同種が開いていれば閉じ・そうでなければ開き、として扱う。
    quote_pairs = {'「': '」', '『': '』', '（': '）', '(': ')', '"': '"', '“': '”'}
    quote_stack = []
    split_idx = -1

    for i, ch in enumerate(wim):
        if quote_stack and ch == quote_stack[-1]:
            quote_stack.pop()
        elif ch in quote_pairs:
            quote_stack.append(quote_pairs[ch])
        elif not quote_stack and ch in '。！？!?':
            split_idx = i
            break
            
    if split_idx != -1 and split_idx < len(wim) - 1:
        takeaway = wim[:split_idx + 1].strip()
        detail = wim[split_idx + 1:].strip()
        return takeaway, detail
    else:
        return wim, ""


def is_fresh(item, cutoff_ts):
    """記事の pub_ts が cutoff_ts 以降か（=「昨日のニュース」の鮮度条件を満たすか）。
    足切り（gather_all_candidate_news）と並び替え優先度（各メディアの relevance_sort_key_fn）の
    両方で同じ鮮度定義を使うための共有関数。"""
    return item.get('pub_ts', 0) >= cutoff_ts


def parse_pub_date_timestamp(pub_str):
    if not pub_str:
        return 0
    try:
        dt = email.utils.parsedate_to_datetime(pub_str)
        return int(dt.timestamp())
    except Exception:
        return 0


def fetch_google_news_rss(query, lang='ja', gl='JP', ceid='JP:ja', max_items=40):
    encoded_q = urllib.parse.quote(query)
    url = f"https://news.google.com/rss/search?q={encoded_q}&hl={lang}&gl={gl}&ceid={ceid}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    }
    req = urllib.request.Request(url, headers=headers)
    items = []
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read()
        root = ET.fromstring(content)
        for el in root.findall('.//item')[:max_items]:
            title = el.findtext('title') or ''
            link = el.findtext('link') or ''
            pub_date = el.findtext('pubDate') or ''
            desc = el.findtext('description') or ''
            source = el.findtext('source') or ''
            if not source and ' - ' in title:
                parts = title.rsplit(' - ', 1)
                title = parts[0].strip()
                source = parts[1].strip()
            items.append({
                'title': title.strip(),
                'link': link.strip(),
                'pub_date': pub_date.strip(),
                'pub_ts': parse_pub_date_timestamp(pub_date),
                'description': clean_html_text(desc),
                'source': source.strip()
            })
    except Exception as e:
        print(f"[WARN] RSS 取得失敗 ({query[:40]}...): {e}", file=sys.stderr)
    return items


def load_recent_published_history(json_path, exclude_date_key=None, days_limit=7):
    if not os.path.exists(json_path):
        return {'recent_urls': set(), 'recent_title_keys': set(), 'recent_titles': []}
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        recent_urls = set()
        recent_title_keys = set()
        recent_titles = []
        issues = sorted(data, key=lambda x: x.get('date', ''), reverse=True)
        count = 0
        for issue in issues:
            d = issue.get('date')
            if exclude_date_key and d == exclude_date_key:
                continue
            if count >= days_limit:
                break
            count += 1
            for art in issue.get('articles', []):
                u = art.get('url', '')
                if u:
                    recent_urls.add(u)
                t = art.get('title', '')
                if t:
                    recent_titles.append(t)
                    tk = re.sub(r'\s+', '', t[:20].lower())
                    if tk:
                        recent_title_keys.add(tk)
        return {
            'recent_urls': recent_urls,
            'recent_title_keys': recent_title_keys,
            'recent_titles': recent_titles
        }
    except Exception as e:
        print(f"[WARN] 過去記事履歴の読み込み失敗: {e}", file=sys.stderr)
        return {'recent_urls': set(), 'recent_title_keys': set(), 'recent_titles': []}


def filter_and_dedup_news(items, blacklist_patterns, published_history=None, is_relevant_fn=None, is_global=False):
    seen_links = set()
    seen_titles = set()
    filtered = []
    pub_urls = published_history.get('recent_urls', set()) if published_history else set()
    pub_title_keys = published_history.get('recent_title_keys', set()) if published_history else set()
    past_duplicates_count = 0

    for it in items:
        link = it['link']
        if link in seen_links:
            continue
        title = it['title']
        title_key = re.sub(r'\s+', '', title[:20].lower())

        if is_relevant_fn and not is_relevant_fn(it, is_global=is_global):
            continue

        if link in pub_urls or title_key in pub_title_keys:
            past_duplicates_count += 1
            continue

        if title_key in seen_titles:
            continue

        if any(p.search(title) for p in blacklist_patterns):
            continue

        seen_links.add(link)
        seen_titles.add(title_key)
        filtered.append(it)

    return filtered, past_duplicates_count


def gather_all_candidate_news(config, target_date=None, exclude_date_key=None):
    if target_date is None:
        target_date = datetime.now(JST)

    pub_history = load_recent_published_history(config['data_json_path'], exclude_date_key=exclude_date_key, days_limit=7)
    when_clause = "when:3d" if target_date.weekday() == 0 else "when:2d"

    jp_raw = fetch_google_news_rss(f"{config['jp_query_gen']} {when_clause}", lang='ja', gl='JP', ceid='JP:ja', max_items=40)
    jp_raw += fetch_google_news_rss(f"{config['jp_query_ind']} {when_clause}", lang='ja', gl='JP', ceid='JP:ja', max_items=35)
    jp_raw += fetch_google_news_rss(f"{config['jp_query_sns']} {when_clause}", lang='ja', gl='JP', ceid='JP:ja', max_items=25)
    jp_items, jp_past_dups = filter_and_dedup_news(
        jp_raw, config['jp_noise_blacklist'], pub_history, config.get('is_relevant_fn'), is_global=False
    )

    # 外部追加ソース（例: Yahoo! リアルタイム検索バズ等）
    extra_fn = config.get('extra_candidates_fn')
    extra_items = []
    if extra_fn:
        try:
            extra_raw = extra_fn(target_date)
            extra_items, _ = filter_and_dedup_news(
                extra_raw, config['jp_noise_blacklist'], pub_history, config.get('is_relevant_fn'), is_global=False
            )
            print(f" -> 追加ソース収集完了: {len(extra_items)} 件 (元 {len(extra_raw)} 件)")
        except Exception as e:
            print(f"[WARN] extra_candidates_fn 実行失敗: {e}", file=sys.stderr)

    gl_raw = fetch_google_news_rss(f"{config['global_query_gen']} {when_clause}", lang='en-US', gl='US', ceid='US:en', max_items=40)
    gl_raw += fetch_google_news_rss(f"{config['global_query_ind']} {when_clause}", lang='en-US', gl='US', ceid='US:en', max_items=35)
    gl_raw += fetch_google_news_rss(f"{config['global_query_sns']} {when_clause}", lang='en-US', gl='US', ceid='US:en', max_items=20)
    global_items, global_past_dups = filter_and_dedup_news(
        gl_raw, config['global_noise_blacklist'], pub_history, config.get('is_relevant_fn'), is_global=True
    )

    # Google News の "when:Nd" はヒット件数が少ない狭いクエリ（特に海外の個社名検索）だと
    # 無視され、条件に合う新着が足りない分を古い記事で埋めて返してくることがある。
    # クエリ文字列側の指定は当てにならないため、実際の pub_ts で確実に足切りする。
    cutoff_days = 3 if target_date.weekday() == 0 else 1
    cutoff_ts = (target_date - timedelta(days=cutoff_days)).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

    def apply_recency_cutoff(items, label):
        fresh = [it for it in items if is_fresh(it, cutoff_ts)]
        stale = len(items) - len(fresh)
        if stale:
            cutoff_str = datetime.fromtimestamp(cutoff_ts, JST).strftime('%Y-%m-%d %H:%M JST')
            print(f" -> [{label}] Google Newsのwhen:フィルタが効かず混入した古い記事を除外: {stale} 件 ({cutoff_str} 以降のみ採用)")
        return fresh

    jp_items = apply_recency_cutoff(jp_items, '国内')
    global_items = apply_recency_cutoff(global_items, '海外')

    sort_fn = config.get('relevance_sort_key_fn')
    if sort_fn:
        jp_items.sort(key=lambda x: sort_fn(x, False, cutoff_ts), reverse=True)
        global_items.sort(key=lambda x: sort_fn(x, True, cutoff_ts), reverse=True)
    else:
        jp_items.sort(key=lambda x: x.get('pub_ts', 0), reverse=True)
        global_items.sort(key=lambda x: x.get('pub_ts', 0), reverse=True)

    print(f" -> 収集完了: 国内 {len(jp_items)} 件 (元 {len(jp_raw)} 件, 過去掲載除外 {jp_past_dups} 件) / 海外 {len(global_items)} 件 (元 {len(gl_raw)} 件, 過去掲載除外 {global_past_dups} 件)")
    return {
        'JP': jp_items,
        'GLOBAL': global_items,
        'EXTRA': extra_items,
        'recent_published_titles': pub_history.get('recent_titles', [])
    }


def build_candidate_index(candidates):
    index = {}
    def tag_list(items, prefix):
        listed = []
        for i, it in enumerate(items, 1):
            cid = f"{prefix}-{i:02d}"
            it['_cand_id'] = cid
            index[cid] = it
            listed.append({
                'id': cid,
                'title': it['title'],
                'source': it['source'],
                'pub_date': it['pub_date'],
                'description': it['description'],
            })
        return listed

    return tag_list(candidates['JP'][:45], 'JP'), tag_list(candidates['GLOBAL'][:30], 'GL'), index


def build_prompt(config, candidates, target_date_str, yesterday_str):
    jp_sample, global_sample, candidate_index = build_candidate_index(candidates)
    recent_titles = candidates.get('recent_published_titles', [])
    recent_section = ""
    if recent_titles:
        formatted_titles = "\n".join(recent_titles[:20])
        recent_section = f"""
【直近のバックナンバーに掲載済みのトピック（★重複選定厳禁★）】:
以下のニュースは直近の当メディアですでに掲載・解説済みです。
同一の事象・発表を報じた記事（別メディアによる後追い報道を含む）は【絶対に再選定しないでください】。
※ただし、新たな数値の発表や具体的方針の転換など、明らかな「続報・新たな進展」である場合のみ選定を許可します。
{formatted_titles}
"""

    extra_items = candidates.get('EXTRA', [])
    sns_section = ""
    sns_output_fields = ""
    if extra_items:
        sns_sample = [{
            'title': it.get('title', ''),
            'text': it.get('raw_text') or it.get('description', ''),
            'likes': it.get('likes', 0),
            'retweets': it.get('retweets', 0),
        } for it in extra_items]
        sns_section = f"""
【X（旧Twitter）生活者バズ投稿一覧（本日の「Xリアル反響」セクション用）】:
以下は生活者が実際に投稿し話題になっている生の声です。記事候補とは別に、この一覧全体を俯瞰して
共通する傾向・トレンドを分析し、後述の "sns_summary" / "sns_why_it_matters" を作成してください。
{json.dumps(sns_sample, ensure_ascii=False, indent=2)}
"""
        sns_output_fields = """,
  "sns_summary": "上記のX投稿一覧全体の傾向を要約した客観的な説明文（120〜200文字）",
  "sns_why_it_matters": "上記のX投稿一覧全体を踏まえた、プロの視点による生活者UX・ビジネスへの示唆（120〜200文字）\""""

    prompt = f"""あなたは日本最高峰の{config['editor_title']}です。
本日の発行日: {target_date_str}（まとめ対象: {yesterday_str}の最新動向）

以下の【国内ニュース候補】および【海外ニュース候補】を精査し、{config['brand_title']}の読者に届ける重要ニュースを厳選してください。
{recent_section}
【厳格な選別ルール】
{config['prompt_selection_rules']}
- "region" は必ず "JP" または "GLOBAL" のいずれか（この2文字列のみ、"GL" や "Global" 等の省略・別表記は禁止）を出力してください。国内ニュース候補（JP-xx）から選んだ記事は "JP"、海外ニュース候補（GL-xx）から選んだ記事は必ず "GLOBAL" としてください。
- 海外ニュースはタイトルを魅力的かつ正確な日本語に翻訳し、元の英語タイトル（original_title）も保持してください。
- すべての記事について、事実の要約（summary: 140〜240文字）に加え、プロの視点によるビジネス示唆『Why it matters（ここがポイント）』（120〜200文字）を必ず記述してください。
- 昨日の動向全体を象徴する最も重要なポイント3点を「エグゼクティブ・サマリー（executive_summary）」としてまとめてください。
- カテゴリは以下から選択：
  {config['prompt_categories']}
- 各記事には、選定元の候補に付いている "id" をそのまま "source_id" として必ず出力してください。
  出典URLはシステム側が id から復元します。URLの推測・生成・出力は一切しないでください。

【国内ニュース候補】:
{json.dumps(jp_sample, ensure_ascii=False, indent=2)}

【海外ニュース候補】:
{json.dumps(global_sample, ensure_ascii=False, indent=2)}
{sns_section}
【出力形式】
Markdownのコードブロック（```json）などは付けず、純粋なJSONのみを出力してください:
{{
  "executive_summary": ["要点1", "要点2", "要点3"],
  "articles": [
    {{
      "region": "JP",
      "category": "{config['sample_category']}",
      "title": "日本語見出し",
      "original_title": "",
      "source": "媒体名",
      "source_id": "選定元候補のid（例: JP-03）",
      "summary": "要約（140〜240文字）",
      "why_it_matters": "示唆・考察（120〜200文字）",
      "tags": {json.dumps(config['sample_tags'], ensure_ascii=False)}
    }},
    {{
      "region": "GLOBAL",
      "category": "{config['sample_category']}",
      "title": "海外ニュースの日本語見出し",
      "original_title": "Original English Headline",
      "source": "媒体名",
      "source_id": "選定元候補のid（例: GL-02）",
      "summary": "要約（140〜240文字）",
      "why_it_matters": "示唆・考察（120〜200文字）",
      "tags": {json.dumps(config['sample_tags'], ensure_ascii=False)}
    }}
  ]{sns_output_fields}
}}"""
    return prompt, candidate_index


def call_llm_api(endpoint, api_key, model_name, prompt_content, user_agent):
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": "You are a professional editorial curator and analyst. Return only valid JSON adhering strictly to the requested schema."},
            {"role": "user", "content": prompt_content}
        ],
        "response_format": {"type": "json_object"}
    }
    # OpenAI の最新推論モデル等では reasoning_effort: 'none' が必要な場合がある
    if 'gpt' in model_name.lower() or 'luna' in model_name.lower():
        payload["reasoning_effort"] = "none"
        payload["temperature"] = 0.2
    else:
        payload["temperature"] = 0.2

    def do_request(p_data):
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(p_data).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Authorization': f"Bearer {api_key}",
                'User-Agent': user_agent
            }
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode('utf-8'))
            raw_text = body['choices'][0]['message']['content'].strip()
            if raw_text.startswith('```'):
                raw_text = re.sub(r'^```(?:json)?\s*', '', raw_text)
                raw_text = re.sub(r'\s*```$', '', raw_text)
            return json.loads(raw_text)

    try:
        return do_request(payload)
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='ignore')
        print(f"[WARN] API HTTP {e.code} ({model_name}): {err_body}", file=sys.stderr)

        # temperature / reasoning_effort / response_format 不整合時の自動再試行
        if e.code == 400 and any(k in err_body.lower() for k in ['temperature', 'reasoning_effort', 'unsupported', 'response_format']):
            print(f" -> パラメータを安全最小構成にして再試行...", file=sys.stderr)
            fallback_payload = {
                "model": model_name,
                "messages": payload["messages"]
            }
            if "response_format" not in err_body.lower():
                fallback_payload["response_format"] = {"type": "json_object"}
            try:
                return do_request(fallback_payload)
            except urllib.error.HTTPError as e2:
                err_body2 = e2.read().decode('utf-8', errors='ignore')
                print(f"[ERROR] 再試行も失敗 ({model_name}): {err_body2}", file=sys.stderr)
                raise RuntimeError(f"HTTP {e2.code}: {err_body2}") from e2
        raise RuntimeError(f"HTTP {e.code}: {err_body}") from e


def title_match_key(title):
    if not title:
        return ''
    t = re.sub(r'[\s\-_\|\(\)\[\]【】〈〉「」『』]+', '', str(title).lower())
    return t[:18]


def normalize_region(value, fallback='JP'):
    """AIが自由記述した region 表記のゆれ（GL / Global / 海外 等）を吸収する。
    レンダリング側は 'JP' / 'GLOBAL' の完全一致で国内・海外バッジを出し分けているため、
    ここで正規化しないと表記ゆれの分だけ海外記事が国内扱いになってしまう。"""
    s = str(value or '')
    v = re.sub(r'[\s_-]', '', s).upper()
    if v in ('GLOBAL', 'GL', 'OVERSEAS', 'INTL', 'INTERNATIONAL', 'WORLD') or '海外' in s:
        return 'GLOBAL'
    if v in ('JP', 'JAPAN', 'DOMESTIC') or '国内' in s:
        return 'JP'
    return fallback


def resolve_source_urls(result, candidate_index):
    by_title = {}
    for it in candidate_index.values():
        key = title_match_key(it['title'])
        if key and key not in by_title:
            by_title[key] = it

    resolved = 0
    unresolved = []
    for art in result.get('articles', []):
        raw_sid = str(art.get('source_id') or art.get('id') or '').strip().upper()
        m = re.search(r'(JP|GL)-?(\d+)', raw_sid)
        src = None
        if m:
            norm_sid = f"{m.group(1)}-{int(m.group(2)):02d}"
            src = candidate_index.get(norm_sid)
        if src is None:
            src = candidate_index.get(raw_sid)

        if src is None:
            for cand_title in (art.get('original_title'), art.get('title')):
                key = title_match_key(cand_title)
                if key and key in by_title:
                    src = by_title[key]
                    break

        if src:
            art['url'] = src['link']
            if not art.get('source'):
                art['source'] = src['source']
            art['source_pub_ts'] = src.get('pub_ts', 0)
            # region はAIの自由記述に頼らず、実際に一致した候補が JP/GLOBAL どちらの
            # リストから来たかで機械的に確定する（"GL" 等の表記ゆれで海外記事が
            # 国内バッジになる不具合の再発防止）。candidate_index の値は必ず
            # build_candidate_index で _cand_id を付与済みのため常に 'JP'/'GL' で始まる。
            art['region'] = 'GLOBAL' if src['_cand_id'].startswith('GL') else 'JP'
            resolved += 1
        else:
            art['url'] = ''
            # 候補を特定できなくても、source_id が "JP-xx"/"GL-xx" 形式であれば
            # そのプレフィックスの方がAIの自由記述(region)より信頼できるので優先する。
            if m:
                art['region'] = 'GLOBAL' if m.group(1) == 'GL' else 'JP'
            else:
                art['region'] = normalize_region(art.get('region'))
            unresolved.append(art.get('title', '(無題)'))

    print(f" -> 出典URLの再接続: {resolved} 件成功 / {len(unresolved)} 件不明")
    for t in unresolved:
        print(f"[WARN] 出典を特定できずリンク無しで出力します: {t[:50]}", file=sys.stderr)
    return result


def analyze_news_with_fallback(config, candidates, target_date_str, yesterday_str):
    print("[2/3] AI要約・インサイト生成プロセスを開始...")
    prompt, candidate_index = build_prompt(config, candidates, target_date_str, yesterday_str)

    providers = [
        {
            "name": "DeepSeek",
            "model": os.environ.get('DEEPSEEK_MODEL', 'deepseek-flash').strip(),
            "key": os.environ.get('DEEPSEEK_API_KEY', '').strip(),
            "url": "https://api.deepseek.com/chat/completions",
            "badge_label": f"DeepSeek ({os.environ.get('DEEPSEEK_MODEL', 'deepseek-flash').strip()})"
        },
        {
            "name": "OpenAI",
            "model": os.environ.get('OPENAI_MODEL', 'gpt-5.6-luna').strip(),
            "key": os.environ.get('OPENAI_API_KEY', '').strip(),
            "url": "https://api.openai.com/v1/chat/completions",
            "badge_label": f"OpenAI ({os.environ.get('OPENAI_MODEL', 'gpt-5.6-luna').strip()})"
        }
    ]

    final_res = None
    for p in providers:
        if not p['key']:
            continue
        print(f" -> 試行中: {p['name']} ({p['model']})...")
        try:
            res = call_llm_api(p['url'], p['key'], p['model'], prompt, config['user_agent'])
            if res and res.get('articles'):
                print(f"[SUCCESS] {p['name']} による生成が成功しました！")
                resolve_source_urls(res, candidate_index)
                res['generated_by'] = p['badge_label']
                res['engine_type'] = p['name'].lower()
                final_res = res
                break
        except Exception as e:
            print(f"[WARN] {p['name']} 失敗: {e}", file=sys.stderr)

    if not final_res:
        print("[INFO] AI未設定またはAPI失敗のため、ルールベースに切り替えます。")
        fb = config['fallback_fn'](candidates, yesterday_str)
        fb['generated_by'] = 'Rule-based Engine (Fallback)'
        fb['engine_type'] = 'fallback'
        final_res = fb

    # EXTRAソース（例: Yahoo! リアルタイム検索バズ等）があれば、独立したSNSバズ枠として整形・保持
    extra_items = candidates.get('EXTRA', [])
    if extra_items:
        final_res['sns_buzz'] = build_sns_buzz_items(extra_items, config)
    elif 'sns_buzz' not in final_res:
        final_res['sns_buzz'] = []

    return final_res


def build_sns_buzz_items(extra_items, config):
    buzz_list = []
    for it in extra_items:
        likes = it.get('likes', 0)
        rt = it.get('retweets', 0)
        source = it.get('source', '')
        author = source.replace('X (@', '@').replace(')', '') if '(@' in source else source
        
        snippet = it.get('raw_text')
        if not snippet:
            desc = it.get('description', '')
            if '：\n「' in desc:
                snippet = desc.split('：\n「', 1)[1].rstrip('」')
            else:
                snippet = desc
        snippet = snippet.strip()

        t = it.get('title', '')
        t_clean = re.sub(r'^【Xで[\d,]+いいね】', '', t).strip()
        if not t_clean or len(t_clean) < 10:
            t_clean = snippet[:70] + "..." if len(snippet) > 75 else snippet

        buzz_list.append({
            'title': t_clean,
            'author': author,
            'url': it.get('link', ''),
            'likes': likes,
            'retweets': rt,
            'text': snippet,
            'tags': ["SNS話題", "生活者UX", "バズアイテム"]
        })
    return buzz_list


def build_dynamic_jsonld(config, issue_data, date_key, formatted_date):
    articles = issue_data.get('articles', [])
    exec_summary = issue_data.get('executive_summary', [])
    dynamic_desc = " ".join(exec_summary[:2]) if exec_summary else f"{formatted_date}の{config['brand_title']}まとめ。"
    if len(dynamic_desc) > 280:
        dynamic_desc = dynamic_desc[:277] + "..."

    all_keywords = set()
    all_categories = []
    for a in articles:
        cat = a.get('category')
        if cat and cat not in all_categories:
            all_categories.append(cat)
            all_keywords.add(cat)
        for t in a.get('tags', []):
            all_keywords.add(t)

    issue_iso = f"{date_key[:4]}-{date_key[4:6]}-{date_key[6:8]}T08:00:00+09:00"
    base_url = f"https://tk.st/job/{config['media_id']}/"

    list_items = []
    has_part_list = []
    for idx, art in enumerate(articles, 1):
        art_id = f"{base_url}{date_key}/#art-{idx}"
        art_schema = {
            "@type": "NewsArticle",
            "@id": art_id,
            "position": idx,
            "headline": art.get('title', ''),
            "description": art.get('summary', ''),
            "url": art_id,
            "articleSection": art.get('category', config['sample_category']),
            "inLanguage": "ja",
            "datePublished": issue_iso,
            "dateModified": issue_iso,
            "isPartOf": {"@id": f"{base_url}{date_key}/#article"},
            "author": {"@id": PERSON_ID},
            "publisher": {"@id": PERSON_ID}
        }
        if art.get('url'):
            based_on = {"@type": "NewsArticle", "url": art['url']}
            if art.get('source'):
                based_on["publisher"] = {"@type": "Organization", "name": art['source']}
            src_ts = art.get('source_pub_ts') or 0
            if src_ts:
                based_on["datePublished"] = datetime.fromtimestamp(src_ts, JST).isoformat()
            art_schema["isBasedOn"] = based_on
        if art.get('tags'):
            art_schema["keywords"] = art['tags']

        has_part_list.append({"@id": art_id})
        list_items.append({
            "@type": "ListItem",
            "position": idx,
            "item": art_schema
        })

    graph = [
        {
            "@type": "NewsArticle",
            "@id": f"{base_url}{date_key}/#article",
            "isPartOf": {
                "@type": "Periodical",
                "name": config['media_name'],
                "url": base_url
            },
            "headline": f"{formatted_date}号：昨日の{config['brand_title_short']}まとめ",
            "description": dynamic_desc,
            "url": f"{base_url}{date_key}/",
            "image": f"https://tk.st/images/ogp/{config['media_id']}-{date_key}.webp",
            "datePublished": issue_iso,
            "dateModified": issue_iso,
            "inLanguage": "ja",
            "author": {"@id": PERSON_ID},
            "publisher": {"@id": PERSON_ID},
            "articleSection": all_categories,
            "keywords": sorted(list(all_keywords)),
            "hasPart": has_part_list
        },
        {
            "@type": "ItemList",
            "@id": f"{base_url}{date_key}/#newslist",
            "name": f"{formatted_date}号 掲載ニュース一覧",
            "numberOfItems": len(articles),
            "itemListElement": list_items
        },
        {
            "@type": "BreadcrumbList",
            "@id": f"{base_url}{date_key}/#breadcrumb",
            "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Shinya Takeda", "item": "https://tk.st/" },
                { "@type": "ListItem", "position": 2, "name": "Job", "item": "https://tk.st/job/" },
                { "@type": "ListItem", "position": 3, "name": config['brand_title'], "item": base_url },
                { "@type": "ListItem", "position": 4, "name": f"{formatted_date}号", "item": f"{base_url}{date_key}/" }
            ]
        },
        {
            "@type": "Person",
            "@id": PERSON_ID,
            "name": "Shinya Takeda",
            "url": "https://tk.st/job/",
            "jobTitle": "Digital Marketer / Tech Lead",
            "sameAs": ["https://tk.st/", "https://github.com/tk33r1"]
        }
    ]

    return {
        "@context": "https://schema.org",
        "@graph": graph
    }


def render_sns_buzz_section(sns_buzz, config, issue_data=None):
    if not sns_buzz:
        return ""

    cards_html = []
    kw_regex = config.get('keyword_regex')
    for idx, item in enumerate(sns_buzz, 1):
        likes_str = f"{item.get('likes', 0):,}"
        rt_str = f"{item.get('retweets', 0):,}"
        author = esc(item.get('author', 'Xユーザー'))
        raw_url = sanitize_url(item.get('url', ''))
        raw_text = item.get('text', '')
        clean_text = re.sub(r'https?://\S+', '', raw_text).strip()
        bold_text = bold_scan_text(esc(clean_text), kw_regex)

        cards_html.append(f"""
        <div class="sns-card" id="sns-buzz-{idx}">
          <div class="sns-card-meta">
            <a href="{raw_url}" target="_blank" rel="noopener noreferrer" class="sns-card-author">
              {ICON_X_SVG}
              <span>{author}</span>
            </a>
            <div class="sns-card-stats">
              <span class="sns-stat-likes" title="{likes_str} いいね">❤️ {likes_str}</span>
              <span class="sns-stat-rt" title="{rt_str} リポスト">🔁 {rt_str}</span>
            </div>
          </div>
          <div class="sns-card-body">
            <blockquote>{bold_text}</blockquote>
          </div>
          <div class="sns-card-footer">
            <a href="{raw_url}" target="_blank" rel="noopener noreferrer" class="sns-card-link">
              <span>Xでポストを見る</span>
              {ICON_EXTERNAL_SVG}
            </a>
          </div>
        </div>""")

    # セクション全体の要約・示唆まとめブロック（AIが生成した場合のみ表示）。
    # AIが sns_summary/sns_why_it_matters を返さなかった場合（項目省略やルールベース
    # フォールバック時）、その日の実際の投稿内容と無関係な固定文言をでっち上げて
    # 「AIの分析」であるかのように出すのは不誠実なため、ボックス自体を省略する。
    issue = issue_data or {}
    raw_summary = issue.get('sns_summary', '')
    raw_wim = issue.get('sns_why_it_matters', '')

    summary_box_html = ""
    if raw_summary or raw_wim:
        bold_summary = bold_scan_text(esc(raw_summary), kw_regex)
        takeaway, detail_wim = split_takeaway(raw_wim)
        bold_takeaway = bold_scan_text(esc(takeaway), kw_regex)
        bold_detail = bold_scan_text(esc(detail_wim), kw_regex)

        summary_box_html = f"""
      <div class="sns-buzz-summary-box">
        <div class="card-summary"><p>{bold_summary}</p></div>
        <div class="why-it-matters">
          <div class="wim-header">
            {ICON_WIM_SVG}
            <strong>Why it matters（生活者UX・生活空間への示唆）</strong>
          </div>
          <div class="wim-takeaway">
            <span class="takeaway-badge">KEY TAKEAWAY</span>
            <p class="takeaway-text">{bold_takeaway}</p>
          </div>
          {f'<p class="wim-detail">{bold_detail}</p>' if bold_detail else ''}
        </div>
      </div>"""

    return f"""
    <section class="sns-buzz-section" id="snsBuzzSection">
      <div class="sns-buzz-header">
        <div class="sns-buzz-title-wrap">
          <span class="sns-badge-x">{ICON_X_SVG} Xリアル反響</span>
          <h2 class="sns-buzz-title">昨日のX（Twitter）生活者バズ・リアル反響まとめ</h2>
        </div>
        <span class="sns-buzz-sub">生活者が注目した神アイテム・使い勝手や比較の生の声</span>
      </div>
      {summary_box_html}
      <div class="sns-buzz-grid">
{"".join(cards_html)}
      </div>
    </section>
    """


def render_article_html(config, issue_data, date_key, formatted_date, prev_issue=None, next_issue=None):
    articles = issue_data.get('articles', [])
    sns_buzz = issue_data.get('sns_buzz', [])
    sns_buzz_html = render_sns_buzz_section(sns_buzz, config, issue_data=issue_data)
    total_count = len(articles)
    engine_label = esc(issue_data.get('generated_by', 'DeepSeek AI'))
    engine_type = esc(issue_data.get('engine_type', 'deepseek'))
    engine_class = f"engine-{engine_type}"

    jsonld_obj = build_dynamic_jsonld(config, issue_data, date_key, formatted_date)
    dynamic_jsonld_str = escape_jsonld_for_script(json.dumps(jsonld_obj, ensure_ascii=False, indent=2))
    dynamic_page_desc = esc(jsonld_obj['@graph'][0]['description'])

    total_chars = sum(len(a.get('title', '')) + len(a.get('summary', '')) + len(a.get('why_it_matters', '')) for a in articles)
    total_chars += sum(len(s) for s in issue_data.get('executive_summary', []))
    reading_minutes = max(1, round(total_chars / 550))

    cat_counts = {}
    for a in articles:
        c = a.get('category', config['sample_category'])
        cat_counts[c] = cat_counts.get(c, 0) + 1

    cat_chips = []
    for c, cnt in cat_counts.items():
        cat_chips.append(f'<button type="button" class="filter-chip" data-filter-type="category" data-filter-val="{esc(c)}" aria-pressed="false">{esc(c)} <span class="chip-count">{cnt}</span></button>')
    cat_chips_html = "".join(cat_chips)

    quick_index_items = []
    for idx, art in enumerate(articles, 1):
        is_global = art.get('region') == 'GLOBAL'
        b_class = 'badge-global' if is_global else 'badge-jp'
        b_txt = '海外' if is_global else '国内'
        cat_name = art.get('category', config['sample_category'])
        quick_index_items.append(f"""        <li class="qi-item">
          <a href="#art-{idx}" class="qi-link">
            <span class="qi-num">{idx:02d}</span>
            <span class="qi-badge {b_class}">{b_txt}</span>
            <span class="qi-cat">{esc(cat_name)}</span>
            <span class="qi-title">{esc(art.get('title', ''))}</span>
            <svg class="qi-icon" viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>
          </a>
        </li>""")
    quick_index_html = "\n".join(quick_index_items)

    kw_regex = config['keyword_regex']
    articles_html = []
    for idx, art in enumerate(articles, 1):
        is_global = art.get('region') == 'GLOBAL'
        region_code = 'GLOBAL' if is_global else 'JP'
        badge_class = 'badge-global' if is_global else 'badge-jp'
        badge_text = '海外 Global' if is_global else '国内 Japan'
        category_name = art.get('category', config['sample_category'])
        orig_title = art.get('original_title', '')
        orig_html = f'<div class="original-title">{esc(orig_title)}</div>' if orig_title else ''
        safe_url = sanitize_url(art.get('url', ''))
        has_source = safe_url != '#'
        raw_title = art.get('title', '')

        bold_summary = bold_scan_text(esc(art.get('summary', '')), kw_regex)
        takeaway, detail_wim = split_takeaway(art.get('why_it_matters', ''))
        bold_takeaway = bold_scan_text(esc(takeaway), kw_regex)
        bold_detail = bold_scan_text(esc(detail_wim), kw_regex)

        if has_source:
            title_inner = f"""
            <a href="{safe_url}" target="_blank" rel="noopener noreferrer">
              {esc(raw_title)}
              {ICON_EXTERNAL_SVG}
            </a>
          """
            source_link_html = f'<a class="source-link" href="{safe_url}" target="_blank" rel="noopener noreferrer">元記事を読む &rarr;</a>'
        else:
            title_inner = esc(raw_title)
            source_link_html = '<span class="source-link is-missing" title="出典URLを特定できませんでした">出典リンクなし</span>'

        tweet_text = f"{raw_title} | {config['media_name']} {date_key}"
        media_id = config['media_id']
        share_url = f"https://tk.st/job/{media_id}/{date_key}/#art-{idx}"
        tweet_intent = f"https://x.com/intent/post?text={urllib.parse.quote(tweet_text)}&url={urllib.parse.quote(share_url)}"

        articles_html.append(f"""
        <article class="news-card" id="art-{idx}" data-region="{region_code}" data-category="{esc(category_name)}">
          <div class="card-meta">
            <button type="button" class="region-badge {badge_class}" data-filter-trigger="region" data-filter-val="{region_code}" title="この地域のニュースで絞り込み">{badge_text}</button>
            <button type="button" class="category-badge" data-filter-trigger="category" data-filter-val="{esc(category_name)}" title="このカテゴリで絞り込み">{esc(category_name)}</button>
            <span class="source-tag">{esc(art.get('source', '業界速報'))}</span>
          </div>
          <h3 class="card-title">{title_inner}</h3>
          {orig_html}
          <div class="card-summary"><p>{bold_summary}</p></div>
          <div class="why-it-matters">
            <div class="wim-header">
              {ICON_WIM_SVG}
              <strong>Why it matters（ビジネス・テック的示唆）</strong>
            </div>
            <div class="wim-takeaway">
              <span class="takeaway-badge">KEY TAKEAWAY</span>
              <p class="takeaway-text">{bold_takeaway}</p>
            </div>
            {f'<p class="wim-detail">{bold_detail}</p>' if bold_detail else ''}
          </div>
          <div class="card-footer">
            <div class="card-actions">
              <button type="button" class="share-copy-btn" data-share-title="{esc(raw_title)}" data-share-takeaway="{esc(takeaway)}" data-share-url="https://tk.st/job/{config['media_id']}/{date_key}/#art-{idx}" data-share-prefix="{esc(config['share_prefix'])}" title="SlackやTeamsの社内共有用にコピー">
                {ICON_COPY_SVG}
                <span>社内共有コピー</span>
              </button>
              <a href="{tweet_intent}" target="_blank" rel="noopener noreferrer" class="x-share-btn" title="Xでポスト">
                {ICON_X_SVG}
              </a>
              {source_link_html}
            </div>
          </div>
        </article>
        """)

    exec_summary_list = issue_data.get('executive_summary', [])
    exec_summary_html = "".join([f"<li>{esc(item)}</li>" for item in exec_summary_list])
    # AIは通常ちょうど3点で生成するが、後日の手動修正等で件数が変わることもあるため、
    # 3点ちょうどの時だけ「3大」と謳い、それ以外は件数を偽らない汎用見出しにする。
    exec_title_text = "昨日の3大重要トピック（Executive Summary）" if len(exec_summary_list) == 3 else "昨日の重要トピック（Executive Summary）"
    p_link = f'<a href="../{prev_issue["date"]}/" class="nav-prev">&larr; {prev_issue["date"][:4]}/{prev_issue["date"][4:6]}/{prev_issue["date"][6:8]} 号</a>' if prev_issue else '<span class="nav-disabled">&larr; 前号</span>'
    n_link = f'<a href="../{next_issue["date"]}/" class="nav-next">{next_issue["date"][:4]}/{next_issue["date"][4:6]}/{next_issue["date"][6:8]} 号 &rarr;</a>' if next_issue else '<span class="nav-disabled">最新号</span>'

    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="../../../data/analytics.js" async></script>
  <title>{formatted_date}号：昨日の{config['brand_title_short']}まとめ — {config['media_name']} | tk.st</title>
  <meta name="description" content="{dynamic_page_desc}">
  <meta name="author" content="Shinya Takeda">
  <meta name="robots" content="max-image-preview:large">
  <meta name="theme-color" content="{config['theme_color']}">

  <link rel="canonical" href="https://tk.st/job/{config['media_id']}/{date_key}/">
  <link rel="author" href="https://tk.st/">

  <meta property="og:title" content="{formatted_date}号：昨日の{config['brand_title_short']}まとめ — {config['media_name']}">
  <meta property="og:description" content="{dynamic_page_desc}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://tk.st/job/{config['media_id']}/{date_key}/">
  <meta property="og:site_name" content="{config['media_name']} | tk.st">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:image" content="https://tk.st/images/ogp/{config['media_id']}-{date_key}.webp">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{formatted_date}号：昨日の{config['brand_title_short']}まとめ — {config['media_name']}">
  <meta name="twitter:description" content="{dynamic_page_desc}">
  <meta name="twitter:image" content="https://tk.st/images/ogp/{config['media_id']}-{date_key}.webp">

  <link rel="icon" href="../../../images/favicons/{config['favicon_file']}" type="image/svg+xml">
  <link rel="apple-touch-icon" href="../../../images/favicons/{config['favicon_file']}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;700;800&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap" rel="stylesheet">
  <script type="application/ld+json">
{dynamic_jsonld_str}
  </script>
  <link rel="stylesheet" href="../../../data/{config['css_file']}">
</head>
<body id="top">
  <div class="reading-progress" id="readingProgress" aria-hidden="true"></div>
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-59NWV9XK" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
  <header class="site-header">
    <div class="container header-inner">
      <a href="../" class="brand-logo">
        {config['brand_logo_svg']}
        <div>
          <div class="brand-title">{config['brand_title']}</div>
          <span class="brand-subtitle">{config['brand_subtitle']}</span>
        </div>
      </a>
    </div>
  </header>

  <main class="container">
    <nav class="breadcrumbs">
      <a href="https://tk.st/">⌂ Shinya Takeda</a><span>/</span>
      <a href="../../">Job</a><span>/</span>
      <a href="../">{config['brand_title']}</a><span>/</span>
      <strong>{formatted_date}号</strong>
    </nav>

    <section class="issue-hero">
      <div class="issue-meta-row">
        <span class="daily-tag">Daily Brief</span>
        <span class="issue-date-label">{formatted_date} 08:00 JST 配信</span>
        <span class="reading-time-badge">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          読了目安 約{reading_minutes}分（{total_chars:,}文字）
        </span>
        <span class="engine-badge {engine_class}"><span class="engine-dot"></span>{engine_label}</span>
      </div>
      <h1 class="hero-title">{formatted_date}号：昨日の{config['brand_title_short']}まとめ</h1>
      <p class="hero-desc">{config['hero_desc']}</p>
    </section>

    <section class="executive-card">
      <div class="exec-title">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        <span>{exec_title_text}</span>
      </div>
      <ul class="exec-list">{exec_summary_html}</ul>
    </section>

    <section class="quick-index-card">
      <div class="qi-header">
        <div class="qi-title-wrap">
          <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
          <span>本日のヘッドライン目次（30秒スキャン）</span>
        </div>
        <div style="display:flex; align-items:center; gap:12px;">
          {f'<a href="#snsBuzzSection" class="qi-sns-link">{ICON_X_SVG} <span>Xリアル反響 ({len(sns_buzz)}件) ↓</span></a>' if sns_buzz else ''}
          <span class="qi-sub">タップで各記事へジャンプ</span>
        </div>
      </div>
      <ol class="qi-list">
{quick_index_html}
      </ol>
    </section>

    <section class="articles-section" id="articlesSection">
      <div class="section-headline">
        <h2>厳選トピックス</h2>
      </div>

      <div class="filter-wrapper">
        <div class="filter-bar-header">
          <div class="filter-label">
            <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.5" fill="none"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
            <span>種別で絞込</span>
          </div>
          <div class="filter-actions">
            <span class="filter-status">表示中: <strong id="visibleArticlesCount">{total_count}</strong> / {total_count} 件</span>
            <button type="button" class="filter-reset-btn" id="filterResetBtn" style="display:none;">条件リセット &times;</button>
            <div class="view-mode-toggle" id="viewModeToggle" role="button" tabindex="0" aria-label="3行コンパクト表示切替" aria-pressed="false" data-current-mode="detail" title="3行コンパクト表示に切り替え">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-text">3行コンパクト表示</span>
            </div>
          </div>
        </div>
        <div class="filter-chips-scroll" role="toolbar" aria-label="ニュース絞り込み">
          <button type="button" class="filter-chip active" data-filter-type="all" data-filter-val="all" aria-pressed="true">すべて <span class="chip-count">{total_count}</span></button>
          <span class="chip-divider" aria-hidden="true"></span>
          <button type="button" class="filter-chip" data-filter-type="region" data-filter-val="JP" aria-pressed="false">国内 <span class="chip-count">{sum(1 for a in articles if a.get('region') != 'GLOBAL')}</span></button>
          <button type="button" class="filter-chip" data-filter-type="region" data-filter-val="GLOBAL" aria-pressed="false">海外 <span class="chip-count">{sum(1 for a in articles if a.get('region') == 'GLOBAL')}</span></button>
          <span class="chip-divider" aria-hidden="true"></span>
          {cat_chips_html}
        </div>
      </div>

      <div class="articles-list detail-view" id="articlesList">
        {"".join(articles_html)}
      </div>

      <div class="no-results-msg" id="noResultsMsg" style="display:none;">
        <p>該当する条件のニュースは見つかりませんでした。</p>
      </div>
    </section>

    {sns_buzz_html}

    <nav class="issue-nav" aria-label="前後の号への移動">
      {p_link}
      <a href="../" class="nav-archive">一覧へ戻る</a>
      {n_link}
    </nav>
  </main>

  <footer class="site-footer">
    <div class="container">
      <div class="footer-layout">
        <div class="footer-left">
          <div id="donation-button-container"></div>
        </div>
        <div class="footer-center">
          <div class="footer-links">
            <a href="https://tk.st/">Home</a><a href="../">{config['brand_title']}</a><a href="../#faq">FAQ</a><a href="../rss.xml">RSS</a><a href="https://tk.st/contact/">Contact</a>
          </div>
          <p>&copy; 2026 Shinya Takeda (tk.st). All rights reserved.</p>
        </div>
        <div class="footer-right-spacer" aria-hidden="true"></div>
      </div>
    </div>
  </footer>

  <a href="#top" class="btn-top" id="btnTop" aria-label="最上部へ戻る" title="最上部へ戻る">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg>
  </a>

  <script src="../../../data/buy-me-oil.js"></script>
  <script src="../../../data/daily-ui.js"></script>
</body>
</html>
"""


def build_meta_pills_html(config, latest):
    if not latest:
        return ''
    date_key = latest['date']
    articles = latest.get('articles', [])
    seen = []
    for art in articles:
        cat = art.get('category')
        if cat and cat not in seen:
            seen.append(cat)

    pills = []
    for cat in seen:
        label = config['category_pill_labels'].get(cat, cat)
        query = 'category:' + urllib.parse.quote(cat, safe='')
        pills.append(f'<a href="{esc(date_key)}/?filter={query}" class="meta-pill-item">{esc(label)}</a>')

    if any(art.get('region') == 'GLOBAL' for art in articles):
        pills.append(f'<a href="{esc(date_key)}/?filter=region:GLOBAL" class="meta-pill-item">🌍 海外ニュースすべて</a>')

    return "\n        ".join(pills)


def render_top_index_html(config, articles_history):
    latest = articles_history[0] if articles_history else None
    latest_date_formatted = f"{latest['date'][:4]}年{int(latest['date'][4:6])}月{int(latest['date'][6:8])}日" if latest else ""
    latest_highlights = "".join([f"<li>{esc(h)}</li>" for h in latest.get('executive_summary', [])[:3]]) if latest else ""
    latest_engine = esc(latest.get('generated_by', 'DeepSeek AI')) if latest else ""
    latest_engine_type = esc(latest.get('engine_type', 'deepseek')) if latest else ""
    meta_pills_html = build_meta_pills_html(config, latest)

    history_cards = []
    for issue in articles_history[:40]:
        d = esc(issue['date'])
        d_fmt = f"{d[:4]}年{int(d[4:6])}月{int(d[6:8])}日"
        summary_preview = esc(issue.get('summary', '') or f"昨日の{config['brand_title_short']}まとめ。")
        count = int(issue.get('count', len(issue.get('articles', []))))
        title = esc(issue.get('title', f'{d_fmt}号まとめ'))
        eng_label = esc(issue.get('generated_by', ''))
        eng_tag = f'<span class="history-engine">• {eng_label.split()[0]}</span>' if eng_label else ''

        history_cards.append(f"""
        <a href="{d}/" class="history-card">
          <div class="history-card-header">
            <span class="history-date">{d_fmt} 号</span>
            <span class="history-count">{count} 本 {eng_tag}</span>
          </div>
          <div class="history-title">{title}</div>
          <div class="history-desc">{summary_preview}</div>
          <div class="history-arrow">記事を読む &rarr;</div>
        </a>
        """)

    faq_jsonld_entities = []
    faq_html_items = []
    for idx, item in enumerate(config['faq_items'], 1):
        clean_ans = clean_html_text(item["a"])
        faq_jsonld_entities.append({
            "@type": "Question",
            "name": item["q"],
            "acceptedAnswer": {"@type": "Answer", "text": clean_ans}
        })
        is_open = " open" if idx == 1 else ""
        faq_html_items.append(f"""        <details class="faq-item"{is_open}>
          <summary class="faq-question">
            <span class="faq-q-badge">Q</span>
            <span class="faq-q-text">{esc(item['q'])}</span>
            <span class="faq-toggle-icon"></span>
          </summary>
          <div class="faq-answer">
            <p>{item['a']}</p>
          </div>
        </details>""")

    faq_accordion_html = "\n".join(faq_html_items)

    latest_date_str = latest['date'] if latest else '20260912'
    latest_iso_date = f"{latest_date_str[:4]}-{latest_date_str[4:6]}-{latest_date_str[6:8]}T08:00:00+09:00"
    earliest_date_str = articles_history[-1]['date'] if articles_history else latest_date_str
    earliest_iso_date = f"{earliest_date_str[:4]}-{earliest_date_str[4:6]}-{earliest_date_str[6:8]}T08:00:00+09:00"
    base_url = f"https://tk.st/job/{config['media_id']}/"

    issue_items = []
    for idx, issue in enumerate(articles_history[:20], 1):
        d = issue['date']
        d_iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}T08:00:00+09:00"
        d_fmt = f"{d[:4]}年{int(d[4:6])}月{int(d[6:8])}日"
        issue_items.append({
            "@type": "ListItem",
            "position": idx,
            "item": {
                "@type": "PublicationIssue",
                "@id": f"{base_url}{d}/#issue",
                "issueNumber": d,
                "name": issue.get('title', f"{d_fmt}号まとめ"),
                "description": clean_html_text(issue.get('summary', '')),
                "url": f"{base_url}{d}/",
                "datePublished": d_iso
            }
        })

    portal_graph = [
        {
            "@type": "BreadcrumbList",
            "@id": f"{base_url}#breadcrumb",
            "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Shinya Takeda", "item": "https://tk.st/" },
                { "@type": "ListItem", "position": 2, "name": "Job", "item": "https://tk.st/job/" },
                { "@type": "ListItem", "position": 3, "name": config['brand_title'], "item": base_url }
            ]
        },
        {
            "@type": "Periodical",
            "@id": f"{base_url}#periodical",
            "name": config['media_name'],
            "alternateName": config['periodical_alternates'],
            "headline": config['brand_subtitle'],
            "description": config['brand_desc'],
            "url": base_url,
            "inLanguage": "ja",
            "issuanceFrequency": "P1D",
            "about": config['periodical_about'],
            "publisher": { "@id": PERSON_ID }
        },
        {
            "@type": "CollectionPage",
            "@id": f"{base_url}#portal",
            "isPartOf": { "@id": f"{base_url}#periodical" },
            "name": f"{config['media_name']} — ポータル＆アーカイブ",
            "headline": f"昨日の{config['brand_title_short']}動向をAI要約＋ビジネス示唆付きで届ける日刊速報",
            "description": config['brand_desc'],
            "url": base_url,
            "primaryImageOfPage": config['portal_ogp_image'],
            "inLanguage": "ja",
            "datePublished": earliest_iso_date,
            "dateModified": latest_iso_date,
            "author": { "@id": PERSON_ID },
            "publisher": { "@id": PERSON_ID },
            "mainEntity": { "@id": f"{base_url}#issuelist" }
        },
        {
            "@type": "ItemList",
            "@id": f"{base_url}#issuelist",
            "name": f"{config['media_name']} バックナンバー一覧",
            "numberOfItems": len(articles_history),
            "itemListElement": issue_items
        },
        {
            "@type": "FAQPage",
            "@id": f"{base_url}#faq",
            "name": f"{config['media_name']} よくあるご質問",
            "mainEntity": faq_jsonld_entities
        },
        {
            "@type": "Person",
            "@id": PERSON_ID,
            "name": "Shinya Takeda",
            "url": "https://tk.st/job/",
            "jobTitle": "Digital Marketer / Tech Lead",
            "knowsAbout": config['person_knows_about'],
            "sameAs": ["https://tk.st/", "https://github.com/tk33r1"]
        }
    ]
    portal_jsonld_str = escape_jsonld_for_script(json.dumps({"@context": "https://schema.org", "@graph": portal_graph}, ensure_ascii=False, indent=2))

    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="../../data/analytics.js" async></script>
  <title>{config['media_name']} — {config['brand_subtitle']} | tk.st</title>
  <meta name="description" content="{config['brand_desc']}">
  <meta name="author" content="Shinya Takeda">
  <meta name="robots" content="max-image-preview:large">
  <meta name="theme-color" content="{config['theme_color']}">

  <link rel="canonical" href="{base_url}">
  <link rel="author" href="https://tk.st/">
  <link rel="alternate" type="application/rss+xml" title="{config['media_name']} RSS" href="{base_url}rss.xml">

  <meta property="og:title" content="{config['media_name']} — {config['brand_subtitle']} | tk.st">
  <meta property="og:description" content="{config['brand_desc']}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="{base_url}">
  <meta property="og:site_name" content="{config['media_name']} | tk.st">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:image" content="{config['portal_ogp_image']}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{config['media_name']} — {config['brand_subtitle']} | tk.st">
  <meta name="twitter:description" content="{config['brand_desc']}">
  <meta name="twitter:image" content="{config['portal_ogp_image']}">

  <link rel="icon" href="../../images/favicons/{config['favicon_file']}" type="image/svg+xml">
  <link rel="apple-touch-icon" href="../../images/favicons/{config['favicon_file']}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;700;800&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap" rel="stylesheet">
  <script type="application/ld+json">
{portal_jsonld_str}
  </script>
  <link rel="stylesheet" href="../../data/{config['css_file']}">
</head>
<body id="top">
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-59NWV9XK" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
  <header class="site-header">
    <div class="container header-inner">
      <a href="./" class="brand-logo">
        {config['brand_logo_svg']}
        <div>
          <div class="brand-title">{config['brand_title']}</div>
          <span class="brand-subtitle">{config['brand_subtitle']}</span>
        </div>
      </a>
      <div class="header-nav">
        <a href="rss.xml" class="nav-icon-btn" target="_blank" rel="noopener noreferrer" aria-label="RSSを購読" title="RSSを購読">
          {ICON_RSS_SVG}
        </a>
      </div>
    </div>
  </header>

  <main class="container">
    <nav class="breadcrumbs">
      <a href="https://tk.st/">⌂ Shinya Takeda</a><span>/</span>
      <a href="../">Job</a><span>/</span>
      <strong>{config['brand_title']}</strong>
    </nav>

    <section class="portal-hero">
      <div class="badge-pill"><span class="badge-dot"></span>毎朝 08:00 JST 配信</div>
      <h1 class="portal-title">{config['media_name']}</h1>
      <p class="portal-desc">{config['portal_hero_desc']}</p>
      <div class="meta-pills">
{meta_pills_html}
      </div>
    </section>

    {f'''
    <section class="featured-latest">
      <div class="featured-header">
        <div class="featured-meta">
          <span class="featured-badge">Latest Issue</span>
          <span class="featured-date">{latest_date_formatted} 08:00 号</span>
        </div>
        <div><span class="engine-badge engine-{latest_engine_type}"><span class="engine-dot"></span>{latest_engine}</span></div>
      </div>
      <h2 class="featured-title">
        <a href="{latest["date"]}/">{esc(latest.get("title", f"{latest_date_formatted}号 速報"))}</a>
      </h2>
      <ul class="featured-highlights">{latest_highlights}</ul>
      <a href="{latest["date"]}/" class="featured-btn">
        <span>最新号を読む</span>
        <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
      </a>
    </section>
    ''' if latest else ''}

    <section class="archive-section">
      <h2 style="font-size:20px; font-weight:800; margin-bottom:18px;">バックナンバー・アーカイブ</h2>
      <div class="history-grid">{"".join(history_cards)}</div>
    </section>

    <section class="faq-section" id="faq">
      <div class="faq-header">
        <h2>
          <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          よくあるご質問（FAQ）
        </h2>
      </div>
      <div class="faq-accordion">
{faq_accordion_html}
      </div>
    </section>

    <div class="curator-card">
      <div class="curator-avatar">ST</div>
      <div class="curator-info">
        <h4>Curated by Shinya Takeda</h4>
        <p>EC/流通のUI/UX改善からAI・Web3プロダクト開発まで。ビジネス課題をテクノロジーで解決するデジタルマーケター / テックリードのポートフォリオをご覧ください。<a href="../" class="text-link">Works &amp; Profileを見る &rarr;</a></p>
      </div>
    </div>
  </main>

  <footer class="site-footer">
    <div class="container">
      <div class="footer-layout">
        <div class="footer-left">
          <div id="donation-button-container"></div>
        </div>
        <div class="footer-center">
          <div class="footer-links">
            <a href="https://tk.st/">Home</a><a href="./">{config['brand_title']}</a><a href="#faq">FAQ</a><a href="rss.xml">RSS</a><a href="https://tk.st/contact/">Contact</a>
          </div>
          <p>&copy; 2026 Shinya Takeda (tk.st). All rights reserved.</p>
        </div>
        <div class="footer-right-spacer" aria-hidden="true"></div>
      </div>
    </div>
  </footer>

  <a href="#top" class="btn-top" id="btnTop" aria-label="最上部へ戻る" title="最上部へ戻る">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg>
  </a>

  <script src="../../data/buy-me-oil.js"></script>
  <script src="../../data/daily-ui.js"></script>
</body>
</html>
"""


def generate_rss_xml(config, articles_history):
    items_xml = []
    latest_pub_dt = None
    base_url = f"https://tk.st/job/{config['media_id']}/"

    for issue in articles_history[:15]:
        d = issue['date']
        pub_dt = datetime.strptime(d, '%Y%m%d').replace(hour=8, minute=0, second=0, tzinfo=JST)
        if latest_pub_dt is None or pub_dt > latest_pub_dt:
            latest_pub_dt = pub_dt
        rfc822_date = email.utils.format_datetime(pub_dt)
        desc_escaped = esc(issue.get('summary') or '')
        title_escaped = esc(issue.get('title', f'{d}号'))

        items_xml.append(f"""    <item>
      <title>{title_escaped}</title>
      <link>{base_url}{d}/</link>
      <guid isPermaLink="true">{base_url}{d}/</guid>
      <pubDate>{rfc822_date}</pubDate>
      <description>{desc_escaped}</description>
    </item>""")

    channel_pub_date = email.utils.format_datetime(latest_pub_dt) if latest_pub_dt else ''
    last_build_date = email.utils.format_datetime(datetime.now(JST))
    channel_dates = f"    <pubDate>{channel_pub_date}</pubDate>\n" if channel_pub_date else ''
    items_joined = "\n".join(items_xml)

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>{config['media_name']} — {config['brand_subtitle']}</title>
    <link>{base_url}</link>
    <description>{config['brand_desc']}</description>
    <language>ja</language>
{channel_dates}    <lastBuildDate>{last_build_date}</lastBuildDate>
    <ttl>720</ttl>
    <generator>{config['media_name']} generator</generator>
    <atom:link href="{base_url}rss.xml" rel="self" type="application/rss+xml"/>
{items_joined}
  </channel>
</rss>
"""


def trigger_daily_ogp_generation(config, date_key):
    ogp_script = os.path.join(REPO_ROOT, '.github', 'scripts', 'ogp', 'generate-daily-ogp.js')
    if not os.path.exists(ogp_script):
        print(f"[WARN] OGP 生成スクリプトが見つかりません: {ogp_script}", file=sys.stderr)
        return
    print(f" -> 日刊 OGP 画像生成中 (Lossless WebP): {date_key}...")
    try:
        import subprocess
        res = subprocess.run(['node', ogp_script, config['ogp_target'], str(date_key)], cwd=REPO_ROOT, capture_output=True, text=True, check=True)
        print(f" -> {res.stdout.strip()}")
    except Exception as e:
        print(f"[WARN] OGP 画像生成に失敗しました（記事生成自体は継続します）: {e}", file=sys.stderr)


def run_daily_pipeline(config):
    parser = argparse.ArgumentParser(description=f"{config['media_name']} Pipeline")
    parser.add_argument('--date', type=str, default='', help='Target issue date in YYYYMMDD format')
    parser.add_argument('--rebuild', action='store_true', help='Rebuild HTML and RSS from existing JSON')
    parser.add_argument('--dry-run', action='store_true', help='Collect candidates and display them without AI summarization')
    args = parser.parse_args()

    data_json_path = config['data_json_path']
    job_dir = config['job_dir']
    rss_xml_path = os.path.join(job_dir, 'rss.xml')
    top_html_path = os.path.join(job_dir, 'index.html')

    if args.rebuild:
        print(f"=== {config['media_name']}: Rebuilding HTML and RSS from JSON ===")
        if not os.path.exists(data_json_path):
            print(f"[ERROR] {data_json_path} が存在しません。", file=sys.stderr)
            sys.exit(1)
        with open(data_json_path, 'r', encoding='utf-8') as f:
            articles_history = json.load(f)
        articles_history.sort(key=lambda x: x['date'], reverse=True)

        for i, issue in enumerate(articles_history):
            prev_issue = articles_history[i + 1] if i + 1 < len(articles_history) else None
            next_issue = articles_history[i - 1] if i > 0 else None
            d = issue['date']
            d_fmt = f"{d[:4]}年{int(d[4:6])}月{int(d[6:8])}日"
            issue_html = render_article_html(config, issue, d, d_fmt, prev_issue, next_issue)
            issue_dir = os.path.join(job_dir, d)
            os.makedirs(issue_dir, exist_ok=True)
            with open(os.path.join(issue_dir, 'index.html'), 'w', encoding='utf-8') as f:
                f.write(issue_html)
            print(f" -> 再生成: {d}号 HTML")

        top_html = render_top_index_html(config, articles_history)
        with open(top_html_path, 'w', encoding='utf-8') as f:
            f.write(top_html)
        print(f" -> 再生成: トップポータル index.html")

        rss_content = generate_rss_xml(config, articles_history)
        with open(rss_xml_path, 'w', encoding='utf-8') as f:
            f.write(rss_content)
        print(f" -> 再生成: rss.xml")
        print("=== Rebuild 完了 ===")
        return

    print(f"=== {config['media_name']} 開始 (v3.0 Common Engine) ===")
    if args.date:
        target_dt = datetime.strptime(args.date, '%Y%m%d').replace(tzinfo=JST)
    else:
        target_dt = datetime.now(JST)

    target_date_key = target_dt.strftime('%Y%m%d')
    target_date_formatted = f"{target_date_key[:4]}年{int(target_date_key[4:6])}月{int(target_date_key[6:8])}日"
    yesterday_dt = target_dt - timedelta(days=1)
    yesterday_str = f"{yesterday_dt.month}月{yesterday_dt.day}日"

    print(f"発行日: {target_date_formatted} ({target_date_key} 08:00 JST) / 対象日: {yesterday_str}")

    candidates = gather_all_candidate_news(config, target_dt, exclude_date_key=target_date_key)

    if args.dry_run:
        print("\n=== DRY-RUN: 候補ニュース一覧 ===")
        print(f"[国内候補: {len(candidates['JP'])} 件]")
        for i, it in enumerate(candidates['JP'][:15], 1):
            is_sns = "★[SNSバズ]" if it.get('is_sns_raw') else ""
            print(f" {i:02d}. {is_sns} {it['title']} ({it['source']})")
        print(f"\n[海外候補: {len(candidates['GLOBAL'])} 件]")
        for i, it in enumerate(candidates['GLOBAL'][:10], 1):
            print(f" {i:02d}. {it['title']} ({it['source']})")
        print("\n=== DRY-RUN 完了 (AI要約・ファイル出力はスキップ) ===")
        return

    ai_result = analyze_news_with_fallback(config, candidates, target_date_formatted, yesterday_str)

    articles_history = []
    if os.path.exists(data_json_path):
        try:
            with open(data_json_path, 'r', encoding='utf-8') as f:
                articles_history = json.load(f)
        except Exception:
            pass

    articles_history = [a for a in articles_history if a.get('date') != target_date_key]

    exec_summary = ai_result.get('executive_summary', [])
    issue_summary = " ".join(exec_summary[:2]) if exec_summary else f"{target_date_formatted}の{config['brand_title_short']}まとめ。"

    new_issue = {
        "date": target_date_key,
        "title": f"{target_date_formatted}号：昨日の{config['brand_title_short']}まとめ",
        "summary": issue_summary,
        "count": len(ai_result.get('articles', [])),
        "generated_by": ai_result.get('generated_by', 'DeepSeek AI'),
        "engine_type": ai_result.get('engine_type', 'deepseek'),
        "executive_summary": exec_summary,
        "articles": ai_result.get('articles', []),
        "sns_buzz": ai_result.get('sns_buzz', []),
        "sns_summary": ai_result.get('sns_summary', ''),
        "sns_why_it_matters": ai_result.get('sns_why_it_matters', '')
    }
    articles_history.append(new_issue)
    articles_history.sort(key=lambda x: x['date'], reverse=True)

    print("[3/3] ファイル出力中...")
    with open(data_json_path, 'w', encoding='utf-8') as f:
        json.dump(articles_history, f, ensure_ascii=False, indent=2)

    # 新規追加号と、その前後で prev/next リンクが変わる隣接号だけ再生成すれば十分
    # （それ以外の過去号の内容・リンク先は今回の追加で変化しない）
    new_index = next(i for i, iss in enumerate(articles_history) if iss['date'] == target_date_key)
    indices_to_render = {new_index}
    if new_index > 0:
        indices_to_render.add(new_index - 1)
    if new_index + 1 < len(articles_history):
        indices_to_render.add(new_index + 1)

    for i in sorted(indices_to_render):
        issue = articles_history[i]
        prev_issue = articles_history[i + 1] if i + 1 < len(articles_history) else None
        next_issue = articles_history[i - 1] if i > 0 else None
        d = issue['date']
        d_fmt = f"{d[:4]}年{int(d[4:6])}月{int(d[6:8])}日"
        issue_html = render_article_html(config, issue, d, d_fmt, prev_issue, next_issue)
        issue_dir = os.path.join(job_dir, d)
        os.makedirs(issue_dir, exist_ok=True)
        with open(os.path.join(issue_dir, 'index.html'), 'w', encoding='utf-8') as f:
            f.write(issue_html)

    top_html = render_top_index_html(config, articles_history)
    with open(top_html_path, 'w', encoding='utf-8') as f:
        f.write(top_html)

    rss_content = generate_rss_xml(config, articles_history)
    with open(rss_xml_path, 'w', encoding='utf-8') as f:
        f.write(rss_content)

    trigger_daily_ogp_generation(config, target_date_key)
    print(f"=== 完了: {config['media_name']} ({target_date_key}号 / Engine: {ai_result.get('generated_by')}) ===")
