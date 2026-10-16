"""ゲーム・DJの週次確認を、APIへ送らず本番の組立てと模擬応答で検査する。"""
import copy
import json
import subprocess
import unittest
from unittest.mock import patch
import ai_models


class AuxiliarySmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = ai_models.auxiliary_config()
        cls.searched = {'stop_reason': 'end_turn', 'content': [
            {'type': 'server_tool_use', 'name': 'web_search', 'id': 's1'},
            {'type': 'web_search_tool_result', 'tool_use_id': 's1', 'content': [
                {'type': 'web_search_result', 'url': 'https://example.com/song', 'title': 'source'}]},
            {'type': 'text', 'text': '1982年の曲。', 'citations': [
                {'type': 'web_search_result_location', 'url': 'https://example.com/song', 'cited_text': '1982年の曲。'}]}]}
        cls.card = {'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': json.dumps({
            'identified': True, 'original_year': 1982, 'year_note': None, 'facts': [
                {'kind': 'other', 'text': '1982年に初出', 'source_url': 'https://example.com/song'}],
            'viral_version': None, 'floor_tip': None, 'floor_tip_source': None, 'mix_hint': None})}]}

    def config_for(self, games='openai', song='openai'):
        config = copy.deepcopy(self.config)
        config['providers'] = {'games': games, 'song': song}
        return config

    def test_unadopted_candidates_never_make_weekly_paid_calls(self):
        with patch.object(ai_models, 'post_json') as post:
            ai_models.smoke_auxiliary_anthropic('mock', 'private', 'candidate', self.config_for())
        post.assert_not_called()

    def test_game_uses_real_builder_and_replaces_only_candidate_id(self):
        with patch.object(ai_models, 'post_json', return_value={'stop_reason': 'end_turn', 'content': [
                {'type': 'text', 'text': 'READY'}]}) as post:
            ai_models.smoke_auxiliary_anthropic('mock', 'private', 'candidate', self.config_for(games='anthropic'))
        body = post.call_args.args[2]
        self.assertEqual(body, {**self.config['game'], 'model': 'candidate'})
        self.assertNotIn('temperature', body)

    def test_song_search_then_json_and_real_source_validation(self):
        with patch.object(ai_models, 'post_json', side_effect=[self.searched, self.card]) as post:
            ai_models.smoke_auxiliary_anthropic('mock', 'private', 'candidate', self.config_for(song='anthropic'))
        first, second = [call.args[2] for call in post.call_args_list]
        self.assertEqual(first['model'], 'candidate')
        self.assertEqual(second['model'], 'candidate')
        self.assertIn('tools', first)
        self.assertNotIn('format', first['output_config'])
        self.assertNotIn('tools', second)
        self.assertEqual(second['output_config']['format']['schema'], self.config['card']['output_config']['format']['schema'])
        self.assertNotIn('maxItems', second['output_config']['format']['schema']['properties']['facts'])
        self.assertEqual(self.config['schema']['properties']['facts']['maxItems'], 4)
        self.assertEqual(json.loads(second['messages'][0]['content'])['evidence']['sources'][0]['url'], 'https://example.com/song')

    def test_missing_search_stops_before_card(self):
        with patch.object(ai_models, 'post_json', return_value={'stop_reason': 'end_turn', 'content': [
                {'type': 'text', 'text': 'memory only'}]}) as post:
            with self.assertRaises(subprocess.CalledProcessError):
                ai_models.smoke_auxiliary_anthropic('mock', 'private', 'candidate', self.config_for(song='anthropic'))
        self.assertEqual(post.call_count, 1)

    def test_invented_source_is_not_a_successful_smoke(self):
        bad = copy.deepcopy(self.card)
        value = json.loads(bad['content'][0]['text'])
        value['facts'][0]['source_url'] = 'https://invented.example/'
        bad['content'][0]['text'] = json.dumps(value)
        with patch.object(ai_models, 'post_json', side_effect=[self.searched, bad]):
            with self.assertRaises(subprocess.CalledProcessError):
                ai_models.smoke_auxiliary_anthropic('mock', 'private', 'candidate', self.config_for(song='anthropic'))


if __name__ == '__main__':
    unittest.main()
