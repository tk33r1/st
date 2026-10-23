import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {publicationRequests,verifyDailyPublication} from './magi2-daily-publication.mjs';

const history=JSON.parse(readFileSync('data/magi-versions.json','utf8'));
const expected={id:'deployed-version',sha:'a'.repeat(40),version:history.versions[0].version};
const body={desc:{ja:'説明',en:'description'},context:{ja:'素材',en:'context'},theme:{ja:'テーマ',en:'theme'}};
const catalog={personas:Object.fromEntries(['MELCHIOR-1','BALTHASAR-2','CASPER-3'].map(k=>[k,body])),synthesizer:body,privacy:{ja:[{text:'説明'}],en:[{text:'Description'}]}};
const version=()=>({id:expected.id,message:expected.sha});
function transport(patch=()=>null) {
  return async(url,options)=>{
    assert.equal(options.redirect,'error');
    const override=patch(url,options);if(override)return override;
    if(url.endsWith('/models'))return Response.json(catalog);
    const probe=publicationRequests().find(p=>p.url===url&&p.options.body===options.body
      &&p.options.headers.Origin===options.headers.Origin);assert.ok(probe,'only fixed endpoints');
    assert.equal(options.method,probe.options.method);assert.equal(options.body,probe.options.body);
    const value=probe.name==='versions'?history:probe.name==='legacy_versions'
      ?{versions:history.versions.filter(r=>r.version==='earlier'||/^\d{1,2}\.\d$/.test(r.version))}
      :probe.name==='old_generation_rejected'?{status:'failed',complete:false,reason:probe.code,results:[]}
      :{error:{code:probe.code}};
    return Response.json(value,{status:probe.status});
  };
}
test('固定の拒否要求と新旧の履歴を検査し、結果に入力本文やカタログ本文を残さない',async()=>{
  const report=await verifyDailyPublication({fetcher:transport(),readDeployment:version,expected});
  assert.equal(report.ok,true);assert.equal(report.cases.length,10);
  assert.doesNotMatch(JSON.stringify(report),/x{30}|description|素材|MELCHIOR/);
});
test('版IDとSHAが異なれば最初に止まり、確認中の割り込みも不合格になる',async()=>{
  let calls=0;
  const before=await verifyDailyPublication({fetcher:async()=>{calls++;},readDeployment:()=>({id:'other',message:expected.sha}),expected});
  assert.equal(before.ok,false);assert.equal(calls,0);
  let reads=0;
  const after=await verifyDailyPublication({fetcher:transport(),readDeployment:()=>++reads===1?version():{id:'human',message:'b'.repeat(40)},expected});
  assert.equal(after.ok,false);assert.equal(after.cases.at(-1).name,'deployment_after');
});
test('200だけでは通さず、旧版へのX.YZ混入・欠けた新版本文・正常検索応答を拒否する',async()=>{
  for(const patch of [
    url=>url.endsWith('/models')?Response.json({}):null,
    url=>url.endsWith('format=2')?Response.json({versions:[]}):null,
    url=>url.endsWith('/versions')?Response.json({versions:[{...history.versions[0],version:'6.01'}]}):null,
    url=>url.endsWith('/rank')?Response.json({status:'results',complete:true,results:[]}):null,
    url=>url.endsWith('/chat')?Response.json({error:{code:'other'}},{status:400}):null,
  ])assert.equal((await verifyDailyPublication({fetcher:transport(patch),readDeployment:version,expected})).ok,false);
});
test('通信障害・巨大な履歴を不合格にし、通信関数の省略では本番fetchを使わない',async()=>{
  const failed=await verifyDailyPublication({fetcher:async()=>{throw new Error('PRIVATE_CREDENTIAL');},readDeployment:version,expected});
  assert.equal(failed.ok,false);assert.doesNotMatch(JSON.stringify(failed),/PRIVATE/);
  const large=transport(url=>url.endsWith('format=2')?new Response(' '.repeat(65537)):null);
  assert.equal((await verifyDailyPublication({fetcher:large,readDeployment:version,expected})).ok,false);
  await assert.rejects(()=>verifyDailyPublication({readDeployment:version,expected}),/publication_inputs/);
});
