"""最終署名APKの本番疎通を観測する。入力・送信・設定変更は利用者が行う。課金送信を自動実行しない。"""
import argparse
import hashlib
import json
from pathlib import Path
import secrets
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from production_smoke_state import SmokeObservation

parser = argparse.ArgumentParser(description=__doc__)
for name in ['adb', 'device', 'apk', 'report']:
    parser.add_argument('--' + name, required=True)
parser.add_argument('--marker', help='未送信の費用ガード計画を再観測するときだけ、同じ固有語を指定する')
args = parser.parse_args()
if args.marker and not re.fullmatch(r'MAGI-QA-release-[a-f0-9]{24}', args.marker):
    parser.error('--marker must be a release guard nonce')
root = Path(__file__).resolve().parents[2]
run = lambda *a: subprocess.check_output([args.adb, '-s', args.device, *a], timeout=30)
utc = lambda: datetime.now(timezone.utc).isoformat()
stamp = json.loads(subprocess.check_output(['node', '.github/scripts/magi-chat-contract.mjs', '--fingerprint'], cwd=root))
report = {'schema': 1, 'kind': 'production', 'pass': False, 'started': utc(), **stamp}
report['pass'] = False
# 会社別D1ガードの固定合成入力として、送信前にこの文面を計画へ登録できる印。
marker = args.marker or 'MAGI-QA-release-' + secrets.token_hex(12)
question = 'Reply with exactly this word: ' + marker
observation = SmokeObservation(marker)
report['apkSha256'] = hashlib.sha256(Path(args.apk).read_bytes()).hexdigest()

def nodes():
    run('shell', 'uiautomator', 'dump', '/data/local/tmp/magi-release-smoke.xml')
    return list(ET.fromstring(run('exec-out', 'cat', '/data/local/tmp/magi-release-smoke.xml')).iter('node'))

try:
    installed = run('shell', 'pm', 'path', 'st.tk.magi').decode().strip().removeprefix('package:')
    assert installed.startswith('/data/app/') and installed.endswith('/base.apk')
    assert hashlib.sha256(run('exec-out', 'cat', installed)).hexdigest() == report['apkSha256'], '最終APKと実機が異なる'
    report['installedApkVerified'] = True
    print('本番への送信は自動実行しません。利用者が許可した検証予算内で実施してください。', flush=True)
    print('通常チャットのアプリ管理でパーソナライズをオンにし、保存して閉じ、もう一度アプリ管理を開いてください。保存後の有効状態を再確認します。', flush=True)
    deadline = time.monotonic() + 360
    while time.monotonic() < deadline:
        rows = nodes()
        observation.observe(rows)
        if observation.settings_on:
            report['personalizationOn'] = True
            break
        time.sleep(1)
    assert report.get('personalizationOn'), 'パーソナライズ有効を確認できない'
    print('設定を保存して新しい通常チャットで、次の合成文を入力し、送信してください。', flush=True)
    print(question, flush=True)
    while time.monotonic() < deadline:
        rows = nodes()
        if observation.observe(rows):
            report.update({'personalizationOn': True, 'normalMode': True, 'observedSending': True, 'newAnswer': True, 'complete': True, 'pass': True})
            break
        time.sleep(1)
    assert report['pass'], '本番応答の正常終了が未確認。自動再送はしない'
except Exception as error:
    report['error'] = str(error)
    raise
finally:
    report['finished'] = utc()
    out = Path(args.report)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'pass': report['pass'], 'report': str(out)}))
