"""日刊②の検索用の語。LLMが返さない場合と過去分の一度だけの補完で使う。

評価の検索語・正解IDは読まない。題名・要約で確認できる概念の翻訳と類義語だけを足す。
Jevの判定や日刊①の検索には、この語を渡さない。
"""
import re
import unicodedata

# 題名の一致を優先し、一般的な「AI」「店舗」より具体的な概念を先に置く。
# (表記の候補, 英語, 日本語の言い換え)
CONCEPTS = [
    ('静かな退職', 'disengaged employees', '社員の意欲低下'),
    ('請求書|経理', 'invoice processing', '会計業務'),
    ('宅配ボックス', 'receive parcels', '留守中の荷物受け取り'),
    ('電気工事士', 'electrician practical exam', '電気資格の講習'),
    ('電子棚札', 'electronic shelf labels', '売場の価格表示'),
    ('買い物支援|買い物弱者', 'rural shopping support', '地域の買い物の手助け'),
    ('デジタル売上', 'digital sales', 'ネット経由の売上'),
    ('在庫補充|自動補充', 'stock replenishment', '品切れを防ぐ補充'),
    ('需要予測', 'demand forecasts', '売れ行きの見通し'),
    ('オラクル|Oracle', 'Oracle cloud', 'クラウド基盤の刷新'),
    ('メイシーズ', "Macy's department store", '百貨店の業務'),
    ('恵那', 'Ena municipality', '恵那市との連携'),
    ('コストコ', 'Costco', '会員制の倉庫型小売'),
    ('タイ国内|リテールタイ', 'Thai offices', 'タイの拠点'),
    ('ウォルマート', 'Walmart', '米国の大手小売'),
    ('シンガポール', 'Singapore', '東南アジアでの展開'),
    ('インスタカート|Instacart', 'Instacart', 'ネットスーパー'),
    ('ハープス|Harps', 'Harps grocery chain', '地方の食品スーパー'),
    ('ハローキティ', 'Hello Kitty', 'サンリオのキャラクター'),
    ('スヌーピー', 'Snoopy', 'キャラクターの雑貨'),
    ('ティックトック|TikTok', 'TikTok', '短い動画での商品発見'),
    ('メタ|Meta', 'Meta', '大手IT企業'),
    ('アマゾン|Amazon', 'Amazon', 'EC企業'),
    ('ジェミニ|Gemini', 'Gemini', 'AI検索サービス'),
    ('コーチ|Coach', 'Coach', '服飾ブランド'),
    ('ジュロン|Jurong', 'Jurong Point', 'シンガポールの商業施設'),
    ('倉庫|物流施設', 'warehouse logistics', '商品の保管と配送'),
    ('リサイクル|再資源化', 'recycling', '資源の循環利用'),
    ('再配達', 'redelivery', '配達のやり直し'),
    ('顔認証', 'facial recognition', '顔で本人を確認'),
    ('RFID', 'RFID inventory tracking', '無線タグでの商品管理'),
    ('無人|省人', 'unattended stores', '人手を減らす売場'),
    ('タッチ決済', 'contactless payment', 'かざして支払い'),
    ('POS|レジ', 'checkout systems', '会計の効率化'),
    ('リテールメディア', 'retail media advertising', '小売の広告事業'),
    ('広告|販促', 'advertising promotions', '商品を知ってもらう施策'),
    ('共同配送', 'shared deliveries', '他社と荷物をまとめて運ぶ'),
    ('忘れ物|落とし物', 'lost and found', '紛失物の照会'),
    ('価格|値上げ', 'pricing', '販売価格の見直し'),
    ('プライバシー|個人情報', 'personal data privacy', '個人のデータの保護'),
    ('GLP-1|肥満治療薬', 'appetite medication', '食欲の変化と食品消費'),
    ('ロボット|ロボティクス', 'robots automation', '機械による作業'),
    ('在庫|欠品', 'inventory management', '商品の過不足を減らす'),
    ('売上|販売実績', 'sales performance', '販売の伸び'),
    ('ネット通販|EC|オンライン', 'online shopping', 'ネットで買い物'),
    ('アプリ', 'mobile apps', 'スマホで使うサービス'),
    ('配送|配達', 'delivery', '商品を届ける'),
    ('商業施設|ショッピングモール', 'shopping malls', '店舗が集まる施設'),
    ('出店|開店|新店舗', 'store openings', '新しい売場の展開'),
    ('店舗網|店舗数', 'store expansion', '小売の拠点を増やす'),
    ('採用|人材|人事', 'staff recruitment', '働く人の確保'),
    ('接客|顧客対応', 'customer service', '来店客の応対'),
    ('止水板|浸水', 'flood prevention', '浸水への備え'),
    ('防災', 'disaster preparedness', '災害への備え'),
    ('セキュリティ|警備', 'store security', '売場の安全管理'),
    ('駐車場', 'parking', '車での来店'),
    ('食品ロス|売れ残り', 'food waste reduction', '廃棄を減らす'),
    ('トレーサビリティ', 'supply chain traceability', '商品の流れを追う'),
    ('省エネ|節電', 'energy savings', '電力消費を減らす'),
    ('ソファ', 'sofas', 'くつろぐ家具'),
    ('ベッド|マットレス', 'beds mattresses', '寝るための家具'),
    ('チェア|椅子', 'chairs seating', '座るための家具'),
    ('収納|片付け', 'storage organization', '整理整頓'),
    ('キッチン|調理', 'kitchen cooking', '台所での家事'),
    ('米びつ', 'rice storage', 'お米の保管'),
    ('ゴミ箱', 'waste bins', 'ごみの片付け'),
    ('防臭|消臭', 'odor control', 'におい対策'),
    ('ドライヤー', 'hair dryers', '髪を乾かす'),
    ('掃除|清掃', 'cleaning', '住まいをきれいにする'),
    ('洗濯|ランドリー', 'laundry', '衣類の手入れ'),
    ('浴室|お風呂|バス用品', 'bathroom accessories', '入浴の道具'),
    ('旅行|トラベル', 'travel accessories', '出先で使う道具'),
    ('ペット|猫|犬', 'pets', '動物と暮らす'),
    ('撥水|防汚', 'water stain resistance', '汚れを防ぐ'),
    ('アウトドア', 'outdoor equipment', '屋外で使う道具'),
    ('家電', 'home appliances', '暮らしの電気製品'),
    ('コスメ|化粧品|保湿', 'skin care cosmetics', '肌の手入れ'),
    ('寝具|布団|毛布', 'bedding', '眠るときの道具'),
    ('衣料|アパレル|N+', 'clothing apparel', '日常に着る服'),
    ('照明|ライト', 'lighting', '部屋の明かり'),
    ('カーテン', 'curtains', '窓まわりの用品'),
    ('ポイント|会員', 'membership rewards', '会員向けの特典'),
    ('AI|人工知能|生成AI', 'artificial intelligence', '人工知能の活用'),
]


def valid_search_terms(value):
    return (isinstance(value, list) and 3 <= len(value) <= 5
            and all(isinstance(t, str) and t.replace('\ufeff', '').strip() and len(t) <= 60
                    and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in t) for t in value)
            and len(set(value)) == len(value))


def fallback_search_terms(article):
    """本文の概念を優先し、英語3語＋日本語2語まで。評価の問いには依存しない。"""
    normalize = lambda s: unicodedata.normalize('NFKC', s).casefold()
    title = normalize(article.get('title', '') or '')
    summary = normalize(article.get('summary', '') or '')
    title_hits, summary_hits = [], []
    def matches(text, key):
        # AIをretailやchairの途中、ECをelectronicの途中に当てない。
        if key.isascii():
            return re.search(r'(?<![a-z0-9])' + re.escape(key) + r'(?![a-z0-9])', text) is not None
        return key in text
    for patterns, english, japanese in CONCEPTS:
        keys = [normalize(p) for p in patterns.split('|')]
        if any(matches(title, p) for p in keys):
            title_hits.append((english, japanese))
        elif any(matches(summary, p) for p in keys):
            summary_hits.append((english, japanese))
    found = title_hits + summary_hits
    terms = [english for english, _ in found[:3]] + [japanese for _, japanese in found[:2]]
    # 未知の題材は事実を補わず、元のタグ・カテゴリー・題名を短い語として使う。
    for term in [*(article.get('tags', []) or []), article.get('category', ''), article.get('title', ''), 'ニュース記事', '日刊ブリーフ', '記事の要約']:
        if len(terms) >= 3:
            break
        if isinstance(term, str):
            term = ''.join(c for c in term if not (ord(c) < 32 or 127 <= ord(c) <= 159)).replace('\ufeff', '').strip()[:60]
            if term and term not in terms:
                terms.append(term)
    return list(dict.fromkeys(terms))


def prepare_search_terms(result):
    """号の既存LLM呼び出しを増やさず、欠けた/不正な語だけ規則で補う。"""
    for article in result.get('articles', []) or []:
        if not valid_search_terms(article.get('search_terms')):
            article['search_terms'] = fallback_search_terms(article)
    return result
