import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {dailyEvaluationBudgetPath,evaluationBudgetPath,evaluationBudgetPolicy,evaluationLedgerGate,evaluationRequestHash,paidEvaluationGate} from './magi-eval-budget.mjs';

const body={model:'synthetic-model',messages:[{role:'user',content:'synthetic'}]};
const month=new Date().toISOString().slice(0,7);
const policy=evaluationBudgetPolicy(dailyEvaluationBudgetPath());
function fixture(run) {
  const dir=mkdtempSync(join(tmpdir(),'magi2-daily-budget-')),path=join(dir,'budget.json');
  const value={version:1,scope:policy.scope,estimates:{},reservations:[]};
  const estimate=(provider,amount)=>value.estimates[evaluationRequestHash(provider,body)]={provider,model:body.model,
    max_usd:amount,pricing_checked_at:new Date().toISOString().slice(0,10),basis:'合成入力の予約。API送信なし'};
  const save=()=>writeFileSync(path,JSON.stringify(value));
  try{run({value,path,save,estimate,gate:()=>evaluationLedgerGate(path,policy)});}
  finally{assert.equal(dirname(dir),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});}
}
test('A6: 保存先とscopeは今月だけで、A2の既定拒否・上限は変わらない',()=>{
  assert.throws(()=>paidEvaluationGate([]),/disabled/);
  assert.deepEqual(evaluationBudgetPolicy(evaluationBudgetPath).caps,{openai:1.20,anthropic:1.20,total:3.12});
  assert.deepEqual(policy.caps,{total:.50});assert.equal(policy.scope,'magi2-daily-'+month.replace('-',''));
  assert.throws(()=>evaluationBudgetPolicy(dailyEvaluationBudgetPath(new Date('2000-01-01T00:00:00Z'))),/shared/);
  assert.throws(()=>evaluationBudgetPolicy(join(tmpdir(),'budget-'+month.replace('-','')+'.json')),/shared/);
});
test('A6: 全社合計$0.50を超える予約を拒否し、実行をまたいで予約を減らさない',()=>fixture(f=>{
  f.estimate('openai',.3);f.estimate('anthropic',.2);f.estimate('typesafe',.000001);f.save();
  f.gate().reserve('openai',body);f.gate().reserve('anthropic',body);
  assert.throws(()=>f.gate().reserve('typesafe',body),/ceiling reached/);
  const ledger=JSON.parse(readFileSync(f.path));assert.equal(ledger.reservations.length,2);
  assert.equal(ledger.reservations.reduce((n,r)=>n+r.max_usd,0),.50);assert.equal(existsSync(f.path+'.lock'),false);
}));
test('A6: 台帳の取り違え・別月の予約・月替わりを拒否する',()=>fixture(f=>{
  f.estimate('openai',.1);f.value.scope='magi-dialogue-20261015';f.save();assert.throws(f.gate,/Invalid/);
  f.value.scope=policy.scope;f.value.reservations=[{provider:'openai',max_usd:.1,at:'2000-01-01T00:00:00Z'}];f.save();assert.throws(f.gate,/Invalid/);
  f.value.reservations=[];f.save();
  assert.throws(()=>evaluationLedgerGate(f.path,evaluationBudgetPolicy(evaluationBudgetPath)),/Invalid/);
  const old={...policy,month:'2000-01'};
  assert.throws(()=>evaluationLedgerGate(f.path,old).reserve('openai',body),/month changed/);
}));
test('A6: 見積もり未登録・要求差し替え・ロック中では予約しない',()=>fixture(f=>{
  f.estimate('openai',.1);f.save();const gate=f.gate();
  assert.throws(()=>gate.reserve('openai',{...body,max_tokens:200}),/exact/);
  writeFileSync(f.path+'.lock','busy');assert.throws(()=>gate.reserve('openai',body));
  assert.equal(readFileSync(f.path+'.lock','utf8'),'busy');assert.equal(JSON.parse(readFileSync(f.path)).reservations.length,0);
}));
