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
source = parser.add_mutually_exclusive_group(required=True)
source.add_argument('--commit', help='公開用: Gitコミットの出荷物と照合')
source.add_argument('--working-tree', action='store_true', help='試作用: 未コミットの作業ファイルと照合（公開の検証には使わない）')
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
    command = [java, '-jar', str(tools / 'lib' / 'apksigner.jar'), 'verify', '--verbose', '--print-certs']
    # minSdk 24以上だとapksignerはv1の検証を省く。旧端末の検証基準も指定し、両署名を実際に調べる。
    if require_schemes:
        command += ['--min-sdk-version', '22']
    text = run(command + [str(Path(apk).resolve())]).decode('utf-8')
    if require_schemes:
        for scheme in ['v1', 'v2']:
            assert re.search(r'Verified using ' + scheme + r' scheme .*: true', text), scheme
    assert 'Number of signers: 1' in text
    return re.search(r'Signer #1 certificate SHA-256 digest: ([a-f0-9]+)', text).group(1)

commit = git('rev-parse', args.commit or 'HEAD').decode().strip()
files = (git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'magi-app/www/') if args.working_tree
         else git('ls-tree', '-r', '--name-only', commit, '--', 'magi-app/www/')).decode().splitlines()
assert files
def source_bytes(file):
    return (root / file).read_bytes() if args.working_tree else git('show', commit + ':' + file)

version = json.loads(source_bytes('magi-app/package.json'))['version'].rsplit('.', 1)[0]
aapt = tools / ('aapt.exe' if os.name == 'nt' else 'aapt')
metadata = run([str(aapt), 'dump', 'badging', str(Path(args.apk).resolve())]).decode('utf-8')
assert "name='st.tk.magi'" in metadata
assert "versionName='" + version + "'" in metadata
assert "versionCode='" + version.replace('.', '') + "'" in metadata
variables = source_bytes('magi-app/android/variables.gradle').decode('utf-8')
min_sdk = int(re.search(r'minSdkVersion\s*=\s*(\d+)', variables).group(1))
target_sdk = int(re.search(r'targetSdkVersion\s*=\s*(\d+)', variables).group(1))
assert "sdkVersion:'" + str(min_sdk) + "'" in metadata
assert "targetSdkVersion:'" + str(target_sdk) + "'" in metadata
cert = certificate(args.apk, True)
assert cert == certificate(args.reference), '旧配布APKとの署名不一致'
checked = {}
with zipfile.ZipFile(args.apk) as archive:
    names = set(archive.namelist())
    for file in files:
        path = 'assets/public/' + file.removeprefix('magi-app/www/')
        expected = source_bytes(file)
        assert path in names, '同梱欠落: ' + file
        actual = archive.read(path)
        assert actual == expected, 'Git正本と同梱バイト列の不一致: ' + file
        checked[file] = hashlib.sha256(actual).hexdigest()
    extras = sorted(path for path in names if path.startswith('assets/public/') and not path.endswith('/') and path not in {'assets/public/' + file.removeprefix('magi-app/www/') for file in files})
    assert all(path in ['assets/public/capacitor.js', 'assets/public/capacitor.plugins.json', 'assets/public/cordova.js', 'assets/public/cordova_plugins.js'] for path in extras), extras
report = {'pass': True, 'commit': commit, 'versionName': version, 'versionCode': int(version.replace('.', '')), 'apkSha256': hashlib.sha256(Path(args.apk).read_bytes()).hexdigest(), 'certificateSha256': cert, 'v1': True, 'v2': True, 'wwwFiles': checked, 'runtimeExtras': extras}
report['source'] = 'working-tree' if args.working_tree else 'commit'
report['minSdk'] = min_sdk
report['targetSdk'] = target_sdk
out = Path(args.report)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({key: value for key, value in report.items() if key != 'wwwFiles'}))
