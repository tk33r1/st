import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {seedBranch,eligibleSeedPR,discoverSeedTrial,reportSeedTrial,installSeedHarness} from './magi2-daily-seed-trial.mjs';
import {eligibleDailyPR} from './magi2-daily-github.mjs';

const head='a'.repeat(40),base='b'.repeat(40),runUrl='https://github.com/tk33r1/st/actions/runs/123';
const delta={commits:[{sha:head,message:'update docs [magi2-daily]',files:[{path:'workers/magi2/README.md',before:'old\n',after:'new\n',added:['new'],removed:['old']}]}]};
function fixture() {
  const f={base,calls:[],comments:new Map(),mails:0};
  f.pr={number:7,state:'open',draft:false,user:{login:'tk33r1'},labels:[{name:'magi2-daily-A'}],
    base:{ref:seedBranch,repo:{full_name:'tk33r1/st'}},head:{ref:'automation/magi2-daily-20261024',sha:head,repo:{full_name:'tk33r1/st'}}};
  f.prs=[f.pr];
  f.client={pages:async path=>path.startsWith('/pulls')?f.prs:f.comments.get(path)||[],request:async(path,options)=>{
    if(!options){if(path==='/pulls/7')return f.pr;if(path.startsWith('/branches/'))return {commit:{sha:f.base}};throw new Error(path);}
    f.calls.push({path,...options});
    if(path.endsWith('/comments')){const rows=f.comments.get(path)||[];rows.push({user:{login:'github-actions[bot]'},...options.body});f.comments.set(path,rows);}
    if(path.endsWith('/labels'))for(const name of options.body.labels)if(!f.pr.labels.some(row=>row.name===name))f.pr.labels.push({name});
    return {};
  }};
  f.discover={client:f.client,number:7,base,head,changes:()=>structuredClone(delta)};
  f.mail=async()=>{f.mails++;};
  f.report=snapshot=>reportSeedTrial({client:f.client,snapshot,validation:'success',issue:14,runUrl,mail:f.mail});
  return f;
}
test('仕込みbaseだけを選び、通常のmain判定は広げない',async()=>{
  const f=fixture();assert.equal(eligibleSeedPR(f.pr),true);assert.equal(eligibleDailyPR(f.pr),false);
  const snapshot=await discoverSeedTrial(f.discover);assert.equal(snapshot.validate,true);assert.equal(snapshot.classification,'A');
  const result=await f.report(snapshot);assert.equal(result.reported,true);assert.equal(result.merge_enabled,false);assert.equal(f.mails,0);
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.path.endsWith('/comments')));
  for(const patch of [p=>p.base.ref='main',p=>p.head.repo.full_name='other/st',p=>p.user.login='other',p=>p.labels=[],p=>p.draft=true]) {
    const g=fixture();patch(g.pr);assert.equal((await discoverSeedTrial(g.discover)).selected,false);
  }
  await assert.rejects(discoverSeedTrial({...f.discover,head:'HEAD'}),/inputs/);
});
test('main側の機械的判定で保護ファイルと検査fixtureの変更を拒否する',async()=>{
  for(const path of ['.github/workflows/magi2-daily-merge.yml','.github/scripts/magi2-daily-check.mjs','.github/scripts/fixtures/magi-versions-apk59.js']) {
    const f=fixture(),changed=structuredClone(delta);changed.commits[0].files[0].path=path;
    const snapshot=await discoverSeedTrial({...f.discover,changes:()=>changed});
    assert.equal(snapshot.validate,false);assert.equal(snapshot.reason,'mechanical_failed');
    await f.report(snapshot);assert.equal(f.mails,1);
  }
});
test('head/baseの変化とA複数では検証へ進まず、複数の理由を記録する',async()=>{
  for(const patch of [f=>f.pr.head.sha='c'.repeat(40),f=>f.base='c'.repeat(40)]) {
    const f=fixture();patch(f);assert.equal((await discoverSeedTrial(f.discover)).validate,false);
  }
  const f=fixture();f.prs.push({...f.pr,number:8});
  const snapshot=await discoverSeedTrial(f.discover);assert.equal(snapshot.reason,'duplicate_or_missing_A');
  const result=await f.report(snapshot);assert.equal(result.status,'duplicate_or_missing_A');assert.equal(f.mails,0);
});
test('検証後の更新・取消では古い結果をコメント・メールへ流さない',async()=>{
  for(const patch of [f=>f.pr.head.sha='c'.repeat(40),f=>f.base='c'.repeat(40),f=>f.pr.state='closed',f=>f.pr.labels=[],f=>f.pr.draft=true]) {
    const f=fixture(),snapshot=await discoverSeedTrial(f.discover);patch(f);
    assert.equal((await f.report(snapshot)).reported,false);assert.equal(f.calls.length,0);assert.equal(f.mails,0);
  }
});
test('検証失敗の通知は成功後だけ記録し、失敗時もPR・固定Issueの証跡を残す',async()=>{
  const f=fixture(),snapshot=await discoverSeedTrial(f.discover);
  const options={client:f.client,snapshot,validation:'failure',issue:14,runUrl,mail:async()=>{f.mails++;throw new Error('offline');}};
  await assert.rejects(reportSeedTrial(options),/mail/);
  assert.equal(f.calls.length,2);assert.ok(![...f.comments.values()].flat().some(row=>row.body.includes('seed-mail:')));
  options.mail=f.mail;await reportSeedTrial(options);await reportSeedTrial(options);
  assert.equal(f.mails,2);assert.equal(f.comments.get('/issues/7/comments').length,2);
});
test('Bは提案用の枝も受理し、検証・マージせず通知済みの印を付ける',async()=>{
  const f=fixture();f.pr.labels=[{name:'magi2-daily-B'}];f.pr.head.ref+='-proposal1';
  const snapshot=await discoverSeedTrial({...f.discover,changes:()=>assert.fail('B diff must not execute')});
  assert.equal(snapshot.classification,'B');assert.equal(snapshot.validate,false);
  await f.report(snapshot);await f.report(snapshot);assert.equal(f.mails,1);
  assert.ok(f.pr.labels.some(row=>row.name==='magi2-daily-notified'));
});
test('draftのBと発見後にdraftへ戻したBも記録・通知し、再実行では重複送信しない',async()=>{
  for(const initialDraft of [true,false]) {
    const f=fixture();f.pr.draft=initialDraft;f.pr.labels=[{name:'magi2-daily-B'}];f.pr.head.ref+='-proposal1';
    const snapshot=await discoverSeedTrial({...f.discover,changes:()=>assert.fail('B diff must not execute')});
    assert.equal(snapshot.selected,true);assert.equal(snapshot.classification,'B');assert.equal(snapshot.validate,false);
    f.pr.draft=true;
    const result=await f.report(snapshot);assert.equal(result.reported,true);assert.equal(result.merge_enabled,false);
    assert.ok(f.comments.get('/issues/7/comments').some(row=>row.body.includes('区分Bの提案（本人確認が必要）')));
    assert.ok(f.comments.get('/issues/14/comments').some(row=>row.body.includes('区分Bの提案（本人確認が必要）')));
    assert.ok(f.pr.labels.some(row=>row.name==='magi2-daily-notified'));assert.equal(f.pr.draft,true);
    const writes=f.calls.length;await f.report(snapshot);assert.equal(f.mails,1);assert.equal(f.calls.length,writes);
    assert.ok(f.calls.every(call=>call.path.endsWith('/comments')||call.path.endsWith('/labels')));
  }
});
function harnessFixture(run) {
  const root=mkdtempSync(join(tmpdir(),'magi2-seed-harness-')),trusted=join(root,'trusted'),candidate=join(root,'candidate');
  const write=(root,path,text)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);};
  try {
    for(const path of ['.github/scripts/magi2-daily-check.mjs','.github/scripts/test-magi2-daily-check.mjs',
      '.github/scripts/magi-version.mjs','.github/workflows/magi2-daily-merge.yml','.github/scripts/fixtures/magi-versions-apk59.js'])write(trusted,path,'trusted '+path);
    write(trusted,'workers/magi2/src/index.js','not candidate code');write(candidate,'workers/magi2/src/index.js','seeded candidate');
    run({root,trusted,candidate,write});
  }finally{rmSync(root,{recursive:true,force:true});}
}
test('古いbaseには運用基盤だけを補い、候補のWorkerや追加テストを上書きしない',()=>harnessFixture(f=>{
  f.write(f.candidate,'.github/scripts/test-magi-regression.mjs','candidate regression');
  const manifest=installSeedHarness({trustedRoot:f.trusted,candidateRoot:f.candidate});assert.equal(manifest.files.length,5);
  assert.ok(manifest.files.every(row=>/^[a-f0-9]{64}$/.test(row.sha256)));
  assert.equal(readFileSync(join(f.candidate,'workers/magi2/src/index.js'),'utf8'),'seeded candidate');
  assert.equal(readFileSync(join(f.candidate,'.github/scripts/test-magi-regression.mjs'),'utf8'),'candidate regression');
  assert.throws(()=>installSeedHarness({trustedRoot:f.trusted,candidateRoot:f.trusted}),/same_root/);
}));
test('運用基盤のコピー先が外へのsymlinkなら、外部のディレクトリも作らず拒否する',()=>harnessFixture(f=>{
  const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.candidate,'.github'),'dir');
  assert.throws(()=>installSeedHarness({trustedRoot:f.trusted,candidateRoot:f.candidate}),/escape/);
  assert.equal(existsSync(join(outside,'scripts')),false);
}));
test('コピー先ファイルが外へのsymlinkなら、リンク先の有無によらず作成・上書きせず拒否する',()=>{
  for(const existing of [false,true])harnessFixture(f=>{
    const outside=join(f.root,'outside'),target=join(outside,'unexpected.mjs');mkdirSync(outside);
    if(existing)writeFileSync(target,'outside content');
    mkdirSync(join(f.candidate,'.github/scripts'),{recursive:true});
    symlinkSync(target,join(f.candidate,'.github/scripts/magi2-daily-check.mjs'));
    assert.throws(()=>installSeedHarness({trustedRoot:f.trusted,candidateRoot:f.candidate}),/escape/);
    assert.equal(existsSync(target),existing);
    if(existing)assert.equal(readFileSync(target,'utf8'),'outside content');
  });
});
test('試行workflowはmainの手動起動だけで、PRコードへ書き込み権限やsecretを渡さない',()=>{
  const source=readFileSync('.github/workflows/magi2-daily-seed-trial.yml','utf8');
  assert.match(source,/workflow_dispatch:/);assert.doesNotMatch(source,/^\s+(?:schedule|pull_request|pull_request_target):/m);
  assert.match(source,/github.ref == 'refs\/heads\/main'/);assert.match(source,/cancel-in-progress: false/);
  assert.doesNotMatch(source,/contents: write|uses:.*deploy-worker|uses:.*magi2-daily-publication|needs.validate.outputs/);
  const validate=source.slice(source.indexOf('  validate:'),source.indexOf('  report:'));
  assert.doesNotMatch(validate,/secrets\.|issues: write|pull-requests: write/);
  assert.match(source,/TRIAL_VALIDATION: \$\{\{ needs.validate.result \}\}/);
});
