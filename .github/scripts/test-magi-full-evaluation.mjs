// 全件モードは入力・全費用の承認前に実行しない。既存の累計台帳を変更しないことも点検する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {evaluationBudgetPath} from './magi-eval-budget.mjs';
const cwd=fileURLToPath(new URL('../../',import.meta.url));
for(const script of ['collect-magi-a3-debates.mjs','eval-magi-a5-followups.mjs']){
 test(script+'：--full --runは台帳を指定しても送信前に拒否する',()=>{
  const before=readFileSync(evaluationBudgetPath);
  const r=spawnSync(process.execPath,['.github/scripts/'+script,'--full','--run','--budget-ledger='+evaluationBudgetPath],
   {cwd,encoding:'utf8',timeout:10000});
  assert.ifError(r.error);assert.equal(r.status,1);assert.match(r.stderr,/計画・模擬確認だけ/);
  assert.deepEqual(readFileSync(evaluationBudgetPath),before,'共有台帳は変更しない');
 });
}
for(const script of ['eval-dj-song-card.mjs','eval-games-production-smoke.mjs'])test(script+'：台帳なしでは送信・予約しない',()=>{
 const before=readFileSync(evaluationBudgetPath);
 const r=spawnSync(process.execPath,['.github/scripts/'+script,'--run'],{cwd,encoding:'utf8',timeout:10000});
 assert.ifError(r.error);assert.equal(r.status,1);assert.match(r.stderr,/Paid API evaluation is disabled/);
 assert.deepEqual(readFileSync(evaluationBudgetPath),before);
});
