// 新入口・scope・世代guard。実キー・本番API・D1は使わない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
const read=path=>readFileSync(path,'utf8'), digest=value=>createHash('sha256').update(value).digest('hex');
const publication=read('.github/site-search/phase4/site-index.json');
function worker() {
  const files=new Map([['data/site-search.json',publication],...['tools','game'].map(scope=>[`data/${scope}.json`,read(`data/${scope}.json`)])]);
  for(const media of ['nitoridaily','retailtechdaily']) files.set(`job/${media}/search-index.json`,read(`job/${media}/search-index.json`));
  const requests=[],jev=[],counts=new Map(),waits=[];let hook=null;
  const sandbox={aiModels:JSON.parse(read('config/ai-models.json')),bundledContext:JSON.parse(read('data/magi-context.json')),
    Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,URL,crypto:webcrypto,setTimeout,clearTimeout,console:{log(){}},
    fetch:async(url,options)=>{
      if(hook){const r=await hook(url,options);if(r) return r;}
      if(url.startsWith('https://tk.st/')) {requests.push(url);const text=files.get(url.slice('https://tk.st/'.length));return new Response(text || '',{status:text?200:404});}
      assert.equal(url,'https://api.typesafe.ai/v1/systemone');const body=JSON.parse(options.body);jev.push(body);
      return Response.json({answers:Object.fromEntries(Object.keys(body.questions).map(id=>[id,{type:'noul',noul:.9}]))});
    }};
  const ctx=vm.createContext(sandbox),strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
  const modules=['languages.js','personas.js','classification.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js'];
  vm.runInContext(modules.map(f=>strip(read('workers/magi2/'+f))).join('\n')+'\n'+strip(read('workers/magi2/src/index.js')).replace('export default {','globalThis.worker={')
    +'\nglobalThis.helpers={makeListSnapshot,fetchSearchSource,getRankSnapshot,rankSnapshotUpdates,listSnapshots,searchSources,cache,rankTargets};',ctx);
  const env={SITE_RANK_ENABLED:'true',SITE_RANK_SCOPES:'site,nitori,retail,tools,game',MAGI_TYPESAFE_API_KEY:'synthetic-key',
    DB:{prepare(sql){return {bind(key,day,limit){return {async first(){assert.match(sql,/RETURNING count/);const id=key+'|'+day,n=counts.get(id)||0;if(n>=limit) return null;counts.set(id,n+1);return {count:n+1};}};}};}}};
  const request=(body,{path='/search/api/rank',method='POST',origin='https://tk.st',signal,headers={}}={})=>ctx.worker.fetch(new Request('https://tk.st'+path,
    {method,headers:{Origin:origin,'Content-Type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify(body)}:{}),signal}),env,{waitUntil:p=>waits.push(p)});
  const body=(scope,extra={})=>({search_contract:1,mode:'rank',scope,locale:'ja',query:'検索したい',filters:{},generation:scope==='site'?digest(files.get('data/site-search.json')):scope==='tools'||scope==='game'?digest(files.get(`data/${scope}.json`)):JSON.parse(files.get(`job/${scope==='nitori'?'nitoridaily':'retailtechdaily'}/search-index.json`)).generation,...extra});
  return {ctx,env,files,requests,jev,counts,waits,request,body,setHook:value=>{hook=value;}};
}
test('固定path/method/mode/契約・旧scope・認可・停止を取得と回数より先に拒否する',async()=>{
  const w=worker();
  for(const patch of [{scope:'bad'},{search_contract:2},{mode:'chat'},{mode:undefined},{filters:{region:'EU'}},{candidates:[]},{generation:'bad'},{query:''}]) {
    assert.equal((await w.request(w.body('tools',patch))).status,400);
  }
  for(const path of ['/search/api/rank/','/search/api/chat']) assert.equal((await w.request(w.body('tools'),{path})).status,404);
  assert.equal((await w.request(w.body('tools'),{method:'GET'})).status,404);
  assert.equal((await w.request(w.body('tools'),{origin:'https://outside.example'})).status,401);
  for(const scope of ['tools','game']) assert.equal((await w.request({mode:'rank',scope,locale:'ja',query:'x'},{path:'/magi2/site-search'})).status,400);
  w.env.SITE_RANK_SCOPES='site,nitori,retail';assert.equal((await (await w.request(w.body('tools'))).json()).reason,'disabled');
  assert.equal(w.requests.length,0);assert.equal(w.jev.length,0);assert.equal(w.counts.size,0);
});
test('5scopeは同じ経路の1回のJevとIP／全体上限を使い、新応答とキャッシュを返す',async()=>{
  const w=worker();
  for(const scope of ['site','tools','game','nitori','retail']) {
    const r=await (await w.request(w.body(scope))).json();assert.equal(r.status,'results',scope);assert.equal(r.cached,false);
    assert.equal(r.searched.scope,scope);assert.equal(r.searched.generation,w.body(scope).generation);assert.ok(r.searched.candidates<=r.searched.total);
    if(scope!=='site') assert.ok(r.searched.candidates<=20);
    const calls=w.jev.length;const again=await (await w.request(w.body(scope))).json();assert.equal(again.cached,true);assert.equal(w.jev.length,calls);
  }
  assert.equal(w.jev.length,5);assert.equal(w.counts.size,2);assert.deepEqual([...w.counts.values()],[10,10]);
});
test('filtersを候補より前に適用し、一覧が自分のscopeだけをJevへ送る',async()=>{
  const w=worker();
  for(const scope of ['tools','game']) {
    const list=JSON.parse(w.files.get(`data/${scope}.json`)),key=scope==='tools'?'category':'genre';
    const raw=list[0][key],value=scope==='tools'?raw.slice(0,1).toUpperCase()+raw.slice(1):raw;
    const r=await (await w.request(w.body(scope,{filters:{[key]:value}}))).json();assert.equal(r.status,'results');
    const candidates=Object.values(w.jev.at(-1).state.candidates);assert.ok(candidates.length);
    assert.ok(candidates.every(c=>c.kind===(scope==='tools'?'tool':'game') && c[key]===value));
  }
});
test('偽のgeneration・searched=null・取得失敗は回数とJevゼロ。連打は同じ再取得間隔を共有する',async()=>{
  for(const scope of ['site','tools','game','nitori','retail']) {
    const w=worker(),body=w.body(scope,{generation:scope==='nitori'||scope==='retail'?'ffff':'f'.repeat(64)});
    const r=await (await w.request(body)).json();assert.equal(r.reason,'index_updating');assert.equal(r.complete,false);assert.equal(r.cached,false);
    assert.equal(r.results.length,0);assert.equal(r.searched.candidates,0);assert.equal(r.searched.judged,0);
    const n=w.requests.length;await w.request(body);assert.equal(w.requests.length,n);assert.equal(w.jev.length,0);assert.equal(w.counts.size,0);
  }
  const w=worker(),body=w.body('tools',{generation:'f'.repeat(64)});w.files.delete('data/tools.json');const r=await (await w.request(body)).json();
  assert.equal(r.reason,'index_updating');assert.equal(r.searched,null);assert.equal(w.counts.size,0);
});
test('版が変われば固定ソースを1回だけ更新し、同じ明示POSTの中で新しい版と1回のJevへ進む',async()=>{
  for(const scope of ['site','tools','game','nitori','retail']) {
    const w=worker();assert.equal((await (await w.request(w.body(scope))).json()).status,'results');w.counts.clear();w.jev.length=0;
    if(scope==='site') {
      const index=JSON.parse(w.files.get('data/site-search.json'));index.pages.find(p=>p.kind==='page').description+=' 追記';w.files.set('data/site-search.json',JSON.stringify(index));
    } else if(['tools','game'].includes(scope)) {
      const key=`data/${scope}.json`,rows=JSON.parse(w.files.get(key));rows[0].description+=' 追記';w.files.set(key,JSON.stringify(rows));
      const index=JSON.parse(w.files.get('data/site-search.json')),id=(scope==='tools'?'tool:':'game:')+rows[0].id;
      index.pages.find(p=>p.id===id).description=rows[0].shortDescription || rows[0].description;w.files.set('data/site-search.json',JSON.stringify(index));
    } else {
      const key=`job/${scope==='nitori'?'nitoridaily':'retailtechdaily'}/search-index.json`,head=JSON.parse(w.files.get(key));head.generation='b2';w.files.set(key,JSON.stringify(head));
    }
    // 60秒の間隔が経過した状態だけを再現し、本文や世代の検査は実コードで行う。
    for(const state of w.ctx.helpers.searchSources.values()) state.retryAt=0;
    for(const state of w.ctx.helpers.rankSnapshotUpdates.values()) state.retryAt=0;
    const body=w.body(scope),r=await (await w.request(body)).json();assert.equal(r.status,'results',scope);assert.equal(r.searched.generation,body.generation);
    assert.equal(w.jev.length,1);assert.deepEqual([...w.counts.values()],[1,1]);
  }
});
test('一覧と公開索引の混在は旧キャッシュを使わず、公開されない行は候補から除く',async()=>{
  const w=worker();const rows=JSON.parse(w.files.get('data/tools.json'));rows[0].title+='不一致';w.files.set('data/tools.json',JSON.stringify(rows));
  const r=await (await w.request(w.body('tools'))).json();assert.equal(r.reason,'index_updating');assert.equal(w.counts.size,0);assert.equal(w.jev.length,0);
  const x=worker();const index=JSON.parse(publication),id='tool:'+JSON.parse(x.files.get('data/tools.json'))[0].id;
  index.pages=index.pages.filter(p=>p.id!==id);x.files.set('data/site-search.json',JSON.stringify(index));
  const good=await (await x.request(x.body('tools'))).json();assert.equal(good.status,'results');
  assert.equal(good.searched.total,JSON.parse(x.files.get('data/tools.json')).length-1);
});
test('同時の新要求の取得を共有し、1要求の切断で別の要求の共有取得を止めない',async()=>{
  const w=worker();let release,sourceCalls=0;
  w.setHook(async url=>{if(url==='https://tk.st/data/tools.json'){sourceCalls++;await new Promise(resolve=>{release=resolve;});return new Response(w.files.get('data/tools.json'));}});
  const ac=new AbortController(),a=w.request(w.body('tools'),{signal:ac.signal}),b=w.request(w.body('tools'));
  while(!release) await new Promise(resolve=>setTimeout(resolve,1));ac.abort();release();await a;
  const r=await (await b).json();assert.equal(r.status,'results');assert.equal(sourceCalls,1);assert.equal(w.jev.length,1);
});
test('新入口の評価scopeも評価キーなしでは回数と索引を使わず停止する',async()=>{
  const w=worker();w.env.SITE_RANK_EVAL_SCOPES='tools,game';w.env.SITE_RANK_EVAL_KEY='fixed-eval';
  for(const scope of ['tools','game']) assert.equal((await (await w.request(w.body(scope))).json()).reason,'disabled');
  assert.equal(w.requests.length,0);assert.equal(w.counts.size,0);
  assert.equal((await (await w.request(w.body('tools'),{headers:{'x-api-key':'fixed-eval'}})).json()).status,'results');
});
test('旧日刊が開始した取得も新要求が共有し、旧要求の中断で新要求の取得を止めない',async()=>{
  const w=worker();let release,n=0;
  w.setHook(async url=>{if(url==='https://tk.st/job/nitoridaily/search-index.json') {
    n++;await new Promise(resolve=>{release=resolve;});return new Response(w.files.get('job/nitoridaily/search-index.json'));
  }});
  const ac=new AbortController(),old=w.request({mode:'rank',scope:'nitori',query:'収納',locale:'ja'},{path:'/magi2/site-search',signal:ac.signal});
  while(!release) await new Promise(resolve=>setTimeout(resolve,1));const next=w.request(w.body('nitori'));
  while(!vm.runInContext("dailySnapshots.get('nitori').lease?.shared",w.ctx)) await new Promise(resolve=>setTimeout(resolve,1));
  ac.abort();release();await old;const r=await (await next).json();assert.equal(r.status,'results');assert.equal(n,1);assert.equal(w.jev.length,1);
  const again=await (await w.request(w.body('nitori'))).json();assert.equal(again.cached,true);
});
test('公開索引の混在を検知した後は、世代が同じ旧一覧キャッシュでもJevと回数へ進まない',async()=>{
  const w=worker();assert.equal((await (await w.request(w.body('tools'))).json()).status,'results');w.counts.clear();w.jev.length=0;
  const p=JSON.parse(w.files.get('data/site-search.json'));p.pages.find(r=>r.kind==='tool').description+='不一致';w.files.set('data/site-search.json',JSON.stringify(p));
  w.ctx.helpers.listSnapshots.get('tools').at=0;w.ctx.helpers.rankSnapshotUpdates.get('tools').retryAt=0;
  for(const state of w.ctx.helpers.searchSources.values()) state.retryAt=0;
  const r=await (await w.request(w.body('tools'))).json();assert.equal(r.reason,'index_updating');assert.equal(r.results.length,0);
  const n=w.requests.length;await w.request(w.body('tools'));assert.equal(w.requests.length,n);assert.equal(w.counts.size,0);assert.equal(w.jev.length,0);
});
