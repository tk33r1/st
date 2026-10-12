"""Messages APIの共通呼び出し。API・キー・生成物を使わずに境界を検査する。"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import patch

import anthropic_api as api


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class AnthropicApiTest(unittest.TestCase):
    def test_card_and_x_share_transport_without_sampling(self):
        mc = module('magi_context_test', 'magi-context.py')
        seen = []
        def post(endpoint, key, payload, user_agent, **options):
            seen.append(payload)
            return {'stop_reason': 'end_turn', 'content': [{'type': 'thinking', 'thinking': 'private'}, {'type': 'text', 'text': 'answer'}]}
        with patch.object(api, 'post_messages', side_effect=post):
            self.assertEqual(mc.call_anthropic('private', 'system', 'public source'), 'answer')
            self.assertEqual(mc.call_anthropic('private', 'system', [{'type': 'image_url', 'image_url': {'url': 'https://pbs.twimg.com/media/public.jpg'}}]), 'answer')
        self.assertEqual(seen[0]['max_tokens'], 4000)
        self.assertEqual(seen[0]['thinking'], {'type': 'disabled'})
        self.assertEqual(seen[0]['output_config'], {'effort': 'low'})
        self.assertEqual(seen[1]['messages'][0]['content'][0], {'type': 'image', 'source': {'type': 'url', 'url': 'https://pbs.twimg.com/media/public.jpg'}})
        for payload in seen:
            self.assertNotIn('temperature', payload)
            self.assertNotIn('top_p', payload)

    def test_daily_keeps_adaptive_tokens_and_json_validation(self):
        import daily_engine
        seen = []
        def post(endpoint, key, payload, user_agent, **options):
            seen.append(payload)
            return {'stop_reason': 'end_turn', 'content': [{'type': 'thinking', 'thinking': 'private'}, {'type': 'text', 'text': '```json\n{"ok":true}\n```'}]}
        with patch.object(api, 'post_messages', side_effect=post):
            self.assertEqual(daily_engine.call_anthropic_api('mock', 'private', 'model', 'public', 'test'), {'ok': True})
        self.assertEqual(seen[0]['max_tokens'], 16384)
        self.assertEqual(seen[0]['thinking'], {'type': 'adaptive'})
        self.assertEqual(seen[0]['output_config'], {'effort': 'medium'})

    def test_refusal_and_truncation_do_not_retry(self):
        for reason in ['refusal', 'max_tokens', None]:
            body = {'stop_reason': reason, 'content': [{'type': 'text', 'text': 'partial'}]}
            with patch.object(api, 'post_messages', return_value=body) as post:
                with self.assertRaises(RuntimeError):
                    api.call_messages('mock', 'private', {}, 'test', retry_waits=(1, 2))
            self.assertEqual(post.call_count, 1)
        self.assertEqual(api.message_text({'stop_reason': 'max_tokens', 'content': [{'type': 'text', 'text': 'partial'}]}, allow_partial=True), 'partial')

    def test_transient_http_retries_and_headers_do_not_expose_key(self):
        private = 'DO_NOT_LOG_PRIVATE_KEY_OR_BODY'
        for status, retries in [(401, 1), (400, 1), (429, 2), (500, 2)]:
            response = contextlib.nullcontext(io.BytesIO(json.dumps({'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': 'answer'}]}).encode()))
            error = urllib.error.HTTPError('mock', status, 'failure', {}, io.BytesIO(private.encode()))
            stderr = io.StringIO()
            with patch.object(api.urllib.request, 'urlopen', side_effect=[error, response]) as open_request, patch.object(api.time, 'sleep'), contextlib.redirect_stderr(stderr):
                if retries == 1:
                    with self.assertRaises(RuntimeError) as raised:
                        api.call_messages(api.ENDPOINT, private, {}, 'test', retry_waits=(1,))
                    self.assertNotIn(private, str(raised.exception))
                else:
                    self.assertEqual(api.call_messages(api.ENDPOINT, private, {}, 'test', retry_waits=(1,)), 'answer')
            self.assertEqual(open_request.call_count, retries)
            headers = dict(open_request.call_args_list[0].args[0].header_items())
            self.assertEqual(headers['X-api-key'], private)
            self.assertEqual(headers['Anthropic-version'], '2023-06-01')
            self.assertNotIn('Authorization', headers)
            self.assertNotIn(private, stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
