// 配布コマンドの唯一の入口。失敗・欠落・古い結果ではGitHubを変更しない。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {matrix, root, sha256, git, sourceFingerprint, checkContract} from './magi-chat-contract.mjs';

export function validateReports({commit, fingerprint, apkSha256, apk, referenceVersionCode, browser, android, production, now = Date.now()}) {
  assert.match(commit, /^[a-f0-9]{40}$/); assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert(apk.pass === true && apk.source === 'commit', '最終APKのコミット照合が未成功');
  assert.equal(apk.commit, commit); assert.equal(apk.apkSha256, apkSha256);
  assert(apk.v1 === true && apk.v2 === true, '署名が未確認');
  assert(Number.isSafeInteger(referenceVersionCode) && apk.versionCode > referenceVersionCode, '配布版のversionCodeを上げる必要がある');
  for (const [kind, report] of Object.entries({browser, android, production})) {
    assert(report?.pass === true && report.schema === 1 && report.kind === kind, kind + ': 未実施または失敗');
    assert.equal(report.commit, commit, kind + ': 別コミットの結果');
    assert.equal(report.fingerprint, fingerprint, kind + ': ソースが変わっている');
    const finished = Date.parse(report.finished), started = Date.parse(report.started);
    assert(Number.isFinite(finished) && Number.isFinite(started) && started <= finished && finished <= now + 60000
      && now - started <= 24 * 60 * 60 * 1000, kind + ': 検査日時が無効または24時間を超えている');
  }
  for (const [report, surfaces] of [[browser, ['web', 'pwa']], [android, ['android']]]) {
    const required = surfaces.flatMap(surface => matrix.flatMap(id => [surface + '/' + id + '/1', surface + '/' + id + '/2',
      ...(!id.startsWith('temporary') ? [surface + '/' + id + '/saved'] : [])]));
    if (report.kind === 'android') required.push('android/background-restart');
    assert(Array.isArray(report.cases)); assert.equal(report.cases.length, required.length, '必須条件の欠落・重複');
    assert.equal(new Set(report.cases.map(c => c.id)).size, required.length, '条件の重複');
    for (const id of required) {
      const row = report.cases.find(c => c.id === id); assert(row?.pass === true, '未成功: ' + id);
      if (/\/[12]$/.test(id)) assert(row.newAnswer === true && row.rendered === true && row.complete === true && row.requests === 1, '今回の回答の成立が未確認: ' + id);
      else assert(row.restored === true, '保存・復元が未確認: ' + id);
    }
    assert.equal(report.paidRequests, 0, '合成検査の外部送信');
  }
  assert(android.packagedWwwVerified === true, 'Androidの同梱画面が未照合');
  const recovery = android.cases.find(c => c.id === 'android/background-restart');
  assert(recovery.answers === 1 && recovery.requests === 1 && recovery.serviceStopped === true, '復元時の二重送信・資源解放が未確認');
  assert.equal(production.apkSha256, apkSha256, '本番疎通を行ったAPKが配布物と異なる');
  for (const key of ['installedApkVerified', 'personalizationOn', 'normalMode', 'observedSending', 'newAnswer', 'complete']) assert(production[key] === true, '最終APKの本番確認が不足: ' + key);
  return {pass: true, commit, fingerprint, apkSha256, checked: new Date(now).toISOString()};
}

async function main() {
  const arg = name => { const i = process.argv.indexOf('--' + name); assert(i >= 0 && process.argv[i + 1], '--' + name + ' が必要'); return process.argv[i + 1]; };
  const commit = git('rev-parse', arg('commit') + '^{commit}');
  assert.equal(git('rev-parse', 'HEAD'), commit, '対象コミットをcheckoutして実行する');
  checkContract(); const fingerprint = sourceFingerprint();
  assert.equal(fingerprint, sourceFingerprint(commit), '対象ソースに未コミットの変更がある');
  const apkPath = resolve(arg('apk')), apkBytes = readFileSync(apkPath), reports = resolve(arg('reports'));
  const stage = mkdtempSync(join(tmpdir(), 'magi-release-'));
  try {
    const stagedApk = join(stage, 'magi-android.apk'); writeFileSync(stagedApk, apkBytes);
    const verification = join(stage, 'apk.json');
    execFileSync('python', [resolve(root, 'magi-app/scripts/verify-apk.py'), '--apk', stagedApk, '--reference', resolve(arg('reference')),
      '--commit', commit, '--build-tools', resolve(arg('build-tools')), '--report', verification], {cwd: root, stdio: 'pipe'});
    const read = name => JSON.parse(readFileSync(resolve(reports, name + '.json'), 'utf8'));
    const apk = JSON.parse(readFileSync(verification, 'utf8'));
    const metadata = execFileSync(join(resolve(arg('build-tools')), process.platform === 'win32' ? 'aapt.exe' : 'aapt'), ['dump', 'badging', resolve(arg('reference'))], {encoding: 'utf8'});
    const referenceVersionCode = Number(metadata.match(/versionCode='(\d+)'/)?.[1]);
    const result = validateReports({commit, fingerprint, apkSha256: sha256(apkBytes), apk, referenceVersionCode, browser: read('browser'), android: read('android'), production: read('production')});
    const output = resolve(reports, 'release-gate.json'); mkdirSync(dirname(output), {recursive: true}); writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    if (process.argv.includes('--publish')) {
      // CIの成功も対象SHAと結び付ける。ローカルJSONだけでは公開しない。
      const gh = (...args) => execFileSync('gh', args, {cwd: root, encoding: 'utf8'}).trim();
      const runId = arg('validation-run'); assert.match(runId, /^\d+$/);
      const run = JSON.parse(gh('api', 'repos/tk33r1/st/actions/runs/' + runId));
      assert.equal(run.head_sha, commit); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
      assert.equal(run.path, '.github/workflows/magi-chat-validation.yml');
      assert.equal(run.repository?.full_name, 'tk33r1/st');
      assert(['push', 'workflow_dispatch'].includes(run.event), 'PR用コミットの結果では配布しない');
      assert.equal(sha256(readFileSync(stagedApk)), result.apkSha256);
      const tag = 'v' + apk.versionName;
      assert.equal(git('rev-list', '-n', '1', tag), commit, '公開タグが対象コミットを指していない');
      // 公開済みの同名Releaseの置換や、既存draftの流用はしない。
      const releases = JSON.parse(gh('api', '--paginate', '--slurp', 'repos/tk33r1/st/releases?per_page=100')).flat();
      assert(!releases.some(r => r.tag_name === tag), '既存Releaseを変更しない。新しい版が必要');
      const notes = join(stage, 'notes.md'); copyFileSync(resolve(arg('notes')), notes);
      gh('release', 'create', tag, stagedApk, '--repo', 'tk33r1/st', '--verify-tag', '--draft', '--title', 'MAGI ' + apk.versionName, '--notes-file', notes);
      // ダウンロードした実配布物のhashまで一致してからdraftを解除する。
      gh('release', 'download', tag, '--repo', 'tk33r1/st', '--pattern', 'magi-android.apk', '--dir', join(stage, 'download'));
      assert.equal(sha256(readFileSync(join(stage, 'download/magi-android.apk'))), result.apkSha256);
      gh('release', 'edit', tag, '--repo', 'tk33r1/st', '--draft=false', '--latest');
    }
    console.log(JSON.stringify(result));
  } finally {
    assert(dirname(resolve(stage)) === resolve(tmpdir()) && basename(stage).startsWith('magi-release-'), '作成した一時フォルダーだけを削除する');
    rmSync(stage, {recursive: true, force: true});
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('公開を停止: ' + error.message); process.exitCode = 1; });
