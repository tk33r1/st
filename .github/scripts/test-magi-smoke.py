"""週次MAGI smokeの設定共有・候補モデル・入力を外部APIなしで確認する。"""
import copy
import json
import unittest
from unittest.mock import patch
import ai_models


def web_stream(provider):
    citation = {'url': 'https://example.com/', 'title': 'source'}
    if provider == 'openai':
        events = [
            {'type': 'response.output_item.done', 'item': {'type': 'web_search_call', 'status': 'completed', 'action': {'sources': [citation]}}},
            {'type': 'response.output_text.delta', 'output_index': 1, 'content_index': 0, 'delta': 'answer'},
            {'type': 'response.output_text.annotation.added', 'output_index': 1, 'content_index': 0, 'annotation': {**citation, 'type': 'url_citation', 'start_index': 0, 'end_index': 6}},
            {'type': 'response.completed', 'response': {'status': 'completed'}},
        ]
    else:
        events = [
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'web_search_tool_result', 'content': [{**citation, 'type': 'web_search_result'}]}},
            {'type': 'content_block_start', 'index': 1, 'content_block': {'type': 'text', 'text': 'answer', 'citations': [{**citation, 'type': 'web_search_result_location'}]}},
            {'type': 'content_block_stop', 'index': 1}, {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}}, {'type': 'message_stop'},
        ]
    return ''.join('data: ' + json.dumps(e) + '\n\n' for e in events)


def verifier_reply(provider, value=None, reason=None):
    value = value or {'parts': [{'label': 'Current exhibition', 'text': 'The current status is unverified.',
                                'status': 'unverified', 'citations': [{'n': 1, 'blocks': [0]}]}]}
    if provider == 'anthropic':
        return {'content': [{'type': 'text', 'text': json.dumps(value)}], 'stop_reason': reason or 'end_turn'}
    return {'choices': [{'message': {'content': json.dumps(value)}, 'finish_reason': reason or 'stop'}]}


def is_verifier(body):
    return (body.get('response_format', {}).get('json_schema', {}).get('name') == 'research_verified_reply'
            or 'parts' in body.get('output_config', {}).get('format', {}).get('schema', {}).get('properties', {}))


class MagiSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = ai_models.magi_config()

    def test_discussion_settings_and_candidate_override(self):
        config = copy.deepcopy(self.config)
        for entry in config['discussion']['personas']:
            name = 'max_completion_tokens' if entry['provider'] == 'openai' else 'max_tokens'
            entry['body'][name] = 777
            if entry['provider'] != 'anthropic':
                entry['body']['top_p'] = .87
        config['discussion']['synthesizer']['body']['max_completion_tokens'] = 1777
        for provider in ['openai', 'deepseek', 'anthropic']:
            with self.subTest(provider=provider):
                sent = []
                def post(url, key, body, stream=False):
                    sent.append((body, stream))
                    if body.get('tools'):
                        return web_stream(provider)
                    if is_verifier(body):
                        return verifier_reply(provider)
                    return {'choices': [{'finish_reason': 'stop', 'message': {'content': 'OK'}}]}
                with patch.object(ai_models, 'post_json', side_effect=post):
                    ai_models.smoke_magi_discussion('mock', 'private', 'candidate-for-test', provider, config)
                persona = next(p['body'] for p in config['discussion']['personas'] if p['provider'] == provider)
                expected = {**persona, 'model': 'candidate-for-test'}
                self.assertEqual(sent[0], (expected, False))
                self.assertEqual(sent[1][0]['messages'][:-1], expected['messages'])
                image = sent[1][0]['messages'][-1]['content'][1]
                if provider == 'anthropic':
                    self.assertEqual(image['source']['type'], 'base64')
                    for body, _ in sent:
                        self.assertNotIn('temperature', body)
                        self.assertNotIn('top_p', body)
                else:
                    self.assertIn('image_url', image)
                for body, _ in sent:
                    self.assertEqual(body['model'], 'candidate-for-test')
                name = 'synthesizer_dark' if provider == 'anthropic' else 'synthesizer'
                if provider == config['discussion'][name]['provider']:
                    self.assertEqual(sent[2], ({**config['discussion'][name]['body'], 'model': 'candidate-for-test'}, True))
                    self.assertNotIn('temperature', sent[2][0])
                    self.assertNotIn('top_p', sent[2][0])
                else:
                    self.assertEqual(len(sent), 2)
                # 悪意への短い返しは、統合のモデルを推論なしでストリーミングする本番の形を最後に送る
                replies = [({**r['body'], 'model': 'candidate-for-test'}, True)
                           for r in config['discussion']['malice_reply'] if r['provider'] == provider]
                start = 3 if provider != 'deepseek' else 2
                self.assertEqual(sent[start:start + len(replies)], replies)
                additions = config['fact_smoke'] + config['research_smoke'] + config['verify_smoke']
                self.assertEqual(sent[start + len(replies):], [({**r['body'], 'model': 'candidate-for-test'}, r['body']['stream'])
                                 for r in additions if r['provider'] == provider])
                for r in additions:
                    if r['provider'] != provider:
                        continue
                    body = r['body']
                    # Webはmedium、Webなしの直接回答はlow。本番の別設定を混同しない。
                    actual = (body.get('reasoning', {}).get('effort') if body.get('input')
                              else body.get('reasoning_effort') if provider == 'openai'
                              else body['output_config']['effort'])
                    self.assertEqual(actual, 'medium' if body.get('tools') or is_verifier(body) else 'low')
                for body, _ in replies:
                    if provider == 'openai':
                        self.assertEqual(body['reasoning_effort'], 'none')
                    else:
                        self.assertEqual(body['thinking'], {'type': 'disabled'})

    def test_site_requests_keep_prompts_and_settings(self):
        sent = []
        cases = self.config['site_smoke'] + self.config['site_schema_smoke']
        def post(url, key, body):
            case = cases[len(sent)]
            sent.append(body)
            return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(case['expected'])}}]}
        with patch.object(ai_models, 'post_json', side_effect=post):
            ai_models.smoke_openai_site_search('mock', 'private', 'candidate-for-test', self.config)
        self.assertEqual([c['purpose'] for c in cases[:2]], ['requested', 'auxiliary'])
        self.assertEqual([len(c['expected']['selections']) for c in cases[2:]], [1, 0])
        self.assertTrue(all(set(c['expected']) == {'selections'} for c in cases))
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
            return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(value)}}]}
        with patch.object(ai_models, 'post_json', side_effect=post):
            ai_models.smoke_openai_site_search('mock', 'private', 'candidate-for-test', self.config)
        # 未知のIDと、やめた daily の項目が付いた古い形を拒否する
        for value in [{'selections': ['unknown-id']},
                      {'selections': [], 'daily': {'media': 'nitori', 'query': '店舗'}}]:
            with self.subTest(value=value):
                invalid = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(value)}}]}
                with patch.object(ai_models, 'post_json', return_value=invalid), self.assertRaises(ai_models.subprocess.CalledProcessError):
                    ai_models.smoke_openai_site_search('mock', 'private', 'candidate-for-test', self.config)

    def test_selection_count_is_observation_but_schema_both_sides_are_required(self):
        cases = self.config['site_smoke'] + self.config['site_schema_smoke']
        sent = []
        def post(url, key, body):
            case = cases[len(sent)]
            sent.append(body)
            value = {'selections': []} if 'purpose' in case else case['expected']
            return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(value)}}]}
        with patch.object(ai_models, 'post_json', side_effect=post):
            observations = ai_models.smoke_openai_site_search('mock', 'private', 'candidate-for-test', self.config)
        self.assertEqual([o['selections'] for o in observations], [0, 0])
        self.assertEqual(len(sent), 4)
        sent = []
        def wrong_shape(url, key, body):
            case = cases[len(sent)]
            sent.append(body)
            value = {'selections': ['x']} if 'purpose' not in case else case['expected']
            return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(value)}}]}
        with patch.object(ai_models, 'post_json', side_effect=wrong_shape), self.assertRaisesRegex(RuntimeError, 'スキーマ疎通'):
            ai_models.smoke_openai_site_search('mock', 'private', 'candidate-for-test', self.config)

    def test_votable_both_choices_and_no_smoke_threshold(self):
        expected = [c['expected'].get('votable') for c in self.config['classify_smoke']]
        self.assertIn('yes', expected)
        self.assertIn('no', expected)
        questions = [set(c['payload']['questions']) for c in self.config['classify_smoke']]
        self.assertEqual(questions[0], {'language', 'malice', 'votable', 'intent', 'site_pages'})
        self.assertEqual(questions[2], questions[0])
        self.assertEqual(questions[1], {'malice', 'votable', 'intent', 'site_pages'})
        self.assertEqual(questions[3:5], [questions[1], questions[1]])
        self.assertTrue(all(q == {'language', 'malice'} for q in questions[5:7]))
        self.assertTrue(all(q == {'language'} for q in questions[7:9]))
        self.assertEqual(questions[9], questions[0] | {'fresh'})
        self.assertEqual(questions[10:12], [questions[1] | {'fresh'}] * 2)
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
        for provider in ['openai', 'deepseek', 'anthropic']:
            for content in ['partial', '', '   ', None]:
                with self.subTest(provider=provider, content=content):
                    response = {'choices': [{'finish_reason': 'length', 'message': {'content': content}}]}
                    def post(url, key, body, stream=False):
                        if is_verifier(body):
                            return verifier_reply(provider)
                        return web_stream(provider) if body.get('tools') else response
                    with patch.object(ai_models, 'post_json', side_effect=post):
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

    def test_verifier_rejects_unknown_source_block_and_incomplete_or_unsupported_answer(self):
        for provider in ['openai', 'anthropic']:
            sample = next(v for v in self.config['verify_smoke'] if v['provider'] == provider)
            for invalid in ['source', 'block', 'status', 'reason']:
                value = json.loads(verifier_reply('openai')['choices'][0]['message']['content'])
                part = value['parts'][0]
                if invalid == 'source':
                    part['citations'][0]['n'] = 2
                if invalid == 'block':
                    part['citations'][0]['blocks'] = [99]
                if invalid == 'status':
                    part['status'] = 'verified'
                response = verifier_reply(provider, value, 'max_tokens' if invalid == 'reason' else None)
                config = {'discussion': {'personas': [], 'synthesizer': {'provider': 'none'}, 'synthesizer_dark': {'provider': 'none'}, 'malice_reply': []},
                          'fact_smoke': [], 'research_smoke': [], 'verify_smoke': [sample]}
                with self.subTest(provider=provider, invalid=invalid), patch.object(ai_models, 'post_json', return_value=response), self.assertRaises(ai_models.subprocess.CalledProcessError):
                    ai_models.smoke_magi_discussion('mock', 'private', 'candidate-for-test', provider, config)

    def test_magi_schema_smoke_uses_production_request_body(self):
        for provider, name in [('anthropic', 'motion'), ('openai', 'motion_fallback')]:
            config = copy.deepcopy(self.config['magi'])
            sent = []
            value = {'motion': 'Go for ramen tonight', 'votable': True}
            config[name]['body']['max_tokens' if provider == 'anthropic' else 'max_completion_tokens'] = 777
            def post(url, key, body):
                sent.append(body)
                if provider == 'anthropic':
                    return {'content': [{'type': 'text', 'text': json.dumps(value)}], 'stop_reason': 'end_turn'}
                return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(value)}}]}
            with patch.object(ai_models, 'post_json', side_effect=post):
                ai_models.smoke_magi_motion('mock', 'private', 'candidate-for-test', config, provider=provider, name=name)
            self.assertEqual(sent, [{**config[name]['body'], 'model': 'candidate-for-test'}])
            if provider == 'anthropic':
                self.assertEqual(sent[0]['output_config']['format']['schema'], config['motion']['format']['json_schema']['schema'])
                self.assertNotIn('temperature', sent[0])
            else:
                # 答え直しは議題化と同じスキーマ・指示を、元の役割の上限・推論なしで送る
                self.assertEqual(sent[0]['response_format'], config['motion']['format'])
                self.assertIn(config['motion']['prompt'], sent[0]['messages'][0]['content'])
                self.assertEqual(sent[0]['reasoning_effort'], 'none')
            # 呼び先の会社が違う設定では何も送らない
            sent.clear()
            with patch.object(ai_models, 'post_json', side_effect=post):
                ai_models.smoke_magi_motion('mock', 'private', 'candidate-for-test', config, provider='deepseek', name=name)
            self.assertEqual(sent, [])

    def test_anthropic_stream_requires_text_and_normal_end(self):
        for text, reason, done in [('answer', 'end_turn', True), ('', 'end_turn', True), ('answer', 'max_tokens', True), ('answer', 'end_turn', False), ('', 'refusal', True)]:
            events = [{'type': 'content_block_delta', 'delta': {'type': 'thinking_delta', 'thinking': 'private'}},
                      {'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': text}},
                      {'type': 'message_delta', 'delta': {'stop_reason': reason}}]
            if done:
                events.append({'type': 'message_stop'})
            raw = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events)
            if text and reason == 'end_turn' and done:
                ai_models.validate_anthropic_stream(raw)
            else:
                with self.assertRaises(RuntimeError):
                    ai_models.validate_anthropic_stream(raw)

    def test_motion_schema_smoke_keeps_quality_decisions_separate(self):
        for value, valid in [({'motion': 'Go for ramen', 'votable': True}, True),
                             ({'motion': '', 'votable': False}, True),
                             ({'motion': '', 'votable': True}, False),
                             ({'motion': 'Invented decision', 'votable': False}, False),
                             ({'motion': 'x', 'votable': 1}, False),
                             ({'motion': 'x', 'votable': True, 'extra': 1}, False)]:
            response = {'content': [{'type': 'text', 'text': json.dumps(value)}], 'stop_reason': 'end_turn'}
            with self.subTest(value=value), patch.object(ai_models, 'post_json', return_value=response):
                if valid:
                    ai_models.smoke_magi_motion('mock', 'private', 'candidate-for-test', self.config['magi'], provider='anthropic')
                else:
                    with self.assertRaises(RuntimeError):
                        ai_models.smoke_magi_motion('mock', 'private', 'candidate-for-test', self.config['magi'], provider='anthropic')

    def test_anthropic_models_detects_only_new_haiku_generations(self):
        pattern = ai_models.PROVIDERS['anthropic']['channels']['haiku']
        # モデルIDの固定値は正本に閉じ、系列の検査は現在の版を組み替えて行う。
        current = ai_models.load_registry()['anthropic']['haiku']['id']
        self.assertIsNotNone(pattern.fullmatch(current))
        self.assertIsNone(pattern.fullmatch(current + '-20261013'))
        self.assertIsNone(pattern.fullmatch(current.replace('haiku', 'sonnet')))
        self.assertIsNone(pattern.fullmatch('prefix-' + current))


if __name__ == '__main__':
    unittest.main()
