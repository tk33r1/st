#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Retail Tech Daily Brief — 毎朝8時のリテールテック・流通DX日刊ニュース自動生成スクリプト

国内外の最新リテールテックニュースを収集し、マルチAI（第1優先: DeepSeek, 第2優先: OpenAI GPT）
による日本語要約とビジネス・テック視点の示唆（Why it matters）を付与してHTML/JSON/RSSを一括生成する。
"""

import argparse
import html
import json
import os
import re
import sys
import email.utils
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

# JST タイムゾーン (+09:00)
JST = timezone(timedelta(hours=9))

# リポジトリルートパスの解決
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
JOB_DIR = os.path.join(REPO_ROOT, 'job', 'retailtechdaily')
DATA_DIR = os.path.join(REPO_ROOT, 'data')
DATA_JSON_PATH = os.path.join(DATA_DIR, 'retail-tech-news.json')
RSS_XML_PATH = os.path.join(JOB_DIR, 'rss.xml')
TOP_HTML_PATH = os.path.join(JOB_DIR, 'index.html')

# 収集クエリ定義（網羅性強化・複線化・SNSトピック対応）
JP_GENERAL_QUERY_BASE = '(リテールテック OR 流通DX OR リテールメディア OR スマートカート OR セルフレジ OR "無人店舗" OR "無人決済" OR "ウォークスルー決済" OR "電子棚札" OR "ESL" OR "需要予測" OR "AI発注" OR "自動発注" OR "ダイナミックプライシング" OR "店舗DX") -レシピ -セール -スイーツ'
JP_INDUSTRY_QUERY_BASE = '(site:ryutsuu.biz OR site:diamond-rm.net OR site:dcs.diamond.co.jp) ("DX" OR "テック" OR "レジ" OR "カート" OR "メディア" OR "AI" OR "実証" OR "RFID" OR "省人化" OR "無人" OR "棚札")'
JP_SNS_QUERY_BASE = '((site:x.com OR site:twitter.com) ("セルフレジ" OR "スマートカート" OR "レジゴー" OR "無人レジ" OR "リテール" OR "スーパー" OR "コンビニ")) OR (("Xで話題" OR "SNSで話題" OR "賛否" OR "物議" OR "バズ" OR "反響") ("セルフレジ" OR "スマートカート" OR "無人レジ" OR "ダイナミックプライシング" OR "スーパー" OR "コンビニ" OR "値上げ" OR "タッチパネル"))'

GLOBAL_GENERAL_QUERY_BASE = '("retail tech" OR "retail technology" OR "retail media" OR "smart cart" OR "smart trolley" OR "cashierless" OR "frictionless checkout" OR "electronic shelf label" OR "retail AI" OR "grocery tech" OR "autonomous checkout")'
GLOBAL_INDUSTRY_QUERY_BASE = '(site:retaildive.com OR site:grocerydive.com OR site:modernretail.co) ("AI" OR "tech" OR "media" OR "checkout" OR "cart" OR "automation" OR "store")'
GLOBAL_SNS_QUERY_BASE = '((site:x.com OR site:twitter.com) ("self-checkout" OR "smart cart" OR "cashierless" OR "grocery" OR "supermarket")) OR (("viral on X" OR "trending on X" OR "customers complain" OR "backlash") ("self-checkout" OR "smart cart" OR "cashierless" OR "retail tech"))'

# 除外ノイズ正規表現（キャンペーン・懸賞ノイズ含む）
JP_NOISE_BLACKLIST = [
    re.compile(p, re.IGNORECASE) for p in [
        r'人事異動', r'役員の異動', r'機構改革', r'決算短信', r'業績予想',
        r'レシピ', r'スイーツ', r'コラボメニュー', r'新メニュー', r'福袋',
        r'新設届出', r'大規模小売店舗立地法',
        r'プレゼント', r'懸賞', r'フォロー＆リポスト', r'ブロマイド', r'一番くじ', r'キャンペーン開催'
    ]
]

GLOBAL_NOISE_BLACKLIST = [
    re.compile(p, re.IGNORECASE) for p in [
        r'stock jumps', r'shares fall', r'financial results', r'q[1-4] earnings', r'quarterly',
        r'giveaway', r'sweepstakes'
    ]
]


# 著者ノードの正規 @id（ポータル・記事ページで共通）
PERSON_ID = "https://tk.st/#author"


def esc(text):
    """HTML特殊文字を安全にエスケープ（XSS防止）"""
    if text is None:
        return ''
    return html.escape(str(text), quote=True)


def sanitize_url(raw_url):
    """http/httpsスキーム以外のURLを無害化"""
    if not raw_url:
        return '#'
    raw_url = raw_url.strip()
    if raw_url.startswith('http://') or raw_url.startswith('https://'):
        return esc(raw_url)
    return '#'


def clean_html_text(raw_html):
    """HTMLタグを除去してプレーンテキスト化"""
    if not raw_html:
        return ''
    text = re.sub(r'<[^>]+>', ' ', raw_html)
    text = text.replace('&quot;', '"').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    text = text.replace('&#39;', "'").replace('&nbsp;', ' ')
    return re.sub(r'\s+', ' ', text).strip()


KEYWORD_PATTERNS = [
    # 小売・流通主要企業
    'ファミリーマート', 'ファミマ', 'セブン-イレブン', 'セブン＆アイ', 'セブン', 'ローソン',
    'イトーヨーカ堂', 'イオン', 'トライアル', 'ベイシア', 'ライフ', 'ヤオコー',
    'Google', 'Amazon', 'Walmart', 'ウォルマート', 'アスタリスク', 'アドインテ', 'TOUCH TO GO', 'TTG',
    # テクノロジー・業務キーワード
    'POSレジ', '完全セルフレジ', 'セルフレジ', 'ハイブリッド型レジ', '切り替え式', 'スマートカート',
    'ウォークスルー決済', '無人決済', '電子棚札', 'ESL', '需要予測AI', '需要予測', 'AI自動発注', '自動発注',
    'ダイナミックプライシング', 'リテールメディア', '店頭サイネージ', 'デジタルサイネージ', 'RFID', '生成AI',
    'Universal Cart', '客層分断', '省人化', 'オムニチャネル', '無人店舗', 'フリクションレス'
]
KEYWORD_PATTERNS.sort(key=len, reverse=True)
KEYWORD_REGEX = re.compile(r'(' + '|'.join(map(re.escape, KEYWORD_PATTERNS)) + r')')


def bold_scan_text(escaped_text):
    """重要キーワードを太字強調（ボールドスキャン）"""
    if not escaped_text:
        return ''
    return KEYWORD_REGEX.sub(r'<strong class="kw-scan">\1</strong>', escaped_text)


def split_takeaway(wim_text):
    """Why it matters から1行キーテイクアウェイ（最初の1文）と詳細を分割"""
    if not wim_text:
        return '', ''
    parts = re.split(r'(?<=[。！？\n])', wim_text, maxsplit=1)
    if len(parts) >= 2:
        return parts[0].strip(), parts[1].strip()
    return wim_text.strip(), ''


def parse_pub_date_timestamp(pub_date_str):
    """RFC 2822 / 822 日付文字列をタイムスタンプ（float）へ変換"""
    if not pub_date_str:
        return 0.0
    try:
        dt = email.utils.parsedate_to_datetime(pub_date_str)
        return dt.timestamp()
    except Exception:
        return 0.0


def fetch_google_news_rss(query, lang='ja', gl='JP', ceid='JP:ja', max_items=40):
    """Google News RSS から指定クエリのニュースを取得"""
    url = f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}&hl={lang}&gl={gl}&ceid={ceid}"
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml, text/xml',
        }
    )
    items = []
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            xml_data = resp.read()
            root = ET.fromstring(xml_data)
            for item in root.findall('.//item')[:max_items]:
                title = clean_html_text(item.find('title').text if item.find('title') is not None else '')
                link = item.find('link').text if item.find('link') is not None else ''
                pub_date = item.find('pubDate').text if item.find('pubDate') is not None else ''
                source = clean_html_text(item.find('source').text if item.find('source') is not None else '')
                desc = clean_html_text(item.find('description').text if item.find('description') is not None else '')

                if ' - ' in title:
                    parts = title.rsplit(' - ', 1)
                    title = parts[0].strip()
                    if not source:
                        source = parts[1].strip()

                if title and link:
                    items.append({
                        'title': title,
                        'source': source or '業界速報',
                        'link': link,
                        'pub_date': pub_date,
                        'pub_ts': parse_pub_date_timestamp(pub_date),
                        'description': desc[:300]
                    })
    except Exception as e:
        print(f"[WARN] RSS取得失敗 ({query[:40]}...): {e}", file=sys.stderr)
    return items


def load_recent_published_history(exclude_date_key=None, days_limit=7):
    """直近のバックナンバーから掲載済み記事のURL・タイトル・プロンプト用要約リストを抽出"""
    if not os.path.exists(DATA_JSON_PATH):
        return {
            'urls': set(),
            'title_keys': set(),
            'recent_titles': []
        }

    try:
        with open(DATA_JSON_PATH, 'r', encoding='utf-8') as f:
            history = json.load(f)
    except Exception as e:
        print(f"[WARN] 履歴JSON読み込み失敗: {e}", file=sys.stderr)
        return {'urls': set(), 'title_keys': set(), 'recent_titles': []}

    history.sort(key=lambda x: x.get('date', ''), reverse=True)

    urls = set()
    title_keys = set()
    recent_titles = []

    count = 0
    for issue in history:
        d = issue.get('date', '')
        # 生成対象日自身は過去履歴の除外対象から除外（再生成・更新の場合を考慮）
        if exclude_date_key and d == exclude_date_key:
            continue

        for art in issue.get('articles', []):
            u = art.get('url', '').strip()
            if u and u != '#':
                urls.add(u)

            t = art.get('title', '').strip()
            if t:
                # 先頭20文字の空白除去で正規化
                tk = re.sub(r'\s+', '', t[:20].lower())
                title_keys.add(tk)
                if len(recent_titles) < 25:
                    recent_titles.append(f"・{t} ({d}号)")

        count += 1
        if count >= days_limit:
            break

    return {
        'urls': urls,
        'title_keys': title_keys,
        'recent_titles': recent_titles
    }


def filter_and_dedup_news(items, blacklist_patterns, published_history=None):
    """記事の重複排除（URL＋タイトル前方一致＋過去バックナンバー掲載除外）とノイズ除去、最新順ソート"""
    seen_links = set()
    seen_titles = set()
    results = []

    pub_urls = published_history.get('urls', set()) if published_history else set()
    pub_title_keys = published_history.get('title_keys', set()) if published_history else set()

    # 配信日時の新しい順（降順）にソート
    sorted_items = sorted(items, key=lambda x: x.get('pub_ts', 0), reverse=True)

    past_dup_count = 0
    for it in sorted_items:
        link = it['link']
        title = it['title']
        # タイトル先頭20文字の空白除去で類似見出しを重複判定
        title_key = re.sub(r'\s+', '', title[:20].lower())

        # 1. 過去バックナンバー（直近7日分）にすでに掲載された記事（同一URLまたはタイトル重複）の除外
        if link in pub_urls or title_key in pub_title_keys:
            past_dup_count += 1
            continue

        # 2. 今回収集プール内での重複排除
        if link in seen_links or title_key in seen_titles:
            continue

        # 3. ノイズ（人事・決算・スイーツ等）のフィルタリング
        if any(pattern.search(title) for pattern in blacklist_patterns):
            continue

        seen_links.add(link)
        seen_titles.add(title_key)
        results.append(it)

    return results, past_dup_count


def gather_all_candidate_news(target_date=None, exclude_date_key=None):
    """国内・海外の3系統クエリ（総合＋専門紙＋SNS話題）から候補記事を並行集約・重複排除・最新順ソート"""
    if target_date is None:
        target_date = datetime.now(JST)

    # 過去バックナンバー（直近7日分）の掲載履歴をロード（過去記事との重複排除用）
    pub_history = load_recent_published_history(exclude_date_key=exclude_date_key, days_limit=7)

    # 月曜日（weekday==0）は土日の48時間分を含むため when:3d、平日は when:2d
    when_clause = "when:3d" if target_date.weekday() == 0 else "when:2d"

    jp_q_gen = f"{JP_GENERAL_QUERY_BASE} {when_clause}"
    jp_q_ind = f"{JP_INDUSTRY_QUERY_BASE} {when_clause}"
    jp_q_sns = f"{JP_SNS_QUERY_BASE} {when_clause}"

    global_q_gen = f"{GLOBAL_GENERAL_QUERY_BASE} {when_clause}"
    global_q_ind = f"{GLOBAL_INDUSTRY_QUERY_BASE} {when_clause}"
    global_q_sns = f"{GLOBAL_SNS_QUERY_BASE} {when_clause}"

    print(f"[1/3] 国内外のリテールテック＆SNS話題ニュースを収集・プール中 (時間窓: {when_clause})...")

    # 国内ニュース収集（総合 40件 + 専門紙 35件 + SNS話題・反響 25件）
    jp_raw = fetch_google_news_rss(jp_q_gen, lang='ja', gl='JP', ceid='JP:ja', max_items=40)
    jp_raw += fetch_google_news_rss(jp_q_ind, lang='ja', gl='JP', ceid='JP:ja', max_items=35)
    jp_raw += fetch_google_news_rss(jp_q_sns, lang='ja', gl='JP', ceid='JP:ja', max_items=25)
    jp_items, jp_past_dups = filter_and_dedup_news(jp_raw, JP_NOISE_BLACKLIST, pub_history)

    # 海外ニュース収集（総合 40件 + 専門紙 35件 + SNS話題・反響 20件）
    global_raw = fetch_google_news_rss(global_q_gen, lang='en-US', gl='US', ceid='US:en', max_items=40)
    global_raw += fetch_google_news_rss(global_q_ind, lang='en-US', gl='US', ceid='US:en', max_items=35)
    global_raw += fetch_google_news_rss(global_q_sns, lang='en-US', gl='US', ceid='US:en', max_items=20)
    global_items, global_past_dups = filter_and_dedup_news(global_raw, GLOBAL_NOISE_BLACKLIST, pub_history)

    # 配信日時の鮮度判定（前日 00:00 JST 以降の新着ニュースを最優先ソート）
    cutoff_days = 3 if target_date.weekday() == 0 else 1
    cutoff_dt = (target_date - timedelta(days=cutoff_days)).replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff_ts = cutoff_dt.timestamp()

    jp_items.sort(key=lambda x: (1 if x.get('pub_ts', 0) >= cutoff_ts else 0, x.get('pub_ts', 0)), reverse=True)
    global_items.sort(key=lambda x: (1 if x.get('pub_ts', 0) >= cutoff_ts else 0, x.get('pub_ts', 0)), reverse=True)

    print(f" -> 収集・精選完了: 国内 {len(jp_items)} 件 (元 {len(jp_raw)} 件, 過去掲載除外 {jp_past_dups} 件) / 海外 {len(global_items)} 件 (元 {len(global_raw)} 件, 過去掲載除外 {global_past_dups} 件)")
    return {
        'JP': jp_items,
        'GLOBAL': global_items,
        'recent_published_titles': pub_history.get('recent_titles', [])
    }


def build_candidate_index(candidates):
    """LLM に渡す候補へ安定IDを付与し、(国内候補, 海外候補, id -> 元アイテム) を返す。

    元記事URLは LLM に渡さない。長い Google News のリダイレクトURLを LLM が
    ドメイン直下へ正規化・切り詰めてしまい、出典リンクが記事に着地しなくなるため。
    """
    index = {}

    def tag(items, prefix):
        listed = []
        for i, it in enumerate(items, 1):
            cid = '%s-%02d' % (prefix, i)
            index[cid] = it
            listed.append({
                'id': cid,
                'title': it['title'],
                'source': it['source'],
                'pub_date': it['pub_date'],
                'description': it['description'],
            })
        return listed

    return tag(candidates['JP'][:45], 'JP'), tag(candidates['GLOBAL'][:30], 'GL'), index


def build_prompt(candidates, target_date_str, yesterday_str):
    """LLM共通のプロンプト構築（精選候補プールから重要トピックを厳選・既出トピック完全除外）"""
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

    return f"""あなたは日本最高峰のリテールテック・流通DXアナリスト兼デジタルマーケター（「Retail Tech Daily Brief」編集長）です。
本日の発行日: {target_date_str}（まとめ対象: {yesterday_str}の最新動向）

以下の【国内ニュース候補】および【海外ニュース候補】を精査し、流通・小売業界の経営者、DX担当者、店舗マーケターにとって実務的・戦略的に重要なニュースを厳選してください。
{recent_section}
【厳格な選別ルール】
1. テクノロジー・DXと無関係な単なる新商品発売や季節イベント（例: 新メニュー発売、コラボスイーツなど）は完全に除外してください。
2. 直近掲載済みのトピックと重複する内容は必ず除外し、昨日（{yesterday_str}）に新しく発表・報道された最新動向を最優先してください。
3. 国内ニュースから最も重要なもの4〜6件、海外ニュースから3〜5件を厳選してください（計7〜10件）。
   選定の際は「技術的新規性」「実店舗への導入インパクト」「人手不足や購買体験の構造的変革」「業界初の試み」を最重視してください。
   また、X（旧Twitter）等のSNSで生活者や店舗現場の間で物議・反響・賛否を呼んでいるトピック（例: セルフレジの操作性や小銭制限への不満・反響、スマートカートの使い勝手、ダイナミックプライシングへの賛否など）があれば、1〜2件積極的に選定し、カテゴリ「SNS話題・生活者のリアル」として生活者視点・現場UX改善への示唆を付与してください。
4. 海外ニュースは、タイトルを魅力的かつ正確な日本語に翻訳し、元の英語タイトル（original_title）も保持してください。
5. すべての記事について、事実の要約（summary: 140〜240文字）に加え、プロの視点によるビジネス・テクノロジー的示唆『Why it matters（ここがポイント）』（120〜200文字）を必ず記述してください。
   海外ニュースの Why it matters では「日本市場や国内リテールへの示唆・影響」に必ず言及してください。
   SNS話題・生活者のリアルの Why it matters では「消費者心理やUI/UXのボトルネック、店舗オペレーションが留意すべき教訓」に言及してください。
6. 昨日の動向全体を象徴する最も重要なポイント3点を「エグゼクティブ・サマリー（executive_summary）」としてまとめてください。
7. カテゴリは以下から選択：
   「店舗DX・次世代決済」「リテールメディア・店頭広告」「物流・RFID・ロボティクス」「AI・需要予測・パーソナライズ」「SNS話題・生活者のリアル」「グローバル先端トレンド」
8. 各記事には、選定元の候補に付いている "id" をそのまま "source_id" として必ず出力してください。
   出典URLはシステム側が id から復元します。URLの推測・生成・出力は一切しないでください。

【国内ニュース候補】:
{json.dumps(jp_sample, ensure_ascii=False, indent=2)}

【海外ニュース候補】:
{json.dumps(global_sample, ensure_ascii=False, indent=2)}

【出力形式】
Markdownのコードブロック（```json）などは付けず、純粋なJSONのみを出力してください:
{{
  "executive_summary": ["要点1", "要点2", "要点3"],
  "articles": [
    {{
      "region": "JP",
      "category": "店舗DX・次世代決済",
      "title": "日本語見出し",
      "original_title": "",
      "source": "媒体名",
      "source_id": "選定元候補のid（例: JP-03）",
      "summary": "要約（140〜240文字）",
      "why_it_matters": "示唆・考察（120〜200文字）",
      "tags": ["スマートカート", "店舗DX"]
    }}
  ]
}}""", candidate_index


def call_llm_api(endpoint, api_key, model_name, prompt_content):
    """OpenAI互換エンドポイントを共通形式で呼び出し"""
    payload = {
        "model": model_name,
        "messages": [
            {
                "role": "system",
                "content": "You are a professional retail technology analyst. Respond ONLY with a valid JSON object matching the requested schema. Do not include markdown formatting."
            },
            {
                "role": "user",
                "content": prompt_content
            }
        ],
        "temperature": 0.3,
        "max_tokens": 4096
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f"Bearer {api_key}",
            'User-Agent': 'RetailTechDailyBrief/2.0'
        }
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        res_data = json.loads(resp.read().decode('utf-8'))
        raw_text = res_data['choices'][0]['message']['content'].strip()
        if raw_text.startswith('```'):
            raw_text = re.sub(r'^```(?:json)?\s*', '', raw_text)
            raw_text = re.sub(r'\s*```$', '', raw_text)
        return json.loads(raw_text)


def title_match_key(title):
    """タイトルの表記ゆれを吸収した突合キー。

    記号の種類を列挙するのは漏れが出るため、英数字と漢字かな以外を落とす方針にする。
    """
    if not title:
        return ''
    return ''.join(ch for ch in str(title).lower() if ch.isalnum())[:40]


def resolve_source_urls(result, candidate_index):
    """LLM が返した記事へ、候補IDから元記事URLを再接続する。

    第1候補は source_id、外した場合はタイトル突合で救済。どちらでも決まらない記事は
    出典リンクを付けない（推測URLや誤リンクを出すより、リンク無しのほうが誠実）。
    """
    by_title = {}
    for it in candidate_index.values():
        key = title_match_key(it['title'])
        if key and key not in by_title:
            by_title[key] = it

    resolved = 0
    unresolved = []
    for art in result.get('articles', []):
        src = candidate_index.get(str(art.get('source_id') or '').strip().upper())
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
            resolved += 1
        else:
            art['url'] = ''
            unresolved.append(art.get('title', '(無題)'))

    print(f" -> 出典URLの再接続: {resolved} 件成功 / {len(unresolved)} 件不明")
    for t in unresolved:
        print(f"[WARN] 出典を特定できずリンク無しで出力します: {t[:50]}", file=sys.stderr)
    return result


def analyze_news_with_fallback(candidates, target_date_str, yesterday_str):
    """マルチAIチェーン（第1: DeepSeek -> 第2: OpenAI GPT -> 最終: ルールベース）"""
    print("[2/3] AI要約・インサイト生成プロセスを開始...")
    prompt, candidate_index = build_prompt(candidates, target_date_str, yesterday_str)

    # プロバイダーチェーン定義
    providers = [
        {
            "name": "DeepSeek",
            "model": os.environ.get('DEEPSEEK_MODEL', 'deepseek-v4.1-flash').strip(),
            "key": os.environ.get('DEEPSEEK_API_KEY', '').strip(),
            "url": "https://api.deepseek.com/chat/completions",
            "badge_label": f"DeepSeek ({os.environ.get('DEEPSEEK_MODEL', 'deepseek-v4.1-flash').strip()})"
        },
        {
            "name": "OpenAI",
            "model": os.environ.get('OPENAI_MODEL', 'gpt-5.6-luna').strip(),
            "key": os.environ.get('OPENAI_API_KEY', '').strip(),
            "url": "https://api.openai.com/v1/chat/completions",
            "badge_label": f"OpenAI ({os.environ.get('OPENAI_MODEL', 'gpt-5.6-luna').strip()})"
        }
    ]

    for p in providers:
        if not p['key']:
            continue
        print(f" -> 試行中: {p['name']} ({p['model']})...")
        try:
            res = call_llm_api(p['url'], p['key'], p['model'], prompt)
            if res and res.get('articles'):
                print(f"[SUCCESS] {p['name']} による生成が成功しました！")
                resolve_source_urls(res, candidate_index)
                res['generated_by'] = p['badge_label']
                res['engine_type'] = p['name'].lower()
                return res
        except Exception as e:
            print(f"[WARN] {p['name']} 呼び出し失敗: {e}", file=sys.stderr)

    # 最終フォールバック（ルールベース）
    print("[INFO] AI未利用またはAPI不通のため、高精度ルールベース生成に切り替えます。")
    res = fallback_rule_based(candidates, yesterday_str)
    res['generated_by'] = "Rule-based Engine (Fallback)"
    res['engine_type'] = "fallback"
    return res


def fallback_rule_based(candidates, yesterday_str):
    """API未設定・通信エラー時の安全出力"""
    articles = []
    blacklist = ['財布', 'スイーツ', 'メニュー', 'コラボ', 'ランチ', '半額セール', 'お弁当']

    for it in candidates['JP']:
        t = it['title']
        if any(b in t for b in blacklist):
            continue

        # SNS話題・賛否・生活者リアルトピックの判定
        is_sns = any(k in t for k in ['Xで話題', 'SNS', '物議', '賛否', 'バズ', 'Twitter', 'x.com', '反響', '不満', '使い勝手'])

        if is_sns:
            cat = "SNS話題・生活者のリアル"
            wim = "店舗オペレーションの省人化・自動化が進む一方で、操作性や現金対応など生活者側の受容性・UXギャップへの配慮が不可欠となっています。"
            tags = ["SNS話題", "店舗UX"]
        elif 'レジ' in t or 'カート' in t or '決済' in t:
            cat = "店舗DX・次世代決済"
            wim = "人手不足解消と購買体験価値向上の両立において、現場オペレーションの省人化とDX推進が急務となっています。"
            tags = ["店舗DX", "流通"]
        else:
            cat = "流通DX一般"
            wim = "人手不足解消と購買体験価値向上の両立において、現場オペレーションの省人化とDX推進が急務となっています。"
            tags = ["店舗DX", "流通"]

        articles.append({
            "region": "JP",
            "category": cat,
            "title": t,
            "original_title": "",
            "source": it['source'],
            "url": it['link'],
            "source_pub_ts": it.get('pub_ts', 0),
            "summary": it['description'][:220] or f"{it['source']}による流通DX関連の最新報道です。",
            "why_it_matters": wim,
            "tags": tags
        })
        if len([a for a in articles if a['region'] == 'JP']) >= 5:
            break

    for it in candidates['GLOBAL']:
        articles.append({
            "region": "GLOBAL",
            "category": "グローバル先端トレンド",
            "title": f"【海外動向】{it['title']}",
            "original_title": it['title'],
            "source": it['source'],
            "url": it['link'],
            "source_pub_ts": it.get('pub_ts', 0),
            "summary": it['description'][:220] or f"Global retail technology movement reported by {it['source']}.",
            "why_it_matters": "海外メガ小売や先端スタートアップの動向は、日本企業が次世代戦略を策定する先行指標となります。",
            "tags": ["海外動向", "グローバル"]
        })
        if len([a for a in articles if a['region'] == 'GLOBAL']) >= 4:
            break

    return {
        "executive_summary": [
            f"{yesterday_str}は、大手流通チェーンによる次世代レジやカートの現場導入検証が活発化しました。",
            "店頭サイネージと購買データを掛け合わせたリテールメディアの戦略が引き続き注目を集めています。",
            "海外市場では、自動店舗（Autonomous Store）やEC連携カートの進化が加速しています。"
        ],
        "articles": articles
    }


# ブランドロゴ SVG スニペット（スマートカート ✕ 同心円シグナル / 案A エディトリアル配色）
BRAND_LOGO_SVG = """<svg class="brand-logo-icon" viewBox="0 0 64 64" width="38" height="38" aria-hidden="true">
  <defs>
    <linearGradient id="hdrBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b192e" />
      <stop offset="60%" stop-color="#0f4c81" />
      <stop offset="100%" stop-color="#1e293b" />
    </linearGradient>
    <linearGradient id="hdrSig" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#818cf8" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="10" fill="url(#hdrBg)" />
  <rect x="1" y="1" width="62" height="62" rx="9" fill="none" stroke="rgba(255, 255, 255, 0.18)" stroke-width="1.2" />
  <path d="M12 26 h5 l5 16 h17 l4 -11 h-23" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" />
  <circle cx="24" cy="47" r="3" fill="#ffffff" />
  <circle cx="38" cy="47" r="3" fill="#ffffff" />
  <circle cx="40" cy="26" r="2.2" fill="url(#hdrSig)" />
  <path d="M 41.8 19.2 A 7 7 0 0 1 46.8 24.2" fill="none" stroke="url(#hdrSig)" stroke-width="2.8" stroke-linecap="round" />
  <path d="M 43.1 14.4 A 12 12 0 0 1 51.6 22.9" fill="none" stroke="url(#hdrSig)" stroke-width="2.8" stroke-linecap="round" />
</svg>"""

# アイコン定数（提案3: インラインSVG共通化）
ICON_EXTERNAL_SVG = """<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" class="external-icon"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>"""

ICON_COPY_SVG = """<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>"""

ICON_X_SVG = """<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>"""

ICON_WIM_SVG = """<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.2" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>"""

# 共通デザイン CSS（提案4: data/retail-tech.css へ外出し）
COMMON_CSS = ""


def build_dynamic_jsonld(issue_data, date_key, formatted_date):
    """日刊記事の収録ニュースに合わせた高解像度 Schema.org JSON-LD を動的生成"""
    articles = issue_data.get('articles', [])
    exec_summary = issue_data.get('executive_summary', [])

    # 動的 description: エグゼクティブサマリーから生成
    dynamic_desc = " ".join(exec_summary[:2]) if exec_summary else f"{formatted_date}のリテールテック＆流通DX最新動向まとめ。"
    if len(dynamic_desc) > 280:
        dynamic_desc = dynamic_desc[:277] + "..."

    # 全タグ・カテゴリ・主要キーワードの集約
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

    # 収録記事の個別 NewsArticle / ListItem
    list_items = []
    has_part_list = []
    for idx, art in enumerate(articles, 1):
        art_id = f"https://tk.st/job/retailtechdaily/{date_key}/#art-{idx}"
        art_schema = {
            "@type": "NewsArticle",
            "@id": art_id,
            "position": idx,
            "headline": art.get('title', ''),
            "description": art.get('summary', ''),
            "url": art_id,
            "articleSection": art.get('category', '流通DX'),
            "inLanguage": "ja",
            # 各カードは本号の一部として同時に公開される
            "datePublished": issue_iso,
            "dateModified": issue_iso,
            "isPartOf": {"@id": f"https://tk.st/job/retailtechdaily/{date_key}/#article"},
            "author": {"@id": PERSON_ID},
            "publisher": {"@id": PERSON_ID}
        }
        if art.get('url'):
            # 出典は sameAs（同一性）ではなく isBasedOn（何を元にしたか）で表す
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
            "@id": f"https://tk.st/job/retailtechdaily/{date_key}/#article",
            "isPartOf": {
                "@type": "Periodical",
                "name": "Retail Tech Daily Brief",
                "url": "https://tk.st/job/retailtechdaily/"
            },
            "headline": f"{formatted_date}号：昨日のリテールテック＆流通DXニュースまとめ",
            "description": dynamic_desc,
            "url": f"https://tk.st/job/retailtechdaily/{date_key}/",
            "image": f"https://tk.st/images/ogp/retailtechdaily-{date_key}.webp",
            "datePublished": f"{date_key[:4]}-{date_key[4:6]}-{date_key[6:8]}T08:00:00+09:00",
            "dateModified": f"{date_key[:4]}-{date_key[4:6]}-{date_key[6:8]}T08:00:00+09:00",
            "inLanguage": "ja",
            "author": {"@id": PERSON_ID},
            "publisher": {"@id": PERSON_ID},
            "articleSection": all_categories,
            "keywords": sorted(list(all_keywords)),
            "hasPart": has_part_list
        },
        {
            "@type": "ItemList",
            "@id": f"https://tk.st/job/retailtechdaily/{date_key}/#newslist",
            "name": f"{formatted_date}号 掲載ニュース一覧",
            "numberOfItems": len(articles),
            "itemListElement": list_items
        },
        {
            "@type": "BreadcrumbList",
            "@id": f"https://tk.st/job/retailtechdaily/{date_key}/#breadcrumb",
            "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Shinya Takeda", "item": "https://tk.st/" },
                { "@type": "ListItem", "position": 2, "name": "Job", "item": "https://tk.st/job/" },
                { "@type": "ListItem", "position": 3, "name": "Retail Tech Daily", "item": "https://tk.st/job/retailtechdaily/" },
                { "@type": "ListItem", "position": 4, "name": f"{formatted_date}号", "item": f"https://tk.st/job/retailtechdaily/{date_key}/" }
            ]
        },
        # ポータル側の @graph と同じ @id を使い、著者ノードを1か所に集約する
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


def render_article_html(issue_data, date_key, formatted_date, prev_issue=None, next_issue=None):
    """記事詳細ページの HTML を生成（種別絞り込みフィルター付き・動的構造化データ内包）"""
    exec_summary_html = "".join([f"<li>{esc(item)}</li>" for item in issue_data['executive_summary']])

    engine_label = esc(issue_data.get('generated_by', 'DeepSeek AI'))
    engine_type = esc(issue_data.get('engine_type', 'deepseek'))
    engine_class = f"engine-{engine_type}"

    articles = issue_data.get('articles', [])
    total_count = len(articles)
    jp_count = sum(1 for a in articles if a.get('region') != 'GLOBAL')
    global_count = sum(1 for a in articles if a.get('region') == 'GLOBAL')

    # 動的 Schema.org 構造化データ（記事個別連動）
    jsonld_obj = build_dynamic_jsonld(issue_data, date_key, formatted_date)
    dynamic_jsonld_str = json.dumps(jsonld_obj, ensure_ascii=False, indent=2)
    dynamic_page_desc = esc(jsonld_obj['@graph'][0]['description'])

    # 読了目安時間の計算（文字数ベース: 550文字/分）
    total_chars = sum(len(a.get('title', '')) + len(a.get('summary', '')) + len(a.get('why_it_matters', '')) for a in articles)
    total_chars += sum(len(s) for s in issue_data.get('executive_summary', []))
    reading_minutes = max(1, round(total_chars / 550))

    # カテゴリ集計（出現順）
    cat_counts = {}
    for a in articles:
        c = a.get('category', '流通DX一般')
        cat_counts[c] = cat_counts.get(c, 0) + 1

    cat_chips = []
    for c, cnt in cat_counts.items():
        cat_chips.append(f'<button type="button" class="filter-chip" data-filter-type="category" data-filter-val="{esc(c)}" aria-pressed="false">{esc(c)} <span class="chip-count">{cnt}</span></button>')
    cat_chips_html = "".join(cat_chips)

    # クイック目次アイテム（30秒スキャン用）
    quick_index_items = []
    for idx, art in enumerate(articles, 1):
        is_global = art.get('region') == 'GLOBAL'
        b_class = 'badge-global' if is_global else 'badge-jp'
        b_txt = '海外' if is_global else '国内'
        cat_name = art.get('category', 'リテールテック')
        t_txt = art.get('title', '')
        quick_index_items.append(f"""        <li class="qi-item">
          <a href="#art-{idx}" class="qi-link">
            <span class="qi-num">{idx:02d}</span>
            <span class="qi-badge {b_class}">{b_txt}</span>
            <span class="qi-cat">{esc(cat_name)}</span>
            <span class="qi-title">{esc(t_txt)}</span>
            <svg class="qi-icon" viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>
          </a>
        </li>""")
    quick_index_html = "\n".join(quick_index_items)

    articles_html = []
    for idx, art in enumerate(articles, 1):
        is_global = art.get('region') == 'GLOBAL'
        region_code = 'GLOBAL' if is_global else 'JP'
        badge_class = 'badge-global' if is_global else 'badge-jp'
        badge_text = '海外 Global' if is_global else '国内 Japan'
        category_name = art.get('category', 'リテールテック')
        orig_title = art.get('original_title', '')
        orig_html = f'<div class="original-title">{esc(orig_title)}</div>' if orig_title else ''
        tags_html = " ".join([f'<span class="tag">#{esc(t)}</span>' for t in art.get('tags', [])])
        # 出典が確定できなかった記事はリンクを張らずタイトルだけ出す
        safe_url = sanitize_url(art.get('url', ''))
        has_source = safe_url != '#'
        raw_title = art.get('title', '')

        # ボールドスキャン（重要企業名・技術キーワード強調）
        escaped_summary = esc(art.get('summary', ''))
        bold_summary = bold_scan_text(escaped_summary)

        # キーテイクアウェイ分割（Why it matters の最初の文を独立抽出）
        raw_wim = art.get('why_it_matters', '')
        takeaway, detail_wim = split_takeaway(raw_wim)
        escaped_takeaway = esc(takeaway)
        bold_takeaway = bold_scan_text(escaped_takeaway)
        escaped_detail = esc(detail_wim)
        bold_detail = bold_scan_text(escaped_detail)

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

        # X共有リンク用
        tweet_text = f"{raw_title} | Retail Tech Daily Brief {date_key}"
        tweet_intent = f"https://x.com/intent/post?text={urllib.parse.quote(tweet_text)}&url={urllib.parse.quote(f'https://tk.st/job/retailtechdaily/{date_key}/#art-{idx}')}"

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
            <div class="tags-container">{tags_html}</div>
            <div class="card-actions">
              <button type="button" class="share-copy-btn" data-share-title="{esc(raw_title)}" data-share-takeaway="{esc(takeaway)}" data-share-url="https://tk.st/job/retailtechdaily/{date_key}/#art-{idx}" title="SlackやTeamsの社内共有用にコピー">
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

    p_link = f'<a href="../{prev_issue["date"]}/" class="nav-prev">&larr; {prev_issue["date"][:4]}/{prev_issue["date"][4:6]}/{prev_issue["date"][6:8]} 号</a>' if prev_issue else '<span class="nav-disabled">&larr; 前号</span>'
    n_link = f'<a href="../{next_issue["date"]}/" class="nav-next">{next_issue["date"][:4]}/{next_issue["date"][4:6]}/{next_issue["date"][6:8]} 号 &rarr;</a>' if next_issue else '<span class="nav-disabled">最新号</span>'

    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <!-- charset は head の先頭に置く（後続バイトの解釈を確定させる） -->
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <!-- 計測タグ（GTM + Ahrefs）は /data/analytics.js に集約 -->
  <script src="../../../data/analytics.js" async></script>

  <title>{formatted_date}号：昨日のリテールテック＆流通DXニュースまとめ — Retail Tech Daily Brief | tk.st</title>
  <meta name="description" content="{dynamic_page_desc}">
  <meta name="author" content="Shinya Takeda">
  <meta name="robots" content="max-image-preview:large">
  <meta name="theme-color" content="#f8fafc">

  <link rel="canonical" href="https://tk.st/job/retailtechdaily/{date_key}/">
  <link rel="author" href="https://tk.st/">

  <meta property="og:title" content="{formatted_date}号：昨日のリテールテック＆流通DXニュースまとめ — Retail Tech Daily Brief">
  <meta property="og:description" content="{dynamic_page_desc}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://tk.st/job/retailtechdaily/{date_key}/">
  <meta property="og:site_name" content="Retail Tech Daily Brief | tk.st">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:image" content="https://tk.st/images/ogp/retailtechdaily-{date_key}.webp">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{formatted_date}号：昨日のリテールテック＆流通DXニュースまとめ — Retail Tech Daily Brief">
  <meta name="twitter:description" content="{dynamic_page_desc}">
  <meta name="twitter:image" content="https://tk.st/images/ogp/retailtechdaily-{date_key}.webp">

  <link rel="icon" href="../../../images/favicons/retail-tech-favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="../../../images/favicons/retail-tech-favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
  <script type="application/ld+json">
{dynamic_jsonld_str}
  </script>
  <link rel="stylesheet" href="../../../data/retail-tech.css">
</head>
<body id="top">
  <div class="reading-progress" id="readingProgress" aria-hidden="true"></div>
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-59NWV9XK" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
  <header class="site-header">
    <div class="container header-inner">
      <a href="../" class="brand-logo">
        {BRAND_LOGO_SVG}
        <div>
          <div class="brand-title">Retail Tech Daily</div>
          <span class="brand-subtitle">毎朝8時のリテールテック速報</span>
        </div>
      </a>
      <div class="header-nav">
        <a href="../" class="nav-btn">一覧へ</a>
      </div>
    </div>
  </header>

  <main class="container">
    <nav class="breadcrumbs">
      <a href="https://tk.st/">⌂ Shinya Takeda</a><span>/</span>
      <a href="../../">Job</a><span>/</span>
      <a href="../">Retail Tech News</a><span>/</span>
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
      <h1 class="hero-title">{formatted_date}号：昨日のリテールテック＆流通DXまとめ</h1>
      <p class="hero-desc">昨日の国内外のリテールテック・流通DX動向。スマートカート・リテールメディア・RFIDロボティクス等の先端事例をプロ視点の示唆付きでお届けします。</p>
    </section>

    <section class="executive-card">
      <div class="exec-title">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        <span>昨日の3大重要トピック（Executive Summary）</span>
      </div>
      <ul class="exec-list">{exec_summary_html}</ul>
    </section>

    <section class="quick-index-card">
      <div class="qi-header">
        <div class="qi-title-wrap">
          <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
          <span>本日のヘッドライン目次（30秒スキャン）</span>
        </div>
        <span class="qi-sub">タップで各記事へジャンプ</span>
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
            <div class="view-mode-toggle" role="group" aria-label="表示モード">
              <button type="button" class="view-btn active" data-view="detailed" title="要約と示唆をすべて表示">詳細</button>
              <button type="button" class="view-btn" data-view="compact" title="見出しと要点のみコンパクト表示">コンパクト</button>
            </div>
          </div>
        </div>
        <div class="filter-scroll" role="group" aria-label="ニュース種別フィルター">
          <button type="button" class="filter-chip active" data-filter="all" aria-pressed="true">すべて <span class="chip-count">{total_count}</span></button>
          <span class="chip-divider"></span>
          <button type="button" class="filter-chip" data-filter-type="region" data-filter-val="JP" aria-pressed="false">🇯🇵 国内 <span class="chip-count">{jp_count}</span></button>
          <button type="button" class="filter-chip" data-filter-type="region" data-filter-val="GLOBAL" aria-pressed="false">🌐 海外 <span class="chip-count">{global_count}</span></button>
          <span class="chip-divider"></span>
          {cat_chips_html}
        </div>
      </div>

      <div class="articles-list" id="articlesList">
        {"".join(articles_html)}
      </div>

      <div class="empty-filter-state" id="emptyFilterState" style="display:none;">
        <div class="empty-icon">🔍</div>
        <p class="empty-text">選択された種別に該当するトピックスはありません。</p>
        <button type="button" class="reset-filter-btn" id="resetFilterBtn">すべてのニュースを表示</button>
      </div>
    </section>

    <div class="issue-pagination">
      <div>{p_link}</div>
      <div><a href="../">アーカイブ一覧へ</a></div>
      <div>{n_link}</div>
    </div>

    <div class="curator-card">
      <div class="curator-avatar">ST</div>
      <div class="curator-info">
        <h4>Curated &amp; Analyzed by Shinya Takeda</h4>
        <p>デジタルマーケター / テックリード。流通・ECのUI/UX改善、データ基盤構築、AIエージェント開発を専門とし、日々のリテール先端動向をキュレーション・分析しています。<a href="../../" class="text-link">実績はこちら &rarr;</a></p>
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
            <a href="https://tk.st/">Home</a><a href="../">Retail Tech Daily</a><a href="../rss.xml">RSS</a><a href="https://tk.st/contact/">Contact</a>
          </div>
          <p>&copy; {date_key[:4]} Shinya Takeda (tk.st). All rights reserved.</p>
        </div>
        <div class="footer-right-spacer" aria-hidden="true"></div>
      </div>
    </div>
  </footer>

  <!-- 最上部へのフローティング追従アンカーリンク -->
  <a href="#top" class="btn-top" id="btnTop" aria-label="最上部へ戻る" title="最上部へ戻る">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg>
  </a>

  <script src="../../../data/buy-me-oil.js"></script>
  <script>
    if (typeof DonationWidget !== 'undefined') {{
      new DonationWidget({{ containerId: 'donation-button-container' }}).init();
    }}
  </script>

  <script>
  (function() {{
    const CHECK_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    const chips = document.querySelectorAll('.filter-chip');
    const cards = document.querySelectorAll('.news-card');
    const visibleCountEl = document.getElementById('visibleArticlesCount');
    const emptyState = document.getElementById('emptyFilterState');
    const resetBtn = document.getElementById('resetFilterBtn');
    const progressBar = document.getElementById('readingProgress');
    const viewBtns = document.querySelectorAll('.view-btn');
    const articlesListEl = document.getElementById('articlesList');

    // 1. スクロール進捗バー
    // scrollHeight はスクロール毎に読むと毎フレーム強制レイアウトになるのでキャッシュし、
    // 高さが変わり得るタイミング（resize・フィルター適用）だけ測り直す。
    let maxScroll = 0;
    function measureScrollRange() {{
      maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      updateProgressBar();
    }}
    function updateProgressBar() {{
      if (!progressBar) return;
      const pct = maxScroll > 0 ? (window.scrollY / maxScroll) * 100 : 0;
      progressBar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    }}
    window.addEventListener('scroll', updateProgressBar, {{ passive: true }});
    window.addEventListener('resize', measureScrollRange, {{ passive: true }});
    measureScrollRange();

    // 2. 表示モード切り替え（詳細 ⇄ コンパクト）
    function setViewMode(mode) {{
      viewBtns.forEach(function(b) {{
        b.classList.toggle('active', b.getAttribute('data-view') === mode);
      }});
      if (articlesListEl) {{
        articlesListEl.classList.toggle('is-compact', mode === 'compact');
      }}
      try {{ localStorage.setItem('rtd_view_mode', mode); }} catch(e) {{}}
    }}
    viewBtns.forEach(function(b) {{
      b.addEventListener('click', function() {{
        setViewMode(b.getAttribute('data-view'));
      }});
    }});
    try {{
      const savedMode = localStorage.getItem('rtd_view_mode');
      if (savedMode === 'compact') setViewMode('compact');
    }} catch(e) {{}}

    // 3. ニュース種別フィルター
    // 初回の ?filter= 復元ではチップへスクロールさせない（読み込み直後に画面が飛ぶため）
    let scrollActiveChipIntoView = false;
    function applyFilter(type, val) {{
      let matched = 0;
      cards.forEach(function(card) {{
        let show = false;
        if (type === 'all') {{
          show = true;
        }} else if (type === 'region') {{
          show = card.getAttribute('data-region') === val;
        }} else if (type === 'category') {{
          show = card.getAttribute('data-category') === val;
        }}

        if (show) {{
          card.classList.remove('is-hidden');
          card.classList.add('fade-in');
          matched++;
        }} else {{
          card.classList.add('is-hidden');
          card.classList.remove('fade-in');
        }}
      }});

      chips.forEach(function(chip) {{
        const cType = chip.getAttribute('data-filter-type') || (chip.getAttribute('data-filter') === 'all' ? 'all' : '');
        const cVal = chip.getAttribute('data-filter-val') || '';
        const isActive = (type === 'all' && cType === 'all') || (type === cType && val === cVal);
        chip.classList.toggle('active', isActive);
        chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        // 横スクロールする絞り込みバーの中で、選択中のチップを見える位置へ寄せる。
        // ページ読み込み直後（?filter= の復元）は動かさない。
        if (isActive && scrollActiveChipIntoView) {{
          chip.scrollIntoView({{ behavior: 'smooth', block: 'nearest', inline: 'center' }});
        }}
      }});

      if (visibleCountEl) visibleCountEl.textContent = matched;
      if (emptyState) emptyState.style.display = (matched === 0) ? 'block' : 'none';
      measureScrollRange();

      // URL パラメータの同期
      try {{
        const url = new URL(window.location);
        if (type === 'all') {{
          url.searchParams.delete('filter');
        }} else {{
          url.searchParams.set('filter', type + ':' + val);
        }}
        window.history.replaceState({{}}, '', url);
      }} catch(e) {{}}
    }}

    chips.forEach(function(chip) {{
      chip.addEventListener('click', function() {{
        const isAll = chip.getAttribute('data-filter') === 'all';
        if (isAll) {{
          applyFilter('all', '');
        }} else {{
          applyFilter(chip.getAttribute('data-filter-type'), chip.getAttribute('data-filter-val'));
        }}
      }});
    }});

    // カード内のバッジクリック連動
    document.querySelectorAll('[data-filter-trigger]').forEach(function(btn) {{
      btn.addEventListener('click', function(e) {{
        e.preventDefault();
        const type = btn.getAttribute('data-filter-trigger');
        const val = btn.getAttribute('data-filter-val');
        applyFilter(type, val);
        const targetSec = document.getElementById('articlesSection');
        if (targetSec) targetSec.scrollIntoView({{ behavior: 'smooth' }});
      }});
    }});

    if (resetBtn) {{
      resetBtn.addEventListener('click', function() {{
        applyFilter('all', '');
      }});
    }}

    // 初回 URL パラメータ復元
    // params.get() は既にデコード済みなので decodeURIComponent は掛けない。
    // 値側にコロンが含まれても壊れないよう、最初のコロンだけで分割する。
    try {{
      const params = new URLSearchParams(window.location.search);
      const f = params.get('filter');
      const sep = f ? f.indexOf(':') : -1;
      if (sep > 0) {{
        const type = f.slice(0, sep);
        const val = f.slice(sep + 1);
        // 該当チップが無い絞り込み条件（古いリンク等）は無視して全件表示のままにする
        const known = Array.from(chips).some(function(chip) {{
          return chip.getAttribute('data-filter-type') === type
            && chip.getAttribute('data-filter-val') === val;
        }});
        if (known) applyFilter(type, val);
      }}
    }} catch(e) {{}}
    scrollActiveChipIntoView = true;

    // 4. 社内共有コピーボタン（Slack / Teams用）
    document.querySelectorAll('.share-copy-btn').forEach(function(btn) {{
      // 元の中身は最初に1度だけ退避する。クリック毎に取り直すと、2秒以内の連打で
      // 「コピー完了！」の状態を"元"として保存してしまい、表示が戻らなくなる。
      const originalHtml = btn.innerHTML;
      let restoreTimer = null;

      function flash(message, ok) {{
        if (restoreTimer) clearTimeout(restoreTimer);
        btn.classList.toggle('copied', ok);
        btn.innerHTML = (ok ? CHECK_ICON : '') + '<span>' + message + '</span>';
        restoreTimer = setTimeout(function() {{
          btn.classList.remove('copied');
          btn.innerHTML = originalHtml;
          restoreTimer = null;
        }}, 2000);
      }}

      btn.addEventListener('click', async function() {{
        const title = btn.getAttribute('data-share-title');
        const takeaway = btn.getAttribute('data-share-takeaway');
        const url = btn.getAttribute('data-share-url');
        const text = '【流通DX日刊速報】' + title + '\\n💡 要点: ' + takeaway + '\\n🔗 ' + url;

        let success = false;
        if (navigator.clipboard && navigator.clipboard.writeText) {{
          try {{
            await navigator.clipboard.writeText(text);
            success = true;
          }} catch(e) {{}}
        }}

        if (!success) {{
          try {{
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            success = true;
          }} catch(e) {{}}
        }}

        // 失敗時も黙らない（非HTTPSや権限拒否で何も起きないと操作不能に見える）
        flash(success ? 'コピー完了！' : 'コピーできませんでした', success);
      }});
    }});

    // 5. 最上部への追従アンカーリンク
    const btnTop = document.getElementById('btnTop');
    if (btnTop) {{
      window.addEventListener('scroll', function() {{
        if (window.scrollY > 300) {{
          btnTop.classList.add('visible');
        }} else {{
          btnTop.classList.remove('visible');
        }}
      }}, {{ passive: true }});

      btnTop.addEventListener('click', function(e) {{
        e.preventDefault();
        window.scrollTo({{ top: 0, behavior: 'smooth' }});
      }});
    }}
  }})();
  </script>
</body>
</html>
"""


# FAQ 定義データ（トップポータル表示 ＆ FAQPage 構造化データ共通）
FAQ_ITEMS = [
    {
        "q": "「Retail Tech Daily Brief」とはどのようなメディアですか？",
        "a": "国内外の流通・小売テクノロジー（店舗DX、スマートカート、リテールメディア、無人決済、RFID、需要予測AIなど）の最新動向を毎朝8:00（JST）に集約・解説する日刊ブリーフです。客観的な事実報道に加え、業界動向や日本市場への示唆（Why it matters）をプロの視点で付与しています。"
    },
    {
        "q": "ニュースの更新頻度と配信時間はいつですか？",
        "a": "土日・祝日を含め、毎日朝8:00（日本時間・JST）に自動配信しています。前日に発表された国内外のプレスリリースや専門紙の最新報道を、毎朝の通勤時や始業前の3〜5分で効率よくキャッチアップできます。"
    },
    {
        "q": "ニュースの選定や分析はどのように行われていますか？",
        "a": "業界専門紙（「流通ニュース」「ダイヤモンド・チェーンストア」等）や海外先端メディア（「Retail Dive」等）に加え、X（旧Twitter）をはじめとするSNS上の生活者・現場のリアルな反響や賛否トピックをクローリング。マルチAI（DeepSeek / OpenAI GPT）が「技術的新規性」「実店舗への導入規模」「顧客UX・現場オペレーションへの影響度」を多角的に分析して厳選しています。"
    },
    {
        "q": "最新ニュースの通知や購読はできますか？",
        "a": "本ページでの閲覧に加え、<a href=\"rss.xml\">RSSフィード (rss.xml)</a> による購読が可能です。SlackやTeams、DiscordのRSS連携アプリに登録することで、社内チャットへの毎朝の自動配信も容易に行えます。"
    },
    {
        "q": "社内チャット（Slack/Teams）やSNSへの引用・共有は可能ですか？",
        "a": "はい、ご自由に共有いただけます。各日刊記事の個別ニュースカードに設置されている「📋 社内共有コピー」ボタンをクリックすると、社内ツール貼り付け用に最適化された要約テキストが一発でクリップボードにコピーされます。"
    }
]


# 絞り込みピルの表示用ラベル。キーは記事カテゴリ名。
# ここに無いカテゴリも（絵文字なしで）そのまま出すので、分類を増やしても穴は開かない。
CATEGORY_PILL_LABELS = {
    "店舗DX・次世代決済": "🛒 店舗DX / カート",
    "リテールメディア・店頭広告": "📺 リテールメディア",
    "物流・RFID・ロボティクス": "📦 RFID / 棚卸ロボ",
    "AI・需要予測・パーソナライズ": "🤖 需要予測AI",
    "SNS話題・生活者のリアル": "💬 SNS話題・生活者のリアル",
    "グローバル先端トレンド": "🌐 グローバル先端トレンド",
}


def build_meta_pills_html(latest):
    """最新号に実在するカテゴリだけで絞り込みピルを組む。

    固定リストで出すと、その号に載っていないカテゴリのピルが「0件」ページへ着地する。
    記事ページ側のチップ（cat_counts）と同じ集合を使うのが正しい。
    """
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
        label = CATEGORY_PILL_LABELS.get(cat, cat)
        query = 'category:' + urllib.parse.quote(cat, safe='')
        pills.append(f'<a href="{esc(date_key)}/?filter={query}" class="meta-pill-item">{esc(label)}</a>')

    # 海外記事があるときだけ地域ピルを添える
    if any(art.get('region') == 'GLOBAL' for art in articles):
        pills.append(f'<a href="{esc(date_key)}/?filter=region:GLOBAL" class="meta-pill-item">🌍 海外ニュースすべて</a>')

    return "\n        ".join(pills)


def render_top_index_html(articles_history):
    """トップポータルページ (job/retailtechdaily/index.html) の HTML を生成（FAQおよびFAQPage構造化データ付き）"""
    latest = articles_history[0] if articles_history else None
    latest_date_formatted = f"{latest['date'][:4]}年{int(latest['date'][4:6])}月{int(latest['date'][6:8])}日" if latest else ""
    latest_highlights = "".join([f"<li>{esc(h)}</li>" for h in latest.get('executive_summary', [])[:3]]) if latest else ""

    latest_engine = esc(latest.get('generated_by', 'DeepSeek AI')) if latest else ""
    latest_engine_type = esc(latest.get('engine_type', 'deepseek')) if latest else ""
    meta_pills_html = build_meta_pills_html(latest)

    displayed_history = articles_history[:40]
    history_cards = []
    for issue in displayed_history:
        d = esc(issue['date'])
        d_fmt = f"{d[:4]}年{int(d[4:6])}月{int(d[6:8])}日"
        summary_preview = esc(issue.get('summary', '') or "昨日のリテールテックまとめ。")
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

    # FAQ 構造化データ（FAQPage）とアコーディオン HTML の生成
    faq_jsonld_entities = []
    faq_html_items = []
    for idx, item in enumerate(FAQ_ITEMS, 1):
        clean_ans = clean_html_text(item["a"])
        faq_jsonld_entities.append({
            "@type": "Question",
            "name": item["q"],
            "acceptedAnswer": {
                "@type": "Answer",
                "text": clean_ans
            }
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

    # 最新号の日時情報
    latest_date_str = latest['date'] if latest else '20260912'
    latest_iso_date = f"{latest_date_str[:4]}-{latest_date_str[4:6]}-{latest_date_str[6:8]}T08:00:00+09:00"

    # バックナンバー各号の PublicationIssue リスト（ItemList 構造化データ）
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
                "@id": f"https://tk.st/job/retailtechdaily/{d}/#issue",
                "issueNumber": d,
                "name": issue.get('title', f"{d_fmt}号まとめ"),
                "description": clean_html_text(issue.get('summary', '')),
                "url": f"https://tk.st/job/retailtechdaily/{d}/",
                "datePublished": d_iso
            }
        })

    # ポータル用 Schema.org JSON-LD (@graph: Breadcrumb + Periodical + CollectionPage + ItemList + FAQPage + Person)
    portal_graph = [
        {
            "@type": "BreadcrumbList",
            "@id": "https://tk.st/job/retailtechdaily/#breadcrumb",
            "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Shinya Takeda", "item": "https://tk.st/" },
                { "@type": "ListItem", "position": 2, "name": "Job", "item": "https://tk.st/job/" },
                { "@type": "ListItem", "position": 3, "name": "Retail Tech Daily", "item": "https://tk.st/job/retailtechdaily/" }
            ]
        },
        {
            "@type": "Periodical",
            "@id": "https://tk.st/job/retailtechdaily/#periodical",
            "name": "Retail Tech Daily Brief",
            "alternateName": ["リテールテック日刊速報", "流通DXデイリー", "Retail Tech Daily"],
            "headline": "毎朝8時のリテールテック・流通DX日刊速報",
            "description": "毎朝8:00更新。昨日の国内外リテールテック・流通DX動向（スマートカート、無人決済、リテールメディア、RFID、AI需要予測、SNS話題）をマルチAI（DeepSeek / GPT）が要約・示唆付きで配信する日刊ニュースメディア。",
            "url": "https://tk.st/job/retailtechdaily/",
            "inLanguage": "ja",
            "issuanceFrequency": "P1D",
            "about": [
                { "@type": "Thing", "name": "リテールテック" },
                { "@type": "Thing", "name": "流通DX" },
                { "@type": "Thing", "name": "スマートカート" },
                { "@type": "Thing", "name": "リテールメディア" },
                { "@type": "Thing", "name": "RFID" },
                { "@type": "Thing", "name": "無人店舗・決済" },
                { "@type": "Thing", "name": "需要予測AI" },
                { "@type": "Thing", "name": "SNS話題・生活者インサイト" }
            ],
            "publisher": { "@id": "https://tk.st/#author" }
        },
        {
            "@type": "CollectionPage",
            "@id": "https://tk.st/job/retailtechdaily/#portal",
            "isPartOf": { "@id": "https://tk.st/job/retailtechdaily/#periodical" },
            "name": "Retail Tech Daily Brief — ポータル＆アーカイブ",
            "headline": "昨日の国内外リテールテック動向をAI要約＋ビジネス示唆付きで届ける日刊速報",
            "description": "毎朝8:00更新。昨日の国内外リテールテック・流通DX動向（スマートカート、無人決済、リテールメディア、RFIDロボティクス、AI需要予測）をマルチAI（DeepSeek / GPT）が要約・示唆付きで配信する日刊速報。",
            "url": "https://tk.st/job/retailtechdaily/",
            "primaryImageOfPage": "https://tk.st/images/ogp/job-ogp.webp",
            "inLanguage": "ja",
            "datePublished": "2026-09-12T08:00:00+09:00",
            "dateModified": latest_iso_date,
            "author": { "@id": "https://tk.st/#author" },
            "publisher": { "@id": "https://tk.st/#author" },
            "mainEntity": { "@id": "https://tk.st/job/retailtechdaily/#issuelist" }
        },
        {
            "@type": "ItemList",
            "@id": "https://tk.st/job/retailtechdaily/#issuelist",
            "name": "Retail Tech Daily Brief バックナンバー一覧",
            "numberOfItems": len(articles_history),
            "itemListElement": issue_items
        },
        {
            "@type": "FAQPage",
            "@id": "https://tk.st/job/retailtechdaily/#faq",
            "name": "Retail Tech Daily Brief よくあるご質問",
            "mainEntity": faq_jsonld_entities
        },
        {
            "@type": "Person",
            "@id": "https://tk.st/#author",
            "name": "Shinya Takeda",
            "url": "https://tk.st/job/",
            "jobTitle": "Digital Marketer / Tech Lead",
            "knowsAbout": [
                "リテールテック",
                "流通DX",
                "ECテクノロジー",
                "スマートカート",
                "リテールメディア",
                "UI/UXエンジニアリング"
            ],
            "sameAs": [
                "https://tk.st/",
                "https://github.com/tk33r1"
            ]
        }
    ]
    portal_jsonld_str = json.dumps({"@context": "https://schema.org", "@graph": portal_graph}, ensure_ascii=False, indent=2)

    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <!-- charset は head の先頭に置く（後続バイトの解釈を確定させる） -->
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <!-- 計測タグ（GTM + Ahrefs）は /data/analytics.js に集約 -->
  <script src="../../data/analytics.js" async></script>

  <title>Retail Tech Daily Brief — 毎朝8時のリテールテック・流通DX日刊速報 | tk.st</title>
  <meta name="description" content="毎朝8:00更新。昨日の国内外リテールテック・流通DX動向（スマートカート、無人決済、リテールメディア、RFIDロボティクス、AI需要予測）をマルチAI（DeepSeek / GPT）が要約・示唆付きで配信する日刊速報。">
  <meta name="author" content="Shinya Takeda">
  <meta name="robots" content="max-image-preview:large">
  <meta name="theme-color" content="#f8fafc">

  <link rel="canonical" href="https://tk.st/job/retailtechdaily/">
  <link rel="author" href="https://tk.st/">
  <link rel="alternate" type="application/rss+xml" title="Retail Tech Daily Brief RSS" href="https://tk.st/job/retailtechdaily/rss.xml">

  <meta property="og:title" content="Retail Tech Daily Brief — 毎朝8時のリテールテック・流通DX日刊速報 | tk.st">
  <meta property="og:description" content="毎朝8:00更新。昨日の国内外リテールテック動向をAI要約＋ビジネス示唆付きで届ける日刊速報。">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://tk.st/job/retailtechdaily/">
  <meta property="og:site_name" content="Retail Tech Daily Brief | tk.st">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:image" content="https://tk.st/images/ogp/job-ogp.webp">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Retail Tech Daily Brief — 毎朝8時のリテールテック・流通DX日刊速報 | tk.st">
  <meta name="twitter:description" content="毎朝8:00更新。昨日の国内外リテールテック動向をAI要約＋ビジネス示唆付きで届ける日刊速報。">
  <meta name="twitter:image" content="https://tk.st/images/ogp/job-ogp.webp">

  <link rel="icon" href="../../images/favicons/retail-tech-favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="../../images/favicons/retail-tech-favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
  <script type="application/ld+json">
{portal_jsonld_str}
  </script>
  <link rel="stylesheet" href="../../data/retail-tech.css">
</head>
<body id="top">
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-59NWV9XK" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
  <header class="site-header">
    <div class="container header-inner">
      <a href="./" class="brand-logo">
        {BRAND_LOGO_SVG}
        <div>
          <div class="brand-title">Retail Tech Daily</div>
          <span class="brand-subtitle">毎朝8時のリテールテック速報</span>
        </div>
      </a>
      <div class="header-nav">
        <a href="rss.xml" class="nav-btn" target="_blank" rel="noopener noreferrer">RSS 購読</a>
      </div>
    </div>
  </header>

  <main class="container">
    <nav class="breadcrumbs">
      <a href="https://tk.st/">⌂ Shinya Takeda</a><span>/</span>
      <a href="../">Job</a><span>/</span>
      <strong>Retail Tech Daily</strong>
    </nav>

    <section class="portal-hero">
      <div class="badge-pill"><span class="badge-dot"></span>毎朝 08:00 JST 配信</div>
      <h1 class="portal-title">Retail Tech Daily Brief</h1>
      <p class="portal-desc">昨日の国内外のリテールテック・流通DX動向を毎朝8時に集約。<br>AI・スマートカート・リテールメディア・RFIDの先端動向をプロのインサイト付きでお届けします。</p>
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
            <a href="https://tk.st/">Home</a><a href="./">Retail Tech Daily</a><a href="#faq">FAQ</a><a href="rss.xml">RSS</a><a href="https://tk.st/contact/">Contact</a>
          </div>
          <p>&copy; 2026 Shinya Takeda (tk.st). All rights reserved.</p>
        </div>
        <div class="footer-right-spacer" aria-hidden="true"></div>
      </div>
    </div>
  </footer>

  <!-- 最上部へのフローティング追従アンカーリンク -->
  <a href="#top" class="btn-top" id="btnTop" aria-label="最上部へ戻る" title="最上部へ戻る">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg>
  </a>

  <script src="../../data/buy-me-oil.js"></script>
  <script>
    if (typeof DonationWidget !== 'undefined') {{
      new DonationWidget({{ containerId: 'donation-button-container' }}).init();
    }}

    // 最上部への追従アンカーリンク
    const btnTop = document.getElementById('btnTop');
    if (btnTop) {{
      window.addEventListener('scroll', function() {{
        if (window.scrollY > 300) {{
          btnTop.classList.add('visible');
        }} else {{
          btnTop.classList.remove('visible');
        }}
      }}, {{ passive: true }});

      btnTop.addEventListener('click', function(e) {{
        e.preventDefault();
        window.scrollTo({{ top: 0, behavior: 'smooth' }});
      }});
    }}
  </script>
</body>
</html>
"""


def generate_rss_xml(articles_history):
    """RSS 2.0 フィード (job/retailtechdaily/rss.xml) を生成"""
    items_xml = []
    latest_pub_dt = None
    for issue in articles_history[:15]:
        d = issue['date']
        pub_dt = datetime.strptime(d, '%Y%m%d').replace(hour=8, minute=0, second=0, tzinfo=JST)
        if latest_pub_dt is None or pub_dt > latest_pub_dt:
            latest_pub_dt = pub_dt
        # strftime の %a/%b はロケール依存（日本語環境で「土」等になり RFC822 として壊れる）。
        # email.utils なら常に英語表記で出る。
        rfc822_date = email.utils.format_datetime(pub_dt)
        desc_escaped = esc(issue.get('summary') or '')
        title_escaped = esc(issue.get('title', f'{d}号'))

        items_xml.append(f"""    <item>
      <title>{title_escaped}</title>
      <link>https://tk.st/job/retailtechdaily/{d}/</link>
      <guid isPermaLink="true">https://tk.st/job/retailtechdaily/{d}/</guid>
      <pubDate>{rfc822_date}</pubDate>
      <description>{desc_escaped}</description>
    </item>""")

    rss_body = "\n".join(items_xml)
    # channel の pubDate は最新号、lastBuildDate は生成時刻。
    # どちらも欠けているとリーダー側が更新を判断しづらい。
    channel_pub_date = email.utils.format_datetime(latest_pub_dt) if latest_pub_dt else ''
    last_build_date = email.utils.format_datetime(datetime.now(JST))
    channel_dates = f"    <pubDate>{channel_pub_date}</pubDate>\n" if channel_pub_date else ''

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Retail Tech Daily Brief — 毎朝8時のリテールテック速報</title>
    <link>https://tk.st/job/retailtechdaily/</link>
    <description>昨日の国内外リテールテック・流通DX動向をAI要約＋ビジネス示唆付きで毎朝8時に配信する日刊ニュースブリーフ。</description>
    <language>ja</language>
{channel_dates}    <lastBuildDate>{last_build_date}</lastBuildDate>
    <ttl>720</ttl>
    <generator>Retail Tech Daily Brief generator</generator>
    <atom:link href="https://tk.st/job/retailtechdaily/rss.xml" rel="self" type="application/rss+xml"/>
{rss_body}
  </channel>
</rss>
"""


def trigger_daily_ogp_generation(date_key):
    """日刊記事専用の OGP 画像（Lossless WebP 2400x1260）を生成"""
    ogp_script = os.path.join(REPO_ROOT, '.github', 'scripts', 'ogp', 'generate-daily-ogp.js')
    if not os.path.exists(ogp_script):
        print(f"[WARN] OGP 生成スクリプトが見つかりません: {ogp_script}", file=sys.stderr)
        return
    print(f" -> 日刊 OGP 画像生成中 (Lossless WebP): {date_key}...")
    try:
        import subprocess
        res = subprocess.run(['node', ogp_script, str(date_key)], cwd=REPO_ROOT, capture_output=True, text=True, check=True)
        print(f" -> {res.stdout.strip()}")
    except Exception as e:
        print(f"[WARN] OGP 画像生成に失敗しました（記事生成自体は継続します）: {e}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description='Retail Tech Daily News Generator')
    parser.add_argument('--date', default='', help='Target issue date (YYYYMMDD). Empty for today JST.')
    parser.add_argument('--rebuild', action='store_true', help='Rebuild HTML and RSS from existing data/retail-tech-news.json without calling APIs')
    args = parser.parse_args()

    os.makedirs(JOB_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    # --rebuild モード: 既存 JSON から全記事 HTML、トップポータル、RSS を再生成
    if args.rebuild:
        print("=== Retail Tech Daily Brief: Rebuilding HTML and RSS from JSON ===")
        if not os.path.exists(DATA_JSON_PATH):
            print(f"[ERROR] {DATA_JSON_PATH} が存在しません。", file=sys.stderr)
            sys.exit(1)
        with open(DATA_JSON_PATH, 'r', encoding='utf-8') as f:
            history = json.load(f)

        history.sort(key=lambda x: x['date'], reverse=True)
        for i, issue in enumerate(history):
            d_key = issue['date']
            d_dir = os.path.join(JOB_DIR, d_key)
            os.makedirs(d_dir, exist_ok=True)
            d_fmt = f"{d_key[:4]}年{int(d_key[4:6])}月{int(d_key[6:8])}日"
            n_iss = history[i - 1] if i > 0 else None
            p_iss = history[i + 1] if i < len(history) - 1 else None
            art_html = render_article_html(issue, d_key, d_fmt, p_iss, n_iss)
            with open(os.path.join(d_dir, 'index.html'), 'w', encoding='utf-8') as f:
                f.write(art_html)
            print(f" -> 再生成完了: {d_key}号 HTML")

            # 該当号の OGP 画像が存在しない場合は生成
            ogp_webp_path = os.path.join(REPO_ROOT, 'images', 'ogp', f'retailtechdaily-{d_key}.webp')
            if not os.path.exists(ogp_webp_path):
                trigger_daily_ogp_generation(d_key)

        top_html = render_top_index_html(history)
        with open(TOP_HTML_PATH, 'w', encoding='utf-8') as f:
            f.write(top_html)
        print(" -> 再生成完了: トップポータル index.html")

        rss_xml = generate_rss_xml(history)
        with open(RSS_XML_PATH, 'w', encoding='utf-8') as f:
            f.write(rss_xml)
        print(" -> 再生成完了: rss.xml")
        print("=== Rebuild 完了 ===")
        return

    now_jst = datetime.now(JST)
    if args.date and args.date.strip():
        target_date = datetime.strptime(args.date.strip(), '%Y%m%d').replace(tzinfo=JST)
    else:
        target_date = now_jst

    date_key = target_date.strftime('%Y%m%d')
    yesterday_date = target_date - timedelta(days=1)
    target_date_formatted = f"{target_date.year}年{target_date.month}月{target_date.day}日"
    yesterday_formatted = f"{yesterday_date.year}年{yesterday_date.month}月{yesterday_date.day}日"

    print(f"=== Retail Tech Daily Brief 生成開始 (v2.0 Simplified) ===")
    print(f"発行日: {target_date_formatted} ({date_key} 08:00 JST) / 対象日: {yesterday_formatted}")

    issue_dir = os.path.join(JOB_DIR, date_key)
    os.makedirs(issue_dir, exist_ok=True)

    # 1. 候補ニュース収集（過去バックナンバーとの重複を自動排除）
    candidates = gather_all_candidate_news(target_date, exclude_date_key=date_key)

    # 2. AI選別・要約（DeepSeek -> OpenAI GPT -> ルールベース）
    issue_data = analyze_news_with_fallback(candidates, target_date_formatted, yesterday_formatted)

    # 3. 履歴データの更新
    history = []
    if os.path.exists(DATA_JSON_PATH):
        try:
            with open(DATA_JSON_PATH, 'r', encoding='utf-8') as f:
                history = json.load(f)
        except Exception as e:
            print(f"[WARN] 既存の {DATA_JSON_PATH} 読み込み失敗: {e}", file=sys.stderr)

    summary_text = " / ".join(issue_data['executive_summary'][:2])
    issue_meta = {
        "date": date_key,
        "title": f"{target_date_formatted}号：昨日のリテールテック＆流通DXまとめ",
        "url": f"https://tk.st/job/retailtechdaily/{date_key}/",
        "summary": summary_text,
        "count": len(issue_data['articles']),
        "executive_summary": issue_data['executive_summary'],
        "generated_by": issue_data.get('generated_by', 'DeepSeek AI'),
        "engine_type": issue_data.get('engine_type', 'deepseek'),
        "articles": issue_data['articles']
    }

    history = [h for h in history if h.get('date') != date_key]
    history.append(issue_meta)
    history.sort(key=lambda x: x['date'], reverse=True)

    curr_idx = [i for i, h in enumerate(history) if h['date'] == date_key][0]
    next_issue = history[curr_idx - 1] if curr_idx > 0 else None
    prev_issue = history[curr_idx + 1] if curr_idx < len(history) - 1 else None

    # 4. ファイル出力
    print(f"[3/3] ファイル出力中...")
    issue_html = render_article_html(issue_data, date_key, target_date_formatted, prev_issue, next_issue)
    with open(os.path.join(issue_dir, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(issue_html)

    with open(DATA_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(history, f, ensure_ascii=False, indent=2)

    top_html = render_top_index_html(history)
    with open(TOP_HTML_PATH, 'w', encoding='utf-8') as f:
        f.write(top_html)

    rss_xml = generate_rss_xml(history)
    with open(RSS_XML_PATH, 'w', encoding='utf-8') as f:
        f.write(rss_xml)

    # 日刊記事固有の OGP 画像（Lossless WebP）を生成
    trigger_daily_ogp_generation(date_key)

    print(f"=== 完了: Retail Tech Daily Brief ({date_key}号 / Engine: {issue_meta['generated_by']}) ===")


if __name__ == '__main__':
    main()
