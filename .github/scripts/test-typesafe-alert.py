"""TypeSafeの課金エラー通知とActionsの呼び出し経路を、外部通信なしで確認する。"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

import nitori_social_filter as social
import typesafe_alert as alert

spec = importlib.util.spec_from_file_location('ai_models', Path(__file__).with_name('ai_models.py'))
models = importlib.util.module_from_spec(spec)
spec.loader.exec_module(models)

ENV = {
    'GITHUB_ACTIONS': 'true', 'RESEND_API_KEY': 'private-mail-key',
    'ALERT_FROM': 'MAGI <from@example.test>', 'ALERT_TO': 'first@example.test, second@example.test',
    'GITHUB_REPOSITORY': 'tk33r1/st', 'GITHUB_RUN_ID': '123',
}


def error(status, body='private upstream text'):
    return urllib.error.HTTPError(social.ENDPOINT, status, 'error', {}, io.BytesIO(body.encode()))


class MailResponse(io.BytesIO):
    status = 200


class AlertTests(unittest.TestCase):
    def setUp(self):
        alert._sent.clear()
        alert._missing_warned = False
        self.env = patch.dict(os.environ, ENV, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_billing_and_auth_errors_notify_but_rate_limits_and_server_errors_do_not(self):
        for status, body, expected in [(401, 'private', 1), (402, 'private', 1), (403, 'private', 1),
                                       (429, 'insufficient_quota private', 1), (429, 'rate limited', 0),
                                       (400, 'bad request', 0), (500, 'balance', 0)]:
            alert._sent.clear()
            with self.subTest(status=status, body=body), patch.object(alert.urllib.request, 'urlopen', return_value=MailResponse()) as send, redirect_stdout(io.StringIO()):
                alert.notify_http_error(error(status, body))
                self.assertEqual(send.call_count, expected)

    def test_parallel_failures_send_once_and_preserve_addresses_without_leaking_content(self):
        output = io.StringIO()
        with patch.object(alert.urllib.request, 'urlopen', return_value=MailResponse()) as send, redirect_stdout(output):
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda _: alert.notify_http_error(error(402)), range(12)))
        self.assertEqual(send.call_count, 1)
        request = send.call_args.args[0]
        self.assertEqual(request.full_url, 'https://api.resend.com/emails')
        payload = json.loads(request.data)
        self.assertEqual(payload['from'], ENV['ALERT_FROM'])
        self.assertEqual(payload['to'], ['first@example.test', 'second@example.test'])
        self.assertIn('https://github.com/tk33r1/st/actions/runs/123', payload['text'])
        for secret in ('private upstream text', 'private-mail-key'):
            self.assertNotIn(secret, request.data.decode() + output.getvalue())

    def test_send_failure_can_retry_and_does_not_raise_or_log_details(self):
        for failure in (TimeoutError('private-mail-key'), error(403, 'private upstream text')):
            alert._sent.clear()
            output = io.StringIO()
            with patch.object(alert.urllib.request, 'urlopen', side_effect=[failure, MailResponse()]) as send, redirect_stderr(output), redirect_stdout(output):
                alert.notify_http_error(error(402))
                alert.notify_http_error(error(402))
                alert.notify_http_error(error(402))
            self.assertEqual(send.call_count, 2)
            self.assertNotIn('private', output.getvalue())

    def test_missing_mail_configuration_warns_once_and_local_runs_do_not_send(self):
        for name in ('RESEND_API_KEY', 'ALERT_FROM', 'ALERT_TO'):
            alert._missing_warned = False
            output = io.StringIO()
            with patch.dict(os.environ, {name: ''}), patch.object(alert.urllib.request, 'urlopen') as send, redirect_stderr(output):
                alert.notify_http_error(error(402))
                alert.notify_http_error(error(402))
                send.assert_not_called()
            self.assertEqual(output.getvalue().count('::warning::'), 1)
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}), patch.object(alert.urllib.request, 'urlopen') as send:
            alert.notify_http_error(error(402))
            send.assert_not_called()

    def test_social_and_smoke_failures_reach_notifier_and_keep_existing_failure_behavior(self):
        for module, invoke, exception in [
            (social, lambda: social.classify({'text': 'private post'}, 'private-key', 'test-model'), social.ClassificationError),
            (models, lambda: models.post_json(social.ENDPOINT, 'private-key', {}), RuntimeError),
        ]:
            upstream = error(402)
            with patch.object(module.urllib.request, 'urlopen', side_effect=upstream), patch.object(module, 'notify_http_error') as notify:
                with self.assertRaises(exception) as failure:
                    invoke()
                notify.assert_called_once_with(upstream)
                self.assertNotIn('private', str(failure.exception))
        with patch.object(models.urllib.request, 'urlopen', side_effect=error(402)), patch.object(models, 'notify_http_error') as notify:
            with self.assertRaises(RuntimeError):
                models.post_json('https://api.openai.com/v1/chat/completions', 'test', {})
            notify.assert_not_called()

if __name__ == '__main__':
    unittest.main()
