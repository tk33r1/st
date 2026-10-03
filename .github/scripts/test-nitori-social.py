#!/usr/bin/env python3
"""日刊ニトリの採否・収集順序・障害時の動作を、外部通信なしで確認する。"""

from datetime import datetime, timedelta
from contextlib import redirect_stderr
import http.client
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import brightdata_social as social
import daily_engine as engine
import nitori_social_filter as gate

spec = importlib.util.spec_from_file_location('nitori_daily', Path(__file__).with_name('generate-nitori-daily.py'))
daily = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daily)


def item(text='ニトリのテレビ台を買った', **extra):
    return dict(platform='x', author='@consumer', raw_text=text, **extra)


class ContentFilterTests(unittest.TestCase):
    def test_failure_and_rejection_do_not_drop_successful_posts(self):
        def classify(state, key, model):
            if state['text'] == '通信失敗':
                raise gate.ClassificationError('HTTP 503')
            return 0.1 if state['text'] == 'ニトリ株を買った' else 0.98
        candidates = [item(), item('通信失敗'), item('母へのプレゼントにニトリを買った'), item('ニトリ株を買った')]
        with patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', side_effect=classify):
            result = gate.filter_consumer_posts(candidates, 'test')
        self.assertEqual([x['raw_text'] for x in result], [candidates[0]['raw_text'], candidates[2]['raw_text']])

    def test_missing_key_does_not_fall_back_to_keywords(self):
        with patch.object(gate, 'api_key', return_value=''), patch.object(gate, 'classify') as classify:
            self.assertEqual(gate.filter_consumer_posts([item()], 'test'), [])
            classify.assert_not_called()

    def test_cache_reuses_only_matching_content_and_settings(self):
        with patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', return_value=.98):
            accepted = gate.filter_consumer_posts([item()], 'test')
        with patch.object(gate, 'api_key', return_value=''), patch.object(gate, 'classify') as classify:
            self.assertEqual(gate.filter_consumer_posts(accepted, 'test'), accepted)
            changed = dict(accepted[0], raw_text='ニトリ株を買った')
            self.assertEqual(gate.filter_consumer_posts([changed], 'test'), [])
            with patch.object(gate, 'MIN_PROBABILITY', .7):
                self.assertEqual(gate.filter_consumer_posts(accepted, 'test'), [])
            with patch.object(gate, 'model_id', return_value='changed-model'):
                self.assertEqual(gate.filter_consumer_posts(accepted, 'test'), [])
            classify.assert_not_called()

    def test_invalid_responses_and_timeouts_fail_closed(self):
        bodies = [b'not json', b'{}', b'{"answers":{"consumer_post":{"type":"noul","noul":true}}}',
                  b'{"answers":{"consumer_post":{"type":"noul","noul":1e999}}}',
                  json.dumps({'answers': {'consumer_post': {'type': 'noul', 'noul': 10**400}}}).encode()]
        for body in bodies:
            with self.subTest(body=body), patch.object(gate.urllib.request, 'urlopen', return_value=io.BytesIO(body)):
                with self.assertRaises(gate.ClassificationError):
                    gate.classify(gate.state_for(item()), 'test', 'test-model')
        for error in (TimeoutError('sensitive upstream detail'), urllib.error.HTTPError('url', 429, 'rate limit', {}, None)):
            with patch.object(gate.urllib.request, 'urlopen', side_effect=error):
                with self.assertRaises(gate.ClassificationError) as failure:
                    gate.classify(gate.state_for(item()), 'test', 'test-model')
                self.assertNotIn('sensitive', str(failure.exception))

    def test_interrupted_response_does_not_drop_other_posts_or_log_body(self):
        class InterruptedResponse(io.BytesIO):
            def read(self, *args):
                raise http.client.IncompleteRead(b'sensitive upstream body', 100)

        def urlopen(request, timeout):
            state = json.loads(request.data)['state']
            if state['text'] == '途切れた投稿':
                return InterruptedResponse()
            return io.BytesIO(b'{"answers":{"consumer_post":{"type":"noul","noul":0.98}}}')

        candidates = [item(), item('途切れた投稿'), item('ニトリの収納を買った')]
        warnings = io.StringIO()
        with patch.object(gate, 'api_key', return_value='test-api-key'), patch.object(gate.urllib.request, 'urlopen', side_effect=urlopen), redirect_stderr(warnings):
            result = gate.filter_consumer_posts(candidates, 'test')
        self.assertEqual([x['raw_text'] for x in result], [candidates[0]['raw_text'], candidates[2]['raw_text']])
        self.assertIn('IncompleteRead', warnings.getvalue())
        self.assertNotIn('sensitive upstream body', warnings.getvalue())
        self.assertNotIn('test-api-key', warnings.getvalue())


class CollectionTests(unittest.TestCase):
    def test_daily_pipeline_keeps_jev_accepted_gifts_but_filters_news_and_past_posts(self):
        now = datetime(2026, 10, 4, tzinfo=daily.JST)
        post = item('母へのプレゼントにニトリのクッションを買った',
                    title='母へのプレゼントにニトリのクッションを買った',
                    link='https://example.com/post', is_sns_raw=True,
                    pub_ts=(now-timedelta(hours=12)).timestamp(), source='X', description='購入体験')
        news = dict(post, link='https://example.com/news', is_sns_raw=False)
        config = dict(daily.CONFIG, extra_candidates_fn=lambda date: [post])
        with patch.object(engine, 'fetch_google_news_rss', return_value=[news]), patch.object(engine, 'load_recent_published_history', return_value={}):
            candidates = engine.gather_all_candidate_news(config, now)
        self.assertEqual([p['link'] for p in candidates['EXTRA']], [post['link']])
        self.assertEqual(candidates['JP'], [])
        with patch.object(engine, 'fetch_google_news_rss', return_value=[]), patch.object(engine, 'load_recent_published_history', return_value={'recent_urls': {post['link']}}):
            candidates = engine.gather_all_candidate_news(config, now)
        self.assertEqual(candidates['EXTRA'], [])

    def test_x_classifies_before_limit_and_keeps_yesterday_and_unique_urls(self):
        def tweet(n, text, when='昨日 12:00'):
            return (f'<p class="Tweet_body__test">{text}</p>'
                    f'<a class="Tweet_authorID__test">@<!-- -->consumer</a>'
                    f'<time class="Tweet_time__test"><a href="https://x.com/consumer/status/{n}">{when}</a></time>')
        content = ''.join(tweet(n, 'ニトリ公式PR' if n == 0 else f'ニトリのテレビ台{n}') for n in range(7))
        content += tweet(7, 'ニトリの今日の買い物', '12:00') + tweet(1, '重複')
        def select(candidates, label):
            self.assertEqual(len(candidates), 7)
            self.assertTrue(any('テレビ台' in x['raw_text'] for x in candidates))
            return candidates[1:]
        with patch.object(daily.urllib.request, 'urlopen', return_value=io.BytesIO(content.encode())), patch.object(daily, 'filter_consumer_posts', side_effect=select):
            result = daily.fetch_yahoo_realtime_nitori_buzz(datetime(2026, 10, 4, tzinfo=daily.JST))
        self.assertEqual(len(result), 5)
        self.assertEqual([x['link'].rsplit('/', 1)[-1] for x in result], ['1', '2', '3', '4', '5'])

    def test_tiktok_filters_window_views_duplicates_then_content_before_limit(self):
        now = datetime(2026, 10, 4, 12, tzinfo=social.JST)
        def row(n, text, days=1, views=20000):
            return dict(description=text, hashtags=['ニトリ'], create_time=(now-timedelta(days=days)).isoformat(),
                        url=f'https://www.tiktok.com/@consumer/video/{n}', profile_username='表示名', play_count=views)
        rows = [row(1, 'テレビ台をプレゼントに購入', views=30000), row(2, '株を買った', views=40000),
                row(1, '重複'), row(3, '古い投稿', days=8), row(4, '再生不足', views=9999)]
        def select(candidates, label):
            self.assertEqual(len(candidates), 2)
            self.assertEqual(candidates[0]['raw_text'], '株を買った')
            state = gate.state_for(candidates[1])
            self.assertIn('ニトリ', state['text'])
            self.assertEqual(state['author'], '@consumer')
            return candidates[1:]
        with patch.object(social, '_api_key', return_value='test'), patch.object(social, '_scrape', return_value=rows), patch.object(social, 'filter_consumer_posts', side_effect=select):
            result = social.fetch_tiktok_buzz(['ニトリ'], now, limit=1)
        self.assertEqual(result[0]['link'], 'https://www.tiktok.com/@consumer/video/1')

    def test_legacy_snapshots_are_classified_and_stale_snapshots_skip_api(self):
        now = datetime(2026, 10, 4, 12, tzinfo=social.JST)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'snapshot.json'
            path.write_text(json.dumps({'captured_at': now.isoformat(), 'items': [item()]}), encoding='utf-8')
            with patch.object(gate, 'api_key', return_value='test'), patch.object(gate, 'classify', return_value=.1) as classify:
                self.assertEqual(social.load_snapshot(path, now), [])
                classify.assert_called_once()
                classify.reset_mock()
                self.assertEqual(social.load_snapshot(path, now + timedelta(hours=37)), [])
                classify.assert_not_called()

    def test_capture_failure_keeps_existing_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'snapshot.json'
            path.write_text('previous snapshot', encoding='utf-8')
            with patch.object(social, 'fetch_tiktok_buzz', return_value=[]):
                social.capture_snapshot(path, ['ニトリ'])
            self.assertEqual(path.read_text(encoding='utf-8'), 'previous snapshot')


if __name__ == '__main__':
    unittest.main()
