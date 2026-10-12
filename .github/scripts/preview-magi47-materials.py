#!/usr/bin/env python3
"""公開1のカード/X素材を比較用に生成する。正本と本番の生成物は書き換えない。"""
import importlib.util
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'workers/.wrangler/magi47-quality/materials.json'


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mc, xp = module('magi-context'), module('magi-x-posts')
    from ai_model_registry import model_id
    keys = {name: os.environ.get(name, '').strip() for name in ('ANTHROPIC_API_KEY', 'OPENAI_API_KEY')}
    if not all(keys.values()):
        raise RuntimeError('Material evaluation API keys are required')
    out = {'date': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'cards': [], 'images': [], 'contexts': [], 'image_urls': []}
    OUT.parent.mkdir(parents=True, exist_ok=True)

    def save():
        OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

    def baseline_call(_key, system, user):
        payload = {'model': model_id('openai', 'luna'), 'reasoning_effort': 'none', 'temperature': 0.2,
                   'max_completion_tokens': 4000, 'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}
        req = urllib.request.Request('https://api.openai.com/v1/chat/completions', data=json.dumps(payload).encode(),
                                     headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys['OPENAI_API_KEY']})
        with urllib.request.urlopen(req, timeout=90) as response:
            data = json.load(response)
        choice = data['choices'][0]
        if choice['finish_reason'] != 'stop' or choice['message'].get('refusal'):
            raise RuntimeError('Baseline material response incomplete')
        return choice['message']['content'].strip()

    top, routed = mc.load_top_page()
    for key, conf in mc.PERSONAS.items():
        subject = conf.get('subject') or f"ある人物（Shinya Takeda）の内面の一側面「{conf['name']}」（{conf['codename']}）"
        system = mc.SYSTEM_PROMPT.format(subject=subject, focus=conf['focus'], target=conf.get('target', mc.CARD_TARGET))
        source = mc.build_source(key, conf, top, routed)
        card = {'codename': conf['codename'], 'source': source, 'variants': []}
        out['cards'].append(card)
        for side, call in [('baseline', baseline_call), ('candidate-1', mc.call_anthropic), ('candidate-2', mc.call_anthropic)]:
            started = time.monotonic()
            text = mc.validate_card(call(keys['ANTHROPIC_API_KEY'], system, '【素材】\n' + source))
            card['variants'].append({'side': side, 'text': text, 'chars': len(text), 'elapsed_ms': round((time.monotonic() - started) * 1000)})
            save()
            print(json.dumps({'card': conf['codename'], 'side': side, 'chars': len(text)}), flush=True)

    # 保存済みの本人の公開投稿から5件ずつだけ読む。いいね/フォロー/全件取得はしない。
    posts = json.loads((ROOT / '.github/magi/x-posts.json').read_text(encoding='utf-8'))['posts']
    media_posts = [p for p in posts if p.get('media')][:5]
    context_posts = [p for p in posts if p.get('context') and p['kind'] in ('reply', 'quote')][:5]
    ids = list(dict.fromkeys(p['id'] for p in media_posts + context_posts))
    try:
        creds = xp.own_credentials()
    except SystemExit:
        out['x_status'] = 'credentials_missing'
        save()
        print('X comparison: credentials missing (not completed)', flush=True)
        return
    # 429を長時間出し直さず、中断して次回の評価へ残す。
    xp.RATE_LIMIT_RETRIES = 0
    status, body = xp.api_get('/tweets', {'ids': ','.join(ids), 'tweet.fields': xp.TWEET_FIELDS, **xp.EXPANSIONS}, creds)
    if status != 200:
        out['x_status'] = f'HTTP_{status}'
        save()
        print(f'X comparison: HTTP {status} (not completed)', flush=True)
        return
    xp.remember(body)
    tweets = {t['id']: t for t in body.get('data', [])}
    baseline = SimpleNamespace(call_anthropic=baseline_call)
    for rec in media_posts:
        tw = tweets.get(rec['id'])
        if not tw:
            continue
        media = [xp.INCLUDES['media'][k] for k in tw.get('attachments', {}).get('media_keys', []) if k in xp.INCLUDES['media'] and xp.image_url(xp.INCLUDES['media'][k])]
        if not media:
            continue
        urls = [xp.image_url(m) for m in media]
        out['image_urls'].extend(u for u in urls if u not in out['image_urls'])
        save()
        out['images'].append({'id': rec['id'], 'input': rec['text'], 'urls': urls,
                              'baseline': xp.describe_images(baseline, keys['ANTHROPIC_API_KEY'], rec, media),
                              'candidate': xp.describe_images(mc, keys['ANTHROPIC_API_KEY'], rec, media)})
        save()
    for rec in context_posts:
        tw = tweets.get(rec['id'])
        if not tw:
            continue
        parent_id = next((r['id'] for r in tw.get('referenced_tweets', []) if r['type'] in ('replied_to', 'quoted')), None)
        parent = xp.INCLUDES['tweets'].get(parent_id)
        if not parent:
            continue
        out['contexts'].append({'id': rec['id'], 'input': rec['text'], 'parent': parent.get('text', ''),
                                'baseline': xp.summarize_context(baseline, keys['ANTHROPIC_API_KEY'], rec, parent),
                                'candidate': xp.summarize_context(mc, keys['ANTHROPIC_API_KEY'], rec, parent)})
        save()
    out['x_status'] = 'complete' if len(out['images']) == len(out['contexts']) == 5 else 'partial'
    save()
    print(json.dumps({'X_images': len(out['images']), 'X_contexts': len(out['contexts']), 'status': out['x_status']}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # 上流の本文・URL・鍵をログへ出さない。
        raise SystemExit('Material evaluation failed: ' + type(exc).__name__)
