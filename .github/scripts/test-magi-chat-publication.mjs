import test from 'node:test';
import assert from 'node:assert/strict';
import {checkRun, waitForCheck} from './wait-magi-chat-check.mjs';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {root} from './magi-chat-contract.mjs';
const sha = 'a'.repeat(40);
const run = (overrides = {}) => ({id: 1, head_sha: sha, path: '.github/workflows/magi-chat-validation.yml', event: 'push',
  repository: {full_name: 'tk33r1/st'}, status: 'completed', conclusion: 'success', ...overrides});
test('Pages: 同じSHAの成功だけを受け付ける', () => assert.equal(checkRun({workflow_runs: [run()]}, sha), true));
for (const overrides of [{head_sha: 'b'.repeat(40)}, {path: '.github/workflows/ai-models.yml'}, {event: 'pull_request'}, {status: 'queued'}, {repository: {full_name: 'fork/st'}}]) {
  test('Pages: 別の結果や未完了を合格にしない ' + JSON.stringify(overrides), () => assert.equal(checkRun({workflow_runs: [run(overrides)]}, sha), false));
}
for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) test('Pages: ' + conclusion + 'で公開を停止', () => assert.throws(() => checkRun({workflow_runs: [run({conclusion})]}, sha)));
test('Pages: 古い成功があっても最新の失敗で止める', () => assert.throws(() => checkRun({workflow_runs: [run(), run({id: 2, conclusion: 'failure'})]}, sha)));
test('Pages: 結果がなければ期限後に拒否する', async () => {
  await assert.rejects(waitForCheck(sha, {timeout: 0, fetcher: async () => ({status: 200, json: async () => ({workflow_runs: []})})}), /停止/);
});
test('Pages: 通信エラーも公開拒否', async () => {
  await assert.rejects(waitForCheck(sha, {fetcher: async () => ({status: 403})}), /取得できない/);
});
test('公開経路: Pagesは出力開始より前にゲートを実行する', () => {
  const text = readFileSync(resolve(root, 'build.sh'), 'utf8');
  assert(text.indexOf('wait-magi-chat-check.mjs') < text.indexOf('rm -rf "$OUT"'));
  assert.match(text, /CF_PAGES.*1/);
});
test('公開経路: magi2の検査がキー同期・デプロイに先行する', () => {
  const text = readFileSync(resolve(root, '.github/workflows/deploy-worker-core.yml'), 'utf8');
  assert.match(text, /magi-chat-check:\n\s+if: inputs.worker == 'magi2'\n\s+uses: .*magi-chat-validation.yml/);
  assert.match(text, /deploy:\n\s+needs: \[magi-chat-check\]/);
  assert.match(text, /needs.magi-chat-check.result == 'success'/);
});
test('公開経路: Webと実Javaの両方が成功しなければCIを合格にしない', () => {
  const text = readFileSync(resolve(root, '.github/workflows/magi-chat-validation.yml'), 'utf8');
  assert.match(text, /needs: \[browser, android\]/);
  assert.match(text, /test "\$BROWSER_RESULT" = success && test "\$ANDROID_RESULT" = success/);
  assert.doesNotMatch(text, /continue-on-error/);
});
