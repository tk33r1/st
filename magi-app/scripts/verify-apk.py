"""配布前にAndroid版・署名・Git正本の全wwwファイルを照合する。鍵は読まない。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--apk', required=True)
parser.add_argument('--reference', required=True, help='署名を引き継ぐ旧配布APK')
parser.add_argument('--commit', required=True)
parser.add_argument('--build-tools', required=True)
parser.add_argument('--report', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
tools = Path(args.build_tools)
java = str(Path(os.environ['JAVA_HOME']) / 'bin' / ('java.exe' if os.name == 'nt' else 'java')) if os.environ.get('JAVA_HOME') else shutil.which('java')

def run(command):
    return subprocess.check_output(command, cwd=root, stderr=subprocess.STDOUT)

def git(*parts):
    return run(['git', *parts])

def certificate(apk, require_schemes=False):
    text = run([java, '-jar', str(tools / 'lib' / 'apksigner.jar'), 'verify', '--verbose', '--print-certs', str(Path(apk).resolve())]).decode('utf-8')
    if require_schemes:
        for scheme in ['v1', 'v2']:
            assert re.search(r'Verified using ' + scheme + r' scheme .*: true', text), scheme
    assert 'Number of signers: 1' in text
    return re.search(r'Signer #1 certificate SHA-256 digest: ([a-f0-9]+)', text).group(1)

commit = git('rev-parse', args.commit).decode().strip()
files = git('ls-tree', '-r', '--name-only', commit, '--', 'magi-app/www/').decode().splitlines()
assert files
version = json.loads(git('show', commit + ':magi-app/package.json'))['version'].rsplit('.', 1)[0]
aapt = tools / ('aapt.exe' if os.name == 'nt' else 'aapt')
metadata = run([str(aapt), 'dump', 'badging', str(Path(args.apk).resolve())]).decode('utf-8')
assert "name='st.tk.magi'" in metadata
assert "versionName='" + version + "'" in metadata
assert "versionCode='" + version.replace('.', '') + "'" in metadata
cert = certificate(args.apk, True)
assert cert == certificate(args.reference), '旧配布APKとの署名不一致'
checked = {}
with zipfile.ZipFile(args.apk) as archive:
    names = set(archive.namelist())
    for file in files:
        path = 'assets/public/' + file.removeprefix('magi-app/www/')
        expected = git('show', commit + ':' + file)
        assert path in names, '同梱欠落: ' + file
        actual = archive.read(path)
        assert actual == expected, 'Git正本と同梱バイト列の不一致: ' + file
        checked[file] = hashlib.sha256(actual).hexdigest()
    extras = sorted(path for path in names if path.startswith('assets/public/') and not path.endswith('/') and path not in {'assets/public/' + file.removeprefix('magi-app/www/') for file in files})
    assert all(path in ['assets/public/capacitor.js', 'assets/public/capacitor.plugins.json', 'assets/public/cordova.js', 'assets/public/cordova_plugins.js'] for path in extras), extras
report = {'pass': True, 'commit': commit, 'versionName': version, 'versionCode': int(version.replace('.', '')), 'apkSha256': hashlib.sha256(Path(args.apk).read_bytes()).hexdigest(), 'certificateSha256': cert, 'v1': True, 'v2': True, 'wwwFiles': checked, 'runtimeExtras': extras}
out = Path(args.report)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({key: value for key, value in report.items() if key != 'wwwFiles'}))
