"""本番観測器の否定検査。ADB・ネットワーク・AI送信は使わない。"""
from pathlib import Path
import sys
import subprocess
import unittest
import xml.etree.ElementTree as ET
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'magi-app/scripts'))
from production_smoke_state import SmokeObservation


def rows(*, text='', send='Send', reply='', temporary=False, checked=None, label=None, checkable=True):
    root = ET.Element('hierarchy')
    if checked is not None:
        ET.SubElement(root, 'node', {'resource-id': 'personal-enabled', 'checked': str(checked).lower(), 'checkable': str(checkable).lower()})
    if label is not None:
        ET.SubElement(root, 'node', {'resource-id': 'personal-enabled-label', 'text': label})
    ET.SubElement(root, 'node', {'resource-id': 'btn-temporary-agent', 'checked': str(temporary).lower()})
    ET.SubElement(root, 'node', {'resource-id': 'agent-input', 'text': text})
    ET.SubElement(root, 'node', {'resource-id': 'agent-send', 'content-desc': send})
    log = ET.SubElement(root, 'node', {'resource-id': 'agent-log'})
    ET.SubElement(log, 'node', {'text': reply})
    return list(root.iter('node'))


class ObservationTest(unittest.TestCase):
    def test_command_entrypoint(self):
        script = Path(__file__).resolve().parents[2] / 'magi-app/scripts/record-production-smoke.py'
        result = subprocess.run([sys.executable, '-X', 'utf8', str(script), '--help'], capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--apk', result.stdout)

    def ready(self):
        o = SmokeObservation('UNIQUE')
        o.observe(rows(checked=True))
        o.observe(rows())
        o.observe(rows(checked=True))
        return o

    def test_new_completed_answer(self):
        o = self.ready()
        self.assertFalse(o.observe(rows(text=o.question)))
        self.assertFalse(o.observe(rows(send='Stop')))
        self.assertTrue(o.observe(rows(reply=o.marker)))

    def test_previous_answer_is_not_success(self):
        o = self.ready()
        self.assertFalse(o.observe(rows(reply=o.marker)))
        with self.assertRaises(AssertionError):
            o.observe(rows(text=o.question, reply=o.marker))

    def test_requires_sending(self):
        o = self.ready()
        o.observe(rows(text=o.question))
        self.assertFalse(o.observe(rows(reply=o.marker)))

    def test_temporary_is_not_normal(self):
        o = self.ready()
        o.observe(rows(text=o.question, temporary=True))
        o.observe(rows(send='Stop', temporary=True))
        self.assertFalse(o.observe(rows(reply=o.marker, temporary=True)))

    def test_personalization_off_is_not_on(self):
        o = SmokeObservation('UNIQUE')
        o.observe(rows(text=o.question, checked=False))
        o.observe(rows(send='Stop', checked=False))
        self.assertFalse(o.observe(rows(reply=o.marker, checked=False)))

    def test_question_does_not_count_as_answer(self):
        o = self.ready()
        o.observe(rows(text=o.question))
        o.observe(rows(send='Stop'))
        self.assertFalse(o.observe(rows(reply=o.question)))

    def test_unsaved_toggle_does_not_count(self):
        o = SmokeObservation('UNIQUE')
        o.observe(rows(checked=True))
        o.observe(rows())
        self.assertFalse(o.settings_on)
        o.observe(rows(checked=False))
        o.observe(rows(text=o.question))
        o.observe(rows(send='Stop'))
        self.assertFalse(o.observe(rows(reply=o.marker)))

    def test_webview_explicit_label_requires_saved_and_reopened_on(self):
        for label in ['Personalization: on', 'パーソナライズ: オン']:
            o = SmokeObservation('UNIQUE')
            o.observe(rows(checked=False, checkable=False, label=label))
            self.assertFalse(o.settings_on)
            o.observe(rows())
            o.observe(rows(checked=False, checkable=False, label=label))
            self.assertTrue(o.settings_on)
            o.observe(rows(text=o.question)); o.observe(rows(send='Stop'))
            self.assertTrue(o.observe(rows(reply=o.marker)))

    def test_off_missing_or_conflicting_labels_do_not_count(self):
        for label, checkable in [('Personalization: off', False), ('パーソナライズ: オフ', False), (None, False), ('Personalization: on', True)]:
            o = SmokeObservation('UNIQUE')
            o.observe(rows(checked=False, checkable=checkable, label=label)); o.observe(rows())
            o.observe(rows(checked=False, checkable=checkable, label=label))
            self.assertFalse(o.settings_on)


if __name__ == '__main__':
    unittest.main()
