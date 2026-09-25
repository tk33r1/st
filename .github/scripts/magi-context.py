#!/usr/bin/env python3
"""MAGI（workers/magi2）の3人格に渡す「人格カード」を、サイトの本文から生成する。

人格の骨格（一人称・口調・文字数）は workers/magi2/personas.js に固定で持ち、
ここで作るのは「いま大切にしている考え・関心・経験」の部分だけ。ページを書き換えると
人格もそれに追従する、というのが狙い。

流れ:
  1. 抽出: 各ページの `data-magi="<人格キー>"` を付けた要素のテキストと、一覧 JSON
     （tools.json 等）を人格ごとに集める。素材は意図して目印を付けたものだけに絞る
     （JSON-LD は本文の言い換えばかりで、SEO の都合で直すたびに作り直しが走るので使わない）。
     class や id には依存しないので、デザインを改修しても目印さえ残せば壊れない。
     目印の内側で読ませたくない部分には `data-magi-skip` を付ける。
  2. 差分判定: 素材＋要約プロンプトのハッシュを前回と比べ、変わった人格だけを次へ。
     sitemap の bot が dateModified を書き換えただけ、CSS を直しただけ、では LLM は
     呼ばれない。
  3. 要約: 変わった人格だけ、素材からゼロで人格カードを作る。前回のカードは渡さない
     （渡すと前回の誤りや消した内容が残りやすい。言い回しが多少変わるのは許容する）。
  4. 検査して data/magi-context.json に書く。どこかで失敗したら何も書かずに exit 1。
     Worker は前回のカードで動き続ける。

ローカル確認: `python .github/scripts/magi-context.py --dry-run` で抽出結果と
「どの人格が再生成対象か」だけを表示する（API キー不要）。
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_PATH = os.path.join(ROOT, 'data', 'magi-context.json')
JST = timezone(timedelta(hours=9))

ENDPOINT = 'https://api.openai.com/v1/chat/completions'
MODEL = os.environ.get('OPENAI_MODEL', '').strip() or 'gpt-5.6-luna'

# 人格カードの長さ。プロンプトでは CARD_TARGET を指示し、検査は少し緩めに取る。
CARD_TARGET = 800
CARD_MIN, CARD_MAX = 80, 1400
# 1人格ぶんの素材の上限。目印の付け過ぎで要約コストが膨らむのを止める安全弁。
SOURCE_MAX = 20000

# 人格ごとの素材。キーはページ側の data-magi の値、codename は Worker 側の PERSONAS と一致させる。
# 素材の一覧はここだけが正。workflow は push のたびに起動し、変わったかどうかはハッシュで判定する。
PERSONAS = {
    'balthasar': {
        'codename': 'BALTHASAR-2',
        'name': 'Humanist',
        'pages': ['thought/index.html'],
        'lists': [],
        'focus': (
            '人間・愛・幸せ・失敗・人生についての本人の思索。テーマごとの結論と、その拠り所にした書物、'
            '読み手に投げかけている問いを残す。過去の版がある場合は「以前は〜と考えていたが、いまは〜」という'
            '考えの変遷として残す。'
        ),
    },
    'melchior': {
        'codename': 'MELCHIOR-1',
        'name': 'Enthusiast',
        'pages': ['dj/index.html', 'motovlog/index.html'],
        'lists': [],
        'focus': (
            '音楽・DJ・ハーレーへの熱量。好きなジャンルやこだわり、DJ としての考え方、原体験、'
            '事故からバイクに戻った経緯と愛機への思いを残す。'
        ),
    },
    'casper': {
        'codename': 'CASPER-3',
        'name': 'Strategist',
        'pages': ['job/index.html'],
        'lists': [
            # (パス, 見出し, 項目の配列を取り出す関数, 1項目を1行にする関数)
            ('data/tools.json', '自作して公開しているブラウザツール',
             lambda d: d, lambda t: f"{t['title']}: {t.get('description', '')}"),
            ('data/glitch.json', '技術ブログ（glitch）の記事',
             lambda d: d['articles'], lambda a: f"{a['title']}" + (f": {a['excerpt']}" if a.get('excerpt') else '')),
        ],
        'focus': (
            '仕事上の専門領域、代表的な実績、意思決定や施策設計の考え方、自作ツールや技術発信から読み取れる'
            '関心領域を残す。'
        ),
    },
}

SYSTEM_PROMPT = """あなたは、ある人物（Shinya Takeda）の内面の一側面「{name}」（{codename}）のための「人格カード」を書く編集者。
人格カードは、その人格として会話する AI の system プロンプトに「本人がいま大切にしている考え・関心・経験」として差し込まれる。
重視する内容: {focus}

ルール:
- 素材（本人のサイトから抜き出した文章）に書かれていることだけを使う。推測で補わない。
- 一人称や口調の指定は不要（別途指定される）。本人についてのメモとして「〜を大切にしている」「〜の経験がある」のように書く。
- 本人の言い回しで核心を突いている表現は、できるだけそのまま残す。
- 連絡先・料金・申込方法・URL・ボタンの文言・機材の細かい仕様など、人格の形成に関係しない実務情報は捨てる。
- 見出し・前置き・後書きを付けず、「- 」で始まる箇条書きだけを出力する。全体で{target}字以内。"""


# ---------------------------------------------------------------- 抽出（HTML）

VOID_TAGS = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
# 中身ごと捨てる要素（UI 部品・埋め込み・装飾）
SKIP_TAGS = {'script', 'style', 'svg', 'button', 'form', 'input', 'select', 'textarea', 'iframe',
             'noscript', 'video', 'audio', 'canvas', 'nav', 'dialog'}
BLOCK_TAGS = {'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'ul', 'ol', 'li',
              'dl', 'dt', 'dd', 'table', 'tr', 'blockquote', 'figure', 'figcaption', 'template',
              'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr'}
HEADING_TAGS = {'h1', 'h2', 'h3', 'h4'}


class Node:
    __slots__ = ('tag', 'attrs', 'children')

    def __init__(self, tag, attrs):
        self.tag = tag
        self.attrs = attrs
        self.children = []


class TreeBuilder(HTMLParser):
    """標準ライブラリだけで組む最小限の DOM。閉じ忘れは、対応する開始タグまで巻き戻して吸収する。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node('#root', {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, {k: (v if v is not None else '') for k, v in attrs})
        self.stack[-1].children.append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    # 自己終了タグ（<line /> 等）は HTMLParser の既定で starttag → endtag と呼ばれるので、上書きしない

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def parse_html(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as f:
        builder = TreeBuilder()
        builder.feed(f.read())
        builder.close()
    return builder.root


def iter_nodes(node):
    for child in node.children:
        if isinstance(child, Node):
            yield child
            yield from iter_nodes(child)


def is_skipped(node):
    return (node.tag in SKIP_TAGS or 'data-magi-skip' in node.attrs
            or node.attrs.get('aria-hidden') == 'true')


def node_text(node):
    """要素のテキストを、ブロック要素ごとに改行を入れて取り出す。"""
    parts = []

    def walk(n):
        # data-magi-lead の子は、DOM 上の位置に関係なく親の先頭に出す。年表のように見た目の都合で
        # 年のラベルが本文の後ろに置かれていると、文字列にしたとき次の項目の年に読めてしまうため
        # （安定ソートなので、lead 同士・それ以外同士の順序は保たれる）
        for child in sorted(n.children, key=lambda c: not (isinstance(c, Node) and 'data-magi-lead' in c.attrs)):
            if isinstance(child, str):
                parts.append(re.sub(r'\s+', ' ', child))
                continue
            if is_skipped(child):
                continue
            block = child.tag in BLOCK_TAGS
            if block:
                parts.append('\n')
            # thought の記事属性（ページには表示されず、属性として持っている情報）
            if child.attrs.get('data-role') == 'revision':
                parts.append(f"［過去の版 {child.attrs.get('data-date', '')}］\n")
            if child.tag in HEADING_TAGS:
                parts.append('■ ')
            walk(child)
            # data-updated（最終更新日）は読まない。カードに日付は出ず、日付だけの修正で作り直しが走るため
            if child.attrs.get('data-question'):
                parts.append(f"\n読み手への問い: {child.attrs['data-question']}")
            if block:
                parts.append('\n')

    walk(node)
    lines = (re.sub(r'^■\s+', '■ ', line.strip()) for line in ''.join(parts).split('\n'))
    return '\n'.join(line for line in lines if line)


def marked_text(path, key):
    """ページ内で data-magi に key を含む要素のテキストを、文書順につなげて返す。"""
    root = parse_html(path)
    marked = [n for n in iter_nodes(root) if key in n.attrs.get('data-magi', '').split()]
    # 目印の内側にさらに目印がある場合、外側だけを使う（二重に数えない）
    inner = {id(d) for n in marked for d in iter_nodes(n)}
    texts = [node_text(n) for n in marked if id(n) not in inner]
    return '\n\n'.join(t for t in texts if t)


# ---------------------------------------------------------------- 抽出（一覧 JSON）

def list_text(path, heading, pick, fmt):
    with open(os.path.join(ROOT, path), encoding='utf-8') as f:
        items = list(pick(json.load(f)))
    # 見出しだけ返すと、一覧が誤って空になっても気づかないまま、その関心の抜けたカードができる
    if not items:
        raise RuntimeError(f'{path} の一覧が空（{heading}）')
    return f'■ {heading}\n' + '\n'.join(f'- {fmt(item)}' for item in items)


def build_source(key, conf):
    """人格1つぶんの素材テキスト。どれかの取り出し元が空なら例外（目印の消失に気づくため）。"""
    blocks = []
    for path in conf['pages']:
        text = marked_text(path, key)
        if not text:
            raise RuntimeError(f'{path} に data-magi="{key}" の目印が見つからない（または中身が空）')
        blocks.append(f'＝＝ {path} ＝＝\n{text}')
    for path, heading, pick, fmt in conf['lists']:
        blocks.append(f'＝＝ {path} ＝＝\n{list_text(path, heading, pick, fmt)}')
    source = '\n\n'.join(blocks)
    if len(source) > SOURCE_MAX:
        raise RuntimeError(f'{key} の素材が {len(source)} 字あり上限 {SOURCE_MAX} を超えた。目印の範囲を見直すこと')
    return source


# ---------------------------------------------------------------- 要約

RETRY_WAITS = (5, 20)  # 再試行までの待ち秒。回数はこの長さ＋1回


def call_openai(api_key, system, user):
    """人格カード1枚を生成する。失敗はすべて RuntimeError にそろえる（呼び出し側で整形して止めるため）。"""
    payload = {
        'model': MODEL,
        # 省略すると推論が走り max_completion_tokens を食い潰すので明示する（magi2 と同じ理由）
        'reasoning_effort': 'none',
        'temperature': 0.2,
        # 日本語は1字あたり1トークン前後。CARD_MAX を超える長さまで出させ、切れたかどうかは
        # finish_reason で判定する（上限で切られた文は検査の文字数範囲に収まってしまうため）
        'max_completion_tokens': 4000,
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
    }
    req = urllib.request.Request(
        ENDPOINT, data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {api_key}'},
    )
    for attempt in range(len(RETRY_WAITS) + 1):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = json.loads(resp.read().decode('utf-8'))
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', errors='ignore')[:300]
            error = f'HTTP {e.code}: {detail}'
            retryable = e.code == 429 or e.code >= 500  # 一時的なもの（レート制限・サーバ側）だけ再試行
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            error, retryable = f'{type(e).__name__}: {e}', True
        if not retryable or attempt == len(RETRY_WAITS):
            raise RuntimeError(f'OpenAI の呼び出しに失敗: {error}')
        print(f'[WARN] {error} — {RETRY_WAITS[attempt]} 秒後に再試行します', file=sys.stderr)
        time.sleep(RETRY_WAITS[attempt])

    try:
        choice = body['choices'][0]
        content = (choice['message'].get('content') or '').strip()
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f'OpenAI の応答の形が想定外: {str(body)[:300]}') from e
    if choice.get('finish_reason') != 'stop':
        raise RuntimeError(f"人格カードが途中で終わった（finish_reason={choice.get('finish_reason')}）")
    return content


def validate_card(card):
    card = card.strip()
    if card.startswith('```'):
        card = re.sub(r'^```\w*\s*|\s*```$', '', card).strip()
    if not (CARD_MIN <= len(card) <= CARD_MAX):
        raise RuntimeError(f'人格カードの長さが範囲外（{len(card)} 字、許容 {CARD_MIN}〜{CARD_MAX}）')
    if not card.startswith('-'):
        raise RuntimeError('人格カードが箇条書きになっていない: ' + card[:80])
    return card


# ---------------------------------------------------------------- main

def load_previous():
    try:
        with open(OUT_PATH, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--dry-run', action='store_true', help='抽出と差分判定だけ行い、API は呼ばない')
    ap.add_argument('--force', action='store_true', help='素材が変わっていなくても全人格を作り直す')
    ap.add_argument('--show', action='store_true', help='抽出した素材を全文表示する')
    args = ap.parse_args()

    previous = load_previous().get('personas', {})
    todo = []
    for key, conf in PERSONAS.items():
        system = SYSTEM_PROMPT.format(name=conf['name'], codename=conf['codename'],
                                      focus=conf['focus'], target=CARD_TARGET)
        source = build_source(key, conf)
        # プロンプトもハッシュに含める。プロンプトを直せば、素材が同じでも作り直される
        digest = hashlib.sha256(f'{MODEL}\n{system}\n{source}'.encode('utf-8')).hexdigest()
        changed = args.force or previous.get(conf['codename'], {}).get('source_hash') != digest
        print(f"{conf['codename']:<12} 素材 {len(source):>5} 字  {'再生成' if changed else '変更なし'}")
        if args.show:
            print(source, '\n')
        if changed:
            todo.append((conf, system, source, digest))

    if args.dry_run or not todo:
        return

    api_key = os.environ.get('OPENAI_API_KEY', '').strip()
    if not api_key:
        sys.exit('OPENAI_API_KEY が未設定')

    now = datetime.now(JST).isoformat(timespec='seconds')
    updated = {}
    for conf, system, source, digest in todo:
        # 前回のカードは渡さず、毎回素材からゼロで作る（前回の誤りや消した内容を引き継がないため）
        card = validate_card(call_openai(api_key, system, f'【素材】\n{source}'))
        updated[conf['codename']] = {'card': card, 'source_hash': digest, 'updated_at': now}
        print(f"--- {conf['codename']}（{len(card)} 字）\n{card}\n")

    # 全人格が成功したときだけ書く。途中で落ちたら前回の JSON がそのまま残る
    personas = {**previous, **updated}
    out = {
        'note': '自動生成（.github/scripts/magi-context.py）。手で編集しない。元の文章は各ページの data-magi の目印の中身',
        'personas': {c['codename']: personas[c['codename']] for c in PERSONAS.values() if c['codename'] in personas},
    }
    with open(OUT_PATH, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write('\n')


if __name__ == '__main__':
    # Windows のコンソール（cp932）で素材の表示が落ちないように
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    try:
        main()
    except RuntimeError as e:
        sys.exit(f'[ERROR] {e}')
