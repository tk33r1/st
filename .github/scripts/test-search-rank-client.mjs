// 新通信契約はDOM・計測・本番Jevから独立して検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../../assets/site-search.js',import.meta.url),'utf8');
function load(fetch=()=>{throw new Error('unexpected fetch');}) {
  const window={location:{hostname:'localhost'}};
  runInNewContext(source,{window,fetch,AbortController,setTimeout,clearTimeout,URL});
  return window.STSiteSearch;
}
const condition=(scope='tools')=>({scope,query:'家電',locale:'ja',filters:{},generation:(scope==='nitori'||scope==='retail')?'abcd':'1'.repeat(64)});
const response=(scope='tools')=>({status:'results',complete:true,cached:false,
  searched:{scope,filters:{},generation:condition(scope).generation,total:9,candidates:9,judged:9},
  results:[{id:'tool:1',kind:scope==='game'?'game':scope==='nitori'||scope==='retail'?'daily':'tool',title:'家電',description:'固定した候補',
    url:scope==='game'?'/game/sample/':scope==='nitori'?'/job/nitoridaily/20261011/#art-1':scope==='retail'?'/job/retailtechdaily/20261011/#art-1':'/tools/sample/'}]});
test('旧APIを維持し、新応答のscope・filters・世代・件数・URLを検査する',()=>{
  const api=load();assert.equal(typeof api.rank,'function');assert.equal(typeof api.readResponse,'function');
  for(const scope of ['site','tools','game','nitori','retail']) assert.equal(api.readRankResponse(200,response(scope),condition(scope)).status,'results');
  const changes=[r=>r.searched.scope='game',r=>r.searched.filters={category:'Other'},r=>r.searched.generation='bad',
    r=>r.searched.judged=10,r=>r.searched.candidates=21,r=>r.complete=false,r=>r.results.push({...r.results[0]}),
    r=>r.results[0].url='/game/sample/',r=>r.results[0].url='/tools/../tools/sample/',r=>r.results[0].url='/tools/%2e%2e/game/sample/',
    r=>r.results[0].url='//outside.example/',r=>r.results[0].kind='page',r=>r.cached=undefined,r=>r.searched=null];
  for(const mutate of changes){const r=response();mutate(r);assert.equal(api.readRankResponse(200,r,condition()).status,'failed',String(mutate));}
  const failed={status:'failed',reason:'index_updating',complete:false,cached:false,searched:null,results:[]};
  assert.equal(api.readRankResponse(200,failed,condition()).reason,'index_updating');
  assert.equal(api.readRankResponse(429,{...failed,reason:'anything'},condition()).reason,'rate_limited');
  assert.equal(api.readRankResponse(500,failed,condition()).reason,'unavailable');
});
test('同一サイトへの明示POSTだけ。並行・確定済みの同条件を重複送信しない',async()=>{
  let posts=0,finish;const calls=[];
  const api=load(async(url,options)=>{posts++;calls.push([url,options]);await new Promise(resolve=>{finish=resolve;});return {status:200,json:async()=>response()};});
  const client=api.createRankClient({scope:'tools'}), a=client.run(condition()),b=client.run(condition());
  assert.equal(a,b);assert.equal(posts,1);finish();assert.equal((await a).status,'results');
  await client.run(condition());assert.equal(posts,1);
  const [url,options]=calls[0];assert.equal(url,'/search/api/rank');assert.equal(options.method,'POST');assert.equal(options.referrerPolicy,'no-referrer');
  assert.deepEqual(JSON.parse(options.body),{search_contract:1,mode:'rank',scope:'tools',query:'家電',locale:'ja',filters:{},generation:'1'.repeat(64)});
  client.invalidate();const next=client.run(condition());finish();await next;assert.equal(posts,2);
  client.cancel();assert.equal(posts,2);
});
test('A→B→Aで遅いAを返さず、中止はPOSTを増やさない',async()=>{
  const jobs=[];const api=load(async()=>{await new Promise(resolve=>jobs.push(resolve));return {status:200,json:async()=>response()};});
  const client=api.createRankClient({scope:'tools'});const a=client.run(condition());client.invalidate();
  const b=client.run({...condition(),query:'机'});client.invalidate();const c=client.run(condition());
  jobs[0]();jobs[1]();assert.equal(await a,null);assert.equal(await b,null);
  jobs[2]();assert.equal((await c).status,'results');assert.equal(jobs.length,3);
});
test('不正条件を送信前に拒否し、disabledを画面の存続中は保持する',async()=>{
  let posts=0;const api=load(async()=>{posts++;return {status:200,json:async()=>({status:'failed',reason:'disabled',complete:false,cached:false,searched:null,results:[]})};});
  const client=api.createRankClient({scope:'tools'});
  for(const patch of [{query:''},{query:'x'.repeat(201)},{generation:'abcd'},{locale:'xx'},{filters:{genre:'x'}},{query:'a\u202eb'}]) assert.throws(()=>client.run({...condition(),...patch}));
  assert.equal(posts,0);await client.run(condition());assert.equal(client.disabled,true);client.invalidate();
  assert.equal(await client.run(condition()),null);assert.equal(posts,1);
});
