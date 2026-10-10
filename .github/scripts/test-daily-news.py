#!/usr/bin/env python3
"""ニュースの採否・判定順序・API障害時の動作を外部通信なしで確認する。"""

from contextlib import redirect_stderr
from datetime import datetime, timedelta
import http.client
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

import daily_engine as engine
import daily_news_filter as gate

spec = importlib.util.spec_from_file_location('retail_daily', Path(__file__).with_name('generate-retail-tech-daily.py'))
daily = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daily)

spec = importlib.util.spec_from_file_location('nitori_daily', Path(__file__).with_name('generate-nitori-daily.py'))
nitori = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nitori)


def item(title, **extra):
    return dict(title=title, description='店舗での技術導入についての説明', source='ニュース媒体',
                link='https://example.com/' + title, pub_ts=0, **extra)


class NewsFilterTests(unittest.TestCase):
    def test_nitori_rescued_candidates_do_not_fill_the_ai_limit_ahead_of_accepted_news(self):
        now = datetime(2026, 10, 4, 8, tzinfo=engine.JST)
        for region, limit in (('JP', 45), ('GLOBAL', 30)):
            with self.subTest(region=region):
                rescued = [item(f'{i:03d} 投資判断を紹介 ニトリ株の最新予想') for i in range(limit + 1)]
                accepted = item('N＋が新店舗をオープン')
                for candidate in rescued + [accepted]:
                    candidate['pub_date'] = '2026-10-03'
                    candidate['pub_ts'] = (now - timedelta(hours=3)).timestamp()
                accepted['pub_ts'] = (now - timedelta(hours=18)).timestamp()
                def fetch(query, **kwargs):
                    requested_region = 'GLOBAL' if kwargs['lang'] == 'en-US' else 'JP'
                    return rescued + [accepted] if requested_region == region else []
                config = dict(nitori.CONFIG, extra_candidates_fn=None)
                with patch.object(engine, 'fetch_google_news_rss', side_effect=fetch), patch.object(engine, 'load_recent_published_history', return_value={}), patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', side_effect=lambda state, *_: .9 if state['title'] == accepted['title'] else .03):
                    candidates = engine.gather_all_candidate_news(config, now)
                jp, gl, _, index = engine.build_candidate_index(candidates)
                selected = jp if region == 'JP' else gl
                self.assertEqual(len(selected), limit)
                self.assertEqual(selected[0]['title'], accepted['title'])
                self.assertIn(accepted, index.values())

    def test_nitori_rejudging_after_api_failure_clears_old_rescue_status(self):
        candidate = item('ニトリの新商品')
        for mode in ('missing_key', 'invalid_model', 'request_failed'):
            with self.subTest(mode=mode):
                with patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', return_value=.03):
                    kept = gate.filter_nitori_news([candidate], 'test', fallback_fn=lambda _: True)
                self.assertEqual(candidate['_news_judgement'], 'brand_rescue')
                with patch.object(gate, 'api_key', return_value='' if mode == 'missing_key' else 'test'), patch.object(gate, 'model_id', side_effect=ValueError() if mode == 'invalid_model' else None, return_value='test'), patch.object(gate, 'classify', side_effect=gate.ClassificationError('HTTP 520')):
                    kept = gate.filter_nitori_news(kept, 'test', fallback_fn=lambda _: True)
                self.assertEqual(candidate['_news_judgement'], 'rule')
                result = nitori.fallback_rule_based(dict(JP=kept, GLOBAL=[]), '2026-10-03')
                self.assertEqual([article['url'] for article in result['articles']], [candidate['link']])

    def test_nitori_jev_accepted_article_wins_over_rescued_duplicate(self):
        now = datetime(2026, 10, 4, 8, tzinfo=engine.JST)
        for region, prefix in (('JP', 'ニトリホールディングスの最新動向について'), ('GLOBAL', 'Nitori Holdings business update: ')):
            with self.subTest(region=region):
                rescued, accepted = [item(prefix + suffix) for suffix in ('株式投資の推奨', '物流倉庫の自動化を開始')]
                self.assertEqual(rescued['title'][:20], accepted['title'][:20])
                for candidate in (rescued, accepted):
                    candidate['pub_ts'] = (now - timedelta(hours=12)).timestamp()
                def fetch(query, **kwargs):
                    requested_region = 'GLOBAL' if kwargs['lang'] == 'en-US' else 'JP'
                    return [rescued, accepted] if requested_region == region else []
                config = dict(nitori.CONFIG, extra_candidates_fn=None)
                with patch.object(engine, 'fetch_google_news_rss', side_effect=fetch), patch.object(engine, 'load_recent_published_history', return_value={}), patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', side_effect=lambda state, *_: .03 if state['title'] == rescued['title'] else .9):
                    candidates = engine.gather_all_candidate_news(config, now)
                self.assertEqual(candidates[region], [accepted])

    def test_nitori_rescued_articles_need_ai_selection_before_publication(self):
        jp_rescued, jp_accepted = item('ニトリ株の投資判断'), item('ニトリ物流の自動化')
        gl_rescued, gl_accepted = item('Nitori shares fall after quarterly financial results'), item('Nitori opens a new store')
        social = dict(item('ニトリのテレビ台を買った'), platform='x', raw_text='ニトリのテレビ台を買った', author='@consumer', pub_date='2026-10-03')
        for candidate in (jp_rescued, jp_accepted, gl_rescued, gl_accepted):
            candidate['pub_date'] = '2026-10-03'
        with patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', side_effect=lambda state, *_: .03 if state['title'] in (jp_rescued['title'], gl_rescued['title']) else .9):
            jp = gate.filter_nitori_news([jp_rescued, jp_accepted], 'test', fallback_fn=lambda _: False)
            gl = gate.filter_nitori_news([gl_rescued, gl_accepted], 'test', fallback_fn=lambda _: False)
        candidates = dict(JP=jp, GLOBAL=gl, EXTRA=[social], recent_published_titles=[])
        # 候補としての救済は残し、AI成功時には選定へ渡す。
        self.assertEqual(jp, [jp_rescued, jp_accepted])
        self.assertEqual(gl, [gl_rescued, gl_accepted])
        _, _, _, index = engine.build_candidate_index(candidates)
        self.assertIn(jp_rescued, index.values())
        self.assertIn(gl_rescued, index.values())
        for mode in ('missing_keys', 'providers_failed'):
            with self.subTest(mode=mode), patch.dict('os.environ', {'ANTHROPIC_API_KEY': '' if mode == 'missing_keys' else 'test', 'OPENAI_API_KEY': '' if mode == 'missing_keys' else 'test', 'DEEPSEEK_API_KEY': '' if mode == 'missing_keys' else 'test'}), patch.object(engine, 'call_anthropic_api', side_effect=RuntimeError('test outage')), patch.object(engine, 'call_llm_api', side_effect=RuntimeError('test outage')):
                result = engine.analyze_news_with_fallback(nitori.CONFIG, candidates, '2026-10-04', '2026-10-03')
            self.assertEqual([article['url'] for article in result['articles']], [jp_accepted['link'], gl_accepted['link']])
            self.assertEqual(len(result['sns_buzz']), 1)
        only_rescued = dict(candidates, JP=[jp_rescued], GLOBAL=[gl_rescued])
        self.assertEqual(nitori.fallback_rule_based(only_rescued, '2026-10-03')['articles'], [])

    def test_nitori_requests_its_own_policy_and_rescues_branded_negatives(self):
        candidates = [item(title) for title in ('シマホの物流自動化', 'ニトリ店舗の新しい施策', '島忠の出店', 'デコホームの新商品', 'N+の店舗', 'Ｎ＋の店舗', 'nItOrI opens a store', '無関係な他社記事')]
        description_brand = item('海外家具小売の展開')
        description_brand['description'] = 'NITORI announces a new store.'
        candidates.append(description_brand)
        states = []
        def response(request, **kwargs):
            payload = json.loads(request.data)
            self.assertEqual(payload['questions']['publishable'], gate.question_for('nitori'))
            states.append(payload['state'])
            probability = .5 if payload['state']['title'] == candidates[0]['title'] else .1
            return io.BytesIO(json.dumps({'answers': {'publishable': {'type': 'noul', 'noul': probability}}}).encode())
        with patch.object(gate, 'api_key', return_value='test'), patch.object(gate.urllib.request, 'urlopen', side_effect=response), patch.object(gate, 'model_id', return_value='test'):
            kept = gate.filter_nitori_news(candidates, 'test', fallback_fn=lambda _: self.fail('成功した判定で従来ルールを使わない'))
        self.assertEqual(kept, candidates[:7] + [description_brand])
        self.assertEqual(len(states), len(candidates))
        source_only = item('無関係な記事')
        source_only['source'] = 'ニトリ'
        self.assertFalse(gate.has_nitori_brand(source_only))

    def test_nitori_failure_does_not_apply_brand_rescue(self):
        candidates = [item('ニトリ株の投資推奨'), item('シマホの物流自動化')]
        for mode in ('missing_key', 'invalid_model', 'request_failed'):
            with self.subTest(mode=mode), patch.object(gate, 'api_key', return_value='' if mode == 'missing_key' else 'test'), patch.object(gate, 'model_id', side_effect=ValueError() if mode == 'invalid_model' else None, return_value='test'), patch.object(gate, 'classify', side_effect=gate.ClassificationError('HTTP 520')):
                kept = gate.filter_nitori_news(candidates, 'test', fallback_fn=lambda candidate: candidate is candidates[1])
                self.assertEqual(kept, candidates[1:])

    def test_nitori_reuses_identical_state_without_duplicating_api_calls(self):
        first = item('ニトリの新商品')
        second = dict(first, link='https://example.com/second')
        with patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', return_value=.1) as classify:
            self.assertEqual(gate.filter_nitori_news([first, second], 'test', fallback_fn=lambda _: False), [first, second])
        classify.assert_called_once()
        self.assertEqual(classify.call_args.args[-1], 'nitori')

    def test_nitori_pipeline_rescues_only_news_and_keeps_social_separate(self):
        now = datetime(2026, 10, 4, 8, tzinfo=engine.JST)
        jp = [item(title) for title in ('ニトリ店舗の実証', 'シマホの物流自動化', '無関係な記事', 'ニトリの古い記事', 'ニトリの過去掲載')]
        gl = [item('NITORI opens a new store'), item('Other retailer opens a new store')]
        social = dict(item('【Xで100いいね】ニトリのテレビ台を買った'), is_sns_raw=True, platform='x', raw_text='ニトリのテレビ台を買った', likes=100)
        for candidate in jp + gl + [social]:
            candidate['pub_ts'] = (now - timedelta(hours=12)).timestamp()
        jp[3]['pub_ts'] = (now - timedelta(days=5)).timestamp()
        history = {'recent_urls': {jp[4]['link']}, 'recent_title_keys': set()}
        judged = []
        def classify(state, key, model, media):
            self.assertEqual(media, 'nitori')
            judged.append(state['title'])
            return .9 if state['title'] == jp[1]['title'] else .1
        config = dict(nitori.CONFIG, extra_candidates_fn=lambda _: [social])
        with patch.object(engine, 'fetch_google_news_rss', side_effect=lambda query, **kw: list(gl if kw['lang'] == 'en-US' else jp)), patch.object(engine, 'load_recent_published_history', return_value=history), patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', side_effect=classify):
            candidates = engine.gather_all_candidate_news(config, now)
        self.assertCountEqual(candidates['JP'], jp[:2])
        self.assertEqual(candidates['GLOBAL'], gl[:1])
        self.assertEqual(candidates['EXTRA'], [social])
        self.assertCountEqual(judged, [candidate['title'] for candidate in jp[:3] + gl])
        self.assertNotIn('-レシピ', config['jp_query_gen'])
        self.assertNotIn('-スイーツ', config['jp_query_gen'])

    def test_successful_judgements_keep_order_and_never_use_keyword_fallback(self):
        candidates = [item('スイーツ売り場の電子棚札'), item('食品紹介だけ'), item('海外の無人決済')]
        def classify(state, key, model, media):
            self.assertEqual(media, 'retail')
            return .49 if state['title'] == '食品紹介だけ' else .5
        def fallback(candidate):
            self.fail('正常な判定をルールで上書きしてはいけない')
        with patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', side_effect=classify):
            kept = gate.filter_retail_news(candidates, 'test', fallback_fn=fallback)
        self.assertEqual(kept, [candidates[0], candidates[2]])

    def test_interrupted_response_uses_fallback_only_for_failed_article(self):
        class BrokenResponse:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
            def read(self, *_):
                raise http.client.IncompleteRead(b'sensitive response')
        candidates = [item('成功'), item('通信失敗'), item('正常な不採用')]
        calls = []
        def response(request, **kwargs):
            payload = json.loads(request.data)
            self.assertEqual(set(payload['questions']), {'publishable'})
            self.assertEqual(kwargs['timeout'], 8)
            self.assertNotIn('link', payload['state'])
            title = payload['state']['title']
            if title == '通信失敗':
                return BrokenResponse()
            return io.BytesIO(json.dumps({'answers': {'publishable': {'type': 'noul', 'noul': .1 if title == '正常な不採用' else .9}}}).encode())
        def fallback(candidate):
            calls.append(candidate['title'])
            return True
        logs = io.StringIO()
        with patch.object(gate, 'api_key', return_value='secret-key'), patch.object(gate.urllib.request, 'urlopen', side_effect=response), redirect_stderr(logs):
            kept = gate.filter_retail_news(candidates, 'test', fallback_fn=fallback)
        self.assertEqual(kept, candidates[:2])
        self.assertEqual(calls, ['通信失敗'])
        self.assertNotIn('sensitive response', logs.getvalue())
        self.assertNotIn('secret-key', logs.getvalue())
        self.assertNotIn('通信失敗', logs.getvalue())

    def test_invalid_response_and_timeout_are_safe_classification_errors(self):
        bodies = [{}, {'answers': {'publishable': {'type': 'choice', 'noul': .9}}}]
        bodies += [{'answers': {'publishable': {'type': 'noul', 'noul': p}}}
                   for p in (True, None, '0.9', -.1, 1.1, float('nan'), float('inf'), 10**400)]
        for body in bodies:
            with self.subTest(body=body), patch.object(gate.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(body).encode())):
                with self.assertRaises(gate.ClassificationError):
                    gate.classify(gate.state_for(item('不正な応答')), 'test', 'test')
        for error in (TimeoutError('sensitive timeout'), urllib.error.HTTPError('https://example.com', 520, 'sensitive response', {}, None)):
            with patch.object(gate.urllib.request, 'urlopen', side_effect=error):
                with self.assertRaises(gate.ClassificationError) as caught:
                    gate.classify(gate.state_for(item('通信')), 'test', 'test')
                self.assertNotIn('sensitive', str(caught.exception))

    def test_missing_key_and_model_config_failure_fall_back_without_api(self):
        candidates = [item('許可'), item('除外')]
        for mode in ('missing_key', 'invalid_model'):
            with self.subTest(mode=mode), patch.object(gate, 'api_key', return_value=''), patch.object(gate, 'model_id', side_effect=ValueError() if mode == 'invalid_model' else None, return_value='test'), patch.object(gate, 'classify') as classify:
                kept = gate.filter_retail_news(candidates, 'test', fallback_fn=lambda candidate: candidate['title'] == '許可')
                self.assertEqual(kept, candidates[:1])
                classify.assert_not_called()

    def test_gather_filters_content_after_recency_and_dedup_before_article_limits(self):
        now = datetime(2026, 10, 4, 8, tzinfo=engine.JST)
        fresh = (now - timedelta(hours=12)).timestamp()
        jp = [item('スイーツ売り場に電子棚札'), item('古いニュース'), item('過去掲載記事'), item('単なる食品紹介')]
        gl = [item('Retail quarterly results reveal checkout rollout'), item('General AI poetry')]
        for candidate in jp + gl:
            candidate['pub_ts'] = fresh
        jp[1]['pub_ts'] = (now - timedelta(days=5)).timestamp()
        history = {'recent_urls': {jp[2]['link']}, 'recent_title_keys': set()}
        judged = []
        def fetch(query, **kwargs):
            return gl if kwargs['lang'] == 'en-US' else jp
        def classify(state, *_):
            judged.append(state['title'])
            return .1 if state['title'] in ('単なる食品紹介', 'General AI poetry') else .9
        with patch.object(engine, 'fetch_google_news_rss', side_effect=fetch), patch.object(engine, 'load_recent_published_history', return_value=history), patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', side_effect=classify):
            candidates = engine.gather_all_candidate_news(daily.CONFIG, now)
        self.assertEqual(candidates['JP'], [jp[0]])
        self.assertEqual(candidates['GLOBAL'], [gl[0]])
        self.assertCountEqual(judged, [jp[0]['title'], jp[3]['title'], gl[0]['title'], gl[1]['title']])
        self.assertEqual(candidates['EXTRA'], [])
        self.assertNotIn('-スイーツ', daily.CONFIG['jp_query_gen'])
        self.assertNotIn('-セール', daily.CONFIG['jp_query_gen'])

    def test_pipeline_failure_uses_the_original_japanese_and_global_rules(self):
        now = datetime(2026, 10, 4, 8, tzinfo=engine.JST)
        fresh = (now - timedelta(hours=12)).timestamp()
        jp = [item('スイーツ売り場に電子棚札'), item('小売チェーンのRFID棚卸し')]
        gl = [item('Retail quarterly results reveal checkout rollout'), item('Grocery robots rollout')]
        for candidate in jp + gl:
            candidate['pub_ts'] = fresh
        def fetch(query, **kwargs):
            return gl if kwargs['lang'] == 'en-US' else jp
        for mode in ('missing_key', 'request_failed'):
            with self.subTest(mode=mode), patch.object(engine, 'fetch_google_news_rss', side_effect=fetch), patch.object(engine, 'load_recent_published_history', return_value={}), patch.object(gate, 'api_key', return_value='' if mode == 'missing_key' else 'test'), patch.object(gate, 'classify', side_effect=gate.ClassificationError('HTTP 520')):
                candidates = engine.gather_all_candidate_news(daily.CONFIG, now)
                self.assertEqual(candidates['JP'], [jp[1]])
                self.assertEqual(candidates['GLOBAL'], [gl[1]])

    def test_rejected_or_expired_title_does_not_hide_a_valid_article_with_same_prefix(self):
        now = datetime(2026, 10, 4, 8, tzinfo=engine.JST)
        prefix = '小売チェーンの店舗運営と業務効率化について'
        expired, rejected, accepted, duplicate = [item(prefix + suffix) for suffix in ('古い報道', '株式推奨', 'AI導入', '追加取材')]
        expired['pub_ts'] = (now - timedelta(days=5)).timestamp()
        for candidate in (rejected, accepted, duplicate):
            candidate['pub_ts'] = (now - timedelta(hours=12)).timestamp()
        judged = []
        def fetch(query, **kwargs):
            return [] if kwargs['lang'] == 'en-US' else [expired, rejected, accepted, duplicate]
        def classify(state, *_):
            judged.append(state['title'])
            return .1 if state['title'] == rejected['title'] else .9
        with patch.object(engine, 'fetch_google_news_rss', side_effect=fetch), patch.object(engine, 'load_recent_published_history', return_value={}), patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', side_effect=classify):
            candidates = engine.gather_all_candidate_news(daily.CONFIG, now)
        self.assertEqual(candidates['JP'], [accepted])
        self.assertCountEqual(judged, [rejected['title'], accepted['title'], duplicate['title']])



class DailyGenerationTests(unittest.TestCase):
    def test_provider_priority_and_fallback_for_both_media(self):
        hosts = ['api.anthropic.com', 'api.openai.com', 'api.deepseek.com']
        candidates = dict(JP=[item('ニトリ店舗の自動化', pub_date='2026-10-08')], GLOBAL=[], recent_published_titles=[])
        valid = {'articles': [{'source_id': 'JP-01', 'region': 'JP', 'title': '店舗の自動化'}]}
        for config in (nitori.CONFIG, daily.CONFIG):
            for winner in range(4):
                calls = []
                def response(request, **kwargs):
                    host = engine.urllib.parse.urlparse(request.full_url).hostname
                    calls.append(host)
                    if hosts.index(host) < winner:
                        raise urllib.error.HTTPError(request.full_url, 503, 'outage', {}, io.BytesIO(b'outage'))
                    if host == hosts[0]:
                        body = {'stop_reason': 'end_turn', 'content': [{'type': 'thinking', 'thinking': 'private'}, {'type': 'text', 'text': json.dumps(valid)}]}
                    else:
                        body = {'choices': [{'message': {'content': json.dumps(valid)}}]}
                    return io.BytesIO(json.dumps(body).encode())
                with self.subTest(media=config['media_name'], winner=winner), patch.dict('os.environ', {
                    'ANTHROPIC_API_KEY': 'test', 'OPENAI_API_KEY': 'test', 'DEEPSEEK_API_KEY': 'test',
                    'ANTHROPIC_MODEL': '', 'OPENAI_MODEL': '', 'DEEPSEEK_MODEL': '',
                }), patch.object(engine.urllib.request, 'urlopen', side_effect=response):
                    result = engine.analyze_news_with_fallback(config, candidates, '2026-10-09', '2026-10-08')
                    self.assertEqual(calls, hosts[:winner + 1])
                    self.assertEqual(result['engine_type'], ('anthropic', 'openai', 'deepseek', 'fallback')[winner])
                    if winner < 3:
                        self.assertEqual(result['articles'][0]['url'], candidates['JP'][0]['link'])

    def test_anthropic_missing_key_or_bad_response_uses_openai(self):
        candidates = dict(JP=[item('店舗の自動化', pub_date='2026-10-08')], GLOBAL=[], recent_published_titles=[])
        for config in (nitori.CONFIG, daily.CONFIG):
            for mode in ('missing_key', 'invalid_json', 'empty_articles', 'truncated', 'refusal', 'no_text'):
                def response(request, **kwargs):
                    body = {'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': '{"articles":[]}'}]}
                    if mode == 'invalid_json':
                        body['content'][0]['text'] = 'not json'
                    elif mode in ('truncated', 'refusal'):
                        body['stop_reason'] = 'max_tokens' if mode == 'truncated' else 'refusal'
                    elif mode == 'no_text':
                        body['content'] = [{'type': 'thinking', 'thinking': '{}'}]
                    return io.BytesIO(json.dumps(body).encode())
                with self.subTest(media=config['media_name'], mode=mode), patch.dict('os.environ', {
                    'ANTHROPIC_API_KEY': '' if mode == 'missing_key' else 'test',
                    'OPENAI_API_KEY': 'test', 'DEEPSEEK_API_KEY': 'test',
                }), patch.object(engine.urllib.request, 'urlopen', side_effect=response) as native, patch.object(engine, 'call_llm_api', return_value={'articles': [{'source_id': 'JP-01'}]}) as compatible:
                    result = engine.analyze_news_with_fallback(config, candidates, '2026-10-09', '2026-10-08')
                    self.assertEqual(result['engine_type'], 'openai')
                    self.assertEqual(native.call_count, 0 if mode == 'missing_key' else 1)
                    self.assertEqual(compatible.call_count, 1)

    def test_anthropic_auth_payload_and_text_blocks(self):
        def response(request, **kwargs):
            payload = json.loads(request.data)
            self.assertEqual(request.get_header('X-api-key'), 'test-key')
            self.assertEqual(request.get_header('Anthropic-version'), '2023-06-01')
            self.assertIsNone(request.get_header('Authorization'))
            self.assertEqual(payload['messages'], [{'role': 'user', 'content': 'test prompt'}])
            self.assertEqual(payload['thinking'], {'type': 'adaptive'})
            self.assertEqual(payload['output_config'], {'effort': 'medium'})
            self.assertEqual(payload['max_tokens'], 16384)
            for field in ('temperature', 'top_p', 'top_k', 'response_format', 'reasoning_effort'):
                self.assertNotIn(field, payload)
            body = {'stop_reason': 'end_turn', 'content': [
                {'type': 'thinking', 'thinking': 'not JSON'},
                {'type': 'text', 'text': '```json\n{"ok":'},
                {'type': 'text', 'text': 'true}\n```'},
            ]}
            return io.BytesIO(json.dumps(body).encode())
        with patch.object(engine.urllib.request, 'urlopen', side_effect=response):
            self.assertEqual(engine.call_anthropic_api('https://api.anthropic.com/v1/messages',
                             'test-key', 'test-model', 'test prompt', 'test-agent'), {'ok': True})


class SearchGenerationTests(unittest.TestCase):
    def test_invalid_titles_are_dropped_before_sources_and_terms_and_issue_still_publishes(self):
        import copy
        import tempfile
        candidates = dict(JP=[item('店舗の収納', pub_date='2026-10-08')], GLOBAL=[], recent_published_titles=[])
        bad = [{'source_id': 'JP-999'}] + [{'title': title, 'source_id': 'JP-999'}
               for title in (None, '', ' \ufeff ', 123, False, [], {})] + [None, '記事', 1]
        valid = {'title': '店舗の収納', 'source_id': 'JP-01', 'why_it_matters': 123}
        for config in (nitori.CONFIG, daily.CONFIG):
            for keep_valid in (True, False):
                with self.subTest(media=config['media_id'], keep_valid=keep_valid), tempfile.TemporaryDirectory() as directory:
                    config = {**config, 'data_dir': str(Path(directory, 'data')), 'job_dir': str(Path(directory, 'job'))}
                    Path(config['job_dir']).mkdir()
                    result = {'articles': copy.deepcopy(bad) + ([copy.deepcopy(valid)] if keep_valid else []),
                              'executive_summary': [None, 123, '有効な要点'], 'sns_buzz': None, 'sns_summary': None, 'sns_why_it_matters': 123}
                    warnings = io.StringIO()
                    with patch('sys.argv', ['daily', '--date', '20261009']), \
                            patch.dict('os.environ', {'ANTHROPIC_API_KEY': 'test', 'ANTHROPIC_MODEL': ''}), \
                            patch.object(engine, 'gather_all_candidate_news', return_value=candidates), \
                            patch.object(engine, 'call_anthropic_api', return_value=result) as first, \
                            patch.object(engine, 'call_llm_api') as second, \
                            patch.object(engine, 'trigger_daily_ogp_generation') as ogp, redirect_stderr(warnings):
                        engine.run_daily_pipeline(config)
                    first.assert_called_once(); second.assert_not_called(); ogp.assert_called_once()
                    self.assertEqual(warnings.getvalue().count('題名が不正なため除外'), len(bad))
                    issue = engine.load_history(config['data_dir'])[0]
                    self.assertEqual(issue['count'], int(keep_valid))
                    self.assertEqual(issue['executive_summary'], ['有効な要点'])
                    self.assertEqual(issue['sns_summary'], '')
                    self.assertEqual(issue['sns_why_it_matters'], '')
                    self.assertEqual(issue['sns_buzz'], [])
                    index = json.loads(Path(config['job_dir'], 'search-index.json').read_text(encoding='utf-8'))
                    self.assertEqual(len(index['records']), int(keep_valid))
                    page = Path(config['job_dir'], '20261009', 'index.html').read_text(encoding='utf-8')
                    if keep_valid:
                        self.assertEqual(issue['articles'][0]['why_it_matters'], '')
                        self.assertEqual(index['records'][0]['url'], '20261009/#art-1')
                        self.assertIn('id="art-1"', page)
                        self.assertNotIn('id="art-2"', page)
                    else:
                        self.assertEqual(issue['articles'], [])
                        self.assertNotIn('id="art-1"', page)
                    for name in ('index.html', 'rss.xml'):
                        self.assertTrue(Path(config['job_dir'], name).is_file())

    def test_issue_optional_field_types_and_bad_article_lists_are_repaired(self):
        valid = {'title': '記事', 'category': '店舗', 'tags': []}
        for summary in (None, '要点', 123, {}, [None, 123, '有効な要点']):
            result = {'articles': [dict(valid)], 'executive_summary': summary}
            prepared = engine.prepare_article_fields(nitori.CONFIG, result)
            self.assertEqual(prepared['executive_summary'], ['有効な要点'] if isinstance(summary, list) else [])
        for articles in (None, '記事', 123, {}):
            with redirect_stderr(io.StringIO()):
                result = engine.prepare_article_fields(nitori.CONFIG, {'articles': articles})
            self.assertEqual(result['articles'], [])

    def test_generated_optional_fields_are_repaired_before_terms_and_publication(self):
        import tempfile
        from daily_search_terms import valid_search_terms
        candidates = dict(JP=[item('店舗の収納', pub_date='2026-10-08')], GLOBAL=[], recent_published_titles=[])
        categories = [None, '', ' \ufeff ', '🧺' * 41, '店舗\x00', '店舗\x85', 1]
        for config in (nitori.CONFIG, daily.CONFIG):
            for category in categories:
                with self.subTest(media=config['media_id'], category=category), tempfile.TemporaryDirectory() as directory:
                    config = {**config, 'data_dir': str(Path(directory, 'data')), 'job_dir': str(Path(directory, 'job'))}
                    Path(config['job_dir']).mkdir()
                    article = {'source_id': 'JP-01', 'title': '店舗の収納', 'summary': None,
                               'tags': ['', None, ' \ufeff ', '収納'], 'source': None}
                    if category is not None:
                        article['category'] = category
                    with patch('sys.argv', ['daily', '--date', '20261009']), \
                            patch.dict('os.environ', {'ANTHROPIC_API_KEY': 'test', 'ANTHROPIC_MODEL': ''}), \
                            patch.object(engine, 'gather_all_candidate_news', return_value=candidates), \
                            patch.object(engine, 'call_anthropic_api', return_value={'articles': [article]}) as first, \
                            patch.object(engine, 'call_llm_api') as second, \
                            patch.object(engine, 'trigger_daily_ogp_generation') as ogp:
                        engine.run_daily_pipeline(config)
                    first.assert_called_once(); second.assert_not_called(); ogp.assert_called_once()
                    stored = engine.load_history(config['data_dir'])
                    repaired = stored[0]['articles'][0]
                    self.assertEqual(repaired['category'], config['sample_category'])
                    self.assertEqual(repaired['tags'], ['収納'])
                    self.assertEqual(repaired['summary'], '')
                    self.assertEqual(repaired['source'], candidates['JP'][0]['source'])
                    self.assertTrue(valid_search_terms(repaired['search_terms']))
                    index = json.loads(Path(config['job_dir'], 'search-index.json').read_text(encoding='utf-8'))
                    self.assertEqual(index, engine.build_search_index(config, stored)['search-index.json'])
                    page = Path(config['job_dir'], '20261009', 'index.html').read_text(encoding='utf-8')
                    self.assertIn(f'data-category="{config["sample_category"]}"', page)
                    self.assertIn(config['sample_category'], Path(config['job_dir'], 'index.html').read_text(encoding='utf-8'))
                    self.assertIn('<item>', Path(config['job_dir'], 'rss.xml').read_text(encoding='utf-8'))

    def test_generated_field_preparation_preserves_valid_content_and_repairs_bad_types(self):
        import copy
        valid = {'title': '店舗の収納', 'summary': '住まいの整理', 'source': '媒体', 'category': '🧺' * 40,
                 'tags': ['収納', ' furniture '], 'search_terms': ['収納', 'home storage', 'organize rooms']}
        for config in (nitori.CONFIG, daily.CONFIG):
            result = {'articles': [copy.deepcopy(valid)]}
            self.assertEqual(engine.prepare_article_fields(config, result), {'articles': [valid]})
            for tags in (None, '収納', 1, {}):
                result = {'articles': [{**valid, 'summary': None, 'source': None, 'category': None, 'tags': tags}]}
                repaired = engine.prepare_article_fields(config, result)['articles'][0]
                self.assertEqual(repaired['category'], config['sample_category'])
                self.assertEqual(repaired['tags'], [])
                self.assertEqual(repaired['summary'], '')
                self.assertEqual(repaired['source'], '')

    def test_month_filter_matches_indexed_articles_and_keeps_empty_issues_in_archive(self):
        import re
        for config in (nitori.CONFIG, daily.CONFIG):
            history = [
                {'date': '20261001', 'count': 0, 'articles': []},
                {'date': '20260930', 'count': 0, 'articles': []},
                {'date': '20260929', 'count': 1, 'articles': [{'title': '店舗の収納', 'category': '店舗'}]},
                {'date': '20260801', 'count': 0},
                {'date': '20260701', 'count': 1, 'articles': [{'title': '昔の店舗', 'category': '店舗'}]},
            ]
            for issues, expected in ((history, ['202609', '202607']), (history[:2], []), ([], [])):
                with self.subTest(media=config['media_id'], months=expected):
                    page = engine.render_top_index_html(config, issues)
                    select = re.search(r'<select id="archiveMonthFilter"[^>]*>(.*?)</select>', page).group(1)
                    months = re.findall(r'<option value="(\d{6})">', select)
                    indexed = {record['date'][:6] for payload in engine.build_search_index(config, issues).values() for record in payload['records']}
                    self.assertEqual(months, expected)
                    self.assertEqual(set(months), indexed)
            self.assertIn('href="20260930/"', engine.render_top_index_html(config, history))
            history[0]['articles'] = [{'title': '今月の店舗', 'category': '店舗'}]
            history[0]['count'] = 1
            self.assertIn('<option value="202610">', engine.render_top_index_html(config, history))

    def test_search_terms_validation_matches_worker_limits(self):
        from daily_search_terms import valid_search_terms
        self.assertTrue(valid_search_terms(['収納', 'home storage', '🧺' * 60]))
        invalid = [None, '', [], ['one', 'two'], list('abcdef'), ['a', 'a', 'b'],
                   ['a', 'b', ''], ['a', 'b', '\ufeff'], ['a', 'b', None],
                   ['a', 'b', 'x\x00'], ['a', 'b', 'x\x85'], ['a', 'b', '🧺' * 61]]
        for config in (nitori.CONFIG, daily.CONFIG):
            for value in invalid:
                with self.subTest(media=config['media_id'], value=value):
                    self.assertFalse(valid_search_terms(value))
                    history = self.history()
                    history[0]['articles'][0]['search_terms'] = value
                    with self.assertRaisesRegex(ValueError, 'search_terms'):
                        engine.build_search_index(config, history)

    def test_existing_llm_call_generates_terms_without_a_second_request(self):
        import copy
        from daily_search_terms import valid_search_terms
        candidates = dict(JP=[item('店舗の収納', pub_date='2026-10-08')], GLOBAL=[], recent_published_titles=[])
        article = {'source_id': 'JP-01', 'region': 'JP', 'category': '商品', 'title': '片付けのための収納',
                   'summary': '住まいを整理する家具。', 'tags': ['収納']}
        for config in (nitori.CONFIG, daily.CONFIG):
            prompt, _ = engine.build_prompt(config, candidates, '2026-10-09', '2026-10-08')
            self.assertIn('"search_terms"', prompt)
            for terms in (None, [], ['整理', 'organize rooms', 'home storage']):
                result = {'articles': [copy.deepcopy(article)]}
                if terms is not None:
                    result['articles'][0]['search_terms'] = terms
                with patch.dict('os.environ', {'ANTHROPIC_API_KEY': 'test', 'ANTHROPIC_MODEL': '', 'OPENAI_API_KEY': 'test'}), \
                        patch.object(engine, 'call_anthropic_api', return_value=result) as first, \
                        patch.object(engine, 'call_llm_api') as second:
                    generated = engine.analyze_news_with_fallback(config, candidates, '2026-10-09', '2026-10-08')
                first.assert_called_once()
                second.assert_not_called()
                self.assertTrue(valid_search_terms(generated['articles'][0]['search_terms']))
                if terms:
                    self.assertEqual(generated['articles'][0]['search_terms'], terms)

    def test_rule_based_terms_are_grounded_and_deterministic(self):
        from daily_search_terms import fallback_search_terms, prepare_search_terms, valid_search_terms
        samples = [('静かな退職', 'disengaged employees'), ('宅配ボックス', 'receive parcels'),
                   ('需要予測', 'demand forecasts'), ('電子棚札', 'electronic shelf labels'),
                   ('未知のニュース', 'ニュース記事')]
        for title, term in samples:
            article = {'title': title, 'summary': '', 'category': '商品', 'tags': []}
            terms = fallback_search_terms(article)
            self.assertTrue(valid_search_terms(terms))
            self.assertEqual(terms, fallback_search_terms(article))
            self.assertIn(term, terms)
            self.assertEqual(prepare_search_terms({'articles': [article]})['articles'][0]['search_terms'], terms)
        for title in ('Retail', 'chair', 'electronic', 'proposal'):
            terms = fallback_search_terms({'title': title, 'summary': '', 'category': '試験', 'tags': []})
            self.assertNotIn('artificial intelligence', terms)
            self.assertNotIn('online shopping', terms)
            self.assertNotIn('checkout systems', terms)

    def test_ambiguous_company_names_do_not_match_compounds_or_training(self):
        from daily_search_terms import fallback_search_terms, valid_search_terms
        samples = [
            ('小売店がメタバースで仮想店舗を開設', '', 'Meta', False),
            ('メタデータを管理するAIシステム', '', 'Meta', False),
            ('メタ認知を使った人材育成', '', 'Meta', False),
            ('アマゾン、メタのAIエージェントから除外を要請', '', 'Meta', True),
            ('Metaがメタバースの事業を発表', '', 'Meta', True),
            ('メタ・プラットフォームズの決算', '', 'Meta', True),
            ('店長が新人の接客をコーチング', '', 'Coach', False),
            ('服飾ブランドで接客をコーチング', '', 'Coach', False),
            ('接客のコーチ役を配置', '', 'Coach', False),
            ('A coach trains employees', '', 'Coach', False),
            ('コーチが新作バッグを発表', '', 'Coach', True),
            ('Coach announces handbags', '', 'Coach', True),
            ('コーチの新展開', 'タペストリーの服飾ブランド。', 'Coach', True),
            ('服飾ブランド・コーチの新展開', '', 'Coach', True),
        ]
        for title, summary, company, expected in samples:
            with self.subTest(title=title):
                terms = fallback_search_terms({'title': title, 'summary': summary, 'category': '話題', 'tags': []})
                self.assertTrue(valid_search_terms(terms))
                self.assertEqual(company in terms, expected)
                if not expected:
                    self.assertNotIn('大手IT企業' if company == 'Meta' else '服飾ブランド', terms)

    def test_backfill_preserves_history_except_terms_and_never_rebuilds_pages(self):
        import copy
        import tempfile
        from daily_search_terms import valid_search_terms
        for config in (nitori.CONFIG, daily.CONFIG):
            with tempfile.TemporaryDirectory() as directory:
                data_dir, job_dir = Path(directory, 'data'), Path(directory, 'job')
                data_dir.mkdir(); job_dir.mkdir()
                config = {**config, 'data_dir': str(data_dir), 'job_dir': str(job_dir)}
                history = self.history()
                history[0]['x_post_id'] = 'unchanged-post-id'
                history[0]['articles'][0]['search_terms'] = ['整理', 'organize rooms', 'home storage']
                original = copy.deepcopy(history)
                input_before = copy.deepcopy(history)
                engine.save_history(config['data_dir'], history)
                (job_dir / 'index.html').write_bytes(b'existing portal')
                (job_dir / 'rss.xml').write_bytes(b'existing feed')
                old_files = {p.name: p.read_bytes() for p in data_dir.iterdir()}
                self.assertEqual(engine.backfill_search_terms(config, history, dry_run=True), 3)
                self.assertEqual({p.name: p.read_bytes() for p in data_dir.iterdir()}, old_files)
                self.assertEqual(engine.backfill_search_terms(config, history), 3)
                updated = engine.load_history(config['data_dir'])
                for issue in updated:
                    for article in issue['articles']:
                        self.assertTrue(valid_search_terms(article.pop('search_terms')))
                for issue in original:
                    for article in issue['articles']:
                        article.pop('search_terms', None)
                self.assertEqual(updated, original)
                self.assertEqual(history, input_before)
                self.assertEqual(history[0]['articles'][0]['search_terms'], ['整理', 'organize rooms', 'home storage'])
                self.assertNotIn('search_terms', history[1]['articles'][0])
                stored = engine.load_history(config['data_dir'])
                self.assertEqual(engine.backfill_search_terms(config, stored), 0)
                self.assertEqual((job_dir / 'index.html').read_bytes(), b'existing portal')
                self.assertEqual((job_dir / 'rss.xml').read_bytes(), b'existing feed')
                files = engine.build_search_index(config, stored)
                self.assertEqual(len({f['generation'] for f in files.values()}), 1)
                self.assertTrue(all('search_terms' in r for f in files.values() for r in f['records']))

    def test_bad_existing_terms_stop_backfill_before_history_or_indexes_are_written(self):
        import tempfile
        for config in (nitori.CONFIG, daily.CONFIG):
            with tempfile.TemporaryDirectory() as directory:
                data_dir, job_dir = Path(directory, 'data'), Path(directory, 'job')
                data_dir.mkdir(); job_dir.mkdir()
                config = {**config, 'data_dir': str(data_dir), 'job_dir': str(job_dir)}
                history = self.history()
                history[-1]['articles'][0]['search_terms'] = []
                engine.save_history(config['data_dir'], history)
                (job_dir / 'search-index.json').write_bytes(b'previous index')
                old = {str(p): p.read_bytes() for p in Path(directory).rglob('*') if p.is_file()}
                with self.assertRaisesRegex(ValueError, 'search_terms'):
                    engine.backfill_search_terms(config, history)
                self.assertEqual({str(p): p.read_bytes() for p in Path(directory).rglob('*') if p.is_file()}, old)

    def history(self):
        return [
            {'date': '20260101', 'articles': [{'title': '新年の収納 🧺', 'category': '新商品', 'summary': 'e\u0301と家具', 'tags': ['収納']}]},
            {'date': '20251231', 'articles': [{'title': '年末の店舗', 'category': '店舗', 'region': 'GLOBAL'}]},
            {'date': '20240229', 'articles': [{'title': 'うるう日の記事', 'category': '店舗'}, {'title': '同じ号の別記事', 'category': '店舗'}]},
        ]

    def test_invalid_search_fields_stop_generation_before_writing_indexes(self):
        import tempfile
        invalid = [('title', ''), ('title', ' \n'), ('title', ' \ufeff \ufeff '), ('title', None),
                   ('category', ''), ('category', None), ('category', '🧺' * 41),
                   ('category', '店舗\x00'), ('category', '店舗\x85'),
                   ('tags', ['']), ('tags', [None]), ('tags', '店舗')]
        invalid += [(field, value) for field in ('summary', 'source') for value in (None, 0, False, [], {})]
        for config in (nitori.CONFIG, daily.CONFIG):
            for field, value in invalid:
                with self.subTest(media=config['media_id'], field=field, value=value), tempfile.TemporaryDirectory() as directory:
                    history = self.history()
                    history[0]['articles'][0][field] = value
                    path = Path(directory, 'search-index.json')
                    path.write_bytes(b'previous index')
                    with self.assertRaisesRegex(ValueError, field):
                        engine.write_search_indexes({**config, 'job_dir': directory}, history)
                    self.assertEqual(path.read_bytes(), b'previous index')
                    self.assertEqual([p.name for p in Path(directory).iterdir()], ['search-index.json'])
        history = self.history()
        history[0]['articles'][0]['category'] = '🧺' * 40
        self.assertEqual(engine.build_search_index(nitori.CONFIG, history)['search-index.json']['records'][0]['category'], '🧺' * 40)
        for field in ('summary', 'source'):
            history[0]['articles'][0].pop(field, None)
        record = engine.build_search_index(nitori.CONFIG, history)['search-index.json']['records'][0]
        self.assertEqual(record['summary'], '')
        self.assertEqual(record['source'], '')

    def test_bad_article_fields_stop_every_pipeline_before_any_output(self):
        import tempfile
        for config in (nitori.CONFIG, daily.CONFIG):
            for mode in ([], ['--rebuild'], ['--rebuild-search-index'], ['--backfill-search-terms']):
                for field in ('summary', 'source'):
                    with self.subTest(media=config['media_id'], mode=mode, field=field), tempfile.TemporaryDirectory() as directory:
                        config = {**config, 'data_dir': str(Path(directory, 'data')), 'job_dir': str(Path(directory, 'job'))}
                        history = self.history()
                        article = history[0]['articles'][0]
                        article[field] = None
                        with patch('sys.argv', ['daily', '--date', '20261010', *mode]), \
                                patch.object(engine, 'load_history', return_value=history), \
                                patch.object(engine, 'gather_all_candidate_news', return_value={}), \
                                patch.object(engine, 'analyze_news_with_fallback', return_value={'articles': [article]}), \
                                patch.object(engine, 'repair_history_source_links', return_value={0}), \
                                patch.object(engine, 'save_history') as save, \
                                patch.object(engine, 'write_issue_page') as issue, \
                                patch.object(engine, 'write_json_atomic') as index, \
                                patch.object(engine, 'render_top_index_html') as portal, \
                                patch.object(engine, 'generate_rss_xml') as rss, \
                                patch.object(engine, 'trigger_daily_ogp_generation') as ogp:
                            with self.assertRaisesRegex(ValueError, field):
                                engine.run_daily_pipeline(config)
                            for output in (save, issue, index, portal, rss, ogp):
                                output.assert_not_called()
                        self.assertEqual(list(Path(directory).iterdir()), [])

    def test_collection_validation_keeps_existing_portal_and_feed(self):
        import tempfile
        for field in ('summary', 'source'):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                config = {**nitori.CONFIG, 'job_dir': directory}
                for name in ('index.html', 'rss.xml', 'search-index.json'):
                    Path(directory, name).write_bytes(b'previous output')
                history = self.history()
                history[0]['articles'][0][field] = None
                with patch.object(engine, 'render_top_index_html') as portal, patch.object(engine, 'generate_rss_xml') as rss:
                    with self.assertRaisesRegex(ValueError, field):
                        engine.write_collection_outputs(config, history)
                    portal.assert_not_called(); rss.assert_not_called()
                self.assertTrue(all(path.read_bytes() == b'previous output' for path in Path(directory).iterdir()))

    def test_valid_publish_and_rebuild_save_the_validated_search_indexes(self):
        import copy
        import tempfile
        for config in (nitori.CONFIG, daily.CONFIG):
            for mode in ([], ['--rebuild']):
                with self.subTest(media=config['media_id'], mode=mode), tempfile.TemporaryDirectory() as directory:
                    config = {**config, 'data_dir': str(Path(directory, 'data')), 'job_dir': str(Path(directory, 'job'))}
                    Path(config['job_dir']).mkdir()
                    history = self.history()
                    engine.save_history(config['data_dir'], history)
                    article = copy.deepcopy(history[0]['articles'][0])
                    with patch('sys.argv', ['daily', '--date', '20261010', *mode]), \
                            patch.object(engine, 'gather_all_candidate_news', return_value={}), \
                            patch.object(engine, 'analyze_news_with_fallback', return_value={'articles': [article]}), \
                            patch.object(engine, 'repair_history_source_links', return_value=set()), \
                            patch.object(engine, 'write_issue_page', return_value='20261010'), \
                            patch.object(engine, 'render_top_index_html', return_value='<main>portal</main>'), \
                            patch.object(engine, 'generate_rss_xml', return_value='<rss>feed</rss>'), \
                            patch.object(engine, 'trigger_daily_ogp_generation'):
                        engine.run_daily_pipeline(config)
                    stored = engine.load_history(config['data_dir'])
                    if mode:
                        self.assertEqual(stored, history)
                    else:
                        self.assertEqual(stored[0]['date'], '20261010')
                        self.assertEqual(stored[0]['articles'], [article])
                        self.assertEqual(stored[1:], history)
                    for name, payload in engine.build_search_index(config, stored).items():
                        self.assertEqual(json.loads(Path(config['job_dir'], name).read_text(encoding='utf-8')), payload)
                    self.assertEqual(Path(config['job_dir'], 'index.html').read_text(encoding='utf-8'), '<main>portal</main>\n')
                    self.assertEqual(Path(config['job_dir'], 'rss.xml').read_text(encoding='utf-8'), '<rss>feed</rss>\n')

    def test_generation_is_shared_by_all_years_and_stable_on_rebuild(self):
        for config in (nitori.CONFIG, daily.CONFIG):
            with self.subTest(media=config['media_id']):
                history = self.history()
                files = engine.build_search_index(config, history)
                self.assertEqual(files, engine.build_search_index(config, list(reversed(history))))
                self.assertEqual(files['search-index.json']['years'], ['2026', '2025', '2024'])
                generations = {payload['generation'] for payload in files.values()}
                self.assertEqual(len(generations), 1)
                self.assertRegex(generations.pop(), r'^[0-9a-f]{16}$')
                # 過去の年だけの更新も、全ファイルの版を更新する。
                history[-1]['articles'][0]['summary'] = '過去の記事の追記'
                updated = engine.build_search_index(config, history)
                for filename in files:
                    self.assertNotEqual(files[filename]['generation'], updated[filename]['generation'])
                self.assertEqual(files['search-index.json']['records'], updated['search-index.json']['records'])
                self.assertEqual([r['url'] for r in files['search-index-2024.json']['records']],
                                 ['20240229/#art-1', '20240229/#art-2'])

    def test_empty_index_has_generation_and_media_is_part_of_generation(self):
        first = engine.build_search_index(nitori.CONFIG, [])['search-index.json']
        second = engine.build_search_index(daily.CONFIG, [])['search-index.json']
        self.assertEqual(first['years'], [])
        self.assertEqual(first['records'], [])
        self.assertRegex(first['generation'], r'^[0-9a-f]{16}$')
        self.assertNotEqual(first['generation'], second['generation'])

    def test_index_only_rebuild_preserves_pages_and_writes_every_year(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            portal = Path(directory, 'index.html')
            portal.write_text('<script type="application/ld+json">{"dateModified":"2026-10-09"}</script>', encoding='utf-8')
            before = portal.read_bytes()
            config = {**nitori.CONFIG, 'job_dir': directory}
            files = engine.write_search_indexes(config, self.history())
            self.assertEqual(portal.read_bytes(), before)
            snapshots = [json.loads(Path(directory, name).read_text(encoding='utf-8')) for name in files]
            self.assertEqual(len(snapshots), 3)
            self.assertEqual(len({s['generation'] for s in snapshots}), 1)
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), sorted(['index.html'] + files))


class RebuildOutputTest(unittest.TestCase):
    def test_rss_is_kept_when_only_build_date_differs(self):
        import tempfile, os
        feed = '<rss><channel><lastBuildDate>Wed, 07 Oct 2026 06:00:00 +0900</lastBuildDate><item>a</item></channel></rss>'
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'rss.xml')
            self.assertFalse(engine._same_except_build_date(path, feed))  # ファイルが無ければ書く
            with open(path, 'w', encoding='utf-8') as f:
                f.write(feed)
            self.assertTrue(engine._same_except_build_date(path, feed.replace('06:00:00', '09:30:00')))
            self.assertFalse(engine._same_except_build_date(path, feed.replace('<item>a</item>', '<item>b</item>')))

if __name__ == '__main__':
    unittest.main()
