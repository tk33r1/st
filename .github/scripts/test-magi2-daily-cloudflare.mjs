import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloudflareVersionReader,wranglerPublishedVersion,magiWorkerName} from './magi2-daily-cloudflare.mjs';

const accountId='a'.repeat(32),token='SYNTHETIC_SECRET',sha='b'.repeat(40);
const id='11111111-1111-1111-1111-111111111111',deployment='22222222-2222-2222-2222-222222222222';
const other='33333333-3333-3333-3333-333333333333';
const list=(version=id,deploy=deployment)=>({deployments:[{id:deploy,versions:[{version_id:version,percentage:100}]}]});
const version=(message=sha)=>({id,annotations:{'workers/message':message}});
const response=result=>Response.json({success:true,result});
function fixture(rows=[list(),version(),list()]) {
  const calls=[];
  const reader=cloudflareVersionReader({accountId,token,fetcher:async(url,options)=>{
    calls.push({url,options});const row=rows.shift();assert.ok(row,'unexpected request');
    return row instanceof Response?row:response(row);
  }});
  return {reader,calls};
}
test('版取得は固定WorkerのGETだけを使い、API応答を版ID・コミットへ限定する',async()=>{
  const f=fixture();assert.deepEqual(await f.reader(),{id,message:sha,deployment_id:deployment});
  assert.equal(f.calls.length,3);
  assert.deepEqual(f.calls.map(c=>new URL(c.url).pathname),[
    '/client/v4/accounts/'+accountId+'/workers/scripts/'+magiWorkerName()+'/deployments',
    '/client/v4/accounts/'+accountId+'/workers/scripts/'+magiWorkerName()+'/versions/'+id,
    '/client/v4/accounts/'+accountId+'/workers/scripts/'+magiWorkerName()+'/deployments',
  ]);
  for(const {options} of f.calls){assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);}
});
test('dirtyは判断材料として残し、追跡不能な自由文・非文字列を出力しない',async()=>{
  assert.equal((await fixture([list(),version(sha+'-dirty'),list()]).reader()).message,sha+'-dirty');
  for(const message of ['PRIVATE_NOTE '+token,null,{},'x'.repeat(1000)]) {
    const result=await fixture([list(),version(message),list()]).reader();assert.equal(result.message,null);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|SECRET/);
  }
});
test('複数版への配分・版IDの不一致・途中の手動公開を拒否する',async()=>{
  const split=list();split.deployments[0].versions.push({version_id:other,percentage:0});
  const partial=list();partial.deployments[0].versions[0].percentage=50;
  for(const data of [split,partial,{deployments:[]},list('bad')])await assert.rejects(fixture([data]).reader,/ambiguous_deployment/);
  await assert.rejects(fixture([list(),{...version(),id:other}]).reader,/version_mismatch/);
  await assert.rejects(fixture([list(),version(),list(other)]).reader,/deployment_changed/);
  await assert.rejects(fixture([list(),version(),list(id,other)]).reader,/deployment_changed/);
});
test('HTTP・API・JSON・転送の異常を拒否し、応答や例外の秘密を再掲しない',async()=>{
  for(const data of [new Response(token,{status:403}),Response.json({success:false,errors:[{message:token}]}),
    new Response('{'),new Response(' '.repeat(1048577))]) {
    await assert.rejects(fixture([data]).reader,error=>!error.message.includes(token)&&/^cloudflare_/.test(error.message));
  }
  const reader=cloudflareVersionReader({accountId,token,fetcher:async()=>{throw new Error(token);}});
  await assert.rejects(reader,/^Error: cloudflare_transport_failed$/);
  for(const settings of [{accountId:'bad',token,fetcher:fetch},{accountId,token:'',fetcher:fetch},
    {accountId,token},{accountId,token,fetcher:fetch,workerName:'other-worker'}])assert.throws(()=>cloudflareVersionReader(settings),/configuration/);
});
test('公開した版はWranglerのdeployイベントだけから取得し、標準出力の文言を解析しない',()=>{
  const row={type:'deploy',version:1,worker_name:magiWorkerName(),version_id:id};
  const good=JSON.stringify(row);
  assert.equal(wranglerPublishedVersion(JSON.stringify({type:'other'})+'\n'+good+'\n'),id);
  for(const value of ['Current Version ID: '+id,'',good+'\n'+good,JSON.stringify({...row,version:2}),
    JSON.stringify({...row,worker_name:'other'}),JSON.stringify({...row,version_id:'not-a-version'}),
    JSON.stringify({...row,version_id:undefined}),token])assert.throws(()=>wranglerPublishedVersion(value));
});
test('公開版のCLIは通信せず、検証した版IDだけをActionsの出力へ書く',()=>{
  const dir=mkdtempSync(join(tmpdir(),'magi2-version-output-'));
  try {
    const file=join(dir,'wrangler.jsonl'),output=join(dir,'github-output');
    writeFileSync(file,JSON.stringify({type:'deploy',version:1,worker_name:magiWorkerName(),version_id:id})+'\n');
    const env={...process.env,GITHUB_OUTPUT:output};delete env.NODE_TEST_CONTEXT;
    const text=execFileSync(process.execPath,['.github/scripts/magi2-daily-cloudflare.mjs','--published','--file',file],
      {encoding:'utf8',env,stdio:['ignore','pipe','pipe']});
    assert.deepEqual(JSON.parse(text),{id});assert.equal(readFileSync(output,'utf8'),'version-id='+id+'\n');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
