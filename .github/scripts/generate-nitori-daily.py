#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Nitori Daily Brief — 毎朝8時の株式会社ニトリ・ニトリHD日刊速報＆SNS話題

共通エンジン `daily_engine.py` を利用した設定駆動型エントリーポイント。
"""

import html
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
import brightdata_social
from daily_engine import build_keyword_regex, build_rule_based_fallback, run_daily_pipeline

JST = timezone(timedelta(hours=9))

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))

# 収集クエリ定義
JP_GENERAL_QUERY = '("株式会社ニトリ" OR "ニトリホールディングス" OR "ニトリHD" OR "ニトリ" OR "デコホーム" OR "島忠") ("店舗" OR "出店" OR "新商品" OR "値下げ" OR "決算" OR "PB" OR "家具" OR "インテリア" OR "生活雑貨" OR "社長" OR "似鳥") -レシピ -スイーツ'
JP_INDUSTRY_QUERY = '("ニトリ" OR "NITORI") ("DX" OR "アプリ" OR "EC" OR "ネット" OR "物流" OR "自動化" OR "ロボット" OR "倉庫" OR "RFID" OR "セルフレジ" OR "ライブコマース" OR "サイズ計測" OR "画像検索")'
JP_SNS_QUERY = '((site:x.com OR site:twitter.com) ("ニトリ" OR "NITORI") ("買った" OR "おすすめ" OR "便利" OR "バズ" OR "神" OR "使いやすい" OR "家具" OR "収納" OR "カーテン" OR "マットレス" OR "不満" OR "不良品" OR "改悪")) OR (("Xで話題" OR "SNSで話題" OR "賛否" OR "物議" OR "バズ" OR "反響" OR "神アイテム" OR "品切れ" OR "売り切れ" OR "買ってよかった") ("ニトリ" OR "NITORI" OR "デコホーム"))'

GLOBAL_GENERAL_QUERY = '("Nitori" OR "Nitori Holdings" OR "ニトリ") ("store" OR "expansion" OR "Asia" OR "opens" OR "retail" OR "furniture" OR "home" OR "Vietnam" OR "Thailand" OR "Malaysia" OR "Philippines" OR "India" OR "Indonesia" OR "Singapore" OR "Taiwan" OR "China")'
GLOBAL_INDUSTRY_QUERY = '("IKEA" OR "Nitori" OR "home furnishing") ("automation" OR "supply chain" OR "store" OR "retail tech" OR "robotics")'
GLOBAL_SNS_QUERY = '((site:x.com OR site:twitter.com) ("Nitori" OR "ニトリ")) OR (("Nitori" OR "ニトリ") ("global" OR "overseas" OR "Asia" OR "expansion"))'

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

NITORI_RELEVANT_KEYWORDS = [
    'ニトリ', 'nitori', 'デコホーム', '島忠', 'シマホ', '似鳥', 'ホームズ'
]
GLOBAL_RELEVANT_KEYWORDS = ['nitori', 'ニトリ']


YAHOO_REALTIME_SPAM_KEYWORDS = [
    '当選', 'プレゼント', '懸賞', '商品券', 'その場であたり', 'フォロー＆リポスト',
    'チキニトラジオ', 'にとりめし', '実業団', '5000m', 'タイムレース', 'ガチャ',
    '似顔絵', 'パトロール', 'スポンサー', 'パチンコ', 'パチスロ', '台'
]

# 発行前日の取得ワークフロー（nitori-tiktok-fetch.yml）が書き出すスナップショット
TIKTOK_SNAPSHOT_PATH = brightdata_social.TIKTOK_SNAPSHOT_PATH


def fetch_yahoo_realtime_nitori_buzz(target_date=None):
    """Yahoo! リアルタイム検索（話題順 md=h）から昨日のニトリバズ投稿をスクレイピング"""
    if target_date is None:
        target_date = datetime.now(JST)

    url = "https://search.yahoo.co.jp/realtime/search?ei=UTF-8&p=%E3%83%8B%E3%83%88%E3%83%AA&md=h"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=12) as res:
            content = res.read().decode('utf-8')
    except Exception as e:
        print(f"[WARN] Yahoo Realtime 取得失敗: {e}", file=sys.stderr)
        return []

    tweet_regex = re.compile(
        r'<p class="Tweet_body__[^"]*">([\s\S]*?)<\/p>[\s\S]*?'
        r'<a class="Tweet_authorID__[^"]*"[^>]*>@<!-- -->([^<]*)<\/a>[\s\S]*?'
        r'<time class="Tweet_time__[^"]*"><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/time>',
        re.IGNORECASE
    )

    items = []
    yesterday_dt = target_date - timedelta(days=1)
    pub_ts = int(yesterday_dt.replace(hour=20, minute=0, second=0).timestamp())

    for m in tweet_regex.finditer(content):
        body_html = m.group(1)
        body_text = re.sub(r'<[^>]+>', '', body_html)
        body_text = html.unescape(body_text).strip()
        body_text = re.sub(r'\s+', ' ', body_text)

        author_id = m.group(2).strip()
        raw_url = m.group(3).split('?')[0]
        time_text = re.sub(r'<[^>]+>', '', m.group(4)).strip()

        chunk = content[m.start():m.start() + 2000]
        rt_m = re.search(r'retweet:(\d+)', chunk)
        like_m = re.search(r'like:(\d+)', chunk)
        rt = int(rt_m.group(1)) if rt_m else 0
        like = int(like_m.group(1)) if like_m else 0

        # 「昨日」判定（ユーザー要望：昨日になっているものを抽出）
        if '昨日' not in time_text:
            continue

        # スパム・無関係・個人イベント等の除外
        if any(k in body_text for k in YAHOO_REALTIME_SPAM_KEYWORDS):
            continue

        # ニトリへの言及
        if 'ニトリ' not in body_text and 'nitori' not in body_text.lower():
            continue

        short_title = body_text[:70] + "..." if len(body_text) > 75 else body_text

        items.append({
            'title': f"【Xで{like:,}いいね】{short_title}",
            'description': f"X（旧Twitter）で反響を呼んでいる生活者の投稿（{like:,}いいね、{rt:,}リポスト）：\n「{body_text}」",
            'source': f"X (@{author_id})",
            'link': raw_url,
            'pub_date': time_text,
            'pub_ts': pub_ts,
            'is_sns_raw': True,
            'platform': 'x',
            'author': f"@{author_id}",
            'likes': like,
            'retweets': rt,
            'raw_text': body_text
        })

    items.sort(key=lambda x: x['likes'], reverse=True)
    return items[:5]


def fetch_all_social_buzz(target_date=None):
    """SNSリアル反響セクション用の候補を全ソースから集める。

    X は Yahoo! リアルタイム検索で「昨日」の投稿を直接取得する。
    TikTok は発行前日の取得ワークフローが書き出したスナップショットを読む
    （API を直接叩かない）。TikTok 検索は日付で絞ると関連度が壊れるため「直近1週間の人気」
    を前夜時点で確定させる設計で、詳細は brightdata_social.py の docstring を参照。

    どのソースが落ちても X だけで発行できるよう、各ソースは独立して失敗を吸収する。
    """
    items = []

    try:
        items.extend(fetch_yahoo_realtime_nitori_buzz(target_date))
    except Exception as e:
        print(f"[WARN] X（Yahoo!リアルタイム）収集失敗: {type(e).__name__}: {e}", file=sys.stderr)

    try:
        tiktok_items = brightdata_social.load_snapshot(TIKTOK_SNAPSHOT_PATH, target_date)
        items.extend(tiktok_items)
    except Exception as e:
        print(f"[WARN] TikTok スナップショット処理失敗: {type(e).__name__}: {e}", file=sys.stderr)

    return items


def is_nitori_relevant(it, is_global=False):
    if it.get('is_sns_raw'):
        return True
    t = it.get('title', '').lower()
    d = it.get('description', '').lower()
    kws = GLOBAL_RELEVANT_KEYWORDS if is_global else NITORI_RELEVANT_KEYWORDS
    return any(k in t or k in d for k in kws)


def relevance_sort_key(it, is_gl=False):
    t = it['title'].lower()
    kws = GLOBAL_RELEVANT_KEYWORDS if is_gl else NITORI_RELEVANT_KEYWORDS
    has_title = 1 if any(k in t for k in kws) else 0
    return (has_title, it.get('pub_ts', 0))


def content_lane(art):
    """記事を Nitori Daily の3つの情報レーンへ分類する。"""
    category = str(art.get('category') or '')
    if category.startswith('SNS'):
        return 'consumer'
    if category in ('商品開発・ヒット商品', '店舗展開・海外戦略'):
        return 'product'
    return 'corporate'


def product_link(art):
    """商品を扱う記事にだけニトリ公式ECの検索リンクを組み立てる。

    出店・物流・経営の記事にEC検索結果を並べても行き先が噛み合わないため、
    レーンではなくカテゴリそのもので絞る（product レーンには出店記事も入る）。
    """
    if str(art.get('category') or '') != '商品開発・ヒット商品':
        return None
    # EC検索の語として成立しないタグ。これを避けて後続の商品名を拾う。
    generic = {
        'ニトリ', '商品開発', 'SNS反響', 'SNS拡散', 'リアル反響', '生活者UX',
        '価格戦略', 'PB', '口コミ', 'ヒット商品', '新商品', '生活提案', 'EC導線',
        'UX改善', '家事UX', '感情価値', '生活課題解決', 'コラボ', '低価格', 'ミドル層',
    }
    query = next(
        (str(tag).strip() for tag in (art.get('tags', []) or [])
         if str(tag).strip() and str(tag).strip() not in generic),
        '',
    )
    if not query:
        return None
    url = f"https://www.nitori-net.jp/ec/search/?q={urllib.parse.quote(query, safe='')}"
    return f'ニトリ公式で「{query}」を探す', url


KEYWORD_PATTERNS = [
    'ニトリホールディングス', 'ニトリHD', '株式会社ニトリ', 'ニトリ', 'デコホーム', '島忠', 'シマホ',
    'NITORI', 'N+', '似鳥昭雄', '似鳥', '白井俊之', '製造物流小売業', 'お、ねだん以上。', 'おねだん以上',
    'Nクール', 'Nウォーム', 'ホテルスタイルまくら', 'レストクッション', '毎日とりかえキッチンスポンジ',
    'ハコブNインボックス', 'ブレッザ', 'ビーズソファ', 'ポケットコイル', '電動リクライニングソファ',
    'ニトリ公式アプリ', 'サイズ計測', '手ぶらdeショッピング', '画像検索', 'ライブコマース', '自動倉庫',
    'ロボティクス', 'RFID', 'オートメーション', '物流センター', 'ホームロジスティクス', 'セルフレジ',
    'ECサイト', 'ニトリネット', 'オムニチャネル', '生活空間', 'プライスダウン', '円安対応'
]

CATEGORY_PILL_LABELS = {
    "商品開発・ヒット商品": "🛋️ 商品開発・ヒット商品",
    "デジタル・EC・アプリ": "📱 デジタル・アプリ・EC",
    "店舗展開・海外戦略": "🏬 店舗展開・海外戦略",
    "物流・サプライチェーン": "📦 物流・自動化倉庫",
    "経営・価格戦略・PB": "💼 経営・価格戦略・PB",
    "SNS話題・リアル反響": "💬 SNS話題・リアル反響",
    "グローバル先端トレンド": "🌐 グローバル先端トレンド",
}

# FAQ の本文と CONFIG の両方から参照する。二重管理にするとハンドルの変更時に片方が残る。
X_HANDLE = 'dailynitori'

FAQ_ITEMS = [
    {
        "q": "「Nitori Daily」とはどのようなメディアですか？",
        "a": "株式会社ニトリおよびニトリホールディングスグループ（デコホーム、島忠、N+等）の最新動向（新商品・バズアイテム、DX・公式アプリ、物流自動化・ホームロジスティクス、国内外の店舗出店、価格戦略など）を毎朝8:00（JST）に集約・解説する日刊ブリーフです。客観的な事実報道に加え、SPA（製造物流小売業）としての構造的強みや生活者UXへの示唆（Why it matters）をプロの視点で付与しています。"
    },
    {
        "q": "ニュースの更新頻度と配信時間はいつですか？",
        "a": "土日・祝日を含め、毎日朝8:00（日本時間・JST）に自動配信しています。前日に発表されたプレスリリース、業界専門紙・一般紙の報道、さらにX（旧Twitter）やTikTokで反響を呼んだ生活者のリアルな声を、毎朝の通勤時や始業前の3〜5分で効率よくキャッチアップできます。"
    },
    {
        "q": "ニュースやSNS話題の選定・分析はどのように行われていますか？",
        "a": "流通・小売の業界専門紙やIR速報に加え、X（旧Twitter）およびTikTok上の生活者による「買ってよかった神アイテム」「組み立てやすさ」「店舗体験」「価格への反響」といったリアルな声をクローリング。TikTokは前日投稿分を再生数順で収集しているため、短尺動画で実際の使用シーンが伸びている商品も拾えます。マルチAI（DeepSeek / OpenAI GPT）が「SPAとしての強み」「生活者UX・利便性への影響度」「事業インパクト」を多角的に分析して厳選しています。"
    },
    {
        "q": "最新ニュースの通知や購読はできますか？",
        "a": f"本ページでの閲覧に加え、<a href=\"rss.xml\">RSSフィード (rss.xml)</a> による購読が可能です。SlackやTeams、DiscordのRSS連携アプリに登録することで、社内チャットへの毎朝の自動配信も容易に行えます。公式Xアカウント <a href=\"https://x.com/{X_HANDLE}\" target=\"_blank\" rel=\"noopener noreferrer\">@{X_HANDLE}</a> もあわせてご利用ください。"
    },
    {
        "q": "社内チャット（Slack/Teams）やSNSへの引用・共有は可能ですか？",
        "a": "はい、ご自由に共有いただけます。各ニュースカードの「📋 コピー」ボタンを押すと、見出し・要点・リンクをまとめた社内ツール貼り付け用のテキストがクリップボードにコピーされます。隣の「共有」ボタンは、対応環境では端末の共有メニューを開き、非対応の環境では同じテキストをコピーします。"
    },
    {
        "q": "気になるテーマだけを追いかけることはできますか？",
        "a": "はい。各記事のタグ横にある ☆ を押すと、そのテーマをウォッチできます。ウォッチ中のテーマは、日刊記事ページでは「★ ウォッチ中」フィルタで該当記事だけに絞り込め、ポータルの「ウォッチ中のテーマ」欄では該当する最新記事が一覧表示され、前回チェック以降に公開された記事には NEW が付きます。解除はポータルの一覧にある × か、記事タグの ★ をもう一度押してください。なおウォッチの設定はご利用のブラウザ内にのみ保存されるため、他の端末には引き継がれません。メールやプッシュによる通知は行っていません。"
    }
]

BRAND_LOGO_SVG = """<svg viewBox="0 0 64 64" width="34" height="34" style="flex-shrink:0; border-radius:7px; box-shadow:0 1px 3px rgba(15,23,42,0.12);">
  <defs>
    <linearGradient id="headerNitoriBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#006b66" />
      <stop offset="55%" stop-color="#009e96" />
      <stop offset="100%" stop-color="#14b8a6" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="7" fill="url(#headerNitoriBg)" />
  <rect x="1" y="1" width="62" height="62" rx="6" fill="none" stroke="rgba(255, 255, 255, 0.25)" stroke-width="1.2" />
  <path d="M13 26 L32 13 L51 26" fill="none" stroke="#ffffff" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M21 48 V27 L43 48 V27" fill="none" stroke="#ffffff" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
</svg>"""


def fallback_rule_based(candidates, yesterday_str):
    sns_news_count = 0

    def classify(item):
        nonlocal sns_news_count
        title = item['title']
        if any(k in title for k in ['アプリ', 'DX', 'EC', 'ネット', '自動', 'ロボット', '物流', 'RFID', '手ぶら', '計測', 'AI']):
            return "デジタル・EC・アプリ", "自社物流（ホームロジスティクス）の自動化と公式アプリの顧客接点強化により、購入から配送・設置までのオムニチャネル体験の最適化が進んでいます。", ["ニトリDX", "物流自動化", "アプリ"]
        if any(k in title for k in ['出店', 'オープン', '店舗', '海外', 'アジア', '葛西', '島忠', 'N＋', 'デコホーム', '進出']):
            return "店舗展開・海外戦略", "新業態『N＋』やデコホームの展開、島忠店舗への複合出店など、ドミナント戦略と生活動線への浸透により、顧客層の裾野拡大が進んでいます。", ["店舗展開", "新業態", "島忠"]
        if any(k in title for k in ['値下げ', 'プライスダウン', '価格', '決算', '似鳥', '社長', '円安', '業績', '戦略']):
            return "経営・価格戦略・PB", "原材料高や為替変動に対し、自社完結のサプライチェーンと徹底的な効率化を武器に、生活防衛意識に応える機動的な価格戦略を展開しています。", ["価格戦略", "SPA", "経営"]
        if sns_news_count < 1 and any(k in title for k in ['Xで話題', 'SNS', '物議', '賛否', 'バズ', '反響', '神アイテム', '悩み', 'ストレス', '満タン', '余裕']):
            sns_news_count += 1
            return "SNS話題・リアル反響", "生活者の実際の使用感や日常の『プチストレス解消』体験がSNSで自然拡散されることで、ブランドへの信頼感向上と店舗・EC双方の来店動機形成に直結しています。", ["生活者UX", "バズ商品", "生活提案"]
        return "商品開発・ヒット商品", "生活空間の困りごとを解決する独自視点の商品開発と、SPA（製造物流小売業）としての高いコストパフォーマンスにより『お、ねだん以上』の価値が体現されています。", ["商品開発", "生活提案", "PB"]

    return build_rule_based_fallback(
        candidates, yesterday_str, classify,
        jp_limit=6,
        global_limit=3,
        jp_summary_fallback="{source}による株式会社ニトリに関する最新報道です。",
        global_summary_fallback="Global movement related to Nitori reported by {source}.",
        global_why_it_matters="海外進出（アジア・東南アジア）の拡大に伴い、現地での知名度獲得とグローバルサプライチェーンの最適化が今後の成長エンジンとなります。",
        global_tags=["海外展開", "グローバル", "アジア戦略"],
        executive_summary=[
            "{yesterday}は、ニトリグループの新商品展開や国内外の事業進展に関する最新ニュースが注目されました。",
            "オムニチャネル推進や物流自動化、店舗オペレーションの進化による顧客体験の向上が続いています。",
            "アジアをはじめとする海外展開や新業態の拡大が着実に進展しています。",
        ],
    )


CONFIG = {
    'media_id': 'nitoridaily',
    'media_name': 'Nitori Daily',
    'x_handle': X_HANDLE,
    'brand_title': 'Nitori Daily',
    'brand_title_short': 'ニトリニュース＆SNS話題',
    'brand_subtitle': '毎朝8時のニトリ速報＆SNS話題',
    'brand_desc': '毎朝8:00更新。昨日のニトリ・ニトリHD動向およびX・TikTok上の話題・反響（ヒット商品、使い勝手、店舗体験、物流DX、SPA戦略）をマルチAI（DeepSeek / GPT）が要約・示唆付きで配信する日刊ニュースメディア。',
    'hero_desc': 'ニトリの最新動向とSNS（X・TikTok）の反響を、毎朝8時にお届け。ヒット商品から生活者UX、店舗・SPA物流DXの最前線まで、AIの解説付きで配信します。',
    'portal_hero_desc': 'ニトリの最新動向とSNS（X・TikTok）の反響を、毎朝8時にお届け。<br>ヒット商品から生活者UX、店舗・SPA物流DXの最前線まで、AIの解説付きで配信します。',
    'portal_seo_title': '日刊ニトリ／速報ニュース・SNSの話題まとめ | Nitori Daily',
    'portal_seo_desc': 'ニトリの最新動向とSNS（X・TikTok）の反響を、毎朝8時にお届け。ヒット商品から生活者UX、店舗・SPA物流DXの最前線まで、AIの解説付きで配信します。',
    'css_file': 'nitori-daily.css',
    'favicon_file': 'nitori-favicon.svg',
    'ogp_target': 'nitori',
    'portal_ogp_image': 'https://tk.st/images/ogp/nitori-ogp.webp',
    'theme_color': '#009e96',
    'share_prefix': '【ニトリ日刊速報】',
    'user_agent': 'NitoriDailyBrief/3.0',
    'data_json_path': os.path.join(REPO_ROOT, 'data', 'nitori-daily.json'),
    'job_dir': os.path.join(REPO_ROOT, 'job', 'nitoridaily'),

    'jp_query_gen': JP_GENERAL_QUERY,
    'jp_query_ind': JP_INDUSTRY_QUERY,
    'jp_query_sns': JP_SNS_QUERY,
    'global_query_gen': GLOBAL_GENERAL_QUERY,
    'global_query_ind': GLOBAL_INDUSTRY_QUERY,
    'global_query_sns': GLOBAL_SNS_QUERY,

    'jp_noise_blacklist': JP_NOISE_BLACKLIST,
    'global_noise_blacklist': GLOBAL_NOISE_BLACKLIST,
    'extra_candidates_fn': fetch_all_social_buzz,
    'extra_candidate_limits': {'tiktok': brightdata_social.TOP_N_PER_PLATFORM},
    'is_relevant_fn': is_nitori_relevant,
    'relevance_sort_key_fn': relevance_sort_key,
    'content_lane_fn': content_lane,
    'content_lanes': (
        ('corporate', '企業・経営'),
        ('product', '商品・店舗'),
        ('consumer', '生活者SNS'),
    ),
    'product_link_fn': product_link,
    'dedupe_featured_sns': True,
    'show_social_metrics': True,
    'consumer_only_status_label': '本日の企業・経営ニュースはありません',
    'keyword_regex': build_keyword_regex(KEYWORD_PATTERNS),

    'editor_title': '流通・SPAアナリスト兼インテリア・小売マーケター（「Nitori Daily Brief」編集長）',
    'prompt_selection_rules': """1. ニトリグループに無関係な他社の単独ニュースやスパム懸賞は完全に除外してください。
2. 直近掲載済みのトピックと重複する内容は必ず除外し、昨日新しく発表・報道された最新動向を最優先してください。
3. 国内ニュースから最も重要なもの4〜6件、海外・グローバル関連から2〜4件を厳選してください（計7〜10件）。ただし候補は事前に直近数日分の日付範囲で絞り込み済みです。海外ニュース候補の件数がこれに満たない場合は、無理に古い・関連度の低い候補で件数を埋めず、実際に選定条件を満たす件数のみを採用してください（0件でも構いません）。
   選定の際は「SPA（製造物流小売業）としての構造的強み」「ヒット商品・新商品開発」「物流・自動化・DXの進化」「店舗展開・海外進出の成果」「価格戦略・為替対応」を最重視してください。
4. 候補の中に『【Xで〜いいね】』『【TikTokで〜回再生】』と記載されたSNS生バズ投稿（X はYahoo! リアルタイム検索、TikTok は前日投稿の再生数上位）がある場合は、生活者の共感・反響や生活空間提案へのインサイトが大きいものを必ず1〜2件選定し、カテゴリ『SNS話題・リアル反響』として採用してください。単なる投稿の転載ではなく、「なぜその使い方やアイテムが反響を呼んでいるのか」「生活者UXや商品力にどんな示唆があるか（Why it matters）」をプロの視点で分析・要約してください。記事URLには参照元となった投稿のURL（https://x.com/... または https://www.tiktok.com/...）を設定してください。""",
    'prompt_categories': '「商品開発・ヒット商品」「デジタル・EC・アプリ」「店舗展開・海外戦略」「物流・サプライチェーン」「経営・価格戦略・PB」「SNS話題・リアル反響」「グローバル先端トレンド」',
    'sample_category': '商品開発・ヒット商品',
    'sample_tags': ["ニトリ", "商品開発"],

    'category_pill_labels': CATEGORY_PILL_LABELS,
    'faq_items': FAQ_ITEMS,
    'brand_logo_svg': BRAND_LOGO_SVG,
    'fallback_fn': fallback_rule_based,

    'periodical_alternates': ["ニトリ日刊速報", "ニトリデイリー", "Nitori Daily"],
    'periodical_about': [
        { "@type": "Thing", "name": "ニトリ" },
        { "@type": "Thing", "name": "ニトリホールディングス" },
        { "@type": "Thing", "name": "製造物流小売業(SPA)" },
        { "@type": "Thing", "name": "商品開発・ヒット商品" },
        { "@type": "Thing", "name": "生活者UX・SNS話題（X / TikTok）" },
        { "@type": "Thing", "name": "デジタル・アプリ・EC" },
        { "@type": "Thing", "name": "物流自動化・ホームロジスティクス" },
        { "@type": "Thing", "name": "店舗展開・グローバル戦略" }
    ],
    'person_knows_about': [
        "ニトリ・SPAビジネスモデル",
        "家具・インテリア・ホームファッション",
        "生活者インサイト・SNS反響分析（X / TikTok）",
        "リテールDX・公式アプリ・EC",
        "自動化物流・サプライチェーン",
        "UI/UXエンジニアリング"
    ]
}

if __name__ == '__main__':
    run_daily_pipeline(CONFIG)
