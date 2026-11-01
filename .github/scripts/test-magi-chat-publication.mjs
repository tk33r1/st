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
test('Pages: botのpushで起動した同じSHAの検査も受け付ける', () => assert.equal(checkRun({workflow_runs: [run({event: 'workflow_dispatch'})]}, sha), true));

test('Pages: SHAを名前に含めない旧dispatchとpushはhead_shaを使い、不正な固定SHAを旧形式へ戻さない',()=>{
  assert.equal(checkRun({workflow_runs:[run({event:'workflow_dispatch',display_title:'MAGI Chat Gate'})]},sha),true);
  assert.equal(checkRun({workflow_runs:[run({display_title:'MAGI Chat Gate '+'b'.repeat(40)})]},sha),true);
  for(const title of ['main',sha.slice(1),sha+'a',sha.toUpperCase(),sha+' suffix'])
    assert.equal(checkRun({workflow_runs:[run({event:'workflow_dispatch',display_title:'MAGI Chat Gate '+title})]},sha),false);
});

test('Pages: mainが進んだ後のdispatchも、実際の検査SHAだけに適用する', () => {
  const other='b'.repeat(40), dispatched=run({event:'workflow_dispatch',head_sha:other,display_title:'MAGI Chat Gate '+sha});
  assert.equal(checkRun({workflow_runs:[dispatched]},sha),true);
  assert.equal(checkRun({workflow_runs:[dispatched]},other),false);
  assert.equal(checkRun({workflow_runs:[run({event:'issue_comment',display_title:'MAGI Chat Gate '+sha})]},sha),false);
  assert.equal(checkRun({workflow_runs:[run({event:'workflow_dispatch',display_title:'MAGI Chat Gate main'})]},sha),false);
});

test('Pages: dispatchの起動SHAで絞らず、固定した検査SHAの結果を読む', async () => {
  await waitForCheck(sha,{fetcher:async url=>{
    assert.equal(new URL(url).searchParams.has('head_sha'),false);
    return {status:200,json:async()=>({workflow_runs:[run({event:'workflow_dispatch',head_sha:'b'.repeat(40),display_title:'MAGI Chat Gate '+sha})]})};
  }});
  const workflow=readFileSync(resolve(root,'.github/workflows/magi-chat-validation.yml'),'utf8');
  assert.match(workflow,/run-name: MAGI Chat Gate \$\{\{ inputs.sha \|\| github.sha \}\}/);
  assert.match(workflow,/workflow_dispatch:\n    inputs:\n      sha:/);
  assert.match(workflow,/CHECK_SHA: \$\{\{ inputs.sha \}\}/);
  assert.match(workflow,/\^\[a-f0-9\]\{40\}\$/);
  for(const job of ['browser','android'])assert.ok(workflow.includes(job+':\n    needs: target'));
});
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
