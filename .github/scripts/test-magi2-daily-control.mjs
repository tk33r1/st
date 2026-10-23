import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {observationSQL,cleanObservation,catalogObservation,observationText,observationPeriod,weeklyPRs} from './magi2-daily-observe.mjs';
import {eligibleDailyPR,githubClient,commentOnce,stateComment,notifyDaily} from './magi2-daily-github.mjs';
import {report} from './magi2-daily-control.mjs';

const period={from:'2026-10-16',until:'2026-10-23'},empty=()=>[{success:true,results:[]},{success:true,results:[]}];
const body={desc:{ja:'説明',en:'description'},context:{ja:'素材',en:'context'},theme:{ja:'テーマ',en:'theme'}};
const models={personas:Object.fromEntries(['MELCHIOR-1','BALTHASAR-2','CASPER-3'].map(k=>[k,body])),synthesizer:body,privacy:{ja:[{text:'説明'}],en:[{text:'Description'}]}};
const pr=()=>({number:7,state:'open',html_url:'https://github.com/tk33r1/st/pull/7',user:{login:'tk33r1'},
  labels:[{name:'magi2-daily-A'}],base:{ref:'main',repo:{full_name:'tk33r1/st'}},
  head:{ref:'automation/magi2-daily-20261023',sha:'a'.repeat(40),repo:{full_name:'tk33r1/st'}}});
function clientFixture(initial=[pr()]) {
  const calls=[],comments=new Map(),prs=structuredClone(initial),main='b'.repeat(40);
  const client={pages:async path=>{
    if(path.startsWith('/pulls'))return prs;
    if(path.startsWith('/issues?'))return [];
    return comments.get(path)||[];
  },request:async(path,options)=>{
    if(!options){if(path==='/branches/main')return {commit:{sha:main}};throw new Error(path);}
    calls.push({path,...options});
    const target=prs.find(pr=>path.startsWith('/issues/'+pr.number+'/labels'));
    if(target&&options.method==='POST')for(const name of options.body.labels) {
      if(!target.labels.some(row=>row.name===name))target.labels.push({name});
    }
    if(target&&options.method==='DELETE')target.labels=target.labels.filter(row=>!path.endsWith('/'+row.name));
    if(path.endsWith('/comments')) {
      const rows=comments.get(path)||[];rows.push({id:rows.length+1,user:{login:'github-actions[bot]'},body:options.body.body});comments.set(path,rows);
    }
    return {};
  }};
  return {client,calls,comments,prs,main};
}
test('週次集計のSELECTは固定3カウンターとリアクション件数だけを返す',()=>{
  const sql=observationSQL(period);assert.doesNotMatch(sql,/\b(?:INSERT|DELETE|UPDATE|SELECT\s+\*)\b/i);
  const script="import sqlite3,json\ndb=sqlite3.connect(':memory:')\ndb.row_factory=sqlite3.Row\n"
    +"db.executescript('CREATE TABLE rate_limit(ip TEXT,day TEXT,count INTEGER); CREATE TABLE reactions(created_at TEXT,request TEXT,response TEXT,ip TEXT);')\n"
    +"db.executemany('INSERT INTO rate_limit VALUES (?,?,?)',[('global','2026-10-22',3),('192.0.2.1','2026-10-22',99)])\n"
    +"db.execute('INSERT INTO reactions VALUES (?,?,?,?)',('2026-10-22T00:00:00Z','PRIVATE_INPUT','PRIVATE_REPLY','192.0.2.1'))\n"
    +"print(json.dumps([{'success':True,'results':[dict(r) for r in db.execute(s)]} for s in input().split(';') if s.strip()]))\n";
  const result=spawnSync('python',['-B','-c',script],{input:sql.replaceAll('\n',' '),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/PRIVATE|192\.0\.2\.1/);
  const report=cleanObservation(JSON.parse(result.stdout),period);assert.equal(report.days.length,7);
  assert.equal(report.days.at(-1).global,3);assert.equal(report.days.at(-1).reactions,1);
});
test('集計結果に本文・IP・未知のカウンター・重複・範囲外が混ざれば出力しない',()=>{
  for(const patch of [{ip:'192.0.2.1'},{request:'PRIVATE'},{response:'PRIVATE'},{kind:'192.0.2.1'},
    {day:'2026-10-23'},{day:'2026-02-30'},{count:-1},{count:'1'}]) {
    const data=empty();data[0].results=[{day:'2026-10-22',kind:'global',count:1,...patch}];assert.throws(()=>cleanObservation(data,period));
  }
  const duplicate=empty();duplicate[0].results=Array(2).fill({day:'2026-10-22',kind:'global',count:1});assert.throws(()=>cleanObservation(duplicate,period));
  assert.deepEqual(observationPeriod(new Date('2026-10-23T03:00:00Z')),period);
  assert.throws(()=>observationSQL({from:"' OR 1=1",until:period.until}));
});
test('カタログは固定GETだけで形を点検し、本文やモデル名を報告へ転載しない',async()=>{
  const calls=[];const result=await catalogObservation(async(url,options)=>{calls.push({url,options});return Response.json(models);});
  assert.equal(result.ok,true);assert.equal(calls[0].url,'https://workers.tk.st/magi2/models');assert.equal(calls[0].options.body,undefined);
  assert.equal((await catalogObservation(async()=>Response.json({}))).ok,false);
  assert.equal((await catalogObservation(async()=>{throw new Error('PRIVATE');})).status,null);
  const text=observationText(cleanObservation(empty(),period),result,[],'6.0');assert.doesNotMatch(text,/PRIVATE|description/);
});
test('週次workflowはD1の文ごとの結果を得るcommandを使い、登録した作成者を集計する',()=>{
  const workflow=readFileSync('.github/workflows/magi2-daily-observe.yml','utf8');
  assert.match(workflow,/--command /);assert.doesNotMatch(workflow,/--file /);
  assert.match(workflow,/MAGI2_DAILY_ACTOR: \$\{\{ vars\.MAGI2_DAILY_ACTOR \}\}/);
  const a=pr();a.user.login='daily-bot';a.merged_at='2026-10-20T00:00:00Z';
  const b=pr();b.user.login='daily-bot';b.labels=[{name:'magi2-daily-B'}];b.created_at='2026-10-21T00:00:00Z';
  const text=observationText(cleanObservation(empty(),period),{ok:true,status:200},[a,b],'6.0',{actor:'daily-bot'});
  assert.match(text,/区分Aのマージ 1件、区分Bの新規PR 1件/);
});
test('週次PR取得はupdated降順で期間開始に達したら打ち切り、期間開始ちょうどは含める',async()=>{
  const calls=[],rows=Array.from({length:100},()=>({...pr(),updated_at:'2026-10-20T00:00:00Z'}));
  const client=githubClient('synthetic',{fetcher:async url=>{
    calls.push(url);assert.match(url,/sort=updated&direction=desc/);
    return Response.json(calls.length===1?rows:[
      {...pr(),updated_at:period.from+'T00:00:00Z'},
      {...pr(),updated_at:'2026-10-15T23:59:59Z'},
    ]);
  }});
  const result=await weeklyPRs(client,period);assert.equal(result.length,101);assert.equal(calls.length,2);
  const all=githubClient('synthetic',{fetcher:async()=>Response.json([{number:1}])});
  assert.deepEqual(await all.pages('/pulls?state=open'),[{number:1}]);
});
test('Bのメールが失敗しても他PRの状態とA重複の報告を続け、未通知分は次回再試行する',async()=>{
  const b=pr();b.number=8;b.labels=[{name:'magi2-daily-B'}];
  const f=clientFixture([b,pr()]),snapshot={number:7,head:'a'.repeat(40),base:f.main,mechanical:{ok:true},open_a:[7]};
  await assert.rejects(()=>report(f.client,snapshot,{issue:10,validation:'success',mail:async()=>{throw new Error('daily_mail_not_configured');}}));
  assert.ok(f.calls.some(c=>c.path==='/issues/7/comments'&&c.body.body.includes('"next": "unconfigured"')));
  assert.ok(!f.prs[0].labels.some(l=>l.name==='magi2-daily-notified'));
  let sent=0;await report(f.client,snapshot,{issue:10,mail:async()=>{sent++;}});assert.equal(sent,1);
  const duplicate=clientFixture([b]);
  await assert.rejects(()=>report(duplicate.client,{open_a:[7,9]},{issue:10,mail:async()=>{throw new Error('daily_mail_500');}}));
  assert.ok(duplicate.calls.some(c=>c.body?.body?.includes('区分Aが複数')));
  const b2=structuredClone(b);b2.number=9;
  const others=clientFixture([b,b2]);
  await assert.rejects(()=>report(others.client,{open_a:[]},{issue:10,mail:async(text,key)=>{if(key[1]===8)throw new Error('daily_mail_500');}}));
  assert.ok(others.prs[1].labels.some(l=>l.name==='magi2-daily-notified'));
});
test('同じrepo・本人・規定ブランチ・Aだけを候補にし、forkと別の人は外す',()=>{
  assert.equal(eligibleDailyPR(pr()),true);
  for(const update of [p=>p.user.login='outsider',p=>p.head.repo.full_name='other/st',p=>p.head.ref='main',p=>p.labels=[]]){
    const value=pr();update(value);assert.equal(eligibleDailyPR(value),false);
  }
  assert.throws(()=>githubClient('synthetic',{repository:'other/st'}));
});

test('R3: Bは案件ごとの枝でも通知し、repo・作成者・ラベルの条件は維持する',async()=>{
  const proposal=pr();proposal.labels=[{name:'magi2-daily-B'}];proposal.head.ref='automation/magi2-daily-20261023-proposal1';
  assert.equal(eligibleDailyPR(proposal,{label:'magi2-daily-B'}),true);
  assert.equal(eligibleDailyPR(proposal),false);
  for(const update of [p=>p.user.login='outsider',p=>p.head.repo.full_name='other/st',p=>p.base.ref='other',p=>p.labels=[]]) {
    const value=structuredClone(proposal);update(value);assert.equal(eligibleDailyPR(value,{label:'magi2-daily-B'}),false);
  }
  const f=clientFixture([proposal]),mails=[];
  await report(f.client,{open_a:[]},{issue:10,mail:async(...args)=>mails.push(args)});
  await report(f.client,{open_a:[]},{issue:10,mail:async(...args)=>mails.push(args)});
  assert.equal(mails.length,1);assert.equal(f.calls.filter(c=>c.path==='/issues/10/comments').length,1);
  assert.ok(f.prs[0].labels.some(row=>row.name==='magi2-daily-notified'));
});

test('R4: AからBへの移行は途中失敗しても追跡でき、再実行で通知まで完了する',async()=>{
  for(const failure of ['add_B','remove_A','mail']) {
    const f=clientFixture(),target=f.prs[0],send=f.client.request;
    target.labels.push({name:'keep-me'});
    let once=true,mails=0;
    f.client.request=async(path,options)=>{
      if(once&&(failure==='add_B'&&options?.body?.labels?.includes('magi2-daily-B')
        ||failure==='remove_A'&&options?.method==='DELETE')){once=false;throw new Error('synthetic failure');}
      return send(path,options);
    };
    const mail=async()=>{if(once&&failure==='mail'){once=false;throw new Error('synthetic failure');}mails++;};
    const snapshot={number:7,head:target.head.sha,base:f.main,mechanical:{ok:true},open_a:[7]};
    await assert.rejects(()=>report(f.client,snapshot,{issue:10,validation:'failure',mail}),/synthetic failure/);
    assert.ok(target.labels.some(row=>['magi2-daily-A','magi2-daily-B'].includes(row.name)));
    const a=eligibleDailyPR(target);
    assert.equal(a,failure==='add_B');
    await report(f.client,a?snapshot:{open_a:[]},{issue:10,validation:'failure',mail});
    await report(f.client,{open_a:[]},{issue:10,mail});
    assert.deepEqual(target.labels.map(row=>row.name).sort(),['keep-me','magi2-daily-B','magi2-daily-notified']);
    assert.equal(mails,1);assert.equal(f.calls.filter(c=>c.path==='/issues/10/comments').length,1);
  }
});
test('通知の重複防止と状態更新はActions自身のコメントだけを数える',async()=>{
  const f=clientFixture();const marker='<!-- magi2-daily:state -->';
  f.comments.set('/issues/7/comments',[{id:99,user:{login:'outsider'},body:marker+'fake'}]);
  await stateComment(f.client,7,{next:'unconfigured'});assert.equal(f.calls.at(-1).method,'POST');
  const count=f.calls.length;await stateComment(f.client,7,{next:'unconfigured'});assert.equal(f.calls.length,count);
  await commentOnce(f.client,10,['test'],'message');await commentOnce(f.client,10,['test'],'message');
  assert.equal(f.calls.filter(c=>c.path==='/issues/10/comments').length,1);
});
test('段階2の変数や見せかけのreadyがあっても準備版はレビュー未設定のままマージしない',async()=>{
  const f=clientFixture(),snapshot={number:7,head:'a'.repeat(40),base:f.main,mechanical:{ok:true},open_a:[7]};
  await report(f.client,snapshot,{issue:10,stage:'2',validation:'success',mail:()=>{throw new Error('no mail expected');}});
  assert.ok(f.calls.some(c=>c.body?.body?.includes('"next": "unconfigured"')));
  assert.ok(!f.calls.some(c=>/\/merge$/.test(c.path)));
  const count=f.calls.length;f.prs[0].head.sha='c'.repeat(40);
  await report(f.client,snapshot,{issue:10,stage:'2',validation:'failure'});assert.equal(f.calls.length,count);
});
test('検証失敗だけをBへ移し、メール成功後に通知済みを付ける',async()=>{
  const f=clientFixture(),snapshot={number:7,head:'a'.repeat(40),base:f.main,mechanical:{ok:true},open_a:[7]},mails=[];
  await report(f.client,snapshot,{issue:10,validation:'failure',mail:async(...args)=>mails.push(args)});
  assert.equal(mails.length,1);assert.ok(f.calls.some(c=>c.method==='DELETE'&&c.path.endsWith('/magi2-daily-A')));
  assert.ok(f.calls.some(c=>c.body?.labels?.includes('magi2-daily-notified')));
  const noSend=clientFixture();noSend.prs[0].labels=[{name:'magi2-daily-B'},{name:'magi2-daily-notified'}];
  await report(noSend.client,{open_a:[]},{issue:10,mail:async()=>{throw new Error('already notified');}});
});
test('メールは本文形式・固定送り先・同じイベントの同じ重複防止キーで送る',async()=>{
  const calls=[],env={RESEND_API_KEY:'synthetic',ALERT_TO:'synthetic@example.test',ALERT_FROM:'sender@example.test'};
  for(let i=0;i<2;i++)await notifyDaily('message',['B',7],{env,fetcher:async(url,options)=>{calls.push({url,options});return Response.json({id:'synthetic'});}});
  assert.equal(calls[0].url,'https://api.resend.com/emails');assert.equal(calls[0].options.headers['Idempotency-Key'],calls[1].options.headers['Idempotency-Key']);
  assert.equal(JSON.parse(calls[0].options.body).html,undefined);
  await assert.rejects(()=>notifyDaily('message',['B',7],{env:{}}),/not_configured/);
});
test('workflowはmainから起動し、PRコードのジョブにsecret・書き込み権限・採用する出力が無い',()=>{
  const source=readFileSync('.github/workflows/magi2-daily-merge.yml','utf8');
  assert.doesNotMatch(source,/^\s+pull_request(?:_target)?:/m);assert.match(source,/cancel-in-progress: false/);
  const validation=source.slice(source.indexOf('  validate:'),source.indexOf('  report:'));
  assert.doesNotMatch(validation,/secrets\.|contents: write|pull-requests: write|outputs:/);
  assert.match(validation,/persist-credentials: false/);assert.match(validation,/\.\.\/trusted\/\.github\/scripts\/magi2-daily-check\.mjs/);
  assert.doesNotMatch(source,/needs\.validate\.outputs/);
  assert.match(source,/DAILY_VALIDATION: \$\{\{ needs\.validate\.result \}\}/);
});
test('手動公開も共通workflowを使い、40桁SHAを固定しAnthropic同期と版のメッセージを維持する',()=>{
  const wrapper=readFileSync('.github/workflows/deploy-worker.yml','utf8'),core=readFileSync('.github/workflows/deploy-worker-core.yml','utf8');
  assert.match(wrapper,/uses: \.\/\.github\/workflows\/deploy-worker-core\.yml/);
  assert.match(wrapper,/sha: \$\{\{ github\.sha \}\}/);assert.match(core,/ref: \$\{\{ inputs\.sha \}\}/);
  assert.ok(core.includes('^[a-f0-9]{40}$'));assert.ok(core.includes('--message "$DEPLOY_SHA"'));
  assert.ok(core.includes('secret put MAGI_ANTHROPIC_API_KEY'));assert.ok(core.includes("inputs.worker == 'magi2' && !inputs.dry-run"));
  assert.ok(core.includes('0008_transition_scores.sql'));assert.ok(core.includes('persist-credentials: false'));
});
test('共通公開はdispatchのoptionsだけでWorkerを選び、未知名は理由を示して拒否する',()=>{
  const wrapper=readFileSync('.github/workflows/deploy-worker.yml','utf8');
  const core=readFileSync('.github/workflows/deploy-worker-core.yml','utf8');
  assert.doesNotMatch(core,/case "\$WORKER" in/);
  const script=core.match(/node --input-type=module <<'JS'\n([\s\S]*?)^        JS$/m)?.[1];assert.ok(script);
  const dir=mkdtempSync(join(tmpdir(),'magi2-worker-options-'));
  try {
    const path=join(dir,'.github/workflows/deploy-worker.yml');mkdirSync(dirname(path),{recursive:true});
    writeFileSync(path,wrapper.replace('          - games','          - games\n          - future-worker'));
    const run=worker=>spawnSync(process.execPath,['--input-type=module','-e',script],
      {cwd:dir,encoding:'utf8',env:{PATH:process.env.PATH,WORKER:worker}});
    assert.equal(run('magi2').status,0);assert.equal(run('future-worker').status,0);
    const invalid=run('missing');assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/::error::Worker must be listed/);
  } finally {assert.equal(dirname(dir),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});}
});
