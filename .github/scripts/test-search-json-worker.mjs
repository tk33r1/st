// JSONの分割受け渡しを検査。実API・DOM・ブラウザの辞書を使わない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const code=readFileSync('assets/search-json-worker.js','utf8');
async function parse(bytes) {
  const messages=[],context=vm.createContext({onmessage:null,TextDecoder,crypto:webcrypto,postMessage:m=>messages.push(structuredClone(m))});
  vm.runInContext(code,context);await context.onmessage({data:bytes});return messages;
}
function collect(messages) {
  let result;
  for(const m of messages) {
    if(m.type==='start') {result=m.rootArray?[]:Object.assign(Object.create(null),m.header);if(!m.rootArray)for(const key of m.keys)result[key]=[];}
    else if(m.type==='rows') (Array.isArray(result)?result:result[m.key]).push(...m.rows);
    else if(m.type==='postings') (Array.isArray(result)?result:result[m.key])[m.index].postings.push(...m.rows);
    else if(m.type==='value') result=m.value;
    else if(m.type==='error') throw new Error('invalid');
  }
  return JSON.parse(JSON.stringify(result));
}
test('大きな配列・複数配列・語のpostings・Unicode・危険なキーを内容を変えず小分けにする',async()=>{
  const rows=Array.from({length:1000},(_,i)=>({id:i,text:'収納𠮷'+i}));
  const huge={surface:'全件',reading:'ぜんけん',postings:Array.from({length:10000},(_,i)=>[i,15])};
  const objects=[rows,[huge],{version:1,record_ids:rows.map(r=>String(r.id)),terms:[{surface:'収納',reading:'しゅうのう',postings:rows.map((_,i)=>[i,1])},huge]},
    JSON.parse('{"__proto__":{"polluted":true},"constructor":[1,2],"value":"日本語"}'),null,42];
  for(const value of objects) {
    const bytes=new TextEncoder().encode(JSON.stringify(value)),messages=await parse(bytes);
    const expected=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');assert.deepEqual(messages[0],{type:'hash',value:expected});
    assert.deepEqual(collect(messages),value);assert.ok(messages.filter(m=>m.type==='rows').every(m=>m.rows.length<=64));
    assert.ok(messages.filter(m=>m.type==='postings').every(m=>m.rows.length<=512));
    if(JSON.stringify(value).includes('ぜんけん')) assert.ok(messages.some(m=>m.type==='postings'),'大きい1語の対応表も分割する');
  }
  assert.equal({}.polluted,undefined);
  assert.ok((await parse(new TextEncoder().encode(JSON.stringify(rows)))).length>10);
});
test('不正JSON・不正UTF-8を完了として返さない',async()=>{
  for(const bytes of [new TextEncoder().encode('{"rows":[1,'),Uint8Array.of(0xff,0xfe)]) {
    const messages=await parse(bytes);assert.equal(messages.at(-1).type,'error');assert.ok(!messages.some(m=>m.type==='done'));assert.throws(()=>collect(messages));
  }
});

function adapter(mode='normal') {
  const rows=JSON.parse(readFileSync('data/tools.json','utf8')).map(row=>({...row,description:'日本語'.repeat(6000)}));
  const bytes=new TextEncoder().encode(JSON.stringify(rows)),calls=[],window={},workers=[];
  class Parser {
    constructor(url) {assert.ok(url.startsWith('blob:'));workers.push(this);if(mode==='unavailable') throw new Error('unsupported');}
    terminate(){this.stopped=true;}
    postMessage(data,transfer) {assert.equal(transfer.length,1);assert.equal(transfer[0],data);const bytes=structuredClone(data,{transfer});if(mode==='pending')return;
      queueMicrotask(async()=>{if(mode==='error'){this.onerror({preventDefault(){}});return;}for(const m of await parse(bytes)) {if(this.stopped)break;this.delivered=true;this.onmessage({data:m});}});}
  }
  vm.runInNewContext(readFileSync('assets/search-data.js','utf8'),{window,crypto:webcrypto,TextDecoder,AbortController,setTimeout,clearTimeout,URL,Blob,Worker:Parser,
    fetch:async path=>{calls.push(path);return new Response(path.startsWith('/assets/')?code:bytes);}});
  return {api:window.STSearchData.createAdapter('tools'),rows,calls,workers};
}
test('adapterはBlob解析で値と生バイトhashを保ち、解析コードだけを共有する',async()=>{
  const a=adapter(),base=await a.api.loadBase({});
  assert.equal(base.records.length,a.rows.length);assert.equal(base.records[0].description,a.rows[0].description);
  assert.ok(a.workers[0].stopped);assert.ok(a.workers[0].delivered,'縮退ではなくWorkerの結果を採用');assert.equal(a.calls.filter(p=>p.startsWith('/assets/')).length,1);
  const refreshed=await a.api.loadBase({cache:'no-cache'});assert.equal(refreshed.sourceHash,base.sourceHash);
  assert.equal(a.calls.filter(p=>p.startsWith('/assets/')).length,1);
});
test('Worker非対応は同じ取得済みバイト列へ縮退し、取消時は採用しない',async()=>{
  const a=adapter('unavailable'),base=await a.api.loadBase({});assert.equal(base.records.length,a.rows.length);
  assert.equal(a.calls.filter(p=>p==='/data/tools.json').length,1);
  const transferred=adapter('error'),fallback=await transferred.api.loadBase({});
  assert.equal(fallback.sourceHash,base.sourceHash);assert.equal(fallback.records[0].description,a.rows[0].description);
  assert.equal(transferred.calls.filter(p=>p==='/data/tools.json').length,1,'移譲した後の失敗でも同じバイト列へ縮退');
  const b=adapter('pending'),ac=new AbortController(),pending=b.api.loadBase({signal:ac.signal});
  while(!b.workers.length)await new Promise(resolve=>setTimeout(resolve,1));ac.abort();
  await assert.rejects(pending,/search_cancelled/);assert.ok(b.workers[0].stopped);
  assert.equal(b.calls.filter(p=>p==='/data/tools.json').length,1);
});
