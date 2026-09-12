#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Retail Tech Daily Brief — 毎朝8時のリテールテック・流通DX日刊速報

共通エンジン `daily_engine.py` を利用した設定駆動型エントリーポイント。
"""

import os
import re
from daily_engine import build_keyword_regex, run_daily_pipeline

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))

# 収集クエリ定義
JP_GENERAL_QUERY = '(リテールテック OR 流通DX OR リテールメディア OR スマートカート OR セルフレジ OR "無人店舗" OR "無人決済" OR "ウォークスルー決済" OR "電子棚札" OR "ESL" OR "需要予測" OR "AI発注" OR "自動発注" OR "ダイナミックプライシング" OR "店舗DX") -レシピ -セール -スイーツ'
JP_INDUSTRY_QUERY = '(site:ryutsuu.biz OR site:diamond-rm.net OR site:dcs.diamond.co.jp) ("DX" OR "テック" OR "レジ" OR "カート" OR "メディア" OR "AI" OR "実証" OR "RFID" OR "省人化" OR "無人" OR "棚札")'
JP_SNS_QUERY = '((site:x.com OR site:twitter.com) ("セルフレジ" OR "スマートカート" OR "レジゴー" OR "無人レジ" OR "リテール" OR "スーパー" OR "コンビニ")) OR (("Xで話題" OR "SNSで話題" OR "賛否" OR "物議" OR "バズ" OR "反響") ("セルフレジ" OR "スマートカート" OR "無人レジ" OR "ダイナミックプライシング" OR "スーパー" OR "コンビニ" OR "値上げ" OR "タッチパネル"))'

GLOBAL_GENERAL_QUERY = '("retail tech" OR "retail technology" OR "retail media" OR "smart cart" OR "smart trolley" OR "cashierless" OR "frictionless checkout" OR "electronic shelf label" OR "retail AI" OR "grocery tech" OR "autonomous checkout")'
GLOBAL_INDUSTRY_QUERY = '(site:retaildive.com OR site:grocerydive.com OR site:modernretail.co) ("AI" OR "tech" OR "media" OR "checkout" OR "cart" OR "automation" OR "store")'
GLOBAL_SNS_QUERY = '((site:x.com OR site:twitter.com) ("self-checkout" OR "smart cart" OR "cashierless" OR "grocery" OR "supermarket")) OR (("viral on X" OR "trending on X" OR "customers complain" OR "backlash") ("self-checkout" OR "smart cart" OR "cashierless" OR "retail tech"))'

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

KEYWORD_PATTERNS = [
    'ファミリーマート', 'ファミマ', 'セブン-イレブン', 'セブン＆アイ', 'セブン', 'ローソン',
    'イトーヨーカ堂', 'イオン', 'トライアル', 'ベイシア', 'ライフ', 'ヤオコー',
    'Google', 'Amazon', 'Walmart', 'ウォルマート', 'アスタリスク', 'アドインテ', 'TOUCH TO GO', 'TTG',
    'POSレジ', '完全セルフレジ', 'セルフレジ', 'ハイブリッド型レジ', '切り替え式', 'スマートカート',
    'ウォークスルー決済', '無人決済', '電子棚札', 'ESL', '需要予測AI', '需要予測', 'AI自動発注', '自動発注',
    'ダイナミックプライシング', 'リテールメディア', '店頭サイネージ', 'デジタルサイネージ', 'RFID', '生成AI',
    'Universal Cart', '客層分断', '省人化', 'オムニチャネル', '無人店舗', 'フリクションレス'
]

CATEGORY_PILL_LABELS = {
    "スマートカート": "🛒 スマートカート",
    "リテールメディア・広告": "📺 リテールメディア・広告",
    "サプライチェーン・店舗自動化": "📦 物流・需要予測・RFID",
    "店舗DX・次世代決済": "💳 店舗DX・次世代決済",
    "流通DX一般": "🏢 流通DX一般",
    "SNS話題・生活者のリアル": "💬 SNS話題・生活者のリアル",
    "グローバル先端トレンド": "🌐 グローバル先端トレンド",
}

FAQ_ITEMS = [
    {
        "q": "「Retail Tech Daily Brief」とはどのようなメディアですか？",
        "a": "スマートカート、無人店舗・ウォークスルー決済、リテールメディア、電子棚札、RFID、需要予測AIなど、国内外のリテールテック・流通DXの最前線を毎朝8:00（JST）に集約・解説する日刊ブリーフです。客観的な事実報道に加え、現場のオペレーションや生活者の購買UX、ビジネス構造に与える示唆（Why it matters）をプロの視点で付与しています。"
    },
    {
        "q": "ニュースの更新頻度と配信時間はいつですか？",
        "a": "土日・祝日を含め、毎日朝8:00（日本時間・JST）に自動配信しています。前日に発表された国内外のプレスリリースや業界専門紙の一次報道を、毎朝の通勤時や始業前の3〜5分で効率よくキャッチアップできます。"
    },
    {
        "q": "記事の選定・要約はどのように行われていますか？",
        "a": "国内外の流通専門メディア、IR速報、テック系ニュースサイトから記事候補を自動収集。マルチAI（DeepSeek / OpenAI GPT）が重複排除とノイズ除去を行い、「事業インパクト」「UXへの影響度」「日本市場への示唆」を多角的に分析して厳選・要約しています。"
    },
    {
        "q": "最新ニュースの通知や購読はできますか？",
        "a": "本ページでの閲覧に加え、<a href=\"rss.xml\">RSSフィード (rss.xml)</a> による購読が可能です。SlackやTeamsのRSS連携アプリに登録することで、社内チャットへの毎朝の自動配信も容易に行えます。"
    },
    {
        "q": "社内チャット（Slack/Teams）への引用・共有は可能ですか？",
        "a": "はい、ご自由に共有いただけます。各日刊記事の個別ニュースカードに設置されている「📋 社内共有コピー」ボタンをクリックすると、社内ツール貼り付け用に最適化された要約テキストが一発でクリップボードにコピーされます。"
    }
]

BRAND_LOGO_SVG = """<svg viewBox="0 0 64 64" width="34" height="34" style="flex-shrink:0; border-radius:7px; box-shadow:0 1px 3px rgba(15,23,42,0.12);">
  <defs>
    <linearGradient id="headerCartBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b192e" />
      <stop offset="60%" stop-color="#0f4c81" />
      <stop offset="100%" stop-color="#1e293b" />
    </linearGradient>
    <linearGradient id="headerCartSignal" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#818cf8" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="7" fill="url(#headerCartBg)" />
  <rect x="1" y="1" width="62" height="62" rx="6" fill="none" stroke="rgba(255, 255, 255, 0.15)" stroke-width="1.2" />
  <path d="M12 26 h5 l5 16 h17 l4 -11 h-23" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" />
  <circle cx="24" cy="47" r="3" fill="#ffffff" />
  <circle cx="38" cy="47" r="3" fill="#ffffff" />
  <circle cx="40" cy="26" r="2.2" fill="url(#headerCartSignal)" />
  <path d="M 41.8 19.2 A 7 7 0 0 1 46.8 24.2" fill="none" stroke="url(#headerCartSignal)" stroke-width="2.8" stroke-linecap="round" />
  <path d="M 43.1 14.4 A 12 12 0 0 1 51.6 22.9" fill="none" stroke="url(#headerCartSignal)" stroke-width="2.8" stroke-linecap="round" />
</svg>"""


def fallback_rule_based(candidates, yesterday_str):
    articles = []
    for it in candidates['JP']:
        t = it['title']
        is_sns = any(k in t for k in ['Xで話題', 'SNS', '物議', '賛否', 'バズ', 'Twitter', 'x.com', '反響', '不満', '使い勝手'])

        if is_sns:
            cat = "SNS話題・生活者のリアル"
            wim = "店舗オペレーションの省人化・自動化が進む一方で、操作性や現金対応など生活者側の受容性・UXギャップへの配慮が不可欠となっています。"
            tags = ["SNS話題", "店舗UX"]
        elif any(k in t for k in ['リテールメディア', 'サイネージ', '広告', 'アドインテ']):
            cat = "リテールメディア・広告"
            wim = "実店舗の購買データと店頭接点をメディア化し、新たな収益源と顧客エンゲージメントを同時に創出する動きが本格化しています。"
            tags = ["リテールメディア", "サイネージ", "広告収益"]
        elif any(k in t for k in ['RFID', 'ロボット', '物流', '自動発注', '需要予測', '自動倉庫', '棚札', 'ESL']):
            cat = "サプライチェーン・店舗自動化"
            wim = "RFIDやAI需要予測による在庫精度向上と自動発注が、欠品防止と現場スタッフの業務負荷軽減を両立させています。"
            tags = ["RFID", "需要予測AI", "自動発注"]
        elif any(k in t for k in ['スマートカート', 'カート']):
            cat = "スマートカート"
            wim = "レジ待ち時間をゼロにするだけでなく、スキャン時のクーポン提示やレコメンドによる客単価向上が実証されています。"
            tags = ["スマートカート", "店内UX", "レジレス"]
        elif any(k in t for k in ['レジ', '決済', '無人', '省人化', 'セルフレジ', 'ウォークスルー']):
            cat = "店舗DX・次世代決済"
            wim = "人手不足解消と購買体験価値向上の両立において、現場オペレーションの省人化とDX推進が急務となっています。"
            tags = ["店舗DX", "決済", "セルフレジ"]
        else:
            cat = "流通DX一般"
            wim = "テクノロジーの活用による顧客体験の再定義と、データドリブンな店舗運営への移行が流通各社で加速しています。"
            tags = ["流通DX", "オムニチャネル"]

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


CONFIG = {
    'media_id': 'retailtechdaily',
    'media_name': 'Retail Tech Daily Brief',
    'brand_title': 'Retail Tech Daily',
    'brand_title_short': 'リテールテック＆流通DX',
    'brand_subtitle': '毎朝8時の流通DX・リテールテック日刊速報',
    'brand_desc': '毎朝8:00更新。昨日の国内外リテールテック・流通DX動向（スマートカート、無人決済、リテールメディア、RFIDロボティクス、AI需要予測）をマルチAI（DeepSeek / GPT）が要約・示唆付きで配信する日刊速報。',
    'hero_desc': '昨日の国内外のリテールテック・流通DX動向。スマートカート・リテールメディア・RFIDロボティクス等の先端事例をプロ視点の示唆付きでお届けします。',
    'portal_hero_desc': '昨日の国内外のリテールテック・流通DX動向を毎朝8時に集約。<br>AI・スマートカート・リテールメディア・RFIDの先端動向をプロのインサイト付きでお届けします。',
    'css_file': 'retail-tech-daily.css',
    'favicon_file': 'retail-tech-favicon.svg',
    'ogp_target': 'retail-tech',
    'portal_ogp_image': 'https://tk.st/images/ogp/retail-tech-ogp.webp',
    'theme_color': '#0f4c81',
    'share_prefix': '【流通DX日刊速報】',
    'user_agent': 'RetailTechDailyBrief/3.0',
    'data_json_path': os.path.join(REPO_ROOT, 'data', 'retail-tech-daily.json'),
    'job_dir': os.path.join(REPO_ROOT, 'job', 'retailtechdaily'),

    'jp_query_gen': JP_GENERAL_QUERY,
    'jp_query_ind': JP_INDUSTRY_QUERY,
    'jp_query_sns': JP_SNS_QUERY,
    'global_query_gen': GLOBAL_GENERAL_QUERY,
    'global_query_ind': GLOBAL_INDUSTRY_QUERY,
    'global_query_sns': GLOBAL_SNS_QUERY,

    'jp_noise_blacklist': JP_NOISE_BLACKLIST,
    'global_noise_blacklist': GLOBAL_NOISE_BLACKLIST,
    'keyword_regex': build_keyword_regex(KEYWORD_PATTERNS),

    'editor_title': '流通・リテールテック専門アナリスト（「Retail Tech Daily Brief」編集長）',
    'prompt_selection_rules': """1. リテールテック・流通DX・店舗イノベーションに無関係な記事は完全に除外してください。
2. 直近掲載済みのトピックと重複する内容は必ず除外し、昨日新しく発表・報道された最新動向を最優先してください。
3. 国内ニュースから最も重要なもの4〜6件、海外・グローバル関連から2〜4件を厳選してください（計7〜10件）。
   選定の際は「スマートカート」「無人店舗・決済」「リテールメディア」「RFID・ロボティクス」「AI需要予測」「電子棚札」を最重視してください。
   また、SNSで生活者・買い物客の間で賛否や反響を呼んでいるリアルトピック（セルフレジの使い勝手、値上げへの反応など）があれば1〜2件積極的に選定してください。""",
    'prompt_categories': '「スマートカート」「リテールメディア・広告」「サプライチェーン・店舗自動化」「店舗DX・次世代決済」「流通DX一般」「SNS話題・生活者のリアル」「グローバル先端トレンド」',
    'sample_category': 'スマートカート',
    'sample_tags': ["スマートカート", "店内UX"],

    'category_pill_labels': CATEGORY_PILL_LABELS,
    'faq_items': FAQ_ITEMS,
    'brand_logo_svg': BRAND_LOGO_SVG,
    'fallback_fn': fallback_rule_based,

    'periodical_alternates': ["リテールテック日刊速報", "流通DXデイリー", "Retail Tech Daily"],
    'periodical_about': [
        { "@type": "Thing", "name": "リテールテック" },
        { "@type": "Thing", "name": "流通DX" },
        { "@type": "Thing", "name": "スマートカート" },
        { "@type": "Thing", "name": "リテールメディア" },
        { "@type": "Thing", "name": "RFID" },
        { "@type": "Thing", "name": "無人店舗・決済" },
        { "@type": "Thing", "name": "需要予測AI" },
        { "@type": "Thing", "name": "店舗オペレーション自動化" }
    ],
    'person_knows_about': [
        "リテールテック",
        "流通DX",
        "ECテクノロジー",
        "スマートカート",
        "リテールメディア",
        "UI/UXエンジニアリング"
    ]
}

if __name__ == '__main__':
    run_daily_pipeline(CONFIG)
