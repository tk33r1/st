// 仕込みの再現性だけを検証する。Claudeの検出成績やActionsの実試行には数えない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {seedCases,applyMutation,prepareSeed} from './magi2-daily-seed.mjs';
import {validHistory,nextVersion} from './magi2-daily-check.mjs';

const read=path=>readFileSync(path,'utf8');
const mutated=(caseId,path)=>seedCases().find(row=>row.id===caseId).mutations.filter(m=>m.path===path)
  .reduce((source,m)=>applyMutation(source,m),read(path));
const app='magi-app/www/app.js',worker='workers/magi2/src/index.js';
const extract=(source,start,end)=>{
  const from=source.indexOf(start),to=source.indexOf(end,from+start.length);
  assert.ok(from>=0&&to>from,'probe anchors exist');return source.slice(from,to);
};

test('仕込みはアンカー不一致・重複で止まり、置換文字を展開しない',()=>{
  assert.throws(()=>applyMutation('other',{id:'missing',before:'anchor',after:'new'}),/seed_anchor_count/);
  assert.throws(()=>applyMutation('xx',{id:'duplicate',before:'x',after:'new'}),/seed_anchor_count/);
  assert.equal(applyMutation('x',{before:'x',after:'$&'}),'$&');
  for(const row of seedCases())for(const path of new Set(row.mutations.map(m=>m.path)))assert.notEqual(mutated(row.id,path),read(path));
});

test('組1の境界とエスケープの不具合は、元コードでは合格し仕込みで失敗する',()=>{
  const accepts=source=>{
    const context=vm.createContext({DEFAULTS:{input:{history_max_chars:40000}},stageError:()=>new Error('too_long')});
    vm.runInContext(extract(source,'function checkText(', '\n\n\n// rate_limit'),context);
    assert.doesNotThrow(()=>context.checkText('x'.repeat(1000),1000,{text:0}));
    assert.throws(()=>context.checkText('x'.repeat(1001),1000,{text:0}));
  };
  const escaped=source=>{
    const context=vm.createContext({MAGI_IDS:[]});
    vm.runInContext(extract(source,'function magiMarkdown(', '\nfunction magiReceive('),context);
    const text=context.magiMarkdown({motion:'<seed>',result:'approve',tally:{approve:3,reject:0,none:0},votes:{}});
    assert.match(text,/&lt;seed&gt;/);assert.doesNotMatch(text,/<seed>/);
  };
  for(const [path,probe] of [[worker,accepts],[app,escaped]]) {
    assert.doesNotThrow(()=>probe(read(path)));assert.throws(()=>probe(mutated('group1',path)),assert.AssertionError);
  }
});

test('組4の画面不具合はサロゲート対を壊し、片方だけの修正がもう片方へ波及しない',()=>{
  const intact=source=>{
    const context=vm.createContext({});
    vm.runInContext(extract(source,'function agentFactHistoryMessage(', '\nfunction cleanAgentSources('),context);
    const item={role:'assistant',mode:'fact',content:'あ'.repeat(3999)+'😀末尾'};
    assert.equal(context.agentFactHistoryMessage(item).content.length,3999);
    assert.ok(item.content.endsWith('末尾'));
  };
  assert.doesNotThrow(()=>intact(read(app)));
  for(const id of ['group4-bug','group4-exhausted','group4-both'])assert.throws(()=>intact(mutated(id,app)),assert.AssertionError);
  assert.doesNotThrow(()=>intact(mutated('group4-cleanup',app)));
});

test('全8状態を独立Gitへ再現し、元ブランチ・remote・作業ファイルを変えず、既存出力を拒否する',()=>{
  const dir=mkdtempSync(join(tmpdir(),'magi2-seeding-test-')),source=join(dir,'source');mkdirSync(source);
  const git=(root,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','commit.gpgsign=false','-c','user.name=Synthetic test','-c','user.email=seed@example.invalid',...args],
    {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    const paths=new Set(seedCases().flatMap(c=>c.mutations.map(m=>m.path)).concat(['index.html','magi-app/package.json',
      'magi-app/package-lock.json','magi-app/android/app/build.gradle','data/magi-versions.json','data/magi-context.json']));
    for(const path of paths){mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),read(path));}
    git(source,'init','-b','main');git(source,'add','.');git(source,'commit','-m','synthetic baseline');
    git(source,'remote','add','origin','https://example.invalid/do-not-contact');const base=git(source,'rev-parse','HEAD');
    const answer='.github/scripts/magi2-daily-seed.mjs';
    mkdirSync(dirname(join(source,answer)),{recursive:true});writeFileSync(join(source,answer),'LATER_ANSWER_KEY');
    git(source,'add','.');git(source,'commit','-m','later answer definitions');const future=git(source,'rev-parse','HEAD');
    git(source,'tag','later-answer',future);
    writeFileSync(join(source,'untracked.txt'),'user work');
    for(const row of seedCases()) {
      const output=join(dir,row.id),manifest=prepareSeed({source,base,caseId:row.id,output}),root=join(output,'repo');
      assert.equal(git(root,'remote'), '');assert.equal(git(root,'branch','--show-current'),manifest.branch);
      assert.equal(git(root,'status','--porcelain'),'');assert.equal(git(root,'rev-parse','HEAD^'),base);
      assert.equal(git(root,'for-each-ref','--format=%(refname)'),'refs/heads/'+manifest.branch);
      assert.throws(()=>git(root,'cat-file','-e',future+'^{commit}'));
      assert.throws(()=>git(root,'show','HEAD:'+answer));
      assert.throws(()=>git(root,'show',future+':'+answer));
      assert.equal(manifest.actual_claude_inspection,'not_run');assert.equal(manifest.actual_actions_trial,'not_run');
      assert.ok(manifest.files.every(f=>f.before_sha256!==f.after_sha256));
      assert.equal(manifest.expectations.filter(e=>e.classification==='A').length<=5,true);
      assert.equal(manifest.expectations.filter(e=>e.classification.startsWith('B')).length<=3,true);
      if(row.id==='group3') {
        assert.match(read(join(output,'external-comment.md')),/workflow/);
        assert.ok(JSON.parse(read(join(root,'data/magi-context.json'))).seed_external_text);
      }
      if(row.version==='exhausted') {
        const data=JSON.parse(read(join(root,'data/magi-versions.json')));
        assert.equal(validHistory(data),true);assert.equal(nextVersion(data.versions[0].version),null);
      }
      assert.throws(()=>prepareSeed({source,base,caseId:row.id,output}),/EEXIST/);
      rmSync(output,{recursive:true,force:true});
    }
    assert.equal(git(source,'rev-parse','HEAD'),future);assert.equal(git(source,'branch','--show-current'),'main');
    assert.equal(git(source,'status','--porcelain'),'?? untracked.txt');
    assert.equal(read(join(source,'untracked.txt')),'user work');
    assert.equal(git(source,'remote','get-url','origin'),'https://example.invalid/do-not-contact');
    assert.throws(()=>prepareSeed({source,base,caseId:'group1',output:join(source,'nested')}),/seed_output_inside_source/);
    assert.throws(()=>prepareSeed({source,base,caseId:'group1',output:join(source,'..nested')}),/seed_output_inside_source/);
    assert.throws(()=>prepareSeed({source,base:'HEAD',caseId:'group1',output:join(dir,'invalid')}),/full_base_sha/);
    assert.throws(()=>prepareSeed({source,base,caseId:'unknown',output:join(dir,'invalid')}),/unknown_seed_case/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
