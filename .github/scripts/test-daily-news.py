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
            with self.subTest(mode=mode), patch.dict('os.environ', {'OPENAI_API_KEY': '' if mode == 'missing_keys' else 'test', 'DEEPSEEK_API_KEY': '' if mode == 'missing_keys' else 'test'}), patch.object(engine, 'call_llm_api', side_effect=RuntimeError('test outage')):
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
