// 公開を通す検査に加え、未実施・結果の使い回し・異なる配布物を必ず止める。
import test from 'node:test';
import assert from 'node:assert/strict';
import {matrix} from './magi-chat-contract.mjs';
import {validateReports} from './magi-release-gate.mjs';

function fixture() {
  const now = Date.parse('2026-10-25T12:00:00Z'), commit = 'a'.repeat(40), fingerprint = 'b'.repeat(64), apkSha256 = 'c'.repeat(64);
  const report = kind => ({schema: 1, kind, commit, fingerprint, pass: true, started: new Date(now - 10000).toISOString(), finished: new Date(now).toISOString(), paidRequests: 0});
  const cases = surfaces => surfaces.flatMap(surface => matrix.flatMap(id => [1, 2].map(turn => ({id: surface + '/' + id + '/' + turn,
    pass: true, newAnswer: true, rendered: true, complete: true, requests: 1})).concat(id.startsWith('temporary') ? [] : [{id: surface + '/' + id + '/saved', pass: true, restored: true}])));
  return {now, commit, fingerprint, apkSha256, referenceVersionCode: 702, apk: {pass: true, source: 'commit', commit, apkSha256, versionCode: 703, v1: true, v2: true},
    browser: {...report('browser'), cases: cases(['web', 'pwa'])}, android: {...report('android'), packagedWwwVerified: true, cases: [...cases(['android']),
      {id: 'android/background-restart', pass: true, restored: true, answers: 1, requests: 1, serviceStopped: true}]},
    production: {...report('production'), apkSha256, installedApkVerified: true, personalizationOn: true, normalMode: true, observedSending: true, newAnswer: true, complete: true}};
}
test('公開ゲート: 全必須検査と最終APKが一致すると合格', () => assert.equal(validateReports(fixture()).pass, true));
for (const [name, mutate] of [
  ['本番の未実施', f => { delete f.production; }],
  ['Androidの失敗', f => { f.android.pass = false; }],
  ['必要な組み合わせの欠落', f => f.browser.cases.pop()],
  ['前の回答を成功と数える', f => { f.android.cases[0].newAnswer = false; }],
  ['別コミット', f => { f.android.commit = 'd'.repeat(40); }],
  ['検査後のソース変更', f => { f.android.fingerprint = 'd'.repeat(64); }],
  ['24時間を超えた結果', f => { f.production.started = '2026-10-23T00:00:00Z'; }],
  ['未来の結果', f => { f.production.finished = '2030-01-01T00:00:00Z'; }],
  ['異なるAPKで本番確認', f => { f.production.apkSha256 = 'd'.repeat(64); }],
  ['試作用APK照合だけ', f => { f.apk.source = 'working-tree'; }],
  ['復元時の二重送信', f => { f.android.cases.at(-1).requests = 2; }],
  ['条件名の重複', f => { f.android.cases[1] = f.android.cases[0]; }],
  ['実Java経路の未確認', f => { f.android.packagedWwwVerified = false; }],
  ['通常オンの本番確認なし', f => { f.production.personalizationOn = false; }],
  ['署名の未確認', f => { f.apk.v2 = false; }],
  ['版番号の据え置き', f => { f.apk.versionCode = 702; }],
]) test('公開ゲート: ' + name + 'を拒否する', () => { const f = fixture(); mutate(f); assert.throws(() => validateReports(f)); });
