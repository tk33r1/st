// 実サービスへ書かず、信頼する取得結果と模擬I/Oで自動処理の境界を確認する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mergeCandidate,dailySettings} from './magi2-daily-merge.mjs';
import {prepareRelease,finishRelease} from './magi2-daily-release.mjs';
import {announceRelease} from './magi2-daily-release-run.mjs';
import {gitRecovery} from './magi2-daily-recovery.mjs';
import {deploymentPlan} from './magi2-daily-deploy.mjs';
import {checkPlan} from './magi2-daily-check.mjs';
import {deployMagiWorker} from './magi2-daily-deploy-worker.mjs';
import {verifyDailyPublication,publicationRequests} from './magi2-daily-publication.mjs';

const head='a'.repeat(40),base='b'.repeat(40),target='c'.repeat(40);
const previousId='11111111-1111-1111-1111-111111111111',deployedId='22222222-2222-2222-2222-222222222222';
const route={configured:true,live_trial_passed:true,name:'synthetic-service',routine_actor:'synthetic-claude',result_actor:'synthetic-reviewer'};
function evidence() {
  const created_at=new Date(Date.now()-1000).toISOString();
  return {route,requests:[{id:'request',round:1,run_id:'run',head,base,actor:route.routine_actor,created_at,
    selection:{model:'gpt-6.1-sol',effort:'high',source:route.name,selected_at:created_at}}],
  records:[{id:'record',request_id:'request',run_id:'run',head,source:route.name,state:'completed',model:'gpt-6.1-sol',effort:'high'}],
  results:[{request_id:'request',run_id:'run',head,actor:route.result_actor,state:'completed',record_id:'record',
    completed_at:created_at,findings:[],table:'| finding_id | status | evidence |\n| --- | --- | --- |'}],
  claude:[{actor:route.routine_actor,head,model_alias:'opus',effort:'high',created_at}]};
}
const changes={commits:[{sha:head,message:'update docs [magi2-daily]',files:[{path:'workers/magi2/README.md',before:'old\n',after:'new\n',added:['new'],removed:['old']}]}]};
function mergeFixture() {
  const pr={number:7,state:'open',draft:false,user:{login:'tk33r1'},labels:[{name:'magi2-daily-A'}],
    base:{ref:'main',repo:{full_name:'tk33r1/st'}},head:{ref:'automation/magi2-daily-20261023',sha:head,repo:{full_name:'tk33r1/st'}}};
  const f={pr,main:base,stage:'2',halts:[],writes:[],reads:0,events:[]};
  f.client={pages:async path=>path.startsWith('/pulls')?[f.pr]:f.halts,request:async(path,options)=>{
    if(options?.method){f.writes.push({path,...options});f.events.push('merge');return {merged:true,sha:target};}
    if(path==='/branches/main')return {commit:{sha:f.main}};
    if(path==='/pulls/7')return f.pr;throw new Error(path);
  }};
  f.options={client:f.client,snapshot:{number:7,head,base,mechanical:{ok:true}},validation:'success',
    readSettings:async()=>({stage:f.stage,actor:'tk33r1',reviewOff:false}),readReview:async()=>evidence(),
    changes:()=>structuredClone(changes),onAttempt:()=>f.events.push('attempt')};
  return f;
}
test('最終headの正式記録と検証がそろった時だけ、headを指定してrebase mergeする',async()=>{
  const f=mergeFixture(),result=await mergeCandidate(f.options);
  assert.equal(result.state,'merged');assert.equal(result.target,target);
  assert.deepEqual(f.writes,[{path:'/pulls/7/merge',method:'PUT',body:{sha:head,merge_method:'rebase'}}]);
  assert.deepEqual(f.events,['attempt','merge']);
});
test('段階1・停止・更新head/base・draft・区分変更・検証失敗はマージしない',async()=>{
  for(const patch of [f=>f.stage='1',f=>f.halts=[{}],f=>f.main='d'.repeat(40),f=>f.pr.head.sha='d'.repeat(40),
    f=>f.pr.draft=true,f=>f.pr.labels=[],f=>f.options.validation='failure',f=>f.pr.user.login='other']) {
    const f=mergeFixture();patch(f);assert.equal((await mergeCandidate(f.options)).state,'blocked');assert.equal(f.writes.length,0);
  }
});
test('本番の未設定アダプターはstage2でもreadyを作らず、転載・不足した正式記録も使わない',async()=>{
  const f=mergeFixture();delete f.options.readReview;
  assert.equal((await mergeCandidate(f.options)).state,'blocked');assert.equal(f.writes.length,0);
  for(const patch of [e=>e.route=null,e=>e.records=[],e=>e.records[0].effort='medium',e=>e.claude=[]]) {
    const g=mergeFixture(),value=evidence();patch(value);g.options.readReview=async()=>({...value,next:'ready'});
    assert.equal((await mergeCandidate(g.options)).state,'blocked');assert.equal(g.writes.length,0);
  }
});
test('直前の段階・head・base変更を再取得して止まり、APIの結果不明と異なるマージ範囲は復旧対象にしない',async()=>{
  for(const kind of ['stage','head','base']) {
    const f=mergeFixture();let calls=0;
    f.options.readSettings=async()=>{if(++calls===2){if(kind==='stage')f.stage='1';if(kind==='head')f.pr.head.sha='d'.repeat(40);if(kind==='base')f.main='d'.repeat(40);}
      return {stage:f.stage,actor:'tk33r1',reviewOff:false};};
    assert.equal((await mergeCandidate(f.options)).state,'blocked');assert.equal(f.writes.length,0);
  }
  const f=mergeFixture(),request=f.client.request;
  f.client.request=async(path,options)=>{if(options?.method)throw new Error('network failed');return request(path,options);};
  assert.equal((await mergeCandidate(f.options)).state,'merge_unknown');assert.deepEqual(f.events,['attempt']);
  const g=mergeFixture();g.options.changes=(b,h)=>h===head?structuredClone(changes):{commits:[]};
  assert.equal((await mergeCandidate(g.options)).state,'merge_invalid');
});
test('リポジトリ変数は実APIから読み、権限不足を段階2やレビュー省略にしない',async()=>{
  const settings=await dailySettings({request:async path=>{if(path.endsWith('STAGE'))return {value:'2'};throw new Error('github_404_GET_'+path);}});
  assert.deepEqual(settings,{stage:'2',actor:'tk33r1',reviewOff:false});
  await assert.rejects(dailySettings({request:async()=>{throw new Error('github_403_GET');}}));
});

const release=()=>({merge:{state:'merged',target,head,base,number:7},previous:{id:previousId,message:base},
  plan:{action:'deploy',rollback_commits:[head]}});
function finishFixture() {
  const events=[],r=release();let restored=false;
  const options={release:r,results:{worker:'success',deploy:'success',publication:'failure',versionId:deployedId},
    readDeployment:async()=>restored?{id:previousId,message:base}:{id:deployedId,message:target},
    rollback:async id=>{events.push(['rollback',id]);restored=true;},revert:async()=>events.push(['revert']),push:async()=>events.push(['push']),
    save:async report=>events.push(['save',report.rollback,report.revert,report.push]),announce:async report=>events.push(['announce',report.reason])};
  return {options,events};
}
test('文書だけなら本番を読まず、版取得失敗も公開へ進めない',async()=>{
  let reads=0;
  const input={merge:release().merge,readDeployment:async()=>{reads++;throw new Error('offline');},plan:({previous})=>previous?{action:'deploy'}:{action:'skip'}};
  assert.equal((await prepareRelease(input)).plan.action,'skip');assert.equal(reads,0);
  input.plan=()=>({action:'blocked'});assert.equal((await prepareRelease(input)).plan.reason,'production_version_unavailable');
});
test('公開成功を通知し、失敗では保存→rollback→版確認→revert→push→停止通知の順を守る',async()=>{
  const success=finishFixture();success.options.results.publication='success';
  assert.equal((await finishRelease(success.options)).halt_required,false);assert.ok(!success.events.some(e=>e[0]==='rollback'));
  const f=finishFixture(),report=await finishRelease(f.options);
  assert.equal(report.reason,'recovered');assert.equal(report.halt_required,true);
  assert.deepEqual(f.events.filter(e=>e[0]!=='save'),[['rollback',previousId],['revert'],['push'],['announce','recovered']]);
  assert.equal(f.events[0][0],'save');
});
test('版の割り込み・不明な公開版・検査失敗・未確定マージ・準備失敗では推測で戻さない',async()=>{
  for(const patch of [f=>f.options.readDeployment=async()=>({id:previousId,message:base}),
    f=>f.options.results.versionId='',f=>f.options.results.worker='failure',f=>f.options.release.merge.state='merge_unknown',
    f=>f.options.release.plan={action:'blocked',reason:'dirty'},f=>f.options.readDeployment=async()=>{throw new Error('offline');}]) {
    const f=finishFixture();patch(f);const result=await finishRelease(f.options);
    assert.equal(result.halt_required,true);assert.ok(!f.events.some(e=>['rollback','revert','push'].includes(e[0])));
  }
});
test('停止Issueの保存中に手動公開された場合も、rollback前の再取得で止まる',async()=>{
  const f=finishFixture();let interrupted=false;
  f.options.save=async()=>{interrupted=true;};
  f.options.readDeployment=async()=>interrupted?{id:previousId,message:base}:{id:deployedId,message:target};
  assert.equal((await finishRelease(f.options)).reason,'deployment_interrupted');
  assert.ok(!f.events.some(e=>e[0]==='rollback'));
});
test('rollback失敗・復旧版不一致ではrevertせず、revert競合ではpushせず、push失敗も停止する',async()=>{
  for(const [patch,reason,forbidden] of [
    [f=>f.options.rollback=async()=>{throw new Error('failed');},'rollback_failed','revert'],
    [f=>f.options.readDeployment=async()=>({id:deployedId,message:target}),'rollback_failed','revert'],
    [f=>f.options.revert=async()=>{throw new Error('conflict');},'revert_conflict','push'],
    [f=>f.options.push=async()=>{throw new Error('rejected');},'push_failed','unused'],
  ]) {
    const f=finishFixture();patch(f);const result=await finishRelease(f.options);
    assert.equal(result.reason,reason);assert.equal(result.halt_required,true);assert.ok(!f.events.some(e=>e[0]===forbidden));
  }
});
function notificationFixture() {
  const comments=[],issues=[],calls=[];let mailFailure=true,mails=0;
  const client={pages:async path=>path.includes('/comments')?comments:issues,request:async(path,options)=>{
    calls.push({path,...options});
    if(path==='/issues'){const row={number:22,user:{login:'github-actions[bot]'},...options.body};issues.push(row);return row;}
    if(path==='/issues/22'){Object.assign(issues[0],options.body);return issues[0];}
    if(path.endsWith('/comments')){comments.push({user:{login:'github-actions[bot]'},...options.body});return {};}
    throw new Error(path);
  }};
  return {client,calls,issues,comments,get mails(){return mails;},recoverMail:()=>mailFailure=false,
    mail:async()=>{mails++;if(mailFailure)throw new Error('mail failed');}};
}
test('メール失敗でも停止Issueと記録を残し、成功後だけ通知済みを記録して二重送信しない',async()=>{
  const f=notificationFixture(),report=await finishRelease(finishFixture().options);
  await assert.rejects(announceRelease({...f,issue:14,report}),/notification_failed/);
  assert.equal(f.issues.length,1);assert.ok(f.issues[0].body.includes('rollback: success'));
  assert.ok(!f.comments.some(c=>c.body.includes('magi2-daily:mail:')));
  f.recoverMail();await announceRelease({...f,issue:14,report});await announceRelease({...f,issue:14,report});
  assert.equal(f.mails,2);assert.equal(f.issues.length,1);
});
test('停止Issue作成が失敗してもメールを試し、docだけではメールしない',async()=>{
  const f=notificationFixture();f.recoverMail();const request=f.client.request;
  f.client.request=async(path,options)=>{if(path==='/issues')throw new Error('issues unavailable');return request(path,options);};
  const report=await finishRelease(finishFixture().options);
  await assert.rejects(announceRelease({...f,issue:14,report}),/halt_issue/);assert.equal(f.mails,1);
  const g=notificationFixture(),skip={...report,outcome:'skip',halt_required:false,reason:'no_worker_changes'};
  await announceRelease({...g,issue:14,report:skip});assert.equal(g.mails,0);
});

function gitFixture(run) {
  const temporary=mkdtempSync(join(tmpdir(),'magi2-auto-git-')),root=join(temporary,'source'),remote=join(temporary,'remote.git');mkdirSync(root);
  const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',
    '-c','user.name=Synthetic test','-c','user.email=test@example.invalid',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const commit=(path,text,message='fix [magi2-daily]',bot=false)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);git(root,'add','.');
    git(root,...(bot?['-c','user.name=github-actions[bot]']:[]),'commit','-m',message);return git(root,'rev-parse','HEAD');};
  try {
    git(root,'init','-b','main');const base=commit('workers/magi2/src/index.js','baseline\n','baseline');
    const fix=commit('workers/magi2/src/index.js','fixed\n');commit('data/magi-context.json','bot card\n','rebuild cards',true);
    const target=commit('data/magi-versions.json','6.01\n','bump version [magi2-daily]');
    const previous={id:previousId,message:base},plan=deploymentPlan({root,target,mergeBase:base,previous});
    const human=commit('human.txt','keep human work\n','manual later work');
    git(temporary,'init','--bare','--initial-branch=main',remote);git(root,'remote','add','origin',remote);git(root,'push','origin','main');
    return run({root,remote,git,commit,base,fix,target,human,release:{merge:{state:'merged',base,target},previous,plan}});
  } finally{rmSync(temporary,{recursive:true,force:true});}
}
test('実Gitで版を含むdailyだけをrevert・pushし、botカードと後続の本人コミットを残す',()=>gitFixture(f=>{
  const recovery=gitRecovery({release:f.release,token:'SYNTHETIC',remote:f.remote});
  try {recovery.revert();recovery.push();}finally{recovery.cleanup();}
  assert.equal(f.git(f.remote,'show','main:workers/magi2/src/index.js'),'baseline');
  assert.equal(f.git(f.remote,'show','main:data/magi-context.json'),'bot card');
  assert.equal(f.git(f.remote,'show','main:human.txt'),'keep human work');
  assert.equal(f.git(f.remote,'merge-base','--is-ancestor',f.human,'main'),'');
  assert.equal(f.git(f.root,'rev-parse','HEAD'),f.human);
}));
test('実Gitのrevert競合・偽の戻し対象を拒否し、push前は元リポジトリを変えない',()=>gitFixture(f=>{
  f.commit('workers/magi2/src/index.js','manual conflicting line\n','manual');f.git(f.root,'push','origin','main');
  const recovery=gitRecovery({release:f.release,token:'SYNTHETIC',remote:f.remote});
  try {assert.throws(()=>recovery.revert());}finally{recovery.cleanup();}
  assert.equal(f.git(f.remote,'show','main:workers/magi2/src/index.js'),'manual conflicting line');
  const forged=gitRecovery({release:{...f.release,plan:{...f.release.plan,rollback_commits:[f.human]}},token:'SYNTHETIC',remote:f.remote});
  try{assert.throws(()=>forged.revert(),/commits_changed/);}finally{forged.cleanup();}
}));
test('workflowは結果だけを採用し、公開と確認を再利用してalwaysの復旧へ接続する',()=>{
  const source=readFileSync('.github/workflows/magi2-daily-merge.yml','utf8');
  const worker=source.slice(source.indexOf('  worker:'),source.indexOf('  deploy:'));
  assert.doesNotMatch(worker,/secrets\.|contents: write|outputs:/);assert.match(worker,/--worker --root/);
  assert.match(source,/sha: \$\{\{ needs.prepare.outputs.target \}\}/);
  assert.match(source,/expected-version-id: \$\{\{ needs.prepare.outputs.previous-id \}\}/);
  assert.match(source,/version-id: \$\{\{ needs.deploy.outputs.version-id \}\}/);
  assert.match(source,/if: always\(\) && needs.merge.outputs.attempted == 'true'/);
  assert.doesNotMatch(source,/needs\.(?:validate|worker)\.outputs|continue-on-error|secrets: inherit/);
  assert.ok(checkPlan('worker').commands.some(c=>c.includes('.github/scripts/test-magi2-daily-automation.mjs')));
});
test('模擬サービスでマージからキー同時公開・公開確認・成功通知又は復旧停止まで通す',async()=>{
  const history=JSON.parse(readFileSync('data/magi-versions.json','utf8'));
  const description={desc:{ja:'説明',en:'Description'},context:{ja:'素材',en:'Context'},theme:{ja:'テーマ',en:'Theme'}};
  const catalog={personas:Object.fromEntries(['MELCHIOR-1','BALTHASAR-2','CASPER-3'].map(key=>[key,description])),
    synthesizer:description,privacy:{ja:[{text:'説明'}],en:[{text:'Description'}]}};
  for(const fail of [false,true]) {
    const f=mergeFixture(),merge=await mergeCandidate(f.options),events=[];
    let current={id:previousId,message:base};
    const readDeployment=async()=>({...current});
    const r=await prepareRelease({merge,readDeployment,plan:({previous})=>previous
      ?{action:'deploy',rollback_commits:[target]}:{action:'blocked',reason:'previous_version_untracked_or_dirty'}});
    await deployMagiWorker({target:r.merge.target,expectedId:r.previous.id,anthropicKey:'SYNTHETIC',readDeployment,run:args=>{
      assert.equal(args[args.indexOf('--message')+1],r.merge.target);current={id:deployedId,message:r.merge.target};events.push('deploy');return {status:0};
    }});
    const publication=await verifyDailyPublication({readDeployment,expected:{id:current.id,sha:r.merge.target,version:history.versions[0].version},
      fetcher:async(url,options)=>{
        assert.equal(options.headers.Authorization,undefined);
        if(url.endsWith('/models'))return Response.json(fail?{}:catalog);
        const probe=publicationRequests().find(p=>p.url===url&&p.options.body===options.body&&p.options.headers.Origin===options.headers.Origin);
        assert.ok(probe);
        const body=probe.name==='versions'?history:probe.name==='legacy_versions'
          ?{versions:history.versions.filter(row=>row.version==='earlier'||/^\d{1,2}\.\d$/.test(row.version))}
          :probe.name==='old_generation_rejected'?{status:'failed',complete:false,reason:probe.code,results:[]}:{error:{code:probe.code}};
        return Response.json(body,{status:probe.status});
      }});
    const report=await finishRelease({release:r,results:{worker:'success',deploy:'success',publication:publication.ok?'success':'failure',versionId:deployedId},
      readDeployment,rollback:async id=>{assert.equal(id,previousId);events.push('rollback');current={...r.previous};},
      revert:async()=>events.push('revert'),push:async()=>events.push('push'),announce:async report=>events.push(report.halt_required?'halt':'success')});
    assert.equal(report.reason,fail?'recovered':'published');
    assert.deepEqual(events,fail?['deploy','rollback','revert','push','halt']:['deploy','success']);
  }
});
test('実行入口はActionsのneedsを読み、正常通知・通知失敗時の停止・マージ不明を記録する',()=>{
  const directory=mkdtempSync(join(tmpdir(),'magi2-release-cli-'));
  try {
    const preload=join(directory,'fetch.mjs'),state=join(directory,'state.json'),report=join(directory,'report.json');
    writeFileSync(preload,`import {writeFileSync} from 'node:fs';
const state={comments:[],issues:[],mail:0,cf:0};
const save=()=>writeFileSync(process.env.SYNTHETIC_STATE,JSON.stringify(state));
globalThis.fetch=async(url,options={})=>{
  const parsed=new URL(url),path=parsed.pathname,body=options.body?JSON.parse(options.body):null;
  if(parsed.hostname==='api.cloudflare.com') {
    state.cf++;save();
    return Response.json({success:true,result:path.endsWith('/deployments')
      ?{deployments:[{id:'33333333-3333-3333-3333-333333333333',versions:[{version_id:'${deployedId}',percentage:100}]}]}
      :{id:'${deployedId}',annotations:{'workers/message':'${target}'}}});
  }
  if(parsed.hostname==='api.resend.com'){state.mail++;save();return new Response('{}',{status:process.env.SYNTHETIC_MAIL_FAIL==='true'?500:200});}
  if(parsed.hostname!=='api.github.com'||!path.startsWith('/repos/tk33r1/st/'))throw new Error('Unexpected network');
  if(path.endsWith('/comments')) {
    if(options.method==='POST'){state.comments.push({user:{login:'github-actions[bot]'},...body});save();return Response.json({});}
    return Response.json(state.comments);
  }
  if(options.method==='POST'&&path.endsWith('/issues')){const value={number:22,user:{login:'github-actions[bot]'},...body};state.issues.push(value);save();return Response.json(value);}
  if(options.method==='PATCH'&&path.endsWith('/issues/22')){Object.assign(state.issues[0],body);save();return Response.json(state.issues[0]);}
  if(path.endsWith('/issues'))return Response.json(state.issues);
  throw new Error('Unexpected request');
};
save();
`);
    for(const mode of ['success','mail_failure','merge_unknown']) {
      const r=release();if(mode==='merge_unknown')r.merge={...r.merge,state:'merge_unknown',target:null};
      const env={...process.env,GITHUB_TOKEN:'SYNTHETIC',GITHUB_REPOSITORY:'tk33r1/st',MAGI2_DAILY_ISSUE:'14',
        CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'SYNTHETIC',RESEND_API_KEY:'SYNTHETIC',
        ALERT_TO:'synthetic@example.invalid',ALERT_FROM:'synthetic@example.invalid',
        DAILY_MERGE:JSON.stringify(r.merge),DAILY_RELEASE:JSON.stringify(r),DAILY_REPORT:report,
        DAILY_RESULTS:JSON.stringify({worker:{result:'success'},deploy:{result:'success',outputs:{'version-id':deployedId}},publication:{result:'success'}}),
        SYNTHETIC_STATE:state,SYNTHETIC_MAIL_FAIL:String(mode==='mail_failure')};delete env.NODE_TEST_CONTEXT;
      const run=()=>execFileSync(process.execPath,['--import',preload,resolve('.github/scripts/magi2-daily-release-run.mjs'),'--finish'],
        {cwd:directory,env,stdio:['ignore','pipe','pipe']});
      if(mode==='success')run();else assert.throws(run);
      const saved=JSON.parse(readFileSync(report,'utf8')),calls=JSON.parse(readFileSync(state,'utf8'));
      assert.equal(saved.reason,mode==='success'?'published':mode==='mail_failure'?'notification_failed':'merge_unverified');
      assert.equal(calls.mail,1);assert.equal(calls.issues.length,mode==='success'?0:1);
      if(mode==='mail_failure'){assert.equal(saved.notification,'failure');assert.ok(!calls.comments.some(c=>c.body.includes('magi2-daily:mail:')));}
      if(mode==='merge_unknown')assert.equal(calls.cf,0);
    }
  } finally{rmSync(directory,{recursive:true,force:true});}
});
