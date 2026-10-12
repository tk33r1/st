// 共通検索の候補クリックの記録（/search/api/click）と集計（search-boost.py）。実キー・本番D1は使わない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=path=>readFileSync(path,'utf8');

function worker() {
  const counts=new Map(),rows=[];
  const sandbox={aiModels:JSON.parse(read('config/ai-models.json')),bundledContext:JSON.parse(read('data/magi-context.json')),
    Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,URL,crypto:webcrypto,setTimeout,clearTimeout,console:{log(){}},
    fetch:async()=>{throw new Error('外部への通信はしない');}};
  const ctx=vm.createContext(sandbox),strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
  const modules=['languages.js','personas.js','classification.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js'];
  vm.runInContext(modules.map(f=>strip(read('workers/magi2/'+f))).join('\n')+'\n'+strip(read('workers/magi2/src/index.js')).replace('export default {','globalThis.worker={'),ctx);
  const DB={prepare(sql){return {bind(...args){return {
    async first(){assert.match(sql,/RETURNING count/);const [key,day,limit]=args,id=key+'|'+day,n=counts.get(id)||0;if(n>=limit) return null;counts.set(id,n+1);return {count:n+1};},
    async run(){assert.match(sql,/INSERT INTO search_clicks/);rows.push(args);return {success:true};}};}};}};
  const env={SEARCH_CLICK_ENABLED:'true',DB};
  const request=(body,{origin='https://tk.st',ip='203.0.113.1',raw}={})=>ctx.worker.fetch(new Request('https://tk.st/search/api/click',
    {method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':ip},body:raw ?? JSON.stringify(body)}),env,{waitUntil(){}});
  return {env,counts,rows,request};
}
const click=(extra={})=>({scope:'tools',query:'pdf',href:'/tools/pdf-studio/',list:'suggest',position:1,...extra});

test('正しい記録は204で1行書き、IPは日付付きハッシュだけを残す',async()=>{
  const w=worker();
  for(const body of [click(),click({scope:'site',href:'/thought/',list:'local',position:3}),
    click({scope:'nitori',href:'/job/nitoridaily/20261012/#art-2',list:'semantic'}),click({scope:'game',href:'/game/masala-tetris-tiffin/'})]) {
    assert.equal((await w.request(body)).status,204,JSON.stringify(body));
  }
  assert.equal(w.rows.length,4);
  const [day,at,scope,query,href,list,position,visitor]=w.rows[0];
  assert.match(day,/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);assert.ok(Number.isSafeInteger(at));
  assert.deepEqual([scope,query,href,list,position],['tools','pdf','/tools/pdf-studio/','suggest',1]);
  assert.match(visitor,/^[a-f0-9]{16}$/);assert.ok(!w.rows.flat().includes('203.0.113.1'));
});

test('形・画面の種類に合わないものは400で、回数もD1も使わない',async()=>{
  const w=worker();
  for(const body of [click({scope:'bad'}),click({href:'/game/x/'}),click({href:'https://evil.example/'}),click({href:'//evil.example/'}),
    click({href:'/tools/a/?q=1'}),click({href:'/tools/%2e%2e/'}),click({scope:'nitori',href:'/job/retailtechdaily/20261012/#art-1'}),
    click({scope:'nitori',href:'/job/nitoridaily/2026101/#art-1'}),click({list:'other'}),click({position:0}),click({position:1.5}),
    click({query:''}),click({query:' pdf'}),click({query:'a'.repeat(201)}),click({query:'a'+String.fromCharCode(0)}),{...click(),extra:1}]) {
    assert.equal((await w.request(body)).status,400,JSON.stringify(body));
  }
  assert.equal((await w.request(null,{raw:'{'})).status,400);
  assert.equal(w.counts.size,0);assert.equal(w.rows.length,0);
});

test('Originを確かめ、IPごとの上限の後は書かない。停止中は204で何もしない',async()=>{
  const w=worker();
  assert.equal((await w.request(click(),{origin:'https://outside.example'})).status,401);
  for(let i=0;i<100;i++) assert.equal((await w.request(click({position:i+1}))).status,204);
  assert.equal((await w.request(click())).status,429);assert.equal(w.rows.length,100);
  assert.equal((await w.request(click(),{ip:'203.0.113.2'})).status,204);assert.equal(w.rows.length,101);
  w.env.SEARCH_CLICK_ENABLED='false';const before=w.counts.size;
  assert.equal((await w.request(click(),{ip:'203.0.113.3'})).status,204);assert.equal(w.rows.length,101);assert.equal(w.counts.size,before);
});

test('集計は人数で数え、公開中のページだけを出し、少ない組と個人情報らしい検索語を出さない',()=>{
  const dir=mkdtempSync(join(tmpdir(),'search-boost-')),rowsPath=join(dir,'rows.json'),out=join(dir,'boost.json');
  const results=[
    ...['a','b','c'].map(v=>({scope:'tools',query:'pdf',href:'/tools/pdf-studio/',visitor:v})),
    {scope:'tools',query:'pdf',href:'/tools/pdf-studio/',visitor:'a'},
    ...['a','b'].map(v=>({scope:'tools',query:'svg',href:'/tools/light-svg/',visitor:v})),
    {scope:'tools',query:'pdf',href:'/tools/removed-tool/',visitor:'d'},
    ...['a','b','c'].map(v=>({scope:'tools',query:'me@example.com',href:'/tools/pdf-studio/',visitor:v})),
    ...['a','b','c'].map(v=>({scope:'site',query:'09012345678',href:'/thought/',visitor:v})),
    {scope:'nitori',query:'収納',href:'/job/nitoridaily/20261012/#art-1',visitor:'a'},
    {scope:'nitori',query:'収納',href:'/job/nitoridaily/19990101/#art-1',visitor:'a'}];
  writeFileSync(rowsPath,JSON.stringify([{results,success:true,meta:{}}]));
  execFileSync('python',['-B','.github/scripts/search-boost.py','--rows',rowsPath,'--output',out]);
  const boost=JSON.parse(read(out));
  assert.equal(boost.version,1);
  assert.deepEqual(boost.scopes.tools.pages,{'/tools/light-svg/':2,'/tools/pdf-studio/':3});
  assert.deepEqual(boost.scopes.tools.queries,{pdf:{'/tools/pdf-studio/':3}});
  assert.deepEqual(boost.scopes.site,{pages:{'/thought/':3},queries:{}});
  assert.deepEqual(boost.scopes.nitori.pages,{'/job/nitoridaily/20261012/#art-1':1});
  const again=join(dir,'again.json');execFileSync('python',['-B','.github/scripts/search-boost.py','--rows',rowsPath,'--output',again]);
  assert.equal(read(again),read(out),'同じ入力なら同じバイト列');
});
