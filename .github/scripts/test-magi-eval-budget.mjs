import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {paidEvaluationGate,evaluationRequestHash} from './magi-eval-budget.mjs';
const root=fileURLToPath(new URL('../../workers/.wrangler/',import.meta.url));
const body={model:'test-model',messages:[{role:'user',content:'synthetic'}],max_tokens:100};
function fixture(run){
  const dir=mkdtempSync(join(root,'budget-test-')),path=join(dir,'budget.json');
  const value={version:1,scope:'magi-dialogue-20261015',estimates:{},reservations:[]};
  const estimate=(provider,max_usd)=>value.estimates[evaluationRequestHash(provider,body)]={provider,model:body.model,max_usd,pricing_checked_at:'2026-10-15',basis:'Synthetic cost ceiling; no API request'};
  const save=()=>writeFileSync(path,JSON.stringify(value));
  const gate=()=>paidEvaluationGate(['--budget-ledger='+path],path);
  try{run({path,value,estimate,save,gate});}finally{
    assert.ok(resolve(dir).startsWith(resolve(root)+'\\')||resolve(dir).startsWith(resolve(root)+'/'));rmSync(dir,{recursive:true});
  }
}
test('実API評価は既定拒否で、台帳を替えて累計予算をリセットできない',()=>{
  assert.throws(()=>paidEvaluationGate([]),/disabled/);
  assert.throws(()=>paidEvaluationGate(['--budget-ledger=other.json']),/shared/);
  const project=fileURLToPath(new URL('../../',import.meta.url));
  for(const [script,...args] of [['eval-magi-a2-worker.mjs'],['probe-magi-a2-web.mjs'],['probe-magi-a2-music-fact.mjs'],['eval-magi-a2-classification.mjs','--run'],['eval-magi-a2-verification.mjs','--run']]){
    const result=spawnSync(process.execPath,['.github/scripts/'+script,...args],{cwd:project,encoding:'utf8',env:{PATH:process.env.PATH}});
    assert.notEqual(result.status,0);assert.match(result.stderr,/Paid API evaluation is disabled/);
  }
});
test('費用未確認・要求変更・ゼロのモデル費用は送信前に拒否する',()=>fixture(({value,estimate,save,gate,path})=>{
  estimate('openai',.1);save();const g=gate();
  assert.throws(()=>g.reserve('openai',{...body,max_tokens:200}),/exact/);
  value.estimates[evaluationRequestHash('openai',body)].max_usd=0;save();assert.throws(()=>g.reserve('openai',body),/exact/);
  assert.equal(JSON.parse(readFileSync(path)).reservations.length,0);assert.equal(existsSync(path+'.lock'),false);
}));
test('失敗と実行をまたいでも予約額が残り、採用後のLunaの$1.20を超えない',()=>fixture(({estimate,save,gate,path})=>{
  estimate('openai',.6);save();gate().reserve('openai',body);gate().reserve('openai',body);
  assert.throws(()=>gate().reserve('openai',body),/ceiling reached/);
  assert.equal(JSON.parse(readFileSync(path)).reservations.length,2);
}));
test('Haikuの枠と、分類等を含む採用後の合計$2.80の両方を守る',()=>fixture(({estimate,save,gate,path})=>{
  estimate('openai',1.2);estimate('anthropic',1.2);estimate('deepseek',.4);estimate('typesafe',.001);save();
  const g=gate();g.reserve('openai',body);g.reserve('anthropic',body);g.reserve('deepseek',body);
  assert.throws(()=>g.reserve('typesafe',body),/ceiling reached/);
  assert.throws(()=>g.reserve('anthropic',body),/ceiling reached/);
  assert.equal(JSON.parse(readFileSync(path)).reservations.length,3);
}));
test('別の評価が台帳を使用中なら、予約も送信もせずそのロックを残す',()=>fixture(({estimate,save,gate,path})=>{
  estimate('openai',.1);save();writeFileSync(path+'.lock','busy');
  assert.throws(()=>gate().reserve('openai',body));assert.equal(readFileSync(path+'.lock','utf8'),'busy');
  assert.equal(JSON.parse(readFileSync(path)).reservations.length,0);
}));
