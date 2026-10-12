// 共通検索の候補クリックの記録（/search/api/click）と集計（search-boost.py）。実キー・本番D1は使わない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
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
  const env={SEARCH_CLICK_ENABLED:'true',SEARCH_CLICK_SALT:'synthetic-salt',DB};
  const request=(body,{origin='https://tk.st',ip='203.0.113.1',raw}={})=>ctx.worker.fetch(new Request('https://tk.st/search/api/click',
    {method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':ip},body:raw ?? JSON.stringify(body)}),env,{waitUntil(){}});
  return {env,counts,rows,request};
}
const click=(extra={})=>({scope:'tools',query:'pdf',href:'/tools/pdf-studio/',list:'suggest',position:1,...extra});

test('正しい記録は204で1行書き、IPは塩を混ぜたハッシュだけを残す',async()=>{
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
  // 日付を混ぜない（日をまたいでも同じ人を1人と数える）。塩なしのハッシュとも一致しない。
  assert.equal(visitor,createHash('sha256').update('synthetic-salt:203.0.113.1').digest('hex').slice(0,16));
  assert.notEqual(visitor,createHash('sha256').update(day+':203.0.113.1').digest('hex').slice(0,16));
  assert.ok(w.rows.every(row=>row[7]===visitor),'同じIPは同じvisitor');
});

test('塩が無ければ記録しない（逆算できるハッシュを作らない）',async()=>{
  const w=worker();delete w.env.SEARCH_CLICK_SALT;
  assert.equal((await w.request(click())).status,204);assert.equal(w.rows.length,0);assert.equal(w.counts.size,0);
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

test('集計は公開中のページだけを出し、少ない組と個人情報らしい検索語を出さない',()=>{
  const dir=mkdtempSync(join(tmpdir(),'search-boost-')),rowsPath=join(dir,'rows.json'),out=join(dir,'boost.json');
  // search-boost.yml の2文（ページごと、検索語→ページごと）の結果の形
  const pages=[{scope:'tools',href:'/tools/pdf-studio/',visitors:3},{scope:'tools',href:'/tools/light-svg/',visitors:2},
    {scope:'tools',href:'/tools/removed-tool/',visitors:9},{scope:'site',href:'/thought/',visitors:3},
    {scope:'nitori',href:'/job/nitoridaily/20261012/#art-1',visitors:1},{scope:'nitori',href:'/job/nitoridaily/19990101/#art-1',visitors:4},
    {scope:'game',href:'/game/masala-tetris-tiffin/',visitors:0},{scope:'bad',href:'/tools/pdf-studio/',visitors:5}];
  const queries=[{scope:'tools',query:'pdf',href:'/tools/pdf-studio/',visitors:3},{scope:'tools',query:'pdf',href:'/tools/removed-tool/',visitors:5},
    {scope:'tools',query:'svg',href:'/tools/light-svg/',visitors:2},
    ...['me@example.com','09012345678','090-1234-5678','090 1234 5678','(03)1234-5678','03ー1234ー5678'].map(query=>({scope:'site',query,href:'/thought/',visitors:5})),
    {scope:'site',query:'pdf 2026',href:'/thought/',visitors:4}];
  writeFileSync(rowsPath,JSON.stringify([{results:pages,success:true,meta:{}},{results:queries,success:true,meta:{}}]));
  execFileSync('python',['-B','.github/scripts/search-boost.py','--rows',rowsPath,'--output',out]);
  const boost=JSON.parse(read(out));
  assert.equal(boost.version,1);
  assert.deepEqual(boost.scopes.tools.pages,{'/tools/light-svg/':2,'/tools/pdf-studio/':3});
  assert.deepEqual(boost.scopes.tools.queries,{pdf:{'/tools/pdf-studio/':3}});
  assert.deepEqual(boost.scopes.site,{pages:{'/thought/':3},queries:{'pdf 2026':{'/thought/':4}}},'区切りのある電話番号も出さない');
  assert.deepEqual(boost.scopes.nitori.pages,{'/job/nitoridaily/20261012/#art-1':1});
  assert.equal(boost.scopes.game,undefined);
  const again=join(dir,'again.json');execFileSync('python',['-B','.github/scripts/search-boost.py','--rows',rowsPath,'--output',again]);
  assert.equal(read(again),read(out),'同じ入力なら同じバイト列');
  writeFileSync(rowsPath,JSON.stringify([{results:pages,success:true,meta:{}}]));
  assert.throws(()=>execFileSync('python',['-B','.github/scripts/search-boost.py','--rows',rowsPath,'--output',out],{stdio:'pipe'}),'1文だけの結果は受け付けない');
});
