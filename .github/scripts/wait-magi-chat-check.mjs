// Pagesの公開前に、同じSHAの合成検査が完了したことをGitHubから読む。欠落時も成功扱いにしない。
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function checkRun(data, sha) {
  assert(Array.isArray(data.workflow_runs), 'GitHub応答の形式が不正');
  const run = data.workflow_runs.filter(r => r.head_sha === sha && r.path === '.github/workflows/magi-chat-validation.yml'
    && r.event === 'push' && r.repository?.full_name === 'tk33r1/st').sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== 'completed') return false;
  assert.equal(run.conclusion, 'success', 'チャット検査が不成功: ' + run.conclusion);
  return true;
}
export async function waitForCheck(sha, {fetcher = fetch, pause = ms => new Promise(r => setTimeout(r, ms)), timeout = 900000} = {}) {
  assert.match(sha || '', /^[a-f0-9]{40}$/, 'Pagesの完全なコミットSHAが必要');
  const deadline = Date.now() + timeout;
  do {
    const headers = {Accept: 'application/vnd.github+json', 'User-Agent': 'tk-st-magi-chat-gate'};
    if (process.env.MAGI_CHECK_GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.MAGI_CHECK_GITHUB_TOKEN;
    const response = await fetcher('https://api.github.com/repos/tk33r1/st/actions/workflows/magi-chat-validation.yml/runs?event=push&head_sha=' + sha + '&per_page=10', {headers, signal: AbortSignal.timeout(15000)});
    assert.equal(response.status, 200, 'GitHubの検査結果を取得できない');
    if (checkRun(await response.json(), sha)) return;
    if (Date.now() >= deadline) break;
    console.log('同じコミットのMAGI Chat Gate完了を待っています');
    await pause(Math.min(60000, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error('チャット検査の成功を確認できないため公開を停止');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  waitForCheck(process.env.CF_PAGES_COMMIT_SHA).catch(e => { console.error(e.message); process.exitCode = 1; });
}
