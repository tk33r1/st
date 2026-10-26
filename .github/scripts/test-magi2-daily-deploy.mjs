import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {deploymentPlan,deploymentVersionUnchanged,recoveryDecision} from './magi2-daily-deploy.mjs';

function fixture(run) {
  const root=mkdtempSync(join(tmpdir(),'magi2-deploy-trial-'));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','commit.gpgsign=false','-c','user.name=Synthetic user','-c','user.email=synthetic@example.invalid',...args],
    {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const write=(path,text)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);};
  const commit=(path,text,message='fix [magi2-daily]',bot=false)=>{
    write(path,text);git('add','.');
    if(bot)git('-c','user.name=github-actions[bot]','commit','-m',message);
    else git('commit','-m',message);
    return git('rev-parse','HEAD');
  };
  try {
    git('init','-b','main');write('workers/magi2/src/index.js','// baseline\n');write('data/magi-context.json','old card\n');
    write('data/magi-versions.json','6.0\n');write('config/ai-models.json','old model\n');git('add','.');git('commit','-m','baseline');
    const base=git('rev-parse','HEAD'),previous={id:'previous-version',message:base};
    run({root,git,write,commit,base,previous,plan:(mergeBase,target=git('rev-parse','HEAD'),prev=previous)=>deploymentPlan({root,target,mergeBase,previous:prev})});
  } finally {rmSync(root,{recursive:true,force:true});}
}

test('文書だけなら版を読まずskipし、Workerの修正だけを固定SHAで計画する',()=>fixture(f=>{
  const docs=f.commit('workers/magi2/README.md','docs\n');assert.equal(f.plan(f.base,docs,null).action,'skip');
  const target=f.commit('workers/magi2/src/index.js','// daily fix\n');
  const result=f.plan(docs,target);assert.equal(result.action,'deploy');assert.equal(result.target,target);
  assert.deepEqual(result.rollback_commits,[target,docs]);assert.equal(result.execution_enabled,false);
  const status=f.git('status','--porcelain');assert.equal(status,'');assert.equal(f.git('rev-parse','HEAD'),target);
}));
test('未記録・dirty・不明なコミット・新しい本番・別枝の版からは公開しない',()=>fixture(f=>{
  const target=f.commit('workers/magi2/src/index.js','// daily\n');
  for(const previous of [null,{id:'old',message:f.base+'-dirty'},{id:'old',message:'untracked'},
    {id:'old',message:'f'.repeat(40)}])assert.equal(f.plan(f.base,target,previous).action,'blocked');
  const later=f.commit('workers/magi2/src/index.js','// later\n','manual');
  assert.equal(f.plan(f.base,target,{id:'new',message:later}).reason,'previous_not_ancestor');
  f.git('checkout','-b','other',f.base);const other=f.commit('unrelated.txt','other\n','other branch');
  assert.equal(f.plan(f.base,target,{id:'other',message:other}).reason,'previous_not_ancestor');
  assert.throws(()=>deploymentPlan({root:f.root,target:'HEAD',mergeBase:f.base,previous:f.previous}),/full_sha/);
}));
test('未公開の手修正・モデル設定を巻き込まず、カードだけのbot更新は残す',()=>fixture(f=>{
  const manual=f.commit('workers/magi2/research.js','// manual\n','manual change');
  assert.equal(f.plan(f.base,manual).reason,'unpublished_manual_worker_change');
  f.git('checkout','-b','models',f.base);
  const model=f.commit('config/ai-models.json','new model\n');assert.equal(f.plan(f.base,model).reason,'unpublished_model_configuration');
  f.git('checkout','-b','cards',f.base);const bot=f.commit('data/magi-context.json','new card\n','rebuild cards',true);
  const daily=f.commit('workers/magi2/src/index.js','// fix\n');
  const result=f.plan(bot,daily);assert.equal(result.action,'deploy');assert.deepEqual(result.rollback_commits,[daily]);
}));
test('戻す範囲は版も含めたdailyだけで、bot更新と対象SHA後の本人変更を保つ',()=>fixture(f=>{
  const fix=f.commit('workers/magi2/src/index.js','// fixed\n');
  f.commit('data/magi-context.json','new card\n','rebuild cards',true);
  const version=f.commit('data/magi-versions.json','6.01\n','bump version [magi2-daily]');
  const result=f.plan(f.base,version);assert.deepEqual(result.rollback_commits,[version,fix]);
  const human=f.commit('human.txt','keep this\n','manual later work');
  for(const sha of result.rollback_commits)f.git('revert','--no-edit',sha);
  assert.equal(readFileSync(join(f.root,'data/magi-versions.json'),'utf8'),'6.0\n');
  assert.equal(readFileSync(join(f.root,'data/magi-context.json'),'utf8'),'new card\n');
  assert.equal(readFileSync(join(f.root,'human.txt'),'utf8'),'keep this\n');
  assert.equal(result.target,version);assert.equal(f.git('merge-base','--is-ancestor',human,'HEAD'),'');
}));
test('revertの競合を実Gitで再現し、本人の後続変更をresetしない',()=>fixture(f=>{
  const fix=f.commit('workers/magi2/src/index.js','// daily\n');const result=f.plan(f.base,fix);
  f.commit('workers/magi2/src/index.js','// human edited same line\n','human later edit');
  assert.throws(()=>f.git('revert','--no-edit',result.rollback_commits[0]));
  f.git('revert','--abort');assert.equal(readFileSync(join(f.root,'workers/magi2/src/index.js'),'utf8'),'// human edited same line\n');
  assert.equal(recoveryDecision({rollback:'success',revert:'failure'}).reason,'revert_conflict');
}));
test('版IDの割り込みでは戻さず、失敗と戻し成功のどちらも停止の印を要求する',()=>{
  assert.equal(deploymentVersionUnchanged({id:'old',message:'a'},{id:'new',message:'a'}),false);
  assert.equal(deploymentVersionUnchanged({id:'old',message:'a'},{id:'old',message:'a'}),true);
  assert.equal(recoveryDecision({deployedId:'ours',currentId:'human'}).reason,'deployment_interrupted');
  assert.equal(recoveryDecision({deployedId:'ours',currentId:'ours'}).next,'rollback');
  assert.equal(recoveryDecision({rollback:'failure'}).reason,'rollback_failed');
  assert.equal(recoveryDecision({rollback:'success'}).next,'revert_on_current_main');
  assert.equal(recoveryDecision({rollback:'success',revert:'success'}).next,'push_with_retry');
  for(const [push,reason] of [['failure','push_failed'],['success','recovered']]) {
    const result=recoveryDecision({rollback:'success',revert:'success',push});assert.equal(result.reason,reason);assert.equal(result.halt_required,true);
  }
  assert.throws(()=>recoveryDecision({revert:'success'}),/recovery_state/);
});
