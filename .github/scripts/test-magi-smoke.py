"""週次MAGI smokeの設定共有・候補モデル・入力を外部APIなしで確認する。"""
import copy
import json
import unittest
from unittest.mock import patch
import ai_models


class MagiSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = ai_models.magi_config()

    def test_discussion_settings_and_candidate_override(self):
        config = copy.deepcopy(self.config)
        for entry in config['discussion']['personas']:
            name = 'max_completion_tokens' if entry['provider'] == 'openai' else 'max_tokens'
            entry['body'][name] = 777
            entry['body']['top_p'] = .87
        config['discussion']['synthesizer']['body']['max_completion_tokens'] = 1777
        for provider in ['openai', 'deepseek', 'google']:
            with self.subTest(provider=provider):
                sent = []
                def post(url, key, body, stream=False):
                    sent.append((body, stream))
                    return {'choices': [{'finish_reason': 'stop', 'message': {'content': 'OK'}}]}
                with patch.object(ai_models, 'post_json', side_effect=post):
                    ai_models.smoke_magi_discussion('mock', 'private', 'candidate-for-test', provider, config)
                persona = next(p['body'] for p in config['discussion']['personas'] if p['provider'] == provider)
                expected = {**persona, 'model': 'candidate-for-test'}
                self.assertEqual(sent[0], (expected, False))
                self.assertEqual(sent[1][0]['messages'][:-1], expected['messages'])
                self.assertIn('image_url', sent[1][0]['messages'][-1]['content'][1])
                for body, _ in sent:
                    self.assertEqual(body['model'], 'candidate-for-test')
                if provider == config['discussion']['synthesizer']['provider']:
                    self.assertEqual(sent[2], ({**config['discussion']['synthesizer']['body'], 'model': 'candidate-for-test'}, True))
                    self.assertNotIn('temperature', sent[2][0])
                    self.assertNotIn('top_p', sent[2][0])
                else:
                    self.assertEqual(len(sent), 2)

    def test_site_requests_keep_prompts_and_settings(self):
        sent = []
        cases = self.config['site_smoke'] + self.config['site_schema_smoke']
        def post(url, key, body):
            case = cases[len(sent)]
            sent.append(body)
            return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(case['expected'])}}]}
        with patch.object(ai_models, 'post_json', side_effect=post):
            ai_models.smoke_openai_site_search('mock', 'private', 'candidate-for-test', self.config)
        self.assertEqual([c['purpose'] for c in cases[:4]], ['requested', 'requested', 'auxiliary', 'auxiliary'])
        self.assertEqual([c['expected']['daily'] is None for c in cases[4:]], [True, False])
        for body, case in zip(sent, cases):
            self.assertEqual(body, {**case['body'], 'model': 'candidate-for-test'})
            if 'purpose' in case:
                self.assertNotIn('Return exactly', json.dumps(body))
                self.assertIn('公開ページ一覧', body['messages'][0]['content'])
            else:
                self.assertIn('Return exactly', body['messages'][0]['content'])
                self.assertEqual(body['response_format'], cases[0]['body']['response_format'])
        self.assertNotEqual(cases[0]['body']['messages'][0]['content'], cases[2]['body']['messages'][0]['content'])

    def test_site_validator_accepts_query_variation_and_rejects_unknown_ids(self):
        cases = self.config['site_smoke'] + self.config['site_schema_smoke']
        def post(url, key, body):
            case = next(c for c in cases if c['body'] == {**body, 'model': c['body']['model']})
            value = copy.deepcopy(case['expected'])
            if value['daily'] and 'purpose' in case:
                value['daily']['query'] = '店舗'
            return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(value)}}]}
        with patch.object(ai_models, 'post_json', side_effect=post):
            ai_models.smoke_openai_site_search('mock', 'private', 'candidate-for-test', self.config)
        for value in [{'selections': ['unknown-id'], 'daily': None},
                      {'selections': [], 'daily': {'media': 'unknown', 'query': '店舗'}}]:
            with self.subTest(value=value):
                invalid = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(value)}}]}
                with patch.object(ai_models, 'post_json', return_value=invalid), self.assertRaises(ai_models.subprocess.CalledProcessError):
                    ai_models.smoke_openai_site_search('mock', 'private', 'candidate-for-test', self.config)

    def test_daily_choice_is_observation_but_schema_both_sides_are_required(self):
        cases = self.config['site_smoke'] + self.config['site_schema_smoke']
        for daily in [None, {'media': 'nitori', 'query': '店舗'}, {'media': 'retail', 'query': '店舗'}]:
            with self.subTest(daily=daily):
                sent = []
                def post(url, key, body):
                    case = cases[len(sent)]
                    sent.append(body)
                    value = {'selections': [], 'daily': daily} if 'purpose' in case else case['expected']
                    return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(value)}}]}
                with patch.object(ai_models, 'post_json', side_effect=post):
                    observations = ai_models.smoke_openai_site_search('mock', 'private', 'candidate-for-test', self.config)
                self.assertEqual([o['daily'] for o in observations], [daily is not None] * 4)
                self.assertEqual(len(sent), 6)
        sent = []
        def missing_object(url, key, body):
            case = cases[len(sent)]
            sent.append(body)
            value = {**case['expected'], 'daily': None}
            return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(value)}}]}
        with patch.object(ai_models, 'post_json', side_effect=missing_object), self.assertRaisesRegex(RuntimeError, 'nullable'):
            ai_models.smoke_openai_site_search('mock', 'private', 'candidate-for-test', self.config)

    def test_votable_both_choices_and_no_smoke_threshold(self):
        expected = [c['expected'].get('votable') for c in self.config['classify_smoke']]
        self.assertIn('yes', expected)
        self.assertIn('no', expected)
        questions = [set(c['payload']['questions']) for c in self.config['classify_smoke']]
        self.assertEqual(questions[0], {'language', 'votable', 'intent', 'site_pages'})
        self.assertEqual(questions[2], questions[0])
        self.assertEqual(questions[1], {'votable', 'intent', 'site_pages'})
        self.assertEqual(questions[3:5], [questions[1], questions[1]])
        self.assertTrue(all(q == {'language'} for q in questions[5:]))
        # Jevの形式検査は閾値を使わず、0.68でも明確なchoiceなら受け付ける。
        sent = []
        def post(url, key, body):
            case = self.config['classify_smoke'][len(sent)]
            sent.append(body)
            return {'answers': {name: {'type': question['type'], 'choice': case['expected'].get(name, next(iter(question['criteria']))),
                                      'confidence': .68} for name, question in body['questions'].items()}}
        with patch.object(ai_models, 'post_json', side_effect=post):
            observations = ai_models.smoke_magi_classification('mock', 'private', 'candidate-for-test', self.config)
        self.assertEqual(len(sent), len(self.config['classify_smoke']))
        self.assertEqual(len(observations), len(sent))

    def test_persona_accepts_nonempty_partial_but_rejects_missing_text(self):
        for provider in ['openai', 'deepseek', 'google']:
            for content in ['partial', '', '   ', None]:
                with self.subTest(provider=provider, content=content):
                    response = {'choices': [{'finish_reason': 'length', 'message': {'content': content}}]}
                    with patch.object(ai_models, 'post_json', return_value=response):
                        if content == 'partial':
                            ai_models.smoke_magi_discussion('mock', 'private', 'candidate-for-test', provider, self.config)
                        else:
                            with self.assertRaises(RuntimeError):
                                ai_models.smoke_magi_discussion('mock', 'private', 'candidate-for-test', provider, self.config)

    def test_classification_rejects_missing_or_wrong_type_in_every_profile(self):
        for case_number, case in enumerate(self.config['classify_smoke'], 1):
            for name in case['payload']['questions']:
                for invalid in [None, 'score']:
                    with self.subTest(case=case_number, question=name, invalid=invalid):
                        answers = {key: {'type': question['type'],
                                         'choice': case['expected'].get(key, next(iter(question['criteria']))),
                                         'confidence': .68}
                                   for key, question in case['payload']['questions'].items()}
                        if invalid is None:
                            answers[name].pop('type')
                        else:
                            answers[name]['type'] = invalid
                        config = {'classify_smoke': [case]}
                        with patch.object(ai_models, 'post_json', return_value={'answers': answers}), self.assertRaisesRegex(RuntimeError, 'type'):
                            ai_models.smoke_magi_classification('mock', 'private', 'candidate-for-test', config)

    def test_synthesis_still_requires_normal_stream_completion(self):
        for finish, done in [('stop', True), ('length', True), ('stop', False)]:
            with self.subTest(finish=finish, done=done):
                raw = 'data: ' + json.dumps({'choices': [{'delta': {'content': 'answer'}, 'finish_reason': finish}]}) + '\n\n'
                if done:
                    raw += 'data: [DONE]\n\n'
                if finish == 'stop' and done:
                    ai_models.validate_chat_stream(raw)
                else:
                    with self.assertRaises(RuntimeError):
                        ai_models.validate_chat_stream(raw)

    def test_magi_schema_smoke_uses_production_request_body(self):
        config = copy.deepcopy(self.config['magi'])
        sent = []
        expected = [{'motion': 'Go for ramen tonight', 'votable': True},
                    {'votes': [{'codename': 'CASPER-3', 'vote': 'reject'}]}]
        for cfg in config.values():
            cfg['body']['max_completion_tokens'] = 777
            cfg['body']['temperature'] = .87
        def post(url, key, body):
            value = expected[len(sent)]
            sent.append(body)
            return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(value)}}]}
        with patch.object(ai_models, 'post_json', side_effect=post):
            ai_models.smoke_openai_magi('mock', 'private', 'candidate-for-test', config)
        for body, name in zip(sent, ['motion', 'vote_reader']):
            self.assertEqual(body, {**config[name]['body'], 'model': 'candidate-for-test'})
            self.assertEqual(body['response_format'], config[name]['format'])
        self.assertIn(self.config['magi']['vote_reader']['prompt'], sent[1]['messages'][0]['content'])
        self.assertNotIn('Write in English.', sent[1]['messages'][0]['content'])


if __name__ == '__main__':
    unittest.main()
