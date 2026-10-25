"""本番の画面を順に観測する。過去の回答や入力本文は成功と数えない。"""


def find(rows, id):
    return next((n for n in rows if n.get('resource-id') == id), None)


class SmokeObservation:
    def __init__(self, marker):
        self.marker = marker
        self.question = 'Reply with exactly this word: ' + marker
        self.settings_on = self.prepared = self.sending = False
        self._saw_on = self._closed_after_on = False

    def observe(self, rows):
        toggle = find(rows, 'personal-enabled')
        if toggle is not None:
            if toggle.get('checked') != 'true':
                self.settings_on = self._saw_on = self._closed_after_on = False
            elif self._saw_on and self._closed_after_on:
                self.settings_on = True
            else:
                self._saw_on = True
            return False
        if self._saw_on:
            self._closed_after_on = True
        if not self.settings_on:
            return False
        temporary, field, send = (find(rows, id) for id in ['btn-temporary-agent', 'agent-input', 'agent-send'])
        if temporary is None or temporary.get('checked') != 'false' or field is None or send is None:
            return False
        if field.get('text') == self.question:
            assert not any(n.get('text') == self.marker for n in rows), '送信前から回答がある'
            self.prepared = True
        if self.prepared and send.get('content-desc') in ['Stop', '停止', 'Show all now', 'すぐに全部表示']:
            self.sending = True
        log = find(rows, 'agent-log')
        return bool(self.prepared and self.sending and log is not None
                    and any(n.get('text') == self.marker for n in log.iter('node'))
                    and send.get('content-desc') in ['Send', '送信'] and field.get('text', '') == '')
