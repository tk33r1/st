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
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
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
ICON_SHARE_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"></path></svg>'
ICON_X_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'
ICON_RSS_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9"></path><path d="M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"></circle></svg>'
ICON_SEARCH_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.3" fill="none" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="16.2" y1="16.2" x2="21" y2="21"></line></svg>'
ICON_MENU_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line></svg>'
ICON_TIKTOK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5 2.6 2.6 0 0 1-2.6-2.6c0-1.72 1.66-3.01 3.37-2.48V9.66c-3.45-.46-6.47 2.22-6.47 5.64 0 3.33 2.76 5.7 5.69 5.7 3.14 0 5.69-2.55 5.69-5.7V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3s-1.88.09-3.24-1.48z"/></svg>'
ICON_INSTAGRAM_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><rect x="2" y="2" width="20" height="20" rx="5.5"></rect><circle cx="12" cy="12" r="4.2"></circle><circle cx="17.6" cy="6.4" r="1.2" fill="currentColor" stroke="none"></circle></svg>'

# SNS バズカードのプラットフォーム別メタ情報。
# 過去号の JSON には platform キーが無いため、未設定は 'x' にフォールバックする。
SNS_PLATFORM_META = {
    'x': {
        'order': 0,
        'label': 'X',
        'icon': ICON_X_SVG,
        'badge_class': 'sns-badge-x',
        'link_text': 'Xでポストを見る',
        'author_fallback': 'Xユーザー',
        'tags': ["SNS話題", "生活者UX", "バズアイテム"],
    },
    'tiktok': {
        'order': 1,
        'label': 'TikTok',
        'icon': ICON_TIKTOK_SVG,
        'badge_class': 'sns-badge-tiktok',
        'link_text': 'TikTokで動画を見る',
        'author_fallback': 'TikTokユーザー',
        'tags': ["TikTok話題", "生活者UX", "バズ動画"],
    },
    'instagram': {
        'order': 2,
        'label': 'Instagram',
        'icon': ICON_INSTAGRAM_SVG,
        'badge_class': 'sns-badge-ig',
        'link_text': 'Instagramでリールを見る',
        'author_fallback': 'Instagramユーザー',
        'tags': ["Instagram話題", "生活者UX", "バズリール"],
    },
}


def sns_platform_meta(platform):
    return SNS_PLATFORM_META.get(platform or 'x', SNS_PLATFORM_META['x'])


def esc(s):
    return html.escape(str(s or ''), quote=True)


def clean_generated_text(value):
    """テンプレート内の条件付き空行が残す末尾空白を除去する。"""
    return '\n'.join(line.rstrip() for line in value.splitlines()) + '\n'


def load_json_list(path):
    """履歴 JSON を読み込む。破損時は空データとして続行せず、既存履歴を保護する。"""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            value = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError(f"履歴 JSON を読み込めないため処理を中止します: {path}") from e
    if not isinstance(value, list):
        raise RuntimeError(f"履歴 JSON のルート要素が配列ではありません: {path}")
    return value


def write_json_atomic(path, value, **dump_options):
    """同一ディレクトリの一時ファイルへ書き出してから置換し、途中終了による破損を防ぐ。"""
    directory = os.path.dirname(path) or '.'
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=f'.{os.path.basename(path)}.', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(value, f, ensure_ascii=False, **dump_options)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def sibling_media_link(config, path_prefix):
    """ハンバーガーメニューに表示する姉妹メディアへのリンクを返す。"""
    siblings = {
        'retailtechdaily': ('nitoridaily', 'Nitori Daily'),
        'nitoridaily': ('retailtechdaily', 'Retail Tech Daily'),
    }
    sibling = siblings.get(config.get('media_id'))
    if not sibling:
        return ''
    media_id, title = sibling
    return f'<a href="{path_prefix}{media_id}/" class="header-menu-media-link">{title}</a>'


def render_site_header(config, brand_href, search_action, menu_links, sibling_prefix):
    """ポータルと個別号で共通のサイトヘッダーを描画する。"""
    items = []
    for href, label, external in menu_links:
        external_attrs = ' target="_blank" rel="noopener noreferrer"' if external else ''
        items.append(f'<a href="{esc(href)}"{external_attrs}>{esc(label)}</a>')
    sibling = sibling_media_link(config, sibling_prefix)
    if sibling:
        items.append(sibling)
    menu_html = '\n            '.join(items)
    return f'''<header class="site-header">
    <div class="header-inner">
      <a href="{esc(brand_href)}" class="brand">
        <span class="brand-mark">{config['brand_logo_svg']}</span>
        <span class="brand-text">
          <span class="brand-name">{config['brand_title']}</span>
          <span class="brand-tag">{config['brand_subtitle']}</span>
        </span>
      </a>
      <div class="header-actions">
        <form class="header-search" action="{esc(search_action)}" method="get" role="search">
          <label class="header-search-label" for="headerSearchInput">記事を検索</label>
          <input type="search" id="headerSearchInput" name="q" autocomplete="off" placeholder="記事を検索">
          <button type="submit" class="header-search-submit" aria-label="検索">{ICON_SEARCH_SVG}</button>
        </form>
        <div class="header-menu">
          <button type="button" class="icon-btn header-menu-button" id="dailyMenuButton" aria-expanded="false" aria-controls="dailyMenuPanel" aria-label="メニューを開く" title="メニュー">{ICON_MENU_SVG}</button>
          <nav class="header-menu-panel" id="dailyMenuPanel" aria-label="メニュー" hidden>
            {menu_html}
          </nav>
        </div>
      </div>
    </div>
  </header>'''


def render_page_footer(config, media_href, faq_href, rss_href):
    """共通フッターとページ先頭へ戻るボタンを描画する。"""
    return f'''<footer class="site-footer">
    <div class="container">
      <div class="footer-layout">
        <div class="footer-left">
          <div id="donation-button-container"></div>
        </div>
        <div class="footer-center">
          <div class="footer-links">
            <a href="https://tk.st/">Home</a><a href="{esc(media_href)}">{config['brand_title']}</a><a href="{esc(faq_href)}">FAQ</a><a href="{esc(rss_href)}">RSS</a><a href="https://tk.st/contact/?to={esc(config['media_id'])}">Contact</a>
          </div>
          <p class="footer-copy">&copy; 2026 Shinya Takeda (tk.st). All rights reserved.</p>
        </div>
        <div class="footer-right-spacer" aria-hidden="true"></div>
      </div>
    </div>
  </footer>

  <a href="#top" class="btn-top" id="btnTop" aria-label="最上部へ戻る" title="最上部へ戻る">
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>
  </a>'''


_JSONLD_SCRIPT_ESCAPE_TABLE = str.maketrans({'<': '\\u003c', '>': '\\u003e', '&': '\\u0026'})


def escape_jsonld_for_script(json_str):
    """外部由来のテキスト（記事タイトル等）が </script> を含んでいても
    <script type="application/ld+json"> を閉じてしまわないようにする。"""
    return json_str.translate(_JSONLD_SCRIPT_ESCAPE_TABLE)


def sanitize_url(url):
    if not url:
        return '#'
    url = str(url).strip()
    if any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in url):
        return '#'
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return '#'
    if parsed.scheme.lower() not in ('http', 'https') or not parsed.netloc:
        return '#'
    return url


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
    data = load_json_list(json_path)
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

    jp_list = tag_list(candidates['JP'][:45], 'JP')
    global_list = tag_list(candidates['GLOBAL'][:30], 'GL')
    sns_list = tag_list(candidates.get('EXTRA', []), 'SNS')
    return jp_list, global_list, sns_list, index


def build_prompt(config, candidates, target_date_str, yesterday_str):
    jp_sample, global_sample, sns_candidates, candidate_index = build_candidate_index(candidates)
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
            'id': source.get('id', ''),
            'platform': sns_platform_meta(it.get('platform'))['label'],
            'title': it.get('title', ''),
            'text': it.get('raw_text') or it.get('description', ''),
            'likes': it.get('likes', 0),
            'retweets': it.get('retweets', 0),
            'views': it.get('views', 0),
            'comments': it.get('comments', 0),
        } for source, it in zip(sns_candidates, extra_items)]
        sns_platform_labels = []
        for it in extra_items:
            label = sns_platform_meta(it.get('platform'))['label']
            if label not in sns_platform_labels:
                sns_platform_labels.append(label)
        sns_platform_names = " / ".join(sns_platform_labels)
        sns_section = f"""
【SNS生活者バズ投稿一覧（{sns_platform_names}／本日の「SNSリアル反響」セクション用）】:
以下は生活者が実際に投稿し話題になっている生の声です。重要な投稿は記事として選定して構いません。
その場合は一覧の "id"（SNS-xx）を記事の "source_id" に必ずそのまま設定してください。また、一覧全体を俯瞰して
共通する傾向・トレンドを分析し、後述の "sns_summary" / "sns_why_it_matters" を作成してください。
各投稿の "platform" は投稿先（{sns_platform_names}）を示します。X は likes / retweets、
動画系（TikTok・Instagram）は views（再生数）が反響の主指標です。媒体ごとの反応の質の違い
（例: 短尺動画では実際の使用シーンや組み立て過程が伸びる等）にも触れてください。
{json.dumps(sns_sample, ensure_ascii=False, indent=2)}
"""
        sns_output_fields = """,
  "sns_summary": "上記のSNS投稿一覧全体の傾向を媒体横断で要約した客観的な説明文（120〜200文字）",
  "sns_why_it_matters": "上記のSNS投稿一覧全体を踏まえた、プロの視点による生活者UX・ビジネスへの示唆（120〜200文字）\""""

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
        m = re.search(r'(JP|GL|SNS)-?(\d+)', raw_sid)
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
            # 候補を特定できなくても、source_id が "JP-xx"/"GL-xx"/"SNS-xx" 形式であれば
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
        platform = it.get('platform', 'x')
        source = it.get('source', '')
        author = it.get('author', '')
        if not author:
            author = re.sub(r'^\w+ \(@', '@', source).replace(')', '') if '(@' in source else source

        snippet = it.get('raw_text')
        if not snippet:
            desc = it.get('description', '')
            if '：\n「' in desc:
                snippet = desc.split('：\n「', 1)[1].rstrip('」')
            else:
                snippet = desc
        snippet = snippet.strip()

        t = it.get('title', '')
        t_clean = re.sub(r'^【(?:Xで[\d,]+いいね|TikTokで[^】]+|Instagramで[^】]+)】', '', t).strip()
        if not t_clean or len(t_clean) < 10:
            t_clean = snippet[:70] + "..." if len(snippet) > 75 else snippet

        buzz_list.append({
            'source_id': it.get('_cand_id', ''),
            'title': t_clean,
            'platform': platform,
            'author': author,
            'url': it.get('link', ''),
            'likes': likes,
            'retweets': rt,
            'views': it.get('views', 0),
            'comments': it.get('comments', 0),
            'posted_on': it.get('pub_date', ''),
            'captured_at': it.get('captured_at', ''),
            'text': snippet,
            'tags': SNS_PLATFORM_META.get(platform, SNS_PLATFORM_META['x'])['tags']
        })
    return buzz_list


def normalize_match_text(value):
    """SNS投稿とAI見出しの照合に使う、記号を除いた緩い比較キー。"""
    return re.sub(r'[^0-9a-zA-Zぁ-んァ-ヶ一-龠]+', '', str(value or '').lower())


def parse_source_timestamp(value):
    if not value:
        return 0
    text = str(value).strip()
    for fmt in ('%Y-%m-%d %H:%M', '%Y-%m-%d', '%Y/%m/%d %H:%M', '%Y/%m/%d'):
        try:
            return int(datetime.strptime(text, fmt).replace(tzinfo=JST).timestamp())
        except ValueError:
            continue
    return 0


def repair_issue_source_links(issue):
    """旧号を含め、SNS由来の厳選記事を保持済みの生投稿URLへ再接続する。"""
    buzz = issue.get('sns_buzz', []) or []
    if not buzz:
        return False

    changed = False
    for idx, item in enumerate(buzz, 1):
        if not item.get('source_id'):
            item['source_id'] = f'SNS-{idx:02d}'
            changed = True
    for art in issue.get('articles', []) or []:
        if art.get('url'):
            continue

        matched = None
        sid = str(art.get('source_id') or '').strip().upper()
        m = re.fullmatch(r'SNS-?(\d+)', sid)
        if m:
            idx = int(m.group(1)) - 1
            if 0 <= idx < len(buzz):
                matched = buzz[idx]

        if matched is None:
            art_key = normalize_match_text(art.get('title'))
            best_score = 0
            for item in buzz:
                item_key = normalize_match_text(item.get('text') or item.get('title'))
                if not item_key:
                    continue
                prefix = min(len(art_key), len(item_key), 28)
                score = prefix if prefix >= 10 and (art_key[:prefix] in item_key or item_key[:prefix] in art_key) else 0
                if score > best_score:
                    best_score = score
                    matched = item

        if matched and matched.get('url'):
            art['url'] = matched['url']
            art['source_pub_ts'] = art.get('source_pub_ts') or parse_source_timestamp(matched.get('posted_on'))
            changed = True
    return changed


def source_kind(art):
    source = str(art.get('source') or '').lower()
    url = str(art.get('url') or '').lower()
    category = str(art.get('category') or '')
    if category.startswith('SNS') or source in ('x', 'tiktok', 'instagram') or 'x.com/' in url or 'tiktok.com/' in url:
        return 'SNS投稿'
    if any(word in source or word in url for word in ('pr times', 'prtimes.', 'atpress', 'アットプレス')):
        return 'プレスリリース'
    if any(word in source or word in url for word in ('公式', 'blog.google', 'nitori-net.jp')):
        return '一次情報'
    return '報道・解説'


def source_time_html(art):
    raw_ts = art.get('source_pub_ts') or 0
    try:
        ts = int(raw_ts)
    except (TypeError, ValueError):
        ts = 0
    if not ts:
        return ''
    dt = datetime.fromtimestamp(ts, JST)
    return f'<time datetime="{dt.isoformat()}" title="出典の公開日時">公開 {dt:%Y.%m.%d %H:%M} JST</time>'


def social_platform_totals(issue):
    totals = defaultdict(lambda: {'count': 0, 'likes': 0, 'views': 0, 'comments': 0})
    for item in issue.get('sns_buzz', []) or []:
        platform = item.get('platform') or 'x'
        totals[platform]['count'] += 1
        for key in ('likes', 'views', 'comments'):
            try:
                totals[platform][key] += int(item.get(key) or 0)
            except (TypeError, ValueError):
                pass
    return totals


def render_social_metrics(issue, previous_issue=None):
    totals = social_platform_totals(issue)
    if not totals:
        return ''
    previous = social_platform_totals(previous_issue or {})
    cards = []
    for platform in sorted(totals, key=lambda p: sns_platform_meta(p)['order']):
        values = totals[platform]
        primary_key = 'views' if values['views'] else 'likes'
        primary_label = '再生' if primary_key == 'views' else 'いいね'
        current_value = values[primary_key]
        previous_value = previous.get(platform, {}).get(primary_key, 0)
        delta = ''
        if previous_value:
            pct = round((current_value - previous_value) / previous_value * 100)
            sign = '+' if pct > 0 else ''
            delta = f'<span class="buzz-delta">前号掲載分比 {sign}{pct}%</span>'
        cards.append(f'''<div class="buzz-metric">
          <span class="buzz-metric-label">{sns_platform_meta(platform)['label']}・掲載 {values['count']}件</span>
          <strong>{current_value:,}</strong><span>{primary_label}合計</span>{delta}
        </div>''')
    captured = next((item.get('captured_at') for item in issue.get('sns_buzz', []) if item.get('captured_at')), '')
    captured_html = f'<p class="buzz-captured">取得時点: {esc(captured)}</p>' if captured else '<p class="buzz-captured">各号発行時点のスナップショット。反応数は取得後に変動します。</p>'
    return f'''<section class="buzz-metrics" aria-labelledby="buzzMetricsTitle">
      <div class="section-head"><h2 class="section-title" id="buzzMetricsTitle">SNSバズ推移</h2><span class="section-rule" aria-hidden="true"></span></div>
      <div class="buzz-metrics-grid">{"".join(cards)}</div>{captured_html}
    </section>'''


def build_search_index(config, articles_history):
    records = []
    for issue in articles_history:
        date_key = issue.get('date', '')
        for idx, art in enumerate(issue.get('articles', []) or [], 1):
            records.append({
                'date': date_key,
                'issue_title': issue.get('title', ''),
                'title': art.get('title', ''),
                'summary': art.get('summary', ''),
                'takeaway': split_takeaway(art.get('why_it_matters', ''))[0],
                'source': art.get('source', ''),
                'source_kind': source_kind(art),
                'category': art.get('category', ''),
                'region': normalize_region(art.get('region')),
                'tags': art.get('tags', []) or [],
                'url': f"{date_key}/#art-{idx}",
            })
    return {'media': config['media_id'], 'generated_at': datetime.now(JST).isoformat(), 'records': records}


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
        source_url = sanitize_url(art.get('url'))
        if source_url != '#':
            based_on = {"@type": "NewsArticle", "url": source_url}
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


def render_sns_buzz_section(sns_buzz, config, issue_data=None, featured_urls=None):
    if not sns_buzz:
        return ""

    featured_urls = {u for u in (featured_urls or set()) if u}
    remaining_buzz = [item for item in sns_buzz if item.get('url') not in featured_urls]
    if not remaining_buzz:
        return ""

    cards_html = []
    kw_regex = config.get('keyword_regex')
    ordered_buzz = sorted(remaining_buzz, key=lambda b: sns_platform_meta(b.get('platform'))['order'])

    for idx, item in enumerate(ordered_buzz, 1):
        platform = item.get('platform', 'x')
        meta = sns_platform_meta(platform)
        likes_str = f"{item.get('likes', 0):,}"
        author = esc(item.get('author') or meta['author_fallback'])
        raw_url = esc(sanitize_url(item.get('url', '')))
        raw_text = item.get('text', '')
        clean_text = re.sub(r'https?://\S+', '', raw_text).strip()
        bold_text = bold_scan_text(esc(clean_text), kw_regex)

        # X は「いいね＋リポスト」、動画系は「再生数＋いいね＋コメント」が読者の見たい指標
        if platform == 'x':
            rt_str = f"{item.get('retweets', 0):,}"
            stat_spans = [
                f'<span class="sns-stat-likes" title="{likes_str} いいね">❤️ {likes_str}</span>',
                f'<span class="sns-stat-rt" title="{rt_str} リポスト">🔁 {rt_str}</span>',
            ]
        else:
            views_str = f"{item.get('views', 0):,}"
            comments_str = f"{item.get('comments', 0):,}"
            stat_spans = [
                f'<span class="sns-stat-views" title="{views_str} 回再生">▶️ {views_str}</span>',
                f'<span class="sns-stat-likes" title="{likes_str} いいね">❤️ {likes_str}</span>',
                f'<span class="sns-stat-comments" title="{comments_str} コメント">💬 {comments_str}</span>',
            ]
        stats_html = "".join(stat_spans)

        # 動画系は「直近1週間」から選ぶので、いつの投稿かをカード単位で示す。
        # X は昨日の投稿だけなので従来どおり日付を出さない。
        posted_html = ''
        if platform != 'x' and item.get('posted_on'):
            posted_html = f'<span class="sns-card-date">{esc(item["posted_on"])}</span>'

        cards_html.append(f"""
        <article class="sns-card" id="sns-buzz-{idx}" data-platform="{esc(platform)}">
          <div class="sns-card-head">
            <a href="{raw_url}" target="_blank" rel="noopener noreferrer" class="sns-card-author">{meta['icon']}<span>{author}</span>{posted_html}</a>
            <div class="sns-card-stats">{stats_html}</div>
          </div>
          <blockquote class="sns-card-body">{bold_text}</blockquote>
          <a href="{raw_url}" target="_blank" rel="noopener noreferrer" class="sns-card-link"><span>{meta['link_text']}</span>{ICON_EXTERNAL_SVG}</a>
        </article>""")

    # セクション全体の要約・示唆まとめブロック（AIが生成した場合のみ表示）。
    # AIが sns_summary/sns_why_it_matters を返さなかった場合（項目省略やルールベース
    # フォールバック時）、その日の実際の投稿内容と無関係な固定文言をでっち上げて
    # 「AIの分析」であるかのように出すのは不誠実なため、ボックス自体を省略する。
    issue = issue_data or {}
    raw_summary = issue.get('sns_summary', '')
    raw_wim = issue.get('sns_why_it_matters', '')

    summary_box_html = ""
    if (raw_summary or raw_wim) and not featured_urls:
        bold_summary = bold_scan_text(esc(raw_summary), kw_regex)
        takeaway, detail_wim = split_takeaway(raw_wim)
        bold_takeaway = bold_scan_text(esc(takeaway), kw_regex)
        bold_detail = bold_scan_text(esc(detail_wim), kw_regex)

        summary_box_html = f"""
      <div class="panel panel-sns">
        <div class="card-summary"><p>{bold_summary}</p></div>
        <div class="why-it-matters">
          <div class="wim-header">{ICON_WIM_SVG}<strong>Why it matters（生活者UX・生活空間への示唆）</strong></div>
          <div class="wim-takeaway">
            <span class="takeaway-badge">KEY TAKEAWAY</span>
            <p class="takeaway-text">{bold_takeaway}</p>
          </div>
          {f'<p class="wim-detail">{bold_detail}</p>' if bold_detail else ''}
        </div>
      </div>"""

    # 収録されたプラットフォームだけをバッジ・見出しに出す（X のみの過去号は従来表示のまま）
    platform_counts = {}
    for item in ordered_buzz:
        p = item.get('platform', 'x')
        platform_counts[p] = platform_counts.get(p, 0) + 1
    present = sorted(platform_counts.items(), key=lambda kv: sns_platform_meta(kv[0])['order'])

    badges = []
    for p, count in present:
        meta = sns_platform_meta(p)
        # 単一プラットフォームなら従来どおり「Xリアル反響」の形。複数なら媒体名＋件数。
        if len(present) == 1:
            inner = f'{meta["label"]}リアル反響'
        else:
            inner = f'{meta["label"]} <span class="sns-badge-count">{count}</span>'
        badges.append(f'<span class="{meta["badge_class"]}">{meta["icon"]} {inner}</span>')
    badges_html = "".join(badges)

    labels = [sns_platform_meta(p)['label'] for p, _ in present]
    if labels == ['X']:
        heading = "その他のX（Twitter）生活者バズ" if featured_urls else "昨日のX（Twitter）生活者バズ・リアル反響まとめ"
    else:
        prefix = 'その他のSNS生活者バズ' if featured_urls else 'SNS生活者バズ・リアル反響まとめ'
        heading = f'{prefix}（{" / ".join(labels)}）'

    # 収集条件が媒体ごとに違う（X は昨日の投稿、動画系は直近1週間で伸びている投稿）。
    # 「昨日の投稿」と誤読されないよう、対象期間を必ず明示する。
    subs = []
    if 'x' in platform_counts:
        subs.append('X は昨日の投稿')
    video_labels = [sns_platform_meta(p)['label'] for p, _ in present if p != 'x']
    if video_labels:
        subs.append(f'{" / ".join(video_labels)} は直近1週間で再生数を伸ばした投稿')
    sub_text = esc('、'.join(subs) + '。生活者が注目した神アイテム・使い勝手や比較の生の声')

    return f"""
    <section class="sns-section" id="snsBuzzSection">
      <div class="section-head">
        <h2 class="section-title">{heading}</h2>
        <span class="section-rule" aria-hidden="true"></span>
        <span class="section-count">{len(ordered_buzz)} posts</span>
      </div>
      <div class="sns-intro">
        <div class="sns-badges">{badges_html}</div>
        <p class="sns-sub">{sub_text}</p>
      </div>
      {summary_box_html}
      <div class="sns-grid">
{"".join(cards_html)}
      </div>
    </section>
    """


def render_article_html(config, issue_data, date_key, formatted_date, prev_issue=None, next_issue=None):
    articles = issue_data.get('articles', [])
    sns_buzz = issue_data.get('sns_buzz', [])
    total_count = len(articles)
    is_low_volume = total_count <= 3
    lane_fn = config.get('content_lane_fn')
    lane_meta = config.get('content_lanes', ())
    product_link_fn = config.get('product_link_fn')
    featured_urls = ({
        art.get('url') for art in articles
        if art.get('category') == 'SNS話題・リアル反響' and art.get('url')
    } if config.get('dedupe_featured_sns') else set())
    remaining_sns = [item for item in sns_buzz if item.get('url') not in featured_urls]
    sns_buzz_html = render_sns_buzz_section(
        sns_buzz, config, issue_data=issue_data,
        featured_urls=featured_urls or None
    )
    social_metrics_html = render_social_metrics(issue_data, prev_issue) if config.get('show_social_metrics') else ''

    # 目次からSNSセクションへ飛ぶリンク。収録プラットフォームに応じてラベルとアイコンを変える
    sns_quick_link = ''
    if remaining_sns and not is_low_volume:
        sns_platforms = sorted(
            {b.get('platform', 'x') for b in remaining_sns},
            key=lambda p: sns_platform_meta(p)['order']
        )
        sns_quick_icons = "".join(sns_platform_meta(p)['icon'] for p in sns_platforms)
        sns_quick_label = 'Xリアル反響' if sns_platforms == ['x'] else 'SNSリアル反響'
        sns_quick_link = (
            f'<a href="#snsBuzzSection" class="qi-sns-link">{sns_quick_icons}'
            f' <span>{sns_quick_label} ({len(remaining_sns)}件) ↓</span></a>'
        )
    engine_label = esc(issue_data.get('generated_by', 'DeepSeek AI'))
    engine_type = esc(issue_data.get('engine_type', 'deepseek'))
    engine_class = f"engine-{engine_type}"

    jsonld_obj = build_dynamic_jsonld(config, issue_data, date_key, formatted_date)
    dynamic_jsonld_str = escape_jsonld_for_script(json.dumps(jsonld_obj, ensure_ascii=False, indent=2))
    dynamic_page_desc = esc(jsonld_obj['@graph'][0]['description'])
    site_header_html = render_site_header(config, '../', '../#archiveSearch', (
        ('../', 'メディアトップ', False),
        ('../#archiveTitle', 'バックナンバー', False),
        ('../#faq', 'FAQ', False),
        ('../rss.xml', 'RSSを購読', True),
    ), '../../')
    site_footer_html = render_page_footer(config, '../', '../#faq', '../rss.xml')

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
            <span class="qi-body">
              <span class="qi-tags"><span class="qi-badge {b_class}">{b_txt}</span><span class="qi-cat">{esc(cat_name)}</span></span>
              <span class="qi-title">{esc(art.get('title', ''))}</span>
            </span>
            <svg class="qi-icon" viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>
          </a>
        </li>""")
    quick_index_html = "\n".join(quick_index_items)

    kw_regex = config['keyword_regex']
    article_entries = []
    for idx, art in enumerate(articles, 1):
        is_global = art.get('region') == 'GLOBAL'
        region_code = 'GLOBAL' if is_global else 'JP'
        badge_class = 'badge-global' if is_global else 'badge-jp'
        badge_text = '海外 GLOBAL' if is_global else '国内 JAPAN'
        category_name = art.get('category', config['sample_category'])
        orig_title = art.get('original_title', '')
        orig_html = f'<p class="original-title">{esc(orig_title)}</p>' if orig_title else ''
        safe_url = sanitize_url(art.get('url', ''))
        has_source = safe_url != '#'
        safe_href = esc(safe_url)
        raw_title = art.get('title', '')
        lane = lane_fn(art) if lane_fn else 'all'

        bold_summary = bold_scan_text(esc(art.get('summary', '')), kw_regex)
        takeaway, detail_wim = split_takeaway(art.get('why_it_matters', ''))
        bold_takeaway = bold_scan_text(esc(takeaway), kw_regex)
        bold_detail = bold_scan_text(esc(detail_wim), kw_regex)

        if has_source:
            title_inner = f'<a href="{safe_href}" target="_blank" rel="noopener noreferrer">{esc(raw_title)}{ICON_EXTERNAL_SVG}</a>'
            source_link_html = f'<a class="source-link" href="{safe_href}" target="_blank" rel="noopener noreferrer">元記事を読む &rarr;</a>'
        else:
            title_inner = esc(raw_title)
            source_link_html = '<span class="source-link is-missing" title="出典URLを特定できませんでした">出典リンクなし</span>'

        share_url = f"https://tk.st/job/{config['media_id']}/{date_key}/#art-{idx}"
        source_time = source_time_html(art)
        source_meta_html = f'<div class="source-details"><span class="source-kind">{source_kind(art)}</span>{source_time}</div>'
        correction_subject = urllib.parse.quote(f"{config['brand_title']} {formatted_date}号 記事{idx}の訂正・出典について")
        correction_link = f'<a class="correction-link" href="https://tk.st/contact/?subject={correction_subject}">訂正・出典を報告</a>'

        tags_html = ''.join(
            f'<span class="topic-tag-wrap"><a class="topic-tag" href="../?q={urllib.parse.quote(str(tag))}#archiveSearch">#{esc(tag)}</a>'
            f'<button type="button" class="topic-watch-btn" data-watch-topic="{esc(tag)}" aria-pressed="false" title="このテーマをウォッチ">☆</button></span>'
            for tag in (art.get('tags', []) or []) if str(tag).strip()
        )
        tags_block = f'<div class="card-tags" aria-label="記事タグ">{tags_html}</div>' if tags_html else ''

        product_link = ''
        product_link_data = product_link_fn(art) if product_link_fn else None
        if product_link_data:
            product_label, product_url = product_link_data
            product_href = esc(sanitize_url(product_url))
            product_link = f'<a class="product-search-link" href="{product_href}" target="_blank" rel="noopener noreferrer">{esc(product_label)} {ICON_EXTERNAL_SVG}</a>'

        if is_low_volume:
            region_control = f'<span class="region-badge {badge_class}">{badge_text}</span>'
            category_control = f'<span class="category-badge">{esc(category_name)}</span>'
        else:
            region_control = f'<button type="button" class="region-badge {badge_class}" data-filter-trigger="region" data-filter-val="{region_code}" title="この地域のニュースで絞り込み">{badge_text}</button>'
            category_control = f'<button type="button" class="category-badge" data-filter-trigger="category" data-filter-val="{esc(category_name)}" title="このカテゴリで絞り込み">{esc(category_name)}</button>'

        card_html = f"""
        <article class="news-card" id="art-{idx}" data-region="{region_code}" data-category="{esc(category_name)}" data-lane="{lane}" data-share-title="{esc(raw_title)}" data-share-takeaway="{esc(takeaway)}" data-share-url="{share_url}">
          <div class="card-index" aria-hidden="true">{idx:02d}</div>
          <div class="card-main">
            <div class="card-meta">
              {region_control}
              {category_control}
              <span class="source-tag">{esc(art.get('source', '業界速報'))}</span>
            </div>
            {source_meta_html}
            <h3 class="card-title">{title_inner}</h3>
            {orig_html}
            <div class="card-summary"><p>{bold_summary}</p></div>
            <div class="why-it-matters">
              <div class="wim-header">{ICON_WIM_SVG}<strong>Why it matters（ビジネス・テック的示唆）</strong></div>
              <div class="wim-takeaway">
                <span class="takeaway-badge">KEY TAKEAWAY</span>
                <p class="takeaway-text">{bold_takeaway}</p>
              </div>
              {f'<p class="wim-detail">{bold_detail}</p>' if bold_detail else ''}
            </div>
            {tags_block}
            {product_link}
            <div class="card-footer">
              <div class="card-actions">
                <label class="share-select-label"><input type="checkbox" class="share-select" aria-label="この記事をまとめて共有に追加"><span>選択</span></label>
                <button type="button" class="share-copy-btn" data-share-title="{esc(raw_title)}" data-share-takeaway="{esc(takeaway)}" data-share-url="https://tk.st/job/{config['media_id']}/{date_key}/#art-{idx}" data-share-prefix="{esc(config['share_prefix'])}" title="SlackやTeamsの社内共有用にコピー">{ICON_COPY_SVG}<span>社内共有コピー</span></button>
                <button type="button" class="native-share-btn" data-share-title="{esc(raw_title)}" data-share-takeaway="{esc(takeaway)}" data-share-url="{share_url}" title="共有先を選ぶ">{ICON_SHARE_SVG}<span>共有</span></button>
                {source_link_html}
                {correction_link}
              </div>
            </div>
          </div>
        </article>"""
        article_entries.append((lane, card_html))

    lane_nav_html = ''
    if lane_fn and lane_meta:
        lane_counts = Counter(lane for lane, _ in article_entries)
        lane_nav_html = '<nav class="content-lane-nav" aria-label="情報種別">' + ''.join(
            f'<a href="#lane-{key}"><span>{label}</span><strong>{lane_counts[key]}</strong></a>'
            for key, label in lane_meta if lane_counts[key]
        ) + '</nav>'
        grouped = []
        for key, label in lane_meta:
            lane_cards = ''.join(card for lane, card in article_entries if lane == key)
            if lane_cards:
                grouped.append(f'<section class="content-lane" id="lane-{key}" data-lane-group="{key}"><h3 class="content-lane-title">{label}</h3>{lane_cards}</section>')
        articles_html = ''.join(grouped)
    else:
        articles_html = ''.join(card for _, card in article_entries)

    exec_summary_list = issue_data.get('executive_summary', [])
    exec_summary_html = "".join([f"<li>{esc(item)}</li>" for item in exec_summary_list])
    # AIは通常ちょうど3点で生成するが、後日の手動修正等で件数が変わることもあるため、
    # 3点ちょうどの時だけ「3大」と謳い、それ以外は件数を偽らない汎用見出しにする。
    exec_title_text = "昨日の3大重要トピック（Executive Summary）" if len(exec_summary_list) == 3 else "昨日の重要トピック（Executive Summary）"

    if is_low_volume:
        status_text = exec_summary_list[0] if exec_summary_list else f'{formatted_date}号は全{total_count}件です。'
        only_consumer = lane_fn and articles and all(lane_fn(a) == 'consumer' for a in articles)
        status_label = config.get('consumer_only_status_label', '本日の概況') if only_consumer else '本日の概況'
        summary_panel_html = f'''<section class="daily-status" aria-labelledby="dailyStatusTitle">
          <span class="daily-status-label">LOW VOLUME BRIEF</span>
          <h2 id="dailyStatusTitle">{status_label}</h2>
          <p>{esc(status_text)}</p>
        </section>'''
        index_panel_html = ''
        filter_wrapper_html = ''
        reading_progress_html = ''
    else:
        summary_panel_html = f'''<section class="panel panel-exec" aria-labelledby="execTitle">
          <h2 class="panel-title" id="execTitle">
            <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
            <span>{exec_title_text}</span>
          </h2>
          <ol class="exec-list">{exec_summary_html}</ol>
        </section>'''
        index_panel_html = f'''<section class="panel panel-index" aria-labelledby="indexTitle">
          <div class="panel-head">
            <h2 class="panel-title" id="indexTitle">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
              <span>本日のヘッドライン目次（30秒スキャン）</span>
            </h2>
            <div class="panel-head-aside">{sns_quick_link}<span class="panel-note">タップで各記事へジャンプ</span></div>
          </div>
          <ol class="qi-list">{quick_index_html}</ol>
        </section>'''

        jp_count = sum(1 for a in articles if a.get('region') != 'GLOBAL')
        global_count = sum(1 for a in articles if a.get('region') == 'GLOBAL')
        region_chips = ''
        if jp_count:
            region_chips += f'<button type="button" class="filter-chip" data-filter-type="region" data-filter-val="JP" aria-pressed="false">国内 <span class="chip-count">{jp_count}</span></button>'
        if global_count:
            region_chips += f'<button type="button" class="filter-chip" data-filter-type="region" data-filter-val="GLOBAL" aria-pressed="false">海外 <span class="chip-count">{global_count}</span></button>'
        filter_wrapper_html = f'''<div class="filter-wrapper">
          <div class="filter-bar-header">
            <div class="filter-label"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg><span>Filter</span></div>
            <div class="filter-actions">
              <span class="filter-status">表示中 <strong id="visibleArticlesCount">{total_count}</strong> / {total_count}</span>
              <button type="button" class="filter-reset-btn" id="filterResetBtn" style="display:none;">条件リセット &times;</button>
              <button type="button" class="view-mode-toggle" id="viewModeToggle" aria-label="3行コンパクト表示切替" aria-pressed="false" data-current-mode="detail" title="3行コンパクト表示に切り替え"><span class="toggle-track"><span class="toggle-thumb"></span></span><span class="toggle-text">3行コンパクト</span></button>
            </div>
          </div>
          <div class="filter-chips-scroll" role="toolbar" aria-label="ニュース絞り込み">
            <button type="button" class="filter-chip active" data-filter-type="all" data-filter-val="all" aria-pressed="true">すべて <span class="chip-count">{total_count}</span></button>
            <span class="chip-divider" aria-hidden="true"></span>{region_chips}<span class="chip-divider" aria-hidden="true"></span>{cat_chips_html}
          </div>
        </div>'''
        reading_progress_html = '<div class="reading-progress" id="readingProgress" aria-hidden="true"></div>'

    share_selected_html = f'''<div class="bulk-share-bar" id="bulkShareBar">
      <span><strong id="selectedArticlesCount">0</strong>件選択</span>
      <button type="button" id="shareSelectedBtn" data-share-prefix="{esc(config['share_prefix'])}" disabled>{ICON_SHARE_SVG}<span>選択記事をまとめて共有</span></button>
    </div>'''
    p_link = f'<a href="../{prev_issue["date"]}/" class="nav-prev">&larr; {prev_issue["date"][:4]}.{prev_issue["date"][4:6]}.{prev_issue["date"][6:8]} 号</a>' if prev_issue else '<span class="nav-disabled">&larr; 前号なし</span>'
    n_link = f'<a href="../{next_issue["date"]}/" class="nav-next">{next_issue["date"][:4]}.{next_issue["date"][4:6]}.{next_issue["date"][6:8]} 号 &rarr;</a>' if next_issue else '<span class="nav-disabled nav-next">最新号</span>'

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
  <script type="application/ld+json">
{dynamic_jsonld_str}
  </script>
  <link rel="stylesheet" href="../../../data/{config['css_file']}">
</head>
<body id="top" data-daily-media="{config['media_id']}">
  {reading_progress_html}
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-59NWV9XK" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>

  {site_header_html}

  <main class="container">
    <nav class="breadcrumbs" aria-label="パンくずリスト">
      <a href="https://tk.st/">Shinya Takeda</a><span class="sep" aria-hidden="true">/</span>
      <a href="../../">Job</a><span class="sep" aria-hidden="true">/</span>
      <a href="../">{config['brand_title']}</a><span class="sep" aria-hidden="true">/</span>
      <strong>{formatted_date}号</strong>
    </nav>

    <article class="issue">
      <header class="issue-masthead">
        <div class="issue-kicker">
          <span class="kicker-tag">Daily Brief</span>
          <span class="kicker-date">{formatted_date} 08:00 JST 配信</span>
        </div>
        <h1 class="issue-title">{formatted_date}号：昨日の{config['brand_title_short']}まとめ</h1>
        <p class="issue-lede">{config['hero_desc']}</p>
        <div class="issue-stats">
          <span class="stat">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            読了目安 約{reading_minutes}分 / {total_chars:,}字
          </span>
          <span class="stat">全 {total_count} 本</span>
          <span class="engine-badge {engine_class}"><span class="engine-dot"></span>{engine_label}</span>
        </div>
      </header>

      {summary_panel_html}
      {index_panel_html}

      <section class="articles-section" id="articlesSection">
        <div class="section-head">
          <h2 class="section-title">厳選トピックス</h2>
          <span class="section-rule" aria-hidden="true"></span>
          <span class="section-count">{total_count} stories</span>
        </div>

        {lane_nav_html}
        {filter_wrapper_html}
        {share_selected_html}

        <div class="articles-list detail-view" id="articlesList">
{articles_html}
        </div>

        <div class="no-results-msg" id="noResultsMsg" style="display:none;">
          <p>該当する条件のニュースは見つかりませんでした。</p>
        </div>
      </section>

      {social_metrics_html}
      {sns_buzz_html}

      <nav class="issue-nav" aria-label="前後の号への移動">
        {p_link}
        <a href="../" class="nav-archive">一覧へ戻る</a>
        {n_link}
      </nav>
    </article>
  </main>

  {site_footer_html}

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
    base_url = f"https://tk.st/job/{config['media_id']}/"
    latest = articles_history[0] if articles_history else None
    latest_date_formatted = f"{latest['date'][:4]}年{int(latest['date'][4:6])}月{int(latest['date'][6:8])}日" if latest else ""
    highlight_limit = 1 if latest and int(latest.get('count', len(latest.get('articles', [])))) <= 3 else 3
    latest_highlights = "".join([f"<li>{esc(h)}</li>" for h in latest.get('executive_summary', [])[:highlight_limit]]) if latest else ""
    latest_engine = esc(latest.get('generated_by', 'DeepSeek AI')) if latest else ""
    latest_engine_type = esc(latest.get('engine_type', 'deepseek')) if latest else ""
    meta_pills_html = build_meta_pills_html(config, latest)
    menu_links = []
    if latest:
        menu_links.append((f'{latest["date"]}/', '最新号を読む', False))
    menu_links.extend((
        ('#archiveTitle', 'バックナンバー', False),
        ('#faq', 'FAQ', False),
        ('rss.xml', 'RSSを購読', True),
    ))
    site_header_html = render_site_header(config, './', './#archiveSearch', menu_links, '../')
    site_footer_html = render_page_footer(config, './', '#faq', 'rss.xml')

    # 当日号はすぐ上の「Latest Issue」に出るため、アーカイブには含めない
    archive_source = articles_history[1:] if latest else articles_history

    history_rows = []
    for issue in archive_source:
        d = esc(issue['date'])
        d_fmt = f"{d[:4]}年{int(d[4:6])}月{int(d[6:8])}日"
        summary_preview = esc(issue.get('summary', '') or f"昨日の{config['brand_title_short']}まとめ。")
        count = int(issue.get('count', len(issue.get('articles', []))))
        title = esc(issue.get('title', f'{d_fmt}号まとめ'))

        history_rows.append(f"""        <li class="archive-item" data-archive-month="{d[:6]}">
          <a href="{d}/" class="archive-row">
            <span class="archive-date">
              <span class="archive-day">{d[6:8]}</span>
              <span class="archive-ym">{d[:4]}.{d[4:6]}</span>
            </span>
            <span class="archive-body">
              <span class="archive-title">{title}</span>
              <span class="archive-desc">{summary_preview}</span>
            </span>
            <span class="archive-meta">
              <span class="archive-count">{count} 本</span>
            </span>
          </a>
        </li>""")

    all_categories = sorted({
        str(art.get('category')) for issue in articles_history for art in issue.get('articles', [])
        if art.get('category')
    })
    all_months = sorted({str(issue.get('date', ''))[:6] for issue in articles_history if issue.get('date')}, reverse=True)
    category_options = ''.join(f'<option value="{esc(cat)}">{esc(cat)}</option>' for cat in all_categories)
    month_options = ''.join(
        f'<option value="{month}">{month[:4]}年{int(month[4:6])}月</option>' for month in all_months
    )

    recent_issues = articles_history[:7]
    trend_counts = Counter()
    generic_tags = {'ニトリ', '流通DX', 'リテールテック', '国内', '海外', 'グローバル'}
    for issue in recent_issues:
        for art in issue.get('articles', []) or []:
            tags = [str(tag).strip() for tag in art.get('tags', []) or [] if str(tag).strip()]
            for tag in tags:
                if tag not in generic_tags:
                    trend_counts[tag] += 1
    trend_items = ''.join(
        f'<li><a href="?q={urllib.parse.quote(tag)}#archiveSearch"><span>#{esc(tag)}</span><strong>{count}件</strong></a></li>'
        for tag, count in trend_counts.most_common(8)
    )
    trend_section_html = f'''<section class="trend-section" aria-labelledby="trendTitle">
      <div class="section-head"><h2 class="section-title" id="trendTitle">直近{len(recent_issues)}号の注目テーマ</h2><span class="section-rule" aria-hidden="true"></span></div>
      <ul class="trend-list">{trend_items}</ul>
      <div class="watch-panel"><h3>ウォッチ中のテーマ</h3><div id="watchTopics" class="watch-topics"><span class="watch-empty">記事タグの ☆ からテーマを登録できます。</span></div></div>
    </section>''' if trend_items else ''

    archive_tools_html = f'''<section class="archive-search" id="archiveSearch" aria-labelledby="archiveSearchTitle">
      <div class="section-head"><h2 class="section-title" id="archiveSearchTitle">記事を横断検索</h2><span class="section-rule" aria-hidden="true"></span></div>
      <form class="archive-search-form" id="archiveSearchForm" role="search">
        <label class="search-query"><span>キーワード・企業・商品名</span><input type="search" id="archiveSearchInput" autocomplete="off" placeholder="例：セルフレジ、イオン、収納"></label>
        <label><span>カテゴリ</span><select id="archiveCategoryFilter"><option value="">すべて</option>{category_options}</select></label>
        <label><span>地域</span><select id="archiveRegionFilter"><option value="">すべて</option><option value="JP">国内</option><option value="GLOBAL">海外</option></select></label>
        <label><span>月</span><select id="archiveMonthFilter"><option value="">すべて</option>{month_options}</select></label>
        <button type="submit">検索</button>
      </form>
      <p class="archive-search-status" id="archiveSearchStatus" aria-live="polite"></p>
      <div class="archive-search-results" id="archiveSearchResults"></div>
    </section>'''

    subscribe_html = f'''<section class="subscribe-panel" aria-labelledby="subscribeTitle">
      <div><span class="subscribe-kicker">SUBSCRIBE</span><h2 id="subscribeTitle">毎朝の更新を購読</h2><p>RSSリーダーやSlack・Teams・Discordに登録できます。</p></div>
      <div class="subscribe-actions"><a href="rss.xml" target="_blank" rel="noopener noreferrer">{ICON_RSS_SVG}<span>RSSを開く</span></a><button type="button" data-rss-copy="{base_url}rss.xml">{ICON_COPY_SVG}<span>RSS URLをコピー</span></button></div>
    </section>'''

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
            <span class="faq-toggle-icon" aria-hidden="true"></span>
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
            "description": config.get('portal_seo_desc') or config['brand_desc'],
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
            "description": config.get('portal_seo_desc') or config['brand_desc'],
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

    featured_html = f"""
    <section class="featured" aria-labelledby="featuredTitle">
      <div class="featured-head">
        <span class="featured-badge">Latest Issue</span>
        <span class="featured-date">{latest_date_formatted} 08:00 号</span>
        <span class="engine-badge engine-{latest_engine_type}"><span class="engine-dot"></span>{latest_engine}</span>
      </div>
      <h2 class="featured-title" id="featuredTitle">
        <a href="{latest["date"] if latest else ""}/">{esc(latest.get("title", f"{latest_date_formatted}号 速報")) if latest else ""}</a>
      </h2>
      <ul class="featured-highlights">{latest_highlights}</ul>
      <a href="{latest["date"] if latest else ""}/" class="featured-btn">
        <span>最新号を読む</span>
        <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
      </a>
    </section>
    """ if latest else ''

    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="../../data/analytics.js" async></script>
  <title>{config.get('portal_seo_title') or f"{config['media_name']} — {config['brand_subtitle']} | tk.st"}</title>
  <meta name="description" content="{config.get('portal_seo_desc') or config['brand_desc']}">
  <meta name="author" content="Shinya Takeda">
  <meta name="robots" content="max-image-preview:large">
  <meta name="theme-color" content="{config['theme_color']}">

  <link rel="canonical" href="{base_url}">
  <link rel="author" href="https://tk.st/">
  <link rel="alternate" type="application/rss+xml" title="{config['media_name']} RSS" href="{base_url}rss.xml">

  <meta property="og:title" content="{config.get('portal_seo_title') or f"{config['media_name']} — {config['brand_subtitle']} | tk.st"}">
  <meta property="og:description" content="{config.get('portal_seo_desc') or config['brand_desc']}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="{base_url}">
  <meta property="og:site_name" content="{config['media_name']} | tk.st">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:image" content="{config['portal_ogp_image']}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{config.get('portal_seo_title') or f"{config['media_name']} — {config['brand_subtitle']} | tk.st"}">
  <meta name="twitter:description" content="{config.get('portal_seo_desc') or config['brand_desc']}">
  <meta name="twitter:image" content="{config['portal_ogp_image']}">

  <link rel="icon" href="../../images/favicons/{config['favicon_file']}" type="image/svg+xml">
  <link rel="apple-touch-icon" href="../../images/favicons/{config['favicon_file']}">
  <script type="application/ld+json">
{portal_jsonld_str}
  </script>
  <link rel="stylesheet" href="../../data/{config['css_file']}">
</head>
<body id="top" data-daily-media="{config['media_id']}">
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-59NWV9XK" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>

  {site_header_html}

  <main class="container">
    <nav class="breadcrumbs" aria-label="パンくずリスト">
      <a href="https://tk.st/">Shinya Takeda</a><span class="sep" aria-hidden="true">/</span>
      <a href="../">Job</a><span class="sep" aria-hidden="true">/</span>
      <strong>{config['brand_title']}</strong>
    </nav>

    <section class="masthead">
      <div class="masthead-inner">
        <h1 class="masthead-title">{config['media_name']}</h1>
        <div class="masthead-rule" aria-hidden="true"></div>
        <p class="masthead-desc">{config['portal_hero_desc']}</p>
        <div class="meta-pills">
{meta_pills_html}
        </div>
      </div>
    </section>
{featured_html}
    {subscribe_html}
    {trend_section_html}
    {archive_tools_html}
    <section class="archive-section" aria-labelledby="archiveTitle">
      <div class="section-head">
        <h2 class="section-title" id="archiveTitle">バックナンバー・アーカイブ</h2>
        <span class="section-rule" aria-hidden="true"></span>
        <span class="section-count">{len(archive_source)} issues</span>
      </div>
      <ol class="archive-list">
{"".join(history_rows)}
      </ol>
      <p class="archive-empty" id="archiveEmpty" hidden>選択した月のバックナンバーはありません。</p>
    </section>

    <section class="faq-section" id="faq" aria-labelledby="faqTitle">
      <div class="section-head">
        <h2 class="section-title" id="faqTitle">よくあるご質問</h2>
        <span class="section-rule" aria-hidden="true"></span>
        <span class="section-count">{len(config['faq_items'])} questions</span>
      </div>
      <div class="faq-accordion">
{faq_accordion_html}
      </div>
    </section>

    <section class="curator" aria-labelledby="curatorTitle">
      <div class="curator-avatar" aria-hidden="true">ST</div>
      <div class="curator-info">
        <h2 id="curatorTitle">Curated by Shinya Takeda</h2>
        <p>EC/流通のUI/UX改善からAI・Web3プロダクト開発まで。ビジネス課題をテクノロジーで解決するデジタルマーケター / テックリードのポートフォリオをご覧ください。<a href="../" class="text-link">Works &amp; Profileを見る &rarr;</a></p>
      </div>
    </section>
  </main>

  {site_footer_html}

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
    <title>{config.get('portal_seo_title') or f"{config['media_name']} — {config['brand_subtitle']}"}</title>
    <link>{base_url}</link>
    <description>{config.get('portal_seo_desc') or config['brand_desc']}</description>
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
        raise FileNotFoundError(f"OGP 生成スクリプトが見つかりません: {ogp_script}")
    print(f" -> 日刊 OGP 画像生成中 (Lossless WebP): {date_key}...")
    try:
        import subprocess
        res = subprocess.run(['node', ogp_script, config['ogp_target'], str(date_key)], cwd=REPO_ROOT, capture_output=True, text=True, check=True)
        print(f" -> {res.stdout.strip()}")
    except Exception as e:
        raise RuntimeError(f"OGP 画像生成に失敗しました: {e}") from e


def format_issue_date(date_key):
    return f"{date_key[:4]}年{int(date_key[4:6])}月{int(date_key[6:8])}日"


def repair_history_source_links(articles_history):
    """履歴をレンダー前に一度だけ正規化する。"""
    changed = False
    for issue in articles_history:
        changed = repair_issue_source_links(issue) or changed
    return changed


def write_issue_page(config, articles_history, index):
    issue = articles_history[index]
    prev_issue = articles_history[index + 1] if index + 1 < len(articles_history) else None
    next_issue = articles_history[index - 1] if index > 0 else None
    date_key = issue['date']
    issue_html = clean_generated_text(
        render_article_html(config, issue, date_key, format_issue_date(date_key), prev_issue, next_issue)
    )
    issue_dir = os.path.join(config['job_dir'], date_key)
    os.makedirs(issue_dir, exist_ok=True)
    with open(os.path.join(issue_dir, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(issue_html)
    return date_key


def write_collection_outputs(config, articles_history):
    """ポータル、RSS、検索インデックスをまとめて書き出す。"""
    job_dir = config['job_dir']
    outputs = (
        ('index.html', clean_generated_text(render_top_index_html(config, articles_history))),
        ('rss.xml', clean_generated_text(generate_rss_xml(config, articles_history))),
    )
    for filename, content in outputs:
        with open(os.path.join(job_dir, filename), 'w', encoding='utf-8') as f:
            f.write(content)
    write_json_atomic(
        os.path.join(job_dir, 'search-index.json'),
        build_search_index(config, articles_history),
        separators=(',', ':'),
    )


def run_daily_pipeline(config):
    parser = argparse.ArgumentParser(description=f"{config['media_name']} Pipeline")
    parser.add_argument('--date', type=str, default='', help='Target issue date in YYYYMMDD format')
    parser.add_argument('--rebuild', action='store_true', help='Rebuild HTML and RSS from existing JSON')
    parser.add_argument('--dry-run', action='store_true', help='Collect candidates and display them without AI summarization')
    args = parser.parse_args()

    data_json_path = config['data_json_path']
    job_dir = config['job_dir']
    if args.rebuild:
        print(f"=== {config['media_name']}: Rebuilding HTML and RSS from JSON ===")
        if not os.path.exists(data_json_path):
            print(f"[ERROR] {data_json_path} が存在しません。", file=sys.stderr)
            sys.exit(1)
        articles_history = load_json_list(data_json_path)
        articles_history.sort(key=lambda x: x['date'], reverse=True)
        history_changed = repair_history_source_links(articles_history)
        if history_changed:
            write_json_atomic(data_json_path, articles_history, indent=2)
            print(" -> 旧号のSNS出典URLを修復してJSONへ反映")

        for i in range(len(articles_history)):
            date_key = write_issue_page(config, articles_history, i)
            print(f" -> 再生成: {date_key}号 HTML")

        write_collection_outputs(config, articles_history)
        print(f" -> 再生成: トップポータル index.html")
        print(f" -> 再生成: rss.xml")
        print(f" -> 再生成: search-index.json")
        print("=== Rebuild 完了 ===")
        return

    print(f"=== {config['media_name']} 開始 (v3.0 Common Engine) ===")
    if args.date:
        target_dt = datetime.strptime(args.date, '%Y%m%d').replace(tzinfo=JST)
    else:
        target_dt = datetime.now(JST)

    target_date_key = target_dt.strftime('%Y%m%d')
    target_date_formatted = format_issue_date(target_date_key)
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
        articles_history = load_json_list(data_json_path)

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
    repair_history_source_links(articles_history)

    print("[3/3] ファイル出力中...")
    write_json_atomic(data_json_path, articles_history, indent=2)

    # 新規追加号と、その前後で prev/next リンクが変わる隣接号だけ再生成すれば十分
    # （それ以外の過去号の内容・リンク先は今回の追加で変化しない）
    new_index = next(i for i, iss in enumerate(articles_history) if iss['date'] == target_date_key)
    indices_to_render = {new_index}
    if new_index > 0:
        indices_to_render.add(new_index - 1)
    if new_index + 1 < len(articles_history):
        indices_to_render.add(new_index + 1)

    for i in sorted(indices_to_render):
        write_issue_page(config, articles_history, i)

    write_collection_outputs(config, articles_history)

    trigger_daily_ogp_generation(config, target_date_key)
    print(f"=== 完了: {config['media_name']} ({target_date_key}号 / Engine: {ai_result.get('generated_by')}) ===")
